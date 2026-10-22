/**
 * Forest Road 2840: an old dirt jeep track across the valley below the waterfall, west to east
 * (the user: "a dirt jeep track from west to east; the trail could go on the track for a little
 * bit"). It runs from a logging landing in the western foothills, down across the valley floor,
 * fords the main creek below the falls and a tributary, and climbs gently to a landing in the
 * eastern foothills (~1.8 km, grades within ~8%).
 *
 * The line was found once by an A* over the terrain (grade-limited, wide turns, few creek
 * crossings) and frozen here as control points, so loading costs nothing. Along it the level
 * (the tread height) is the ground smoothed along the road, held to a gentle grade, and dipped
 * down to the stream bed at each ford. terrain.js cuts the road's shelf into the height field
 * (`roadShelf`, after the streams were traced, so their channels still cut through at the fords);
 * roadmesh.js lays the surface (ruts, a grassy crown, shoulders) over it.
 *
 * Pure (no imports): terrain.js uses it in baseHeight and hands it the ground before the road and
 * the streams on first use (`initRoad`).
 */

export const ROAD_NAME = 'Forest Road 2840';
export const ROAD_NUMBER = '2840';

const CONTROL = [
  [-678, 44], [-630, 44], [-590, 68], [-550, 84], [-510, 76], [-462, 52], [-438, 12], [-406, -20],
  [-366, -36], [-318, -52], [-286, -84], [-254, -116], [-214, -116], [-174, -132], [-126, -156],
  [-86, -164], [-46, -196], [-14, -220], [34, -228], [66, -204], [106, -196], [146, -180], [178, -148],
  [226, -164], [266, -156], [274, -116], [290, -76], [306, -28], [354, -36], [394, -52], [434, -36],
  [474, -12], [522, -12], [570, -4], [610, 0], [658, 20], [706, 28], [730, 52],
];

export const ROAD_SURFACE = 2.3; // m, half-width of the travelled surface (ruts ±0.78 m)
export const ROAD_FLAT = 3.8; // m, half-width of the level shelf (surface + shoulders)
const LANDING = 9; // m more round each end: a cleared, levelled logging landing
const STEP = 2; // m between line points
const MAX_GRADE = 0.085;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

let R = null;

