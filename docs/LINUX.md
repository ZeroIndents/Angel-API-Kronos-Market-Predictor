# 🐧 Kronos View on Linux — Complete Guide

> Full project documentation for running **Kronos View** (the live AI chart
> terminal) on Linux. For Windows see [WINDOWS.md](WINDOWS.md), for macOS
> see [MACOS.md](MACOS.md).

---

## 1. What this project is

**Kronos View** is a self-hosted **live chart terminal** built around
NVIDIA's **Kronos** zero-shot financial forecasting model. It shows one chart
at a time — Nifty 50, NIFTY FUT, or Bank Nifty — streams **live ticks** from
Angel One SmartAPI, and lets the Kronos model **predict the next 30 candles**
as a dashed overlay on the chart.

> ⚠️ **Research / educational demo only — not investment advice.**
> See `LICENSE` (viewing license, all rights reserved).

### Feature list

| Feature | Detail |
|---|---|
| 🔮 Kronos AI forecast | Dashed predicted close path for the next 30 candles, direction call, confidence score, market-regime panel |
| 🔁 Auto-predict | Forecast re-runs automatically as live candles close |
| ⚡ Live feed | Angel One SmartWebSocketV2 ticks folded into the forming candle |
| 📊 Timeframes | 1m / 5m / 15m / 30m / 1H / 1D |
| 🗓 Range shortcuts | 1D → 5Y |
| 🎯 Candle auto-zoom | Chart follows the newest candle; ⟲ / `Alt+R` recentres |
| 🔍 Symbol search | `Ctrl+K` — only the 3 shipped instruments |
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
| **NVIDIA GPU with CUDA** | Kronos inference is **GPU-only** — deliberately no CPU fallback. Any CUDA-capable GPU works (models are tiny: 4.1M / 24.7M params). |
| **NVIDIA driver** | Supports CUDA 12.8. Verify with `nvidia-smi`. |
| **Python 3.10 – 3.12 (64-bit)** | Debian/Ubuntu: `python3.11` etc. via apt. Developed on Python 3.10. |
| **~2 GB free disk** | venv + PyTorch CUDA wheels (~2.5 GB with torch) |
| **Internet** | First run: Angel scrip master (~34 MB) + Kronos model weights from Hugging Face |

### Optional

| Item | Why |
|---|---|
| `systemd` | Auto-start the server at boot (guide below) — present on virtually all distros |
| `tmux` / `screen` | Run the server in the background without systemd |

---

## 3. Project structure

```
Kronos_windows/
├── server.py               # FastAPI server: history REST, live WS, forecast API
├── static/
│   ├── index.html          # Single-page chart UI (bare toolbar)
│   ├── app.js              # Chart application (lightweight-charts v5.2)
│   └── styles.css          # Dark theme
├── 2_kronos_inference.py   # GPU inference core — Kronos-mini / Kronos-small ONLY
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

### Data flow at a glance

1. **History** — `/api/history` fetches OHLCV candles from Angel One REST
   (falls back to cached local CSVs when the session is down).
2. **Live** — one shared `SmartWebSocketV2` connection streams ticks to the
   browser over the server's own `/ws`; the UI folds them into the forming
   candle.
3. **Forecast** — `/api/kronos/forecast` runs the GPU Kronos model on the
   current candles and returns a predicted path the UI draws as a dashed
   line.

---

## 4. Installation (Linux)

Tested on **Ubuntu 22.04/24.04**; the steps translate to Debian, Fedora,
Arch and most others with their package names.

### Step 1 — System packages

```bash
sudo apt update
sudo apt install -y python3.11 python3.11-venv python3-pip git curl
```

> If `python3.11` isn't available, use `python3` (check the version:
> `python3 --version` — must be 3.10–3.12). The project was developed on
> Python 3.10.

### Step 2 — NVIDIA driver + CUDA

Kronos ships as a **CUDA PyTorch wheel** (`cu128`), so you do **not** need
the full CUDA toolkit — you need a driver that supports CUDA 12.8.

```bash
# Check for an existing NVIDIA GPU + driver
nvidia-smi
```

If `nvidia-smi` is missing, install the driver. On Ubuntu:

```bash
# Option A: auto-install the recommended driver
sudo ubuntu-drivers autoinstall
sudo reboot

