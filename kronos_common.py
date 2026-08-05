"""
kronos_common.py
================
Shared helper module for the Kronos platform — the single home for the
machinery that used to be copy-pasted into a dozen numbered scripts:

* ``import_script`` — load a digit-prefixed sibling script via importlib
  (a plain ``import`` cannot handle filenames that start with a digit),
  reusing any module already in ``sys.modules`` so shared caches (most
  importantly the Kronos predictor in ``2_kronos_inference``) stay
  process-wide instead of being duplicated per browser session.
* ``kronos_view_port / kronos_view_url / kronos_view_up / kronos_view_embed``
  — the Kronos View terminal (``21_tv_webapp``) discovery + embed helpers
  every Streamlit page needs (port from ``.env`` ``TV_PORT``, host-aware
  URL for LAN devices, TCP liveness probe, iframe embed with the AI overlay).
* ``width_kwargs`` — the correct ``st.*`` stretch keyword for the installed
  Streamlit version (``use_container_width`` was renamed to
  ``width="stretch"`` in 1.49; the old name is deprecated in 1.60).
* ``patch_lightweight_charts`` — the missing-comma monkey-patch that fixes
  lightweight-charts 2.1 line-series rendering (identical fix was duplicated
  in the dashboard and the Live AI page).
* ``install_secret_redaction`` — attaches a logging filter that scrubs Angel
  One JWTs / API keys / PINs out of every log line, so secrets never land in
  ``*.log`` files (the smartapi-python SDK logs full ``Authorization``
  headers on every failed request).

The module deliberately imports NOTHING heavy at module level (no streamlit,
no pandas, no torch) so every consumer — including the pure-API servers and
CLI scripts — can import it cheaply.
"""

from __future__ import annotations

import importlib.util
import logging
import re
import sys
import traceback
from pathlib import Path
from typing import Any

# The project folder this module lives in (used as the default base dir for
# import_script callers that do not pass one, and as the .env location).
PROJECT_DIR = Path(__file__).resolve().parent
ENV_FILE = PROJECT_DIR / ".env"


# ---------------------------------------------------------------------------
# Sibling-module loading (digit-leading filenames -> importlib)
# ---------------------------------------------------------------------------
def import_script(rel_path: str, base_dir: str | Path | None = None) -> Any:
    """Import a sibling script whose filename starts with a digit (which a
    regular ``import`` statement cannot handle) and return its module.

    Reuses any module already in ``sys.modules`` — so shared caches (the
    Kronos predictor inside ``2_kronos_inference``, the SmartAPI session)
    stay process-wide instead of being duplicated per browser session. The
    module is registered in ``sys.modules`` BEFORE execution so circular
    imports between sibling scripts resolve cleanly.

    ``base_dir`` defaults to this project folder; pass a different base dir
    for scripts that live in a subfolder.
    """
    path = Path(base_dir or PROJECT_DIR) / rel_path
    if not path.is_file():
        raise FileNotFoundError(f"Missing required script: {path}")
    module_name = path.stem
    if module_name in sys.modules and sys.modules[module_name] is not None:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Streamlit width helper (version-safe)
# ---------------------------------------------------------------------------
def width_kwargs() -> dict:
    """Return the correct \"stretch\" keyword arguments for the installed
    Streamlit version (``use_container_width`` was renamed to
    ``width=\"stretch\"`` in Streamlit 1.49; the old name is deprecated and may
    be removed in newer releases such as 1.60)."""
    try:
        import streamlit as _st
        from streamlit import __version__ as sv
        major, minor = (int(part) for part in sv.split(".")[:2])
    except (ImportError, ValueError):
        return {"use_container_width": True}
    if (major, minor) >= (1, 49):
        return {"width": "stretch"}
    return {"use_container_width": True}


# ---------------------------------------------------------------------------
# Kronos View terminal (21_tv_webapp) discovery + embed
# ---------------------------------------------------------------------------
def kronos_view_port() -> int:
    """The port the Kronos View terminal actually binds (from ``.env``
    ``TV_PORT``, default 81).

    Ports < 1024 need root on Linux, so deployments commonly set
    ``TV_PORT=8081`` in ``.env``. Every dashboard embed AND liveness probe
    must use this same port, otherwise the chart reports \"offline\" while
    the server is actually running on the configured port.
    """
    try:
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("TV_PORT="):
                return int(line.split("=", 1)[1].strip() or 81)
    except Exception:
        pass
    return 81


