"""
10_smartapi_live.py
===================
Real-time tick -> 5-minute candle aggregator for the Angel One SmartAPI
WebSocket (SmartWebSocketV2).

While the market is open this connects to Angel One's live feed, subscribes to
the Nifty 50 / Bank Nifty index ticks and rolls them up into fresh 5-minute
OHLCV candles - the exact input Kronos needs to forecast off *today's* price
action instead of yesterday's CSV.

Two usage modes:

1. Standalone CLI (captures candles to CSV while you watch)::

       python 10_smartapi_live.py --minutes 60 --out nifty50_live_5m.csv

2. Importable class, so the dashboard can start/stop the feed in a
   background thread and read the current (still-forming) candle live::

       from 10_smartapi_live import LiveCandleAggregator
       agg = LiveCandleAggregator()
       agg.start()
       df = agg.candles_to_dataframe("Nifty 50")
       agg.stop()

Prices arrive from SmartAPI in **paise** (index ~25000 arrives as ~2500000);
the aggregator divides by 100 before bucketing.
"""

from __future__ import annotations

import argparse
import importlib.util
import logging
import sys
import threading
import time
import zoneinfo
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
from SmartApi.smartWebSocketV2 import SmartWebSocketV2

# All live candles are bucketed on the IST wall-clock grid (Asia/Kolkata =
# UTC+5:30). The machine may run in any timezone, so IST must be explicit -
# ``datetime.fromtimestamp()`` without a tz argument would use the machine's
# local timezone and shift every candle boundary.
IST_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")


