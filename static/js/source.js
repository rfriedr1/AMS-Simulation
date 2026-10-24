/**
 * "Ion source" view: a self-contained 2D cutaway simulation of the MICADAS
 * caesium sputter source, following the CEZA explainer (potentials as run on
 * the CEZA MICADAS; C- beam shaped after the ray trace in that drawing).
 *
 * Scene (units = mm, y = 0 on the beam axis, x grows towards the beamline):
 *
 *   cathode ─ lens plate ─[Cs gap 10 kV]─ ionizer(hole) ─ channel ─ extractor
 *   ─[extraction gap 30 kV]─ ground electrode ─ steerer ─ box lens ─ object pt.
 *
 * Zone physics (stylised, not a field solve):
 *   - Cs vapour sprayed from the ring nozzle onto the hot ionizer -> Cs+,
 *     which falls through U_cath radially onto the sample spot
 *   - impacts sputter a material-dependent cocktail; anions leave at a few
 *     eV in all directions, are turned forward in the pocket, focused by
 *     the lens aperture (crossover just past the plate), accelerated
 *     radially to U_cath at the ionizer hole, drift through the field-free
 *     channel, get a focus trim at the extractor, gain U_ion in the
 *     extraction gap, a slight divergence at the ground electrode, are aimed
 *     by the steerer and focused by the box lens onto the object point
 *   - co-extracted electrons are thrown out by the suppressor magnets
 */

import { ANIM_V, speed } from "./physics.js";

// ── geometry (scene mm) ────────────────────────────────────────────────────
const G = {
  bounds: { x0: -30, x1: 375, y0: -112, y1: 112 },
  target: [26, 0],          // sample spot on the cathode face
  spotR: 5.5,
  cathode: { x0: 6, x1: 26, half: 26 },
  plate: { x0: 29, x1: 33, ap: 7 },          // immersion lens plate + aperture
  R: 65,                    // ionizer shell radius around the target spot
  holeDeg: 10,              // half-angle of the hole on the axis (±11 mm)
  spanDeg: 44,              // outer half-angle of the ionizer cap
  channelHalf: 14,          // field-free channel behind the ionizer hole
  oven: { x0: 76, x1: 112, y0: 60, y1: 92 },
  nozzleDist: 47,           // ring nozzle: distance from the target spot...
  nozzleAng: 28,            // ...and angle off-axis of its two cross-sections
  extr: { x: 128, w: 5, ap: 10 },            // extractor aperture electrode
  magnetX: 140,             // suppressor magnets (electron removal)
  gnd: { x: 173, w: 5, ap: 10 },             // ground electrode
  steer: { x0: 190, x1: 206, gap: 12 },      // steerer plates
  box: { x: [225, 245, 265], w: [6, 10, 6], ap: 10, half: 34 },  // einzel
  objX: 330, objAp: 4,      // object point of the LE magnet
  wallY: 58,
};

const DEG = Math.PI / 180;
const CS_SPAWN_NOM = 22;          // Cs atoms per second at nominal oven temp

export class SourceView {
  constructor(config, els, shared) {
    this.cfg = config;
    this.shared = shared;                    // { speed(), paused() }
    this.material = config.materials[0];
    this.settings = {};
    for (const c of config.controls) this.settings[c.key] = c.nominal;

    this.particles = [];
    this.events = [];
    this.acc = { cs: Math.random() };
    this.stats = { cs: 0, out: { C: 0, CH: 0, CH2: 0, O: 0 }, lost: 0,
                   window: { cs: 0, C: 0, O: 0 } };
    this.rates = { cs: 0, C: 0, O: 0 };

    this.cv = els;                            // {static, trails, sprites, stage}
    this.xS = els.static.getContext("2d");
    this.xT = els.trails.getContext("2d");
    this.xP = els.sprites.getContext("2d");
    this.hover = null;

    // immersion lens (target shield) — default ON; toggling it shows how the
    // beam formation right at the cathode decides the whole extraction
    const lensToggle = document.getElementById("lensToggle");
    this.lensOn = lensToggle ? lensToggle.checked : true;
    if (lensToggle) lensToggle.addEventListener("change", () => {
      this.lensOn = lensToggle.checked;
      this.drawStatic();
    });
    this.lensToggle = lensToggle;

    // electric-field overlay (equipotential lines), on by default
    const fieldToggle = document.getElementById("fieldToggle");
    this.fieldOn = fieldToggle ? fieldToggle.checked : true;
    if (fieldToggle) fieldToggle.addEventListener("change", () => {
      this.fieldOn = fieldToggle.checked;
      this.drawStatic();
    });

    this.resize();
    this.buildControls(els.slidersHost);
    this.buildMaterialToggle(els.materialHost);
    this.wireHover();
    this.startMeasurementLoop(els);
  }

