#!/usr/bin/env bash
# Start the MICADAS AMS simulator.
set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
  ./.venv/bin/pip install --quiet --upgrade pip
  ./.venv/bin/pip install --quiet -r requirements.txt
fi

# Binds to all interfaces so the app is reachable from other computers on
# the network via http://<this-machine's-ip>:8550. For a localhost-only
# instance, start with:  ./run.sh --host 127.0.0.1
echo "MICADAS simulator → http://<this-machine's-ip>:8550 (or http://127.0.0.1:8550 locally)"
exec ./.venv/bin/python -m uvicorn server.main:app --host 0.0.0.0 --port 8550 --log-config server/log_config.json "$@"
