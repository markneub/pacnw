/**
 * Streams: snowmelt from the high country running down to the lake.
 *
 * Paths come from drainage, not hand placement: a priority flood from the lake
 * over a coarse grid of the uncarved terrain gives every cell a downhill
 * neighbour on its way to the lake (pits are flooded over, as real water
 * would), and each stream follows that from its source. Streams that meet
 * merge, and grow wider downstream with the area they drain.
 *
 * Each stream is then a polyline with, per point, its bed level (forced to
 * fall steadily downstream, so water never runs uphill) and width. carve()
 * cuts the channel into the terrain: a flat bed with banks easing back to the
 * natural ground. distance() keeps trees and rocks out of the water.
 *
 * Pure functions of a height function (no imports from terrain.js), built once.
 */

const GRID = 8; // m, the drainage grid
const SAMPLE = 4; // m between stream points
const HASH = 16; // m, spatial hash cells

/** Sources: snowmelt springs on the benches and high basin, and side streams off the peaks. */
const SOURCES = [
  { x: 70, z: -1010 }, // the high basin, under the pass
  { x: -190, z: -760 }, // west wall of the basin
  { x: 300, z: -720 }, // east wall
  { x: -420, z: -260 }, // west foothills
  { x: 470, z: -180 }, // east foothills
];