  // ── coordinate transform ─────────────────────────────────────────────
  resize() {
    const stage = this.cv.stage;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = stage.clientWidth; this.h = stage.clientHeight;
    if (!this.w || !this.h) return;
    for (const cv of [this.cv.static, this.cv.trails, this.cv.sprites]) {
      cv.width = Math.round(this.w * dpr);
      cv.height = Math.round(this.h * dpr);
      cv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const sx = this.w / (G.bounds.x1 - G.bounds.x0);
    const sy = this.h / (G.bounds.y1 - G.bounds.y0);
    this.scale = Math.min(sx, sy);
    this.ox = (this.w - (G.bounds.x1 - G.bounds.x0) * this.scale) / 2 - G.bounds.x0 * this.scale;
    this.oy = (this.h - (G.bounds.y1 - G.bounds.y0) * this.scale) / 2 - G.bounds.y0 * this.scale;
    this.drawStatic();
    this.xT.clearRect(0, 0, this.w, this.h);
    for (const p of this.particles) p.prev = null;
  }

  s2c(x, y) { return [x * this.scale + this.ox, y * this.scale + this.oy]; }
  px(mm) { return mm * this.scale; }

  // ── controls (same look & behaviour as the beamline sliders) ────────
  buildControls(host) {
    host.innerHTML = "";
    this.sliderEls = {};
    const groups = {};
    for (const c of this.cfg.controls) {
      if (!groups[c.group]) {
        const g = document.createElement("div");
        g.className = "ctl-group";
        g.innerHTML = `<div class="group-title">${c.group}</div>`;
        host.appendChild(g);
        groups[c.group] = g;
      }
      groups[c.group].appendChild(this.makeSlider(c));
    }
  }

  makeSlider(c) {
    const row = document.createElement("div");
    row.className = "slider-row";
    row.innerHTML = `
      <div class="slider-top">
        <span class="slider-name" title="${c.hint}">${c.label}</span>
        <span class="slider-val"></span>
      </div>
      <div class="slider-line">
        <button class="step-btn" data-dir="down" title="−${c.step} ${c.unit} (hold to repeat)">‹</button>
        <div class="slider-track-wrap">
          <span class="nominal-tick" style="left:${((c.nominal - c.min) / (c.max - c.min)) * 100}%"></span>
          <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.nominal}">
        </div>
        <button class="step-btn" data-dir="up" title="+${c.step} ${c.unit} (hold to repeat)">›</button>
      </div>`;
    const input = row.querySelector("input");
    const val = row.querySelector(".slider-val");
    const refresh = () => {
      const v = parseFloat(input.value);
      this.settings[c.key] = v;
      const dec = c.step < 0.01 ? 3 : c.step < 1 ? 1 : 0;
      val.textContent = `${v.toFixed(dec)} ${c.unit}`;
      val.classList.toggle("off", Math.abs(v - c.nominal) > (c.max - c.min) * 0.004);
      input.style.setProperty("--fill", `${((v - c.min) / (c.max - c.min)) * 100}%`);
      // the field overlay depends on the potentials — redraw (rAF-debounced)
      if (this.fieldOn && !this._redrawPending) {
        this._redrawPending = true;
        requestAnimationFrame(() => { this._redrawPending = false; this.drawStatic(); });
      }
    };
    input.addEventListener("input", refresh);
    const reset = () => { input.value = c.nominal; refresh(); };
    input.title = val.title = "Double-click to reset to design value";
    input.addEventListener("dblclick", reset);
    val.style.cursor = "pointer";
    val.addEventListener("dblclick", reset);
    for (const btn of row.querySelectorAll(".step-btn")) {
      const stepOnce = () => { btn.dataset.dir === "up" ? input.stepUp() : input.stepDown(); refresh(); };
      let delay = null, repeat = null;
      const stop = () => { clearTimeout(delay); clearInterval(repeat); };
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault(); stepOnce();
        delay = setTimeout(() => { repeat = setInterval(stepOnce, 60); }, 400);
      });
      for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, stop);
    }
    refresh();
    this.sliderEls[c.key] = { input, refresh, nominal: c.nominal };
    return row;
  }

  tuneToOptimum() {
    for (const s of Object.values(this.sliderEls)) { s.input.value = s.nominal; s.refresh(); }
    if (this.lensToggle && !this.lensToggle.checked) {
      this.lensToggle.checked = true;
      this.lensOn = true;
      this.drawStatic();
    }
  }

  buildMaterialToggle(host) {
    host.innerHTML = "";
    for (const m of this.cfg.materials) {
      const b = document.createElement("button");
      b.textContent = m.label;
      b.title = m.blurb;
      b.classList.toggle("active", m.key === this.material.key);
      b.addEventListener("click", () => {
        this.material = m;
        for (const x of host.children) x.classList.toggle("active", x === b);
      });
      host.appendChild(b);
    }
  }

  // ── spawning & physics ───────────────────────────────────────────────
  spawnCs(dt) {
    // Cs oven runs at its fixed operating point (not user-adjustable).
    // The vapour is sprayed from the ring nozzle in front of the ionizer
    // straight onto the hot cap, so nearly all of it gets ionized.
    this.acc.cs += dt * CS_SPAWN_NOM;
    const [tx, ty] = G.target;
    while (this.acc.cs >= 1) {
      this.acc.cs -= 1;
      const sgn = Math.random() < 0.5 ? 1 : -1;
      const na = G.nozzleAng * DEG;
      const nx = tx + G.nozzleDist * Math.cos(na);
      const ny = ty + sgn * G.nozzleDist * Math.sin(na);
      const ta = (14 + Math.random() * 26) * DEG;   // aim at the ionizer band
      const gx = tx + G.R * Math.cos(ta) - nx;
      const gy = ty + sgn * G.R * Math.sin(ta) - ny;
      const len = Math.hypot(gx, gy) || 1;
      const v = 11 + Math.random() * 8;
      this.particles.push({
        type: "cs0", color: "rgba(253,230,138,0.8)",
        x: nx + (Math.random() - 0.5) * 2, y: ny + (Math.random() - 0.5) * 2,
        vx: (gx / len) * v, vy: (gy / len) * v, prev: null, r: 1.4,
      });
    }
  }

  ionizeProb() { return 0.92; }   // ionizer at its ~1000 °C operating point

  sputter(x, y) {
    this.stats.cs++; this.stats.window.cs++;
    this.events.push({ type: "spark", x, y, color: "#fde68a", t: 0, big: true });
    const yieldFac = Math.max(0, (this.settings.cathodeKV - 2) / 8);
    const n = this.material.burst * yieldFac;
    const count = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    const v0 = Math.max(speed(12, 5) * ANIM_V, 3.5);    // ~5 eV sputter energy
    for (let i = 0; i < count; i++) {
      const pick = Math.random();
      let acc = 0, item = this.material.mix[0];
      for (const m of this.material.mix) { acc += m.p; if (pick <= acc) { item = m; break; } }
      // the sputter plume is intrinsically wide (all forward directions)
      const ang = (Math.random() * 2 - 1) * 80 * DEG;
      const neutral = item.kind === "neutral";
      const sp = neutral ? 24 + Math.random() * 14 : v0 * (0.8 + Math.random() * 0.5);
      this.particles.push({
        type: neutral ? "sput0" : "anion",
        kind: item.kind, color: item.color,
        x: G.target[0] + 0.5, y: G.target[1] + (Math.random() - 0.5) * 3,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        prev: null, r: neutral ? 1.3 : 1.8, zone: 0,
      });
    }
    // secondary electrons leave with the anions (and are thrown out later)
    if (Math.random() < 0.5) {
      const ang = (Math.random() * 2 - 1) * 60 * DEG;
      this.particles.push({
        type: "e", color: "#e2e8f0", x: G.target[0] + 0.5, y: G.target[1],
        vx: Math.cos(ang) * 6, vy: Math.sin(ang) * 6, prev: null, r: 0.9,
        zone: 0, sgn: Math.random() < 0.5 ? 1 : -1,
      });
    }
  }

  update(dtRaw) {
    const dt = Math.min(dtRaw, 0.05) * this.shared.speed();
    if (this.shared.paused()) return;
    this.spawnCs(dt);
    const S = this.settings;
    const [tx, ty] = G.target;

    // speeds at the stage energies (scene mm/s)
    const vIon = Math.max(speed(12, S.cathodeKV * 1000) * ANIM_V, 30);        // at the ionizer hole
    const vOut = Math.max(speed(12, (S.cathodeKV + S.srcKV) * 1000) * ANIM_V, 40); // after the gap
    const aPocket = 60 * (S.cathodeKV / 10);                 // field reaching into the pocket
    const dPlate = G.plate.x1 - tx;
    const vPlate = Math.sqrt(2 * aPocket * dPlate) + 1;
    // spherical-gap field (∝ 1/r² from the sample spot): most of U_cath is
    // gained right behind the lens plate, which keeps the beam slim
    const gapK = Math.max(0, (vIon * vIon - vPlate * vPlate) / 2 / (1 / dPlate - 1 / G.R));
    const aExt = Math.max(0, (vOut * vOut - vIon * vIon) / (2 * (G.gnd.x - G.extr.x)));
    const aCs = 120 * (S.cathodeKV / 10);                    // Cs+ radial acceleration

    for (const p of this.particles) {
      if (p.dead) continue;

      if (p.type === "cs0") {
        p.vx += (Math.random() - 0.5) * 6 * dt;
        p.vy += (Math.random() - 0.5) * 6 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        const d = Math.hypot(p.x - tx, p.y - ty);
        if (d < G.R + 2.5 && d > G.R - 2.5) {
          const ang = Math.abs(Math.atan2(p.y - ty, p.x - tx)) / DEG;
          if (ang > G.holeDeg && ang < G.spanDeg + 6) {
            if (Math.random() < this.ionizeProb()) {   // surface ionization
              p.type = "cs+"; p.color = "#fcd34d"; p.r = 1.8;
              const k = 6 / d; p.vx = -(p.x - tx) * k; p.vy = -(p.y - ty) * k;
            } else { p.dead = true; }
            continue;
          }
        }
        if (p.x < G.cathode.x0 || p.x > G.bounds.x1 - 8 || Math.abs(p.y) > 100 || d < G.spotR) p.dead = true;
      }

      else if (p.type === "cs+") {
        const d = Math.hypot(p.x - tx, p.y - ty) || 1;
        p.vx += (-(p.x - tx) / d) * aCs * dt;
        p.vy += (-(p.y - ty) / d) * aCs * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        // the lens plate aperture: Cs+ must pass the ±ap hole
        if (p.x <= G.plate.x1 && p.x > G.plate.x0 && Math.abs(p.y) > G.plate.ap) {
          p.dead = true;
          this.events.push({ type: "spark", x: p.x, y: p.y, color: "#fcd34d", t: 0 });
        } else if (Math.hypot(p.x - tx, p.y - ty) < G.spotR) { p.dead = true; this.sputter(p.x, p.y); }
        else if (p.x < G.cathode.x1 && Math.abs(p.y) > G.spotR) {
          p.dead = true;
          this.events.push({ type: "spark", x: p.x, y: p.y, color: "#fcd34d", t: 0 });
        }
      }

      else if (p.type === "sput0") {
        p.x += p.vx * dt; p.y += p.vy * dt;
        const d = Math.hypot(p.x - tx, p.y - ty);
        if ((p.x > G.plate.x0 && p.x < G.plate.x1 + 1 && Math.abs(p.y) > G.plate.ap) ||
            (d > G.R - 2 && Math.abs(Math.atan2(p.y - ty, p.x - tx)) / DEG > G.holeDeg) ||
            Math.abs(p.y) > G.wallY + 30 || p.x > G.objX) p.dead = true;
      }

      else if (p.type === "anion" || p.type === "e") {
        const isE = p.type === "e";
        const m = isE ? 2.6 : 1;            // electrons: light → visibly faster
        const d = Math.hypot(p.x - tx, p.y - ty) || 1;

        if (this.lensOn && p.x < G.plate.x1) {        // pocket behind the lens plate
          p.vx += aPocket * m * dt;
          // the fringe field reaching into the pocket turns the slow ions
          // forward at once (immersion lens action starts here)
          if (!isE) p.vy *= Math.exp(-1.5 * dt);
        } else if (d < G.R) {                         // Cs gap: 1/r² field, U_cath
          // With the plate, the field close to the aperture is axial (the
          // fringe there is what focuses) and only further out radial around
          // the spot. Without the plate the sample sits in the full spherical
          // field: radial everywhere, so the wide emission angles are kept.
          const aGap = gapK / (Math.max(d, G.spotR) ** 2);
          const radial = this.lensOn ? Math.max(0, Math.min(1, (d - 12) / 40)) : 1;
          const ux = (p.x - tx) / d, uy = (p.y - ty) / d;
          p.vx += (radial * ux + (1 - radial)) * aGap * m * dt;
          p.vy += radial * uy * aGap * m * dt;
        } else if (p.x > G.extr.x && p.x < G.gnd.x) { // extraction gap: U_ion
          p.vx += aExt * m * dt;
        }
        // suppressor magnets throw the electrons out of the beam
        if (isE && p.x > G.extr.x && p.x < G.magnetX + 14) p.vy += p.sgn * 900 * dt;

        const x0 = p.x;
        p.x += p.vx * dt; p.y += p.vy * dt;

        // ── immersion lens plate: aperture check + converging kick
        //    (plate "removed" when the lens is switched off)
        if (p.zone === 0 && p.x >= G.plate.x1) {
          if (this.lensOn && Math.abs(p.y) > G.plate.ap) { this.kill(p, isE); continue; }
          if (this.lensOn && !isE) p.vy += -(p.y * p.vx) / 3.5; // crossover ~8 mm past the plate
          p.zone = 1;
        }
        // ── ionizer hole
        if (p.zone === 1 && Math.hypot(p.x - tx, p.y - ty) >= G.R) {
          if (Math.abs(Math.atan2(p.y - ty, p.x - tx)) / DEG > G.holeDeg) { this.kill(p, isE); continue; }
          p.zone = 2;
        }
        if (p.zone === 2 && Math.abs(p.y) > G.channelHalf) { this.kill(p, isE); continue; }
        // ── extractor: aperture + focus trim
        if (p.zone === 2 && p.x >= G.extr.x) {
          if (Math.abs(p.y) > G.extr.ap) { this.kill(p, isE); continue; }
          if (!isE) p.vy += -(p.y * p.vx) * 0.014 * S.extrOffsetKV;
          p.zone = 3;
        }
        if (p.zone === 3 && isE && Math.abs(p.y) > G.channelHalf + 2) { this.kill(p, true); continue; }
        // ── ground electrode: aperture + slight divergence at the gap exit
        if (p.zone === 3 && p.x >= G.gnd.x) {
          if (Math.abs(p.y) > G.gnd.ap) { this.kill(p, isE); continue; }
          p.vy += (p.y * p.vx) * 0.003;
          p.zone = 4;
        }
        // ── steerer (deflection drawn exaggerated)
        if (p.zone === 4 && p.x >= (G.steer.x0 + G.steer.x1) / 2) {
          if (Math.abs(p.y) > G.steer.gap) { this.kill(p, isE); continue; }
          p.vy += (S.steererV / 100) * 0.05 * p.vx;
          p.zone = 5;
        }
        // ── box lens: entry aperture, converging kick at the centre, exit aperture
        if (p.zone === 5 && p.x >= G.box.x[0]) {
          if (Math.abs(p.y) > G.box.ap) { this.kill(p, isE); continue; }
          p.zone = 6;
        }
        if (p.zone === 6 && p.x >= G.box.x[1]) {
          const f = S.boxLensKV > 0.05 ? 75 * (15 / S.boxLensKV) : Infinity;
          p.vy += -(p.y * p.vx) / f;
          p.zone = 7;
        }
        if (p.zone === 7 && p.x >= G.box.x[2]) {
          if (Math.abs(p.y) > G.box.ap) { this.kill(p, isE); continue; }
          p.zone = 8;
        }
        // ── object point of the LE magnet
        if (p.x >= G.objX) {
          if (Math.abs(p.y) < G.objAp && !isE) {
            p.dead = true;
            this.stats.out[p.kind] = (this.stats.out[p.kind] || 0) + 1;
            if (p.kind === "C") this.stats.window.C++;
            if (p.kind === "O") this.stats.window.O++;
            this.events.push({ type: "out", x: G.objX + 3, y: p.y, color: p.color, t: 0 });
          } else this.kill(p, isE);
          continue;
        }
        if (Math.abs(p.y) > (p.zone >= 2 ? G.wallY : 100)) { this.kill(p, isE); continue; }
        void x0;
      }
    }
    this.particles = this.particles.filter((p) => !p.dead);
    for (const ev of this.events) ev.t += dt;
    this.events = this.events.filter((ev) => ev.t < 0.8);
  }

  kill(p, quiet = false) {
    p.dead = true;
    if (!quiet) this.stats.lost++;
    this.events.push({ type: "spark", x: p.x, y: p.y, color: p.color, t: 0, small: quiet });
  }

  // ── rendering ────────────────────────────────────────────────────────
  drawStatic() {
    const ctx = this.xS;
    ctx.clearRect(0, 0, this.w, this.h);
    this.hitRects = [];
    const [tx, ty] = G.target;
    const rect = (x0, y0, x1, y1, fill, stroke) => {
      const a = this.s2c(x0, y0), b = this.s2c(x1, y1);
      const X = Math.min(a[0], b[0]), Y = Math.min(a[1], b[1]);
      const W = Math.abs(b[0] - a[0]), H = Math.abs(b[1] - a[1]);
      ctx.fillStyle = fill; ctx.fillRect(X, Y, W, H);
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(X, Y, W, H); }
    };

    // vacuum box at ground
    ctx.strokeStyle = "rgba(148,163,184,0.25)"; ctx.lineWidth = 1.4;
    const h0 = this.s2c(G.bounds.x0 + 14, -102), h1 = this.s2c(G.bounds.x1 - 10, 102);
    ctx.strokeRect(h0[0], h0[1], h1[0] - h0[0], h1[1] - h0[1]);

    if (this.fieldOn) this.drawField(ctx);

    // ── cathode stage: holder, sample, immersion lens plate
    rect(G.cathode.x0, -G.cathode.half, G.cathode.x1, G.cathode.half, "rgba(45,212,191,0.22)", "rgba(45,212,191,0.5)");
    const sp = this.s2c(tx, ty);
    ctx.fillStyle = this.material.key === "gas" ? "#94a3b8" : "#1e293b";
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sp[0], sp[1], this.px(G.spotR), 0, 7); ctx.fill(); ctx.stroke();
    this.hit("cathode", G.cathode.x0 - 6, -G.cathode.half, G.cathode.x1 + 2, G.cathode.half);
    for (const sgn of [1, -1]) {
      rect(G.plate.x0, sgn * G.plate.ap, G.plate.x1, sgn * G.cathode.half,
        this.lensOn ? "rgba(45,212,191,0.60)" : "rgba(45,212,191,0.14)",
        this.lensOn ? null : "rgba(45,212,191,0.45)");
    }
    this.hit("immersion", G.plate.x0 - 2, -G.cathode.half, G.plate.x1 + 3, G.cathode.half);

    // ── ionizer stage: spherical cap (hot), shroud/channel, extractor
    for (const sgn of [1, -1]) {
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], this.px(G.R), sgn * G.holeDeg * DEG, sgn * G.spanDeg * DEG, sgn < 0);
      ctx.strokeStyle = "rgba(251,146,60,0.9)";
      ctx.lineWidth = Math.max(4, this.px(5));
      ctx.shadowColor = "#fb923c"; ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.shadowBlur = 0;
      // channel walls behind the hole (field-free)
      ctx.beginPath();
      ctx.moveTo(...this.s2c(tx + G.R - 1, sgn * G.channelHalf));
      ctx.lineTo(...this.s2c(G.extr.x - 2, sgn * G.channelHalf));
      ctx.strokeStyle = "rgba(251,146,60,0.45)"; ctx.lineWidth = 1.5; ctx.stroke();
    }
    this.hit("ionizer", tx + G.R * 0.5, -G.R - 8, G.extr.x - 4, G.R + 8);

    // ring nozzle (two cross-sections + faint edge-on ellipse)
    const na = G.nozzleAng * DEG;
    const nX = tx + G.nozzleDist * Math.cos(na), nY = G.nozzleDist * Math.sin(na);
    ctx.save();
    ctx.strokeStyle = "rgba(253,230,138,0.28)"; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    const nc = this.s2c(nX, 0);
    ctx.beginPath(); ctx.ellipse(nc[0], nc[1], this.px(3.2), this.px(nY), 0, 0, 7); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
    for (const sgn of [1, -1]) {
      rect(nX - 3.5, sgn * nY - 3, nX + 3.5, sgn * nY + 3, "rgba(253,230,138,0.55)", "rgba(253,230,138,0.8)");
      this.hit("nozzle", nX - 6, sgn * nY - 6, nX + 6, sgn * nY + 6);
    }
    // Cs oven + feed line
    rect(G.oven.x0, G.oven.y0, G.oven.x1, G.oven.y1, "rgba(253,230,138,0.12)", "rgba(253,230,138,0.6)");
    ctx.beginPath();
    ctx.moveTo(...this.s2c((G.oven.x0 + G.oven.x1) / 2, G.oven.y0));
    ctx.lineTo(...this.s2c(nX, nY + 3));
    ctx.strokeStyle = "rgba(253,230,138,0.35)"; ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([]);
    this.hit("oven", G.oven.x0 - 4, G.oven.y0 - 4, G.oven.x1 + 4, G.oven.y1 + 4);

    // extractor (ionizer stage colour) + suppressor magnets
    for (const sgn of [1, -1]) {
      rect(G.extr.x, sgn * G.extr.ap, G.extr.x + G.extr.w, sgn * 42, "rgba(251,146,60,0.45)", "rgba(251,146,60,0.7)");
      rect(G.magnetX - 3, sgn * 13, G.magnetX + 3, sgn * 19, sgn > 0 ? "rgba(248,113,113,0.8)" : "rgba(96,165,250,0.8)");
    }
    this.hit("extractor", G.extr.x - 6, -44, G.magnetX + 6, 44);

    // ground electrode
    for (const sgn of [1, -1])
      rect(G.gnd.x, sgn * G.gnd.ap, G.gnd.x + G.gnd.w, sgn * 50, "rgba(203,213,225,0.55)", "rgba(203,213,225,0.8)");
    this.hit("ground", G.gnd.x - 6, -50, G.gnd.x + G.gnd.w + 6, 50);

    // chamber walls of the extraction section
    ctx.strokeStyle = "rgba(148,163,184,0.35)"; ctx.lineWidth = 1.4;
    for (const sgn of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(...this.s2c(G.extr.x - 2, sgn * G.wallY));
      ctx.lineTo(...this.s2c(G.objX + 12, sgn * G.wallY));
      ctx.stroke();
    }

    // steerer plates
    for (const sgn of [1, -1])
      rect(G.steer.x0, sgn * G.steer.gap, G.steer.x1, sgn * (G.steer.gap + 3), "rgba(96,165,250,0.7)", null);
    this.hit("steerer", G.steer.x0 - 4, -G.steer.gap - 10, G.steer.x1 + 4, G.steer.gap + 10);

    // box lens: ground – centre – ground
    G.box.x.forEach((x, i) => {
      const centre = i === 1;
      for (const sgn of [1, -1])
        rect(x - G.box.w[i] / 2, sgn * G.box.ap, x + G.box.w[i] / 2, sgn * G.box.half,
          centre ? "rgba(167,139,250,0.6)" : "rgba(203,213,225,0.5)",
          centre ? "rgba(167,139,250,0.9)" : "rgba(203,213,225,0.8)");
    });
    this.hit("boxlens", G.box.x[0] - 8, -G.box.half - 4, G.box.x[2] + 8, G.box.half + 4);

    // object point of the LE magnet (focus marker + acceptance)
    ctx.save();
    ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(160,176,205,0.6)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(...this.s2c(G.objX, -30)); ctx.lineTo(...this.s2c(G.objX, 30)); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
    for (const sgn of [1, -1])
      rect(G.objX - 1.5, sgn * G.objAp, G.objX + 1.5, sgn * 12, "rgba(160,176,205,0.5)", null);
    this.hit("exit", G.objX - 10, -34, G.objX + 36, 34);
    const ar = this.s2c(G.bounds.x1 - 14, -24);
    ctx.fillStyle = "rgba(160,176,205,0.85)";
    ctx.font = "600 11px Inter"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText("→ LE magnet", ar[0], ar[1]);

    // labels
    ctx.font = "600 10.5px Inter"; ctx.fillStyle = "rgba(160,176,205,0.85)";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    const label = (t, x, y) => { const p = this.s2c(x, y); ctx.fillText(t.toUpperCase(), p[0], p[1]); };
    label("sample cathode", tx - 6, -G.cathode.half - 10);
    label(this.lensOn ? "immersion lens" : "immersion lens (off)", 40, G.cathode.half + 12);
    label("cs ring nozzle", nX + 6, -nY - 12);
    label("spherical ionizer", tx + G.R * 0.8, -G.R - 14);
    label("Cs oven", (G.oven.x0 + G.oven.x1) / 2, G.oven.y1 + 12);
    label("extractor", G.extr.x + 6, -48);
    label("ground electrode", G.gnd.x + 2, -G.wallY - 10);
    label("steerer", (G.steer.x0 + G.steer.x1) / 2, G.steer.gap + 16);
    label("box lens (einzel)", G.box.x[1], -G.box.half - 10);
    label("object point", G.objX, 44);

    if (this.hover) {
      const r = this.hitRects.find((h) => h.key === this.hover);
      if (r) {
        ctx.strokeStyle = "rgba(56,189,248,0.8)"; ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(Math.min(r.a[0], r.b[0]), Math.min(r.a[1], r.b[1]),
          Math.abs(r.b[0] - r.a[0]), Math.abs(r.b[1] - r.a[1]));
        ctx.setLineDash([]);
      }
    }
  }

  hit(key, x0, y0, x1, y1) {
    this.hitRects.push({ key, a: this.s2c(x0, y0), b: this.s2c(x1, y1) });
  }

  /**
   * Equipotential overlay, shaped after the field picture of the explainer:
   *  - cathode↔ionizer (Cs gap, U_cath): spherical shells with 1/r spacing,
   *    crowding towards the lens plate; meniscus bulging into the aperture
   *  - ionizer channel: field-free
   *  - extractor↔ground electrode (extraction gap, U_ion): near-uniform
   *    planes bulging into the two apertures
   *  - box lens: symmetric meniscus pairs around the centre electrode
   *  - everything beyond: field-free
   */
  drawField(ctx) {
    const S = this.settings;
    const [tx, ty] = G.target;
    ctx.save();
    ctx.strokeStyle = "rgba(125,211,252,0.40)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);

    // Cs gap: shells between the plate and the ionizer cap
    const nGap = Math.max(2, Math.min(12, Math.round(S.cathodeKV)));
    const a = G.plate.x1 - tx + 2, b = G.R - 3;
    const span = (G.spanDeg + 3) * DEG;
    for (let k = 1; k <= nGap; k++) {
      const f = k / (nGap + 1);
      const r = 1 / ((1 - f) / a + f / b);
      ctx.beginPath();
      ctx.arc(...this.s2c(tx, ty), this.px(r), -span, span);
      ctx.stroke();
    }
    if (this.lensOn) {       // field penetration into the lens aperture
      for (const [xm, bulge] of [[G.plate.x1 + 0.5, 4], [G.plate.x1 + 3, 2.2]]) {
        ctx.beginPath();
        ctx.moveTo(...this.s2c(xm, -G.plate.ap));
        ctx.quadraticCurveTo(...this.s2c(xm - bulge, 0), ...this.s2c(xm, G.plate.ap));
        ctx.stroke();
      }
    }

    // extraction gap: planes between extractor and ground electrode
    const nCol = Math.max(2, Math.min(12, Math.round(S.srcKV / 3)));
    const xA = G.extr.x + G.extr.w + 3, xB = G.gnd.x - 3;
    for (let k = 0; k < nCol; k++) {
      const x = xA + ((xB - xA) * k) / (nCol - 1 || 1);
      ctx.beginPath();
      ctx.moveTo(...this.s2c(x, -(G.wallY - 6)));
      ctx.lineTo(...this.s2c(x, G.wallY - 6));
      ctx.stroke();
    }
    // penetration into the extractor hole (reach ∝ extractor offset) and the ground aperture
    const reach = 4 + 4 * S.extrOffsetKV;
    ctx.beginPath();
    ctx.moveTo(...this.s2c(G.extr.x - 1, -G.extr.ap));
    ctx.quadraticCurveTo(...this.s2c(G.extr.x - reach, 0), ...this.s2c(G.extr.x - 1, G.extr.ap));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(...this.s2c(G.gnd.x + G.gnd.w + 1, -G.gnd.ap));
    ctx.quadraticCurveTo(...this.s2c(G.gnd.x + G.gnd.w + 7, 0), ...this.s2c(G.gnd.x + G.gnd.w + 1, G.gnd.ap));
    ctx.stroke();

    // box lens: meniscus pairs on both sides of the centre electrode
    const amp = 2 + 5 * Math.min(2, S.boxLensKV / 15);
    for (const side of [-1, 1]) {
      for (const [off, k] of [[6, 1], [12, 0.6]]) {
        const x = G.box.x[1] + side * off;
        ctx.beginPath();
        ctx.moveTo(...this.s2c(x, -G.box.ap));
        ctx.quadraticCurveTo(...this.s2c(x + side * amp * k, 0), ...this.s2c(x, G.box.ap));
        ctx.stroke();
      }
    }

    // potential labels (live): cathode stage, ionizer, extractor, ground, lens
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(125,211,252,0.75)";
    ctx.font = "600 10px JetBrains Mono, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    const lbl = (t, x, y) => { const p = this.s2c(x, y); ctx.fillText(t, p[0], p[1]); };
    lbl(`−${(S.cathodeKV + S.srcKV).toFixed(0)} kV`, tx - 4, G.cathode.half + 26);
    lbl(`−${S.srcKV.toFixed(0)} kV`, tx + G.R + 10, G.R + 26);
    lbl(`−${(S.srcKV + S.extrOffsetKV).toFixed(1)} kV`, G.extr.x + 8, 56);
    lbl("0 kV", G.gnd.x + 4, G.wallY + 16);
    lbl(`−${S.boxLensKV.toFixed(0)} kV`, G.box.x[1], G.box.half + 14);
    lbl("field-free", (tx + G.R + G.extr.x) / 2 + 2, -G.channelHalf - 8);
    lbl("field-free", (G.box.x[2] + G.objX) / 2, -G.wallY + 14);
    ctx.restore();
  }

  frame(dtRaw) {
    const dt = Math.min(dtRaw, 0.05);
    const paused = this.shared.paused();
    if (!paused) {
      this.xT.save();
      this.xT.globalCompositeOperation = "destination-out";
      this.xT.fillStyle = `rgba(0,0,0,${Math.min(0.3, dt * 3.6)})`;
      this.xT.fillRect(0, 0, this.w, this.h);
      this.xT.restore();
      this.xT.save();
      this.xT.globalCompositeOperation = "lighter";
      this.xT.lineCap = "round";
      for (const p of this.particles) {
        const sp = this.s2c(p.x, p.y);
        if (p.prev) {
          this.xT.strokeStyle = p.color;
          this.xT.globalAlpha = p.type === "cs0" ? 0.30 : p.type === "sput0" ? 0.35 : p.type === "e" ? 0.45 : 0.8;
          this.xT.lineWidth = p.type === "anion" ? 1.8 : p.type === "e" ? 0.8 : 1.3;
          this.xT.beginPath(); this.xT.moveTo(...p.prev); this.xT.lineTo(...sp); this.xT.stroke();
        }
        p.prev = sp;
      }
      this.xT.restore();
    }

    const ctx = this.xP;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    for (const p of this.particles) {
      const sp = this.s2c(p.x, p.y);
      ctx.shadowColor = p.color; ctx.shadowBlur = p.type === "e" ? 3 : 6;
      ctx.fillStyle = p.color; ctx.globalAlpha = p.type === "cs0" ? 0.7 : 1;
      ctx.beginPath(); ctx.arc(sp[0], sp[1], p.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    for (const ev of this.events) {
      const sp = this.s2c(ev.x, ev.y);
      const a = 1 - ev.t / 0.8;
      ctx.globalAlpha = ev.small ? a * 0.5 : a;
      ctx.strokeStyle = ev.color; ctx.lineWidth = ev.big ? 2 : 1.4;
      ctx.beginPath(); ctx.arc(sp[0], sp[1], 2 + ev.t * (ev.big ? 30 : ev.small ? 8 : 18), 0, 7); ctx.stroke();
    }
    ctx.restore();
  }

  // ── hover info ───────────────────────────────────────────────────────
  wireHover() {
    const stage = this.cv.stage;
    stage.addEventListener("mousemove", (ev) => {
      const r = stage.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      const hitEntry = this.hitRects.find((h) =>
        x >= Math.min(h.a[0], h.b[0]) && x <= Math.max(h.a[0], h.b[0]) &&
        y >= Math.min(h.a[1], h.b[1]) && y <= Math.max(h.a[1], h.b[1]));
      const key = hitEntry ? hitEntry.key : null;
      if (key !== this.hover) {
        this.hover = key;
        this.drawStatic();
        const comp = key && this.cfg.components[key];
        if (comp) {
          this.cv.infoTitle.textContent = comp.label;
          this.cv.infoBody.textContent = comp.blurb;
        }
      }
      stage.style.cursor = key ? "help" : "default";
    });
  }

  // ── measurements ─────────────────────────────────────────────────────
  startMeasurementLoop(els) {
    const INT = 500, ALPHA = 0.25;
    setInterval(() => {
      if (!this.shared.paused()) {
        for (const k of ["cs", "C", "O"]) {
          const inst = this.stats.window[k] / (INT / 1000) / this.shared.speed();
          this.rates[k] += ALPHA * (inst - this.rates[k]);
          this.stats.window[k] = 0;
        }
      }
      const m = this.material;
      const csNom = CS_SPAWN_NOM * 0.9;
      // fraction of sputtered anions that reaches the object point at design
      // settings (measured in the sim itself)
      const passFrac = 0.9;
      const share = (kind) => m.mix.find((x) => x.kind === kind).p;
      const nomC = csNom * m.burst * share("C") * passFrac;
      const nomO = csNom * m.burst * share("O") * passFrac;
      const uaCs = (this.rates.cs / csNom) * this.cfg.display.csCurrentUA;
      const uaC = nomC > 0 ? (this.rates.C / nomC) * m.cCurrentUA : 0;
      const uaO = nomO > 0 ? (this.rates.O / nomO) * m.oCurrentUA : 0;
      els.valCs.textContent = `${uaCs.toFixed(0)} µA`;
      els.valC.textContent = `${uaC.toFixed(1)} µA`;
      els.valO.textContent = `${uaO.toFixed(1)} µA`;
      els.barCs.style.width = `${Math.min(100, uaCs / (this.cfg.display.csCurrentUA * 1.2) * 100)}%`;
      els.barC.style.width = `${Math.min(100, uaC / 75 * 100)}%`;
      els.barO.style.width = `${Math.min(100, uaO / 40 * 100)}%`;
      const keV = this.settings.cathodeKV + this.settings.srcKV;
      els.valEnergy.textContent = `${keV.toFixed(1)} keV`;
      const ok = Math.abs(keV - this.cfg.nominal.injectionKeV) < 0.6;
      els.valEnergy.style.color = ok ? "" : "#fbbf24";
      els.energyHint.textContent = ok
        ? "U_ion + U_cath — matches the 40 keV the beamline is tuned for"
        : `beamline expects ${this.cfg.nominal.injectionKeV} keV — this beam would be lost at the injection magnet`;
      els.valLost.textContent = this.stats.lost;
    }, INT);
  }
}
