import * as THREE from 'three';

/**
 * The "near ring": full-detail models for the instances within a radius of
 * the camera, held in fixed-capacity InstancedMeshes that are refilled as the
 * walker moves. Everything further away is drawn by cheap far-LOD chunks.
 *
 * Both tiers decide visibility per instance in the vertex shader from the same
 * radius uniform (see patchLod in materials.js), so they are exact complements:
 * every tree is drawn once, at one level of detail. The pool only has to hold
 * a superset of the instances inside the radius, which is why it can refill
 * lazily (every few metres of movement) without anything popping.
 *
 * This is also where expensive close-up assets belong: the pool's size is
 * bounded by the radius, not by the size of the forest.
 */

const CELL = 20; // m, spatial grid for gathering instances
const REFILL_STEP = 4; // m of camera travel between refills
const MARGIN = 10; // m beyond the radius the pool also holds (>= REFILL_STEP)

const cellKey = (gx, gz) => (gx + 32768) * 65536 + (gz + 32768);

export class NearPool {
  /**
   * @param parts    [{geometry, material}] full-detail model
   * @param matrices Float32Array, 16 per instance (world matrices)
   * @param colors   per part: Float32Array, 3 per instance (instance colours)
   * @param xz       Float32Array, 2 per instance (positions, for gathering)
   */
  constructor(parts, matrices, colors, xz, radius) {
    this.matrices = matrices;
    this.colors = colors;
    this.xz = xz;
    this.count = xz.length / 2;

    this.grid = new Map();
    for (let i = 0; i < this.count; i++) {
      const k = cellKey(Math.floor(xz[i * 2] / CELL), Math.floor(xz[i * 2 + 1] / CELL));
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(i);
    }

    this.capacity = this.maxNearby(radius + MARGIN);
    this.meshes = parts.map(({ geometry, material }) => {
      const im = new THREE.InstancedMesh(geometry, material, this.capacity);
      im.count = 0;
      im.frustumCulled = false; // contents move around; the GPU clips
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, new THREE.Color(1, 1, 1)); // allocate instanceColor
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      return im;
    });
    this.lastX = Infinity;
    this.lastZ = Infinity;
  }

  /** Upper bound on instances within `r` of any point (square windows over the grid). */
  maxNearby(r) {
    const span = Math.ceil(r / CELL) + 1;
    let best = 0;
    for (const k of this.grid.keys()) {
      const gx = Math.floor(k / 65536) - 32768;
      const gz = (k % 65536) - 32768;
      let n = 0;
      for (let dz = -span; dz <= span; dz++) {
        for (let dx = -span; dx <= span; dx++) {
          const list = this.grid.get(cellKey(gx + dx, gz + dz));
          if (list) n += list.length;
        }
      }
      if (n > best) best = n;
    }
    return Math.max(1, Math.min(best, this.count));
  }

  /** Refill if the camera has moved far enough. Allocation-free. */
  update(cam, radius, force = false) {
    if (!force && Math.hypot(cam.x - this.lastX, cam.z - this.lastZ) < REFILL_STEP) return;
    this.lastX = cam.x;
    this.lastZ = cam.z;

    const r = radius + MARGIN;
    const r2 = r * r;
    const g0x = Math.floor((cam.x - r) / CELL);
    const g1x = Math.floor((cam.x + r) / CELL);
    const g0z = Math.floor((cam.z - r) / CELL);
    const g1z = Math.floor((cam.z + r) / CELL);
    let n = 0;
    for (let gz = g0z; gz <= g1z; gz++) {
      for (let gx = g0x; gx <= g1x; gx++) {
        const list = this.grid.get(cellKey(gx, gz));
        if (!list) continue;
        for (let j = 0; j < list.length && n < this.capacity; j++) {
          const i = list[j];
          const dx = this.xz[i * 2] - cam.x;
          const dz = this.xz[i * 2 + 1] - cam.z;
          if (dx * dx + dz * dz > r2) continue;
          // plain copies: subarray() would allocate a view object per call
          for (let p = 0; p < this.meshes.length; p++) {
            const mDst = this.meshes[p].instanceMatrix.array;
            for (let e = 0; e < 16; e++) mDst[n * 16 + e] = this.matrices[i * 16 + e];
            const cDst = this.meshes[p].instanceColor.array;
            const cSrc = this.colors[p];
            cDst[n * 3] = cSrc[i * 3];
            cDst[n * 3 + 1] = cSrc[i * 3 + 1];
            cDst[n * 3 + 2] = cSrc[i * 3 + 2];
          }
          n++;
        }
      }
    }
    for (const im of this.meshes) {
      im.count = n;
      im.instanceMatrix.clearUpdateRanges();
      im.instanceMatrix.addUpdateRange(0, n * 16);
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.clearUpdateRanges();
      im.instanceColor.addUpdateRange(0, n * 3);
      im.instanceColor.needsUpdate = true;
    }
  }
}
