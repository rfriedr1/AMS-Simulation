/**
 * Beamline element classes.
 *
 * Each element owns a slice [s0, s0+length] of the reference path and knows
 *   - its geometry (straight or 90° arc, from the backend config),
 *   - how it acts on a particle (curvature mismatch, kicks, acceleration),
 *   - how to draw itself.
 *
 * Transverse motion is first-order beam optics around the reference path:
 *     x'' = k0 - k(particle)        (positive x = outward of the bends)
 * A particle whose rigidity does not match the field drifts off-axis and is
 * lost when |x| exceeds the local aperture.
 */

import {
  magneticCurvature, electricCurvature, rotM90, rotP90, rotMinus,
} from "./physics.js";

// ─────────────────────────────────────────────────────────────── base class

export class BeamElement {
  constructor(cfg) {
    Object.assign(this, {
      key: cfg.key, type: cfg.type, label: cfg.label, blurb: cfg.blurb,
      s0: cfg.s0, length: cfg.length, aperture: cfg.aperture,
      entry: cfg.entry, dir: cfg.dir, cfg,
    });
    this.isArc = false;
  }

  /** Scene position of (sLocal, xDraw) — xDraw already exaggeration-scaled. */
  point(sLocal, xDraw = 0) {
    const n = rotP90(this.dir);
    return [
      this.entry[0] + this.dir[0] * sLocal + n[0] * xDraw,
      this.entry[1] + this.dir[1] * sLocal + n[1] * xDraw,
    ];
  }

  /** Beam direction at sLocal. */
  dirAt() { return this.dir; }

  /** Reference-curvature minus particle-curvature, in 1/mm. */
  kDelta() { return 0; }

  /** Hook: energy gain / stripping / captures. Returns false if absorbed. */
  step() { return true; }

  apertureAt() { return this.aperture; }

  /** Hover hit-test polygon (scene coords). */
  outline(halfWidth) {
    const w = halfWidth ?? this.drawHalfWidth();
    const a = this.point(0, -w), b = this.point(0, w);
    const c = this.point(this.length, w), d = this.point(this.length, -w);
    return [a, b, c, d];
  }

  drawHalfWidth() { return this.aperture; } // scene mm before exaggeration
}

export class ArcElement extends BeamElement {
  constructor(cfg) {
    super(cfg);
    this.isArc = true;
    this.radius = cfg.radius;
    const off = rotM90(this.dir);
    this.center = [
      this.entry[0] + this.radius * off[0],
      this.entry[1] + this.radius * off[1],
    ];
  }

  point(sLocal, xDraw = 0) {
    const theta = sLocal / this.radius;
    const v = [this.entry[0] - this.center[0], this.entry[1] - this.center[1]];
    const r = rotMinus(v, theta);
    const scale = (this.radius + xDraw) / this.radius;
    return [this.center[0] + r[0] * scale, this.center[1] + r[1] * scale];
  }

  dirAt(sLocal) { return rotMinus(this.dir, sLocal / this.radius); }

  outline(halfWidth) {
    const w = halfWidth ?? this.drawHalfWidth();
    const pts = [];
    const N = 10;
    for (let i = 0; i <= N; i++) pts.push(this.point((i / N) * this.length, w));
    for (let i = N; i >= 0; i--) pts.push(this.point((i / N) * this.length, -w));
    return pts;
  }
}

// ─────────────────────────────────────────────────────────── concrete types

export class Drift extends BeamElement {}

export class Source extends BeamElement {
  drawHalfWidth() { return this.aperture + 14; }
}

export class Steerer extends BeamElement {
  kDelta(p, sLocal, S) {
    const volts = (S[this.cfg.controls[0]] || 0) * 1000;
    if (!volts || p.q === 0 || p.E <= 1) return 0;
    const kick = volts * this.cfg.geomFactor / (2 * p.E); // rad over full length
    return kick / this.length;                            // rad per mm
  }
}

