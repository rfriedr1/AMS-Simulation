@echo off
REM Start the MICADAS AMS simulator (Windows).
cd /d "%~dp0"

if not exist .venv (
  echo Creating virtual environment...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if errorlevel 1 (
    echo ERROR: Python 3 not found. Install it from https://www.python.org/downloads/
    echo        and tick "Add python.exe to PATH" during setup.
    pause
    exit /b 1
  )
  .venv\Scripts\python -m pip install --quiet --upgrade pip
  .venv\Scripts\pip install --quiet -r requirements.txt
)

REM Binds to all interfaces so the app is reachable from other computers on
REM the network via http://<this-machine's-ip>:8550. For localhost only,
REM start with:  run.bat --host 127.0.0.1
echo MICADAS simulator: http://^<this-machine's-ip^>:8550  (Ctrl+C to stop)
.venv\Scripts\python -m uvicorn server.main:app --host 0.0.0.0 --port 8550 --log-config server\log_config.json %*