# ---------------------------------------------------------------------------
# Import the sibling session manager (digit-leading filename -> importlib).
# ---------------------------------------------------------------------------
def _load_auth_module():
    path = Path(__file__).resolve().parent / "8_smartapi_auth.py"
    if not path.is_file():
        raise FileNotFoundError(f"Missing required script: {path}")
    spec = importlib.util.spec_from_file_location("smartapi_auth", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["smartapi_auth"] = module
    spec.loader.exec_module(module)
    return module


auth_mod = _load_auth_module()
SmartAPISession = auth_mod.SmartAPISession
SessionExpired = auth_mod.SessionExpired

INTERVAL_MINUTES = 1
PRICE_DIVISOR = 100.0          # SmartAPI sends prices in paise

# symboltoken -> friendly asset key (999-prefixed index tokens, matching
# 9_smartapi_fetch.py - the legacy 5-digit tokens no longer stream/return data)
ASSETS = {
    "Nifty 50":   {"token": "99926000", "exchange_type": 1},
    "Bank Nifty": {"token": "99926009", "exchange_type": 1},
}

# Per-exchangeType trading-session windows (IST, minutes since midnight).
# NSE_CM(1)/NSE_FO(2)/BSE_CM(3) trade 09:15-15:30; MCX(5) trades 09:00-23:30
# so its ticks must NOT be dropped by the NSE-only session filter below.
SESSION_WINDOWS = {
    1: (9 * 60 + 15, 15 * 60 + 30),
    2: (9 * 60 + 15, 15 * 60 + 30),
    3: (9 * 60 + 15, 15 * 60 + 30),
    5: (9 * 60, 23 * 60 + 30),
}

OHLCV_COLUMNS = ["open", "high", "low", "close", "volume"]

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def market_status() -> tuple[bool, str]:
    """Is the NSE cash market open right now (IST)? Returns (open, label).

    NSE cash session: 09:15-15:30 IST, Mon-Fri. The label is human-readable
    so the dashboard can show "Market open / closed" next to the feed.
    """
    import zoneinfo
    now = datetime.now(zoneinfo.ZoneInfo("Asia/Kolkata"))
    if now.weekday() >= 5:
        return False, f"Market closed (weekend) · {now.strftime('%a %d %b %H:%M')} IST"
    minutes = now.hour * 60 + now.minute
    if minutes < 9 * 60 + 15 or minutes > 15 * 60 + 30:
        return False, f"Market closed (outside 09:15-15:30) · {now.strftime('%a %d %b %H:%M')} IST"
    return True, f"Market open · {now.strftime('%a %d %b %H:%M')} IST"


class LiveCandleAggregator:
    """Subscribe to index ticks and roll them into 1-minute or 5-minute OHLCV candles.

    Designed to run in a background thread: ``start()`` connects the
    websocket (blocking call running in its own thread), ``stop()`` closes it.
    Candles accumulate in-memory and auto-flush to CSV on disk in real time.
    """

    def __init__(
        self,
        assets: dict | None = None,
        interval_minutes: int = INTERVAL_MINUTES,
        price_divisor: float = PRICE_DIVISOR,
        max_days: int = 7,
        write_csvs: bool = True,
        flush_interval_s: float = 15.0,
    ) -> None:
        self.assets = assets or ASSETS
        self.interval = pd.Timedelta(minutes=interval_minutes)
        self.interval_minutes = interval_minutes
        self.price_divisor = price_divisor
        self.max_days = max_days
        # False for stream-only aggregators (e.g. the Kronos View per-symbol
        # broadcasters) so only ONE writer owns the CSV files at a time and
        # the 5m file can never be polluted with raw 1m rows.
        self.write_csvs = write_csvs
        self.flush_interval_s = flush_interval_s

        # token -> list of closed candle dicts
        self._closed: dict[str, list[dict]] = {a["token"]: [] for a in self.assets.values()}
        # token -> in-progress candle dict
        self._forming: dict[str, dict | None] = {a["token"]: None for a in self.assets.values()}
        self._lock = threading.Lock()
        self._sws: SmartWebSocketV2 | None = None
        self._thread: threading.Thread | None = None
        self._flush_thread: threading.Thread | None = None
        self._running = False
        self.last_tick_ts: dict[str, datetime | None] = {a["token"]: None for a in self.assets.values()}
        # Per-token flush gate so EVERY symbol's CSVs get written on each
        # flush cycle - a single shared timestamp meant only the first
        # symbol ever passed the gate (all others skipped every cycle).
        self._last_flush: dict[str, float] = {}
        # Per-token session window (minutes) derived from its exchangeType,
        # so MCX ticks (trading till 23:30) are bucketed while NSE cash
        # (09:15-15:30) rules are applied to equities/futures/options.
        self._session = {
            a["token"]: SESSION_WINDOWS.get(int(a.get("exchange_type", 1)),
                                            SESSION_WINDOWS[1])
            for a in self.assets.values()
        }

    # ------------------------------------------------------------------ helpers
    def _bucket_start(self, ts: datetime) -> datetime:
        """Floor a timestamp to the bucket it belongs to (e.g. 1-minute or
        5-minute), anchored to the IST grid. Returns a naive-IST wall-clock
        time matching the convention of the history CSVs, so live candles
        always line up with the historical ones regardless of the machine's
        local timezone."""
        epoch = int(ts.timestamp())
        floored = epoch - (epoch % int(self.interval.total_seconds()))
        return datetime.fromtimestamp(floored, tz=IST_TZ).replace(tzinfo=None)

    def _resample_to(self, df: pd.DataFrame, minutes: int) -> pd.DataFrame:
        """Aggregate candles up to a coarser interval (e.g. 1m -> 5m) using the
        same OHLC rules the rest of the platform applies."""
        if df is None or df.empty:
            return df
        d = df.assign(_ts=pd.to_datetime(df["timestamps"]))
        agg = {"open": "first", "high": "max", "low": "min", "close": "last",
               "volume": "sum"}
        out = (d.set_index("_ts").resample(f"{minutes}min").agg(agg)
               .dropna(subset=["open"])
               .reset_index()
               .rename(columns={"_ts": "timestamps"}))
        return out[["timestamps"] + OHLCV_COLUMNS]

    def _merge_history(self, live_df: pd.DataFrame, hist_fname: str) -> pd.DataFrame:
        """Live candles merged with a cached CSV (when present), deduped and
        sorted so the newest candle wins for a given timestamp."""
        frames = []
        hist_path = Path(__file__).resolve().parent / hist_fname
        if hist_path.is_file():
            try:
                hist_df = pd.read_csv(hist_path)
                hist_df["timestamps"] = pd.to_datetime(hist_df["timestamps"])
                frames.append(hist_df)
            except Exception:
                pass
        # Fresh live candles LAST + keep="last" => live always wins over any
        # stale row from a previous session (a crashed writer, an old build).
        frames.append(live_df)
        merged = pd.concat(frames, ignore_index=True)
        merged["timestamps"] = pd.to_datetime(merged["timestamps"], errors="coerce")
        merged = merged.dropna(subset=["timestamps"] + OHLCV_COLUMNS)
        merged = merged.drop_duplicates(subset=["timestamps"], keep="last")
        return merged.sort_values("timestamps").reset_index(drop=True)

    def _flush_loop(self) -> None:
        """Background loop: keep the CSVs fresh even when ticks are sparse
        (throttled by the 2s write gate inside _auto_flush)."""
        while True:
            with self._lock:
                if not self._running:
                    return
                tokens = list(self._closed.keys())
            for token in tokens:
                try:
                    self._auto_flush(token)
                except Exception:
                    pass
            time.sleep(self.flush_interval_s)

    def _asset_slug(self, asset_key: str) -> str:
        """Filesystem slug for an asset key. The two indices use the legacy
        nifty50/banknifty names (which every other script reads); any other
        symbol (an NSE equity) gets its own per-symbol files instead of being
        written into the banknifty CSVs."""
        if asset_key == "Nifty 50":
            return "nifty50"
        if asset_key in ("Nifty Bank", "Bank Nifty"):
            return "banknifty"
        return asset_key.replace(" ", "_").replace("-", "_").lower()

    def _auto_flush(self, token: str) -> None:
        """Persist live candles merged with historical context straight to disk.

        Stream-only aggregators (``write_csvs=False``) never touch the files.
        The interval-specific file (e.g. ``nifty50_live_1m.csv``) always gets
        the native live candles. The legacy ``*_live_5m.csv`` file is ONLY ever
        written with real 5-minute data (resampled up from the live 1m candles
        when the feed runs at 1m), so it can never be polluted with 1m rows -
        which previously made the 5m file identical to the 1m file.
        """
        if not self.write_csvs:
            return
        now = time.time()
        last = self._last_flush.get(token, 0.0)
        if now - last < 2.0:  # throttle disk writes to at most once per 2 s per symbol
            return
        self._last_flush[token] = now
        try:
            asset_key = next((k for k, v in self.assets.items() if v["token"] == token), None)
            if not asset_key:
                return
            base_dir = Path(__file__).resolve().parent
            sf = self._asset_slug(asset_key)
            fname = f"{sf}_live_{self.interval_minutes}m.csv"
            legacy_fname = f"{sf}_live_5m.csv"
            hist_fname = f"{sf}_smartapi_5m.csv"

            live_df = self.candles_to_dataframe(asset_key)
            if live_df.empty:
                return

            if self.interval_minutes == 1:
                # Native 1m file: merge with the 1m candles captured in earlier
                # sessions (they accumulate across restarts).
                merged_1m = self._merge_history(live_df, f"{sf}_live_1m.csv")
                merged_1m.to_csv(base_dir / fname, index=False)
                # Legacy 5m file: resample the live 1m candles UP to 5m, then
                # merge with the cached 5m history so it stays a true 5m file
                # (indices only - equities have no canonical 5m CSV to merge).
                if legacy_fname != fname:
                    live_5m = self._resample_to(live_df, 5)
                    merged_5m = self._merge_history(live_5m, hist_fname)
                    merged_5m.to_csv(base_dir / legacy_fname, index=False)
            else:
                merged = self._merge_history(live_df, hist_fname)
                merged.to_csv(base_dir / fname, index=False)
                if legacy_fname != fname:
                    merged.to_csv(base_dir / legacy_fname, index=False)
        except Exception:
            pass

    # -------------------------------------------------------------- websocket
    def _on_open(self, wsapp) -> None:
        logger.info("WebSocket connected - subscribing to index ticks.")
        token_list = [
            {"exchangeType": a["exchange_type"], "tokens": [a["token"]]}
            for a in self.assets.values()
        ]
        try:
            self._sws.subscribe("kronos1", self._sws.QUOTE, token_list)
        except Exception as exc:  # pragma: no cover - network layer
            logger.error("Subscribe failed: %s", exc)

    def _on_ticks(self, wsapp, ticks) -> None:
        if isinstance(ticks, dict):
            ticks = [ticks]
        elif not isinstance(ticks, list):
            return
        for tick in ticks:
            if not isinstance(tick, dict):
                continue
            token = str(tick.get("token"))
            ltp = tick.get("last_traded_price")
            ts_ms = tick.get("exchange_timestamp")
            if token not in self._forming or ltp is None or ts_ms is None:
                continue
            volume = tick.get("volume_trade_for_the_day", 0) or 0
            self._process_tick(token, float(ltp), int(ts_ms), float(volume))

    def _process_tick(self, token: str, price: float, ts_ms: int,
                      volume: float) -> None:
        """Fold one tick into the IST-anchored candle grid.

        ``ts_ms`` is the exchange timestamp (absolute epoch ms); converting
        it with ``tz=IST_TZ`` then flooring via ``_bucket_start`` places the
        tick on the IST wall-clock grid no matter what timezone the machine
        runs in. When the tick belongs to a new bucket the previous candle is
        closed (moved to ``_closed``) and a fresh forming candle starts, so
        a closed candle is never mutated afterwards - exactly what the
        predictor's "predict on every new closed candle" watcher relies on.
        """
        tick_dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=IST_TZ)
        # Only bucket ticks inside the instrument's own trading session
        # (NSE/BSE 09:15-15:30, MCX 09:00-23:30). Angel streams pre-open and
        # post-close quotes; if they were bucketed they would become
        # out-of-session candles in the live CSVs, which resample into
        # phantom 1H bars that read as gaps on the chart.
        start_min, end_min = self._session.get(token, SESSION_WINDOWS[1])
        minutes = tick_dt.hour * 60 + tick_dt.minute
        if minutes < start_min or minutes > end_min:
            return
        bucket = self._bucket_start(tick_dt)
        # SmartAPI sends prices in paise (1/100th); the browser broadcaster
        # divides too, so the aggregator must store rupees to match the
        # history CSVs (nifty50_smartapi_5m.csv etc. are in rupees).
        price = price / self.price_divisor

        with self._lock:
            forming = self._forming.get(token)
            if forming is not None and forming["bucket"] != bucket:
                # Close the previous bucket's candle and start a new one.
                self._closed.setdefault(token, []).append(forming)
                forming = None
            if forming is None:
                forming = {
                    "bucket": bucket,
                    "open": price, "high": price,
                    "low": price, "close": price,
                    "volume": volume,
                }
                self._forming[token] = forming
            else:
                forming["high"] = max(forming["high"], price)
                forming["low"] = min(forming["low"], price)
                forming["close"] = price
                # volume_trade_for_the_day is the CUMULATIVE daily volume, not
                # a per-tick delta - last-wins (never sum it per tick).
                forming["volume"] = volume
            self.last_tick_ts[token] = tick_dt

            # Keep only the last max_days of closed candles (same policy the
            # in-memory buffer always had, now on the IST clock).
            closed = self._closed.get(token, [])
            if len(closed) > 1:
                cutoff = datetime.now(IST_TZ).replace(tzinfo=None) \
                    - timedelta(days=self.max_days)
                self._closed[token] = [c for c in closed if c["bucket"] >= cutoff]

    def _on_close(self, wsapp, *args) -> None:
        logger.info("WebSocket closed.")

    def _on_error(self, wsapp, error, *args) -> None:
        logger.warning("WebSocket error: %s", error)

    def _run(self) -> None:
        try:
            self._sws.connect()
        except Exception as exc:  # pragma: no cover
            logger.error("WebSocket connection failed: %s", exc)
        finally:
            self._running = False

    # ------------------------------------------------------------------ public
    def start(self) -> None:
        """Start the live feed (requires a logged-in SmartAPI session)."""
        session = SmartAPISession()
        if not session.is_logged_in():
            raise SessionExpired(
                "SmartAPI session is stale - log in first (python 8_smartapi_auth.py --login)."
            )
        tokens = session.load_tokens()

        self._sws = SmartWebSocketV2(
            # The stored JWT may carry a ``Bearer `` prefix (older versions of
            # 8_smartapi_auth.py cached it verbatim) - the WebSocket expects
            # the raw token, so reuse the session manager's strip helper.
            auth_token=auth_mod._strip_bearer(tokens.get("jwt")),
            api_key=tokens.get("api_key", ""),
            client_code=tokens.get("client_id", ""),
            feed_token=tokens.get("feed"),
        )
        self._sws.on_open = self._on_open
        self._sws.on_data = self._on_ticks
        self._sws.on_close = self._on_close
        self._sws.on_error = self._on_error
        self._sws._on_close = lambda *args, **kwargs: None

        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        if self.write_csvs:
            self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True)
            self._flush_thread.start()
        logger.info("Live feed started for %s", ", ".join(self.assets))

    def stop(self) -> None:
        self._running = False
        if self._sws is not None:
            try:
                self._sws.close_connection()
            except Exception:  # pragma: no cover
                pass

    def is_running(self) -> bool:
        return self._running and self._thread is not None and self._thread.is_alive()

    def last_price(self, asset_key: str) -> float | None:
        """Latest traded price for an asset key, or ``None`` when the key is
        not subscribed (e.g. the sidebar uses "Bank Nifty" while the feed
        keys are "Nifty Bank") - callers must never crash on unknown keys."""
        asset = self.assets.get(asset_key)
        if asset is None:
            return None
        forming = self._forming.get(asset["token"])
        return forming["close"] if forming else None

    def snapshot(self) -> dict[str, dict]:
        """Return ``{asset_key: {"ltp", "last_ts", "n_candles"}}`` for every
        subscribed asset - one call for the whole watchlist."""
        out: dict[str, dict] = {}
        with self._lock:
            for key, asset in self.assets.items():
                token = asset["token"]
                forming = self._forming[token]
                out[key] = {
                    "ltp": forming["close"] if forming else None,
                    "last_ts": self.last_tick_ts[token],
                    "n_candles": len(self._closed[token]) + (1 if forming else 0),
                }
        return out

    def candles_to_dataframe(self, asset_key: str) -> pd.DataFrame:
        """Closed candles + the still-forming one, as a Kronos-ready DataFrame.
        Returns an empty frame (same schema) for unknown asset keys."""
        asset = self.assets.get(asset_key)
        if asset is None:
            return pd.DataFrame(columns=["timestamps"] + OHLCV_COLUMNS)
        token = asset["token"]
        with self._lock:
            rows = [dict(c) for c in self._closed[token]]
            forming = self._forming[token]
            if forming is not None:
                rows.append(dict(forming))
        if not rows:
            return pd.DataFrame(columns=["timestamps"] + OHLCV_COLUMNS)
        df = pd.DataFrame(rows)
        df = df.rename(columns={"bucket": "timestamps"})
        df = df[["timestamps"] + OHLCV_COLUMNS].sort_values("timestamps").reset_index(drop=True)
        return df

    def save_csv(self, asset_key: str, out_path: str | Path) -> Path:
        if asset_key not in self.assets:
            raise KeyError(
                f"'{asset_key}' is not subscribed by this feed. Subscribed: {list(self.assets)}"
            )
        df = self.candles_to_dataframe(asset_key)
        out_path = Path(out_path)
        df.to_csv(out_path, index=False)
        logger.info("Saved %d live candles to %s", len(df), out_path)
        return out_path


