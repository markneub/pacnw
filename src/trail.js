import * as THREE from 'three';
import { WATER_LEVEL } from './config.js';
import { loadTick } from './loadprogress.js';
import { fallsPassage, fallsLocal, underCap } from './fallsshape.js';
import { road, roadAt, ROAD_NAME, ROAD_FLAT, ROAD_SURFACE } from './road.js';
import {
  heightAt, rawGroundAt, groundAt, groundColor, groundLayers, snowAmount, slopeAt, setGroundModifier, setTerrainCutout,
  streams, setWalkModifier, streamBed, marshAt, waterLevelAt, sandAt,
} from './terrain.js';
import { shared, wetChunks, patchSunlight, sunKey, patchPuddles } from './materials.js';
import { patchGroundDetail, groundDetailCacheKey } from './grounddetail.js';
import { patchRocky } from './rockyslope.js';

// The trail runs from the trailhead at the spawn point south through the dunes to
// the ocean beach, along the sand and back up through the dunes, north to the
// marsh boardwalk and a viewpoint on the lake's west shore, then climbs north
// through the forest onto the lower snow bench and up again into the high basin
// below the pass.
export const TRAIL_STOPS = [
  { name: 'trailhead', label: 'Trailhead', x: 22, z: 652 },
  { name: 'beach', label: 'Ocean beach', x: -60, z: 942 },
  { name: 'dunes', label: 'Dune trail', x: 300, z: 948 },
  { name: 'marsh', label: 'Marsh boardwalk', x: 160, z: 480 },
  { name: 'lake', label: 'Lake viewpoint', x: 55, z: 385 },
  // (a waypoint, no sign: over the rapids' footbridge and up the creek's east bank)
  { name: 'rapids', x: 95, z: -40, hidden: true },
  // (two more on Forest Road 2840 (road.js): the trail meets it east of the main creek's ford, follows
  // it west over the creek (on a footbridge beside the ford) and leaves it to climb the ledge onto the
  // waterfall's bowl (terrain.js RAMPS): in and out of the bowl by the same side, the trail ran back
  // alongside itself, the user)
  { name: 'roadeast', x: 75, z: -202, hidden: true },
  { name: 'roadwest', x: -150, z: -146, hidden: true },
  // behind the waterfall (fallsshape.js): the trail takes a fixed way through the alcove (passage),
  // west to east, then up the east ledge onto the snow bench
  { name: 'falls', label: 'Waterfall', ...fallsPassage()[26], passage: fallsPassage().reverse() },
  { name: 'snowfield', label: 'Snowfield', x: 210, z: -560 },
  { name: 'basin', label: 'High basin', x: 70, z: -920 },
];
/** Numeric spatial-hash key (no string garbage in per-frame lookups). */
const cellKey = (gx, gz) => (gx + 32768) * 65536 + (gz + 32768);

export const TRAIL_WIDTH = 1.05; // half-width of the visible tread (it wanders ~0.75–1.4 m: treadHalf)

/** Smooth value noise in −1..1 (world-anchored, deterministic). */
function vnoise(x, z) {
  const h = (i, j) => {
    let k = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
    k = Math.imul(k ^ (k >>> 13), 1274126177);
    return ((k ^ (k >>> 16)) >>> 0) / 2147483648 - 1;
  };
  const i = Math.floor(x);
  const j = Math.floor(z);
  let u = x - i;
  let v = z - j;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}
/**
 * The tread's half-width where its edge passes (x, z): it narrows and widens along the trail
 * (a ~25 m swell, ~7 m bulges, an odd worn-out spot), and, sampled where each edge lies, the
 * two sides wander independently. (A constant width with a gentle wobble read as a laid path, the user.)
 */
export function treadHalf(x, z) {
  const k = 0.27 * vnoise(x / 25 + 31.7, z / 25 - 12.3) + 0.21 * vnoise(x / 7 - 4.1, z / 7 + 8.9);
  const wide = Math.max(0, vnoise(x / 40 + 7.3, z / 40 + 2.2) - 0.4) * 0.6; // here and there a broad, trampled patch
  return TRAIL_WIDTH * Math.min(1.45, Math.max(0.6, 1 + k + wide));
}

// Cross-section of the bench cut into the hillside: level out to BENCH_HALF,
// then a cut bank (uphill) or fill slope (downhill) blending back into the
// natural ground by BANK_OUTER. The corridor mesh covers CORRIDOR_HALF, and the
// terrain mesh is hidden inside CUTOUT_HALF (the overlap hides the seam).
const BENCH_HALF = TRAIL_WIDTH * 1.15 + 0.15;
const BANK_OUTER = 4.2;
const CUTOUT_HALF = 4.7;
const CORRIDOR_HALF = 5.8;
const CORRIDOR_STEP = 0.5;
const STEP = 1.5; // m between centreline points

// Routing grid (only covers the area the trail can plausibly use).
const CELL = 6;
const MIN_X = -350;
const MAX_X = 450;
const MIN_Z = -1010;
const MAX_Z = 1000;
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

/**
 * Least-cost path between two points, preferring gentle grades (→ switchbacks).
 * The search state is (cell, heading), so turning costs something: every
 * change of direction adds TURN_COST × (1 − cos θ)/2 metres. Without it the
 * cheapest way up a steep slope was a ladder of ~10 m legs with hairpins every
 * few metres (the user saw sharp, cut-up switchbacks into the snow); with it
 * the legs run longer and the hairpins are fewer, as on a built trail.
 */
