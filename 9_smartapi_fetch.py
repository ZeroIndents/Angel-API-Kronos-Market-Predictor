"""
9_smartapi_fetch.py
===================
Download 5-minute OHLCV candles for Nifty 50 and Bank Nifty from the **Angel
One SmartAPI** (using the API key you already hold) and save them as clean
local CSVs in exactly the same lowercase schema the rest of the Kronos
pipeline expects.

Why this exists next to 1_fetch_data.py:
* yfinance is free but only serves the last ~60 days of 5-minute data and is
  delayed.
* SmartAPI gives exchange-grade candles (equity + index) through your free
  Angel One key - no monthly fee, unlike Kite Connect's 500 INR/month plan.

Output
------
- nifty50_smartapi_5m.csv    (columns: timestamps, open, high, low, close, volume)
- banknifty_smartapi_5m.csv  (columns: timestamps, open, high, low, close, volume)

Usage
-----
    python 9_smartapi_fetch.py --days 60            # both indices
    python 9_smartapi_fetch.py --days 60 --asset nifty
    python 9_smartapi_fetch.py --days 400 --asset both   # deep history, chunked

The script logs in automatically using the credentials in
``smartapi_config.json`` (see 8_smartapi_auth.py).
"""

from __future__ import annotations

import argparse
import importlib.util
import logging
import sys
import time
from pathlib import Path

import pandas as pd
from SmartApi.smartConnect import SmartConnect  # noqa: F401  (re-export for callers)


# ---------------------------------------------------------------------------
# Import the sibling session manager. Its filename starts with a digit, so a
# plain ``import``/``from`` statement cannot be used - load it via importlib
# (same pattern the dashboard uses for all numbered sibling scripts).
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


_auth_mod = _load_auth_module()
SmartAPISession = _auth_mod.SmartAPISession
SessionExpired = _auth_mod.SessionExpired

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
INTERVAL = "FIVE_MINUTE"          # SmartAPI interval enum value
EXCHANGE = "NSE"
# Per-request retention cap for intraday candles (~100 days). We request in
# 30-day chunks to stay comfortably inside the limit and to keep each
# response small, then merge + dedupe locally.
CHUNK_DAYS = 30
SLEEP_BETWEEN_CALLS = 0.5         # well above the 3 req/sec rate limit

# Angel One symbol tokens. Angel One's new master uses a ``999``-prefixed
# token for indices - the legacy 5-digit tokens (26000 / 26009) make
# getCandleData return ``success`` with an EMPTY data array.
ASSETS = {
    "Nifty 50":   {"token": "99926000", "symbol": "NIFTY 50",   "csv": "nifty50_smartapi_5m.csv"},
    "Bank Nifty": {"token": "99926009", "symbol": "NIFTY BANK", "csv": "banknifty_smartapi_5m.csv"},
}

OHLCV_COLUMNS = ["open", "high", "low", "close", "volume"]

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# SmartAPI helpers
# ---------------------------------------------------------------------------
def get_client() -> SmartConnect:
    """Return an authenticated SmartConnect client for today (logs in if the
    cached session is fresh, otherwise raises SessionExpired)."""
    session = SmartAPISession()
    # A fresh cached login is sufficient - the PIN is only needed to *create*
    # a new session, not to use an existing one (users often log in through
    # the dashboard form without saving the PIN to the config file).
    if not session.is_logged_in():
        raise SessionExpired(
            "SmartAPI session is stale or missing. Log in via the dashboard "
            "or run:  python 8_smartapi_auth.py --login"
        )
    return session.get_client()


def _parse_timestamp(value) -> pd.Timestamp:
    """Normalise a SmartAPI candle timestamp to a naive IST Timestamp.

    Angel One may return timestamps as epoch-millisecond ints (legacy tokens)
    or ISO strings with an explicit offset (e.g. ``2026-07-31T09:15:00+05:30``
    with the 999-prefixed index tokens) - handle both, plus naive strings.
    """
    try:
        ts = pd.to_datetime(int(value), unit="ms")
    except (ValueError, TypeError):
        ts = pd.to_datetime(value)
    if ts.tzinfo is None:
        # Legacy epoch-ms values arrive as naive wall-clock readings; treating
        # them as IST matches Angel community practice and the previous
        # behaviour of this script.
        ts = ts.tz_localize("Asia/Kolkata")
    else:
        # ISO strings with an explicit +05:30 offset (the 999-prefix tokens)
        # are unambiguous - convert, don't localize.
        ts = ts.tz_convert("Asia/Kolkata")
    return ts.tz_localize(None)