# ---------------------------------------------------------------------------
# Standalone CLI
# ---------------------------------------------------------------------------
def _cli() -> int:
    parser = argparse.ArgumentParser(description="Capture live 5-minute candles via SmartAPI.")
    parser.add_argument("--minutes", type=int, default=60,
                        help="How long to capture (default 60).")
    parser.add_argument("--asset", choices=["nifty", "bank", "both"], default="both")
    parser.add_argument("--out", type=str, default=".",
                        help="Output dir (files named nifty50_live_5m.csv / banknifty_live_5m.csv).")
    args = parser.parse_args()

    assets = {
        "nifty": {"Nifty 50": ASSETS["Nifty 50"]},
        "bank": {"Bank Nifty": ASSETS["Bank Nifty"]},
        "both": ASSETS,
    }[args.asset]

    agg = LiveCandleAggregator(assets=assets)
    try:
        agg.start()
    except SessionExpired as exc:
        print(f"[error] {exc}")
        return 1

    print(f"Capturing live ticks for {args.minutes} minutes ...")
    deadline = time.time() + args.minutes * 60
    try:
        while time.time() < deadline:
            for key in assets:
                price = agg.last_price(key)
                status = f"{price:,.2f}" if price is not None else "—"
                print(f"\r{key:<12} LTP: {status:<14}", end="", flush=True)
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nInterrupted - saving what we have.")
    finally:
        agg.stop()

    print("\nDone.")
    for key in assets:
        fname = "nifty50_live_5m.csv" if key == "Nifty 50" else "banknifty_live_5m.csv"
        agg.save_csv(key, Path(args.out) / fname)
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
