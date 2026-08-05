"""
server.py
=========
Standalone **live chart terminal** for the Kronos platform — a
self-contained FastAPI app: history REST, live WebSocket and the Kronos AI
forecast overlay for the three public instruments (Nifty 50, NIFTY FUT,
Bank Nifty).

Endpoints
---------
+-------------------------+--------------------------------------------------+
| Method / path           | Purpose                                          |
+-------------------------+--------------------------------------------------+
| ``GET  /``              | The chart UI (static/index.html)                 |
| ``GET  /styles.css``    | Dark theme stylesheet                            |
| ``GET  /app.js``        | Chart application bundle                         |
| ``GET  /api/symbols``   | The 3 public instruments (symbol picker)         |
| ``GET  /api/search``    | Search - only the 3 public instruments ever      |
| ``GET  /api/ltp``       | Last traded price                                |
| ``GET  /api/history``   | OHLCV candles (Angel One REST, CSV fallback)     |
| ``GET  /api/auth/status``| SmartAPI login status + market clock             |
| ``POST /api/auth/login``| Perform the daily TOTP login                     |
| ``WS   /ws?symbol=...`` | Live ticks (Angel One SmartWebSocketV2)          |
| ``POST /api/kronos/forecast`` | Kronos AI overlay forecast (dashed line)    |
+-------------------------+--------------------------------------------------+

Data flow
---------
* **History** — served from the Angel One SmartAPI REST API when a session
  is logged in (any interval: 1m/5m/15m/30m/1H/1D). When there is no valid
  session (or the request fails), the server gracefully falls back to the
  cached local SmartAPI CSVs (resampled for non-5m intervals), so the chart
  always has candles to show.
* **Live** — ONE shared ``SmartWebSocketV2`` connection (the background
  CSV recorder) subscribes to the whole watchlist and is bridged to the
  browser over this server's own WebSocket: every raw tick is forwarded to
  the panes watching that symbol, and the *browser* folds it into the
  current forming candle via ``series.update()`` — exactly the TradingView
  pattern. A single socket means we never trip Angel's concurrent-connection
  limit (which previously 429'd the feed). With the market closed the
  socket stays connected and idles until ticks arrive on the next session.
* **Kronos** — ``POST /api/kronos/forecast`` runs the local NVIDIA Kronos
  model on the current candles and returns a forecast path the UI draws as
  a dashed line series over the chart.

Run
---
    .venv/Scripts/python.exe server.py      # Windows
    .venv/bin/python server.py              # Linux / macOS (see docs/)
    -> http://127.0.0.1:81

Credentials
-----------
Angel One requires a fresh 2FA login every trading day. The server reuses
``8_smartapi_auth.py``: credentials live in ``smartapi_config.json`` (or an
optional ``.env`` — see ``.env.example``), tokens are cached in
``smartapi_tokens.json``. Use the in-app login button, the CLI
(``python 8_smartapi_auth.py --login``) or the dashboard login form.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
# Flattened single-folder layout: the chart server and its support modules
# (2_kronos_inference, 8_smartapi_auth, ...) all live in the same directory,
# so the "project root" IS this folder.
PROJECT_DIR = BASE_DIR
HISTORY_DIR = PROJECT_DIR / "history"      # deep cache (created on demand)

# This script runs directly from its own subfolder (sys.path[0] = BASE_DIR),
# so make the project root importable before pulling in kronos_common.
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from kronos_common import import_script  # noqa: E402


# ---------------------------------------------------------------------------
# Sibling-module loading (digit-leading filenames -> importlib). Reuses any
# module the Streamlit app already imported so caches (predictor, session)
# are shared process-wide when both apps run side by side.
# ---------------------------------------------------------------------------
def _import_script(rel_path: str):
    """Import a digit-prefixed sibling script, reusing any module already in
    ``sys.modules`` so shared caches stay process-wide - see
    kronos_common.import_script()."""
    return import_script(rel_path, PROJECT_DIR)


auth_mod = _import_script("8_smartapi_auth.py")
fetch_mod = _import_script("9_smartapi_fetch.py")
live_mod = _import_script("10_smartapi_live.py")
infer_mod = _import_script("2_kronos_inference.py")
universe_mod = _import_script("16_market_universe.py")

SmartAPISession = auth_mod.SmartAPISession
SessionExpired = auth_mod.SessionExpired

# ---------------------------------------------------------------------------
# .env support (tiny parser - python-dotenv is not installed). Values found
# here are used to seed smartapi_config.json so every other script (and the
# daily login) picks them up automatically.
# ---------------------------------------------------------------------------
def _read_env(path: Path) -> dict:
    out: dict = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        out[key.strip()] = val.strip().strip('"').strip("'")
    return out


def _seed_config_from_env() -> None:
    env = {}
    for p in (PROJECT_DIR / ".env", BASE_DIR / ".env"):
        env.update(_read_env(p))
    if not env:
        return
    session = SmartAPISession()
    cfg = session.load_config()
    mapping = {
        "API_KEY": "api_key",
        "CLIENT_ID": "client_id",
        "PIN": "pin",
        "TOTP_SECRET": "totp_secret",
    }
    additions = {json_key: env[env_key]
                 for env_key, json_key in mapping.items()
                 if env.get(env_key) and not cfg.get(json_key)}
    if additions:
        session.save_config(additions)


_seed_config_from_env()

# ---------------------------------------------------------------------------
# Interval + asset configuration
# ---------------------------------------------------------------------------
# SmartAPI REST interval enum values (Angel One: 1m/3m/5m/10m/15m/30m/1H/1D).
INTERVALS = {
    "1m": "ONE_MINUTE",
    "5m": "FIVE_MINUTE",
    "15m": "FIFTEEN_MINUTE",
    "30m": "THIRTY_MINUTE",
    "1H": "ONE_HOUR",
    "1D": "ONE_DAY",
}
DEFAULT_INTERVAL = "5m"

# Index assets stream on the WebSocket and have deep local CSV fallbacks.
LIVE_ASSETS = {
    "Nifty 50":   {"token": "99926000", "exchange_type": 1},
    "Nifty Bank": {"token": "99926009", "exchange_type": 1},
    "Bank Nifty": {"token": "99926009", "exchange_type": 1},
}
CSV_FALLBACK = {
    "Nifty 50":   "nifty50_smartapi_5m.csv",
    "Nifty Bank": "banknifty_smartapi_5m.csv",
    "Bank Nifty": "banknifty_smartapi_5m.csv",
}

OHLCV_COLUMNS = ["open", "high", "low", "close", "volume"]

app = FastAPI(
    title="Kronos View",
    description=(
        "Live chart viewer for the Kronos AI forecasting platform: Angel One "
        "SmartAPI history + live ticks and the local NVIDIA Kronos forecast "
        "overlay. Research use only."
    ),
    version="1.0.0-public",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------
# PUBLIC BUILD - exactly THREE chartable instruments. Every resolution
# path (history, ltp, live WS, forecast) is gated through _resolve_asset, so
# this single allowlist keeps the terminal locked to these instruments no
# matter what symbol string a client sends. 'Nifty Bank' is the same index
# as 'Bank Nifty' (alias kept for the symbol picker dedup).
ALLOWED_SYMBOLS = {"Nifty 50", "NIFTY FUT", "Bank Nifty", "Nifty Bank"}


def _resolve_token(symbol: str) -> str | None:
    """SmartAPI token for a display label (index assets first, then the
    market-universe master for NIFTY FUT)."""
    asset = _resolve_asset(symbol)
    return asset["token"] if asset else None


def _resolve_asset(symbol: str) -> dict | None:
    """Resolve a display label to ``{token, exchange, exchange_type}``.

    Each SmartAPI segment has its OWN REST ``exchange`` label AND WebSocket
    exchangeType (NSE_CM = 1, NSE_FO = 2, BSE_CM = 3, MCX = 5). Every
    consumer (history fetch, live broadcaster, CSV recorder) must use the
    instrument's own segment or the request/stream silently returns nothing -
    this helper keeps them aligned for equities, indices, index/stock
    futures, options and commodities alike.

    PUBLIC BUILD: refuses anything outside ALLOWED_SYMBOLS - a symbol picker
    limited to the three curated instruments is meaningless if /api/history
    still serves the whole SmartAPI universe to hand-crafted requests.
    """
    if symbol not in ALLOWED_SYMBOLS:
        return None
    if symbol in LIVE_ASSETS:
        info = LIVE_ASSETS[symbol]
        return {"token": info["token"], "exchange": "NSE",
                "exchange_type": info.get("exchange_type", 1)}
    try:
        rec = universe_mod.resolve(symbol) if universe_mod is not None else None
        if rec and rec.get("token"):
            seg = str(rec.get("exch_seg", "NSE"))
            return {
                "token": str(rec["token"]),
                "exchange": universe_mod.SEGMENT_EXCHANGE.get(seg, "NSE"),
                "exchange_type": universe_mod.SEGMENT_EXCHANGE_TYPE.get(seg, 1),
            }
    except Exception:
        pass
    return None


def _to_utc_epoch(ts) -> list[int]:
    """Convert naive-IST candle timestamps to UTC epoch seconds (the format
    lightweight-charts expects). Accepts a Series or a DatetimeIndex (the
    forecast DataFrame's index is a DatetimeIndex, history columns are
    Series - both must work)."""
    ts = pd.to_datetime(ts)
    if isinstance(ts, pd.DatetimeIndex):
        utc = (ts.tz_localize("Asia/Kolkata", ambiguous="infer")
                 .tz_convert("UTC"))
    else:
        utc = (ts.dt.tz_localize("Asia/Kolkata", ambiguous="infer")
                 .dt.tz_convert("UTC"))
    return [int(v) for v in (utc.astype("int64") // 10 ** 9).tolist()]


def _resample(df: pd.DataFrame, interval: str) -> pd.DataFrame:
    """Resample candles to the requested interval (fallback path only - the
    live REST path already returns the right interval).

    Buckets are anchored to the IST grid (Asia/Kolkata = UTC+5:30): the
    input timestamps are naive-IST (every CSV in this project is), so they
    are localized to IST before resampling and de-localized after. A plain
    UTC-anchored resample would put 1H candles on :30/:00 UTC (06:30 IST)
    instead of the :00/:30 IST boundaries the REST API, the live recorder
    and the browser's candle bucketing all use - which used to produce
    duplicated/misaligned candles at the seams."""
    # 5m MUST be a real rule here - the live-CSV merge feeds the 1m recorder
    # file through _resample(df, '5m'), and a no-op shortcut (the old
    # behavior, fine for the 5m-native cache path) leaked 1-minute rows into
    # the 5m chart, producing non-uniform bar spacing that broke rendering
    # when zoomed out and panned.
    rule = {"5m": "5min", "15m": "15min", "30m": "30min", "1H": "1h", "1D": "1D"}.get(interval)
    if rule is None:
        # 1m cannot be reconstructed from a coarser source - return an EMPTY
        # frame rather than silently serving 5m rows labelled as 1m (which
        # used to inject 5m bars into the 1m chart at :00/:05 boundaries).
        return pd.DataFrame(columns=["timestamps"] + OHLCV_COLUMNS)
    # Angel's native intraday candles are anchored to the NSE market-open
    # grid (09:15 IST: 09:15/09:20 for 5m, 09:15/09:45 for 30m, 09:15/10:15
    # for 1H). Resampling on the wall-clock grid (00:00 IST) produced a
    # SECOND offset grid (09:00/09:30/...) that interleaved with the native
    # bars - giving 30m/1H charts bars only 15 min apart (non-uniform bar
    # spacing that broke rendering when the user zoomed out and panned).
    # Shift the index so 09:15 IST becomes 00:00, resample on the midnight
    # grid, then shift back. 1D stays midnight-anchored (matches Angel daily).
    idx = pd.to_datetime(df["timestamps"]).dt.tz_localize(
        "Asia/Kolkata", ambiguous="infer")
    d = df.assign(_ts=idx).set_index("_ts")
    agg = {"open": "first", "high": "max", "low": "min", "close": "last",
           "volume": "sum"}
    anchor = None if rule == "1D" else pd.Timedelta(hours=9, minutes=15)
    if anchor is not None:
        d.index = d.index - anchor
    out = (d.resample(rule).agg(agg)
           .dropna(subset=["open"])
           .reset_index()
           .rename(columns={"_ts": "timestamps"}))
    if anchor is not None:
        out["timestamps"] = out["timestamps"] + anchor
    out["timestamps"] = out["timestamps"].dt.tz_localize(None)
    return out[["timestamps"] + OHLCV_COLUMNS]


def _merge_frames(frames: list[pd.DataFrame], days: int) -> pd.DataFrame:
    """Concatenate candle frames, dedupe by timestamp (LAST source wins, so
    append the freshest frame last), sort and trim to the last ``days``."""
    frames = [f for f in frames if f is not None and len(f)]
    if not frames:
        return pd.DataFrame(columns=["timestamps"] + OHLCV_COLUMNS)
    merged = pd.concat(frames, ignore_index=True)
    merged["timestamps"] = pd.to_datetime(merged["timestamps"], errors="coerce")
    merged = merged.dropna(subset=["timestamps"] + OHLCV_COLUMNS)
    merged = merged.drop_duplicates(subset=["timestamps"], keep="last")
    merged = merged.sort_values("timestamps").reset_index(drop=True)
    cutoff = merged["timestamps"].max() - pd.Timedelta(days=days)
    return merged[merged["timestamps"] >= cutoff].reset_index(drop=True)


def _clip_to_session(df: pd.DataFrame, interval: str) -> pd.DataFrame:
    """Drop candle rows whose START time is outside the NSE cash session
    (09:15-15:30 IST). Daily candles (``interval == "1D"``, midnight-anchored)
    are returned untouched - the guard lives HERE, not at the call sites, so a
    future caller can never silently wipe a daily series.

    The live recorder buckets whatever ticks Angel streams - including pre-open
    (~07:51) and post-close (~15:56) quotes - so the live CSVs can contain
    out-of-session candles. Left unclipped, a 07:51 row resamples into phantom
    1H candles at 07:15/08:15 (pre-open) that show up as stray bars / gaps on
    the chart, and post-close rows add candles after the session. Expects
    ``df["timestamps"]`` already parsed as datetime64 (every caller parses
    before this runs)."""
    if interval == "1D" or df is None or df.empty:
        return df
    hm = df["timestamps"].dt.hour * 60 + df["timestamps"].dt.minute
    return df[(hm >= 9 * 60 + 15) & (hm <= 15 * 60 + 30)].reset_index(drop=True)


def _live_slug(symbol: str) -> str:
    """Filesystem slug for the live recorder CSVs - must match
    10_smartapi_live.LiveCandleAggregator._asset_slug exactly."""
    if symbol == "Nifty 50":
        return "nifty50"
    if symbol in ("Nifty Bank", "Bank Nifty"):
        return "banknifty"
    return symbol.replace(" ", "_").replace("-", "_").lower()


# The live CSVs are re-read on EVERY /api/history request - and when the
# Angel REST session is down (the common case), they are the PRIMARY source,
# so 4 panes clicking intervals would re-parse ~200KB files constantly.
# Short TTL cache (the recorder flushes every ~2 s, so 5 s is safely fresh).
_LIVE_CSV_CACHE: dict = {}
_LIVE_CSV_TTL = 5.0
_LIVE_CSV_LOCK = threading.Lock()


def _live_csv_frames(symbol: str, interval: str) -> list[pd.DataFrame]:
    """Read the background recorder's live CSVs (``{slug}_live_1m.csv`` and
    ``{slug}_live_5m.csv``) for ``symbol`` at the requested ``interval``
    (native for 1m/5m, IST-anchored resample otherwise).

    These files are written continuously by 10_smartapi_live.py and hold the
    FRESHEST candles (including today's and the forming one) that the deep
    ``history/`` cache - backfilled on a schedule - does not. Merging them
    into every interval keeps the live candles on screen across timeframe
    switches instead of them vanishing behind stale cache data."""
    key = (symbol, interval)
    now = time.time()
    with _LIVE_CSV_LOCK:
        hit = _LIVE_CSV_CACHE.get(key)
        if hit is not None and now - hit[0] < _LIVE_CSV_TTL:
            return [f.copy() for f in hit[1]]
    slug = _live_slug(symbol)
    frames: list[pd.DataFrame] = []
    for fname, native in ((f"{slug}_live_1m.csv", "1m"),
                          (f"{slug}_live_5m.csv", "5m")):
        # Only ever resample UP (1m -> anything, 5m -> 15m/30m/1H/1D). A
        # 1m target must come only from the native 1m file - down-resampling
        # 5m rows into the 1m chart would corrupt it.
        if interval == "1m" and native != "1m":
            continue
        path = PROJECT_DIR / fname
        if not path.is_file():
            continue
        try:
            df = pd.read_csv(path)
            df["timestamps"] = pd.to_datetime(df["timestamps"], errors="coerce")
            df = df.dropna(subset=["timestamps"] + OHLCV_COLUMNS)
            if interval != native:
                df = _resample(df, interval)
            df = _clip_to_session(df, interval)
            if len(df) >= 2:
                frames.append(df)
        except Exception as exc:
            print(f"[history] live CSV read failed for {fname}: {exc}")
    if frames:
        with _LIVE_CSV_LOCK:
            _LIVE_CSV_CACHE[key] = (time.time(), frames)
    return frames


# The DEEP cache (history/*.csv) is re-read AND re-resampled on every
# /api/history request - up to 18k rows per file, on every range button
# click and pane. Unlike the live CSVs (which the recorder rewrites every
# ~2 s) the deep cache only changes when 22_history_backfill.py runs on a
# schedule, so an mtime-signature-keyed memo makes repeated requests
# effectively free while still picking up a fresh backfill automatically.
_DEEP_CACHE: dict = {}
_DEEP_CACHE_TTL = 120.0
_DEEP_CACHE_LOCK = threading.Lock()


def _deep_cache_sig(paths: list[Path]) -> str:
    """Signature of a set of candidate cache files: path + mtime_ns + size.
    Any backfill that writes a file changes the signature, busting the memo."""
    parts: list[str] = []
    for p in paths:
        try:
            st = p.stat()
            parts.append(f"{p.name}:{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append(f"{p.name}:missing")
    return "|".join(parts)


def _history_cache_df(symbol: str, interval: str, days: int = 365,
                      before: pd.Timestamp | None = None,
                      allow_empty: bool = False
                      ) -> tuple[pd.DataFrame | None, dict | None]:
    """Read deep history from the ``history/`` cache written by
    ``22_history_backfill.py`` (5y daily / 365d intraday for the whole
    watchlist). Returns ``(df, meta)`` or ``(None, None)`` when the cache has
    nothing for this symbol+interval.

    Intraday intervals that were not backfilled themselves (15m/30m/1H) are
    resampled from the cached 5m series on the fly. When ``allow_empty`` is
    set (older-page loads) and the cache exists but has nothing older than
    ``before``, an empty frame is returned with ``meta["done"]`` so the UI
    can stop scrolling instead of erroring.

    The expensive part - reading the CSVs, IST-anchored resampling, session
    clipping and merging - is memoized per (symbol, interval, file-signature)
    so a range-button click storm doesn't re-parse megabytes every time."""
    if interval not in INTERVALS:
        return None, None
    token = _resolve_token(symbol)
    if token is None:
        return None, None
    if interval == "1m":
        candidates = [(HISTORY_DIR / f"{token}_1m.csv", None)]
        # Angel's ONE_MINUTE retention is only ~10 days, so the backfilled
        # 1m cache is usually thin (sometimes a single partial day). The live
        # 1m CSV the background recorder writes holds the recent sessions and
        # often has FAR more rows - merge it in (appended LAST so the freshest
        # rows win on overlapping timestamps) so the 1m chart shows real
        # depth instead of "today only". Same slug rules as the recorder
        # (10_smartapi_live.LiveCandleAggregator._asset_slug).
        live_fname = PROJECT_DIR / f"{_live_slug(symbol)}_live_1m.csv"
        if live_fname.is_file():
            candidates.append((live_fname, None))
    elif interval == "5m":
        candidates = [(HISTORY_DIR / f"{token}_5m.csv", None)]
    else:
        # 15m/30m/1H: the resampled-5m fallback FIRST and the genuine interval
        # cache LAST - on overlapping timestamps keep='last' below lets the
        # real cache win over the approximate resample.
        candidates = [
            (HISTORY_DIR / f"{token}_5m.csv", interval),
            (HISTORY_DIR / f"{token}_{interval}.csv", None),
        ]

    # Read EVERY candidate and merge them (deep cache first, live CSV last so
    # the freshest rows win on overlapping timestamps) instead of returning
    # the first file that happens to have two candles - the old behaviour
    # could serve a 1-day 1m cache while a much deeper live CSV sat unused.
    # This whole read+resample+clip+merge block is memoized on the source
    # files' mtime signature - it only changes on a backfill run.
    sig_paths = [p for p, _ in candidates]
    sig = _deep_cache_sig(sig_paths)
    cache_key = (symbol, interval, sig)
    _now = time.time()
    with _DEEP_CACHE_LOCK:
        _hit = _DEEP_CACHE.get(cache_key)
        if _hit is not None and _now - _hit[0] < _DEEP_CACHE_TTL:
            df, degraded = _hit[1][0].copy(), _hit[1][1]
        else:
            df, degraded = None, False
    if df is None:
        frames: list[pd.DataFrame] = []
        used_resample = False
        used_native = False
        for path, resample_to in candidates:
            if not path.is_file():
                continue
            try:
                fdf = pd.read_csv(path)
                fdf["timestamps"] = pd.to_datetime(fdf["timestamps"])
                if resample_to:
                    fdf = _resample(fdf, resample_to)
                    used_resample = True
                else:
                    used_native = True
                fdf = _clip_to_session(fdf, interval)
                if len(fdf) < 2:
                    continue
                frames.append(fdf)
            except Exception as exc:
                print(f"[history] cache read failed for {path}: {exc}")
        if not frames:
            return None, None
        # "degraded" only when the interval has NO real cache of its own and
        # we had to fall back to a resampled 5m series - a genuine
        # 15m/30m/1H cache (even merged with the resample) is NOT degraded.
        degraded = used_resample and not used_native
        df = pd.concat(frames, ignore_index=True)
        df = df.drop_duplicates(subset=["timestamps"], keep="last")
        df = df.sort_values("timestamps").reset_index(drop=True)
        with _DEEP_CACHE_LOCK:
            _DEEP_CACHE[cache_key] = (time.time(), (df.copy(), degraded))

    if before is not None:
        df = df[df["timestamps"] < before]
        if len(df) < 2:
            if allow_empty:
                empty = df.iloc[0:0].copy()
                meta = {
                    "source": "history-cache",
                    "degraded": degraded,
                    "done": True,
                    "available": {"start": None, "end": None,
                                   "rows": 0, "interval": interval},
                }
                return empty, meta
            return None, None

    cutoff = df["timestamps"].max() - pd.Timedelta(days=days)
    df = df[df["timestamps"] >= cutoff].reset_index(drop=True)
    if len(df) < 2:
        return None, None

    meta = {
        "source": "history-cache",
        "degraded": degraded,
        "available": {
            "start": _to_utc_epoch(df["timestamps"].iloc[:1])[0],
            "end": _to_utc_epoch(df["timestamps"].iloc[-1:])[0],
            "rows": int(len(df)),
            "interval": interval,
        },
    }
    return df, meta



# Fresh recent-window Angel REST cache: the browser's range buttons and
# interval switches all hit /api/history; caching the REST response for a
# few seconds keeps us comfortably inside Angel's 3 req/s rate limit while
# still serving FRESH candles on every reload.
_REST_RECENT_CACHE: dict = {}
_REST_RECENT_TTL = 25.0
_REST_RECENT_TTL_OLD = 600.0   # historical scroll-back windows are stable (10 min)
_REST_RECENT_LOCK = threading.Lock()


def _fetch_rest_recent(symbol: str, interval: str, days: int,
                        end_ts: pd.Timestamp | None = None) -> pd.DataFrame | None:
    """Fresh Angel One REST candles for the recent ``days`` (TTL-cached).

    Returns None when there is no usable session (or the request fails) so
    callers fall back to the deep cache / CSV. 1m uses a 10-day chunk
    (Angel's ONE_MINUTE retention is ~10 days per request); everything else
    uses 30-day chunks.
    """
    asset = _resolve_asset(symbol)
    if asset is None:
        return None
    token = asset["token"]
    exchange = asset["exchange"]
    # Older-page (scroll-back) windows are historical and stable, so they get
    # a much longer TTL than the fast-moving recent window. ``end_ts`` makes
    # the fetch walk backwards from that moment instead of from now.
    key = (symbol, interval, None if end_ts is None else int(end_ts.timestamp()))
    now = time.time()
    ttl = _REST_RECENT_TTL if end_ts is None else _REST_RECENT_TTL_OLD
    with _REST_RECENT_LOCK:
        hit = _REST_RECENT_CACHE.get(key)
        if hit is not None and now - hit[0] < ttl:
            return hit[1]
    # Angel One limits us to ~3 requests/second; a fresh page load with a
    # few panes can briefly exceed that. Retry with short backoff so a
    # rate-limit hiccup degrades to a slow response instead of a stale
    # history-cache fallback.
    df = None
    for attempt in range(3):
        try:
            client = SmartAPISession().get_client()
            chunk = 10 if interval == "1m" else 30
            # Scroll-back windows arrive tz-naive IST (see api/history before=);
            # localize so fetch_candles' chunk arithmetic stays tz-consistent.
            fetch_to = None
            if end_ts is not None:
                fetch_to = end_ts.tz_localize("Asia/Kolkata") \
                    if getattr(end_ts, "tzinfo", None) is None else end_ts
            df = fetch_mod.fetch_candles(
                client, token, days=days, chunk_days=chunk,
                interval=INTERVALS[interval], exchange=exchange,
                to_date=fetch_to,
            )
            break
        except SessionExpired:
            return None
        except Exception as exc:
            if "rate" in str(exc).lower() and attempt < 2:
                time.sleep(1.0 * (attempt + 1))
                continue
            print(f"[history] Angel REST failed for {symbol} {interval}: {exc}")
            return None
    if df is None or len(df) < 2:
        return None
    with _REST_RECENT_LOCK:
        _REST_RECENT_CACHE[key] = (now, df.copy())
    return df


def _history_df(symbol: str, interval: str = DEFAULT_INTERVAL,
                days: int = 30, before: pd.Timestamp | None = None
                ) -> tuple[pd.DataFrame, dict]:
    """Best-effort OHLCV history for ``symbol`` at ``interval``.

    Priority: deep ``history/`` cache (5y) -> Angel REST -> live recorder
    CSVs -> cached static CSV. The live CSVs are ALWAYS merged on top of
    whatever base frame is used (keep-last dedupe), so today's candles - and
    the forming one - survive a timeframe switch for EVERY interval, not
    just 1m. Returns ``(df, meta)`` where ``meta`` describes the data source
    so the UI can badge it (``angel-rest`` / ``history-cache`` /
    ``live-csv`` / ``csv-fallback``)."""
    if interval not in INTERVALS:
        raise HTTPException(status_code=400, detail=f"Unknown interval '{interval}'.")

    # --- older-page loads (infinite scroll-back): deep cache only ---
    if before is not None:
        df, meta = _history_cache_df(symbol, interval, days=days, before=before,
                                     allow_empty=True)
        return df, meta

    # --- fresh recent candles: Angel REST first, merged over the deep cache ---
    # The deep cache alone is stale by construction (it is backfilled on a
    # schedule), so EVERY interval - not just 1m - must get today's candles
    # from the live REST API. The cache still provides the deep bulk for
    # wide ranges, and the merge dedupes by timestamp (REST wins) so the
    # chart always ends at the true latest close.
    recent_days = max(1, min(days, 45))
    rest_df = _fetch_rest_recent(symbol, interval, recent_days)
    try:
        cache_df, cache_meta = _history_cache_df(symbol, interval, days=days)
    except Exception as exc:
        cache_df, cache_meta = None, None
        print(f"[history] cache lookup failed for {symbol}: {exc}")
    # Live recorder CSVs (today's candles + the forming one) for EVERY
    # interval - the key fix that keeps the current candles on screen when
    # switching timelines, even offline / without a fresh Angel session.
    live_frames = _live_csv_frames(symbol, interval)
    has_live = bool(live_frames)

    if rest_df is not None:
        if cache_df is not None and not cache_df.empty:
            combined = _merge_frames([cache_df, rest_df] + live_frames, days)
            if len(combined) >= 2:
                meta = dict(cache_meta or {})
                meta["source"] = "angel-rest+cache" + ("+live" if has_live else "")
                meta["degraded"] = bool(meta.get("degraded", False))
                return combined, meta
        combined = _merge_frames([rest_df] + live_frames, days)
        if len(combined) >= 2:
            return combined, {"source": "angel-rest" + ("+live" if has_live else ""),
                              "degraded": False}

    # --- fallback: deep cache (merged with the live tail) ---
    if cache_df is not None and len(cache_df) >= 2:
        combined = _merge_frames([cache_df] + live_frames, days)
        if len(combined) >= 2:
            meta = dict(cache_meta or {})
            meta["source"] = (meta.get("source") or "history-cache") \
                + ("+live" if has_live else "")
            return combined, meta

    # --- live CSVs alone (symbols with no deep cache / offline) ---
    if live_frames:
        combined = _merge_frames(live_frames, days)
        if len(combined) >= 2:
            return combined, {"source": "live-csv", "degraded": False}

    # --- last resort: cached static CSV (resampled for coarser intervals) ---
    fname = CSV_FALLBACK.get(symbol)
    if fname:
        path = PROJECT_DIR / fname
        if path.is_file():
            try:
                df = pd.read_csv(path)
                df["timestamps"] = pd.to_datetime(df["timestamps"])
                if interval != "5m":
                    df = _resample(df, interval)
                combined = _merge_frames([df] + live_frames, days)
                if len(combined) >= 2:
                    return combined, {"source": "csv-fallback" + ("+live" if has_live else ""),
                                      "degraded": False}
            except Exception as exc:
                print(f"[history] CSV fallback failed: {exc}")

    raise HTTPException(
        status_code=404,
        detail=(f"No data for '{symbol}' ({interval}). Log in to Angel One "
                f"or add a cached CSV (nifty50/banknifty_smartapi_5m.csv)."),
    )


# Cap candles per /api/history response. A 1Y range on a 5m chart is ~18k
# rows - serializing + re-rendering all of them on every interval switch is
# the bulk of the "lag" when switching timelines. TradingView loads a bounded
# window and pages older candles on scroll (the UI already does via before=).
MAX_CANDLES = 15000


def _candles_payload(df: pd.DataFrame, symbol: str, interval: str,
                     meta: dict) -> dict:
    """JSON payload for /api/history: UTC-epoch times + OHLCV floats."""
    if len(df) > MAX_CANDLES:
        df = df.iloc[-MAX_CANDLES:]
    return {
        "symbol": symbol,
        "interval": interval,
        "meta": meta,
        "candles": [
            {
                "time": t,
                "open": round(float(o), 2),
                "high": round(float(h), 2),
                "low": round(float(l), 2),
                "close": round(float(c), 2),
                "volume": float(v),
            }
            for t, o, h, l, c, v in zip(
                _to_utc_epoch(df["timestamps"]),
                df["open"], df["high"], df["low"], df["close"], df["volume"],
            )
        ],
    }


# ---------------------------------------------------------------------------
# Live tick bridge: SmartWebSocketV2 -> browser WebSocket clients
# ---------------------------------------------------------------------------
class _TickBroadcaster(live_mod.LiveCandleAggregator):
    """LiveCandleAggregator that ALSO forwards every raw tick to the browser
    clients registered for its symbol (the browser does its own candle
    bucketing so the current candle updates with ``series.update()``)."""

    def __init__(self, assets: dict, sink) -> None:
        # Stream-only: the CSV files are owned by the single background
        # recorder below, so per-symbol browser broadcasters never touch disk
        # (that used to make broadcasters race each other on the same files).
        super().__init__(assets=assets, write_csvs=False)
        self._sink = sink          # callable(tick_dict)

    def _on_ticks(self, wsapp, ticks) -> None:
        super()._on_ticks(wsapp, ticks)
        if isinstance(ticks, dict):
            ticks = [ticks]
        elif not isinstance(ticks, list):
            return
        if not self._forming:
            return
        token = next(iter(self._forming))
        for tick in ticks:
            if not isinstance(tick, dict):
                continue
            if str(tick.get("token")) != token:
                continue
            try:
                self._sink({
                    "type": "tick",
                    "token": token,
                    "price": float(tick.get("last_traded_price")) / self.price_divisor,
                    "ts_ms": int(tick.get("exchange_timestamp") or 0),
                    "volume": float(tick.get("volume_trade_for_the_day") or 0),
                })
            except Exception:
                pass


class _RecorderBroadcaster(live_mod.LiveCandleAggregator):
    """The background recorder, but ALSO a live bridge: it keeps writing the
    per-symbol CSVs (``write_csvs=True``) while forwarding every raw tick to
    the browser clients subscribed to that tick's symbol.

    This is the fix for "no live data": the app used to open one Angel
    socket PER pane (up to 4) on top of the recorder's own socket - Angel
    limits concurrent connections per client, so the extras were rejected
    with 429 "Connection Limit Exceeded" and the feed died. Now the single
    recorder socket streams the WHOLE watchlist to every pane."""

    def __init__(self, assets: dict, sink) -> None:
        super().__init__(assets=assets, interval_minutes=1, write_csvs=True)
        self._sink = sink          # callable(tick_dict); maps token -> clients

    def _on_ticks(self, wsapp, ticks) -> None:
        super()._on_ticks(wsapp, ticks)
        if isinstance(ticks, dict):
            ticks = [ticks]
        elif not isinstance(ticks, list):
            return
        for tick in ticks:
            if not isinstance(tick, dict):
                continue
            try:
                self._sink({
                    "type": "tick",
                    "token": str(tick.get("token")),
                    "price": float(tick.get("last_traded_price")) / self.price_divisor,
                    "ts_ms": int(tick.get("exchange_timestamp") or 0),
                    "volume": float(tick.get("volume_trade_for_the_day") or 0),
                })
            except Exception:
                pass



def _recorder_sink(assets: dict):
    """Sink for the recorder socket: forward a tick to every browser client
    subscribed to a display label whose token matches the tick's token, and
    evaluate price alerts for the label."""
    by_token: dict[str, list[str]] = {}
    for label, info in assets.items():
        by_token.setdefault(str(info.get("token")), []).append(label)

    def sink(tick: dict) -> None:
        labels = by_token.get(str(tick.get("token")))
        if labels:
            with _clients_lock:
                targets = [e for e in _clients.values() if e.get("symbol") in labels]
            for entry in targets:
                try:
                    entry["loop"].call_soon_threadsafe(
                        entry["queue"].put_nowait, tick
                    )
                except Exception:
                    pass
    return sink


# symbol -> broadcaster (one live Angel socket per symbol, shared by clients).
# Reference-counted: a broadcaster is started when the first client needs it
# and STOPPED when the last client for that symbol goes away, so symbol
# switches and page closes never leak SmartWebSocketV2 connections.
_broadcasters: dict[str, _TickBroadcaster] = {}
_clients: dict[int, dict] = {}        # ws id -> {"queue", "symbol", "loop"}
_client_count: dict[str, int] = {}    # symbol -> number of browser clients
_clients_lock = threading.Lock()      # guards _clients / _client_count / _broadcasters

# When the Angel session is stale (the common case outside a fresh daily
# login) the broadcaster start fails fast - but the browser auto-reconnects
# its WebSocket, which used to retry the socket spawn every few seconds and
# spam the logs. Cooldown: after a failed start we skip further socket
# attempts for a window, and the endpoint degrades to "no-session" (chart
# keeps working off cached CSVs) without hammering Angel or the log.
# Two windows: session/auth failures get 60 s (a stale token stays stale
# until login), while transient socket errors get only 5 s so a recoverable
# hiccup restores the live feed quickly.
_broadcaster_fail_ts: dict[str, tuple[float, float]] = {}   # symbol -> (ts, window)
_BROADCASTER_FAIL_COOLDOWN = 60.0
_BROADCASTER_TRANSIENT_COOLDOWN = 5.0


def _sink_for(symbol: str):
    """Push a tick to every browser client subscribed to ``symbol``. Called
    from the SmartWebSocketV2 thread; snapshot the client list under the lock
    first, then hand each message to its asyncio loop thread-safely."""
    def sink(tick: dict) -> None:
        with _clients_lock:
            targets = [e for e in _clients.values() if e.get("symbol") == symbol]
        for entry in targets:
            try:
                entry["loop"].call_soon_threadsafe(
                    entry["queue"].put_nowait, tick
                )
            except Exception:
                pass
    return sink


def _ensure_broadcaster(symbol: str) -> str:
    """Make sure live ticks flow for ``symbol``. Returns a status string for
    the UI badge (``live`` / ``no-session`` / ``error``).

    Preferred path: the shared recorder socket - ONE Angel connection covers
    the whole watchlist and forwards ticks to every pane. A per-symbol
    socket is only started as a fallback when the recorder is down (Angel's
    concurrent-connection limit is what used to 429 the feed)."""
    asset = _resolve_asset(symbol)
    if asset is None:
        return "error"
    token = asset["token"]
    with _recorder_lock:
        rec = _recorder
    if rec is not None and rec.is_running():
        # Only claim "live" when the shared socket actually subscribes to this
        # symbol's token - an embed symbol outside the watchlist must fall
        # back to its own per-symbol socket (otherwise it would show "live"
        # but never receive ticks).
        covered = any(str(info.get("token")) == token
                      for info in rec.assets.values())
        if covered:
            # The shared socket covers it - retire any stale per-symbol
            # socket for this symbol so we never exceed Angel's connection
            # limit (the cause of the 429s).
            leftover = _broadcasters.pop(symbol, None)
            if leftover is not None:
                try:
                    leftover.stop()
                except Exception:
                    pass
            return "live"
    existing = _broadcasters.get(symbol)
    if existing is not None and existing.is_running():
        # Monthly rollover guard: near-month futures (NIFTY FUT) change token
        # at expiry - the running socket may still be streaming the OLD
        # contract. Restart it with the freshly resolved token so the live
        # feed never points at a dead contract.
        running_tokens = {str(i.get("token")) for i in existing.assets.values()}
        if token not in running_tokens:
            try:
                existing.stop()
            except Exception:
                pass
            _broadcasters.pop(symbol, None)
            existing = None
    if existing is not None and existing.is_running():
        return "live"
    # Failed-start cooldown: skip the socket attempt entirely while a recent
    # failure is still within its window (browser ws auto-reconnects would
    # otherwise retry every few seconds).
    now = time.time()
    entry = _broadcaster_fail_ts.get(symbol)
    if entry is not None and now - entry[0] < entry[1]:
        return "no-session"
    try:
        agg = _TickBroadcaster(
            assets={symbol: {"token": token,
                             "exchange_type": asset["exchange_type"]}},
            sink=_sink_for(symbol),
        )
        agg.start()                     # raises SessionExpired if not logged in
        _broadcasters[symbol] = agg
        _broadcaster_fail_ts.pop(symbol, None)
        return "live"
    except SessionExpired:
        _broadcaster_fail_ts[symbol] = (now, _BROADCASTER_FAIL_COOLDOWN)
        return "no-session"
    except Exception as exc:
        msg = str(exc).lower()
        if any(k in msg for k in ("stale", "session", "login", "auth")):
            # The Angel lib raises non-SessionExpired variants for a stale
            # token - classify them as no-session (needs login) not error,
            # with the long cooldown (it only clears via login).
            _broadcaster_fail_ts[symbol] = (now, _BROADCASTER_FAIL_COOLDOWN)
            print(f"[ws] broadcaster: {symbol} needs SmartAPI login ({exc})")
            return "no-session"
        # Transient socket error: short cooldown so the feed recovers fast.
        _broadcaster_fail_ts[symbol] = (now, _BROADCASTER_TRANSIENT_COOLDOWN)
        print(f"[ws] broadcaster start failed for {symbol}: {exc}")
        return "error"


def _incr_client(symbol: str) -> None:
    with _clients_lock:
        _client_count[symbol] = _client_count.get(symbol, 0) + 1


def _decr_client(symbol: str) -> None:
    """Drop one client for ``symbol``; stop its Angel socket when it was the
    last one (reference-counted broadcaster lifecycle)."""
    with _clients_lock:
        n = _client_count.get(symbol, 0) - 1
        if n <= 0:
            _client_count.pop(symbol, None)
            agg = _broadcasters.pop(symbol, None)
        else:
            _client_count[symbol] = n
            agg = None
    if agg is not None:
        try:
            agg.stop()
        except Exception:
            pass


async def _ws_writer(ws: WebSocket, queue: asyncio.Queue) -> None:
    while True:
        item = await queue.get()
        await ws.send_json(item)


async def _ws_reader(ws: WebSocket, entry: dict) -> None:
    while True:
        raw = await ws.receive_text()
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        mtype = msg.get("type")
        if mtype == "switch_symbol" and msg.get("symbol"):
            new_symbol = str(msg["symbol"])
            if new_symbol != entry["symbol"]:
                old_symbol = entry["symbol"]
                _decr_client(old_symbol)
                entry["symbol"] = new_symbol
                _incr_client(new_symbol)
                status = _ensure_broadcaster(new_symbol)
                await ws.send_json({"type": "status", "symbol": new_symbol,
                                    "feed": status})
        elif mtype == "ping":
            await ws.send_json({"type": "pong"})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, symbol: str = "Nifty 50") -> None:
    await ws.accept()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    entry = {"queue": queue, "symbol": symbol, "loop": loop}
    with _clients_lock:
        _clients[id(ws)] = entry
    _incr_client(symbol)

    feed = _ensure_broadcaster(symbol)
    session = SmartAPISession()
    is_open, market_label = live_mod.market_status()
    await ws.send_json({
        "type": "status",
        "connected": True,
        "symbol": symbol,
        "feed": feed,
        "logged_in": session.is_logged_in(),
        "market": market_label,
        "market_open": is_open,
    })
    try:
        await asyncio.gather(
            _ws_writer(ws, queue), _ws_reader(ws, entry),
            return_exceptions=True,
        )
    except WebSocketDisconnect:
        pass
    finally:
        with _clients_lock:
            _clients.pop(id(ws), None)
        _decr_client(entry["symbol"])


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------
@app.get("/api/symbols")
def symbols() -> dict:
    """Watchlist for the symbol picker: index assets first, then the curated
    equity universe. Dedupes case-insensitively AND by SmartAPI token, so
    aliases like "Bank Nifty" vs "Nifty Bank" never both appear."""
    labels: list[str] = []
    try:
        curated = universe_mod.curated_symbols() if universe_mod is not None else []
        labels = [universe_mod.display_label(r) for r in curated]
    except Exception:
        labels = []
    out: list[str] = []
    seen_labels: set[str] = set()
    seen_tokens: set[str] = set()
    for label in ["Nifty 50", "Bank Nifty"] + labels:
        if not label:
            continue
        key = label.upper()
        if key in seen_labels:
            continue
        token = _resolve_token(label)
        if token is not None and token in seen_tokens:
            continue                       # alias of an already-listed instrument
        if token is not None:
            seen_tokens.add(token)
        seen_labels.add(key)
        out.append(label)
    return {"symbols": out}


