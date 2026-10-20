/**
 * ?perf overlay. Line 1 is what you see: FPS, frame interval (avg and worst
 * over the last 2 s) and hitches. With vsync the interval sits at 16.7 ms
 * whenever the work fits, so line 2 measures the work itself:
 *
 *  - CPU: JS time per frame (game update + three.js issuing draw calls).
 *  - GPU: the GPU's time for the frame, from timer queries
 *    (EXT_disjoint_timer_query_webgl2) where the browser offers them. They're
 *    asynchronous, so they don't disturb the frame.
 *  - Safari / iOS have no timer queries, so GPU time isn't shown there; use
 *    ?bench, which measures real frame cost. ?perf=sync instead ends each
 *    frame with a 1-pixel readback and shows the time until the GPU is done,
 *    but on iOS that wait reads 2-4x the true cost (measured with ?bench), so
 *    treat it as an upper bound.
 *
 * Line 4 is the player's spot as URL parameters (x, z, yaw, pitch), so a screenshot of a view says
 * where it was taken.
 *
 * Budget: 16.7 ms at 60 Hz. Leave a few ms for the browser's own compositing.
 */
const WINDOW_MS = 2000;
const RING = 240;

class Ring {
  constructor() {
    this.v = new Float32Array(RING);
    this.head = 0;
    this.count = 0;
  }

  push(x) {
    this.v[this.head] = x;
    this.head = (this.head + 1) % RING;
    this.count = Math.min(this.count + 1, RING);
  }

  /** avg and worst of the newest n samples (writes into out, no allocation) */
  stats(n, out) {
    n = Math.min(n, this.count);
    let sum = 0;
    let worst = 0;
    for (let i = 1; i <= n; i++) {
      const x = this.v[(this.head - i + RING) % RING];
      sum += x;
      worst = Math.max(worst, x);
    }
    out.avg = sum / Math.max(1, n);
    out.worst = worst;
    out.n = n;
    return out;
  }
}

export class PerfOverlay {
  constructor(renderer, mode = '') {
    this.renderer = renderer;
    this.el = document.createElement('div');
    this.el.id = 'perf';
    document.body.appendChild(this.el);
    this.frame = new Ring(); // interval between frames
    this.cpu = new Ring();
    this.gpu = new Ring();
    this.last = performance.now();
    this.start = 0;
    this.nextPaint = 0;
    this.hitches = 0; // frames over 50 ms since start
    this.s = { avg: 0, worst: 0, n: 0 };

    const gl = renderer.getContext();
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (this.ext) {
      this.free = Array.from({ length: 6 }, () => gl.createQuery());
      this.pending = []; // in issue order
    }
    this.sync = !this.ext && mode === 'sync';
    this.pixel = new Uint8Array(4);
    this.pacer = null; // set by main.js
    this.player = null; // set by main.js: line 4 is where you stand, as URL parameters
    this.drawnSincePaint = 0;
  }

  /** Call at the very start of the frame. */
  begin() {
    this.start = performance.now();
    if (this.ext && this.free.length) {
      const q = this.free.pop();
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
      this.pending.push(q);
      this.querying = true;
    }
  }

  /** Call once per frame after rendering. */
  end() {
    const { gl, ext } = this;
    if (this.querying) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.querying = false;
    }
    let cpuEnd = performance.now();
    if (this.sync) {
      // waits for the GPU to finish this frame
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
      cpuEnd = performance.now();
    }
    this.cpu.push(cpuEnd - this.start);
    if (ext) this.collect();

    const now = performance.now();
    const ms = now - this.last;
    this.last = now;
    this.frame.push(ms);
    this.drawnSincePaint++;
    if (ms > 50 && this.frame.count > 30) this.hitches++;
    if (now < this.nextPaint) return;
    this.nextPaint = now + 500;
    this.paint();
  }

  collect() {
    const { gl, ext } = this;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      this.pending.shift();
      this.free.push(q);
      // a disjoint event (clock change, power state) invalidates the result
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) this.gpu.push(ns / 1e6);
    }
  }

  paint() {
    const { s } = this;
    // how many frames make up the last ~2 s
    let n = 0;
    let span = 0;
    const f = this.frame;
    while (n < f.count && span < WINDOW_MS) span += f.v[(f.head - ++n + RING) % RING];

    f.stats(n, s);
    let text = `${(1000 / s.avg).toFixed(0)} fps · frame ${s.avg.toFixed(1)} ms · worst ${s.worst.toFixed(0)} ms · hitches ${this.hitches}\n`;
    this.cpu.stats(n, s);
    const cpu = `${s.avg.toFixed(1)} ms (worst ${s.worst.toFixed(1)})`;
    if (this.sync) {
      text += `work ${cpu} · cpu+gpu, sync (reads high)`;
    } else if (this.ext) {
      text += `cpu ${cpu}`;
      this.gpu.stats(n, s);
      text += s.n ? ` · gpu ${s.avg.toFixed(1)} ms (worst ${s.worst.toFixed(1)})` : ' · gpu …';
    } else {
      text += `cpu ${cpu} · gpu n/a here (use ?bench)`;
    }
    const { calls, triangles } = this.renderer.info.render;
    // animation frames skipped because the GPU was behind (framepacer.js): GPU-bound when > 0
    let wait = '';
    if (this.pacer) {
      const drawn = this.drawnSincePaint;
      const skipped = this.pacer.skipped;
      this.pacer.skipped = 0;
      wait = ` · gpu-bound ${Math.round((100 * skipped) / Math.max(1, skipped + drawn))}%`;
    }
    this.drawnSincePaint = 0;
    const p = this.player;
    const pos = p ? `\nx=${p.pos.x.toFixed(1)}&z=${p.pos.z.toFixed(1)}&yaw=${(Math.atan2(Math.sin(p.yaw), Math.cos(p.yaw))).toFixed(2)}&pitch=${p.pitch.toFixed(2)}` : '';
    this.el.textContent = `${text}\n${calls} draws · ${(triangles / 1e6).toFixed(2)}M tris · dpr ${this.renderer.getPixelRatio()}${wait} · ${__BUILD_SHA__}${pos}`;
  }
}
