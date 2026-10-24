/**
 * Canvas renderer.
 *
 * Three stacked canvases:
 *   static  — the machine itself (redrawn on resize / hover highlight)
 *   trails  — particle trails with per-frame fade (persistent buffer)
 *   sprites — particle heads + transient events (cleared every frame)
 *
 * Scene coordinates are real machine millimetres; transverse offsets are
 * exaggerated by TRANSVERSE_EXAG for visibility.
 */

import { TRANSVERSE_EXAG as EXAG } from "./physics.js";

const COLORS = {
  pipe: "rgba(148,163,184,0.34)",
  pipeFill: "rgba(148,163,184,0.05)",
  axis: "rgba(148,163,184,0.14)",
  label: "rgba(160,176,205,0.85)",
  labelLine: "rgba(160,176,205,0.30)",
  highlight: "rgba(56,189,248,0.95)",
};

export class Renderer {
  constructor(els, path, engine) {
    this.cvStatic = els.static; this.cvTrails = els.trails; this.cvSprites = els.sprites;
    this.xS = this.cvStatic.getContext("2d");
    this.xT = this.cvTrails.getContext("2d");
    this.xP = this.cvSprites.getContext("2d");
    this.path = path;
    this.engine = engine;
    this.highlightKey = null;
    this.hitPolys = [];
    this.detFlash = 0;
    this.resize();
  }

  // ───────────────────────────────────────────── transform
  resize() {
    const stage = this.cvStatic.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = stage.clientWidth; this.h = stage.clientHeight;
    for (const cv of [this.cvStatic, this.cvTrails, this.cvSprites]) {
      cv.width = Math.round(this.w * dpr);
      cv.height = Math.round(this.h * dpr);
      cv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const b = this.path.bounds(70);
    const sx = this.w / (b.maxX - b.minX), sy = this.h / (b.maxY - b.minY);
    this.scale = Math.min(sx, sy);
    this.ox = (this.w - (b.maxX - b.minX) * this.scale) / 2 - b.minX * this.scale;
    this.oy = (this.h - (b.maxY - b.minY) * this.scale) / 2 - b.minY * this.scale;
    this.drawStatic();
    this.xT.clearRect(0, 0, this.w, this.h);
    for (const p of this.engine.particles) p.prevDraw = null; // avoid streaks
  }

  w2s([x, y]) { return [x * this.scale + this.ox, y * this.scale + this.oy]; }
  px(mm) { return mm * this.scale; }

  // ───────────────────────────────────────────── static machine
  drawStatic() {
    const ctx = this.xS;
    ctx.clearRect(0, 0, this.w, this.h);
    this.hitPolys = [];
    this.drawGrid(ctx);

    // reference axis (dashed) under everything
    ctx.save();
    ctx.strokeStyle = COLORS.axis; ctx.lineWidth = 1; ctx.setLineDash([3, 7]);
    ctx.beginPath();
    for (const el of this.path.elements) {
      const N = el.isArc ? 24 : 2;
      for (let i = 0; i <= N; i++) {
        const pt = this.w2s(el.point((i / N) * el.length, 0));
        if (el.s0 === 0 && i === 0) ctx.moveTo(...pt); else ctx.lineTo(...pt);
      }
    }
    ctx.stroke();
    ctx.restore();

    for (const el of this.path.elements) {
      this.drawElement(ctx, el);
      if (el.label) {
        this.hitPolys.push({
          key: el.key,
          poly: el.outline(el.drawHalfWidth() * EXAG).map((p) => this.w2s(p)),
        });
      }
    }
    for (const el of this.path.elements)
      if (el.label && el.type !== "slit") this.drawLabel(ctx, el);
    this.drawScaleBar(ctx);
  }

  drawGrid(ctx) {
    ctx.save();
    ctx.fillStyle = "rgba(148,163,184,0.05)";
    const step = 34;
    for (let x = step / 2; x < this.w; x += step)
      for (let y = step / 2; y < this.h; y += step) {
        ctx.beginPath(); ctx.arc(x, y, 1, 0, 7); ctx.fill();
      }
    ctx.restore();
  }

  drawScaleBar(ctx) {
    const mm = 500, w = this.px(mm);
    const x0 = 18, y0 = this.h - 20;
    ctx.save();
    ctx.strokeStyle = "rgba(160,176,205,0.5)"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0); ctx.lineTo(x0 + w, y0); ctx.lineTo(x0 + w, y0 - 4);
    ctx.stroke();
    ctx.fillStyle = COLORS.label; ctx.font = "10px JetBrains Mono, monospace";
    ctx.fillText("0.5 m", x0 + w / 2 - 14, y0 - 7);
    ctx.restore();
  }