@app.get("/api/search")
def search(q: str = "", limit: int = 30) -> dict:
    """Search the FULL SmartAPI universe (NSE + NFO futures/options + BSE +
    MCX). Returns display labels for the symbol picker - any label returned
    here is chartable via /api/history and streamable via /api/ws."""
    try:
        hits = universe_mod.search(q, limit=limit) if universe_mod is not None else []
    except Exception:
        hits = []
    labels: list[str] = []
    for rec in hits:
        try:
            label = universe_mod.display_label(rec)
        except Exception:
            label = str(rec.get("symbol", "") or rec.get("name", "") or "")
        if label and label not in labels:
            labels.append(label)
    return {"results": labels}


@app.get("/api/ltp")
def ltp(symbols: str = "") -> dict:
    """Live last-traded prices for a comma-separated list of display labels.
    Reads the shared recorder socket's in-memory candles first (true live
    LTP during market hours); falls back to the last close of the history
    frame when the symbol is not streaming."""
    labels = [s.strip() for s in symbols.split(",") if s.strip()][:50]
    out: dict[str, dict] = {}
    with _recorder_lock:
        rec = _recorder
    for label in labels:
        entry: dict = {}
        if rec is not None and rec.is_running():
            try:
                px = rec.last_price(label)
                if px is not None:
                    entry["ltp"] = round(float(px), 2)
            except Exception:
                pass
        if "ltp" not in entry:
            try:
                df, _ = _history_df(label, "1D", days=10)
                if df is not None and len(df):
                    entry["ltp"] = round(float(df["close"].iloc[-1]), 2)
            except Exception:
                pass
        out[label] = entry
    return {"prices": out}


