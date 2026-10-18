import * as THREE from 'three';
import { PLAYER, WORLD_SIZE, WATER_LEVEL } from './config.js';
import { walkAt as groundAt } from './terrain.js'; // (footbridges included)

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
    this.bob = 0;
    this.locked = false;
    this.stick = new THREE.Vector2(); // analog input: x = strafe, y = forward, length 0..1
    this.moveDir = new THREE.Vector3(); // reused each frame (no per-frame garbage)
    this.levelPitch = false; // one-thumb touch steering: ease the view to follow the ground ahead
    this.slopePitch = 0; // smoothed pitch of the ground ahead (radians)
    this.spin = new THREE.Vector2(); // look glide after a released swipe (rad/s, decays)

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
    this.yaw -= dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -1.45, 1.45);
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
    if (this.levelPitch) {
      // look along the ground ahead rather than at the horizon: up a hill you
      // see the slope you're climbing, not the dirt in front of your face
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      // average gradient over the next 10 m (one sample would catch every bump and gully)
      const h0 = groundAt(this.pos.x, this.pos.z);
      let grade = 0;
      for (let d = 2; d <= 10; d += 2) grade += (groundAt(this.pos.x + fx * d, this.pos.z + fz * d) - h0) / d;
      const target = THREE.MathUtils.clamp(Math.atan(grade / 5) * 0.8, -0.55, 0.55);
      this.slopePitch += (target - this.slopePitch) * (1 - Math.exp(-dt * 3));
      this.pitch += (this.slopePitch - this.pitch) * (1 - Math.exp(-dt * 1.2));
    }

    const stickLen = Math.min(1, this.stick.length());
    if (stickLen > 0.12) {
      // thumbstick: gentle push walks (proportionally), pushing to the rim runs
      fwdIn = this.stick.y;
      strafeIn = this.stick.x;
      running = stickLen > 0.92;
      throttle = running ? 1 : Math.min(1, stickLen / 0.8);
    }

    const ground = groundAt(this.pos.x, this.pos.z);
    const wading = ground < WATER_LEVEL - 0.4;
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

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;

    this.collide(this.pos, PLAYER.radius);
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
    if (this.onGround) this.bob += dt * moving * 1.6;
    this.syncCamera(moving);
  }

  syncCamera(moving = 0) {
    const bob = Math.sin(this.bob) * Math.min(moving, 6) * 0.012;
    this.camera.position.set(this.pos.x, this.pos.y + PLAYER.eyeHeight + bob, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }
}
