"""
2_kronos_inference.py
=====================
Run zero-shot forecasting with the **Kronos** financial foundation model
(*"Kronos: A Foundation Model for the Language of Financial Markets"*,
Tsinghua University research team, arXiv:2508.02739, accepted at AAAI 2026)
on the clean 5-minute CSVs produced by ``1_fetch_data.py``.

The script works with *both* generations of the Kronos codebase and picks
the right API automatically:

* **Current API** (github.com/shiyu-coder/Kronos, the repo you can clone
  today): ``KronosPredictor(model, tokenizer, device=...)`` and
  ``predict(df=..., x_timestamp=..., y_timestamp=..., pred_len=..., ...)``.
* **Legacy API** (the original NeoQuasar/Kronos repo from the YouTube
  tutorial era - no longer online): ``KronosPredictor.from_pretrained(...)``
  and ``predict(x_df, x_timestamp, y_timestamp) -> (pred_df, pred_timestamp)``.

Setup
-----
1. Clone the Kronos repo next to this project:

       git clone https://github.com/shiyu-coder/Kronos

   (or set the ``KRONOS_REPO_DIR`` environment variable to your clone).

2. Make sure the HF model is cached before the first run - the dashboard
   does this automatically, or you can just run this script once.

Main entry point::

    historical, forecast = generate_forecast("nifty50_5m.csv",
                                             lookback=400, pred_len=120)
"""

from __future__ import annotations

import inspect
import logging
import os
import sys
from pathlib import Path

import pandas as pd

BASE_DIR = Path(__file__).resolve().parent

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Kronos codebase discovery
# ---------------------------------------------------------------------------
def _find_kronos_repo() -> Path | None:
    """Locate a clone of the Kronos repository (either layout works:
    the current ``model/`` package or the legacy root-level ``model.py``)."""
    env_dir = os.environ.get("KRONOS_REPO_DIR", "").strip()
    candidates = [Path(env_dir)] if env_dir else []
    candidates += [BASE_DIR / "Kronos", BASE_DIR / "kronos", BASE_DIR.parent / "Kronos"]
    for path in candidates:
        if (path / "model" / "kronos.py").is_file() or (path / "model.py").is_file():
            return path
    return None


KRONOS_REPO_DIR = _find_kronos_repo()
if KRONOS_REPO_DIR is not None and str(KRONOS_REPO_DIR) not in sys.path:
    sys.path.insert(0, str(KRONOS_REPO_DIR))

try:
    from model import Kronos, KronosTokenizer, KronosPredictor
except ImportError as exc:  # pragma: no cover - environment setup issue
    raise ImportError(
        "Could not import the Kronos codebase. Clone it next to this "
        "project and try again:\n"
        "    git clone https://github.com/shiyu-coder/Kronos\n"
        "Alternatively set the KRONOS_REPO_DIR environment variable to "
        "the path of your existing clone."
    ) from exc

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# Compute-device auto-detection: CUDA GPU when available, Apple Silicon MPS
# next, plain CPU everywhere else (including Intel Macs and CPU-only boxes).
# The Kronos models are tiny (4.1M / 24.7M params) and run comfortably on
# CPU - a GPU only makes forecasts faster. Every consumer (dashboard, Live
# AI, Simulation, FastAPI, MCP, TV viewer) reads this single DEVICE constant,
# so the compute backend switches in exactly one place.
try:
    import torch as _torch
except ImportError as exc:       # pragma: no cover - torch is always installed
    raise RuntimeError(
        "PyTorch is required for Kronos inference but could not be imported. "
        "Install it with: pip install torch   (Windows/Linux NVIDIA-GPU users: "
        "see requirements.txt for the faster CUDA wheel index URL)."
    ) from exc

if _torch.cuda.is_available():
    DEVICE = "cuda"
elif (getattr(getattr(_torch, "backends", None), "mps", None) is not None
        and _torch.backends.mps.is_available()):
    DEVICE = "mps"          # Apple Silicon (M1/M2/M3/M4)
