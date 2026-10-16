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
 * Two steps keep the GPU's work down:
 *  - refill (every REFILL_STEP m of travel): gather the candidates within the
 *    radius + MARGIN from a spatial grid
 *  - cull (whenever the view has turned or moved enough, see vegetation.js
 *    updateNear): of those, upload only the ones whose bounding sphere is in a
 *    widened view frustum, plus everything very close. The widening is larger
 *    than the turn that triggers a re-cull, so nothing is ever missing on screen.
 *
 * This is also where expensive close-up assets belong: the pool's size is
 * bounded by the radius, not by the size of the forest.
 */

const CELL = 20; // m, spatial grid for gathering instances
const REFILL_STEP = 4; // m of camera travel between refills
const MARGIN = 10; // m beyond the radius the pool also holds (>= REFILL_STEP)
const KEEP_NEAR = 10; // m: always drawn, whatever the view (things right beside you swing into view fast)

const cellKey = (gx, gz) => (gx + 32768) * 65536 + (gz + 32768);
const sphere = new THREE.Sphere();

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

    // world bounding sphere per instance: the model's (all parts) through its matrix
    const local = new THREE.Sphere();
    const box = new THREE.Box3();
    for (const { geometry } of parts) {
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox);
    }
    box.getBoundingSphere(local);
    this.spheres = new Float32Array(this.count * 4);
    const m = new THREE.Matrix4();
    const c = new THREE.Vector3();
    for (let i = 0; i < this.count; i++) {
      m.fromArray(matrices, i * 16);
      c.copy(local.center).applyMatrix4(m);
      this.spheres.set([c.x, c.y, c.z, local.radius * m.getMaxScaleOnAxis()], i * 4);
    }

    this.capacity = this.maxNearby(radius + MARGIN);
    this.candidates = new Int32Array(this.capacity);
    this.nCandidates = 0;
    // all parts share one matrix buffer (uploaded once per cull); colours differ per part
    const shared = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 16), 16);
    shared.setUsage(THREE.DynamicDrawUsage);
    this.meshes = parts.map(({ geometry, material }) => {
      const im = new THREE.InstancedMesh(geometry, material, this.capacity);
      im.instanceMatrix = shared;
      im.count = 0;
      im.frustumCulled = false; // culled per instance in cull()
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

  /** Re-gather the candidates if the camera has moved far enough. Returns true if it did. Allocation-free. */
  update(cam, radius, force = false) {
    if (!force && Math.hypot(cam.x - this.lastX, cam.z - this.lastZ) < REFILL_STEP) return false;
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
          if (dx * dx + dz * dz <= r2) this.candidates[n++] = i;
        }
      }
    }
    this.nCandidates = n;
    return true;
  }

  /**
   * Upload the candidates that can be seen: in `frustum` (already widened by
   * the caller) or within KEEP_NEAR of the camera. Allocation-free.
   */
  cull(frustum, cam) {
    const sp = this.spheres;
    const near2 = KEEP_NEAR * KEEP_NEAR;
    const mDst = this.meshes[0].instanceMatrix.array;
    let n = 0;
    for (let j = 0; j < this.nCandidates; j++) {
      const i = this.candidates[j];
      const dx = this.xz[i * 2] - cam.x;
      const dz = this.xz[i * 2 + 1] - cam.z;
      if (dx * dx + dz * dz > near2) {
        sphere.center.set(sp[i * 4], sp[i * 4 + 1], sp[i * 4 + 2]);
        sphere.radius = sp[i * 4 + 3];
        if (!frustum.intersectsSphere(sphere)) continue;
      }
      // plain copies: subarray() would allocate a view object per call
      for (let e = 0; e < 16; e++) mDst[n * 16 + e] = this.matrices[i * 16 + e];
      for (let p = 0; p < this.meshes.length; p++) {
        const cDst = this.meshes[p].instanceColor.array;
        const cSrc = this.colors[p];
        cDst[n * 3] = cSrc[i * 3];
        cDst[n * 3 + 1] = cSrc[i * 3 + 1];
        cDst[n * 3 + 2] = cSrc[i * 3 + 2];
      }
      n++;
    }
    const shared = this.meshes[0].instanceMatrix;
    shared.clearUpdateRanges();
    shared.addUpdateRange(0, n * 16);
    shared.needsUpdate = true;
    for (const im of this.meshes) {
      im.count = n;
      im.instanceColor.clearUpdateRanges();
      im.instanceColor.addUpdateRange(0, n * 3);
      im.instanceColor.needsUpdate = true;
    }
  }
}