def kronos_view_url(port: int | None = None) -> str:
    """Host-aware base URL for the Kronos View terminal (the configured
    ``TV_PORT`` from ``.env`` by default).

    The Streamlit app can be opened from another device on the LAN (e.g.
    http://192.168.29.100:80). An iframe pointing at ``127.0.0.1:8081`` would
    resolve to *that device itself* and never load the live chart, so the
    host is taken from the Host header the browser actually used. Falls
    back to 127.0.0.1 when the header is unavailable (e.g. unit tests).
    """
    port = kronos_view_port() if port is None else port
    host = "127.0.0.1"
    try:
        import streamlit as _st
        req_host = (_st.context.headers.get("Host") or "").strip()
        if req_host:
            if req_host.startswith("["):          # IPv6 literal [::1]:80
                host = req_host.split("]")[0] + "]"
            else:
                host = req_host.rsplit(":", 1)[0]  # drop any explicit port
    except Exception:
        pass
    return f"http://{host}:{port}"


def kronos_view_up(timeout: float = 0.6) -> bool:
    """Quick TCP probe — is the Kronos View server listening on its port?"""
    import socket
    try:
        with socket.create_connection(("127.0.0.1", kronos_view_port()), timeout=timeout):
            return True
    except OSError:
        return False


def kronos_view_embed(symbol: str, interval: str = "5m", ai: bool = True,
                      height: int = 620) -> None:
    """Embed the Kronos View chart for one symbol/interval in a Streamlit
    page. With ``ai=True`` the embedded chart turns its Kronos AI overlay +
    auto-predict on, so the prediction appears on the new chart itself."""
    import streamlit as _st
    from urllib.parse import quote
    if not kronos_view_up():
        _st.info(
            "🖥️ The Kronos View terminal isn't running yet — open the "
            "**Kronos View** tab (launcher) or run "
            "`python server.py`, then come back here. "
            "It serves the live chart + Kronos prediction overlay."
        )
        return
    params = f"symbol={quote(symbol)}&interval={interval}&ai={'1' if ai else '0'}&layout=1"
    _st.iframe(f"{kronos_view_url()}/?{params}", height=height)
    _st.caption(
        "Kronos View chart — candles update live over the Angel feed; the "
        "dashed overlay is the Kronos forecast and it re-runs automatically "
        "on every newly closed candle (🔮 AI on for this embed)."
    )


# ---------------------------------------------------------------------------
# lightweight-charts 2.1 monkey-patch (missing comma in line-series JS)
# ---------------------------------------------------------------------------
def patch_lightweight_charts() -> bool:
    """Apply the lightweight-charts 2.1 line-series fix.

    ``lightweight-charts`` 2.1 emits invalid JavaScript for line series when
    ``scale_candles_only`` is enabled: in ``Line.__init__`` the generated
    options object is ``priceScaleId: undefined`` immediately followed by
    ``autoscaleInfoProvider: () => ({...})`` with NO comma between them,
    producing a ``SyntaxError: Unexpected identifier 'autoscaleInfoProvider'``
    that aborts the entire chart-building script (candles included).
    Re-emit the template with the missing comma so SMA and forecast lines
    render while candles-only autoscaling keeps working.

    Returns True when the patch was applied, False when lightweight-charts is
    not installed (callers should never block the app over a chart nicety).
    """
    try:
        import lightweight_charts.abstract as _lwc_abstract

        def _lwc_fixed_line_init(self, chart, name, color, style, width,
                                 price_line, price_label, price_scale_id=None,
                                 crosshair_marker=True):
            _lwc_abstract.SeriesCommon.__init__(self, chart, name)
            self.color = color
            # Python <3.12 f-strings cannot hold `{`/`}` inside a string
            # literal in a replacement field (SyntaxError: f-string:
            # expecting '}'), so the JS autoscale callback - which is full of
            # braces - is built as a plain string FIRST and embedded by name.
            _autoscale_snippet = (
                "autoscaleInfoProvider: () => ({\n"
                "    priceRange: { minValue: 1_000_000_000, maxValue: 0 },\n"
                "}),\n"
                if chart._scale_candles_only else ""
            )
            self.run_script(f'''
                {self.id} = {self._chart.id}.createLineSeries(
                    "{name}",
                    {{
                        color: '{color}',
                        lineStyle: {_lwc_abstract.as_enum(style, _lwc_abstract.LINE_STYLE)},
                        lineWidth: {width},
                        lastValueVisible: {_lwc_abstract.jbool(price_label)},
                        priceLineVisible: {_lwc_abstract.jbool(price_line)},
                        crosshairMarkerVisible: {_lwc_abstract.jbool(crosshair_marker)},
                        priceScaleId: {f'"{price_scale_id}"' if price_scale_id else 'undefined'},
                        {_autoscale_snippet}
                    }}
                )
            null''')

        _lwc_abstract.Line.__init__ = _lwc_fixed_line_init
        return True
    except Exception:
        # Never block the app over a chart nicety, but make a patch failure
        # visible in the log instead of silently regressing the chart.
        traceback.print_exc()
        return False


