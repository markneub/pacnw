import { groundDetail } from './grounddetail.js';
import { surfaceDetail } from './surfacedetail.js';

/**
 * ?bench: a one-tap benchmark for real devices. It stops the game loop, then
 * at a few fixed views renders the scene with parts switched off one at a time
 * (and at other resolutions) and shows a table you can copy.
 *
 * Timing: a batch renders N frames back to back and waits for the GPU once at
 * the end, so CPU and GPU overlap the way they do in play, with no vsync and
 * almost no measuring overhead: "frame" is the real cost of a frame. "cpu" is
 * the JS time inside renderer.render (three.js issuing draw calls).
 *
 * Phones change clock speed with load, which can shift every number mid-run.
 * So the GPU is warmed up first, and each row is measured paired with the full
 * scene, alternating batches. "saves" is that paired difference (negative =
 * costs more), and "±" is half the spread of those differences (noise).
 */
const VIEWS = [
  { name: 'spawn', x: null, z: null },
  { name: 'forest', x: -30, z: 420, yaw: 0.3, pitch: 0 },
  { name: 'snowy slope', x: -60, z: -250, yaw: 0.4, pitch: 0 },
];

export async function runBench({ renderer, scene, camera, player, veg, weather, grass, spawn, quick = false }) {
  // quick: a smoke test for slow software renderers (one view, tiny batches)
  const N = quick ? 2 : 12; // frames per batch
  const PAIRS = quick ? 1 : 5; // alternating full/config batch pairs per row (median taken)
  const WARM_MS = quick ? 0 : 1500;
  const views = quick ? VIEWS.slice(0, 1) : VIEWS;
  const gl = renderer.getContext();
  const pixel = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const render = () => renderer.render(scene, camera);
  const byName = (n) => scene.getObjectByName(n);
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  const panel = document.createElement('div');
  panel.id = 'bench';
  const pre = document.createElement('pre');
  panel.appendChild(pre);
  document.body.appendChild(panel);
  const show = (text) => { pre.textContent = text; };

  const hide = (...objs) => {
    const was = objs.map((o) => o.visible);
    for (const o of objs) o.visible = false;
    return () => objs.forEach((o, i) => { o.visible = was[i]; });
  };
  const vegOff = (kind) => {
    veg.setEnabled(kind, false);
    veg.updateVisibility(camera.position);
    return () => {
      veg.setEnabled(kind, true);
      veg.updateVisibility(camera.position);
    };
  };
  const dpr = renderer.getPixelRatio();
  const configs = [
    ['- trees', () => vegOff('trees')],
    ['- ferns', () => vegOff('ferns')],
    ['- rocks/logs', () => vegOff('rocks')],
    ['- ground', () => hide(byName('terrain'), byName('trail'))],
    ['- ground detail', () => {
      const r = groundDetail.uniforms.uGDRange.value;
      const was = r.clone();
      r.set(0, 0.001);
      return () => r.copy(was);
    }],
    ['- bark/rock tex', () => {
      const r = surfaceDetail.uSDRange.value;
      const was = r.clone();
      r.set(0, 0.001);
      return () => r.copy(was);
    }],
    ['- grass', () => (byName('grass') ? hide(byName('grass')) : () => {})],
    ['grass 50%', () => {
      if (!grass) return () => {};
      grass.setShare(0.5);
      return () => grass.setShare(1);
    }],
    ['- water', () => hide(byName('lake'))],
    ['- sky', () => hide(byName('sky'))],
    ['- rain/snow', () => hide(weather.rain, weather.snow)],
    ['empty scene', () => hide(...scene.children)],
  ];
  // other resolutions, up to the screen's own
  for (const d of [1, 1.5, 2, 2.5, 3]) {
    if (Math.abs(d - dpr) < 0.01 || d > window.devicePixelRatio + 0.01) continue;
    configs.push([`dpr ${d}`, () => {
      renderer.setPixelRatio(d);
      return () => renderer.setPixelRatio(dpr);
    }]);
  }

  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  /** one batch: [ms per frame, cpu ms per frame] */
  function batch() {
    let inRender = 0;
    sync();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const a = performance.now();
      render();
      inRender += performance.now() - a;
    }
    sync();
    return [(performance.now() - t0) / N, inRender / N];
  }
  const settle = () => { for (let i = 0; i < 3; i++) { render(); sync(); } };

  /** paired: alternate full / config batches so clock changes hit both alike */
  function measurePaired(apply) {
    const frame = [];
    const cpu = [];
    const diff = [];
    for (let p = 0; p < PAIRS; p++) {
      settle();
      const [f] = batch();
      const undo = apply();
      settle(); // compiles anything new, reallocates on resolution changes
      const [c, cc] = batch();
      undo();
      frame.push(c);
      cpu.push(cc);
      diff.push(f - c);
    }
    const spread = (Math.max(...diff) - Math.min(...diff)) / 2;
    return { frame: median(frame), cpu: median(cpu), saves: median(diff), spread };
  }

  const w = renderer.domElement.width;
  const h = renderer.domElement.height;
  const lines = [
    `Cascadia Woods bench v2 · ${w}×${h} px (dpr ${dpr.toFixed(2)}, screen ${window.devicePixelRatio})`,
    navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 90),
    'ms per frame. saves = paired full − row (negative = costs more), ± = noise.',
  ];
  const fmt = (v) => ` ${v.toFixed(1).padStart(5)}`;
  const total = views.length * (configs.length + 1);
  let done = 0;
  const progress = () => show(`Benchmarking… ${Math.round((done / total) * 100)}%\n${lines.join('\n')}`);

  // bring the GPU up to speed before timing anything
  progress();
  await nextFrame();
  for (const t0 = performance.now(); performance.now() - t0 < WARM_MS;) { render(); sync(); }

  for (const view of views) {
    player.place(view.x ?? spawn.x, view.z ?? spawn.z, view.yaw ?? spawn.yaw, view.pitch ?? spawn.pitch);
    veg.updateNear(camera, true);
    veg.updateVisibility(camera.position);
    weather.update(10, 0, camera); // snap weather and fog to this spot
    grass?.update(camera); // the game loop is paused: move the grass tile here
    render();
    const { calls, triangles } = renderer.info.render;
    lines.push('', `${view.name} (${calls} draws, ${(triangles / 1e6).toFixed(2)}M tris)`,
      `${'config'.padEnd(16)} frame   cpu  saves     ±`);

    progress();
    await nextFrame();
    settle();
    const base = [];
    const baseCpu = [];
    for (let p = 0; p < PAIRS * 2; p++) {
      const [f, c] = batch();
      base.push(f);
      baseCpu.push(c);
    }
    lines.push(`${'full'.padEnd(16)}${fmt(median(base))}${fmt(median(baseCpu))}`);
    done++;

    for (const [name, apply] of configs) {
      progress();
      await nextFrame();
      const m = measurePaired(apply);
      lines.push(`${name.padEnd(16)}${fmt(m.frame)}${fmt(m.cpu)}${fmt(m.saves)}${fmt(m.spread)}`);
      done++;
    }
  }

  const result = lines.join('\n');
  console.info(result);
  show(result);
  const copy = document.createElement('button');
  copy.textContent = 'Copy results';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(result);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed: select the text instead';
    }
  });
  panel.appendChild(copy);
  window.__bench = result;
  return result;
}
