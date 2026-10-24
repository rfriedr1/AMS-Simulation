/**
 * Simulation engine: spawns ions at the source, transports them along the
 * reference path with first-order optics, handles stripping/fragmentation,
 * wall losses, Faraday-cup captures and detector counts.
 */

import { AMU, ANIM_V, speed, TRANSVERSE_EXAG } from "./physics.js";
import { Path } from "./elements.js";

const MAX_SUBSTEP = 6;        // mm — integration step cap
const BASE_SPAWN_RATE = 7.5;  // particles/s per unit spawn weight

let nextId = 1;

export class Particle {
  constructor(species, E0) {
    this.id = nextId++;
    this.speciesKey = species.key;
    this.species = species;
    this.massAmu = species.mass_amu;
    this.m = species.mass_amu * AMU;
    this.q = species.charge;
    this.E = E0;                       // eV (kinetic)
    this.s = 0;                        // mm along reference path
    this.x = (Math.random() - 0.5) * 2.4;   // mm transverse
    this.xp = (Math.random() - 0.5) * 0.004; // rad
    this.color = species.color;
    this.kind = species.kind;          // atomic | molecular | fragment
    this.label = species.label;
    this.stripped = false;
    this.alive = true;
    this.fate = null;                  // wall | cup | detector | exit
    this.prevDraw = null;              // last drawn scene position
  }

  vScene() { return Math.max(speed(this.massAmu, this.E) * ANIM_V, 60); }
}

export class SimulationEngine {
  constructor(config) {
    this.config = config;
    this.path = new Path(config.beamline);
    this.refMassAmu = config.bouncer.refMassAmu;
    this.species = config.species;
    this.enabled = Object.fromEntries(config.species.map((s) => [s.key, true]));

    // user settings, initialised at the design point
    this.settings = { bouncer: true };
    for (const c of config.controls) this.settings[c.key] = c.nominal;

    this.particles = [];
    this.sampleF = 1.0; // F14C of the selected sample (1 = modern)
    this.spawnAcc = Object.fromEntries(config.species.map((s) => [s.key, Math.random()]));
    this.events = [];      // transient visual events {type, pos, color, t}
    this.calibrating = false;

    this.stats = {
      cup12: 0, cup13: 0, cupCH: 0, det14: 0, background: 0, lost: 0,
      spawned14: 0, arrived14: 0,
      window: { cup12: 0, cup13: 0, cupCH: 0, det14: 0 }, // per-interval counters for rates
    };

    this.cupsRegion = this.path.byKey("cups");
    this.calibrateCups();
  }

  // ────────────────────────────────────────────────── cup calibration
  /**
   * The off-axis Faraday cups are fixed hardware: their positions are where
   * the 12C+ / 13C+ beams land at the DESIGN settings. We find those spots by
   * tracking one noiseless ghost ion per cup at nominal settings.
   */
  calibrateCups() {
    const nominal = { bouncer: true };
    for (const c of this.config.controls) nominal[c.key] = c.nominal;

    this.calibrating = true;
    for (const cup of this.cupsRegion.cups) {
      const spec = this.species.find((s) => s.key === cup.species);
      if (!spec) continue;
      const ghost = new Particle(spec, nominal.srcKV * 1000);
      ghost.x = 0; ghost.xp = 0;
      ghost.deterministic = true;
      const plane = this.cupsRegion.s0 + this.cupsRegion.cupPlane;
      let guard = 0;
      while (ghost.alive && ghost.s < plane && guard++ < 20000) {
        this.advance(ghost, MAX_SUBSTEP, nominal, true);
      }
      cup.x = ghost.alive ? ghost.x : null;
    }
    this.calibrating = false;
  }

  // ────────────────────────────────────────────────── spawning
  setSpecies(key, on) { this.enabled[key] = on; }

  /** F14C of the sample in the source: scales the 14C beam (1 = modern). */
  setSample(f14c) { this.sampleF = f14c; }

  /** Simulated capture rates at the design point — the reference used to
   *  convert stylised simulation rates into realistic machine readings. */
  nominalRates() {
    const r = {};
    for (const s of this.species) {
      const base = BASE_SPAWN_RATE * s.spawn_weight;
      r[s.key] = s.kind === "molecular"
        ? base * (1 - s.stripper.survival)
        : base * s.stripper.charged_fraction;
    }
    return { cup12: r.C12, cup13: r.C13, cupCH: r.CH13, det14modern: r.C14 };
  }