export function buildStreams(height, { size, waterLevel, lake }) {
  const half = size / 2;
  const n = Math.floor(size / GRID) + 1;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = height(-half + i * GRID, -half + j * GRID);

  // priority flood from the lake: next = the lowest unvisited neighbour of the visited area
  const down = new Int32Array(n * n).fill(-1); // the cell each cell drains into
  const level = new Float32Array(n * n); // flooded (pit-filled) level
  const seen = new Uint8Array(n * n);
  const heap = new MinHeap();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = -half + i * GRID;
      const z = -half + j * GRID;
      if (h[k] < waterLevel && Math.hypot(x - lake.x, (z - lake.z) * 1.4) < lake.r * 1.2) {
        seen[k] = 1;
        level[k] = h[k];
        heap.push(h[k], k);
      }
    }
  }
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.size) {
    const k = heap.pop();
    const i = k % n;
    const j = (k - i) / n;
    for (const [di, dj] of dirs) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const kk = jj * n + ii;
      if (seen[kk]) continue;
      seen[kk] = 1;
      down[kk] = k;
      level[kk] = Math.max(h[kk], level[k] + 0.01);
      heap.push(level[kk], kk);
    }
  }

  // trace each source down to the lake; a stream ends where it meets one already traced
  const owner = new Int32Array(n * n).fill(-1);
  const flowAcc = new Float32Array(n * n);
  const traces = [];
  for (const src of SOURCES) {
    let k = Math.round((src.z + half) / GRID) * n + Math.round((src.x + half) / GRID);
    const cells = [];
    while (k >= 0 && owner[k] < 0) {
      cells.push(k);
      owner[k] = traces.length;
      if (down[k] < 0) break;
      k = down[k];
    }
    traces.push({ cells, joins: k >= 0 && owner[k] >= 0 && owner[k] !== traces.length ? k : -1 });
  }
  // drained length so far feeds the width: each trace adds its length to everything downstream
  for (const t of traces) {
    let acc = 0;
    for (const k of t.cells) flowAcc[k] += (acc += GRID);
    let k = t.joins;
    while (k >= 0) {
      flowAcc[k] += acc;
      k = down[k];
    }
  }

  // smooth polylines, resampled, with bed level and width
  const streams = [];
  for (const t of traces) {
    let cells = t.cells.slice();
    if (t.joins >= 0) cells.push(t.joins);
    if (cells.length < 3) continue;
    let pts = cells.map((k) => ({ x: -half + (k % n) * GRID, z: -half + Math.floor(k / n) * GRID, acc: flowAcc[k] }));
    for (let r = 0; r < 3; r++) pts = chaikin(pts);
    pts = resample(pts, SAMPLE);
    // bed: a little below the natural ground, never rising downstream
    let bed = Infinity;
    for (const p of pts) {
      const width = 1.8 + Math.min(3.2, Math.sqrt(p.acc) * 0.08); // a creek: ~2 m at the spring, ~5 m at the lake
      p.width = width;
      const ground = height(p.x, p.z);
      bed = Math.min(bed - 0.02, ground - 0.9 - width * 0.12);
      p.bed = bed;
    }
    streams.push({ points: pts });
  }

  // spatial hash of segments
  const hash = new Map();
  const key = (gx, gz) => (gx + 32768) * 65536 + (gz + 32768);
  const segs = [];
  for (const s of streams) {
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1];
      const b = s.points[i];
      const seg = { a, b };
      segs.push(seg);
      const reach = Math.max(a.width, b.width) / 2 + BANK + 2;
      const gx0 = Math.floor((Math.min(a.x, b.x) - reach) / HASH);
      const gx1 = Math.floor((Math.max(a.x, b.x) + reach) / HASH);
      const gz0 = Math.floor((Math.min(a.z, b.z) - reach) / HASH);
      const gz1 = Math.floor((Math.max(a.z, b.z) + reach) / HASH);
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const kk = key(gx, gz);
          if (!hash.has(kk)) hash.set(kk, []);
          hash.get(kk).push(seg);
        }
      }
    }
  }

  // nearest point on any stream: distance, bed level, half width (reused object: no garbage)
  const near = { d: Infinity, bed: 0, half: 0, t: 0, seg: null };
  function nearest(x, z) {
    near.d = Infinity;
    near.seg = null;
    const list = hash.get(key(Math.floor(x / HASH), Math.floor(z / HASH)));
    if (!list) return near;
    for (const seg of list) {
      const { a, b } = seg;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
      if (d < near.d) {
        near.d = d;
        near.t = t;
        near.seg = seg;
        near.bed = a.bed + (b.bed - a.bed) * t;
        near.half = (a.width + (b.width - a.width) * t) / 2;
      }
    }
    return near;
  }

  /** The terrain height with the channel cut in (never raises the ground). */
  function carve(x, z, ground) {
    const c = nearest(x, z);
    if (!c.seg) return ground;
    const u = (c.d - c.half) / BANK; // 0 at the bed's edge, 1 where the bank meets the natural ground
    if (u >= 1) return ground;
    const s = u <= 0 ? 0 : u * u * (3 - 2 * u);
    return Math.min(ground, c.bed + (ground - c.bed) * s + (u <= 0 ? 0 : 0));
  }

  /** Horizontal distance to the nearest stream's centre line (Infinity far away). */
  function distance(x, z) {
    return nearest(x, z).d;
  }

  return { streams, carve, distance, nearest };
}

const BANK = 7; // m from the bed's edge to natural ground

function chaikin(pts) {
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25, acc: a.acc * 0.75 + b.acc * 0.25 });
    out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75, acc: a.acc * 0.25 + b.acc * 0.75 });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function resample(pts, step) {
  const out = [{ ...pts[0] }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    let s = step - carry;
    while (s <= l) {
      const t = s / l;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, acc: a.acc + (b.acc - a.acc) * t });
      s += step;
    }
    carry = l - (s - step);
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(last.x - out[out.length - 1].x, last.z - out[out.length - 1].z) > step * 0.3) out.push({ ...last });
  return out;
}

class MinHeap {
  constructor() {
    this.v = [];
    this.k = [];
  }
  get size() { return this.v.length; }
  push(value, item) {
    const v = this.v;
    const k = this.k;
    let i = v.length;
    v.push(value);
    k.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= v[i]) break;
      [v[p], v[i]] = [v[i], v[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop() {
    const v = this.v;
    const k = this.k;
    const top = k[0];
    const lv = v.pop();
    const lk = k.pop();
    if (v.length) {
      v[0] = lv;
      k[0] = lk;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < v.length && v[l] < v[m]) m = l;
        if (r < v.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [v[m], v[i]] = [v[i], v[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}
