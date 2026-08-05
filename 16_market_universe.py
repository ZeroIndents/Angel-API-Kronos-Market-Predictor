"""
16_market_universe.py
=====================
Symbol universe for the Angel One SmartAPI live TradingView platform.

Angel One publishes the *complete* instrument master (OpenAPIScripMaster)
at a public URL - every tradable symbol: NSE indices (999-prefixed tokens)
and equities, NFO index/stock futures (FUTIDX/FUTSTK) and index/stock
options (OPTIDX/OPTSTK), BSE equities + indices, and MCX commodity
futures/options (FUTCOM/OPTFUT). This module downloads it once (34 MB),
caches a filtered view of every chartable segment next to this script and
exposes a searchable, TradingView-style symbol list.

    python 16_market_universe.py --search "reliance"
    python 16_market_universe.py --refresh       # force a re-download

Everything is offline after the first download. If the download fails the
module degrades gracefully to a small hard-coded index list (``CURATED``)
so the dashboard still works.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

BASE_DIR = Path(__file__).resolve().parent

MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
CACHE_FILE = BASE_DIR / "scrip_master_cache.csv"
MASTER_TTL_DAYS = 7

# Hard-coded fallback for when the master cannot be downloaded (the two
# index assets the public build ships with - see CURATED_NAMES).
_FALLBACK = [
    {"token": "99926000", "symbol": "Nifty 50", "name": "NIFTY"},
    {"token": "99926009", "symbol": "Nifty Bank", "name": "BANKNIFTY"},
]

# PUBLIC BUILD - exactly THREE chartable instruments ship with this
# terminal: the Nifty 50 index, the near-month NIFTY future and the Bank
# Nifty index. Symbol names are resolved against the downloaded master so
# the tokens always match Angel's current file.
CURATED_NAMES = [
    "Nifty 50", "Nifty Bank",
]

# Near-month futures: display label -> base name in the master. Contracts
# roll every month (NIFTY25AUG26FUT -> NIFTY29SEP26FUT -> ...), so these
# labels always resolve to whichever expiry is the closest future one.
CURATED_FUTURES = [
    "NIFTY FUT",
]
FUTURES_BASE = {
    "NIFTY FUT": "NIFTY",
    "BANKNIFTY FUT": "BANKNIFTY",
}

# SmartAPI segment -> (REST exchange label, WebSocket exchangeType).
#   1 = NSE_CM (indices + equities)   2 = NSE_FO (futures/options)
#   3 = BSE_CM (BSE equities/indices)  5 = MCX  (commodities)
SEGMENT_EXCHANGE = {
    "NSE": "NSE",
    "NFO": "NFO",
    "BSE": "BSE",
    "MCX": "MCX",
}
SEGMENT_EXCHANGE_TYPE = {
    "NSE": 1,
    "NFO": 2,
    "BSE": 3,
    "MCX": 5,
}

# Chartable segments kept from the master (everything SmartAPI serves
# candles + ticks for). BFO/NCO/CDS/NCDEX are excluded - Angel's historical
# and live APIs do not reliably serve those segments.
KEEP_SEGMENTS = ("NSE", "NFO", "BSE", "MCX")

_filtered_cache: pd.DataFrame | None = None


# ---------------------------------------------------------------------------
# Download / cache
# ---------------------------------------------------------------------------
def _download_master() -> pd.DataFrame:
    """Download the full OpenAPIScripMaster and return the filtered view of
    every chartable segment: NSE (indices + equities), NFO (index/stock
    futures + index/stock options), BSE (equities + indices) and MCX
    (commodity futures/options + spot)."""
    req = urllib.request.Request(MASTER_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        rows = json.load(resp)
    df = pd.DataFrame(rows)
    df = df[df["exch_seg"].isin(KEEP_SEGMENTS)].copy()
    df = df[["token", "symbol", "name", "expiry", "strike",
             "lotsize", "instrumenttype", "exch_seg"]].copy()
    df["token"] = df["token"].astype(str)
    df = df.drop_duplicates(subset=["token"]).sort_values("symbol").reset_index(drop=True)
    return df


def refresh_master(force: bool = False) -> pd.DataFrame:
    """Ensure the filtered master is cached on disk (re-downloads if stale)."""
    global _filtered_cache
    if _filtered_cache is not None and not force:
        return _filtered_cache
    fresh = (CACHE_FILE.is_file()
             and (datetime.now().timestamp() - CACHE_FILE.stat().st_mtime)
                 < MASTER_TTL_DAYS * 86400)
    if fresh and not force:
        try:
            _filtered_cache = pd.read_csv(CACHE_FILE)
            _filtered_cache["token"] = _filtered_cache["token"].astype(str)
            # Older caches were filtered to NSE + NFO index futures only -
            # treat them as stale so options/BSE/MCX actually show up without
            # waiting for the 7-day TTL. Require an NFO option + BSE + MCX row.
            cols = set(_filtered_cache.columns)
            if {"exch_seg", "instrumenttype"} <= cols:
                has = _filtered_cache["exch_seg"]
                if (has.eq("NFO").any() and has.eq("BSE").any()
                        and has.eq("MCX").any()):
                    return _filtered_cache
        except Exception:
            pass
    df = _download_master()
    df.to_csv(CACHE_FILE, index=False)
    _filtered_cache = df
    return df


def load() -> pd.DataFrame:
    """Return the full filtered universe (indices + NSE equities)."""
    try:
        return refresh_master()
    except Exception:
        return pd.DataFrame(_FALLBACK)


# ---------------------------------------------------------------------------
# Search / resolve
# ---------------------------------------------------------------------------
def search(query: str = "", limit: int = 30) -> list[dict[str, Any]]:
    """Search the universe by name/symbol with tokenized matching.

    Handles TradingView-style queries where no single field contains the
    whole phrase:

    - ``"NIFTY FUT"`` -> name ``NIFTY`` AND a FUT* instrument (FUTIDX/
      FUTSTK/FUTCOM) -> near-month index futures rank first
    - ``"BANKNIFTY 46000 CE"`` -> name + strike + call side
    - ``"GOLD"`` -> exact-name matches (MCX GOLD future) beat substring
      matches (GOLDBEES ETF)

    Returns a list of dicts with keys ``token``, ``symbol``, ``name`` and
    ``instrumenttype``.

    PUBLIC BUILD: only the three curated instruments (Nifty 50, NIFTY FUT,
    Bank Nifty) are ever returned - a query merely filters those three, so
    no other instrument in the SmartAPI master is reachable from the picker.
    """
    curated = curated_symbols()
    q = (query or "").strip().upper()
    if not q:
        return curated[:limit]
    out: list[dict[str, Any]] = []
    for rec in curated:
        label = display_label(rec).upper()
        sym = str(rec.get("symbol", "") or "").upper()
        name = str(rec.get("name", "") or "").upper()
        if q in label or q in sym or q in name:
            out.append(rec)
    return out[:limit]


def _near_month_future(base_name: str, exch_seg: str = "NFO",
                       instrumenttype: str = "FUTIDX") -> dict[str, Any] | None:
    """Resolve ``base_name`` to its closest FUTURE expiry.

    Defaults to NFO index futures (FUTIDX, e.g. NIFTY). Pass
    ``instrumenttype="FUTSTK"`` for stock futures (RELIANCE FUT) or
    ``exch_seg="MCX"``/``instrumenttype="FUTCOM"`` for commodities
    (GOLD/SILVER/CRUDEOIL on MCX). Futures roll monthly, so the near-month
    contract (and its token) changes over time - always resolve fresh.
    Returns the master record or None."""
    df = load()
    rows = df[(df["exch_seg"].eq(exch_seg))
              & df["instrumenttype"].eq(instrumenttype)].copy()
    rows = rows[rows["name"].astype(str).str.upper().eq(base_name.upper())]
    if rows.empty:
        return None
    rows["_expiry"] = pd.to_datetime(rows["expiry"], format="%d%b%Y", errors="coerce")
    # Never pick an already-expired contract; prefer the nearest future one.
    # Compare on the IST calendar day (contract expiry is an IST business
    # date) so a machine in another timezone can't keep a just-expired
    # contract as "nearest" for up to ~a day.
    ist_today = pd.Timestamp.now(tz="Asia/Kolkata").normalize().tz_localize(None)
    rows = rows[rows["_expiry"] >= ist_today]
    if rows.empty:
        return None
    best = rows.sort_values("_expiry").iloc[0]
    return {
        "token": str(best.get("token", "")),
        "symbol": str(best.get("symbol", "")),
        "name": str(best.get("name", "")),
        "expiry": str(best.get("expiry", "")),
        "strike": best.get("strike"),
        "lotsize": best.get("lotsize"),
        "instrumenttype": str(best.get("instrumenttype", "")),
        "exch_seg": exch_seg,
    }


def curated_symbols() -> list[dict[str, Any]]:
    """Resolve the default watchlist against the current master (indices +
    equities + near-month futures incl. stock/commodity)."""
    df = load()
    out: list[dict[str, Any]] = []
    for wanted in CURATED_NAMES:
        upper = wanted.upper()
        row = df[(df["name"].astype(str).str.upper() == upper)
                 | (df["symbol"].astype(str).str.upper() == upper)]
        if not row.empty:
            r = row.iloc[0].to_dict()
            out.append({
                "token": str(r.get("token", "")),
                "symbol": str(r.get("symbol", "")),
                "name": str(r.get("name", "")),
                "expiry": str(r.get("expiry", "") or ""),
                "instrumenttype": str(r.get("instrumenttype", "")),
                "exch_seg": str(r.get("exch_seg", "")),
            })
    for label in CURATED_FUTURES:
        fut = resolve(label)
        if fut:
            out.append(fut)
    if not out:
        out = [dict(r) for r in _FALLBACK]
    return out


def display_label(rec: dict[str, Any]) -> str:
    """Friendly label for the UI:

    - NFO index futures (FUTIDX)  -> "NIFTY FUT"
    - NFO stock futures (FUTSTK)  -> "RELIANCE FUT" (name + " FUT")
    - MCX commodity futures       -> "GOLD" / "SILVER" (name as-is)
    - NFO/MCX options            -> "NIFTY 11AUG26 21700 CE" (readable)
    - indices keep spaced names, equities show the short name.
    """
    it = str(rec.get("instrumenttype", ""))
    seg = str(rec.get("exch_seg", ""))
    name = str(rec.get("name", "") or "")
    if it in ("FUTIDX", "FUTSTK"):
        return f"{name} FUT"
    if it in ("OPTIDX", "OPTSTK", "OPTFUT"):
        return _option_label(rec)
    sym = str(rec.get("symbol", "") or "")
    if it == "" and seg == "MCX":
        return name or sym                       # commodity spot
    if name.upper() == "NIFTY":
        return "Nifty 50"                        # master symbol "NIFTY 50"
    if name.upper() == "BANKNIFTY":
        return "Bank Nifty"                      # master symbol "NIFTY BANK"
    if " " in sym:
        return sym
    return name or sym


def _option_label(rec: dict[str, Any]) -> str:
    """Readable option label: ``NIFTY11AUG2621700CE`` -> "NIFTY 11AUG26 21700 CE".
    Strikes are stored in paise (the float 800000.0 == 8000.00); the symbol
    itself embeds the rupee strike (``21700``), which is what we render."""
    sym = str(rec.get("symbol", "") or "")
    name = str(rec.get("name", "") or "")
    # e.g. NIFTY11AUG2621700CE | RELIANCE26NOV262900CE | GOLD31AUG26162000CE
    import re
    m = re.match(r"^(.+?)(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$", sym)
    if m:
        base, exp, strike, side = m.groups()
        return f"{base} {exp} {int(strike):,} {side}"
    return sym or f"{name} OPT"


def resolve(display: str) -> dict[str, Any] | None:
    """Map a display label (a symbol from a selectbox) back to a symbol dict.

    Futures labels ("NIFTY FUT", "RELIANCE FUT", "GOLD") resolve to the
    near-month contract; option labels ("NIFTY 11AUG26 21700 CE") resolve to
    the exact contract; anything else matches by exact symbol/name."""
    upper = (display or "").strip().upper()
    if not upper:
        return None
    if upper in FUTURES_BASE:
        return _near_month_future(FUTURES_BASE[upper])
    if upper.endswith(" FUT") and len(upper) > 4:
        base = upper[:-4]
        # stock futures first (most liquid), then index futures
        fut = _near_month_future(base, "NFO", "FUTSTK")
        if fut:
            return fut
        return _near_month_future(base, "NFO", "FUTIDX")
    # MCX commodity name -> near-month FUTCOM (GOLD -> GOLD05OCT26FUT)
    if " " not in upper and not upper.endswith(("CE", "PE")):
        fut = _near_month_future(upper, "MCX", "FUTCOM")
        if fut:
            return fut
    # Symbol + name match (covers options + equities). Merge both so the
    # NSE cash contract wins ties: RELIANCE is "RELIANCE-EQ" on NSE (name
    # "RELIANCE") but bare "RELIANCE" on BSE - a pure symbol match would pick
    # the BSE row first, so combine with name matches and prefer NSE.
    df = load()
    both = df[df["symbol"].astype(str).str.upper().eq(upper)
              | df["name"].astype(str).str.upper().eq(upper)]
    both = both.drop_duplicates(subset=["token"])
    if not both.empty:
        return _prefer_segment(both).iloc[0].to_dict()
    # Option label "NIFTY 11AUG26 21700 CE" -> reconstruct the symbol.
    import re
    m = re.match(r"^(.+?)\s+(\d{2}[A-Z]{3}\d{2})\s+([\d,]+)\s+(CE|PE)$", upper)
    if m:
        base, exp, strike, side = m.groups()
        sym_str = f"{base}{exp}{strike.replace(',', '')}{side}"
        hit = df[df["symbol"].astype(str).str.upper().eq(sym_str)]
        if not hit.empty:
            return _prefer_segment(hit).iloc[0].to_dict()
    # Option label WITHOUT an expiry ("BANKNIFTY 46000 PE"): pick the
    # near-month contract at that strike so hand-typed watchlist/embed labels
    # still resolve instead of dead-ending.
    m = re.match(r"^(.+?)\s+([\d,]+)\s+(CE|PE)$", upper)
    if m:
        base, strike, side = m.groups()
        strike = strike.replace(',', '')
        opt_rows = df[df["name"].astype(str).str.upper().eq(base)
                      & df["symbol"].astype(str).str.endswith(strike + side)]
        opt_rows = opt_rows.drop_duplicates(subset=["token"])
        if not opt_rows.empty:
            opt_rows = opt_rows.copy()
            opt_rows["_expiry"] = pd.to_datetime(
                opt_rows["expiry"], format="%d%b%Y", errors="coerce")
            future = opt_rows[opt_rows["_expiry"] >= pd.Timestamp.today().normalize()]
            if not future.empty:
                return _prefer_segment(
                    future.sort_values("_expiry")
                ).iloc[0].drop(labels=["_expiry"]).to_dict()
            return _prefer_segment(opt_rows).iloc[0].to_dict()
    # Name match (e.g. "RELIANCE" -> NSE equity, "SENSEX" -> BSE index).
    hit = df[df["name"].astype(str).str.upper().eq(upper)]
    if not hit.empty:
        return _prefer_segment(hit).iloc[0].to_dict()
    return None


def _prefer_segment(rows: pd.DataFrame) -> pd.DataFrame:
    """Order rows so the primary segment wins ties: NSE (cash) > NFO > BSE >
    MCX. Used when the same symbol/name lists in several segments (RELIANCE on
    NSE+BSE, GOLD index vs GOLD future)."""
    order = {"NSE": 0, "NFO": 1, "BSE": 2, "MCX": 3}
    seg = rows["exch_seg"].astype(str)
    rows = rows.assign(_seg_rank=seg.map(order).fillna(4))
    return rows.sort_values("_seg_rank").drop(columns=["_seg_rank"])


def build_live_assets(displays: list[str]) -> dict[str, dict[str, Any]]:
    """Map display labels -> ``{token, exchange_type}`` for the live aggregator.

    Each segment streams on its own WebSocket exchangeType: NSE_CM = 1,
    NSE_FO (futures/options) = 2, BSE_CM = 3, MCX = 5. Using the cash type
    for a derivative/commodity token makes the WebSocket silently ignore it.
    """
    assets: dict[str, dict[str, Any]] = {}
    for display in displays:
        rec = resolve(display)
        if rec and rec.get("token"):
            seg = str(rec.get("exch_seg", "NSE"))
            assets[display] = {
                "token": rec["token"],
                "exchange_type": SEGMENT_EXCHANGE_TYPE.get(seg, 1),
            }
    return assets


def exchange_for(rec: dict[str, Any]) -> str:
    """REST ``exchange`` label for a master record (NSE/NFO/BSE/MCX)."""
    return SEGMENT_EXCHANGE.get(str(rec.get("exch_seg", "NSE")), "NSE")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _cli() -> int:
    parser = argparse.ArgumentParser(description="Angel One symbol universe.")
    parser.add_argument("--search", type=str, default="", help="Search symbols.")
    parser.add_argument("--refresh", action="store_true", help="Re-download the master.")
    args = parser.parse_args()

    if args.refresh:
        df = refresh_master(force=True)
        print(f"Master refreshed: {len(df)} instruments -> {CACHE_FILE}")
        return 0

    hits = search(args.search, limit=30)
    print(f"{len(hits)} result(s):")
    for h in hits:
        print(f"  {h['token']:<10} {h['symbol']:<24} {h.get('name', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
