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

  // Depressions on the way: the flood level runs flat across a pit, so a stream following it would
  // carve a trench through the far rim. Real water fills the pit and spills over. Small pits are
  // filled with sediment (the ground is raised to the spill level: a flat floor, see fill below); a
  // big closed basin (over SINK_AREA) swallows the stream instead: it runs down to the basin's low
  // spot and ends in a pond there.
  const comp = new Int32Array(n * n).fill(-1);
  const comps = [];
  const pitDepth = (k) => level[k] - h[k];
  function component(k) {
    if (comp[k] >= 0) return comps[comp[k]];
    const c = { cells: [], fill: false };
    comp[k] = comps.length;
    comps.push(c);
    const stack = [k];
    while (stack.length) {
      const q = stack.pop();
      c.cells.push(q);
      const i = q % n;
      const j = (q - i) / n;
      for (let d = 0; d < 4; d++) {
        const ii = i + dirs[d][0];
        const jj = j + dirs[d][1];
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const kk = jj * n + ii;
        if (comp[kk] < 0 && pitDepth(kk) > 0.05) {
          comp[kk] = comp[k];
          stack.push(kk);
        }
      }
    }
    return c;
  }

  // trace each source down to the lake; a stream ends where it meets one already traced
  const owner = new Int32Array(n * n).fill(-1);
  const flowAcc = new Float32Array(n * n);
  const traces = [];
  const ponds = [];
  for (const src of SOURCES) {
    let k = Math.round((src.z + half) / GRID) * n + Math.round((src.x + half) / GRID);
    const cells = [];
    let sink = false;
    while (k >= 0 && owner[k] < 0) {
      if (pitDepth(k) > 0.05) {
        const c = component(k);
        if (c.cells.length * GRID * GRID > SINK_AREA) {
          sink = true;
          break;
        }
        c.fill = true;
      }
      cells.push(k);
      owner[k] = traces.length;
      if (down[k] < 0) break;
      k = down[k];
    }
    if (sink) {
      // downhill (on the real ground) to the basin's nearest low spot, and a pond there
      for (;;) {
        cells.push(k);
        owner[k] = traces.length;
        const i = k % n;
        const j = (k - i) / n;
        let best = k;
        for (const [di, dj] of dirs) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          if (h[jj * n + ii] < h[best]) best = jj * n + ii;
        }
        if (best === k || owner[best] >= 0) break;
        k = best;
      }
      ponds.push(pondAround(k, h[k] + POND_DEPTH));
      k = -1;
    }
    traces.push({ cells, joins: k >= 0 && owner[k] >= 0 && owner[k] !== traces.length ? k : -1 });
  }

  // the cells of a pond: everything below its level connected to its low spot
  function pondAround(k0, lv) {
    const cells = [k0];
    const seenP = new Set(cells);
    for (let q = 0; q < cells.length; q++) {
      const i = cells[q] % n;
      const j = (cells[q] - i) / n;
      for (let d = 0; d < 4; d++) {
        const ii = i + dirs[d][0];
        const jj = j + dirs[d][1];
        const kk = jj * n + ii;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n || seenP.has(kk) || h[kk] >= lv) continue;
        seenP.add(kk);
        cells.push(kk);
      }
    }
    let x = 0;
    let z = 0;
    for (const c of cells) {
      x += -half + (c % n) * GRID;
      z += -half + Math.floor(c / n) * GRID;
    }
    x /= cells.length;
    z /= cells.length;
    let r = 0;
    for (const c of cells) r = Math.max(r, Math.hypot(-half + (c % n) * GRID - x, -half + Math.floor(c / n) * GRID - z));
    const xz = cells.map((c) => [-half + (c % n) * GRID, -half + Math.floor(c / n) * GRID]);
    return { x, z, level: lv, r: r + GRID * 1.5, cells: xz, cell: GRID };
  }

  // sediment in the small pits on a stream's way: depth to raise each grid point, sampled bilinearly
  const fillDepth = new Float32Array(n * n);
  for (const c of comps) if (c.fill) for (const k of c.cells) fillDepth[k] = pitDepth(k);
  function fillAt(x, z) {
    const gx = Math.min(n - 1.001, Math.max(0, (x + half) / GRID));
    const gz = Math.min(n - 1.001, Math.max(0, (z + half) / GRID));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const k = j * n + i;
    const a = fillDepth[k];
    const b = fillDepth[k + 1];
    const c = fillDepth[k + n];
    const d = fillDepth[k + n + 1];
    if (a + b + c + d === 0) return 0;
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  }
  const filled = (x, z) => height(x, z) + fillAt(x, z);

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
    // arc length, and the rapids reach (the main creek only: around RAPIDS, where the trail crosses)
    let along = 0;
    let s0 = -1;
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) along += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      pts[i].s = along;
      const d = Math.hypot(pts[i].x - RAPIDS.x, pts[i].z - RAPIDS.z);
      if (streams.length === 0 && d < best && d < 60) {
        best = d;
        s0 = along;
      }
    }
    for (const p of pts) {
      const ds = p.s - s0;
      p.rapid = s0 < 0 ? 0 : smooth(-RAPIDS.before, -RAPIDS.before + 40, ds) * (1 - smooth(RAPIDS.after - 30, RAPIDS.after, ds));
    }
    // bed: a little below the natural ground, never rising downstream
    let bed = Infinity;
    for (const p of pts) {
      // a creek: ~2 m at the spring, ~5 m at the lake; ~70% wider through the rapids
      const width = (1.8 + Math.min(3.2, Math.sqrt(p.acc) * 0.08)) * (1 + 0.7 * p.rapid);
      p.width = width;
      const ground = filled(p.x, p.z);
      bed = Math.min(bed - 0.02, ground - 0.9 - width * 0.12 - 0.6 * p.rapid);
      p.bed = bed;
      // where the channel still runs deep (a smoothed bend over a spur), the banks lie back further
      p.bank = BANK + Math.max(0, ground - bed - 2.5) * 2.5;
    }
    streams.push({ points: pts });
  }

  // Rocks in the beds: more on steep runs, fewer on slow reaches. A hash of the stream and point
  // picks them (no random stream shared with the scatter, so nothing else moves). Each has its
  // place in the ribbon's frame too: s = metres along the stream, a = metres across (+ = the
  // ribbon's +u side), which the water shader uses for the flow around it.
  const rocks = [];
  streams.forEach((st, si) => {
    const pts = st.points;
    for (let i = 3; i < pts.length - 3; i++) {
      const p = pts[i];
      const fall = Math.max(0, (pts[i - 1].bed - pts[i + 1].bed) / (2 * SAMPLE));
      const rnd = (k) => hashU(si * 7919 + i, k);
      if (rnd(0) > 0.14 + Math.min(0.45, fall * 5) + 0.5 * p.rapid) continue;
      const half = p.width / 2;
      // (boulders in the rapids: the current breaks over them)
      const r = Math.min(half * 0.55, 0.3 + 0.6 * rnd(1) * rnd(2) + 0.25 * Math.min(1, fall * 8) + 0.45 * p.rapid * rnd(7));
      const a = (rnd(3) * 2 - 1) * Math.max(0, half - r * 0.6);
      const ds = (rnd(4) - 0.5) * SAMPLE * 0.8;
      const dx = pts[i + 1].x - pts[i - 1].x;
      const dz = pts[i + 1].z - pts[i - 1].z;
      const l = Math.hypot(dx, dz) || 1;
      rocks.push({
        x: p.x + (dx / l) * ds - (dz / l) * a,
        z: p.z + (dz / l) * ds + (dx / l) * a,
        r, stream: si, s: p.s + ds, a, pick: rnd(5), rotY: rnd(6) * Math.PI * 2,
      });
    }
  });

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
      const reach = Math.max(a.width, b.width) / 2 + Math.max(a.bank, b.bank) + 2;
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
  const near = { d: Infinity, bed: 0, half: 0, bank: BANK, t: 0, seg: null };
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
        near.bank = a.bank + (b.bank - a.bank) * t;
      }
    }
    return near;
  }

  /** The terrain height with the pits on the streams' way filled and the channel cut in. */
  function carve(x, z, ground) {
    ground += fillAt(x, z);
    const c = nearest(x, z);
    if (!c.seg) return ground;
    const u = (c.d - c.half) / c.bank; // 0 at the bed's edge, 1 where the bank meets the natural ground
    if (u >= 1) return ground;
    const s = u <= 0 ? 0 : u * u * (3 - 2 * u);
    return Math.min(ground, c.bed + (ground - c.bed) * s);
  }

  /** The pond's water level at (x, z), or -Infinity outside every pond (callers check the ground). */
  function pondLevel(x, z) {
    for (const p of ponds) if (Math.hypot(x - p.x, z - p.z) < p.r) return p.level;
    return -Infinity;
  }

  /** Horizontal distance to the nearest stream's centre line (Infinity far away). */
  function distance(x, z) {
    return nearest(x, z).d;
  }

  return { streams, ponds, rocks, carve, distance, nearest, pondLevel, fillAt };
}

/** The rapids: the main creek's reach around this point (where the trail crosses it) runs wide and fast. */
const RAPIDS = { x: 112, z: -8, before: 150, after: 130 };
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const BANK = 7; // m from the bed's edge to natural ground (more where the channel runs deep)
const SINK_AREA = 8e4; // m²: a closed basin bigger than this ends a stream (in a pond) instead of being filled
const POND_DEPTH = 1.5; // m of water over the basin's low spot

/** A hash of two integers to [0, 1). */
function hashU(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

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
