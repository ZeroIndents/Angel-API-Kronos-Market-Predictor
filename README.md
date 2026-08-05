# 🔮 Kronos View — Live AI Chart Terminal

A self-hosted **live chart terminal** built around the **Kronos** zero-shot
financial forecasting model, focused on a single thing: watching the AI
predict the next candles on NSE (Indian market) data in real time.

**One chart. Live ticks. AI forecast overlay. Nothing else.**

> ⚠️ **Research / educational demo only — not investment advice.** See `LICENSE`.

## About the AI model

Kronos is **not** an NVIDIA product. It is an open-source research model
from a **Tsinghua University** team (Yu Shi, Zongliang Fu, et al.):

- **Paper:** *"Kronos: A Foundation Model for the Language of Financial
  Markets"* — [arXiv:2508.02739](https://arxiv.org/abs/2508.02739), accepted
  at **AAAI 2026**
- **Code:** [github.com/shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos)
- **Weights:** Hugging Face (`NeoQuasar/Kronos-mini`, `NeoQuasar/Kronos-small`)
- NVIDIA's only connection: the authors trained on RTX 4090D GPUs. (NVIDIA's
  *separate* "Kronos" robotics model is a coincidental name overlap.)

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

## Models & compute

Two Kronos variants are supported, and the compute device is **auto-detected**:

| Model | Params | Max context |
|---|---|---|
| `Kronos-mini` | 4.1M | 2048 |
| `Kronos-small` (default) | 24.7M | 512 |

The device auto-detects at startup in this order:

1. **CUDA GPU** — NVIDIA GPU (Windows/Linux). Fastest. Optional speedup.
2. **Apple Silicon MPS** — M1/M2/M3/M4 Macs, uses the Apple GPU.
3. **CPU** — any machine, including **Intel Macs** and GPU-less boxes. The
   models are tiny (4.1M / 24.7M params), so CPU forecasts are quick.

The status bar shows which device the forecast ran on (`⚡GPU`, `Apple`, or
`CPU`).

## Platform guides

Complete, platform-specific documentation:

| Platform | Guide | Notes |
|---|---|---|
| 🪟 Windows | [`docs/WINDOWS.md`](docs/WINDOWS.md) | Works on CPU out of the box; optional NVIDIA-CUDA speedup |
| 🍎 macOS | [`docs/MACOS.md`](docs/MACOS.md) | Apple Silicon uses MPS; **Intel Macs** run on CPU (`torch==2.2.2`) |
| 🐧 Linux | [`docs/LINUX.md`](docs/LINUX.md) | Works on CPU; optional NVIDIA-CUDA + systemd auto-start |

## Quickstart (any OS — CPU works)

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate · macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

Then open `http://localhost:81`.

> **NVIDIA GPU speedup (optional, Windows/Linux):** before the `pip install
> -r requirements.txt` line, run
> `pip install torch --index-url https://download.pytorch.org/whl/cu128`.
>
> **Intel Mac:** newer torch dropped Intel macOS wheels — use
> `pip install torch==2.2.2` first (see `docs/MACOS.md`).

### Clone the Kronos model repo

The server imports the Kronos codebase at runtime — clone it next to this
folder (or set `KRONOS_REPO_DIR`):

```
git clone https://github.com/shiyu-coder/Kronos
```

The model weights download from Hugging Face on the first forecast.

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
- `2_kronos_inference.py` — inference core, auto device (CUDA / MPS / CPU)
- `8_smartapi_auth.py` / `9_smartapi_fetch.py` / `10_smartapi_live.py` —
  Angel One session, history, and live ticks
- `16_market_universe.py` — NSE scrip master + symbol search

## License

**Viewing license — all rights reserved.** This project is shared for
viewing and personal evaluation only. Copying, redistribution, modification,
commercial use, and derivative works are prohibited without written
permission. See `LICENSE`.
