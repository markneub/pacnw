import * as THREE from 'three';
import { WATER_LEVEL } from './config.js';
import {
  heightAt, rawGroundAt, groundAt, groundColor, groundLayers, snowAmount, slopeAt, setGroundModifier, setTerrainCutout,
} from './terrain.js';
import { shared, wetChunks, patchSunlight, sunKey } from './materials.js';
import { patchGroundDetail, groundDetailCacheKey } from './grounddetail.js';

// The trail runs from the trailhead at the spawn point, down to a viewpoint on
// the lake's west shore, then climbs north through the forest to the one gentle
// ridge shoulder above the snowline.
export const TRAIL_STOPS = [
  { name: 'trailhead', label: 'Trailhead', x: 22, z: 652 },
  { name: 'lake', label: 'Lake viewpoint', x: 55, z: 385 },
  { name: 'ridge', label: 'Ridge viewpoint', x: 120, z: -510 },
];
/** Numeric spatial-hash key (no string garbage in per-frame lookups). */
const cellKey = (gx, gz) => (gx + 32768) * 65536 + (gz + 32768);

export const TRAIL_WIDTH = 1.05; // half-width of the visible tread (it wanders ±15%)

// Cross-section of the bench cut into the hillside: level out to BENCH_HALF,
// then a cut bank (uphill) or fill slope (downhill) blending back into the
// natural ground by BANK_OUTER. The corridor mesh covers CORRIDOR_HALF, and the
// terrain mesh is hidden inside CUTOUT_HALF (the overlap hides the seam).
const BENCH_HALF = TRAIL_WIDTH * 1.15 + 0.15;
const BANK_OUTER = 4.2;
const CUTOUT_HALF = 4.7;
const CORRIDOR_HALF = 5.8;
const CORRIDOR_STEP = 0.5;
const BLEND_SIGMA = 0.7; // how sharply the nearest trail leg takes over (m)

// Routing grid (only covers the area the trail can plausibly use).
const CELL = 6;
const MIN_X = -350;
const MAX_X = 450;
const MIN_Z = -620;
const MAX_Z = 720;
const NX = Math.floor((MAX_X - MIN_X) / CELL) + 1;
const NZ = Math.floor((MAX_Z - MIN_Z) / CELL) + 1;

// 16 directions: the 8 neighbours plus knight moves, so the path isn't limited
// to 45° turns.
const MOVES = [];
for (let dz = -2; dz <= 2; dz++) {
  for (let dx = -2; dx <= 2; dx++) {
    const king = Math.max(Math.abs(dx), Math.abs(dz)) === 1;
    const knight = Math.abs(dx * dz) === 2;
    if (king || knight) MOVES.push([dx, dz, Math.hypot(dx, dz) * CELL]);
  }
}

/** Least-cost path between two points, preferring gentle grades (→ switchbacks). */
function route(heights, side, a, b) {
  const idx = (ix, iz) => iz * NX + ix;
  const toCell = (p) => [Math.round((p.x - MIN_X) / CELL), Math.round((p.z - MIN_Z) / CELL)];
  const [sx, sz] = toCell(a);
  const [tx, tz] = toCell(b);
  const start = idx(sx, sz);
  const goal = idx(tx, tz);

  const g = new Float32Array(NX * NZ).fill(Infinity);
  const from = new Int32Array(NX * NZ).fill(-1);
  const closed = new Uint8Array(NX * NZ);
  const heap = new MinHeap();
  g[start] = 0;
  heap.push(start, 0);

  while (heap.size) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % NX;
    const cz = (cur - cx) / NX;
    for (const [dx, dz, dist] of MOVES) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= NX || nz >= NZ) continue;
      const n = idx(nx, nz);
      if (closed[n]) continue;
      const h = heights[n];
      if (h < WATER_LEVEL + 1.2) continue;
      const grade = (h - heights[cur]) / dist;
      // steep grades cost a lot more than distance; side-slope makes the
      // tread hard to cut, so avoid traversing cliffs too
      const steep = Math.max(0, Math.abs(grade) - 0.18);
      const cost = dist * (1 + 40 * grade * grade + 2500 * steep * steep + 6 * side[n] * side[n]);
      const ng = g[cur] + cost;
      if (ng < g[n]) {
        g[n] = ng;
        from[n] = cur;
        const hx = (nx - tx) * CELL;
        const hz = (nz - tz) * CELL;
        heap.push(n, ng + Math.hypot(hx, hz));
      }
    }
  }

  const path = [];
  for (let c = goal; c !== -1; c = from[c]) {
    const cx = c % NX;
    path.push(new THREE.Vector2(MIN_X + cx * CELL, MIN_Z + ((c - cx) / NX) * CELL));
  }
  path.reverse();
  path[0].set(a.x, a.z);
  path[path.length - 1].set(b.x, b.z);
  return path;
}