const TURN_COST = 40;
const WET_COST = 60; // m per 6 m cell in or beside a creek
function route(heights, side, wet, marsh, level, sand, rock, onRoad, a, b) {
  const D = MOVES.length;
  const idx = (ix, iz) => iz * NX + ix;
  const toCell = (p) => [Math.round((p.x - MIN_X) / CELL), Math.round((p.z - MIN_Z) / CELL)];
  const [sx, sz] = toCell(a);
  const [tx, tz] = toCell(b);
  const start = idx(sx, sz);
  const goal = idx(tx, tz);
  // the turn cost between each pair of move directions
  const turn = new Float32Array(D * D);
  for (let i = 0; i < D; i++) {
    for (let j = 0; j < D; j++) {
      const [ax, az, al] = MOVES[i];
      const [bx, bz, bl] = MOVES[j];
      const cos = ((ax * bx + az * bz) * CELL * CELL) / (al * bl);
      turn[i * D + j] = (TURN_COST * (1 - cos)) / 2;
    }
  }

  const g = new Float32Array(NX * NZ * D).fill(Infinity);
  const from = new Int32Array(NX * NZ * D).fill(-1);
  const closed = new Uint8Array(NX * NZ * D);
  const heap = new MinHeap();
  // the start may leave in any direction
  for (let d = 0; d < D; d++) {
    g[start * D + d] = 0;
    heap.push(start * D + d, 0);
  }
  let end = -1;

  while (heap.size) {
    const st = heap.pop();
    const cur = (st / D) | 0;
    const dir = st - cur * D;
    if (cur === goal) {
      end = st;
      break;
    }
    if (closed[st]) continue;
    closed[st] = 1;
    const cx = cur % NX;
    const cz = (cur - cx) / NX;
    for (let k = 0; k < D; k++) {
      const [dx, dz, dist] = MOVES[k];
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= NX || nz >= NZ) continue;
      const n = idx(nx, nz);
      const ns = n * D + k;
      if (closed[ns]) continue;
      const h = heights[n];
      if (h < level[n] + 1.2 && !marsh[n]) continue; // (the marsh is crossed on a boardwalk)
      if (rock[n] && n !== goal) continue; // (the waterfall's cliffs: under them the terrain is the bowl's floor)
      const grade = (h - heights[cur]) / dist;
      // steep grades cost a lot more than distance; side-slope makes the
      // tread hard to cut, so avoid traversing cliffs too
      // (on the dunes a path just goes up the sand, as in the reference photos: grades cost less)
      const steep = Math.max(0, Math.abs(grade) - 0.18 - 0.1 * sand[n]);
      // (on the road a walk is easy: the trail follows it where it goes its way)
      const cost = dist * (onRoad[n] ? 0.55 : 1) * (1 + 40 * (1 - 0.6 * sand[n]) * grade * grade + 2500 * steep * steep + 6 * side[n] * side[n]) + (cur === start ? 0 : turn[dir * D + k]) + wet[n] * WET_COST;
      const ng = g[st] + cost;
      if (ng < g[ns]) {
        g[ns] = ng;
        from[ns] = st;
        const hx = (nx - tx) * CELL;
        const hz = (nz - tz) * CELL;
        heap.push(ns, ng + Math.hypot(hx, hz));
      }
    }
  }

  const path = [];
  for (let st = end; st !== -1; st = from[st]) {
    const c = (st / D) | 0;
    const cx = c % NX;
    if (path.length && path[path.length - 1].c === c) continue;
    const v = new THREE.Vector2(MIN_X + cx * CELL, MIN_Z + ((c - cx) / NX) * CELL);
    v.c = c;
    path.push(v);
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
 * `route` is the coarse route (the A* legs, [x0, z0, x1, z1, ...]) from the world bake
 * (world.js); without it the route is searched here.
 */
export async function buildTrail({ route: baked = null } = {}) {
  const coarse = baked ? Array.from({ length: baked.length / 2 }, (_, i) => new THREE.Vector2(baked[2 * i], baked[2 * i + 1]))
    : await searchRoute();
  await loadTick(0.65);
  const points = resample(chaikin(coarse, 3), STEP);

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

  const stops = TRAIL_STOPS.filter((s) => !s.hidden).map((stop) => {
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

  // Forest Road 2840 (road.js): where the trail runs on it, no tread or bench cut of its own (the
  // road is the walking surface), and a junction (a signed stop) where it joins and where it leaves
  // (a short step off it is still the same stretch)
  const onRoad = points.map((p) => roadAt(p.x, p.y).d < 1.5);
  const shared = [];
  for (let i = 0; i < points.length; i++) {
    if (!onRoad[i]) continue;
    let j = i;
    while (j + 1 < points.length && (onRoad[j + 1] || onRoad.slice(j + 1, j + 50).some(Boolean))) j++;
    if (j - i >= 10) shared.push({ a: i, b: j });
    i = j;
  }
  const R = road();
  for (const { a, b } of shared) {
    for (const index of [a, b]) {
      if (index === 0 || index === points.length - 1) continue;
      const leaves = index === b ? 1 : -1;
      // Its sign stands where a hiker on the road meets the turn: on the road's shoulder beside the
      // trail's mouth, on the side the shared stretch comes from (so you read it before you reach the
      // turn), facing the road. Stops reached by leaving the road are straight on (↑, past the sign);
      // those along the road ← or → as you face the sign (signs.js).
      let at = index;
      while (at > 2 && at < points.length - 3 && roadAt(points[at].x, points[at].y).d < ROAD_FLAT + 0.5) at += leaves;
      const r = roadAt(points[at].x, points[at].y);
      const [ax, az] = R.pts[r.i];
      const [bx, bz] = R.pts[r.i + 1];
      const tl = Math.hypot(bx - ax, bz - az);
      let tx = (bx - ax) / tl;
      let tz = (bz - az) / tl;
      const t0 = (points[at].x - ax) * tx + (points[at].y - az) * tz;
      const rx = ax + tx * t0; // the nearest point of the road's line
      const rz = az + tz * t0;
      const ox = (points[at].x - rx) / r.d; // out from the road, on the trail's side
      const oz = (points[at].y - rz) / r.d;
      const back = points[Math.max(0, Math.min(points.length - 1, index - leaves * 20))]; // along the shared stretch
      if ((back.x - rx) * tx + (back.y - rz) * tz < 0) {
        tx = -tx;
        tz = -tz;
      }
      // clear of the trail's tread (and the board's half-width) along the shoulder
      const clear = (x, z) => {
        let m = Infinity;
        for (let k = Math.max(0, index - 80); k < Math.min(points.length, index + 80); k++) m = Math.min(m, Math.hypot(points[k].x - x, points[k].y - z));
        return m - treadHalf(x, z);
      };
      const D = ROAD_SURFACE + 1.1;
      let along = 2.2;
      while (along < 8 && clear(rx + ox * D + tx * along, rz + oz * D + tz * along) < 1.1) along += 0.25;
      const sign = { x: rx + ox * D + tx * along, z: rz + oz * D + tz * along, rotY: Math.atan2(ox, oz) };
      // facing the sign (looking out from the road), the shared stretch lies to the right (+1) or left
      const roadDir = tx * -oz + tz * ox > 0 ? 1 : -1;
      stops.push({ name: 'junction', label: ROAD_NAME, junction: true, index, sign, roadDir, x: points[index].x, z: points[index].y, leaves });
    }
  }

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
  // Hairpin landings: where two legs pass close (and aren't neighbours along the trail), the
  // bank between their treads can be at most LANDING_SLOPE steep, so their tread heights are
  // pulled together (both, half each), as a built switchback has a flattened turn. Then a light
  // smoothing along the trail so the approaches ease into the landing.
  {
    const LANDING_SLOPE = 1.2;
    const pairs = [];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 8; j < points.length; j++) {
        const d = points[i].distanceTo(points[j]);
        if (d < 2 * BANK_OUTER) pairs.push([i, j, Math.max(0.3, d - 2 * BENCH_HALF) * LANDING_SLOPE]);
      }
    }
    for (let it = 0; it < 40; it++) {
      for (const [i, j, maxDh] of pairs) {
        const dh = tread[j] - tread[i];
        if (Math.abs(dh) <= maxDh) continue;
        const fix = (Math.abs(dh) - maxDh) * Math.sign(dh) * 0.5;
        tread[i] += fix;
        tread[j] -= fix;
      }
      for (let k = 1; k < tread.length - 1; k++) tread[k] = tread[k] * 0.6 + (tread[k - 1] + tread[k + 1]) * 0.2;
    }
  }

  // Footbridges where the trail crosses a stream. Each is level, spans the water along the trail
  // (an angled crossing is longer than the channel is wide), sits clear of the water, and rests on
  // a dirt berm at each end that carries the tread up to it (see benchHeight).
  const treadAt = (i, along) => {
    const k = THREE.MathUtils.clamp(i + along / STEP, 0, points.length - 1);
    const k0 = Math.floor(k);
    const k1 = Math.min(points.length - 1, k0 + 1);
    return tread[k0] + (tread[k1] - tread[k0]) * (k - k0);
  };
  const arc = [0]; // metres along the trail at each point
  for (let i = 1; i < points.length; i++) arc.push(arc[i - 1] + points[i].distanceTo(points[i - 1]));
  const crossings = [];
  for (let i = 0, wet = false; i < points.length; i++) {
    const c = streams().nearest(points[i].x, points[i].y);
    // (behind the falls the creek is overhead; on the road the trail wades its ford)
    const now = !!c.seg && c.d < c.half + 0.5 && !underCap(points[i].x, points[i].y) && roadAt(points[i].x, points[i].y).d > 3;
    if (now && !wet) {
      // the middle of the wet run
      let j = i;
      while (j + 1 < points.length) {
        const cj = streams().nearest(points[j + 1].x, points[j + 1].y);
        if (!cj.seg || cj.d >= cj.half + 0.5 || underCap(points[j + 1].x, points[j + 1].y)) break;
        j++;
      }
      const m = Math.round((i + j) / 2);
      const a = points[Math.max(0, m - 2)];
      const b = points[Math.min(points.length - 1, m + 2)];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      const dx = (b.x - a.x) / l;
      const dz = (b.y - a.y) / l;
      const cm = streams().nearest(points[m].x, points[m].y);
      const half = cm.half;
      const bed = cm.bed;
      // the stream's direction there, and how obliquely the trail crosses it
      const sx = cm.seg.b.x - cm.seg.a.x;
      const sz = cm.seg.b.z - cm.seg.a.z;
      const sl = Math.hypot(sx, sz) || 1;
      const cos = Math.max(0.5, Math.abs((dx * -sz + dz * sx) / sl));
      const wetAlong = (half + 1.0) / cos; // water and wet gravel, measured along the trail
      const reach = wetAlong + 1.2; // the bridge's half-length: each end rests ~1 m on its berm
      const deck = Math.max(treadAt(m, -reach), treadAt(m, reach), bed + 1.4, rawGroundAt(points[m].x, points[m].y) + 1.0) + 0.05;
      crossings.push({ x: points[m].x, z: points[m].y, s: arc[m], dx, dz, half, reach, deck, span: 2 * reach });
    }
    wet = now;
  }
  const BERM_TOP = 1.6; // m, half-width of the berm's flat top
  const BERM_SIDE = 0.6; // side slope (drop per metre), so it meets natural ground within BANK_OUTER
  const RAMP = 0.15; // the approach ramp's grade (22% read as a steep mound from the trail)

  /**
   * The berm's surface for a crossing at a point `along` m (along the trail) from the bridge's
   * middle and `across` m from the centreline, or -Infinity where it doesn't reach. It follows the
   * trail (a berm straight along the bridge's axis ended up beside the trail where it curves).
   */
  function bermHeight(b, along, across, c) {
    if (across > BANK_OUTER || along > b.reach + 14) return -Infinity;
    let top = b.deck - 0.04;
    top -= Math.max(0, along - b.reach) * RAMP; // the ramp down to the tread
    top -= Math.max(0, b.reach - 1.0 - along) * 1.6; // under the bridge (past ~1 m of bearing): a steep face toward the water
    top -= Math.max(0, across - BERM_TOP) * BERM_SIDE; // sloped sides
    // kept out of the channel, except under the tread itself: on an angled crossing that tipped the
    // walking surface sideways at the bridge ends (the tread's corner there just meets the bank)
    if (c.seg) top -= Math.max(0, c.half + 1.3 - c.d) * 2.0 * THREE.MathUtils.smoothstep(across, 1.3, 2.2);
    return top;
  }

  /**
   * Ground height with the bench cut in. Each nearby centreline segment pulls
   * the ground toward its tread height. The closest segment dominates (sharp
   * Gaussian weights), so where switchback legs pass close each tread stays
   * level and the ground between them becomes a short bank, still continuous.
   */
  function benchHeight(x, z, g) {
    const list = segs.get(cellKey(Math.floor(x / HASH), Math.floor(z / HASH)));
    if (!list) return g;
    // (no bench of its own on or right by the road: the road's shelf is the ground there)
    const offRoad = THREE.MathUtils.smoothstep(roadAt(x, z).d, ROAD_FLAT, ROAD_FLAT + 3);
    let acc = 0;
    let wsum = 0;
    let dMin = Infinity;
    let sMin = 0;
    for (const i of list) {
      const a = points[i];
      const b = points[i + 1];
      const abx = b.x - a.x;
      const abz = b.y - a.y;
      const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.y) * abz) / (abx * abx + abz * abz), 0, 1);
      const d = Math.hypot(x - (a.x + abx * t), z - (a.y + abz * t));
      if (d < dMin) {
        dMin = d;
        sMin = arc[i] + (arc[i + 1] - arc[i]) * t;
      }
      if (d >= BANK_OUTER || onRoad[i] || onRoad[i + 1]) continue;
      const keep = THREE.MathUtils.smoothstep(d, BENCH_HALF, BANK_OUTER); // 0 on the tread, 1 outside
      // inverse distance from the tread's edge: each leg owns its own tread, and between two
      // close legs the hand-over spreads across the whole gap between their treads, a bank, not
      // a cliff (a sharp Gaussian put it in ~0.5 m: walls of up to 2.6 m, dark slots in the snow)
      const de = Math.max(d - BENCH_HALF, 0.02);
      const w = 1 / (de * de * de);
      const hc = tread[i] + (tread[i + 1] - tread[i]) * t;
      acc += w * (hc - g) * (1 - keep) * offRoad;
      wsum += w;
    }
    const h = wsum > 0 ? g + acc / wsum : g;
    // where the trail crosses a stream, the stream's channel cuts through the tread (a footbridge
    // spans it) instead of the tread damming it like a culvert
    const c = streams().nearest(x, z);
    let out = h;
    if (c.seg && h > g && !underCap(x, z)) {
      const cut = 1 - THREE.MathUtils.smoothstep(c.d, c.half + 0.4, c.half + 2.2);
      out = h + (g - h) * cut;
    }
    // the footbridges' dirt berms: fill up to the berm wherever it stands above the ground
    for (const b of crossings) out = Math.max(out, bermHeight(b, Math.abs(sMin - b.s), dMin, c));
    return out;
  }
  setGroundModifier(benchHeight);

  const mesh = buildCorridorMesh(points, distanceTo);
  setTerrainCutout(...buildCutoutMask(mesh.userData.cover));
  delete mesh.userData.cover;

  // The marsh boardwalk: sections along the trail wherever it crosses the marsh, each level, at
  // least 0.4 m over the water and 0.25 m over the ground, the deck height eased along the run
  const boardwalk = [];
  {
    const SEC = 3.0; // m, one section (the Blender model)
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        // deck heights: the need at each section, then smoothed so steps stay small
        const need = run.map((p) => Math.max(WATER_LEVEL + 0.4, rawGroundAt(p.x, p.z) + 0.25, groundAt(p.x, p.z) + 0.2));
        // at most 0.1 m between sections (the lower one is raised): a gentle slope, never a step
        const y = need.slice();
        for (let k = 1; k < y.length; k++) y[k] = Math.max(y[k], y[k - 1] - 0.1);
        for (let k = y.length - 2; k >= 0; k--) y[k] = Math.max(y[k], y[k + 1] - 0.1);
        run.forEach((p, k) => boardwalk.push({ ...p, y: y[k] }));
      }
      run = [];
    };
    let acc = SEC;
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1];
      const p = points[i];
      acc += p.distanceTo(a);
      const inMarsh = marshAt(p.x, p.y) > 0.12 && rawGroundAt(p.x, p.y) < WATER_LEVEL + 1.0; // (wet ground only)
      if (!inMarsh) {
        flush();
        acc = SEC;
        continue;
      }
      if (acc < SEC - 0.1) continue; // (points are 1.5 m apart: every second one; rounding made it every third)
      acc = 0;
      const q = points[Math.min(points.length - 1, i + 2)];
      const o = points[Math.max(0, i - 2)];
      const l = Math.hypot(q.x - o.x, q.y - o.y) || 1;
      run.push({ x: p.x, z: p.y, dx: (q.x - o.x) / l, dz: (q.y - o.y) / l });
    }
    flush();
  }

  setWalkModifier((x, z, g) => {
    for (const s of boardwalk) {
      const ox = x - s.x;
      const oz = z - s.z;
      if (Math.abs(ox * s.dx + oz * s.dz) < 1.65 && Math.abs(-ox * s.dz + oz * s.dx) < 0.65) return Math.max(g, s.y);
    }
    for (const b of crossings) {
      const ox = x - b.x;
      const oz = z - b.z;
      const along = ox * b.dx + oz * b.dz;
      const across = -ox * b.dz + oz * b.dx;
      if (Math.abs(along) < b.reach && Math.abs(across) < 0.85) return Math.max(g, b.deck);
    }
    return g;
  });

  return { points, stops, distanceTo, guide, mesh, crossings, boardwalk, shared, route: coarse };
}

