import * as THREE from 'three';
import { WORLD_SIZE } from './config.js';
import { rawGroundAt } from './terrain.js';

// Lighting baked at load time. None of this costs anything per frame: it ends
// up in vertex colours and instance tints. It works from geometry alone, so it
// keeps working if the procedural models are swapped for other assets.

const smooth = THREE.MathUtils.smoothstep;

/**
 * Per-vertex ambient occlusion for a prototype (all its parts together):
 * dark at the base and in the crown's interior, light at the outer tips.
 * Stored as a vertex colour that multiplies the material colour.
 */
export function bakePrototypeAO(parts, kind) {
  const box = new THREE.Box3();
  for (const { geometry } of parts) {
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
  }
  const height = Math.max(0.01, box.max.y - Math.max(0, box.min.y));

  // widest extent at each height band, to judge how "inside" a vertex is
  const BINS = 16;
  const reach = new Float32Array(BINS).fill(1e-3);
  const bin = (y) => Math.min(BINS - 1, Math.max(0, Math.floor((y / height) * BINS)));
  for (const { geometry } of parts) {
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const b = bin(pos.getY(i));
      reach[b] = Math.max(reach[b], Math.hypot(pos.getX(i), pos.getZ(i)));
    }
  }

  for (const { geometry, material } of parts) {
    const pos = geometry.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    // models may already carry colours (far-LOD trees bake their materials
    // into vertex colours): multiply rather than replace
    const base = geometry.attributes.color;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const t = Math.max(0, y) / height;
      let ao;
      if (kind === 'trees') {
        const radial = Math.min(1, Math.hypot(pos.getX(i), pos.getZ(i)) / reach[bin(y)]);
        ao = (0.42 + 0.58 * smooth(t, 0, 0.75)) * (0.62 + 0.38 * radial);
      } else if (kind === 'ferns') {
        ao = 0.55 + 0.45 * smooth(t, 0, 1);
      } else {
        ao = 0.5 + 0.5 * smooth(t, 0, 0.6);
      }
      colors[i * 3] = ao * (base ? base.getX(i) : 1);
      colors[i * 3 + 1] = ao * (base ? base.getY(i) : 1);
      colors[i * 3 + 2] = ao * (base ? base.getZ(i) : 1);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    material.vertexColors = true;
  }
}

// Approximate crown radius (m, at scale 1) for canopy shading.
const CROWN = {
  fir: 3.3, fir_snow: 4.4, hemlock: 4.2, hemlock_snow: 4, cedar: 5.2,
  sapling: 1.6, sapling_snow: 1.6, snag: 0.8,
};

/**
 * How shaded each spot is by the forest canopy, from the tree placements.
 * Returns occlusionAt(x, z) in 0 (open sky) .. 1 (deep shade).
 */
export function bakeCanopy(placements) {
  const RES = 2; // metres per cell
  const N = WORLD_SIZE / RES;
  const half = WORLD_SIZE / 2;
  let grid = new Float32Array(N * N);

  for (const [name, list] of Object.entries(placements)) {
    const crown = CROWN[name];
    if (!crown) continue;
    for (const p of list) {
      const r = crown * p.scale;
      const cx = (p.x + half) / RES;
      const cz = (p.z + half) / RES;
      const rc = r / RES;
      for (let z = Math.max(0, Math.floor(cz - rc)); z <= Math.min(N - 1, Math.ceil(cz + rc)); z++) {
        for (let x = Math.max(0, Math.floor(cx - rc)); x <= Math.min(N - 1, Math.ceil(cx + rc)); x++) {
          const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz) / rc;
          if (d < 1) grid[z * N + x] += 0.55 * (1 - d * d) * Math.min(1.3, p.scale);
        }
      }
    }
  }

  // two box-blur passes soften the shade under the crowns
  const tmp = new Float32Array(N * N);
  for (let pass = 0; pass < 2; pass++) {
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        let s = 0;
        let n = 0;
        for (let k = -2; k <= 2; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < N) {
            s += grid[z * N + xx];
            n++;
          }
        }
        tmp[z * N + x] = s / n;
      }
    }
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        let s = 0;
        let n = 0;
        for (let k = -2; k <= 2; k++) {
          const zz = z + k;
          if (zz >= 0 && zz < N) {
            s += tmp[zz * N + x];
            n++;
          }
        }
        grid[z * N + x] = s / n;
      }
    }
  }
  for (let i = 0; i < grid.length; i++) grid[i] = 1 - Math.exp(-grid[i] * 1.1);

  return function occlusionAt(x, z) {
    const gx = THREE.MathUtils.clamp((x + half) / RES - 0.5, 0, N - 1.001);
    const gz = THREE.MathUtils.clamp((z + half) / RES - 0.5, 0, N - 1.001);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const a = grid[iz * N + ix];
    const b = grid[iz * N + ix + 1];
    const c = grid[(iz + 1) * N + ix];
    const d = grid[(iz + 1) * N + ix + 1];
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  };
}

const DIRS = Array.from({ length: 8 }, (_, i) => [Math.cos((i / 8) * Math.PI * 2), Math.sin((i / 8) * Math.PI * 2)]);
const STEPS = [3, 7, 14, 28, 50];

/** Sky visibility from the terrain alone: hollows and gullies get less light. */
export function horizonAO(x, z, h0 = rawGroundAt(x, z)) {
  let occ = 0;
  for (const [dx, dz] of DIRS) {
    let maxSlope = 0;
    for (const s of STEPS) {
      const slope = (rawGroundAt(x + dx * s, z + dz * s) - h0) / s;
      if (slope > maxSlope) maxSlope = slope;
    }
    occ += maxSlope / Math.sqrt(1 + maxSlope * maxSlope); // sin of the horizon angle
  }
  return 1 - 0.75 * (occ / DIRS.length);
}

/**
 * Darken a ground mesh's vertex colours by terrain AO and canopy shade.
 * Works on the terrain (RGB) and the trail corridor (RGBA).
 */
export function shadeGround(object, canopyAt) {
  object.traverse((o) => {
    if (o.isMesh) shadeMesh(o, canopyAt);
  });
}

function shadeMesh(mesh, canopyAt) {
  const pos = mesh.geometry.attributes.position;
  const col = mesh.geometry.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const shade = horizonAO(x, z) * (1 - 0.6 * canopyAt(x, z));
    col.setXYZ(i, col.getX(i) * shade, col.getY(i) * shade, col.getZ(i) * shade);
  }
  col.needsUpdate = true;
}
