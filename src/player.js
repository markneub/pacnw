import * as THREE from 'three';
import { PLAYER, WORLD_SIZE, WATER_LEVEL } from './config.js';
import { groundAt } from './terrain.js';

/**
 * First-person walker: mouse look via pointer lock, WASD/arrows to move,
 * Shift to run, Space to jump. Feet follow the terrain and are pushed out of
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

    camera.rotation.order = 'YXZ';

    document.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space' && this.onGround && this.locked) {
        this.vel.y = PLAYER.jumpSpeed;
        this.onGround = false;
      }
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.45, 1.45);
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) this.keys.clear();
    });
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
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const running = k.has('ShiftLeft') || k.has('ShiftRight');

    const ground = groundAt(this.pos.x, this.pos.z);
    const wading = ground < WATER_LEVEL - 0.4;
    let speed = running ? PLAYER.runSpeed : PLAYER.walkSpeed;
    if (wading) speed *= 0.45;

    const dir = new THREE.Vector3(strafe, 0, -fwd);
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
