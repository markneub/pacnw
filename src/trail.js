import * as THREE from 'three';
import { WATER_LEVEL } from './config.js';
import {
  heightAt, rawGroundAt, groundAt, groundColor, groundLayers, snowAmount, slopeAt, setGroundModifier, setTerrainCutout,
  streams, setWalkModifier,
} from './terrain.js';
import { shared, wetChunks, patchSunlight, sunKey, patchPuddles } from './materials.js';
import { patchGroundDetail, groundDetailCacheKey } from './grounddetail.js';

// The trail runs from the trailhead at the spawn point, down to a viewpoint on
// the lake's west shore, then climbs north through the forest onto the lower
// snow bench and up again into the high basin below the pass.
export const TRAIL_STOPS = [
  { name: 'trailhead', label: 'Trailhead', x: 22, z: 652 },
  { name: 'lake', label: 'Lake viewpoint', x: 55, z: 385 },
  { name: 'snowfield', label: 'Snowfield', x: 110, z: -540 },
  { name: 'basin', label: 'High basin', x: 70, z: -920 },
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
const MIN_Z = -1010;
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
    const h = wsum > 0 ? g + acc / wsum : g;
    // where the trail crosses a stream, the stream's channel cuts through the tread (a footbridge
    // spans it) instead of the tread damming it like a culvert
    const c = streams().nearest(x, z);
    if (!c.seg || h <= g) return h;
    const cut = 1 - THREE.MathUtils.smoothstep(c.d, c.half + 0.4, c.half + 2.2);
    return h + (g - h) * cut;
  }
  setGroundModifier(benchHeight);

  const mesh = buildCorridorMesh(points, distanceTo);
  setTerrainCutout(...buildCutoutMask(mesh.userData.cover));
  delete mesh.userData.cover;

  // footbridges where the trail crosses a stream: deck level with the tread on both banks
  const crossings = [];
  for (let i = 0, wet = false; i < points.length; i++) {
    const c = streams().nearest(points[i].x, points[i].y);
    const now = !!c.seg && c.d < c.half + 0.5;
    if (now && !wet) {
      // the middle of the wet run
      let j = i;
      while (j + 1 < points.length) {
        const cj = streams().nearest(points[j + 1].x, points[j + 1].y);
        if (!cj.seg || cj.d >= cj.half + 0.5) break;
        j++;
      }
      const m = Math.round((i + j) / 2);
      const a = points[Math.max(0, m - 2)];
      const b = points[Math.min(points.length - 1, m + 2)];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      const dx = (b.x - a.x) / l;
      const dz = (b.y - a.y) / l;
      const cm = streams().nearest(points[m].x, points[m].y);
      const span = 2 * (cm.half + 2.4);
      const ends = [-1, 1].map((k) => groundAt(points[m].x + dx * k * span / 2, points[m].y + dz * k * span / 2));
      // the deck follows the trail's grade from bank to bank
      crossings.push({ x: points[m].x, z: points[m].y, dx, dz, span, deck: (ends[0] + ends[1]) / 2 + 0.06, rise: ends[1] - ends[0] });
    }
    wet = now;
  }
  setWalkModifier((x, z, g) => {
    for (const b of crossings) {
      const ox = x - b.x;
      const oz = z - b.z;
      const along = ox * b.dx + oz * b.dz;
      const across = -ox * b.dz + oz * b.dx;
      if (Math.abs(along) < b.span / 2 && Math.abs(across) < 0.85) return Math.max(g, b.deck + (b.rise * along) / b.span);
    }
    return g;
  });

  return { points, stops, distanceTo, guide, mesh, crossings };
}

/**
 * Mask over the trail's bounding box (1 texel per metre): 1 where the terrain
 * mesh should be hidden because the corridor mesh replaces it.
 *
 * Built from the corridor's own triangles, so it can never cut a hole: a texel
 * is cut only if it lies under a triangle of the strip that is fully opaque
 * (all three corners inside the faded edge) and faces up (where the strip folds
 * back on the inside of a tight switchback, its flipped triangles are culled),
 * then the mask is eroded by a texel, because the shader samples it bilinearly.
 * (A mask from distanceTo() alone left holes at the trail's ends and at
 * switchbacks: tools/holecheck.mjs finds them.)
 */