else:
    DEVICE = "cpu"          # no CUDA GPU - Intel Macs and CPU-only machines

# Human-readable label for the UI badge ("GPU" vs "CPU" vs "Apple GPU").
def device_label(device: str = DEVICE) -> str:
    return "GPU" if device == "cuda" else ("Apple" if device == "mps" else "CPU")

# Model -> tokenizer -> context-length mapping from the official model zoo.
# Public build: Kronos-mini + Kronos-small only (Kronos-base is not shipped).
MODEL_OPTIONS = {
    "Kronos-mini": {
        "model": "NeoQuasar/Kronos-mini",
        "tokenizer": "NeoQuasar/Kronos-Tokenizer-2k",   # mini uses the 2k tokenizer
        "max_context": 2048,
    },
    "Kronos-small": {
        "model": "NeoQuasar/Kronos-small",
        "tokenizer": "NeoQuasar/Kronos-Tokenizer-base",
        "max_context": 512,
    },
}

# Kronos-small is the default for the public build (mini is the lightweight
# option for quick checks).
DEFAULT_MODEL = "Kronos-small"

OHLCV_COLUMNS = ["open", "high", "low", "close", "volume"]

_PREDICTOR_CACHE: dict[tuple, KronosPredictor] = {}


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------
def load_predictor(
    model_name: str = DEFAULT_MODEL,
    device: str = DEVICE,
    max_context: int | None = None,
) -> KronosPredictor:
    """Load a ``KronosPredictor`` on the detected compute device
    (``cuda`` / ``mps`` / ``cpu``) and cache it in-process.

    Supports both the current ``shiyu-coder/Kronos`` API and the legacy
    tutorial-era API (``KronosPredictor.from_pretrained``).
    """
    if model_name not in MODEL_OPTIONS:
        raise ValueError(
            f"Unknown model '{model_name}'. Choose from {list(MODEL_OPTIONS)}."
        )
    if device not in ("cuda", "mps", "cpu"):
        raise ValueError(f"Unknown device '{device}' - choose cuda, mps or cpu.")
    cfg = MODEL_OPTIONS[model_name]
    max_context = max_context or cfg["max_context"]

    cache_key = (model_name, device, max_context)
    if cache_key in _PREDICTOR_CACHE:
        return _PREDICTOR_CACHE[cache_key]

    if hasattr(KronosPredictor, "from_pretrained"):
        # --- Legacy API (tutorial-era repo) ---
        logger.info("Detected legacy Kronos API -> KronosPredictor.from_pretrained().")
        predictor = KronosPredictor.from_pretrained(
            cfg["model"], device=device, max_context=max_context
        )
    else:
        # --- Current API (shiyu-coder/Kronos) ---
        logger.info(
            "Detected current Kronos API -> loading tokenizer '%s' + model '%s'.",
            cfg["tokenizer"], cfg["model"],
        )
        tokenizer = KronosTokenizer.from_pretrained(cfg["tokenizer"])
        model = Kronos.from_pretrained(cfg["model"])
        predictor = KronosPredictor(model, tokenizer, device=device, max_context=max_context)

    _PREDICTOR_CACHE[cache_key] = predictor

    # Torch thread tuning: on a GPU the model does the heavy lifting, so a
    # small pool (4) is ample for data prep / tokenization and keeps the UI
    # responsive. On CPU the model itself is the heavy lift, so use more of
    # the cores (capped at 8 so a concurrent inference never freezes the box).
    try:
        import torch as _torch
        _target = (max(2, min(int(os.cpu_count() or 4), 8)) if device == "cpu"
                   else max(1, min(4, int(os.cpu_count() or 4))))
        if _torch.get_num_threads() != _target:
            _torch.set_num_threads(_target)
    except Exception:
        pass

    # GPU micro-optimisations: allow TF32 matmuls on Ampere+ so the model's
    # linear layers run noticeably faster with negligible accuracy impact,
    # and let cuDNN autotune once per tensor shape (then reuse the fastest
    # kernel) instead of re-benchmarking on every forecast. The model is
    # transformer-only so the benchmark flag mostly matters for the warm-up
    # pass - the real latency win comes from the boot warm-up keeping the
    # CUDA context + weights resident.
    if device == "cuda":
        try:
            import torch as _torch
            _torch.set_float32_matmul_precision("high")
            _torch.backends.cudnn.benchmark = True
        except Exception:
            pass

    return predictor


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------
def load_csv(csv_path: str | Path) -> pd.DataFrame:
    """Load a CSV produced by ``1_fetch_data.py`` and return a clean
    DataFrame sorted by ``timestamps``."""
    csv_path = Path(csv_path)
    if not csv_path.is_file():
        raise FileNotFoundError(
            f"CSV not found: {csv_path}. Run 1_fetch_data.py first "
            f"(or use the dashboard's download button)."
        )
    df = pd.read_csv(csv_path)
    if "timestamps" not in df.columns:
        raise ValueError(
            f"'{csv_path.name}' has no 'timestamps' column. Generate the "
            f"file with 1_fetch_data.py."
        )
    df["timestamps"] = pd.to_datetime(df["timestamps"], errors="coerce")
    df = df.dropna(subset=["timestamps"] + OHLCV_COLUMNS)
    df = df.sort_values("timestamps").reset_index(drop=True)
    return df