# Option B: pick a specific driver explicitly
sudo apt install -y nvidia-driver-550   # adjust version to a CUDA-12.8-capable one
sudo reboot
```

After reboot verify:

```bash
nvidia-smi
```

You should see the GPU model and a CUDA version row (≥ 12.x).

### Step 3 — Clone the project + the Kronos model repo

```bash
git clone https://github.com/<owner>/Kronos_windows.git
cd Kronos_windows

# Kronos model codebase is imported at runtime — clone it NEXT to this folder
git clone https://github.com/shiyu-coder/Kronos
```

### Step 4 — Create the venv & install dependencies

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
```

**Important:** install the **CUDA build** of PyTorch first — a plain
`pip install torch` on Linux pulls the CPU-only wheel and Kronos will fail
at startup:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install -r requirements.txt
```

> `cu128` = CUDA 12.8. Older driver? Pick the matching index URL
> (`cu121`, `cu124`, ...) from [pytorch.org/get-started](https://pytorch.org/get-started/locally/).

### Step 5 — Verify the GPU works

```bash
python -c "import torch; print('CUDA available:', torch.cuda.is_available())"
```

Must print `CUDA available: True`. If `False`: driver too old/missing —
back to Step 2.

### Step 6 — Configure Angel One credentials

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

### Step 7 — Log in to Angel One (once per trading day)

```bash
python 8_smartapi_auth.py --login
```

Prompts for the 6-digit TOTP (or uses `TOTP_SECRET` automatically). The
in-app **Login** button does the same thing.

---

## 5. Running the terminal

### Foreground (testing)

```bash
source .venv/bin/activate
python server.py
```

Then open **http://localhost:81** — or `http://<SERVER-IP>:81` from any
device on the network. `Ctrl+C` stops it.

On boot the server starts a background CSV recorder and warms the GPU
(preloads the model + runs one tiny forecast) so the first real click is
instant.

### Background (no systemd)

```bash
tmux new -s kronos -d '.venv/bin/python server.py'
# reattach: tmux attach -t kronos
```

### Auto-start with systemd (recommended)

Create a user service:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/kronos-view.service <<'EOF'
[Unit]
Description=Kronos View - live chart terminal + Kronos AI overlay (FastAPI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/USER/Kronos_windows
ExecStart=/home/USER/Kronos_windows/.venv/bin/python /home/USER/Kronos_windows/server.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
# First start may download model weights + warm the CUDA context; give it room.
TimeoutStartSec=300
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF
```

Replace `USER` with your actual username, then enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now kronos-view.service
systemctl --user status kronos-view.service
```

To allow it to start at boot *before login* (headless box), enable lingering:

```bash
sudo loginctl enable-linger $USER
```

Useful commands:

```bash
systemctl --user status kronos-view        # status + recent logs
journalctl --user -u kronos-view -f        # follow live logs
systemctl --user restart kronos-view       # restart after config change
```

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
| `GET /api/auth/status` | Login status + market clock |
| `POST /api/auth/login` | Daily TOTP login |
| `POST /api/kronos/forecast` | Run the GPU forecast on current candles |
| `WS /ws?symbol=...` | Live tick stream |

---

## 7. Troubleshooting (Linux)

| Problem | Fix |
|---|---|
| `CUDA available: False` | Driver too old/missing — redo Step 2 and `sudo reboot` |
| `Kronos inference is GPU-only...` at startup | CPU torch wheel installed — redo the `pip install torch --index-url .../cu128` step |
| `Could not import torch` | Same CUDA-wheel install command |
| Port 81 busy | Change `TV_PORT` in `.env`, restart |
| Forecast does nothing | Model weights still downloading on first run (internet + a few minutes) |
| No candles on chart | Angel session expired — click **Login** in the status bar |
| systemd service crashes instantly | `journalctl --user -u kronos-view -n 50` to see why; usually a path/username typo in the service file |
| Firewall blocks LAN access | `sudo ufw allow 81/tcp` |
| GPU not visible in container | `docker run --gpus all` / pass the GPU through explicitly |

---

## 8. Security notes

- **Never commit** `.env`, `smartapi_config.json`, or `smartapi_tokens.json`
  — all three are in `.gitignore`.
- All Angel One tokens/PINs are **redacted from log output** by
  `kronos_common.py`'s secret-redaction filter.
- The project is shared under a **viewing license** — copying, modifying,
  redistributing, or commercial use is prohibited. See `LICENSE`.
