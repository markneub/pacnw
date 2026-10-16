/**
 * Phone/tablet controls, designed for one thumb.
 *
 * Put your thumb down anywhere and drag:
 * - sliding sideways turns your view (like a swipe);
 * - how far up from where you touched sets your speed: a little walks,
 *   near the top of the range runs; pulling down backs up slowly.
 * While you steer one-handed the view gently levels itself.
 * A second finger, if you want one, is a free look (including up/down).
 * The jump button sits bottom-right.
 */
const THROTTLE_RANGE = 80; // px of upward travel for full speed

/** Phones and tablets; touchscreen laptops (fine primary pointer) keep mouse + keyboard. */
export function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches;
}

export class TouchControls {
  constructor(surface, player) {
    this.player = player;
    this.steerId = null;
    this.steerOriginY = 0;
    this.steerLastX = 0;
    this.lookId = null;
    this.lookLast = { x: 0, y: 0 };

    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    this.root.innerHTML = `
      <div class="stick"><div class="knob"></div></div>
      <button type="button" class="tbtn jump" aria-label="Jump">⤒</button>
    `;
    document.body.appendChild(this.root);
    this.stickEl = this.root.querySelector('.stick');
    this.knobEl = this.root.querySelector('.knob');

    this.root.querySelector('.jump').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      player.jump();
    });

    surface.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e), { passive: false });
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    // stop iOS from treating gestures as page scroll/zoom
    surface.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    surface.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  show(visible) {
    this.root.classList.toggle('active', visible);
  }

  /** Radians of turn per pixel of horizontal slide (~130° per screen width). */
  get lookRate() {
    return 2.3 / Math.max(window.innerWidth, 320);
  }

  down(e) {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    if (this.steerId === null) {
      this.steerId = e.pointerId;
      this.steerOriginY = e.clientY;
      this.steerLastX = e.clientX;
      this.placeStick(e.clientX, e.clientY, 0);
      this.stickEl.classList.add('on');
      this.player.levelPitch = this.lookId === null;
    } else if (this.lookId === null) {
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
      this.player.levelPitch = false;
    }
  }

  move(e) {
    if (e.pointerId === this.steerId) {
      e.preventDefault();
      this.player.look((e.clientX - this.steerLastX) * this.lookRate, 0);
      this.steerLastX = e.clientX;
      const up = (this.steerOriginY - e.clientY) / THROTTLE_RANGE; // + forward, - back
      const throttle = Math.max(-0.5, Math.min(1, up));
      // the ring follows the thumb sideways; the knob shows the throttle
      this.placeStick(e.clientX, this.steerOriginY, -throttle * THROTTLE_RANGE);
      this.player.stick.set(0, Math.abs(throttle) < 0.1 ? 0 : throttle);
    } else if (e.pointerId === this.lookId) {
      e.preventDefault();
      const k = this.lookRate;
      this.player.look((e.clientX - this.lookLast.x) * k, (e.clientY - this.lookLast.y) * k);
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  up(e) {
    if (e.pointerId === this.steerId) {
      this.steerId = null;
      this.player.stick.set(0, 0);
      this.player.levelPitch = false;
      this.stickEl.classList.remove('on');
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
      this.player.levelPitch = this.steerId !== null;
    }
  }

  placeStick(x, y, knobY) {
    this.stickEl.style.transform = `translate(${x}px, ${y}px)`;
    this.knobEl.style.transform = `translate(0px, ${knobY}px)`;
  }
}