def _infer_frequency(ts: pd.Series) -> pd.Timedelta:
    """Dominant intraday sampling frequency, robust to the large gaps that
    exist between sessions (overnight, weekends, holidays)."""
    diffs = ts.diff().dropna()
    # Explicit-unit construction is required: pandas 2.3.3's other Timedelta
    # constructors (kwargs like hours=..., and string forms like "2h") trip
    # numpy 2.5's deprecated 'generic' timedelta-unit path.
    intraday = diffs[diffs <= pd.Timedelta(2, unit="h")]
    if intraday.empty:
        intraday = diffs
    freq = intraday.median()
    if pd.isna(freq) or freq <= pd.Timedelta(0, unit="s"):
        freq = pd.Timedelta(5, unit="m")
    return freq


def _fixed_frequency_future(ts: pd.Series, pred_len: int) -> pd.Series:
    """Fallback: simply extrapolate at the dominant intraday frequency."""
    freq = _infer_frequency(ts)
    # Start one period after the last candle (slicing avoids Timestamp + Timedelta,
    # which triggers numpy 2.5's deprecated 'generic' unit path in pandas 2.3.3).
    future = pd.date_range(start=ts.iloc[-1], periods=pred_len + 1, freq=freq)[1:]
    return pd.Series(future)


def build_future_timestamps(x_timestamp: pd.Series, pred_len: int) -> pd.Series:
    """Build realistic future timestamps for the forecast horizon.

    Kronos conditions on the calendar fields of each timestamp
    (minute/hour/weekday/day/month), so the future timestamps should stay
    inside real trading sessions. We therefore repeat the intraday pattern
    of the most recent *full* session across the following trading days,
    skipping weekends. Falls back to plain fixed-frequency extrapolation
    when the session pattern cannot be inferred.
    """
    ts = pd.to_datetime(pd.Series(x_timestamp)).reset_index(drop=True)
    dates = ts.dt.normalize()
    session_sizes = ts.groupby(dates).size()

    # Use the most recent session at least as long as the median session
    # (the very last day is often still in progress / partial).
    median_size = session_sizes.median()
    full_sessions = session_sizes[session_sizes >= max(median_size, 1)]
    if full_sessions.empty:
        return _fixed_frequency_future(ts, pred_len)

    session_date = full_sessions.index[-1]
    session = ts[dates == session_date]
    # Time-of-day offsets (elapsed since midnight), so that
    # ``cursor + offset`` yields real market clock times (09:15, 09:20, ...)
    # instead of offsets relative to the session start (which would shift
    # every forecast candle ~9 hours into the night).
    offsets = session - session.dt.normalize()

    future: list[pd.Timestamp] = []
    last_ts = ts.iloc[-1]
    cursor = last_ts.normalize()

    # 1) If the final day in the data is a partial (in-progress) session,
    #    finish it first so the forecast continues seamlessly from the last
    #    candle instead of jumping to the next trading day.
    for offset in offsets:
        if len(future) >= pred_len:
            break
        candidate = cursor + offset
        if candidate > last_ts:
            future.append(candidate)

    # 2) Then keep going on the following trading days (weekends skipped),
    #    repeating the same intraday pattern.
    while len(future) < pred_len:
        # DateOffset (not Timedelta) avoids numpy 2.5's deprecated 'generic'
        # timedelta-unit path, which pandas 2.3.3 still trips on.
        cursor = cursor + pd.DateOffset(days=1)
        if cursor.weekday() >= 5:      # skip Saturday / Sunday
            continue
        for offset in offsets:
            if len(future) >= pred_len:
                break
            future.append(cursor + offset)

    # Every generated timestamp is strictly after the last historical candle,
    # so the forecast can never overlap the context fed to the model.
    return pd.Series(pd.to_datetime(future)).reset_index(drop=True)