  spawn(dt) {
    for (const spec of this.species) {
      if (!this.enabled[spec.key]) continue;
      const sampleScale = spec.key === "C14" ? this.sampleF : 1;
      this.spawnAcc[spec.key] += dt * BASE_SPAWN_RATE * spec.spawn_weight * sampleScale;
      while (this.spawnAcc[spec.key] >= 1) {
        this.spawnAcc[spec.key] -= 1;
        this.particles.push(new Particle(spec, this.settings.srcKV * 1000));
        if (spec.key === "C14") this.stats.spawned14++;
      }
    }
  }

  // ────────────────────────────────────────────────── stripping
  strip(p) {
    p.stripped = true;
    const beh = p.species.stripper;

    if (!beh || beh.kind === "atomic") {
      // deterministic ghosts always take the dominant outcome (charged)
      const rnd = p.deterministic ? 0 : Math.random();
      if (rnd < (beh ? beh.charged_fraction : 1)) {
        p.q = +1;
      } else {
        // Neutralised: no field can act on it any more. Switch to ballistic
        // mode — a true straight line in the DRAWN geometry (no transverse
        // exaggeration), so the audience sees it leave the bend tangentially
        // and hit the chamber wall exactly where its straight track ends.
        p.q = 0;
        p.color = "#64748b";
        const el = this.path.elementAt(p.s);
        const sL = p.s - el.s0;
        const d = el.dirAt(sL);
        const nOut = [-d[1], d[0]];
        const slope = p.xp * TRANSVERSE_EXAG; // visual continuity with its track so far
        const len = Math.hypot(d[0] + nOut[0] * slope, d[1] + nOut[1] * slope);
        p.ballistic = true;
        p.bPos = el.point(sL, p.x * TRANSVERSE_EXAG);
        p.bDir = [(d[0] + nOut[0] * slope) / len, (d[1] + nOut[1] * slope) / len];
        p.bElIdx = this.path.elements.indexOf(el);
      }
      return;
    }

    // molecular species: ghosts always break up (the ~100 % case), so the
    // monitor cup gets calibrated onto the fragment trajectory
    if (!p.deterministic && Math.random() < beh.survival) {
      p.q = +1; // rare intact survivor — the dangerous background
      p.survivor = true;
      return;
    }

    // break-up: the carbon fragment keeps the particle slot, protons are new
    const parentMass = p.massAmu;
    const parentE = p.E;
    const frags = p.species.fragments || [];
    let first = true;
    for (const f of frags) {
      for (let i = 0; i < f.count; i++) {
        if (first) {
          first = false;
          p.massAmu = f.mass_amu;
          p.m = f.mass_amu * AMU;
          p.E = parentE * (f.mass_amu / parentMass);
          p.q = +1;
          p.color = f.color;
          p.kind = "fragment";
          p.label = f.label;
          if (!p.deterministic) p.xp += (Math.random() - 0.5) * 0.006; // Coulomb-explosion kick
        } else if (p.deterministic) {
          continue; // calibration ghosts spawn no secondary fragments
        } else {
          const ghost = new Particle(p.species, 1);
          ghost.massAmu = f.mass_amu;
          ghost.m = f.mass_amu * AMU;
          ghost.E = parentE * (f.mass_amu / parentMass);
          ghost.q = +1;
          ghost.s = p.s; ghost.x = p.x;
          ghost.xp = p.xp + (Math.random() - 0.5) * 0.01;
          ghost.stripped = true;
          ghost.color = f.color;
          ghost.kind = "fragment";
          ghost.label = f.label;
          this.particles.push(ghost);
        }
      }
    }
    this.events.push({ type: "burst", el: "acc", t: 0 });
  }

  // ────────────────────────────────────────────────── captures
  captureCup(p, cup) {
    p.alive = false; p.fate = "cup";
    this.stats[cup.key] = (this.stats[cup.key] || 0) + 1;
    this.stats.window[cup.key] = (this.stats.window[cup.key] || 0) + 1;
    this.markEvent(p, "capture", cup.key);
  }

  captureDetector(p) {
    p.alive = false; p.fate = "detector";
    if (p.speciesKey === "C14") {
      this.stats.det14++; this.stats.window.det14++; this.stats.arrived14++;
      this.markEvent(p, "count");
    } else {
      this.stats.background++;
      this.markEvent(p, "bgcount");
    }
  }

  markEvent(p, type, info) {
    const el = this.path.elementAt(Math.min(p.s, this.path.totalLength - 0.01));
    if (!el) return;
    const ap = el.apertureAt(p.s - el.s0);
    const x = Math.max(-ap - 2, Math.min(ap + 2, p.x));
    const pos = el.point(p.s - el.s0, x * TRANSVERSE_EXAG);
    this.events.push({ type, pos, color: p.color, t: 0, info });
  }