@app.get("/api/history")
def history(symbol: str = "Nifty 50", interval: str = DEFAULT_INTERVAL,
            days: int = 30, before: str | None = None) -> dict:
    """OHLCV candles. ``days`` = how far back (default 30, pass 365 or 1825
    for deep history). ``before`` = epoch cutoff for older-page loads
    (infinite scroll-back on the chart). Older pages come from the deep
    cache only - never re-trigger the live Angel fetch."""
    before_ts = None
    if before:
        try:
            before_ts = pd.to_datetime(int(before), unit="s", utc=True).tz_convert(
                "Asia/Kolkata").tz_localize(None)
        except Exception:
            before_ts = "invalid"
    if before_ts is not None:
        # Paged older history: deep cache only. An empty cache page (or a
        # malformed before= token) means we reached the beginning - return it
        # cleanly (meta.done) instead of 404 or silently re-serving recent data.
        if before_ts == "invalid":
            empty = pd.DataFrame(columns=["timestamps"] + OHLCV_COLUMNS)
            return _candles_payload(empty, symbol, interval,
                                    {"source": "history-cache", "done": True,
                                     "available": None})
        df, meta = _history_cache_df(symbol, interval, days, before=before_ts,
                                     allow_empty=True)
        if df is None or len(df) == 0:
            # A true cache MISS (df is None) means this symbol was never
            # backfilled (futures / MCX / newer watchlist entries). Pull an
            # older Angel REST window instead so scroll-back works for every
            # symbol, not just the ones with a local deep cache. A present
            # but exhausted cache (done=True) is authoritative - stop there.
            if df is None:
                older = _fetch_rest_recent(symbol, interval,
                                           min(days, 150), end_ts=before_ts)
                if older is not None and len(older) >= 2:
                    return _candles_payload(older, symbol, interval,
                                            {"source": "angel-rest",
                                             "degraded": False})
            empty = pd.DataFrame(columns=["timestamps"] + OHLCV_COLUMNS)
            return _candles_payload(empty, symbol, interval,
                                    meta or {"source": "history-cache",
                                             "done": True, "available": None})
        return _candles_payload(df, symbol, interval, meta)
    df, meta = _history_df(symbol, interval, days)
    return _candles_payload(df, symbol, interval, meta)