/** Build the line, its level and its spatial hash (once): `pre(x, z)` = the ground before the road. */
export function initRoad(pre, streams) {
  if (R) return R;
  // Chaikin ×3, then resampled every STEP m
  let p = CONTROL.map(([x, z]) => [x, z]);
  for (let k = 0; k < 3; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i];
      const [bx, bz] = p[i + 1];
      out.push([ax + (bx - ax) * 0.25, az + (bz - az) * 0.25], [ax + (bx - ax) * 0.75, az + (bz - az) * 0.75]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  const pts = [p[0]];
  let carry = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const [ax, az] = p[i];
    const [bx, bz] = p[i + 1];
    const l = Math.hypot(bx - ax, bz - az);
    let t = STEP - carry;
    while (t <= l) {
      pts.push([ax + ((bx - ax) * t) / l, az + ((bz - az) * t) / l]);
      t += STEP;
    }
    carry = l - (t - STEP);
  }
  pts.push(p[p.length - 1]);
  const n = pts.length;
  const arc = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));

  // the level: the ground, smoothed along the road (two passes over ±16 m) ...
  let level = pts.map(([x, z]) => pre(x, z));
  for (let pass = 0; pass < 2; pass++) {
    const sm = level.slice();
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, i - 8); k <= Math.min(n - 1, i + 8); k++) {
        s += level[k];
        c++;
      }
      sm[i] = s / c;
    }
    level = sm;
  }
  // ... dipped to the bed at each ford, easing down at a ford's grade ...
  const fords = [];
  for (let i = 0; i < n; i++) {
    const c = streams.nearest(pts[i][0], pts[i][1]);
    if (!c.seg || c.d > c.half) continue;
    let j = i;
    while (j + 1 < n) {
      const cj = streams.nearest(pts[j + 1][0], pts[j + 1][1]);
      if (!cj.seg || cj.d > cj.half) break;
      j++;
    }
    const m = Math.round((i + j) / 2);
    const cm = streams.nearest(pts[m][0], pts[m][1]);
    fords.push({ i: m, x: pts[m][0], z: pts[m][1], s: arc[m], bed: cm.bed, half: cm.half });
    i = j + 6;
  }
  for (const f of fords) {
    for (let k = 0; k < n; k++) level[k] = Math.min(level[k], f.bed + 0.12 + 0.075 * Math.max(0, Math.abs(arc[k] - f.s) - f.half));
  }
  // ... and held to a gentle grade both ways (cutting the crests, filling the dips half each)
  const pinned = level.map((_, i) => fords.some((f) => Math.abs(f.i - i) < 4));
  for (let it = 0; it < 600; it++) {
    for (let i = 1; i < n; i++) {
      const lim = MAX_GRADE * (arc[i] - arc[i - 1]);
      const dh = level[i] - level[i - 1];
      if (Math.abs(dh) <= lim) continue;
      const fix = ((Math.abs(dh) - lim) * Math.sign(dh)) / 2;
      // (never lifted out of a ford: those only move down)
      if (!pinned[i]) level[i] -= fix;
      if (!pinned[i - 1]) level[i - 1] += fix;
    }
  }

  // spatial hash of segments
  const CELL = 16;
  const reach = ROAD_FLAT + LANDING + 18;
  const cells = new Map();
  const key = (gx, gz) => (gx + 4096) * 8192 + (gz + 4096);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    minX = Math.min(minX, ax);
    maxX = Math.max(maxX, ax);
    minZ = Math.min(minZ, az);
    maxZ = Math.max(maxZ, az);
    for (let gz = Math.floor((Math.min(az, bz) - reach) / CELL); gz <= Math.floor((Math.max(az, bz) + reach) / CELL); gz++) {
      for (let gx = Math.floor((Math.min(ax, bx) - reach) / CELL); gx <= Math.floor((Math.max(ax, bx) + reach) / CELL); gx++) {
        const k = key(gx, gz);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
      }
    }
  }
  R = { pts, arc, level, fords, cells, key, CELL, n, len: arc[n - 1], box: [minX - reach, minZ - reach, maxX + reach, maxZ + reach] };
  return R;
}

/** The built road (after initRoad), or null. */
export const road = () => R;

const near = { d: Infinity, u: 0, s: 0, i: -1, level: 0 };
/**
 * Nearest point of the road to (x, z): d (m), u (signed across, + to the left going east), s (m along),
 * level there. One shared object (copy what you need). d = Infinity away from it.
 */
export function roadAt(x, z) {
  near.d = Infinity;
  if (!R || x < R.box[0] || z < R.box[1] || x > R.box[2] || z > R.box[3]) return near;
  const list = R.cells.get(R.key(Math.floor(x / R.CELL), Math.floor(z / R.CELL)));
  if (!list) return near;
  const { pts, arc, level } = R;
  for (const i of list) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = ((x - ax) * dx + (z - az) * dz) / l2;
    // (past the ends the distance is round the end point: a landing is round)
    t = Math.min(1, Math.max(0, t));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < near.d) {
      near.d = d;
      near.u = (dx * (z - az) - dz * (x - ax)) >= 0 ? -d : d;
      near.s = arc[i] + (arc[i + 1] - arc[i]) * t;
      near.i = i;
      near.level = level[i] + (level[i + 1] - level[i]) * t;
    }
  }
  return near;
}

/** How much wider the level ground is at s along the road (the landings round each end). */
export function landingAt(s) {
  return R ? LANDING * Math.max(1 - smooth(10, 26, s), smooth(R.len - 26, R.len - 10, s)) : 0;
}

/**
 * The ground h at (x, z) with the road's shelf cut in: level across the flat, then a cut bank or a
 * fill slope (about 1 : 1.4) back to the ground; a small crown of 4 cm in the middle.
 */
export function roadShelf(x, z, h) {
  const r = roadAt(x, z);
  if (r.d === Infinity) return h;
  const flat = ROAD_FLAT + landingAt(r.s);
  const bank = Math.min(16, Math.max(1.6, 1.2 + 1.4 * Math.abs(r.level - h)));
  if (r.d > flat + bank) return h;
  const level = r.level + 0.04 * (1 - smooth(0, ROAD_SURFACE, r.d));
  const w = 1 - smooth(flat, flat + bank, r.d);
  return h + (level - h) * w;
}
