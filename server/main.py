"""MICADAS AMS simulator — FastAPI app.

Serves the single-page frontend and exposes the physics model (species,
beamline geometry, nominal set-points) as JSON. Run with:

    uvicorn server.main:app --reload
"""

import logging
from pathlib import Path

from fastapi import FastAPI
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


app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")
