# 🍎 Kronos View on macOS — Complete Guide

> Full project documentation for running **Kronos View** (the live AI chart
> terminal) on macOS — **Apple Silicon (M1–M4) and Intel Macs**. For Windows
> see [WINDOWS.md](WINDOWS.md), for Linux see [LINUX.md](LINUX.md).

---

## 1. What this project is

**Kronos View** is a self-hosted **live chart terminal** built around the
**Kronos** zero-shot financial forecasting model. It shows one chart at a
time — Nifty 50, NIFTY FUT, or Bank Nifty — streams **live ticks** from Angel
One SmartAPI, and lets the Kronos model **predict the next 30 candles** as a
dashed overlay on the chart.

> ⚠️ **Research / educational demo only — not investment advice.**
> See `LICENSE` (viewing license, all rights reserved).

### About the AI model

Kronos is an **open-source research model from a Tsinghua University team**
(Yu Shi, Zongliang Fu, et al.) — *"Kronos: A Foundation Model for the
Language of Financial Markets"*, [arXiv:2508.02739](https://arxiv.org/abs/2508.02739),
accepted at **AAAI 2026**. It is **not** an NVIDIA product and does **not**
require NVIDIA hardware.

### Feature list

| Feature | Detail |
|---|---|
| 🔮 Kronos AI forecast | Dashed predicted close path for the next 30 candles, direction call, confidence score, market-regime panel |
| 🔁 Auto-predict | Forecast re-runs automatically as live candles close |
| ⚡ Live feed | Angel One SmartWebSocketV2 ticks folded into the forming candle |
| 📊 Timeframes | 1m / 5m / 15m / 30m / 1H / 1D |
| 🗓 Range shortcuts | 1D → 5Y |
| 🎯 Candle auto-zoom | Chart follows the newest candle; ⟲ / `⌘+R` recentres |
| 🔍 Symbol search | `⌘+K` — only the 3 shipped instruments |
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

## 2. 🍎 Which Mac? Compute device auto-detection

Kronos inference runs **on every Mac** — no NVIDIA hardware needed. The
compute device auto-detects at startup:

| Mac | Device | Notes |
|---|---|---|
| **Apple Silicon (M1–M4)** | `mps` (Apple GPU) | The default torch wheel uses the Metal/MPS backend automatically — good speed, zero config |
| **Intel Mac** | `cpu` | Works out of the box; see the torch version note in Step 3 |

The status bar badges each forecast's device: `Apple`, or `CPU`.

> The models are tiny (4.1M / 24.7M params), so even CPU-only Intel Macs
> get forecasts in a second or two.

---

## 3. Project structure

```
Kronos_windows/            (repo is platform-independent — same files on macOS)
├── server.py               # FastAPI server: history REST, live WS, forecast API
├── static/
│   ├── index.html          # Single-page chart UI (bare toolbar)
│   ├── app.js              # Chart application (lightweight-charts v5.2)
│   └── styles.css          # Dark theme
├── 2_kronos_inference.py   # Inference core — Kronos-mini / Kronos-small, auto device (MPS/CPU)
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

---

## 4. Installation (macOS)

Open **Terminal** and run each block.

### Step 1 — Python

- **Apple Silicon:** `brew install python@3.11`
- **Intel Mac:** also `brew install python@3.11` (Homebrew still ships
  Intel builds on Intel Macs)

```bash
python3.11 --version
```

### Step 2 — Clone the project + the Kronos model repo

```bash
git clone https://github.com/<owner>/Kronos_windows.git
cd Kronos_windows

# Kronos model codebase is imported at runtime — clone it NEXT to this folder
git clone https://github.com/shiyu-coder/Kronos
```

### Step 3 — Create the venv & install dependencies

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
```

**Intel Macs — one extra step.** Newer torch dropped Intel (x86_64) macOS
wheels. Install the last Intel build first, then the requirements:

```bash
# Intel Mac only:
pip install torch==2.2.2

# All Macs:
pip install -r requirements.txt
```

Apple Silicon can skip the torch line — the default wheel uses MPS.

### Step 4 — Configure Angel One credentials

```bash
cp .env.example .env
nano .env
```

| Variable | Where to get it |
|---|---|
| `API_KEY` | smartapi.angelbroking.com → My Profile → **API** tab (create an app) |
| `CLIENT_ID` | Your Angel One client code (trading account user ID) |
| `PIN` | Your 4-digit trading PIN |
| `TOTP_SECRET` | Base32 secret from the Angel One TOTP in Google Authenticator *(optional — otherwise you type a 2FA code daily)* |
| `TV_PORT` / `TV_HOST` | Defaults `81` / `0.0.0.0` — fine as-is |

> 🔐 `.env`, `smartapi_config.json`, `smartapi_tokens.json` are **git-ignored**.

### Step 5 — Log in to Angel One (once per trading day)

```bash
python 8_smartapi_auth.py --login
```

Prompts for the 6-digit TOTP (or uses `TOTP_SECRET` automatically). The
in-app **Login** button does the same thing.

---

## 5. Running the terminal

```bash
source .venv/bin/activate
python server.py
```

Then open **http://localhost:81** — or `http://<YOUR-MAC-IP>:81` from any
device on the network. `Ctrl+C` stops it.

On boot the server starts a background CSV recorder and warms the model on
the active device (MPS or CPU) so the first forecast is instant.

### First forecast

1. Pick a symbol (default `Nifty 50`) and timeframe.
2. Click **🔮 Forecast** — the model draws the dashed path.
3. Toggle **Auto** to re-run on every candle close. Check the status bar for
   the device badge (`Apple` on Apple Silicon, `CPU` on Intel).

### Auto-start at login (optional)

Create `~/Library/LaunchAgents/com.kronos.view.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kronos.view</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/USER/Kronos_windows/.venv/bin/python</string>
    <string>/Users/USER/Kronos_windows/server.py</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/USER/Kronos_windows</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/kronos-view.log</string>
  <key>StandardErrorPath</key><string>/tmp/kronos-view.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.kronos.view.plist
```

(Replace `USER` with your username.)

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

## 7. Troubleshooting (macOS)

| Problem | Fix |
|---|---|
| `pip install torch==2.2.2` fails on Intel Mac | Very old macOS? torch 2.2.2 needs macOS 10.15+; if that fails, `pip install torch==2.1.2` |
| Forecast badges `CPU` on Apple Silicon | MPS wasn't detected — `pip install --upgrade torch` and ensure you're on an arm64 Python (`python3.11 -c "import platform; print(platform.machine())"` should print `arm64`) |
| `python: command not found` | `brew install python@3.11` |
| `pip: command not found` | `python3.11 -m pip --version`; fix with `python3.11 -m ensurepip` |
| Port 81 busy | Change `TV_PORT` in `.env`, restart |
| Can't reach `http://<mac-ip>:81` from another device | macOS firewall: System Settings → Network → Firewall → allow Python |
| No candles on chart | Angel session expired — click **Login** in the status bar |
| Slow first forecast | Model weights download from Hugging Face on first run — needs internet + a few minutes |

---

## 8. Security notes

- **Never commit** `.env`, `smartapi_config.json`, or `smartapi_tokens.json`
  — all three are in `.gitignore`.
- All Angel One tokens/PINs are **redacted from log output** by
  `kronos_common.py`'s secret-redaction filter.
- The project is shared under a **viewing license** — copying, modifying,
  redistributing, or commercial use is prohibited. See `LICENSE`.
