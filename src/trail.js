import * as THREE from 'three';
import { WATER_LEVEL } from './config.js';
import { heightAt, groundAt, snowAmount, slopeAt } from './terrain.js';

// The trail runs from the trailhead at the spawn point, down to a viewpoint on
// the lake's west shore, then climbs north through the forest to the one gentle
// ridge shoulder above the snowline.
export const TRAIL_STOPS = [
  { name: 'trailhead', label: 'Trailhead', x: 22, z: 652 },
  { name: 'lake', label: 'Lake viewpoint', x: 55, z: 385 },
  { name: 'ridge', label: 'Ridge viewpoint', x: 120, z: -510 },
];
export const TRAIL_WIDTH = 1.7;

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
        const k = `${gx},${gz}`;
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
    const list = segs.get(`${Math.floor(x / HASH)},${Math.floor(z / HASH)}`);
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

  return { points, stops, distanceTo, guide, mesh: buildTrailMesh(points) };
}

/** A ribbon draped over the terrain, dirt in the forest and packed snow up high. */
function buildTrailMesh(points) {
  const ACROSS = 4; // quads across the tread
  const positions = [];
  const colors = [];
  const uvs = [];
  const indices = [];
  const dirt = new THREE.Color(0x6b5034);
  const dirtWet = new THREE.Color(0x4a3824);
  const packed = new THREE.Color(0x8d99a8); // trodden, slushy snow reads darker than fresh powder
  const col = new THREE.Color();
  let along = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dir = next.clone().sub(prev).normalize();
    const normal = new THREE.Vector2(-dir.y, dir.x);
    if (i > 0) along += p.distanceTo(points[i - 1]);

    // the tread wanders slightly in width
    const w = TRAIL_WIDTH * (0.85 + 0.3 * (0.5 + 0.5 * Math.sin(along * 0.07) * Math.sin(along * 0.023)));
    const h0 = groundAt(p.x, p.y);
    const snow = snowAmount(p.x, p.y, h0, 0);
    for (let j = 0; j <= ACROSS; j++) {
      const s = j / ACROSS - 0.5;
      const x = p.x + normal.x * s * w * 2;
      const z = p.y + normal.y * s * w * 2;
      positions.push(x, groundAt(x, z) + 0.07, z);
      col.copy(dirt).lerp(dirtWet, Math.abs(s) * 1.6).lerp(packed, snow);
      colors.push(col.r, col.g, col.b);
      uvs.push(along, s * 2); // v: -1 (left edge) … 1 (right edge)
    }
    if (i > 0) {
      const r0 = (i - 1) * (ACROSS + 1);
      const r1 = i * (ACROSS + 1);
      for (let j = 0; j < ACROSS; j++) {
        indices.push(r0 + j, r0 + j + 1, r1 + j, r0 + j + 1, r1 + j + 1, r1 + j);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // Soft, ragged edges and a little gravel/mud texture, all in the shader.
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTrailUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTrailUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vTrailUv;
        float tHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
        float tNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x),
                     mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float edgeNoise = tNoise(vec2(vTrailUv.x * 0.9, vTrailUv.y * 2.0)) * 0.35;
        float edge = 1.0 - smoothstep(0.55, 1.0, abs(vTrailUv.y) + edgeNoise - 0.1);
        float grit = tNoise(vTrailUv * vec2(6.0, 9.0)) * 0.6 + tNoise(vTrailUv * vec2(1.3, 2.0)) * 0.4;
        diffuseColor.rgb *= 0.8 + grit * 0.4;
        diffuseColor.a *= edge;`);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'trail';
  mesh.renderOrder = 1;
  return mesh;
}
