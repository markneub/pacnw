/**
 * Phone/tablet controls, designed for one thumb.
 *
 * Put your thumb down anywhere and drag:
 * - sliding sideways turns your view (like a swipe);
 * - how far up from where you touched sets your speed: a little walks,
 *   near the top of the range runs; pulling down backs up slowly.
 * While you walk, the view eases to follow the slope ahead.
 *
 * Hold your thumb still for a moment instead, and the drag becomes a free
 * look (up, down and around) without walking; the screen edges darken
 * slightly while it's on. Let go mid-swipe and the view glides on briefly.
 * The view stays where you left it until you walk again.
 *
 * A second finger, if you want one, is also a free look.
 */
const THROTTLE_RANGE = 80; // px of upward travel for full speed
const HOLD_MS = 260; // still this long → look mode
const HOLD_SLOP = 10; // px of movement that commits to walking instead

/** Phones and tablets; touchscreen laptops (fine primary pointer) keep mouse + keyboard. */
export function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches;
}

export class TouchControls {
  constructor(surface, player) {
    this.player = player;
    this.steerId = null;
    this.mode = null; // first finger: 'pending' | 'walk' | 'look'
    this.originX = 0;
    this.originY = 0;
    this.steerLastX = 0;
    this.holdTimer = 0;
    this.last = { x: 0, y: 0, t: 0 };
    this.vel = { x: 0, y: 0 }; // look speed (rad/s), for the glide on release
    this.lookId = null;
    this.lookLast = { x: 0, y: 0 };

    this.cue = document.createElement('div');
    this.cue.id = 'look-cue';
    document.body.appendChild(this.cue);

    surface.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e), { passive: false });
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    // stop iOS from treating gestures as page scroll/zoom
    surface.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    surface.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  /** Radians of turn per pixel of slide (~130° per screen width). */
  get lookRate() {
    return 2.3 / Math.max(window.innerWidth, 320);
  }

  down(e) {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    if (this.steerId === null) {
      this.steerId = e.pointerId;
      this.mode = 'pending';
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.player.spin.set(0, 0); // a new touch stops any glide
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => this.startLook(), HOLD_MS);
    } else if (this.lookId === null && this.mode === 'walk') {
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
      this.player.levelPitch = false;
    }
  }

  startLook() {
    if (this.mode !== 'pending') return;
    this.mode = 'look';
    this.player.levelPitch = false;
    this.last = { x: this.originX, y: this.originY, t: performance.now() };
    this.vel = { x: 0, y: 0 };
    this.cue.classList.add('on');
  }

  startWalk(e) {
    clearTimeout(this.holdTimer);
    this.mode = 'walk';
    this.steerLastX = this.originX; // the slide so far counts as turning
    this.player.levelPitch = this.lookId === null;
    this.walk(e);
  }

  walk(e) {
    this.player.look((e.clientX - this.steerLastX) * this.lookRate, 0);
    this.steerLastX = e.clientX;
    const up = (this.originY - e.clientY) / THROTTLE_RANGE; // + forward, - back
    const throttle = Math.max(-0.5, Math.min(1, up));
    this.player.stick.set(0, Math.abs(throttle) < 0.1 ? 0 : throttle);
  }

  move(e) {
    if (e.pointerId === this.steerId) {
      e.preventDefault();
      if (this.mode === 'pending') {
        if (Math.hypot(e.clientX - this.originX, e.clientY - this.originY) > HOLD_SLOP) this.startWalk(e);
      } else if (this.mode === 'walk') {
        this.walk(e);
      } else if (this.mode === 'look') {
        const k = this.lookRate;
        const dx = (e.clientX - this.last.x) * k;
        const dy = (e.clientY - this.last.y) * k;
        this.player.look(dx, dy);
        const now = performance.now();
        const dt = Math.max(1, now - this.last.t) / 1000;
        // smoothed swipe speed, for the glide when the thumb lifts
        this.vel.x += (dx / dt - this.vel.x) * 0.5;
        this.vel.y += (dy / dt - this.vel.y) * 0.5;
        this.last = { x: e.clientX, y: e.clientY, t: now };
      }
    } else if (e.pointerId === this.lookId) {
      e.preventDefault();
      const k = this.lookRate;
      this.player.look((e.clientX - this.lookLast.x) * k, (e.clientY - this.lookLast.y) * k);
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  up(e) {
    if (e.pointerId === this.steerId) {
      clearTimeout(this.holdTimer);
      if (this.mode === 'look' && performance.now() - this.last.t < 80) {
        this.player.spin.set(this.vel.x, this.vel.y).clampLength(0, 3); // let go mid-swipe: glide on (≤ ~30°)
      }
      this.steerId = null;
      this.mode = null;
      this.cue.classList.remove('on');
      this.player.stick.set(0, 0);
      this.player.levelPitch = false;
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
      this.player.levelPitch = this.mode === 'walk';
    }
  }
}
