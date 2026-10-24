/**
 * UI controller: builds the data-driven control panel (sliders, isotope
 * chips), wires hover/info, and refreshes the measurement read-outs.
 */

export class UI {
  constructor(config, engine, renderer) {
    this.config = config;
    this.engine = engine;
    this.renderer = renderer;
    this.sliderEls = {};
    this.paused = false;
    this.speed = 1;

    this.buildSliders();
    this.buildChips();
    this.buildSampleSelector();
    this.wireStage();
    this.wireTopbar();
    this.wireBouncer();
    this.startMeasurementLoop();
  }

  // ───────────────────────────────────────────── sample selector
  buildSampleSelector() {
    const sel = document.getElementById("sampleSelect");
    for (const s of this.config.measurement.samples) {
      const opt = document.createElement("option");
      opt.value = s.key;
      const f = s.f14c >= 0.01 ? s.f14c.toFixed(2) : s.f14c > 0 ? s.f14c.toFixed(4) : "0";
      opt.textContent = `${s.label} · F¹⁴C = ${f}`;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      const s = this.config.measurement.samples.find((x) => x.key === sel.value);
      this.engine.setSample(s.f14c);
    });
  }

  // ───────────────────────────────────────────── sliders
  buildSliders() {
    const host = document.getElementById("sliders");
    const groups = {};
    for (const c of this.config.controls) {
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
          <span class="nominal-tick"></span>
          <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.nominal}">
        </div>
        <button class="step-btn" data-dir="up" title="+${c.step} ${c.unit} (hold to repeat)">›</button>
      </div>`;
    const input = row.querySelector("input");
    const val = row.querySelector(".slider-val");
    const tick = row.querySelector(".nominal-tick");
    tick.style.left = `${((c.nominal - c.min) / (c.max - c.min)) * 100}%`;

    const refresh = () => {
      const v = parseFloat(input.value);
      this.engine.settings[c.key] = v;
      const decimals = c.step < 0.01 ? 4 : c.step < 0.5 ? 2 : 0;
      val.textContent = `${v.toFixed(decimals)} ${c.unit}`;
      const off = Math.abs(v - c.nominal) > (c.max - c.min) * 0.004;
      val.classList.toggle("off", off);
      input.style.setProperty("--fill", `${((v - c.min) / (c.max - c.min)) * 100}%`);
    };
    input.addEventListener("input", refresh);
    // arrow buttons: one slider-step per click — far finer than dragging
    // allows; hold to repeat
    for (const btn of row.querySelectorAll(".step-btn")) {
      const stepOnce = () => {
        btn.dataset.dir === "up" ? input.stepUp() : input.stepDown();
        refresh();
      };
      let delay = null, repeat = null;
      const stop = () => { clearTimeout(delay); clearInterval(repeat); };
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        stepOnce();
        delay = setTimeout(() => { repeat = setInterval(stepOnce, 60); }, 400);
      });
      for (const ev of ["pointerup", "pointerleave", "pointercancel"])
        btn.addEventListener(ev, stop);
    }
    // double-click the slider (or the value chip) → back to design value
    const reset = () => { input.value = c.nominal; refresh(); };
    input.title = "Double-click to reset to design value";
    input.addEventListener("dblclick", reset);
    val.title = "Double-click to reset to design value";
    val.style.cursor = "pointer";
    val.addEventListener("dblclick", reset);
    refresh();
    this.sliderEls[c.key] = { input, refresh, nominal: c.nominal };
    return row;
  }

  /** Smoothly glide every control back to its design value. */
  tuneToOptimum() {
    const t0 = performance.now(), dur = 900;
    const from = {};
    for (const [k, s] of Object.entries(this.sliderEls)) from[k] = parseFloat(s.input.value);
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const tickFn = (now) => {
      const f = Math.min(1, (now - t0) / dur);
      for (const [k, s] of Object.entries(this.sliderEls)) {
        s.input.value = from[k] + (s.nominal - from[k]) * ease(f);
        s.refresh();
      }
      if (f < 1) requestAnimationFrame(tickFn);
    };
    requestAnimationFrame(tickFn);
    document.getElementById("bouncerToggle").checked = true;
    this.engine.settings.bouncer = true;
  }

  // ───────────────────────────────────────────── isotope chips
  buildChips() {
    const host = document.getElementById("speciesChips");
    for (const s of this.config.species) {
      const b = document.createElement("button");
      b.className = "chip on";
      b.style.setProperty("--c", s.color);
      b.title = s.note;
      b.innerHTML = `
        <span class="swatch"></span>
        <span><span class="chip-name">${s.html}</span>
        <div class="chip-sub">${s.kind === "molecular" ? "molecular impostor" : "mass"} ${s.mass_amu.toFixed(3)} u</div></span>
        <span class="chip-state">on</span>`;
      b.addEventListener("click", () => {
        const on = !b.classList.contains("on");
        b.classList.toggle("on", on);
        b.querySelector(".chip-state").textContent = on ? "on" : "off";
        this.engine.setSpecies(s.key, on);
      });
      host.appendChild(b);
    }
  }

  // ───────────────────────────────────────────── stage hover → info card
  wireStage() {
    const stage = document.getElementById("stage");
    const title = document.getElementById("infoTitle");
    const body = document.getElementById("infoBody");
    const hint = document.getElementById("stageHint");
    const byKey = Object.fromEntries(
      this.config.beamline.elements.filter((e) => e.label).map((e) => [e.key, e]));

    let pinned = null;
    const show = (key) => {
      const el = key && byKey[key];
      if (el) { title.textContent = el.label; body.innerHTML = el.blurb; }
    };
    stage.addEventListener("mousemove", (ev) => {
      const r = stage.getBoundingClientRect();
      const key = this.renderer.elementAtScreen(ev.clientX - r.left, ev.clientY - r.top);
      this.renderer.setHighlight(key || pinned);
      stage.style.cursor = key ? "pointer" : "default";
      if (key) hint.style.opacity = 0;
      show(key || pinned);
    });
    stage.addEventListener("mouseleave", () => { this.renderer.setHighlight(pinned); show(pinned); });
    stage.addEventListener("click", (ev) => {
      const r = stage.getBoundingClientRect();
      const key = this.renderer.elementAtScreen(ev.clientX - r.left, ev.clientY - r.top);
      if (key === "source") {   // step inside the ion source
        window.dispatchEvent(new CustomEvent("ams:view", { detail: "source" }));
        return;
      }
      pinned = key;
      show(pinned);
    });
  }

  // ───────────────────────────────────────────── top bar
  wireTopbar() {
    const btnPause = document.getElementById("btnPause");
    const iconPause = document.getElementById("iconPause");
    const iconPlay = document.getElementById("iconPlay");
    const badge = document.getElementById("pausedBadge");
    const setPaused = (v) => {
      this.paused = v;
      iconPause.style.display = v ? "none" : "";
      iconPlay.style.display = v ? "" : "none";
      badge.classList.toggle("show", v);
    };
    btnPause.addEventListener("click", () => setPaused(!this.paused));
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && e.target.tagName !== "INPUT") {
        e.preventDefault(); setPaused(!this.paused);
      }
    });

    document.getElementById("speedSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.speed = parseFloat(b.dataset.speed);
      for (const x of b.parentElement.children) x.classList.toggle("active", x === b);
    });

    document.getElementById("btnTune").addEventListener("click", () => this.tuneToOptimum());

    const modal = document.getElementById("aboutModal");
    document.getElementById("btnAbout").addEventListener("click", () => (modal.hidden = false));
    document.getElementById("btnCloseAbout").addEventListener("click", () => (modal.hidden = true));
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") modal.hidden = true; });
  }

  wireBouncer() {
    const t = document.getElementById("bouncerToggle");
    t.addEventListener("change", () => { this.engine.settings.bouncer = t.checked; });
  }

  // ───────────────────────────────────────────── measurements
  startMeasurementLoop() {
    const st = this.engine.stats;
    const rates = { cup12: 0, cup13: 0, cupCH: 0, det14: 0 };
    const cupsCfg = this.config.beamline.elements.find((e) => e.type === "cups");
    const kMonitor = cupsCfg ? cupsCfg.monitorFactor : 0;
    const INTERVAL = 500, ALPHA = 0.25;
    setInterval(() => {
      if (!this.paused) {
        for (const k of Object.keys(rates)) {
          const inst = st.window[k] / (INTERVAL / 1000) / this.speed;
          rates[k] += ALPHA * (inst - rates[k]);
          st.window[k] = 0;
        }
      }
      // ── convert stylised simulation rates into realistic machine readings
      const M = this.config.measurement;
      const nom = this.engine.nominalRates();
      const QE = 1.602176634e-19;
      const I12 = (rates.cup12 / nom.cup12) * M.cup12_uA;                 // µA
      const I13 = (rates.cup13 / nom.cup13) * M.cup12_uA * M.ratio13;     // µA
      const Imon = (rates.cupCH / nom.cupCH) * M.monitor_nA;              // nA
      const cps = (rates.det14 / nom.det14modern) * M.modernCps;          // counts/s

      document.getElementById("valCup12").textContent = `${I12.toFixed(1)} µA`;
      document.getElementById("valCup13").textContent = `${I13.toFixed(2)} µA`;
      document.getElementById("valCupCH").textContent = `${Imon.toFixed(1)} nA`;
      document.getElementById("valDet").textContent =
        `${cps < 10 ? cps.toFixed(2) : cps.toFixed(0)} /s`;

      const pct = (v, cap) => `${Math.min(100, (v / cap) * 100)}%`;
      document.getElementById("barCup12").style.width = pct(I12, M.cup12_uA * 1.15);
      document.getElementById("barCup13").style.width = pct(I13, M.cup12_uA * M.ratio13 * 1.15);
      document.getElementById("barCupCH").style.width = pct(Imon, M.monitor_nA * 1.3);
      document.getElementById("barDet").style.width = pct(cps, M.modernCps * 1.15);

      document.getElementById("valDetTotal").textContent = st.det14;
      document.getElementById("valBg").textContent = st.background;
      document.getElementById("valBgEst").textContent = (st.cupCH * kMonitor).toFixed(1);

      // ── 14C/12C ratio and radiocarbon age
      const ions12 = (I12 * 1e-6) / QE;       // 12C+ ions/s in the cup
      const ratio = ions12 > 1 ? cps / ions12 : 0;
      const F = ratio / M.modernRatio;
      document.getElementById("valRatio").textContent =
        ratio > 0 ? `¹⁴C/¹²C = ${(ratio / 1e-12).toFixed(2)} ×10⁻¹²` : "¹⁴C/¹²C = —";
      let ageTxt;
      if (rates.cup12 < 0.3) ageTxt = "—";                  // no beam, no measurement
      else if (F >= 0.92) ageTxt = "modern";
      else if (F < 0.0025) ageTxt = "≥ 50,000 yr";
      else ageTxt = `≈ ${Math.round((M.halfLifeYr / Math.LN2) * Math.log(1 / F))
        .toLocaleString("en-US")} yr`;
      document.getElementById("valAge").textContent = ageTxt;
      document.getElementById("valLost").textContent = st.lost;
      const trans = st.spawned14 > 12
        ? `${Math.min(100, (st.arrived14 / st.spawned14) * 100).toFixed(0)} %` : "–";
      document.getElementById("valTrans").textContent = trans;
    }, INTERVAL);
  }
}
