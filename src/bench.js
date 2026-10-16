import { groundDetail } from './grounddetail.js';

/**
 * ?bench: a one-tap benchmark for real devices. It stops the game loop, then
 * at a few fixed views renders the scene with parts switched off one at a time
 * and shows a table you can copy.
 *
 * Timing: "frame" renders N frames back to back and waits for the GPU once at
 * the end, so CPU and GPU overlap the way they do in play, with no vsync and
 * almost no measuring overhead: it's the real cost of a frame. "cpu" is the
 * JS time inside renderer.render (three.js issuing draw calls). "sync" waits
 * for the GPU after every frame, like the ?perf overlay on iOS, so the gap
 * between sync and frame is the cost of measuring that way.
 */
const VIEWS = [
  { name: 'spawn', x: null, z: null },
  { name: 'forest', x: -30, z: 420, yaw: 0.3, pitch: 0 },
  { name: 'snowy slope', x: -60, z: -250, yaw: 0.4, pitch: 0 },
];

export async function runBench({ renderer, scene, camera, player, veg, weather, spawn, quick = false }) {
  // quick: a smoke test for slow software renderers (one view, tiny batches)
  const N = quick ? 2 : 15; // frames per batch
  const REPEATS = quick ? 1 : 3; // batches per config (median taken)
  const views = quick ? VIEWS.slice(0, 1) : VIEWS;
  const gl = renderer.getContext();
  const pixel = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const render = () => renderer.render(scene, camera);
  const byName = (n) => scene.getObjectByName(n);

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
    ['full', () => () => {}],
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
    ['- water', () => hide(byName('lake'))],
    ['- sky', () => hide(byName('sky'))],
    ['- rain/snow', () => hide(weather.rain, weather.snow)],
    ['empty scene', () => hide(...scene.children)],
  ];
  if (dpr > 1) {
    configs.push(['dpr 1', () => {
      renderer.setPixelRatio(1);
      return () => renderer.setPixelRatio(dpr);
    }]);
  }

  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  function measure() {
    for (let i = 0; i < 3; i++) { render(); sync(); } // settle (and compile anything new)
    const frame = [];
    const cpu = [];
    const synced = [];
    for (let r = 0; r < REPEATS; r++) {
      let inRender = 0;
      sync();
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        const a = performance.now();
        render();
        inRender += performance.now() - a;
      }
      sync();
      frame.push((performance.now() - t0) / N);
      cpu.push(inRender / N);

      let s = 0;
      for (let i = 0; i < N; i++) {
        const a = performance.now();
        render();
        sync();
        s += performance.now() - a;
      }
      synced.push(s / N);
    }
    return { frame: median(frame), cpu: median(cpu), sync: median(synced) };
  }

  const w = renderer.domElement.width;
  const h = renderer.domElement.height;
  const lines = [
    `Cascadia Woods bench · ${w}×${h} px (dpr ${dpr.toFixed(2)})`,
    navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 90),
    'ms per frame. "saves" = full minus this row.',
  ];
  const fmt = (v) => ` ${v.toFixed(1).padStart(5)}`;
  const total = views.length * configs.length;
  let done = 0;

  for (const view of views) {
    player.place(view.x ?? spawn.x, view.z ?? spawn.z, view.yaw ?? spawn.yaw, view.pitch ?? spawn.pitch);
    veg.updateNear(camera.position, true);
    veg.updateVisibility(camera.position);
    weather.update(10, 0, camera); // snap weather and fog to this spot
    const { calls, triangles } = (render(), renderer.info.render);
    lines.push('', `${view.name} (${calls} draws, ${(triangles / 1e6).toFixed(2)}M tris)`,
      `${'config'.padEnd(16)} frame   cpu   sync   saves`);
    let full = 0;
    for (const [name, apply] of configs) {
      show(`Benchmarking… ${Math.round((done / total) * 100)}%\n${lines.join('\n')}`);
      await new Promise((r) => requestAnimationFrame(() => r()));
      const undo = apply();
      const m = measure();
      undo();
      if (name === 'full') full = m.frame;
      const saves = name === 'full' ? '' : fmt(full - m.frame);
      lines.push(`${name.padEnd(16)}${fmt(m.frame)}${fmt(m.cpu)}${fmt(m.sync)}${saves}`);
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