# ---------------------------------------------------------------------------
# Prediction
# ---------------------------------------------------------------------------
def _run_predict(
    predictor: KronosPredictor,
    x_df: pd.DataFrame,
    x_timestamp: pd.Series,
    y_timestamp: pd.Series,
    pred_len: int,
    temperature: float,
    top_p: float,
    sample_count: int,
    device: str = DEVICE,
) -> pd.DataFrame:
    """Call ``predict`` on whichever Kronos API generation is installed and
    return the raw forecast DataFrame. ``device`` is the effective compute
    device (threaded from the caller, NOT the module global) so the CUDA
    autocast wrapper always matches the device the predictor actually runs
    on."""
    params = inspect.signature(predictor.predict).parameters

    if "df" in params and "pred_len" in params:
        # --- Current API: returns pred_df indexed by y_timestamp ---
        def _call():
            return predictor.predict(
                df=x_df,
                x_timestamp=x_timestamp,
                y_timestamp=y_timestamp,
                pred_len=pred_len,
                T=temperature,
                top_p=top_p,
                sample_count=sample_count,
                verbose=False,
            )
    else:
        # --- Legacy API: predict(x_df, x_timestamp, y_timestamp) ---
        def _call():
            result = predictor.predict(x_df, x_timestamp, y_timestamp)
            if isinstance(result, tuple):
                return result[0]
            return result

    if device == "cuda":
        # Mixed-precision inference on the GPU: autocast keeps the heavy
        # matmuls in fp16 (~2x faster, roughly half the VRAM of fp32) and
        # falls back to fp32 *on the GPU* if anything is autocast-incompatible.
        try:
            import torch as _torch
            with _torch.autocast(device_type="cuda", dtype=_torch.float16):
                return _call()
        except Exception as exc:
            logger.warning(
                "GPU fp16 inference failed (%s) - retrying in fp32 on the GPU", exc
            )
    return _call()


def _normalise_forecast(pred_df: pd.DataFrame, y_timestamp: pd.Series) -> pd.DataFrame:
    """Force the forecast into a consistent shape: a DataFrame containing at
    least a ``close`` column, indexed by the future timestamps."""
    if pred_df is None:
        raise ValueError("Kronos returned no predictions (pred_df is None).")

    pred_df = pred_df.copy()
    y_index = pd.DatetimeIndex(pd.to_datetime(pd.Series(y_timestamp)).reset_index(drop=True))

    if len(pred_df) != len(y_index):
        raise ValueError(
            f"Kronos returned {len(pred_df)} forecast rows but the requested "
            f"horizon is {len(y_index)}."
        )

    keep = [c for c in ("open", "high", "low", "close", "volume", "amount")
            if c in pred_df.columns]
    if not keep:
        raise ValueError("Kronos output contains no recognised columns.")
    if "close" not in keep:
        raise ValueError("Kronos output is missing the 'close' column.")

    pred_df = pred_df[keep]
    pred_df.index = y_index
    pred_df.index.name = "timestamps"
    return pred_df


