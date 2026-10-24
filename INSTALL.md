# Installation & Operation

The MICADAS AMS simulator is a small Python web application (FastAPI +
uvicorn). It has no database and no build step — install Python, install two
packages, start the server, open a browser.

**Requirements:** Python 3.9 or newer, ~50 MB disk space, any modern browser
(Chrome, Edge, Firefox, Safari). No GPU needed.

---

## macOS (workstation or server)

Python 3 ships with macOS / the Xcode command-line tools. Then:

```bash
# 1. Copy or clone the AMS-Simulation folder onto the machine, e.g.:
cd ~/Apps
git clone <your-repo-url> AMS-Simulation   # or just copy the folder

# 2. Start (first run creates a virtual environment and installs packages):
cd AMS-Simulation
./run.sh
```

Open **http://127.0.0.1:8550** in a browser. Stop with `Ctrl+C`.

If `./run.sh` is not executable after copying: `chmod +x run.sh`.

## Windows (workstation or server)

1. Install Python 3 from <https://www.python.org/downloads/> —
   during setup, tick **"Add python.exe to PATH"**.
   (On Windows Server you can also use `winget install Python.Python.3.12`.)
2. Copy or clone the `AMS-Simulation` folder onto the machine.
3. Double-click **`run.bat`** (or run it in a terminal — note that
   PowerShell requires the path prefix: `.\run.bat`; plain `run.bat` only
   works in `cmd`). The first run creates a virtual environment in `.venv`
   and installs the packages; afterwards the server starts immediately.

Open **http://127.0.0.1:8550** in a browser. Stop with `Ctrl+C`
(or by closing the window).

---

## Using the app with a virtual environment

The app always runs inside a Python **virtual environment** (`.venv`, a
private folder with its own Python and packages) so that nothing is installed
into the system Python. `run.sh` / `run.bat` create and use it automatically —
you normally never have to think about it. For manual control:

**Create the environment and install the dependencies (one-time):**

```bash
# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

```bat
:: Windows
py -3 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

**Run the app from the activated environment:**

```bash
uvicorn server.main:app --host 0.0.0.0 --port 8550
```

Leave the environment with `deactivate`. You can also skip activation and
call the environment's interpreter directly — this is exactly what the start
scripts do:

```bash
./.venv/bin/python -m uvicorn server.main:app --host 0.0.0.0 --port 8550   # macOS / Linux
.venv\Scripts\python -m uvicorn server.main:app --host 0.0.0.0 --port 8550 # Windows
```

Good to know:

- The `.venv` folder is disposable: delete it and the next `run.sh` /
  `run.bat` rebuilds it from `requirements.txt`. This is also the fix of
  choice for a broken environment or after a Python upgrade.
- The environment belongs to the machine it was created on — when copying
  the app to another computer, copy it **without** `.venv` and let the start
  script recreate it there.

---

## Serving the simulator to other computers (LAN)

The start scripts bind to **all interfaces by default**, so the app is
immediately reachable from other computers — e.g. a classroom or exhibition
setup: just open `http://<server-ip>:8550` from any device on the network
(find the server's IP with `ipconfig` on Windows, `ifconfig`/System Settings
on macOS; e.g. `http://192.168.123.144:8550`).

For a private, localhost-only instance instead:

```bash
./run.sh --host 127.0.0.1        # macOS / Linux
run.bat --host 127.0.0.1         # Windows
```

Notes:
- Allow inbound TCP port 8550 in the firewall
  (Windows: Defender Firewall → Inbound Rules; macOS: System Settings →
  Network → Firewall, or it will simply prompt you on first start).
- A different port: append `--port 8080` to the same commands.
- The app is stateless — any number of browsers can watch their own
  independent simulation at the same time (the physics runs client-side).

## Keeping it running unattended

- **macOS:** `nohup ./run.sh > micadas.log 2>&1 &`
  (or create a `launchd` LaunchAgent for start-at-boot).
- **Windows:** Task Scheduler → *Create Basic Task* → trigger "At startup"
  → action *Start a program* → `run.bat` (set "Start in" to the
  AMS-Simulation folder).

To stop a background instance: `pkill -f "uvicorn server.main:app"` (macOS)
or end the `python.exe` task in Task Manager (Windows).

## Updating

Replace the folder (or `git pull`) and restart the server. If
`requirements.txt` changed, delete the `.venv` folder once — the next start
recreates it with the new packages.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `python`/`py` not found (Windows) | Reinstall Python with "Add to PATH" ticked, or use the full path to `python.exe`. |
| Port 8550 already in use | Start with `--port 8080` (and open that port instead). |
| Page loads but stays empty | The browser cached an old version — hard-reload (`Ctrl+F5` / `⌘⇧R`). |
| Other computers can't connect | Firewall blocks inbound TCP port 8550, or the server was started with `--host 127.0.0.1`. |
