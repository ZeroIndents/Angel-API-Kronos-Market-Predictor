# 🍎 Kronos View on macOS — Complete Guide

> Full project documentation for running **Kronos View** (the live AI chart
> terminal) on macOS. For Windows see [WINDOWS.md](WINDOWS.md), for Linux
> see [LINUX.md](LINUX.md).

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
| 🔍 Symbol search | `Ctrl+K` (⌘+K on macOS) — only the 3 shipped instruments |
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

## 2. ⚠️ macOS + GPU: the one hard requirement

**Kronos inference is CUDA-GPU-only. There is deliberately no CPU fallback**
— `2_kronos_inference.py` exits at import time if CUDA is unavailable.

CUDA is **NVIDIA-only**, and Apple has not shipped NVIDIA hardware or
drivers in Macs since ~2013. **Intel/Apple Silicon Macs have AMD or Apple
GPUs, which CUDA does not run on.** A macOS machine therefore **cannot**
execute the Kronos forecast locally.

That does **not** mean you can't use Kronos View from a Mac — it means the
**server must run somewhere with an NVIDIA GPU**, and your Mac uses the web
UI as a pure client:

```
┌────────────┐   browser (any Mac)    ┌──────────────────────────────┐
│ Your Mac    │ ◄──── http://host:81 ──│ Server (NVIDIA GPU machine)  │
│  = client   │                       │  Windows / Linux / cloud VM  │
└────────────┘                       └──────────────────────────────┘
```

The web UI runs in **any modern browser** (Safari, Chrome, Edge, Firefox)
and needs nothing installed beyond the browser itself.

### Your options

| Option | Description | Doc to follow |
|---|---|---|
| **1. Run the server on a PC with an NVIDIA GPU** | Simplest. Set up on Windows/Linux (or any NVIDIA box), then open `http://<that-pc-ip>:81` from your Mac. | [WINDOWS.md](WINDOWS.md) or [LINUX.md](LINUX.md) |
| **2. Rent a cloud GPU VM** | A cloud instance with an NVIDIA GPU (e.g. any major cloud provider) — follow the Linux steps there. | [LINUX.md](LINUX.md) |
| **3. Run on the Mac, lose the forecast** | The chart/live/history endpoints work without CUDA, but the forecast module **fails at import**, so the server as shipped won't start on a Mac without a code change. This is intentionally unsupported (GPU-only is a deliberate design decision). | — |

> If you choose option 1 or 2, you can stop reading here and set up the
> server on the GPU machine using the matching guide. The rest of this page
> documents running the full stack on a Mac **that has no NVIDIA GPU** —
> i.e. what you *can* do from the Mac side.

---

## 3. What runs on the Mac

Even without a GPU, a Mac is a first-class **client**:

- ✅ Open the chart terminal in any browser
- ✅ View live ticks, history, all 6 timeframes, volume, screenshots
- ✅ Use the symbol picker (3 instruments)
- ❌ Run the Kronos forecast (needs the NVIDIA GPU server)

Everything below assumes you are hosting the **server elsewhere** (option 1
or 2) and just want to reach it — plus how to install the project on a Mac
for development/contribution purposes.

---

## 4. Project structure

```
Kronos_windows/            (repo is platform-independent — same files on macOS)
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

---

## 5. Connecting to a server from your Mac

### Find the server's address

On the machine running `server.py`, find its LAN IP:

- **Windows:** `ipconfig` → `IPv4 Address`
- **Linux:** `hostname -I` or `ip addr`
- **Cloud VM:** its public IP / DNS name

The server binds `0.0.0.0:81` by default, so it is reachable on the LAN.

### Open it on the Mac

```text
http://<SERVER-IP>:81
```

- Same network only for a LAN box — a cloud VM needs its security group /
  firewall to allow port 81.
- If the server runs on this very Mac via a remote/cloud box that forwards
  the port, `http://localhost:81` also works.

### Bookmark it as an app (optional)

1. Safari → **File → Add to Dock** (or Chrome → *Install as app*)
2. The terminal then behaves like a desktop app in its own window.

---

## 6. Installing the project on a Mac (for development / contribution)

You can check out and run everything *except* the GPU forecast on a Mac.

### Prerequisites

- **Python 3.10–3.12** — use Homebrew: `brew install python@3.11`
  (macOS system Python is too old; the Xcode CLT Python is for Apple's use)
- **Git** — `xcode-select --install` or `brew install git`

### Step 1 — Clone & venv

```bash
git clone https://github.com/<owner>/Kronos_windows.git
cd Kronos_windows
python3.11 -m venv .venv
source .venv/bin/activate
```

### Step 2 — Install dependencies

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

> **Skip the CUDA torch step on macOS** — there is no CUDA wheel for macOS
> and `pip install torch` on a Mac installs the **CPU build**, which the
> project deliberately refuses to use. (For reference: on Linux/Windows you
> must install the CUDA build *instead* — see those platform guides.)

### Step 3 — Configure credentials (for data access)

```bash
cp .env.example .env
nano .env          # fill API_KEY, CLIENT_ID, PIN, TOTP_SECRET
```

See [WINDOWS.md §4 Step 6](WINDOWS.md) for where each value comes from —
the process is identical.

### Step 4 — What you can run without a GPU

| Command | Works on Mac? | Notes |
|---|---|---|
| `python 8_smartapi_auth.py --status / --login` | ✅ | Angel One session management is pure HTTP — no GPU needed |
| `python 9_smartapi_fetch.py --days 30 --asset nifty` | ✅ | Historical candles to CSV |
| `python 16_market_universe.py --search "nifty"` | ✅ | Downloads the scrip master (~34 MB) |
| `python 10_smartapi_live.py --minutes 30` | ✅ | Live tick capture to CSV |
| `python server.py` | ❌ | Fails at import: **"Kronos inference is GPU-only and no CUDA GPU is available"** |
| `python 2_kronos_inference.py` | ❌ | Same GPU gate |

So on a Mac you can fully develop the data + UI layers, but the server as
shipped will not boot — that is by design (GPU-only). To see the full app,
point the server at an NVIDIA machine as described in §2/§5.

---

## 7. Troubleshooting (macOS)

| Problem | Fix |
|---|---|
| `Kronos inference is GPU-only...` | Expected on a Mac — run the server on an NVIDIA machine (see §2) |
| `python: command not found` | `brew install python@3.11` |
| `pip: command not found` | `python3.11 -m pip --version`; install with `python3.11 -m ensurepip` |
| Port 81 busy | Change `TV_PORT` in `.env` on the *server* machine |
| Can't reach `http://<server-ip>:81` | Same LAN? Firewall on the server allow port 81? (Windows: allow in Firewall; cloud: open the security group) |
| No candles on chart | Angel session expired — click **Login** in the status bar (server machine) |
| Slow first forecast | Model weights download from Hugging Face on first run — needs internet + a few minutes |

---

## 8. Security notes

- **Never commit** `.env`, `smartapi_config.json`, or `smartapi_tokens.json`
  — all three are in `.gitignore`.
- All Angel One tokens/PINs are **redacted from log output** by
  `kronos_common.py`'s secret-redaction filter.
- The project is shared under a **viewing license** — copying, modifying,
  redistributing, or commercial use is prohibited. See `LICENSE`.