  /** Polygon for the element body at given half-width (scene mm, drawn exaggerated). */
  shape(ctx, el, halfWidth, x0 = null, x1 = null) {
    const lo = x0 ?? -halfWidth, hi = x1 ?? halfWidth;
    const N = el.isArc ? 22 : 2;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const pt = this.w2s(el.point((i / N) * el.length, hi * EXAG));
      i === 0 ? ctx.moveTo(...pt) : ctx.lineTo(...pt);
    }
    for (let i = N; i >= 0; i--) {
      ctx.lineTo(...this.w2s(el.point((i / N) * el.length, lo * EXAG)));
    }
    ctx.closePath();
  }

  grad(ctx, el, c1, c2) {
    const a = this.w2s(el.point(0, 0)), b = this.w2s(el.point(el.length, 0));
    const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
    g.addColorStop(0, c1); g.addColorStop(1, c2);
    return g;
  }

  drawElement(ctx, el) {
    const hl = this.highlightKey === el.key;
    ctx.save();
    switch (el.type) {
      case "drift": {
        this.shape(ctx, el, el.aperture);
        ctx.fillStyle = COLORS.pipeFill; ctx.fill();
        ctx.strokeStyle = COLORS.pipe; ctx.lineWidth = 1.2; ctx.stroke();
        break;
      }
      case "source": {
        this.shape(ctx, el, el.aperture + 13);
        ctx.fillStyle = this.grad(ctx, el, "rgba(251,146,60,0.30)", "rgba(251,146,60,0.10)");
        ctx.fill();
        ctx.strokeStyle = hl ? COLORS.highlight : "rgba(251,146,60,0.65)";
        ctx.lineWidth = hl ? 2 : 1.4; ctx.stroke();
        // glowing sample spot
        const spot = this.w2s(el.point(el.length * 0.22, 0));
        const g = ctx.createRadialGradient(...spot, 0, ...spot, this.px(30));
        g.addColorStop(0, "rgba(255,200,120,0.95)"); g.addColorStop(1, "rgba(255,160,60,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(...spot, this.px(30), 0, 7); ctx.fill();
        ctx.fillStyle = "#ffd9a0"; ctx.font = `700 ${Math.max(9, this.px(26))}px Inter`;
        ctx.textAlign = "center";
        const tp = this.w2s(el.point(el.length * 0.6, 0));
        ctx.fillText("Cs⁺ → C⁻", tp[0], tp[1] + this.px(7));
        break;
      }
      case "steerer": {
        this.shape(ctx, el, el.aperture);
        ctx.fillStyle = COLORS.pipeFill; ctx.fill();
        for (const side of [-1, 1]) {
          this.shape(ctx, el, 0, side * (el.aperture + 1), side * (el.aperture + 7));
          ctx.fillStyle = hl ? "rgba(45,212,191,0.8)" : "rgba(45,212,191,0.45)";
          ctx.fill();
        }
        if (hl) { this.shape(ctx, el, el.aperture + 9); ctx.strokeStyle = COLORS.highlight; ctx.lineWidth = 2; ctx.stroke(); }
        break;
      }
      case "dipole": {
        const isLE = !!el.cfg.isLE;
        const body = el.aperture + (isLE ? 16 : 10);
        this.shape(ctx, el, body);
        ctx.fillStyle = isLE
          ? this.grad(ctx, el, "rgba(56,189,248,0.30)", "rgba(56,189,248,0.12)")
          : this.grad(ctx, el, "rgba(129,140,248,0.30)", "rgba(129,140,248,0.12)");
        ctx.fill();
        ctx.strokeStyle = hl ? COLORS.highlight : (isLE ? "rgba(56,189,248,0.6)" : "rgba(129,140,248,0.6)");
        ctx.lineWidth = hl ? 2.2 : 1.4; ctx.stroke();
        // field symbols: x-in-circle (B into the screen)
        ctx.fillStyle = "rgba(232,244,255,0.5)";
        ctx.font = `${Math.max(8, this.px(34))}px Inter`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (const f of [0.25, 0.5, 0.75]) {
          const pt = this.w2s(el.point(f * el.length, 0));
          ctx.fillText("⊗", pt[0], pt[1]);
        }
        break;
      }
      case "slit": {
        const gapDraw = el.aperture * EXAG, jawW = 26 * EXAG;
        for (const side of [-1, 1]) {
          this.shape(ctx, el, 0, side * gapDraw / EXAG, side * (gapDraw + jawW) / EXAG);
          ctx.fillStyle = hl ? "rgba(203,213,225,0.85)" : "rgba(148,163,184,0.55)";
          ctx.fill();
        }
        break;
      }
      case "accelerator": {
        this.shape(ctx, el, el.aperture + 15);
        ctx.fillStyle = this.grad(ctx, el, "rgba(167,139,250,0.22)", "rgba(167,139,250,0.22)");
        ctx.fill();
        ctx.strokeStyle = hl ? COLORS.highlight : "rgba(167,139,250,0.6)";
        ctx.lineWidth = hl ? 2.2 : 1.4; ctx.stroke();
        // accelerating column ribs
        ctx.strokeStyle = "rgba(167,139,250,0.35)"; ctx.lineWidth = 1;
        for (let f = 0.08; f < 1; f += 0.084) {
          if (Math.abs(f - 0.5) < 0.06) continue;
          const a = this.w2s(el.point(f * el.length, (el.aperture + 12) * 1));
          const b = this.w2s(el.point(f * el.length, -(el.aperture + 12) * 1));
          ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
        }
        // terminal + He stripper at the centre
        const mid = this.w2s(el.point(el.length * 0.5, 0));
        const rr = this.px(34);
        const g = ctx.createRadialGradient(...mid, 0, ...mid, rr);
        g.addColorStop(0, "rgba(125,211,252,0.5)"); g.addColorStop(1, "rgba(125,211,252,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(...mid, rr, 0, 7); ctx.fill();
        ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(125,211,252,0.8)"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(...mid, this.px(22), 0, 7); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#bae6fd"; ctx.font = `600 ${Math.max(8, this.px(20))}px Inter`;
        ctx.textAlign = "center";
        ctx.fillText("He stripper", mid[0], mid[1] - this.px(34));
        ctx.fillStyle = "rgba(232,244,255,0.75)";
        ctx.fillText("+" + Math.round(this.engine.settings.termKV) + " kV terminal", mid[0], mid[1] + this.px(44));
        break;
      }
      case "esa": {
        // two curved deflection plates
        const gapHalf = el.aperture;
        for (const [side, color, sign] of [[1, "rgba(251,113,133,0.8)", "+"], [-1, "rgba(56,189,248,0.8)", "−"]]) {
          ctx.beginPath();
          const N = 22;
          for (let i = 0; i <= N; i++) {
            const pt = this.w2s(el.point((i / N) * el.length, side * (gapHalf + 4) * EXAG));
            i === 0 ? ctx.moveTo(...pt) : ctx.lineTo(...pt);
          }
          ctx.strokeStyle = hl ? COLORS.highlight : color;
          ctx.lineWidth = Math.max(3, this.px(10)); ctx.stroke();
          const mp = this.w2s(el.point(el.length * 0.5, side * (gapHalf + 26) * EXAG));
          ctx.fillStyle = color; ctx.font = `800 ${Math.max(10, this.px(30))}px Inter`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(sign, mp[0], mp[1]);
        }
        this.shape(ctx, el, gapHalf);
        ctx.fillStyle = "rgba(148,163,184,0.04)"; ctx.fill();
        break;
      }
      case "cups": {
        this.shape(ctx, el, el.aperture);
        ctx.fillStyle = COLORS.pipeFill; ctx.fill();
        ctx.strokeStyle = COLORS.pipe; ctx.lineWidth = 1.2; ctx.stroke();
        let cupIdx = -1;
        for (const cup of el.cups) {
          cupIdx++;
          if (cup.x === null) continue;
          const spec = this.engine.species.find((s) => s.key === cup.species);
          const c = spec ? spec.color : "#cbd5e1";
          const w = this.px(Math.max(cup.halfWidth * EXAG, 9));
          const depth = this.px(26);
          const pos = this.w2s(el.point(el.cupPlane, cup.x * EXAG));
          const d = el.dirAt(el.cupPlane);
          const dp = [d[0], d[1]], np = [-d[1], d[0]];
          ctx.beginPath(); // open box facing upstream
          ctx.moveTo(pos[0] - np[0] * w - dp[0] * 2, pos[1] - np[1] * w - dp[1] * 2);
          ctx.lineTo(pos[0] - np[0] * w + dp[0] * depth, pos[1] - np[1] * w + dp[1] * depth);
          ctx.lineTo(pos[0] + np[0] * w + dp[0] * depth, pos[1] + np[1] * w + dp[1] * depth);
          ctx.lineTo(pos[0] + np[0] * w - dp[0] * 2, pos[1] + np[1] * w - dp[1] * 2);
          ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = c.replace(")", ",0.18)").replace("rgb", "rgba");
          ctx.font = `700 ${Math.max(9, this.px(24))}px Inter`;
          ctx.fillStyle = c; ctx.textAlign = "center";
          // stagger labels along the beam direction so they don't overlap
          const off = depth + 12 + cupIdx * Math.max(11, this.px(28));
          const lp = [pos[0] + dp[0] * off, pos[1] + dp[1] * off];
          ctx.fillText(cup.label, lp[0], lp[1] + 4);
        }
        break;
      }
      case "detector": {
        this.shape(ctx, el, el.aperture + 14);
        const flash = Math.max(0, this.detFlash);
        ctx.fillStyle = this.grad(ctx, el,
          `rgba(244,63,94,${0.18 + flash * 0.4})`, "rgba(244,63,94,0.10)");
        ctx.fill();
        ctx.strokeStyle = hl ? COLORS.highlight : "rgba(244,63,94,0.7)";
        ctx.lineWidth = hl ? 2.2 : 1.5; ctx.stroke();
        // anode grid
        ctx.strokeStyle = "rgba(244,63,94,0.35)"; ctx.lineWidth = 1;
        for (let f = 0.3; f < 0.95; f += 0.16) {
          const a = this.w2s(el.point(f * el.length, (el.aperture + 9)));
          const b = this.w2s(el.point(f * el.length, -(el.aperture + 9)));
          ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
        }
        break;
      }
    }
    ctx.restore();
  }

  drawLabel(ctx, el) {
    const mid = el.length / 2;
    const w = (el.drawHalfWidth() + 16) * EXAG;
    // place the label on the outward side of bends, "above" otherwise
    const base = this.w2s(el.point(mid, w));
    const alt = this.w2s(el.point(mid, -w));
    const pick = el.isArc ? base : (base[1] <= alt[1] ? base : alt);
    const anchor = this.w2s(el.point(mid, 0));
    const dx = pick[0] - anchor[0], dy = pick[1] - anchor[1];
    const len = Math.hypot(dx, dy) || 1;
    ctx.save();
    ctx.font = "600 10.5px Inter";
    const text = el.label.split(" (")[0].toUpperCase();
    const tw = ctx.measureText(text).width;
    // clamp inside the canvas so nothing gets clipped at the edges
    const tx = Math.max(tw / 2 + 6, Math.min(this.w - tw / 2 - 6, pick[0] + (dx / len) * 10));
    const ty = Math.max(14, Math.min(this.h - 8, pick[1] + (dy / len) * 10));
    ctx.fillStyle = this.highlightKey === el.key ? "#7dd3fc" : COLORS.label;
    ctx.textAlign = "center";
    ctx.textBaseline = dy > 0 ? "top" : "bottom";
    ctx.fillText(text, tx, ty);
    ctx.restore();
  }

  // ───────────────────────────────────────────── dynamic layers
  frame(dt, paused) {
    // fade trails
    if (!paused) {
      this.xT.save();
      this.xT.globalCompositeOperation = "destination-out";
      this.xT.fillStyle = `rgba(0,0,0,${Math.min(0.32, dt * 4.2)})`;
      this.xT.fillRect(0, 0, this.w, this.h);
      this.xT.restore();
    }

    const live = this.engine.livePositions(EXAG);

    // trail segments
    if (!paused) {
      this.xT.save();
      this.xT.globalCompositeOperation = "lighter";
      this.xT.lineCap = "round";
      for (const { p, pos } of live) {
        const sp = this.w2s(pos);
        if (p.prevDraw) {
          this.xT.strokeStyle = p.color;
          this.xT.globalAlpha = p.kind === "fragment" ? 0.5 : 0.75;
          this.xT.lineWidth = p.speciesKey === "C14" ? 2.2 : 1.6;
          this.xT.beginPath();
          this.xT.moveTo(...p.prevDraw); this.xT.lineTo(...sp);
          this.xT.stroke();
        }
        p.prevDraw = sp;
      }
      this.xT.restore();
    }

    // particle heads
    const ctx = this.xP;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    for (const { p, pos } of live) {
      const sp = this.w2s(pos);
      ctx.shadowColor = p.color; ctx.shadowBlur = 7;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], p.speciesKey === "C14" ? 2.6 : 2.0, 0, 7);
      ctx.fill();
    }
    ctx.restore();

    // events
    this.detFlash = Math.max(0, this.detFlash - dt * 2.5);
    for (const ev of this.engine.events) {
      if (!ev.pos) { if (ev.type === "burst") continue; else continue; }
      const sp = this.w2s(ev.pos);
      const a = 1 - ev.t / 0.9;
      ctx.save();
      if (ev.type === "spark") {
        ctx.strokeStyle = ev.color; ctx.globalAlpha = a * 0.9;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sp[0], sp[1], 2 + ev.t * 26, 0, 7); ctx.stroke();
        ctx.fillStyle = "#fda4af"; ctx.globalAlpha = a;
        ctx.beginPath(); ctx.arc(sp[0], sp[1], 1.6, 0, 7); ctx.fill();
      } else if (ev.type === "capture") {
        ctx.strokeStyle = ev.color; ctx.globalAlpha = a;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sp[0], sp[1], 3 + ev.t * 18, 0, 7); ctx.stroke();
      } else if (ev.type === "count" || ev.type === "bgcount") {
        if (ev.t < dt * 1.5 && ev.type === "count") this.detFlash = 1;
        ctx.strokeStyle = ev.type === "count" ? "#f43f5e" : "#a78bfa";
        ctx.globalAlpha = a; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.arc(sp[0], sp[1], 3 + ev.t * 34, 0, 7); ctx.stroke();
        ctx.font = "700 11px Inter"; ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(ev.type === "count" ? "¹⁴C!" : "background", sp[0] + 10, sp[1] - 8 - ev.t * 16);
      }
      ctx.restore();
    }
  }

  // ───────────────────────────────────────────── hover
  setHighlight(key) {
    if (key !== this.highlightKey) { this.highlightKey = key; this.drawStatic(); }
  }

  elementAtScreen(px, py) {
    for (const { key, poly } of this.hitPolys) {
      if (pointInPoly(px, py, poly)) return key;
    }
    return null;
  }
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