class MinHeap {
  constructor() {
    this.items = [];
    this.prio = [];
  }

  get size() {
    return this.items.length;
  }

  push(item, p) {
    const { items, prio } = this;
    let i = items.length;
    items.push(item);
    prio.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prio[parent] <= p) break;
      items[i] = items[parent];
      prio[i] = prio[parent];
      i = parent;
    }
    items[i] = item;
    prio[i] = p;
  }

  pop() {
    const { items, prio } = this;
    const top = items[0];
    const lastItem = items.pop();
    const lastPrio = prio.pop();
    if (items.length) {
      let i = 0;
      const n = items.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && prio[c + 1] < prio[c]) c++;
        if (prio[c] >= lastPrio) break;
        items[i] = items[c];
        prio[i] = prio[c];
        i = c;
      }
      items[i] = lastItem;
      prio[i] = lastPrio;
    }
    return top;
  }
}

/** Chaikin corner cutting, keeping the end points. */
function chaikin(pts, iterations) {
  let p = pts;
  for (let k = 0; k < iterations; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      out.push(p[i].clone().lerp(p[i + 1], 0.25), p[i].clone().lerp(p[i + 1], 0.75));
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

function resample(pts, spacing) {
  const out = [pts[0].clone()];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = a.distanceTo(b);
    let t = spacing - carry;
    while (t <= len) {
      out.push(a.clone().lerp(b, t / len));
      t += spacing;
    }
    carry = len - (t - spacing);
  }
  out.push(pts[pts.length - 1].clone());
  return out;
}

/**
 * Build the trail: route it, then expose the centreline, a mesh draped on the
 * terrain, and distanceTo(x, z) for keeping vegetation off the tread.
 */
export function buildTrail() {
  const heights = new Float32Array(NX * NZ);
  const side = new Float32Array(NX * NZ);
  for (let iz = 0; iz < NZ; iz++) {
    for (let ix = 0; ix < NX; ix++) {
      const x = MIN_X + ix * CELL;
      const z = MIN_Z + iz * CELL;
      heights[iz * NX + ix] = heightAt(x, z);
      side[iz * NX + ix] = slopeAt(x, z);
    }
  }

  let coarse = [];
  for (let i = 0; i < TRAIL_STOPS.length - 1; i++) {
    const leg = route(heights, side, TRAIL_STOPS[i], TRAIL_STOPS[i + 1]);
    coarse = coarse.concat(i === 0 ? leg : leg.slice(1));
  }
  const points = resample(chaikin(coarse, 3), 1.5);

  // Spatial hash of centreline segments for distance queries.
  const HASH = 12;
  const segs = new Map();
  points.forEach((p, i) => {
    if (i === points.length - 1) return;
    const q = points[i + 1];
    const minX = Math.floor((Math.min(p.x, q.x) - 12) / HASH);
    const maxX = Math.floor((Math.max(p.x, q.x) + 12) / HASH);
    const minZ = Math.floor((Math.min(p.y, q.y) - 12) / HASH);
    const maxZ = Math.floor((Math.max(p.y, q.y) + 12) / HASH);
    for (let gz = minZ; gz <= maxZ; gz++) {
      for (let gx = minX; gx <= maxX; gx++) {
        const k = cellKey(gx, gz);
        if (!segs.has(k)) segs.set(k, []);
        segs.get(k).push(i);
      }
    }
  });

  /**
   * Closest centreline segment to (x, z): { d, i } with d = distance and i the
   * segment's start index. d is Infinity if the trail is more than ~12 m away.
   */
  function nearest(x, z) {
    const list = segs.get(cellKey(Math.floor(x / HASH), Math.floor(z / HASH)));
    let best = Infinity;
    let bestI = -1;
    if (!list) return { d: best, i: bestI };
    for (const i of list) {
      const a = points[i];
      const b = points[i + 1];
      const abx = b.x - a.x;
      const abz = b.y - a.y;
      const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.y) * abz) / (abx * abx + abz * abz), 0, 1);
      const d = Math.hypot(x - (a.x + abx * t), z - (a.y + abz * t));
      if (d < best) {
        best = d;
        bestI = i;
      }
    }
    return { d: best, i: bestI };
  }

  const distanceTo = (x, z) => nearest(x, z).d;

  const stops = TRAIL_STOPS.map((stop) => {
    let index = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = Math.hypot(p.x - stop.x, p.y - stop.z);
      if (d < bestD) {
        bestD = d;
        index = i;
      }
    });
    return { ...stop, index };
  });

  /**
   * Where the walker is relative to the trail, given their facing direction:
   * the next stop ahead and how far along the trail it is (metres), or null
   * when off the trail.
   */
  function guide(x, z, dirX, dirZ) {
    const { d, i } = nearest(x, z);
    if (d > TRAIL_WIDTH + 3) return null;
    const a = points[i];
    const b = points[i + 1];
    const forward = (b.x - a.x) * dirX + (b.y - a.y) * dirZ >= 0;
    const ahead = forward ? stops.filter((s) => s.index > i + 2) : stops.filter((s) => s.index < i - 1).reverse();
    const next = ahead[0];
    if (!next) return { next: null, metres: 0 };
    let metres = 0;
    const [lo, hi] = forward ? [i, next.index] : [next.index, i];
    for (let k = lo; k < hi; k++) metres += points[k].distanceTo(points[k + 1]);
    return { next, metres };
  }

  // --- bench cut ---------------------------------------------------------------
  // Tread height along the centreline: natural ground, smoothed along the trail
  // so the walking surface has no 5 m-grid kinks.
  const raw = points.map((p) => rawGroundAt(p.x, p.y));
  const tread = raw.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - 4); k <= Math.min(raw.length - 1, i + 4); k++) {
      sum += raw[k];
      n++;
    }
    return sum / n;
  });

  /**
   * Ground height with the bench cut in. Each nearby centreline segment pulls
   * the ground toward its tread height. The closest segment dominates (sharp
   * Gaussian weights), so where switchback legs pass close each tread stays
   * level and the ground between them becomes a short bank, still continuous.
   */
  function benchHeight(x, z, g) {
    const list = segs.get(cellKey(Math.floor(x / HASH), Math.floor(z / HASH)));
    if (!list) return g;
    let acc = 0;
    let wsum = 0;
    for (const i of list) {
      const a = points[i];
      const b = points[i + 1];
      const abx = b.x - a.x;
      const abz = b.y - a.y;
      const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.y) * abz) / (abx * abx + abz * abz), 0, 1);
      const d = Math.hypot(x - (a.x + abx * t), z - (a.y + abz * t));
      if (d >= BANK_OUTER) continue;
      const keep = THREE.MathUtils.smoothstep(d, BENCH_HALF, BANK_OUTER); // 0 on the tread, 1 outside
      const w = Math.exp(-(d * d) / (BLEND_SIGMA * BLEND_SIGMA));
      const hc = tread[i] + (tread[i + 1] - tread[i]) * t;
      acc += w * (hc - g) * (1 - keep);
      wsum += w;
    }
    return wsum > 0 ? g + acc / wsum : g;
  }
  setGroundModifier(benchHeight);

  const mesh = buildCorridorMesh(points, distanceTo);
  setTerrainCutout(...buildCutoutMask(points, distanceTo));

  return { points, stops, distanceTo, guide, mesh };
}

