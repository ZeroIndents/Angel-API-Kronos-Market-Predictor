#!/usr/bin/env bash
set -euo pipefail
echo "🔮 Kronos View — Setup"
echo "======================"

# 1. Clone the Kronos model repo if missing
if [ ! -d "Kronos" ] && [ -z "${KRONOS_REPO_DIR:-}" ]; then
  echo "📦 Cloning Kronos model repo..."
  git clone --depth 1 https://github.com/shiyu-coder/Kronos.git
fi

# 2. Create venv if missing
if [ ! -d ".venv" ]; then
  echo "🐍 Creating Python venv..."
  python3 -m venv .venv
fi

source .venv/bin/activate

# 3. Install CPU-only PyTorch first (smaller download)
echo "📥 Installing PyTorch (CPU-only)..."
pip install torch --index-url https://download.pytorch.org/whl/cpu -q

# 4. Install remaining deps
echo "📥 Installing dependencies..."
pip install -r requirements.txt -q

echo ""
echo "✅ Setup complete!"
echo ""
echo "Run:  source .venv/bin/activate && python server.py"
echo "Then open: http://localhost:81"