function buildCutoutMask(cover) {
  const { positions, alphas, indices } = cover;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  minX = Math.floor(minX - 2);
  minZ = Math.floor(minZ - 2);
  const w = Math.ceil(maxX + 2) - minX;
  const h = Math.ceil(maxZ + 2) - minZ;
  const covered = new Uint8Array(w * h);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    if (alphas[a] < 0.999 || alphas[b] < 0.999 || alphas[c] < 0.999) continue;
    const ax = positions[a * 3]; const az = positions[a * 3 + 2];
    const bx = positions[b * 3]; const bz = positions[b * 3 + 2];
    const cx = positions[c * 3]; const cz = positions[c * 3 + 2];
    // facing up: the y of (b - a) x (c - a)
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (ny <= 1e-6) continue;
    // texel centres inside the triangle (in xz)
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - minX));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) - minX));
    const z0 = Math.max(0, Math.floor(Math.min(az, bz, cz) - minZ));
    const z1 = Math.min(h - 1, Math.ceil(Math.max(az, bz, cz) - minZ));
    const edge = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
    const area = edge(ax, az, bx, bz, cx, cz);
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) {
        const px = minX + i + 0.5;
        const pz = minZ + j + 0.5;
        const e0 = edge(ax, az, bx, bz, px, pz) * area;
        const e1 = edge(bx, bz, cx, cz, px, pz) * area;
        const e2 = edge(cx, cz, ax, az, px, pz) * area;
        if (e0 >= 0 && e1 >= 0 && e2 >= 0) covered[j * w + i] = 1;
      }
    }
  }
  // erode: keep a texel only if it and its 8 neighbours are covered
  const data = new Uint8Array(w * h);
  for (let j = 1; j < h - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      let all = 1;
      for (let dj = -1; dj <= 1 && all; dj++) for (let di = -1; di <= 1; di++) if (!covered[(j + dj) * w + i + di]) { all = 0; break; }
      if (all) data[j * w + i] = 255;
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
  const tmpSnow = new THREE.Color();
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
      // (in snow a softer edge and a boot-packed groove down the middle, over the snow's own colour:
      // a flat grey-blue fill read as a painted stripe)
      const edge = 0.3 + 0.5 * snow;
      const t = 1 - THREE.MathUtils.smoothstep(d + wobble, TRAIL_WIDTH - edge, TRAIL_WIDTH + edge);
      const groove = 1 - Math.min(1, d / TRAIL_WIDTH) ** 2;
      tmp.copy(dirt).lerp(dirtWet, Math.min(1, d / TRAIL_WIDTH) * 0.6);
      tmpSnow.copy(col).lerp(packed, 0.4 + 0.45 * groove);
      tmp.lerp(tmpSnow, snow);
      col.lerp(tmp, t);

      // detail layers: exposed soil on the banks and the tread itself read as dirt
      const dirtW = Math.max(t, THREE.MathUtils.smoothstep(cut, 0.15, 0.9) * 0.75) * (1 - snow * 0.85);
      layers.push(lw[0] * (1 - dirtW), lw[1] * (1 - dirtW), lw[2] * (1 - dirtW), lw[3] * (1 - dirtW) + dirtW);

      // fade the strip's outer edge into the terrain beneath
      const alpha = 1 - THREE.MathUtils.smoothstep(Math.abs(u), CUTOUT_HALF + 0.3, CORRIDOR_HALF);
      colors.push(col.r, col.g, col.b, alpha);
      treadAttr.push(t * (1 - 0.7 * snow)); // (less dark grit on trodden snow)
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
    transparent: false, // the opaque interior; the faded fringe uses fringeMat (below)
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  // Same mottling as the terrain shader so the two match, plus grit on the tread.
  const wet = wetChunks(0.9);
  mat.onBeforeCompile = (shader) => {
    patchSunlight(shader);
    shader.uniforms.uWet = shared.uWet;
    shader.uniforms.uPuddle = shared.uPuddle;
    shader.uniforms.uSnowline = shared.uSnowline;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTread;\nvarying float vTread;\nvarying vec3 vGroundPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTread = aTread;\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTread;
        varying vec3 vGroundPos;
        uniform float uWet;
        uniform float uPuddle;
        uniform float uSnowline;
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
        // puddles collect in low spots of the tread in rain, growing as they fill (not up in the snow)
        float pt = 0.76 - 0.16 * uPuddle;
        puddle = smoothstep(pt, pt + 0.05, gNoise(vGroundPos.xz * 0.45 + 3.7) * 0.7 + gNoise(vGroundPos.xz * 1.7) * 0.3)
          * smoothstep(0.55, 0.9, vTread) * smoothstep(0.03, 0.25, uPuddle) * (1.0 - smoothstep(uSnowline - 35.0, uSnowline - 15.0, vGroundPos.y));
        diffuseColor.rgb *= mix(1.0, 0.5, puddle);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        ${wet.roughness}
        roughnessFactor = mix(roughnessFactor, 0.04, puddle);`);
    patchGroundDetail(shader);
    patchPuddles(shader);
  };
  mat.customProgramCacheKey = () => `${groundDetailCacheKey()}|${sunKey()}`;
  // The faded outer fringe blends over the terrain, so it's transparent, and it must not write
  // depth: where switchback legs overlap, a fringe drawn first used to hide the leg beneath it,
  // and with the terrain cut away there the sky showed through (tools/holecheck.mjs).
  const fringeMat = mat.clone();
  fringeMat.transparent = true;
  fringeMat.depthWrite = false;
  fringeMat.onBeforeCompile = mat.onBeforeCompile;
  fringeMat.customProgramCacheKey = mat.customProgramCacheKey;
  const opaqueTri = (alpha, a, b, c) => alpha[a] > 0.999 && alpha[b] > 0.999 && alpha[c] > 0.999;

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
    const alpha = part.attributes.color.array.filter((_, k) => k % 4 === 3);
    const solid = [];
    const fringe = [];
    for (let i = 1; i <= r1 - r0; i++) {
      const a = (i - 1) * rowLen;
      const b = i * rowLen;
      for (let j = 0; j < across; j++) {
        for (const [p, q, r] of [[a + j, a + j + 1, b + j], [a + j + 1, b + j + 1, b + j]]) {
          (opaqueTri(alpha, p, q, r) ? solid : fringe).push(p, q, r);
        }
      }
    }
    part.setIndex([...solid, ...fringe]);
    part.addGroup(0, solid.length, 0);
    part.addGroup(solid.length, fringe.length, 1);
    part.computeBoundingSphere();
    const mesh = new THREE.Mesh(part, [mat, fringeMat]);
    mesh.name = `trail ${r0}`;
    group.add(mesh);
  }
  // Skirts: a wall hanging 3 m down from the strip's opaque boundary (|u| = 4.8 m, where the
  // terrain cutout ends) and across both ends. Around switchbacks the strip's faded edge can sit
  // up to ~2 m off the terrain (one leg's bench cut reaches into the next), and a sightline under
  // it used to look into the cut-away hole beneath and see the sky. Standard terrain crack fix.
  {
    const P = geo.attributes.position;
    const C = geo.attributes.color;
    const L = geo.attributes.aLayers;
    const jEdge = Math.round((CORRIDOR_HALF - 4.8) / CORRIDOR_STEP); // u = ±4.8
    const sPos = [];
    const sCol = [];
    const sLay = [];
    const sIdx = [];
    const wall = (vA, vB) => {
      const base = sPos.length / 3;
      for (const v of [vA, vB]) {
        for (const drop of [0, 3]) {
          sPos.push(P.getX(v), P.getY(v) - drop, P.getZ(v));
          const k = drop ? 0.55 : 0.8; // a little darker going down
          sCol.push(C.getX(v) * k, C.getY(v) * k, C.getZ(v) * k, 1);
          sLay.push(L.getX(v), L.getY(v), L.getZ(v), L.getW(v));
        }
      }
      // two-sided (the material is DoubleSide-free, so emit both windings)
      sIdx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      sIdx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    };
    for (let i = 1; i < rows; i++) {
      const a = (i - 1) * rowLen;
      const b = i * rowLen;
      wall(a + jEdge, b + jEdge);
      wall(a + across - jEdge, b + across - jEdge);
    }
    for (const r of [0, rows - 1]) for (let j = jEdge; j < across - jEdge; j++) wall(r * rowLen + j, r * rowLen + j + 1);
    const skirt = new THREE.BufferGeometry();
    skirt.setAttribute('position', new THREE.Float32BufferAttribute(sPos, 3));
    skirt.setAttribute('color', new THREE.Float32BufferAttribute(sCol, 4));
    skirt.setAttribute('aTread', new THREE.Float32BufferAttribute(new Float32Array(sPos.length / 3), 1));
    skirt.setAttribute('aLayers', new THREE.Float32BufferAttribute(sLay, 4));
    skirt.setIndex(sIdx);
    skirt.computeVertexNormals();
    skirt.computeBoundingSphere();
    const mesh = new THREE.Mesh(skirt, mat);
    mesh.name = 'trail skirt';
    group.add(mesh);
  }

  // what the terrain cutout is built from (buildCutoutMask)
  group.userData.cover = {
    positions: geo.attributes.position.array,
    alphas: Float32Array.from({ length: geo.attributes.color.count }, (_, i) => geo.attributes.color.getW(i)),
    indices: geo.index.array,
  };
  geo.dispose();
  return group;
}
