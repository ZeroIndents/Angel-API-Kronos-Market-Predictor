# 🔮 Kronos View — Live AI Chart Terminal

A self-hosted **live chart terminal** for NVIDIA's **Kronos** zero-shot
financial forecasting model, focused on a single thing: watching the AI
predict the next candles on NSE (Indian market) data in real time.

**One chart. Live ticks. AI forecast overlay. Nothing else.**

> ⚠️ **Research / educational demo only — not investment advice.** See `LICENSE`.

---

## What it does

- **🔮 Kronos AI forecast** — click the button (or hit Auto) and the model
  draws a dashed prediction path for the next 30 candles over the live chart,
  with a direction call, confidence score, and market-regime context panel.
- **Live feed** — Angel One SmartAPI WebSocket ticks stream straight in and
  the forecast re-runs as candles close.
- **Timeframes** — 1m / 5m / 15m / 30m / 1H / 1D.
- **Range shortcuts** — 1D → 5Y.
- **Candle auto-zoom** — the chart follows the latest candle and re-centres
  automatically; ⟲ (or Alt+R) resets the view to the recent candles.
- **Volume toggle, fullscreen, PNG screenshot**, symbol search (Ctrl+K), and
  a status bar with source / market / websocket badges.

The chart deliberately ships **bare**: no drawing tools, no indicator
library, no multi-pane layouts, no compare, no alerts/patterns/news panels —
just the forecast.

## Models

Two NVIDIA Kronos variants are supported (GPU-only):

| Model | Params | Max context |
|---|---|---|
| `Kronos-mini` | 4.1M | 2048 |
| `Kronos-small` (default) | 24.7M | 512 |

## Platform guides

Complete, platform-specific documentation:

| Platform | Guide | Notes |
|---|---|---|
| 🪟 Windows | [`docs/WINDOWS.md`](docs/WINDOWS.md) | CUDA torch install, `.bat` autostart |
| 🍎 macOS | [`docs/MACOS.md`](docs/MACOS.md) | **GPU warning**: Kronos is CUDA-only, so macOS cannot run the forecast locally — use a Mac as a browser client for a server on an NVIDIA machine |
| 🐧 Linux | [`docs/LINUX.md`](docs/LINUX.md) | NVIDIA driver setup, systemd auto-start |

## Quickstart (Windows)

```bat
py -m venv .venv
.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe server.py
```

Then open `http://localhost:81`.

### Clone the Kronos model repo

The server imports the Kronos codebase at runtime — clone it next to this
folder (or set `KRONOS_REPO_DIR`):

```
git clone https://github.com/shiyu-coder/Kronos
```

The GPU model weights download from Hugging Face on first forecast.

### Angel One login (for live data)

Copy `.env.example` to `.env`, fill in your SmartAPI credentials, and log in:

```
python 8_smartapi_auth.py --login
```

Without a login the chart still works from any cached local CSVs that were
recorded in a previous session.

## Stack

- `server.py` — FastAPI: history REST, live WebSocket, Kronos forecast endpoint
- `static/` — lightweight-charts v5.2 UI (single chart)
- `2_kronos_inference.py` — GPU inference core (Kronos-mini / Kronos-small)
- `8_smartapi_auth.py` / `9_smartapi_fetch.py` / `10_smartapi_live.py` —
  Angel One session, history, and live ticks
- `16_market_universe.py` — NSE scrip master + symbol search

## License

**Viewing license — all rights reserved.** This project is shared for
viewing and personal evaluation only. Copying, redistribution, modification,
commercial use, and derivative works are prohibited without written
permission. See `LICENSE`.