/** The A* route between the stops over a grid of the terrain (the slow part of the trail). */
async function searchRoute() {
  const heights = new Float32Array(NX * NZ);
  const side = new Float32Array(NX * NZ);
  const wet = new Float32Array(NX * NZ);
  const marsh = new Uint8Array(NX * NZ);
  const level = new Float32Array(NX * NZ); // the water level there (the lake's, or the sea's at the coast)
  const sand = new Float32Array(NX * NZ);
  const rock = new Uint8Array(NX * NZ);
  const onRoad = new Uint8Array(NX * NZ);
  for (let iz = 0; iz < NZ; iz++) {
    for (let ix = 0; ix < NX; ix++) {
      const x = MIN_X + ix * CELL;
      const z = MIN_Z + iz * CELL;
      heights[iz * NX + ix] = heightAt(x, z);
      side[iz * NX + ix] = slopeAt(x, z);
      marsh[iz * NX + ix] = marshAt(x, z) > 0.25 ? 1 : 0;
      level[iz * NX + ix] = waterLevelAt(x, z);
      sand[iz * NX + ix] = sandAt(x, z);
      // the waterfall's cliff and the alcove under it (only the fixed passage goes in there)
      const f = fallsLocal(x, z);
      rock[iz * NX + ix] = f && f.d > -1.5 && underCap(x, z) ? 1 : 0;
      // the road (road.js): easy walking, its fords included (the trail wades them with the road, on
      // stepping stones along the edge: vegetation.js addSteppingStones)
      const rd = roadAt(x, z).d;
      onRoad[iz * NX + ix] = rd < 2.2 ? 1 : 0;
      // creeks: stepping into one costs a lot, so the trail crosses once, squarely, rather than
      // following a channel (it once crossed the same creek twice at a hairpin)
      const c = streams().nearest(x, z);
      // (the rapids, streams.js, are where the trail is meant to cross the main creek: cheap there)
      if (c.seg && c.d < c.half + 4 && !underCap(x, z)) wet[iz * NX + ix] = c.seg.a.rapid > 0.3 || rd < 2.2 ? 0.1 : 1;
    }
    await loadTick((0.25 * iz) / NZ);
  }

  // (a stop with a passage: routed to its first point, along it, and on from its last)
  let coarse = [];
  for (let i = 0; i < TRAIL_STOPS.length - 1; i++) {
    const a = TRAIL_STOPS[i].passage?.at(-1) ?? TRAIL_STOPS[i];
    const b = TRAIL_STOPS[i + 1].passage?.[0] ?? TRAIL_STOPS[i + 1];
    const leg = route(heights, side, wet, marsh, level, sand, rock, onRoad, a, b);
    coarse = coarse.concat(i === 0 ? leg : leg.slice(1));
    if (TRAIL_STOPS[i + 1].passage) coarse = coarse.concat(TRAIL_STOPS[i + 1].passage.slice(1).map((p) => new THREE.Vector2(p.x, p.z)));
    await loadTick(0.25 + (0.4 * (i + 1)) / (TRAIL_STOPS.length - 1));
  }
  return coarse;
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

// the trail's tread, edged per pixel: worn ragged, grass and duff nibbling in, scuffs out past it
const TRAIL_TREAD = `
        // the tread, edged per pixel: worn ragged, grass and duff nibbling in, scuffs out past it
        float rag = (gNoise(vGroundPos.xz * 1.1 + 5.1) - 0.5) * 0.8 + (gNoise(vGroundPos.xz * 3.7 - 2.3) - 0.5) * 0.42
          + (gNoise(vGroundPos.xz * 11.0) - 0.5) * 0.2;
        float treadIn = smoothstep(-vEdge.y, vEdge.y, vEdge.x + rag);
        // scuffed, half-worn patches out past the edge (and tufts left standing just inside it)
        float scuff = smoothstep(0.58, 0.74, gNoise(vGroundPos.xz * 0.8 - 9.3) * 0.6 + gNoise(vGroundPos.xz * 2.9 + 1.7) * 0.4);
        treadIn = max(treadIn, scuff * 0.75 * smoothstep(-1.2, -0.1, vEdge.x + rag * 0.5));
        treadIn *= vEdge.z;
        diffuseColor.rgb = mix(diffuseColor.rgb, vTreadCol * diffuse, treadIn);
        vTread = treadIn * vTreadK;`;

/**
 * The road's surface (roadmesh.js), per pixel from u (m across, aEdge.x), s (m along, aEdge.y) and
 * the surface's half-width (aPrint.y): two packed wheel ruts that wander a little along the road,
 * a crown between them where grass and moss grow back, gravelly dirt out to a ragged edge, the
 * ground beyond. The ruts are the tread (grit, puddles). Where the trail's own tread leaves the road
 * (aPrint.x: m inside the trail's tread), the road gives way to the trail's strip beneath it.
 */
const ROAD_TREAD = `
        float rag = (gNoise(vGroundPos.xz * 1.3 + 5.1) - 0.5) * 0.55 + (gNoise(vGroundPos.xz * 4.3 - 2.3) - 0.5) * 0.25
          + (gNoise(vGroundPos.xz * 12.0) - 0.5) * 0.1;
        float roadU = vEdge.x;
        if (vPrint.x + rag * 0.5 > 0.0 && abs(roadU) > vPrint.y - 0.2) discard;
        float wob = (gNoise(vec2(vEdge.y * 0.05, 1.7)) - 0.5) * 0.5;
        float ru = abs(roadU - wob);
        float onRoad = smoothstep(-0.15, 0.15, vPrint.y - abs(roadU) + rag);
        float rut = (1.0 - smoothstep(0.15, 0.3, abs(ru - 0.78) + rag * 0.14)) * onRoad;
        float crown = (1.0 - smoothstep(0.18, 0.45, ru + rag * 0.2))
          * smoothstep(0.38, 0.62, gNoise(vGroundPos.xz * 0.9 + 2.0) * 0.7 + gNoise(vGroundPos.xz * 3.0) * 0.3) * onRoad;
        float gravel = gNoise(vGroundPos.xz * 9.0) * 0.6 + gNoise(vGroundPos.xz * 23.0) * 0.4;
        vec3 roadGround = diffuseColor.rgb;
        vec3 surf = vTreadCol * diffuse * (0.86 + gravel * 0.28);
        vec3 rc = mix(roadGround, surf, onRoad);
        rc = mix(rc, surf * vec3(0.7, 0.66, 0.62), rut);
        rc = mix(rc, roadGround * vec3(0.92, 1.06, 0.84), crown);
        diffuseColor.rgb = mix(roadGround, rc, vEdge.z);
        vTread = rut * vEdge.z * vTreadK;`;

/** The corridor strips' materials (the trail's, or the road's: roadmesh.js): [opaque interior, faded fringe]. */
export function corridorMaterials(road = false) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    transparent: false, // the opaque interior; the faded fringe uses fringeMat (below)
    polygonOffset: true,
    // (the road's strip wins where it overlaps the trail's, at the junctions)
    polygonOffsetFactor: road ? -2 : -1,
    polygonOffsetUnits: road ? -4 : -2,
  });
  // Same mottling as the terrain shader so the two match, plus grit on the tread.
  const wet = wetChunks(0.9);
  mat.onBeforeCompile = (shader) => {
    patchSunlight(shader);
    shader.uniforms.uWet = shared.uWet;
    shader.uniforms.uPuddle = shared.uPuddle;
    shader.uniforms.uSnowline = shared.uSnowline;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTread;\nattribute vec3 aTreadCol;\nattribute vec3 aEdge;\nattribute vec3 aPrint;\nvarying float vTreadK;\nvarying vec3 vTreadCol;\nvarying vec3 vEdge;\nvarying vec3 vPrint;\nvarying vec3 vGroundPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTreadK = aTread;\nvTreadCol = aTreadCol;\nvEdge = aEdge;\nvPrint = aPrint;\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTreadK;
        varying vec3 vTreadCol;
        varying vec3 vEdge;
        float vTread;
        varying vec3 vPrint;
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
        // on sand: lines of footprints, three walkers' worth, each wandering a little across the
        // tread (a shadowed hollow with a lit lip on the far side)
        if (vPrint.z > 0.05 && abs(vPrint.y) < 1.6) {
          float hollow = 0.0;
          float lip = 0.0;
          for (int w = 0; w < 3; w++) {
            float fw = float(w);
            float stride = 0.7 + 0.07 * fw;
            float lane = (fw - 1.0) * 0.5 + 0.18 * sin(vPrint.x * 0.045 + fw * 2.1);
            float sk = vPrint.x / stride + fw * 0.37;
            float k = floor(sk + 0.5);
            float side = mod(k, 2.0) * 2.0 - 1.0;
            vec2 e = vec2((sk - k) * stride / 0.14, (vPrint.y - lane - side * 0.11) / 0.06);
            float r = dot(e, e);
            float keep = step(gHash(vec2(k, fw * 7.0 + 1.0)), 0.85); // some are scuffed out
            hollow = max(hollow, (1.0 - smoothstep(0.5, 1.0, r)) * keep);
            lip = max(lip, smoothstep(0.8, 1.05, r) * (1.0 - smoothstep(1.05, 1.8, r)) * step(0.0, e.x) * keep);
          }
          float pv = vPrint.z * (1.0 - smoothstep(25.0, 60.0, distance(cameraPosition, vGroundPos)) * 0.5);
          diffuseColor.rgb *= mix(1.0, 0.72, hollow * pv) * (1.0 + 0.1 * lip * pv);
        }
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
    patchRocky(shader, { tread: true });
    patchPuddles(shader);
    // (last, so it lands first after the chunk: the detail, rock and grit patches all see the tread)
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        ${road ? ROAD_TREAD : TRAIL_TREAD}`);
  };
  mat.customProgramCacheKey = () => `${groundDetailCacheKey()}|${sunKey()}|${road}`;
  // The faded outer fringe blends over the terrain, so it's transparent, and it must not write
  // depth: where switchback legs overlap, a fringe drawn first used to hide the leg beneath it,
  // and with the terrain cut away there the sky showed through (tools/holecheck.mjs).
  const fringeMat = mat.clone();
  fringeMat.transparent = true;
  fringeMat.depthWrite = false;
  fringeMat.onBeforeCompile = mat.onBeforeCompile;
  fringeMat.customProgramCacheKey = mat.customProgramCacheKey;
  return [mat, fringeMat];
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
  const treadCol = []; // the tread's colour here (the shader lays it over the vertex colour inside the edge)
  const edgeAttr = []; // m inside the tread's edge (< 0 outside), its softness, the marsh mask
  const printAttr = []; // footprints in the sand: arc length, offset across, how sandy
  const layers = [];
  const roadD = []; // m from the road's centreline (road.js)
  const lw = [0, 0, 0, 0];
  const indices = [];
  const dirt = new THREE.Color(0x6b5034);
  const dirtWet = new THREE.Color(0x4a3824);
  const packed = new THREE.Color(0x8d99a8); // trodden, slushy snow reads darker than fresh powder
  const churned = new THREE.Color(0xb3a58a); // sand scuffed up by boots: a shade darker, no grit
  const soil = new THREE.Color(0x5a4430);
  const col = new THREE.Color();
  const tmp = new THREE.Color();
  const tmpSnow = new THREE.Color();
  const e = 1;

  // The strip runs on past both ends of the trail: the bench cut rounds each end off out to
  // BANK_OUTER, and a strip that stopped at the last point left the cut's end wall uncovered (with
  // the terrain above it, a slot to see through: the user, at the trailhead). Opaque until the cut
  // has blended back into the ground, then faded like the sides.
  const ext = [];
  for (let k = 1; k * STEP <= CORRIDOR_HALF + 0.2; k++) ext.push(k * STEP);
  const along = (s) => 1 - THREE.MathUtils.smoothstep(s, CUTOUT_HALF + 0.3, CORRIDOR_HALF);
  const beyond = (a, b, s) => b.clone().sub(a).normalize().multiplyScalar(s).add(b);
  const n = points.length;
  const rowPts = [
    ...ext.slice().reverse().map((s) => ({ p: beyond(points[1], points[0], s), fade: along(s) })),
    ...points.map((p) => ({ p, fade: 1 })),
    ...ext.map((s) => ({ p: beyond(points[n - 2], points[n - 1], s), fade: along(s) })),
  ];
  const pts = rowPts.map((r) => r.p);

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
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
      roadD.push(roadAt(x, z).d);

      // colour: the ground as it would be, then exposed soil where the bank is
      // cut or filled, then the tread itself (all from world position, so
      // overlapping switchback strips agree)
      const naturalSlope = 1 - 2 * e / Math.hypot(
        rawGroundAt(x + e, z) - rawGroundAt(x - e, z), 2 * e, rawGroundAt(x, z + e) - rawGroundAt(x, z - e),
      );
      groundColor(x, g, z, naturalSlope, col);
      groundLayers(x, g, z, naturalSlope, lw);
      const snow = snowAmount(x, z, g, 0);
      const sandy = sandAt(x, z); // (on the beach and dunes: a path of footprints in the sand)
      const d = distanceTo(x, z);
      const cut = Math.abs(y - g);
      tmp.copy(soil).lerp(dirtWet, Math.min(1, cut / 3) * 0.5);
      // (not where a creek runs through the cut: its bed stays wet stone, or the strip's edge showed under the water)
      const bedHere = streamBed(x, z);
      col.lerp(tmp, THREE.MathUtils.smoothstep(cut, 0.15, 0.9) * 0.75 * (1 - snow * 0.85) * (1 - bedHere) * (1 - sandy));

      const half = treadHalf(x, z);
      // (in snow a softer edge and a boot-packed groove down the middle, over the snow's own colour:
      // a flat grey-blue fill read as a painted stripe)
      const edge = 0.14 + 0.5 * Math.max(snow, sandy);
      // (no tread under the marsh boardwalk: the marsh runs on beneath it)
      const dry = 1 - THREE.MathUtils.smoothstep(marshAt(x, z), 0.05, 0.2);
      const t = (1 - THREE.MathUtils.smoothstep(d, half - edge, half + edge)) * dry;
      const groove = 1 - Math.min(1, d / half) ** 2;
      tmp.copy(dirt).lerp(dirtWet, Math.min(1, d / half) * 0.6);
      tmpSnow.copy(col).lerp(packed, 0.4 + 0.45 * groove);
      tmp.lerp(tmpSnow, snow);
      tmpSnow.copy(col).lerp(churned, 0.3 + 0.3 * groove);
      tmp.lerp(tmpSnow, sandy);
      treadCol.push(tmp.r, tmp.g, tmp.b);
      edgeAttr.push(Math.max(-3, Math.min(3, half - d)), edge, dry);

      // detail layers: exposed soil on the banks and the tread itself read as dirt
      const dirtW = Math.max(t, THREE.MathUtils.smoothstep(cut, 0.15, 0.9) * 0.75 * (1 - bedHere)) * (1 - snow * 0.85) * (1 - sandy);
      layers.push(lw[0] * (1 - dirtW), lw[1] * (1 - dirtW), lw[2] * (1 - dirtW), lw[3] * (1 - dirtW) + dirtW);

      // fade the strip's outer edge into the terrain beneath
      const alpha = Math.min(1 - THREE.MathUtils.smoothstep(Math.abs(u), CUTOUT_HALF + 0.3, CORRIDOR_HALF), rowPts[i].fade);
      colors.push(col.r, col.g, col.b, alpha);
      treadAttr.push((1 - 0.7 * snow) * (1 - sandy)); // (× the tread: less dark grit on trodden snow, none on sand)
      printAttr.push((i - ext.length) * STEP, u, sandy * (1 - THREE.MathUtils.smoothstep(marshAt(x, z), 0.05, 0.2)));
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
  geo.setAttribute('aTreadCol', new THREE.Float32BufferAttribute(treadCol, 3));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edgeAttr, 3));
  geo.setAttribute('aPrint', new THREE.Float32BufferAttribute(printAttr, 3));
  geo.setAttribute('aLayers', new THREE.Float32BufferAttribute(layers, 4));
  geo.setAttribute('aShade', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3).fill(1), 1));
  geo.setIndex(indices);
  // normals from the ground's own slope at each vertex (computeVertexNormals averaged in the
  // triangles where the strip folds over itself on tight turns: downward normals, black pockets)
  {
    const P = geo.attributes.position;
    const nrm = new Float32Array(P.count * 3);
    const e = 0.4;
    for (let v = 0; v < P.count; v++) {
      const x = P.getX(v);
      const z = P.getZ(v);
      const nx = groundAt(x - e, z) - groundAt(x + e, z);
      const nz = groundAt(x, z - e) - groundAt(x, z + e);
      const l = Math.hypot(nx, 2 * e, nz);
      nrm[v * 3] = nx / l;
      nrm[v * 3 + 1] = (2 * e) / l;
      nrm[v * 3 + 2] = nz / l;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  }

  const [mat, fringeMat] = corridorMaterials();
  const opaqueTri = (alpha, a, b, c) => alpha[a] > 0.999 && alpha[b] > 0.999 && alpha[c] > 0.999;
  // No triangles that are flipped over: on the inside of a turn tighter than the strip's
  // half-width the strip folds over itself, and its triangles there face down (seen from above,
  // their winding reverses) and poked up through the strip as shards (the user: dark shapes in
  // the snow at hairpins)
  const PA = geo.attributes.position.array;
  const facesUp = (a, b, c) => {
    const ux = PA[b * 3] - PA[a * 3];
    const uz = PA[b * 3 + 2] - PA[a * 3 + 2];
    const vx = PA[c * 3] - PA[a * 3];
    const vz = PA[c * 3 + 2] - PA[a * 3 + 2];
    return (uz * vx - ux * vz) > 1e-4; // the y of (b − a) × (c − a)
  };
  // and none on the road's surface: where the trail runs on the road (or crosses onto it) the
  // road's strip is the ground (roadmesh.js; it shows this strip through where the trail's tread
  // leaves it), and the terrain isn't cut away there
  const onRoadSurface = (a, b, c) => roadD[a] < 1.8 && roadD[b] < 1.8 && roadD[c] < 1.8;
  const keepTri = (a, b, c) => facesUp(a, b, c) && !onRoadSurface(a, b, c);
  {
    const src = geo.index.array;
    const kept = [];
    for (let k = 0; k < src.length; k += 3) if (keepTri(src[k], src[k + 1], src[k + 2])) kept.push(src[k], src[k + 1], src[k + 2]);
    geo.setIndex(kept);
  }

  // Split into ~150 m segments so off-screen stretches are frustum-culled.
  // Normals come from the full strip, so segment joins don't show.
  const rowLen = across + 1;
  const rows = pts.length;
  const SEG = 100; // rows per segment (1.5 m each)
  const group = new THREE.Group();
  group.name = 'trail';
  for (let r0 = 0; r0 < rows - 1; r0 += SEG) {
    const r1 = Math.min(rows - 1, r0 + SEG);
    const v0 = r0 * rowLen;
    const v1 = (r1 + 1) * rowLen;
    const part = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'color', 'aTread', 'aTreadCol', 'aEdge', 'aPrint', 'aLayers', 'aShade']) {
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
          if (!keepTri(v0 + p, v0 + q, v0 + r)) continue;
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
          // the strip edge's own colour (darkened, it read as black notches where a skirt shows
          // above ground at hairpins)
          const k = drop ? 0.85 : 1;
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
    skirt.setAttribute('aTreadCol', new THREE.Float32BufferAttribute(new Float32Array(sPos.length), 3));
    skirt.setAttribute('aEdge', new THREE.Float32BufferAttribute(new Float32Array(sPos.length).map((_, i) => (i % 3 === 0 ? -3 : i % 3 === 1 ? 0.2 : 0)), 3));
    skirt.setAttribute('aPrint', new THREE.Float32BufferAttribute(new Float32Array(sPos.length), 3));
    skirt.setAttribute('aLayers', new THREE.Float32BufferAttribute(sLay, 4));
    skirt.setAttribute('aShade', new THREE.Float32BufferAttribute(new Float32Array(sPos.length / 3).fill(1), 1));
    skirt.setIndex(sIdx);
    // lit like the ground it continues: computeVertexNormals averaged the two windings' opposite
    // normals to zero, so wherever the skirt showed it was black (spots and thin lines in the snow)
    skirt.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(sPos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
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