# ---------------------------------------------------------------------------
# Secret redaction (JWT / API keys / PINs never reach log files)
# ---------------------------------------------------------------------------
# The smartapi-python SDK logs the full request headers — including the
# ``Authorization: Bearer <jwt>`` header and the ``X-PrivateKey`` — on every
# failed call. These patterns scrub those secrets out of any log record.
_REDACT = "***REDACTED***"

# (pattern, replacement). Only genuinely secret values are scrubbed:
# Authorization/JWT, the API key (X-PrivateKey) and the trading PIN. The
# client_id is deliberately NOT scrubbed - it is an account username that
# makes login-debugging easier, not a credential.
_SECRET_PATTERNS: list[tuple[re.Pattern, str]] = [
    # Authorization header inside a dict repr: 'Authorization': 'Bearer eyJ...'
    (re.compile(r"('Authorization':\s*'Bearer )[^']*(')"), r"\1" + _REDACT + r"\2"),
    # Authorization header as plain text: Authorization: Bearer eyJ...
    (re.compile(r"(Authorization:\s*Bearer )[A-Za-z0-9._\-]+", re.IGNORECASE),
     r"\1" + _REDACT),
    # A bare "Bearer <token>" pair (library's internal request object).
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]{20,}"), r"\1" + _REDACT),
    # X-PrivateKey / api_key / pin values inside a dict repr.
    (re.compile(r"('X-PrivateKey':\s*')[^']*(')"), r"\1" + _REDACT + r"\2"),
    (re.compile(r"('(?:api_key|pin)':\s*')[^']*(')"), r"\1" + _REDACT + r"\2"),
    # A raw JWT body token (eyJ...header.signature) with no "Bearer" prefix.
    (re.compile(r"\beyJ[A-Za-z0-9_.\-]{30,}"), _REDACT),
]


class SecretRedactionFilter(logging.Filter):
    """A logging filter that scrubs Angel One secrets from every record.

    Attach it to the root logger (and logzero's logger, which the SmartAPI
    SDK uses) so JWT / API-key / PIN values never reach ``*.log`` files.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        redacted = msg
        for pattern, repl in _SECRET_PATTERNS:
            redacted = pattern.sub(repl, redacted)
        if redacted != msg:
            record.msg = redacted
            record.args = ()
        return True


def install_secret_redaction() -> SecretRedactionFilter:
    """Attach the secret-scrubbing filter to every logger the platform uses.

    Covers the root logger (all child loggers propagate through it) plus
    logzero's own logger, which the smartapi-python SDK logs through.
    Idempotent per filter instance — safe to call from every entry point.
    """
    filt = SecretRedactionFilter("kronos-secrets")
    logging.getLogger().addFilter(filt)
    try:
        from logzero import logger as _lz
        _lz.addFilter(filt)
    except Exception:
        pass
    try:
        logging.getLogger("SmartApi").addFilter(filt)
        logging.getLogger("smartConnect").addFilter(filt)
    except Exception:
        pass
    return filt
