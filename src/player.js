import * as THREE from 'three';
import { PLAYER, WORLD_SIZE } from './config.js';
import { walkAt as groundAt, openWaterLevel } from './terrain.js'; // (footbridges included)

// Water deeper than this stops you (the lake, ponds and the sea): you can wade out until it's
// about chest deep, so the eyes (and the camera) always stay above the surf.
const MAX_WADE = 1.1;
const waterDepth = (x, z) => openWaterLevel(x, z) - groundAt(x, z);

/**
 * First-person walker: mouse look via pointer lock, WASD/arrows to move,
 * Shift to run. Touch controls drive it through `stick` and look().
 * Feet follow the terrain and are pushed out of
 * trunks and boulders by the supplied collide() function.
 */
export class Player {
  constructor(camera, dom, collide) {
    this.camera = camera;
    this.dom = dom;
    this.collide = collide;
    this.pos = new THREE.Vector3(); // feet position
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.onGround = true;
    this.bob = 0; // footstep phase (2π per step)
    this.bobAmp = 0; // eases with speed
    this.locked = false;
    this.stick = new THREE.Vector2(); // analog input: x = strafe, y = forward, length 0..1
    this.moveDir = new THREE.Vector3(); // reused each frame (no per-frame garbage)
    this.levelPitch = false; // one-thumb touch steering: ease the view to follow the ground ahead
    this.slopePitch = 0; // smoothed pitch of the ground ahead (radians)
    this.spin = new THREE.Vector2(); // look glide after a released swipe (rad/s, decays)
    // Gaze attractors: things worth looking at (the note on the cabin table...) that ease the view's tilt toward
    // themselves when you're close and facing them (addGaze). Looking up or down yourself lets go of one until you
    // walk away from it.
    this.gaze = [];
    this.gazeS = 0; // the strongest pull now (0..1) and the tilt it wants
    this.gazePitch = 0;
    // a crouch (0..1): eye level only, eased; set from outside (main.js: in the cave)
    this.crouchTarget = 0;
    this.crouch = 0;
    this.pitchInput = 0; // how far the player tilted the view themselves this frame (rad)

    camera.rotation.order = 'YXZ';

    document.addEventListener('keydown', (e) => this.keys.add(e.code));
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (this.locked) this.look(e.movementX * 0.0022, e.movementY * 0.0022);
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) this.keys.clear();
    });
  }

  look(dx, dy) {
    this.pitchInput += Math.abs(dy);
    this.yaw -= dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -1.45, 1.45);
  }

  /**
   * Something worth looking at: { pos (world, its point of interest), reach (m, horizontal: it starts to pull
   * within this), cone ([cos, cos]: the facing over which the pull fades in), low (where it
   * should end up on screen: 0 the middle, 1 the bottom edge; 0.4 = the top of the bottom third), active?() }.
   */
  addGaze(target) {
    this.gaze.push({ cone: [0.7, 0.9], low: 0.4, active: null, ...target, released: false });
  }

  /** The strongest gaze pull now: sets this.gazeS (0..1) and this.gazePitch. */
  attend() {
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const eye = this.pos.y + this.eye();
    this.gazeS = 0;
    for (const t of this.gaze) {
      const dx = t.pos.x - this.pos.x;
      const dz = t.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > t.reach || (t.active && !t.active())) {
        t.released = false;
        continue;
      }
      const s = THREE.MathUtils.smoothstep((fx * dx + fz * dz) / Math.max(d, 1e-3), t.cone[0], t.cone[1])
        * (1 - THREE.MathUtils.smoothstep(d, t.reach - 0.8, t.reach));
      if (s > 0.2 && this.pitchInput > 0.015) t.released = true; // (they're looking where they like; not mouse jitter)
      if (t.released || s <= this.gazeS) continue;
      this.gazeS = s;
      const toward = Math.atan2(t.pos.y - eye, Math.max(d, 0.35));
      const below = Math.atan(t.low * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)); // (not dead centre)
      this.gazePitch = Math.max(-1.1, toward + below);
    }
    this.pitchInput = 0;
  }

  lock() {
    this.dom.requestPointerLock?.();
  }

  place(x, z, yaw = 0, pitch = 0) {
    this.pos.set(x, 0, z);
    this.collide(this.pos, PLAYER.radius);
    this.pos.y = groundAt(this.pos.x, this.pos.z);
    this.yaw = yaw;
    this.pitch = pitch;
    this.syncCamera();
  }

  update(dt) {
    if (this.spin.x !== 0 || this.spin.y !== 0) {
      this.look(this.spin.x * dt, this.spin.y * dt);
      this.spin.multiplyScalar(Math.exp(-dt * 6));
      if (this.spin.lengthSq() < 1e-4) this.spin.set(0, 0);
    }
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let running = k.has('ShiftLeft') || k.has('ShiftRight');
    let fwdIn = fwd;
    let strafeIn = strafe;
    let throttle = 1;
    this.attend();
    if (this.levelPitch) {
      // look along the ground ahead rather than at the horizon: up a hill you
      // see the slope you're climbing, not the dirt in front of your face
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      // average gradient over the next 10 m (one sample would catch every bump and gully)
      const h0 = groundAt(this.pos.x, this.pos.z);
      let grade = 0;
      for (let d = 2; d <= 10; d += 2) grade += (groundAt(this.pos.x + fx * d, this.pos.z + fz * d) - h0) / d;
      let target = THREE.MathUtils.clamp(Math.atan(grade / 5) * 0.8, -0.55, 0.55);
      if (this.gazeS > 0) target += (this.gazePitch - target) * this.gazeS; // (something worth looking at wins)
      this.slopePitch += (target - this.slopePitch) * (1 - Math.exp(-dt * 3));
      this.pitch += (this.slopePitch - this.pitch) * (1 - Math.exp(-dt * 1.2));
    } else if (this.gazeS > 0) {
      this.pitch += (this.gazePitch - this.pitch) * (1 - Math.exp(-dt * 2)) * this.gazeS;
      this.slopePitch = this.pitch;
    }

    const stickLen = Math.min(1, this.stick.length());
    if (stickLen > 0.12) {
      // thumbstick: gentle push walks (proportionally), pushing to the rim runs
      fwdIn = this.stick.y;
      strafeIn = this.stick.x;
      running = stickLen > 0.92;
      throttle = running ? 1 : Math.min(1, stickLen / 0.8);
    }

    const wading = waterDepth(this.pos.x, this.pos.z) > 0.4;
    let speed = running ? PLAYER.runSpeed : PLAYER.walkSpeed;
    if (wading) speed *= 0.45;
    speed *= throttle;

    const dir = this.moveDir.set(strafeIn, 0, -fwdIn);
    if (dir.lengthSq() > 0) dir.normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.yaw);
    const accel = this.onGround ? 12 : 2.5;
    const blend = 1 - Math.exp(-accel * dt);
    this.vel.x += (dir.x * speed - this.vel.x) * blend;
    this.vel.z += (dir.z * speed - this.vel.z) * blend;
    this.vel.y -= PLAYER.gravity * dt;

    const px = this.pos.x;
    const pz = this.pos.z;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;

    this.collide(this.pos, PLAYER.radius);
    // too deep to wade: slide along the edge (keep whichever axis stays in shallow enough water)
    if (waterDepth(this.pos.x, this.pos.z) > MAX_WADE && waterDepth(this.pos.x, this.pos.z) > waterDepth(px, pz)) {
      if (waterDepth(this.pos.x, pz) <= MAX_WADE) this.pos.z = pz;
      else if (waterDepth(px, this.pos.z) <= MAX_WADE) this.pos.x = px;
      else {
        this.pos.x = px;
        this.pos.z = pz;
      }
    }
    const lim = WORLD_SIZE / 2 - 5;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -lim, lim);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -lim, lim);

    const floor = groundAt(this.pos.x, this.pos.z);
    if (this.pos.y <= floor) {
      this.pos.y = floor;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.onGround && this.pos.y - floor < 0.6 && this.vel.y <= 0) {
      // stick to the ground when walking downhill
      this.pos.y = floor;
      this.vel.y = 0;
    } else {
      this.onGround = false;
    }

    const moving = Math.hypot(this.vel.x, this.vel.z);
    // Gait: the head dips once per footstep and sways a little toward the planted foot once
    // per stride. The game walks fast (5 m/s), so steps are sized for a natural cadence: ~2.1
    // steps/s walking, ~2.9 running. The motion eases in and out with speed, so stopping settles
    // instead of freezing mid-bob.
    if (this.onGround) this.bob += (dt * moving * 2 * Math.PI) / (1 + 0.27 * moving);
    const want = this.onGround ? Math.min(1, moving / PLAYER.walkSpeed) * (1 + 0.5 * Math.min(1, Math.max(0, moving - PLAYER.walkSpeed) / 6)) : 0;
    this.bobAmp += (want - this.bobAmp) * Math.min(1, dt * 6);
    this.crouch += (this.crouchTarget - this.crouch) * (1 - Math.exp(-dt * 5));
    this.syncCamera();
  }

  /** Eye height above the feet (lower crouched: 1.7 → 1.4 m). */
  eye() {
    return PLAYER.eyeHeight - 0.3 * this.crouch;
  }

  syncCamera() {
    const a = this.bobAmp;
    const stride = this.bob * 0.5; // two steps per stride
    const dip = (Math.cos(this.bob) - 1) * 0.5 * 0.035 * a; // 0 at mid-stance .. -3.5 cm at heel strike
    const sway = Math.sin(stride) * 0.012 * a;
    this.camera.position.set(
      this.pos.x + Math.cos(this.yaw) * sway,
      this.pos.y + this.eye() + dip,
      this.pos.z - Math.sin(this.yaw) * sway,
    );
    this.camera.rotation.set(this.pitch, this.yaw, Math.sin(stride) * 0.004 * a);
  }
}
