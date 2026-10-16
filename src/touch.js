/**
 * Phone/tablet controls.
 *
 * - Left half of the screen: a floating thumbstick appears where you touch.
 *   Drag to walk; push it to the rim to run.
 * - Right half: swipe to look around.
 * - Button: jump. (Weather always follows altitude on phones.)
 *
 * Several fingers are tracked independently by pointerId, so you can walk and
 * look at the same time.
 */
const STICK_RADIUS = 56; // px of thumb travel for full deflection

/** Phones and tablets; touchscreen laptops (fine primary pointer) keep mouse + keyboard. */
export function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches;
}

export class TouchControls {
  constructor(surface, player) {
    this.player = player;
    this.stickId = null;
    this.stickOrigin = { x: 0, y: 0 };
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

    const tap = (el, fn) => el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
    tap(this.root.querySelector('.jump'), () => player.jump());

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

  down(e) {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    if (e.clientX < window.innerWidth / 2 && this.stickId === null) {
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stickEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.knobEl.style.transform = 'translate(0px, 0px)';
      this.stickEl.classList.add('on');
    } else if (this.lookId === null) {
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  move(e) {
    if (e.pointerId === this.stickId) {
      e.preventDefault();
      let dx = e.clientX - this.stickOrigin.x;
      let dy = e.clientY - this.stickOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > STICK_RADIUS) {
        dx *= STICK_RADIUS / len;
        dy *= STICK_RADIUS / len;
      }
      this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
      this.player.stick.set(dx / STICK_RADIUS, -dy / STICK_RADIUS);
    } else if (e.pointerId === this.lookId) {
      e.preventDefault();
      // a full-width swipe turns you about 200°
      const k = 3.5 / Math.max(window.innerWidth, 320);
      this.player.look((e.clientX - this.lookLast.x) * k, (e.clientY - this.lookLast.y) * k);
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  up(e) {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.player.stick.set(0, 0);
      this.stickEl.classList.remove('on');
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
    }
  }
}