export class Dipole extends ArcElement {
  kDelta(p, sLocal, S, sim) {
    const k0 = 1 / this.radius;
    const B = S[this.cfg.fieldKey] || 0;
    let E = p.E;
    // Bouncer: the LE-magnet chamber is biased so the injected mass follows
    // the reference orbit (sequential injection, modelled per particle).
    // Only species with a slot in the bouncer cycle (masses 12/13/14) get
    // this help — e.g. 16O- does not, and is dumped here.
    if (this.cfg.isLE && S.bouncer && p.species.bounced !== false) {
      E += S.srcKV * 1000 * (sim.refMassAmu / p.massAmu - 1) * Math.abs(p.q);
    }
    return k0 - magneticCurvature(p.massAmu, E, Math.abs(p.q), B);
  }
}

export class Slit extends BeamElement {
  apertureAt() { return this.aperture; }
  drawHalfWidth() { return 22; }
}

export class Accelerator extends BeamElement {
  step(p, sPrev, sNew, S, sim) {
    const half = this.length * this.cfg.stripperAt;
    const Vt = S.termKV * 1000;

    // Tandem principle: the anion (q = -1) is pulled towards the positive
    // terminal, gaining e·Vt over the first half...
    const segIn = Math.max(0, Math.min(sNew, half) - Math.min(sPrev, half));
    let dE = Vt * (segIn / half) * Math.abs(p.q);

    // ...is stripped to a cation (or destroyed) in the He gas at the terminal...
    if (!p.stripped && sNew >= half) sim.strip(p);

    // ...and, now positive, is pushed away again, gaining q·e·Vt once more.
    const segOut = Math.max(0, Math.max(sNew, half) - Math.max(sPrev, half));
    if (p.q > 0) dE += Vt * (segOut / (this.length - half)) * p.q;

    if (dE > 0 && p.E > 1) {
      const pOld = Math.sqrt(p.E);
      p.E += dE;
      p.xp *= pOld / Math.sqrt(p.E); // adiabatic damping
    }
    return true;
  }
  drawHalfWidth() { return this.aperture + 16; }
}

export class ESA extends ArcElement {
  kDelta(p, sLocal, S) {
    const k0 = 1 / this.radius;
    const field = 2 * (S.esaKV * 1000) / this.cfg.gapM; // V/m
    return k0 - electricCurvature(p.E, Math.abs(p.q), field);
  }
}

export class CupsRegion extends BeamElement {
  constructor(cfg) {
    super(cfg);
    // cup transverse centers (mm) are set by the calibration run at startup
    this.cups = cfg.cups.map((c) => ({ ...c, x: null, halfWidth: cfg.cupHalfWidth }));
    this.cupPlane = cfg.cupPlane;
  }
  step(p, sPrev, sNew, S, sim) {
    if (sPrev < this.cupPlane && sNew >= this.cupPlane && !sim.calibrating) {
      for (const cup of this.cups) {
        if (cup.x !== null && Math.abs(p.x - cup.x) <= cup.halfWidth) {
          sim.captureCup(p, cup);
          return false;
        }
      }
    }
    return true;
  }
  drawHalfWidth() { return this.aperture; }
}

export class Detector extends BeamElement {
  step(p, sPrev, sNew, S, sim) {
    if (sPrev <= 12 && !sim.calibrating) { sim.captureDetector(p); return false; }
    return true;
  }
  drawHalfWidth() { return this.aperture + 16; }
}

// ──────────────────────────────────────────────────────────────── factory

const TYPES = {
  source: Source, drift: Drift, steerer: Steerer, dipole: Dipole,
  slit: Slit, accelerator: Accelerator, esa: ESA, cups: CupsRegion,
  detector: Detector,
};

export function createElement(cfg) {
  const Cls = TYPES[cfg.type] || Drift;
  return new Cls(cfg);
}

/** The full reference path: orders elements, finds the element for a given s. */
export class Path {
  constructor(beamlineCfg) {
    this.elements = beamlineCfg.elements.map(createElement);
    this.totalLength = beamlineCfg.totalLength;
  }

  elementAt(s) {
    // linear scan is fine for ~20 elements
    for (const el of this.elements) {
      if (s < el.s0 + el.length) return el;
    }
    return null;
  }

  byKey(key) { return this.elements.find((e) => e.key === key); }

  /** Scene-space bounding box including chamber widths. */
  bounds(pad = 90) {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const el of this.elements) {
      for (const [x, y] of el.outline(el.drawHalfWidth() * 3 + 20)) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }
}