  // ────────────────────────────────────────────────── ballistic neutrals
  /** Local coordinates of a scene point relative to an element's reference
   *  path: arc → polar around the bend center, straight → axis projection. */
  ballisticLocal(el, pos) {
    if (el.isArc) {
      const vx = pos[0] - el.center[0], vy = pos[1] - el.center[1];
      const ex = el.entry[0] - el.center[0], ey = el.entry[1] - el.center[1];
      const dot = ex * vx + ey * vy, cross = ex * vy - ey * vx;
      const theta = Math.atan2(-cross, dot); // bends turn in the -theta sense
      return { sLocal: theta * el.radius, drawnX: Math.hypot(vx, vy) - el.radius };
    }
    const dx = pos[0] - el.entry[0], dy = pos[1] - el.entry[1];
    return {
      sLocal: dx * el.dir[0] + dy * el.dir[1],
      drawnX: dx * -el.dir[1] + dy * el.dir[0],
    };
  }

  /** Straight-line propagation in drawn scene space; collisions are tested
   *  against the drawn chamber walls (aperture × exaggeration). */
  advanceBallistic(p, dist) {
    let remaining = dist, guard = 0;
    while (remaining > 0.01 && p.alive && guard++ < 64) {
      const step = Math.min(remaining, MAX_SUBSTEP);
      p.bPos = [p.bPos[0] + p.bDir[0] * step, p.bPos[1] + p.bDir[1] * step];
      remaining -= step;

      let el = this.path.elements[p.bElIdx];
      let loc = this.ballisticLocal(el, p.bPos);
      while (loc.sLocal > el.length) {
        if (p.bElIdx >= this.path.elements.length - 1) {
          p.alive = false; p.fate = "exit"; return;
        }
        el = this.path.elements[++p.bElIdx];
        loc = this.ballisticLocal(el, p.bPos);
      }
      p.s = el.s0 + Math.max(0, Math.min(loc.sLocal, el.length));

      if (Math.abs(loc.drawnX) > el.apertureAt(loc.sLocal) * TRANSVERSE_EXAG) {
        p.alive = false; p.fate = "wall";
        this.stats.lost++;
        this.events.push({ type: "spark", pos: [...p.bPos], color: p.color, t: 0 });
        return;
      }
    }
  }

  // ────────────────────────────────────────────────── transport
  /** Advance one particle by ds (mm). Returns false when it stops existing. */
  advance(p, ds, S, silent = false) {
    const el = this.path.elementAt(p.s);
    if (!el) { p.alive = false; p.fate = "exit"; return false; }

    const sLocal = p.s - el.s0;
    const step = Math.min(ds, el.s0 + el.length - p.s + 0.001, MAX_SUBSTEP);

    // transverse optics
    const dk = el.kDelta(p, sLocal, S, this);
    p.xp += dk * step;
    p.x += p.xp * step;

    // element-specific physics (acceleration, stripping, captures)
    const sPrev = sLocal, sNew = sLocal + step;
    if (el.step(p, sPrev, sNew, S, this) === false) return false;

    p.s += step;

    // wall loss
    if (Math.abs(p.x) > el.apertureAt(sNew)) {
      p.alive = false; p.fate = "wall";
      if (!silent) {
        this.stats.lost++;
        this.markEvent(p, "spark");
      }
      return false;
    }
    if (p.s >= this.path.totalLength) { p.alive = false; p.fate = "exit"; return false; }
    return true;
  }

  update(dt) {
    this.spawn(dt);
    const S = this.settings;
    for (const p of this.particles) {
      if (!p.alive) continue;
      if (p.ballistic) { this.advanceBallistic(p, p.vScene() * dt); continue; }
      let remaining = p.vScene() * dt;
      let guard = 0;
      while (remaining > 0.01 && p.alive && guard++ < 64) {
        const ds = Math.min(remaining, MAX_SUBSTEP);
        if (!this.advance(p, ds, S)) break;
        remaining -= ds;
      }
    }
    // prune dead particles (renderer reads fate/events first via shared list)
    this.particles = this.particles.filter((p) => p.alive);
    // age events
    for (const ev of this.events) ev.t += dt;
    this.events = this.events.filter((ev) => ev.t < 0.9);
  }

  /** Scene position + species color of every live particle (for rendering). */
  livePositions(exag) {
    const out = [];
    for (const p of this.particles) {
      if (p.ballistic) { out.push({ p, pos: p.bPos }); continue; }
      const el = this.path.elementAt(p.s);
      if (!el) continue;
      const pos = el.point(p.s - el.s0, p.x * exag);
      out.push({ p, pos });
    }
    return out;
  }
}
