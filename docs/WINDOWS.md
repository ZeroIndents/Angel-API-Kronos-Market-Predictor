# 🪟 Kronos View on Windows — Complete Guide

> Full project documentation for running **Kronos View** (the live AI chart
> terminal) on Windows 10 / 11. For macOS see [MACOS.md](MACOS.md), for
> Linux see [LINUX.md](LINUX.md).

---

## 1. What this project is

**Kronos View** is a self-hosted **live chart terminal** built around the
**Kronos** zero-shot financial forecasting model. It shows you one chart at a
time — Nifty 50, NIFTY FUT, or Bank Nifty — streams **live ticks** from Angel
One SmartAPI, and lets the Kronos model **predict the next 30 candles** as a
dashed overlay on the chart.

It is deliberately **bare**: no drawing tools, no indicator library, no
multi-pane layouts, no alerts, no news panel. One chart, live data, AI
forecast. Nothing else.

> ⚠️ **Research / educational demo only — not investment advice.**
> See `LICENSE` (viewing license, all rights reserved).

### About the AI model

Kronos is an **open-source research model from a Tsinghua University team**
(Yu Shi, Zongliang Fu, et al.) — *"Kronos: A Foundation Model for the
Language of Financial Markets"*, [arXiv:2508.02739](https://arxiv.org/abs/2508.02739),
accepted at **AAAI 2026**. It is **not** an NVIDIA product. NVIDIA's only
connection is that the authors trained on RTX 4090D GPUs.

### Feature list

| Feature | Detail |
|---|---|
| 🔮 Kronos AI forecast | Dashed predicted close path for the next 30 candles, direction call, confidence score, market-regime panel |
| 🔁 Auto-predict | Forecast re-runs automatically as live candles close |
| ⚡ Live feed | Angel One SmartWebSocketV2 ticks folded into the forming candle |
| 📊 Timeframes | 1m / 5m / 15m / 30m / 1H / 1D |
| 🗓 Range shortcuts | 1D → 5Y |
| 🎯 Candle auto-zoom | Chart follows the newest candle; ⟲ / `Alt+R` recentres |
| 🔍 Symbol search | `Ctrl+K` — but only the 3 shipped instruments are reachable |
| 📸 Screenshot / ⛶ Fullscreen | PNG export, fullscreen mode |
| 📈 Volume toggle | Candles + volume, or candles only |

### The three instruments

The public build ships with **exactly three** chartable instruments,
hard-limited at every layer (UI, search API, history API, live feed):

| Display label | What it resolves to |
|---|---|
| `Nifty 50` | NSE index `NIFTY` (token 99926000) |
| `NIFTY FUT` | Near-month NFO index future (rolls automatically at expiry) |
| `Bank Nifty` | NSE index `BANKNIFTY` (token 99926009) |

Typing anything else (e.g. `TCS`, `RELIANCE`) returns no results, and the
server refuses to resolve any other symbol even via hand-crafted API calls.

---

## 2. Hardware & software requirements

### Mandatory