/**
 * Mask over the trail's bounding box (1 texel per metre): 1 where the terrain
 * mesh should be hidden because the corridor mesh replaces it.
 */
function buildCutoutMask(points, distanceTo) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.y);
    maxZ = Math.max(maxZ, p.y);
  }
  const pad = CORRIDOR_HALF + 2;
  minX = Math.floor(minX - pad);
  minZ = Math.floor(minZ - pad);
  const w = Math.ceil(maxX + pad) - minX;
  const h = Math.ceil(maxZ + pad) - minZ;
  const data = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      // texel centres
      if (distanceTo(minX + i + 0.5, minZ + j + 0.5) < CUTOUT_HALF) data[j * w + i] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return [tex, minX, minZ, w, h];
}

/**
 * The trail corridor: a fine strip of ground that replaces the terrain mesh
 * along the trail, carrying the level tread, the cut banks and fill slopes,
 * and fading out at its edges where it meets the untouched terrain.
 */
function buildCorridorMesh(points, distanceTo) {
  const across = Math.round((CORRIDOR_HALF * 2) / CORRIDOR_STEP);
  const positions = [];
  const colors = [];
  const treadAttr = [];
  const layers = [];
  const lw = [0, 0, 0, 0];
  const indices = [];
  const dirt = new THREE.Color(0x6b5034);
  const dirtWet = new THREE.Color(0x4a3824);
  const packed = new THREE.Color(0x8d99a8); // trodden, slushy snow reads darker than fresh powder
  const soil = new THREE.Color(0x5a4430);
  const col = new THREE.Color();
  const tmp = new THREE.Color();
  const e = 1;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dir = next.clone().sub(prev).normalize();
    const nx = -dir.y;
    const nz = dir.x;

    for (let j = 0; j <= across; j++) {
      const u = -CORRIDOR_HALF + j * CORRIDOR_STEP;
      const x = p.x + nx * u;
      const z = p.y + nz * u;
      const g = rawGroundAt(x, z);
      const y = groundAt(x, z);
      positions.push(x, y + 0.02, z);

      // colour: the ground as it would be, then exposed soil where the bank is
      // cut or filled, then the tread itself (all from world position, so
      // overlapping switchback strips agree)
      const naturalSlope = 1 - 2 * e / Math.hypot(
        rawGroundAt(x + e, z) - rawGroundAt(x - e, z), 2 * e, rawGroundAt(x, z + e) - rawGroundAt(x, z - e),
      );
      groundColor(x, g, z, naturalSlope, col);
      groundLayers(x, g, z, naturalSlope, lw);
      const snow = snowAmount(x, z, g, 0);
      const d = distanceTo(x, z);
      const cut = Math.abs(y - g);
      tmp.copy(soil).lerp(dirtWet, Math.min(1, cut / 3) * 0.5);
      col.lerp(tmp, THREE.MathUtils.smoothstep(cut, 0.15, 0.9) * 0.75 * (1 - snow * 0.85));

      const wobble = Math.sin(x * 0.31 + z * 0.17) * 0.18 + Math.sin(x * 0.07 - z * 0.11) * 0.2;
      const t = 1 - THREE.MathUtils.smoothstep(d + wobble, TRAIL_WIDTH - 0.3, TRAIL_WIDTH + 0.25);
      tmp.copy(dirt).lerp(dirtWet, Math.min(1, d / TRAIL_WIDTH) * 0.6).lerp(packed, snow);
      col.lerp(tmp, t);

      // detail layers: exposed soil on the banks and the tread itself read as dirt
      const dirtW = Math.max(t, THREE.MathUtils.smoothstep(cut, 0.15, 0.9) * 0.75) * (1 - snow * 0.85);
      layers.push(lw[0] * (1 - dirtW), lw[1] * (1 - dirtW), lw[2] * (1 - dirtW), lw[3] * (1 - dirtW) + dirtW);

      // fade the strip's outer edge into the terrain beneath
      const alpha = 1 - THREE.MathUtils.smoothstep(Math.abs(u), CUTOUT_HALF + 0.3, CORRIDOR_HALF);
      colors.push(col.r, col.g, col.b, alpha);
      treadAttr.push(t);
    }
    if (i > 0) {
      const r0 = (i - 1) * (across + 1);
      const r1 = i * (across + 1);
      for (let j = 0; j < across; j++) {
        // wound so faces point up (+Y)
        indices.push(r0 + j, r0 + j + 1, r1 + j, r0 + j + 1, r1 + j + 1, r1 + j);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geo.setAttribute('aTread', new THREE.Float32BufferAttribute(treadAttr, 1));
  geo.setAttribute('aLayers', new THREE.Float32BufferAttribute(layers, 4));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  // Same mottling as the terrain shader so the two match, plus grit on the tread.
  const wet = wetChunks(0.9);
  mat.onBeforeCompile = (shader) => {
    patchSunlight(shader);
    shader.uniforms.uWet = shared.uWet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTread;\nvarying float vTread;\nvarying vec3 vGroundPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTread = aTread;\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTread;
        varying vec3 vGroundPos;
        uniform float uWet;
        float puddle;
        float gHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float gNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x),
                     mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gn = gNoise(vGroundPos.xz * 0.9) * 0.5 + gNoise(vGroundPos.xz * 0.23) * 0.35 + gNoise(vGroundPos.xz * 3.1) * 0.15;
        diffuseColor.rgb *= 0.78 + gn * 0.44;
        float grit = gNoise(vGroundPos.xz * 7.0) * 0.6 + gNoise(vGroundPos.xz * 2.2) * 0.4;
        diffuseColor.rgb *= mix(1.0, 0.82 + grit * 0.36, vTread);
        ${wet.color}
        // puddles collect in low spots of the tread when it's wet
        puddle = smoothstep(0.6, 0.7, gNoise(vGroundPos.xz * 0.45 + 3.7) * 0.7 + gNoise(vGroundPos.xz * 1.7) * 0.3)
          * smoothstep(0.55, 0.9, vTread) * smoothstep(0.5, 0.9, uWet);
        diffuseColor.rgb *= mix(1.0, 0.5, puddle);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        ${wet.roughness}
        roughnessFactor = mix(roughnessFactor, 0.04, puddle);`);
    patchGroundDetail(shader);
  };
  mat.customProgramCacheKey = () => `${groundDetailCacheKey()}|${sunKey()}`;

  // Split into ~150 m segments so off-screen stretches are frustum-culled.
  // Normals come from the full strip, so segment joins don't show.
  const rowLen = across + 1;
  const rows = points.length;
  const SEG = 100; // rows per segment (1.5 m each)
  const group = new THREE.Group();
  group.name = 'trail';
  for (let r0 = 0; r0 < rows - 1; r0 += SEG) {
    const r1 = Math.min(rows - 1, r0 + SEG);
    const v0 = r0 * rowLen;
    const v1 = (r1 + 1) * rowLen;
    const part = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'color', 'aTread', 'aLayers']) {
      const attr = geo.attributes[name];
      part.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(v0 * attr.itemSize, v1 * attr.itemSize), attr.itemSize));
    }
    const idx = [];
    for (let i = 1; i <= r1 - r0; i++) {
      const a = (i - 1) * rowLen;
      const b = i * rowLen;
      for (let j = 0; j < across; j++) idx.push(a + j, a + j + 1, b + j, a + j + 1, b + j + 1, b + j);
    }
    part.setIndex(idx);
    part.computeBoundingSphere();
    const mesh = new THREE.Mesh(part, mat);
    mesh.name = `trail ${r0}`;
    group.add(mesh);
  }
  geo.dispose();
  return group;
}