def generate_forecast(
    csv_path: str | Path,
    lookback: int = 400,
    pred_len: int = 120,
    model_name: str = DEFAULT_MODEL,
    predictor: KronosPredictor | None = None,
    temperature: float = 1.0,
    top_p: float = 0.9,
    sample_count: int = 1,
    device: str = DEVICE,
    end_ts: pd.Timestamp | str | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Run Kronos zero-shot inference on the last ``lookback`` candles of a
    CSV produced by ``1_fetch_data.py``.

    Parameters
    ----------
    csv_path : path to the 5-minute CSV (e.g. ``nifty50_5m.csv``).
    lookback : number of historical candles given to the model as context.
    pred_len : number of future candles to forecast.
    model_name : one of ``MODEL_OPTIONS`` ("Kronos-small" by default).
    predictor : an already-loaded ``KronosPredictor`` (avoids re-loading
                the model on every call - pass a cached instance).
    temperature / top_p / sample_count : sampling controls.
    end_ts : optional cutoff timestamp. When given, only candles at or before
             this moment are used as context, so the forecast is made "as if
             it were" that point in time. Used by the backtest verifier
             (6_verify_forecast.py) to replay historical forecasts.

    Returns
    -------
    (historical_df, forecast_df)
        historical_df : the last ``lookback`` rows (timestamps + OHLCV).
        forecast_df   : ``pred_len`` rows (open/high/low/close/volume/amount,
                        or at least ``close``) indexed by the future
                        timestamps.
    """
    if lookback <= 0 or pred_len <= 0:
        raise ValueError("'lookback' and 'pred_len' must be positive integers.")
    if model_name not in MODEL_OPTIONS:
        raise ValueError(
            f"Unknown model '{model_name}'. Choose from {list(MODEL_OPTIONS)}."
        )
    if device not in ("cuda", "mps", "cpu"):
        raise ValueError(f"Unknown device '{device}' - choose cuda, mps or cpu.")

    df = load_csv(csv_path)
    if end_ts is not None:
        end_ts = pd.Timestamp(end_ts)
        df = df[df["timestamps"] <= end_ts].reset_index(drop=True)
    if len(df) < lookback:
        raise ValueError(
            f"'{Path(csv_path).name}' only contains {len(df)} candles but a "
            f"lookback of {lookback} was requested. Re-run 1_fetch_data.py "
            f"or reduce the lookback."
        )

    historical = df.iloc[-lookback:].reset_index(drop=True)
    x_df = historical[OHLCV_COLUMNS]
    x_timestamp = pd.Series(historical["timestamps"])
    y_timestamp = build_future_timestamps(x_timestamp, pred_len)

    if predictor is None:
        predictor = load_predictor(model_name=model_name, device=device)

    logger.info(
        "Kronos inference: lookback=%d pred_len=%d model=%s device=%s",
        lookback, pred_len, model_name, device,
    )

    pred_df = _run_predict(
        predictor, x_df, x_timestamp, y_timestamp,
        pred_len, temperature, top_p, sample_count,
        device=device,
    )
    forecast = _normalise_forecast(pred_df, y_timestamp)

    return historical, forecast


if __name__ == "__main__":
    hist, fcast = generate_forecast("nifty50_5m.csv")
    print(f"Historical context: {hist.shape} rows")
    print(f"Forecast: {len(fcast)} candles")
    print(fcast.round(2).to_string())
