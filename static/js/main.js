/**
 * Entry point: fetch the machine description from the Python backend,
 * assemble engine + renderer + UI for the beamline view and the ion-source
 * view, run the animation loop for whichever view is active.
 */

import { SimulationEngine } from "./engine.js";
import { Renderer } from "./renderer.js";
import { UI } from "./ui.js";
import { SourceView } from "./source.js";

async function boot() {
  const [config, srcConfig] = await Promise.all([
    fetch("api/config").then((r) => r.json()),
    fetch("api/source-config").then((r) => r.json()),
  ]);

  // ── beamline view ────────────────────────────────────────────────────
  const engine = new SimulationEngine(config);
  const renderer = new Renderer(
    {
      static: document.getElementById("cvStatic"),
      trails: document.getElementById("cvTrails"),
      sprites: document.getElementById("cvSprites"),
    },
    engine.path,
    engine,
  );
  const ui = new UI(config, engine, renderer);

  // ── ion-source view ──────────────────────────────────────────────────
  const sourceView = new SourceView(srcConfig, {
    stage: document.getElementById("stageSource"),
    static: document.getElementById("cvSrcStatic"),
    trails: document.getElementById("cvSrcTrails"),
    sprites: document.getElementById("cvSrcSprites"),
    slidersHost: document.getElementById("sourceSliders"),
    materialHost: document.getElementById("materialSeg"),
    infoTitle: document.getElementById("infoTitleSrc"),
    infoBody: document.getElementById("infoBodySrc"),
    valCs: document.getElementById("valSrcCs"),
    valC: document.getElementById("valSrcC"),
    valO: document.getElementById("valSrcO"),
    barCs: document.getElementById("barSrcCs"),
    barC: document.getElementById("barSrcC"),
    barO: document.getElementById("barSrcO"),
    valEnergy: document.getElementById("valSrcEnergy"),
    energyHint: document.getElementById("srcEnergyHint"),
    valLost: document.getElementById("valSrcLost"),
  }, { speed: () => ui.speed, paused: () => ui.paused });

  document.getElementById("btnTuneSource")
    .addEventListener("click", () => sourceView.tuneToOptimum());

  window.AMS = { config, srcConfig, engine, renderer, ui, sourceView };

  document.getElementById("appVer").textContent = `v${config.machine.version}`;

  // ── view switching ───────────────────────────────────────────────────
  let view = "beam";
  const tabs = document.getElementById("viewTabs");
  function setView(v) {
    view = v;
    for (const b of tabs.children) b.classList.toggle("active", b.dataset.view === v);
    const beam = v === "beam";
    document.getElementById("stageWrapBeam").hidden = !beam;
    document.getElementById("beamControls").hidden = !beam;
    document.getElementById("beamPanelRight").hidden = !beam;
    document.getElementById("stageWrapSource").hidden = beam;
    document.getElementById("sourceControls").hidden = beam;
    document.getElementById("sourcePanelRight").hidden = beam;
    if (!beam) sourceView.resize();
    else renderer.resize();
  }
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) setView(b.dataset.view);
  });
  window.addEventListener("ams:view", (e) => setView(e.detail));

  new ResizeObserver(() => renderer.resize()).observe(document.getElementById("stage"));
  new ResizeObserver(() => sourceView.resize()).observe(document.getElementById("stageSource"));

  // paused badge for the source stage mirrors the main one
  const srcBadge = document.getElementById("pausedBadgeSource");
  setInterval(() => srcBadge.classList.toggle("show", ui.paused), 300);

  // ── animation loop (drives only the visible view) ────────────────────
  let last = performance.now();
  function loop(now) {
    const dtRaw = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (view === "beam") {
      const dt = dtRaw * ui.speed;
      if (!ui.paused) engine.update(dt);
      renderer.frame(dt, ui.paused);
    } else {
      sourceView.update(dtRaw);
      sourceView.frame(dtRaw);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

boot().catch((err) => {
  document.body.innerHTML =
    `<div style="color:#fb7185;font:14px monospace;padding:40px">
       Failed to start the simulator: ${err}<br><br>
       Is the backend running? Start it with <b>./run.sh</b> and open
       <b>http://127.0.0.1:8550</b>.
     </div>`;
  console.error(err);
});