@app.get("/api/auth/status")
def auth_status() -> dict:
    session = SmartAPISession()
    st = session.status()
    is_open, market_label = live_mod.market_status()
    st["market_open"] = is_open
    st["market_label"] = market_label
    # Which compute device Kronos inference actually runs on - always 'cuda'
    # in this build (CPU was removed), surfaced so the UI can badge it.
    st["device"] = infer_mod.DEVICE
    st["gpu"] = infer_mod.DEVICE == "cuda"
    return st


class LoginRequest(BaseModel):
    totp: str = Field(..., description="6-digit TOTP from the authenticator app.")


@app.post("/api/auth/login")
def auth_login(req: LoginRequest) -> dict:
    session = SmartAPISession()
    try:
        session.login(totp=req.totp.strip())
    except (auth_mod.ConfigError, auth_mod.LoginError) as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    return {"ok": True, **session.status()}


# ---------------------------------------------------------------------------
# Kronos AI overlay
# ---------------------------------------------------------------------------
class LiveCandle(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class KronosRequest(BaseModel):
    symbol: str = Field(default="Nifty 50")
    interval: str = Field(default=DEFAULT_INTERVAL)
    lookback: int = Field(default=400, ge=100, le=2048)
    pred_len: int = Field(default=30, ge=5, le=120)
    model: str = Field(default=infer_mod.DEFAULT_MODEL)
    # Probabilistic inference controls: sample_count independent Kronos
    # forward passes are averaged into the returned path, and their spread
    # becomes a confidence band + a 0-100 confidence score (direction
    # agreement weighted by band tightness). sample_count=1 stays the fast
    # deterministic-feeling single path (used by the live auto-predictor).
    sample_count: int = Field(default=1, ge=1, le=8)
    temperature: float = Field(default=1.0, ge=0.3, le=1.5)
    top_p: float = Field(default=0.9, ge=0.5, le=1.0)
    # Freshest candles from the browser pane (including the currently forming
    # candle), UTC epoch seconds + OHLCV. When present, they OVERRIDE the
    # matching cached timestamps so the model always predicts from the very
    # latest live close - the chart then refreshes only after this analysis.
    live_tail: list[LiveCandle] | None = None


_predictor_cache: dict = {}
# Result cache for /api/kronos/forecast: every open pane/device auto-predicts
# on the SAME closed candle, so one Kronos forward pass per
# (symbol, interval, model, candle) is enough for all of them. The key
# carries the last candle's UTC epoch - the next candle busts it naturally.
# The TTL is a safety net for manual re-runs within the same minute.
_forecast_result_cache: dict = {}
_FORECAST_RESULT_TTL = 50.0
# Serialize Kronos inference: torch forward passes on the SAME predictor
# object are not thread-safe, and several panes/devices auto-predict on the
# same new candle - without this lock the concurrent calls crashed with a
# 500 ("Kronos forecast failed") whenever two requests arrived together.
# The result cache above already dedupes identical requests, so this lock
# only serializes genuinely different forecasts (cheap in practice).
_FORECAST_INFER_LOCK = threading.Lock()


@app.post("/api/kronos/forecast")
def kronos_forecast(req: KronosRequest) -> dict:
    """Run the local Kronos model on the current candles and return a
    forecast path the UI draws as a dashed overlay line series."""
    if req.interval not in INTERVALS:
        raise HTTPException(status_code=400, detail=f"Unknown interval '{req.interval}'.")

    # Build a context CSV from the same history the chart is showing (deep
    # 5y cache first, else Angel REST). Fetch enough DAYS for the requested
    # lookback at this interval - and when the deep cache exists (1D holds 5
    # years) give the model the whole multi-year context it can see, so a
    # 400-lookback daily forecast is not clamped to ~280 candles.
    candles_per_day = {"1m": 375, "5m": 75, "15m": 25, "30m": 13,
                       "1H": 7, "1D": 1}.get(req.interval, 75)
    days = max(30, min(600, req.lookback // candles_per_day + 10))
    if req.interval == "1D":
        days = 1825      # the cache holds 5y of daily candles - use them
    df, meta = _history_df(req.symbol, req.interval, days=days)
    if df is None or len(df) < 10:
        raise HTTPException(
            status_code=400,
            detail=f"Only {0 if df is None else len(df)} candles available - "
                   "need at least 10 to run a forecast.",
        )

    # --- Merge the browser's live tail over the cached history ------------
    # The pane sends the freshest candles (UTC epoch time + OHLCV) INCLUDING
    # the still-forming candle. Convert back to naive-IST Timestamps, drop any
    # cached rows with the same timestamp (live wins), then append the new
    # ones so the model context ends at the true live close. This is what
    # makes "live predict the upcoming candle" actually live.
    if req.live_tail:
        try:
            live = pd.DataFrame([c.model_dump() for c in req.live_tail])
            live["timestamps"] = pd.to_datetime(live["time"], unit="s", utc=True)
            live["timestamps"] = (live["timestamps"].dt.tz_convert("Asia/Kolkata")
                                   .dt.tz_localize(None))
            live = live[["timestamps"] + OHLCV_COLUMNS]
            combined = pd.concat([df, live], ignore_index=True)
            combined = combined.drop_duplicates(subset=["timestamps"], keep="last")
            combined = combined.sort_values("timestamps").reset_index(drop=True)
            if len(combined) >= 10:
                df = combined
                meta = {**meta,
                        "source": (meta.get("source") or "history-cache") + "+live"}
        except Exception as exc:
            print(f"[kronos] live_tail merge failed ({exc}) - using cache only")

    # Clamp the lookback to what the fetched history actually covers (e.g. on
    # a 1D chart ~30 daily candles exist, so lookback=400 would otherwise
    # fail - the model just gets all the history it can see).
    lookback = max(10, min(req.lookback, len(df) - 1))

    # --- Result cache: one forward pass per (symbol, interval, model,
    # candle) shared across all devices/panes. The browser's live_tail is
    # merged above, so the last timestamp is the candle every pane is
    # predicting on right now; identical requests short-circuit here. ---
    cache_key = (
        req.symbol, req.interval, req.model, lookback, req.pred_len,
        req.sample_count, req.temperature, req.top_p,
        int(_to_utc_epoch(df["timestamps"].iloc[-1:])[0]),
    )
    _now = time.time()
    _hit = _forecast_result_cache.get(cache_key)
    if _hit is not None and _now - _hit[0] < _FORECAST_RESULT_TTL:
        return _hit[1]

    tmp = Path(tempfile.gettempdir()) / (
        f"tv_kronos_{req.symbol.replace(' ', '_').lower()}_{req.interval}.csv"
    )
    df.to_csv(tmp, index=False)

    t0 = time.perf_counter()
    try:
        # Model load + inference both live under the lock: the load itself is
        # idempotent (process-wide cache in 2_kronos_inference), but holding
        # the lock for it too guarantees only one thread ever builds a fresh
        # predictor, and torch forwards on it are always serialized.
        with _FORECAST_INFER_LOCK:
            if req.model not in _predictor_cache:
                # GPU-only: follow the shared DEVICE constant (always 'cuda').
                _predictor_cache[req.model] = infer_mod.load_predictor(
                    model_name=req.model, device=infer_mod.DEVICE
                )
            predictor = _predictor_cache[req.model]
            n_samples = max(1, req.sample_count)
            paths: list[pd.DataFrame] = []
            for _ in range(n_samples):
                _, f_df = infer_mod.generate_forecast(
                    csv_path=str(tmp),
                    lookback=lookback,
                    pred_len=req.pred_len,
                    model_name=req.model,
                    predictor=predictor,
                    temperature=req.temperature,
                    top_p=req.top_p,
                    sample_count=1,
                )
                paths.append(f_df)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Kronos forecast failed: {exc}") from exc

    last_close = float(df["close"].iloc[-1])
    last_time = _to_utc_epoch(df["timestamps"].iloc[-1:])[0]

    # --- Probabilistic aggregation ----------------------------------------
    closes = np.array([p["close"].to_numpy() for p in paths])     # (n, pred_len)
    mean_path = closes.mean(axis=0)
    std_path = closes.std(axis=0)
    times = _to_utc_epoch(paths[0].index)
    forecast_df = paths[0].copy()
    forecast_df["close"] = mean_path

    next_close = float(mean_path[0])
    move_pct = (next_close - last_close) / last_close * 100.0
    # The NET move over the ENTIRE forecast path (last forecast close vs the
    # last real close) - this is what the dashed line actually draws. The
    # golden box headlines this instead of the first-candle move_pct, so the
    # box can never contradict the overlay: on 1H the first hour can be flat
    # while the 30-hour path swings hundreds of points.
    horizon_close = float(mean_path[-1])
    net_move_pct = (horizon_close - last_close) / last_close * 100.0

    band: list[dict] | None = None
    confidence: float | None = None
    if n_samples > 1:
        lo = mean_path - std_path
        hi = mean_path + std_path
        band = [
            {"time": int(t), "lo": round(float(l), 2), "hi": round(float(h), 2)}
            for t, l, h in zip(times, lo, hi)
        ]
        # Direction agreement on the very next candle (the trader's first
        # decision point) + how tight the band is relative to price.
        move = mean_path[0] - last_close
        if abs(move) < 1e-9:
            agreement = 0.5
        else:
            agreement = float(np.mean(np.sign(closes[:, 0] - last_close) == np.sign(move)))
        rel_band = float(np.nanmean(std_path / max(last_close, 1e-9)))
        tightness = max(0.0, 1.0 - rel_band * 60)      # 0.3% band -> 0.82, 1% -> 0.4
        confidence = round(100 * (0.6 * agreement + 0.4 * tightness), 1)

    # --- Market regime snapshot (pure pandas, no heavy imports) -----------
    regime = _market_regime(df)

    resp = {
        "meta": {
            "symbol": req.symbol,
            "interval": req.interval,
            "model": req.model,
            "lookback": lookback,
            "pred_len": req.pred_len,
            "sample_count": n_samples,
            "device": infer_mod.DEVICE,
            "inference_seconds": round(time.perf_counter() - t0, 2),
            "source": meta["source"],
            "regime": regime,
            # True when the forecast fell back to the deep cache / live CSVs
            # with NO fresh Angel REST feed (rate limit, session blip). The
            # golden box shows a ⚠ stale-data chip so a 1H fallback anchored
            # on old candles is visible instead of silently wild.
            "stale": "angel-rest" not in (meta.get("source") or ""),
        },
        "last_close": round(last_close, 2),
        "last_time": last_time,
        "move_pct": round(move_pct, 3),
        "net_move_pct": round(net_move_pct, 3),
        "horizon_close": round(horizon_close, 2),
        "confidence": confidence,
        "band": band,
        "forecast": [
            {"time": t, "close": round(float(c), 2)}
            for t, c in zip(times, forecast_df["close"])
        ],
    }
    # Store the result (pruning stale entries) so every device/panel on the
    # same candle shares this single inference instead of running N more.
    _forecast_result_cache[cache_key] = (time.time(), resp)
    if len(_forecast_result_cache) > 400:
        _expired = [k for k, v in _forecast_result_cache.items()
                    if time.time() - v[0] >= _FORECAST_RESULT_TTL]
        for k in _expired:
            _forecast_result_cache.pop(k, None)
    return resp


def _market_regime(df: pd.DataFrame) -> dict:
    """Tiny pure-pandas regime snapshot attached to every forecast: RSI 14
    (Wilder), ATR as a PERCENTILE RANK of its own recent history (so the
    High/Normal/Low label is meaningful on ANY interval - 1m through 1D,
    where raw ATR% differs by ~10x), EMA 20-vs-50 trend slope, and a
    plain-language trend / volatility label. Lets the chart answer "am I in
    a trend or a range, and how much does the AI trust a trend move?"""
    out: dict = {"trend": "n/a", "vol_state": "n/a", "rsi": None,
                 "atr_pct": None, "ema_slope_pct": None, "state": "Neutral"}
    try:
        close = df["close"]
        delta = close.diff()
        gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
        loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
        rs = gain / loss.replace(0, np.nan)
        rsi_s = 100 - 100 / (1 + rs)
        rsi_now = float(rsi_s.iloc[-1]) if pd.notna(rsi_s.iloc[-1]) else None
        if rsi_now is not None:
            out["rsi"] = round(rsi_now, 1)
            out["state"] = ("Overbought" if rsi_now >= 70
                             else ("Oversold" if rsi_now <= 30 else "Neutral"))

        tr = pd.concat([df["high"] - df["low"],
                        (df["high"] - close.shift()).abs(),
                        (df["low"] - close.shift()).abs()], axis=1).max(axis=1)
        atr = tr.ewm(alpha=1 / 14, adjust=False).mean()
        atr_pct = float(atr.iloc[-1] / close.iloc[-1] * 100)
        out["atr_pct"] = round(atr_pct, 3)
        # Percentile rank of today's ATR% within its own recent window -
        # interval-agnostic, so 5m charts report "High" when 5m vol is high
        # for 5m, not when it is high by DAILY standards.
        atr_series = (atr / close * 100).dropna()
        if len(atr_series) >= 20 and pd.notna(atr_pct):
            window = atr_series.iloc[-min(60, len(atr_series)):]
            rank = float((window <= atr_pct).mean())
        else:
            rank = 0.5
        out["vol_rank"] = round(rank, 3)
        out["vol_state"] = ("High" if rank >= 0.8
                             else ("Low" if rank <= 0.2 else "Normal"))

        ema_fast = close.ewm(span=20, adjust=False).mean()
        ema_slow = close.ewm(span=50, adjust=False).mean()
        slope = float((ema_fast.iloc[-1] - ema_slow.iloc[-1]) / ema_slow.iloc[-1] * 100)
        out["ema_slope_pct"] = round(slope, 3)
        out["trend"] = ("Strong uptrend" if slope > 0.15
                         else ("Uptrend" if slope > 0.03
                               else ("Strong downtrend" if slope < -0.15
                                     else ("Downtrend" if slope < -0.03
                                           else "Flat / ranging"))))
    except Exception:
        pass
    return out


# ---------------------------------------------------------------------------
# Static UI
# ---------------------------------------------------------------------------
def _no_store(resp: FileResponse) -> FileResponse:
    """Never let the browser cache the UI bundle during development - a stale
    app.js is the most confusing kind of bug."""
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index() -> FileResponse:
    return _no_store(FileResponse(BASE_DIR / "static" / "index.html"))


@app.get("/styles.css")
def styles() -> FileResponse:
    return _no_store(FileResponse(BASE_DIR / "static" / "styles.css", media_type="text/css"))


@app.get("/app.js")
def script() -> FileResponse:
    return _no_store(FileResponse(BASE_DIR / "static" / "app.js", media_type="text/javascript"))


# ---------------------------------------------------------------------------
# Background CSV recorder
# ---------------------------------------------------------------------------
# CSVs used to only be written while a browser pane was connected (the
# per-symbol broadcasters are reference-counted and stop with the last
# client). A persistent, single-socket aggregator covering the whole
# watchlist now writes the CSVs continuously in the background - the data is
# captured on disk regardless of who is looking, so the files always end at
# the latest closed candle.
_recorder: "_RecorderBroadcaster | None" = None
_recorder_lock = threading.Lock()


def _start_recorder() -> None:
    """Start the persistent live-CSV recorder in a daemon thread.

    One SmartWebSocketV2 connection subscribes to the whole watchlist and
    writes every symbol's candles to disk (1m file + resampled 5m file, per
    the aggregator's IST-anchored flush logic). Retries every 30 s until a
    valid SmartAPI session exists; the recorder auto-restarts if the socket
    drops (``_running`` goes False).
    """
    def loop() -> None:
        global _recorder
        while True:
            try:
                # Idle outside trading hours instead of reconnecting against
                # Angel's rate limits for hours on end (the socket would just
                # drop again with no ticks to receive).
                is_open, _ = live_mod.market_status()
                if not is_open:
                    time.sleep(120)
                    continue
                session = SmartAPISession()
                if not session.is_logged_in():
                    time.sleep(30)
                    continue
                # Resolve the current watchlist (indices + equities + near-month
                # futures). The recorder socket is rebuilt whenever the resolved
                # tokens CHANGE - near-month futures roll at monthly expiry, and
                # keeping the old token would stream a dead contract into the
                # live CSVs until a manual restart.
                want_assets: dict = {}
                for rec in universe_mod.curated_symbols():
                    label = universe_mod.display_label(rec)
                    token = str(rec.get("token", ""))
                    if label and token:
                        seg = str(rec.get("exch_seg", "NSE"))
                        want_assets[label] = {
                            "token": token,
                            "exchange_type": universe_mod.SEGMENT_EXCHANGE_TYPE.get(seg, 1),
                        }
                if not want_assets:
                    time.sleep(30)
                    continue
                with _recorder_lock:
                    alive = _recorder is not None and _recorder.is_running()
                    if alive and _recorder.assets != want_assets:
                        try:
                            _recorder.stop()
                        except Exception:
                            pass
                        alive = False
                if alive:
                    time.sleep(30)
                    continue
                assets = want_assets
                agg = _RecorderBroadcaster(
                    assets=assets, sink=_recorder_sink(assets),
                )
                agg.start()
                with _recorder_lock:
                    _recorder = agg
                # The shared socket now covers the whole watchlist - stop any
                # per-symbol sockets that boot started before it connected, so
                # the app never holds more than ONE Angel connection.
                with _clients_lock:
                    stale = list(_broadcasters.keys())
                for sym in stale:
                    b = _broadcasters.pop(sym, None)
                    if b is not None:
                        try:
                            b.stop()
                        except Exception:
                            pass
                print(f"[recorder] ONE shared Angel socket streaming {len(assets)} symbols "
                      f"to every chart pane + CSVs (retired {len(stale)} per-symbol sockets)")
            except Exception as exc:
                print(f"[recorder] retry: {exc}")
            time.sleep(30)

    threading.Thread(target=loop, daemon=True, name="csv-recorder").start()

def _warm_gpu() -> None:
    """Preload the default Kronos model on the GPU and run one tiny forecast
    on cached candles at boot, so the first real user forecast is instant:
    the CUDA context, cuDNN heuristics and model weights are already
    resident before anyone opens the page. Fully best-effort - a failure
    (empty cache, first-ever model download) just means the first request
    pays the load."""
    try:
        fname = PROJECT_DIR / CSV_FALLBACK.get("Nifty 50", "nifty50_smartapi_5m.csv")
        if not fname.is_file():
            print("[gpu-warmup] no cached CSV - skipping (first forecast will load)")
            return
        with _FORECAST_INFER_LOCK:
            if infer_mod.DEFAULT_MODEL not in _predictor_cache:
                _predictor_cache[infer_mod.DEFAULT_MODEL] = infer_mod.load_predictor(
                    model_name=infer_mod.DEFAULT_MODEL, device=infer_mod.DEVICE
                )
            predictor = _predictor_cache[infer_mod.DEFAULT_MODEL]
            _, _ = infer_mod.generate_forecast(
                csv_path=str(fname),
                lookback=100,
                pred_len=5,
                model_name=infer_mod.DEFAULT_MODEL,
                predictor=predictor,
                temperature=1.0,
                top_p=0.9,
                sample_count=1,
            )
        print(f"[gpu-warmup] GPU warm: Kronos {infer_mod.DEFAULT_MODEL} ready "
              f"({infer_mod.DEVICE}) - first forecast is instant")
    except Exception as exc:
        print(f"[gpu-warmup] skipped ({exc}) - first forecast will warm the model")


if __name__ == "__main__":
    import uvicorn

    env = {}
    for p in (PROJECT_DIR / ".env", BASE_DIR / ".env"):
        env.update(_read_env(p))
    try:
        port = int(env.get("TV_PORT", "81"))
    except ValueError:
        port = 81
    host = env.get("TV_HOST", "0.0.0.0")
    _start_recorder()   # background CSV recorder (independent of browser clients)
    # Warm the GPU in the background (see _warm_gpu) - never blocks startup.
    threading.Thread(target=_warm_gpu, daemon=True, name="gpu-warmup").start()
    uvicorn.run(app, host=host, port=port, log_level="info")