| Requirement | Notes |
|---|---|
| **Python 3.10 – 3.12 (64-bit)** | Install from [python.org](https://www.python.org/downloads/) — **tick "Add python.exe to PATH"** during install. The project was developed on Python 3.10. |
| **~2 GB free disk** | venv + PyTorch wheels |
| **Internet** | First run: downloads the Angel One scrip master (~34 MB) and the Kronos model weights from Hugging Face |

### Optional

| Item | Why |
|---|---|
| **NVIDIA GPU + driver** | Optional **speedup** — the forecast runs fine on CPU too. If you have one, install the CUDA torch wheel (Step 3B). The models are tiny (4.1M / 24.7M params), so CPU forecasts are quick. |
| `git` | Only needed to clone the Kronos model repo |
| Visual Studio Build Tools | Only if a dependency needs compiling (rare with the wheels below) |

---

## 3. Project structure

```
Kronos_windows/
├── server.py               # FastAPI server: history REST, live WS, forecast API
├── static/
│   ├── index.html          # Single-page chart UI (bare toolbar)
│   ├── app.js              # Chart application (lightweight-charts v5.2)
│   └── styles.css          # Dark theme
├── 2_kronos_inference.py   # Inference core — Kronos-mini / Kronos-small, auto device (CUDA/CPU)
├── 8_smartapi_auth.py      # Angel One session manager (daily TOTP 2FA login)
├── 9_smartapi_fetch.py     # Angel One REST history fetcher
├── 10_smartapi_live.py     # Live tick → 5m candle aggregator
├── 16_market_universe.py   # NSE scrip master download + 3-symbol search
├── kronos_common.py        # Shared helpers (module loader, secret redaction)
├── requirements.txt        # Python dependencies
├── .env.example            # Credentials template → copy to .env
├── LICENSE                 # Viewing license — all rights reserved
└── README.md               # Quick overview
```

### How the pieces fit together

```
                ┌──────────────────────────────────────────────┐
                │                 Browser (static/)              │
                │   lightweight-charts v5.2 · one chart pane    │
                └──────────────┬───────────────────────────────┘
                               │ REST / WebSocket
                ┌──────────────▼───────────────────────────────┐
                │                 server.py (FastAPI)            │
                │  /api/history · /ws · /api/kronos/forecast    │
                └──────┬──────────────┬──────────────┬──────────┘
                       │              │              │
              ┌────────▼───┐  ┌───────▼──────┐  ┌────▼────────────┐
              │ 9_smartapi │  │ 10_smartapi  │  │ 2_kronos_infer  │
              │ _fetch.py  │  │ _live.py     │  │ ence.py         │
              │ (history)  │  │ (live ticks) │  │ (CPU or CUDA)   │
              └──────┬─────┘  └──────┬───────┘  └────┬────────────┘
                     │               │               │
              ┌──────▼───────────────▼──────┐  ┌────▼────────────┐
              │       Angel One SmartAPI     │  │ Kronos model    │
              │  (REST + SmartWebSocketV2)   │  │ repo + HF weights│
              └──────────────────────────────┘  └─────────────────┘
```

Data flow:

1. **History** — `/api/history` fetches OHLCV candles from Angel One REST.
   If the session is down it falls back to any cached local CSVs.
2. **Live** — the server keeps **one shared** SmartWebSocketV2 connection
   and forwards every tick to the browser over its own `/ws`, where the UI
   folds it into the forming candle.
3. **Forecast** — `/api/kronos/forecast` runs the Kronos model (CUDA GPU if
   detected, otherwise CPU) on the current candles and returns a predicted
   path the UI draws as a dashed line.

---

## 4. Installation (Windows)

Open **PowerShell** (or Windows Terminal) and run each block.

### Step 1 — Python

1. Download Python **3.10–3.12 (64-bit)** from [python.org](https://www.python.org/downloads/).
2. In the installer, **check the box "Add python.exe to PATH"**.
3. Verify:

```powershell
python --version
```

### Step 2 — Create the virtual environment

```powershell
cd path\to\Kronos_windows
py -m venv .venv
```

### Step 3 — Install dependencies

The device auto-detects (CUDA GPU → CPU), so **option A works on every
machine** — even without an NVIDIA GPU.

```powershell
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

#### Step 3B (optional) — NVIDIA GPU speedup

Only if you have an NVIDIA GPU and want faster forecasts: install the CUDA
build of torch **before** the requirements line:

```powershell
.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

> `cu128` = CUDA 12.8. If your driver is older, pick the matching index URL
> (e.g. `cu121`, `cu124`) from [pytorch.org/get-started](https://pytorch.org/get-started/locally/).

### Step 4 — Verify (optional, GPU machines)

```powershell
.venv\Scripts\python.exe -c "import torch; print('CUDA available:', torch.cuda.is_available())"
```

`True` → the server will badge forecasts `⚡GPU`. `False` → no problem, it
runs on CPU and badges them `CPU`.

### Step 5 — Clone the Kronos model repo

The server imports the Kronos codebase at runtime. Clone it **next to this
folder** (or set `KRONOS_REPO_DIR` to point at your clone):

```powershell
git clone https://github.com/shiyu-coder/Kronos
```

The model weights (`NeoQuasar/Kronos-mini`, `NeoQuasar/Kronos-small`)
download automatically from Hugging Face on the first forecast.

### Step 6 — Configure Angel One credentials

Copy the template and open it in a text editor:

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in:

| Variable | Where to get it |
|---|---|
| `API_KEY` | smartapi.angelbroking.com → My Profile → **API** tab (create an app) |
| `CLIENT_ID` | Your Angel One client code (trading account user ID) |
| `PIN` | Your 4-digit trading PIN |
| `TOTP_SECRET` | Base32 secret from the Angel One TOTP in Google Authenticator *(optional — without it you type a 2FA code daily)* |
| `TV_PORT` / `TV_HOST` | Defaults `81` / `0.0.0.0` — fine as-is |

> 🔐 `.env` and the generated `smartapi_config.json` / `smartapi_tokens.json`
> are **git-ignored** and never committed.

### Step 7 — Log in to Angel One (once per trading day)

```powershell
.venv\Scripts\python.exe 8_smartapi_auth.py --login
```

It will prompt for the 6-digit TOTP (or use `TOTP_SECRET` automatically).
Sessions expire daily — the in-app **Login** button in the status bar does
the same thing.

---

## 5. Running the terminal

```powershell
.venv\Scripts\python.exe server.py
```

Then open **http://localhost:81** in your browser.

- Other devices on your network: `http://<YOUR-PC-IP>:81`
- `Ctrl+C` stops the server.
- On boot the server starts a background CSV recorder and warms the model
  (preloads it + one tiny forecast) so your first click is instant. The
  status bar shows the device: `⚡GPU`, or `CPU`.

### First forecast

1. Pick a symbol (default `Nifty 50`) and timeframe.
2. Click **🔮 Forecast** in the toolbar — the model draws the dashed path.
3. Toggle **Auto** to re-run the forecast automatically on every candle close.

---

## 6. Using the API directly

All endpoints are on `http://localhost:81`:

| Method / path | Purpose |
|---|---|
| `GET /` | Chart UI |
| `GET /api/symbols` | The 3 allowed instruments |
| `GET /api/search?q=...` | Search — returns only the 3 instruments |
| `GET /api/ltp?symbol=...` | Last traded price |
| `GET /api/history?symbol=...&interval=...&days=...` | OHLCV candles |
| `GET /api/auth/status` | Login status + market clock + compute device |
| `POST /api/auth/login` | Daily TOTP login |
| `POST /api/kronos/forecast` | Run the forecast on current candles |
| `WS /ws?symbol=...` | Live tick stream |

---

## 7. Troubleshooting (Windows)

| Problem | Fix |
|---|---|
| `Could not import torch` | `pip install torch` (plain, CPU) — or the CUDA build in Step 3B |
| Forecast is slower than expected | That's CPU inference — optional CUDA wheel (Step 3B) makes it ~2–5× faster |
| `CUDA available: False` but you have a GPU | Update NVIDIA driver, reboot, redo Step 3B |
| Port 81 busy | Change `TV_PORT` in `.env`, restart |
| Forecast button does nothing | Check the console: model weights may still be downloading on first run (needs internet + a few minutes) |
| No candles on chart | Angel session expired — press **Login** in the status bar (or run Step 7) |
| `python` not found | Reinstall Python and tick **"Add python.exe to PATH"** |
| Firewall prompt | Allow Python through the firewall so LAN devices can reach `:81` |

### Run at login (optional)

Create `start-kronos.bat`:

```bat
@echo off
cd /d "%~dp0"
.venv\Scripts\python.exe server.py
```

Put a shortcut to it in `shell:startup`, or schedule it with **Task
Scheduler** (trigger: *At log on*).

---

## 8. Security notes

- **Never commit** `.env`, `smartapi_config.json`, or `smartapi_tokens.json`
  — all three are in `.gitignore`.
- All Angel One tokens/PINs are **redacted from log output** by
  `kronos_common.py`'s secret-redaction filter.
- The project is shared under a **viewing license** — copying, modifying,
  redistributing, or commercial use is prohibited. See `LICENSE`.