def fetch_candles(
    client: SmartConnect,
    token: str,
    days: int = 60,
    chunk_days: int = CHUNK_DAYS,
    interval: str = INTERVAL,
    exchange: str = EXCHANGE,
    to_date: pd.Timestamp | None = None,
) -> pd.DataFrame:
    """Fetch ``days`` of candles for one instrument token at the given
    ``interval`` (one of the SmartAPI interval enum values, e.g. ``"FIVE_MINUTE"``
    or ``"ONE_DAY"``).

    ``to_date`` anchors the window instead of "now" (older-page scroll-back);
    pass it as an Asia/Kolkata-aware (or naive-IST) timestamp.

    ``exchange`` defaults to the module-level ``EXCHANGE`` ("NSE" for cash);
    pass ``"NFO"`` for derivative instruments (NIFTY/BANKNIFTY futures) whose
    tokens live in the NFO segment - a cash exchange label returns no data for
    them.

    Requests are issued in ``chunk_days``-wide windows working backwards from
    now, so arbitrarily deep history can be pulled while respecting the
    per-request retention cap and the 3 req/sec rate limit.
    """
    frames: list[pd.DataFrame] = []
    # ``to_date`` lets callers pull an OLDER window (infinite scroll-back on
    # the charts) instead of always the most recent ``days`` up to now. The
    # window depth is measured back from this anchor (not from real "now",
    # which would exit the loop after a single chunk for an old window).
    anchor = to_date if to_date is not None else pd.Timestamp.now(tz="Asia/Kolkata")
    end = anchor

    logger.info("Fetching %d days of %s data for token %s (%s) ...",
                days, interval.lower(), token, exchange)
    while True:
        start = end - pd.Timedelta(days=chunk_days)
        params = {
            "exchange": exchange,
            "symboltoken": token,
            "interval": interval,
            "fromdate": start.strftime("%Y-%m-%d %H:%M"),
            "todate": end.strftime("%Y-%m-%d %H:%M"),
        }
        logger.debug("Request window: %s -> %s", params["fromdate"], params["todate"])
        response = None
        for attempt in range(3):
            response = client.getCandleData(params)
            if isinstance(response, dict) and response.get("status") is True:
                break
            msg = response.get("message", "") if isinstance(response, dict) else ""
            if "Too many requests" in msg or "AB1021" in str(response):
                logger.warning("Angel REST rate limited (attempt %d/3) - waiting 1s...", attempt + 1)
                time.sleep(1.0)
            else:
                break

        if not isinstance(response, dict) or response.get("status") is not True:
            msg = response.get("message", "unknown error") if isinstance(response, dict) else "no response"
            raise ConnectionError(f"getCandleData failed: {msg}")

        rows = response.get("data") or []
        if rows:
            df = pd.DataFrame(rows, columns=["timestamps", "open", "high", "low", "close", "volume"])
            df["timestamps"] = df["timestamps"].map(_parse_timestamp)
            frames.append(df)
        else:
            # A single window can legitimately be empty (holidays, weekends) - do
            # not abort a deep multi-chunk fetch because of it; fail at the end
            # if *no* window returned anything.
            logger.info("No candles in window %s -> %s (token %s); skipping.",
                        params["fromdate"], params["todate"], token)

        time.sleep(SLEEP_BETWEEN_CALLS)
        end = start
        if (anchor - start).days >= days:
            break

    if not frames:
        raise ValueError(
            f"No data returned for token {token} on {exchange}. For indices make "
            "sure the 999-prefixed token is used (e.g. 99926000 for NIFTY 50, "
            "99926009 for BANK NIFTY); for futures pass exchange='NFO'. "
            "Also confirm the window covers trading days."
        )

    df = pd.concat(frames, ignore_index=True)
    df = df.drop_duplicates(subset=["timestamps"], keep="last")
    df = df.sort_values("timestamps").reset_index(drop=True)

    # Keep only the most recent `days` worth of sessions.
    cutoff = df["timestamps"].max() - pd.Timedelta(days=days)
    df = df[df["timestamps"] >= cutoff].reset_index(drop=True)

    for col in OHLCV_COLUMNS:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=OHLCV_COLUMNS)

    logger.info("Fetched %d candles (%s -> %s).", len(df), df["timestamps"].iloc[0], df["timestamps"].iloc[-1])
    return df


def save_asset_csv(
    asset_key: str,
    output_dir: str | Path = ".",
    days: int = 60,
    client: SmartConnect | None = None,
) -> Path:
    """Fetch one asset and save it to CSV. Returns the output path."""
    if asset_key not in ASSETS:
        raise KeyError(f"Unknown asset '{asset_key}'. Available: {list(ASSETS)}")
    asset = ASSETS[asset_key]
    client = client or get_client()
    df = fetch_candles(client, asset["token"], days=days)
    out_path = Path(output_dir) / asset["csv"]
    df.to_csv(out_path, index=False)
    logger.info("Saved %d rows to %s", len(df), out_path)
    return out_path


def fetch_all(
    output_dir: str | Path = ".",
    days: int = 60,
    client: SmartConnect | None = None,
) -> dict[str, Path]:
    """Download and save every configured asset. Returns {asset_key: path}."""
    client = client or get_client()
    return {key: save_asset_csv(key, output_dir=output_dir, days=days, client=client)
            for key in ASSETS}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch NSE 5-minute data via Angel One SmartAPI.")
    parser.add_argument("--days", type=int, default=60, help="How many days of 5-minute data (default 60).")
    parser.add_argument("--asset", choices=["nifty", "bank", "both"], default="both")
    args = parser.parse_args()

    try:
        cli_client = get_client()
    except SessionExpired as exc:
        print(f"[error] {exc}")
        raise SystemExit(1)

    keys = {
        "nifty": ["Nifty 50"],
        "bank": ["Bank Nifty"],
        "both": list(ASSETS),
    }[args.asset]

    print("\nDone. Saved files:")
    for key in keys:
        path = save_asset_csv(key, days=args.days, client=cli_client)
        print(f"  {key:<12} -> {path}")
