/**
 * ?perf overlay: frame time (avg and worst over the last 2 s), FPS, draw calls
 * and triangles. "Worst" is the number to watch for stutter: anything well
 * above the average means hitches.
 */
export class PerfOverlay {
  constructor(renderer) {
    this.renderer = renderer;
    this.el = document.createElement('div');
    this.el.id = 'perf';
    document.body.appendChild(this.el);
    this.samples = new Float32Array(240);
    this.count = 0;
    this.head = 0;
    this.last = performance.now();
    this.nextPaint = 0;
    this.hitches = 0; // frames over 50 ms since start
  }

  /** Call once per frame after rendering. */
  tick() {
    const now = performance.now();
    const ms = now - this.last;
    this.last = now;
    this.samples[this.head] = ms;
    this.head = (this.head + 1) % this.samples.length;
    this.count = Math.min(this.count + 1, this.samples.length);
    if (ms > 50 && this.count > 30) this.hitches++;
    if (now < this.nextPaint) return;
    this.nextPaint = now + 500;

    // last ~2 s of frames
    let sum = 0;
    let worst = 0;
    let n = 0;
    let span = 0;
    for (let i = 1; i <= this.count && span < 2000; i++) {
      const v = this.samples[(this.head - i + this.samples.length) % this.samples.length];
      sum += v;
      span += v;
      worst = Math.max(worst, v);
      n++;
    }
    const avg = sum / Math.max(1, n);
    const { calls, triangles } = this.renderer.info.render;
    this.el.textContent = `${(1000 / avg).toFixed(0)} fps · avg ${avg.toFixed(1)} ms · worst ${worst.toFixed(0)} ms`
      + ` · hitches ${this.hitches}\n${calls} draws · ${(triangles / 1e6).toFixed(2)}M tris`;
  }
}
