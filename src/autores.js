/**
 * Automatic resolution: a safety net for long sessions on phones that heat up
 * and lower their GPU clock. If more than 10% of frames miss 60 fps over the
 * last ~2 s, the render resolution steps down one notch (0.25 x), down to a
 * floor. Each step reallocates the framebuffer, a single small hitch, which
 * beats a stutter that keeps going. It never steps back up within a session,
 * so it can't oscillate.
 *
 * Isolated hitches don't trigger it, and neither do long gaps (tab switches,
 * ?bench). Off with ?dpr=… (a fixed resolution) or ?autores=0.
 *
 * `floor` is a number or a function (re-read at each step, so a window that goes fullscreen
 * later gets a lower floor). It only sees frames that are really drawn (framepacer.js).
 */
const WINDOW = 120; // frames (~2 s at 60 fps)
const MIN_FRAMES = WINDOW; // judge only on a full window since the last reset
const SLOW_MS = 22; // a frame that took longer missed a 60 Hz vsync
const SLOW_SHARE = 0.1;
const STEP = 0.25;
const GAP_MS = 250; // longer than this is a pause, not a slow frame
const HOLD_MS = 2000; // settle time after start and after each step

export class AutoResolution {
  constructor(renderer, { floor, now = () => performance.now() }) {
    this.renderer = renderer;
    this.floor = floor;
    this.now = now;
    this.slow = new Uint8Array(WINDOW);
    this.head = 0;
    this.n = 0;
    this.slowCount = 0;
    this.last = now();
    this.holdUntil = this.last + HOLD_MS;
    this.done = false;
  }

  floorNow() {
    return typeof this.floor === 'function' ? this.floor() : this.floor;
  }

  reset() {
    this.slow.fill(0);
    this.head = 0;
    this.n = 0;
    this.slowCount = 0;
  }

  /** Call once per frame. */
  tick() {
    if (this.done || this.renderer.getPixelRatio() - STEP < this.floorNow() - 1e-3) return;
    const now = this.now();
    const dt = now - this.last;
    this.last = now;
    if (dt > GAP_MS || now < this.holdUntil) {
      this.reset();
      return;
    }
    const s = dt > SLOW_MS ? 1 : 0;
    this.slowCount += s - this.slow[this.head];
    this.slow[this.head] = s;
    this.head = (this.head + 1) % WINDOW;
    this.n = Math.min(this.n + 1, WINDOW);
    if (this.n >= MIN_FRAMES && this.slowCount > this.n * SLOW_SHARE) this.stepDown(now);
  }

  stepDown(now) {
    const from = this.renderer.getPixelRatio();
    const to = Math.max(this.floorNow(), from - STEP);
    this.renderer.setPixelRatio(to);
    console.info(`auto resolution: ${from} → ${to} (${this.slowCount}/${this.n} frames missed 60 fps)`);
    this.holdUntil = now + HOLD_MS;
    this.reset();
  }
}
