"""MICADAS AMS simulator — FastAPI app.

Serves the single-page frontend and exposes the physics model (species,
beamline geometry, nominal set-points) as JSON. Run with:

    uvicorn server.main:app --reload
"""

import base64
import logging
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .physics.beamline import build_config
from .physics.source import build_source_config

BASE_DIR = Path(__file__).resolve().parent.parent

app = FastAPI(
    title="MICADAS AMS Simulator",
    description="Particle-track simulation of a MICADAS-type accelerator "
                "mass spectrometer for radiocarbon dating.",
    version=__version__,
)


@app.on_event("startup")
async def _banner():
    log = logging.getLogger("uvicorn.error")
    log.info("=" * 56)
    log.info("  MICADAS AMS Simulator  v%s", __version__)
    log.info("  MIni CArbon DAting System - particle-track simulation")
    log.info("=" * 56)


@app.get("/api/config")
def get_config():
    """Full machine description consumed by the frontend engine."""
    return JSONResponse(build_config())


@app.get("/api/source-config")
def get_source_config():
    """Cs sputter ion-source model for the 'Ion source' view."""
    return JSONResponse(build_source_config())


@app.post("/api/snapshot")
async def save_snapshot(request: Request):
    """Save a rendered image of the simulation into docs/ (screenshots for
    the README). Only accepted from the local machine; the name is reduced
    to a safe file stem and the format to png/jpeg."""
    if request.client is None or request.client.host not in ("127.0.0.1", "::1"):
        raise HTTPException(status_code=403, detail="local requests only")
    body = await request.json()
    stem = re.sub(r"[^a-z0-9_-]", "", str(body.get("name", "snapshot")).lower()) or "snapshot"
    data_url = str(body.get("dataUrl", ""))
    m = re.match(r"^data:image/(png|jpeg);base64,(.+)$", data_url, re.S)
    if not m:
        raise HTTPException(status_code=400, detail="dataUrl must be a png/jpeg data URL")
    ext = "jpg" if m.group(1) == "jpeg" else "png"
    out_dir = BASE_DIR / "docs"
    out_dir.mkdir(exist_ok=True)
    path = out_dir / f"{stem}.{ext}"
    path.write_bytes(base64.b64decode(m.group(2)))
    return {"saved": str(path.relative_to(BASE_DIR)), "bytes": path.stat().st_size}


app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")
