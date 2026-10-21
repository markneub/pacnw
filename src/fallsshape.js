/**
 * The waterfall's shape (falls.js builds it; terrain.js, streams.js and the trail read it).
 *
 * The main creek runs off the edge of the lower snow bench and drops ~46 m into a bowl cut back
 * into the riser below it, as at Oregon's Silver Falls: a horseshoe of basalt cliffs whose base is
 * undercut into a deep alcove (a soft layer weathered back under a hard cap), so the trail passes
 * behind the falling water.
 *
 * Plan view: a U opening downstream (+z). Its line is the face of the cliff (the cap's front): a
 * half ellipse round the back, then arms running downstream and flaring apart until the ground
 * outside falls to the bowl's floor. Every point near it has a signed distance d from that line
 * (> 0 into the rock) and φ, metres along it from the back (− west, + east). The alcove runs back
 * D(φ) m behind the face round the back of the U.
 *
 * The terrain is a height field, so it can't overhang: inside the U and under the overhang it's
 * the bowl's floor, rising to the natural ground well behind the alcove (one terrain cell clear
 * of it, so no terrain triangle tilts into the alcove); falls.js lays the cliff over that, a
 * mesh that can overhang, with its top following the natural ground.
 *
 * Pure functions (no imports): terrain.js uses them in baseHeight.
 */

/** The U's frame: its middle (a = z − z0 downstream, l = x − x0 across), half-width W, and the back's depth Lb. */
export const FALLS = {
  x: -24, z: -398,
  W: 22, Lb: 14, flare: 0.15, armEnd: 78,
  floor: 96, // the bowl's floor at the plunge pool
  slope: 0.03, // its fall downstream
  alcove: 10, // m, the alcove's depth round the back
  alcoveEnd: 31, // |φ| where it closes up (tapering from alcoveEnd − 9)
  pool: { x: -24, z: -402, rl: 10, ra: 8, depth: 3 },
};

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** A smooth wobble along the line (m). */
const wob = (s) => 1.1 * Math.sin(s * 0.21 + 1.3) + 0.45 * Math.sin(s * 0.47 + 0.4);

/** The face line as a dense polyline from the west arm's end round the back to the east arm's: { x, z, nx, nz, phi }. */
export const LINE = (() => {
  const { x: x0, z: z0, W, Lb, flare, armEnd } = FALLS;
  const raw = [];
  for (let a = armEnd; a > 0; a -= 0.5) raw.push([-(W + flare * a), a]);
  for (let k = 0; k <= 240; k++) {
    const t = -Math.PI / 2 + (k / 240) * Math.PI;
    raw.push([W * Math.sin(t), -Lb * Math.cos(t)]);
  }
  for (let a = 0.5; a <= armEnd; a += 0.5) raw.push([W + flare * a, a]);
  // arc length, then the wobble (outward), resampled every 0.25 m
  const len = [0];
  for (let i = 1; i < raw.length; i++) len.push(len[i - 1] + Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]));
  const mid = len[raw.findIndex((p) => p[0] >= 0)];
  // (the line runs west arm → back → east arm: counter-clockwise seen from above, so the rock is on
  // its left in x/z: outward = (dz, −dx))
  const pts = raw.map((p, i) => {
    const q0 = raw[Math.max(0, i - 1)];
    const q1 = raw[Math.min(raw.length - 1, i + 1)];
    const l = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
    const w = wob(len[i] - mid) * smooth(armEnd, armEnd - 20, p[1]);
    return [p[0] + ((q1[1] - q0[1]) / l) * w, p[1] - ((q1[0] - q0[0]) / l) * w];
  });
  const out = [];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const l = Math.hypot(bx - ax, bz - az);
    let t = -carry;
    if (i === 1) out.push([ax, az]);
    for (t += 0.25; t <= l; t += 0.25) out.push([ax + ((bx - ax) * t) / l, az + ((bz - az) * t) / l]);
    carry = l - (t - 0.25);
  }
  // φ from the back (the point straight upstream of the middle), normals outward
  let back = 0;
  out.forEach((p, i) => {
    if (p[1] < out[back][1] && Math.abs(p[0]) < 6) back = i;
  });
  const res = [];
  let s = 0;
  for (let i = 0; i < out.length; i++) {
    if (i > 0) s += Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
    res.push({ x: x0 + out[i][0], z: z0 + out[i][1], s });
  }
  const sBack = res[back].s;
  for (let i = 0; i < res.length; i++) {
    const p = res[Math.max(0, i - 1)];
    const q = res[Math.min(res.length - 1, i + 1)];
    const l = Math.hypot(q.x - p.x, q.z - p.z);
    res[i].nx = (q.z - p.z) / l;
    res[i].nz = -(q.x - p.x) / l;
    res[i].phi = res[i].s - sBack;
  }
  if (res[back].nz > 0) throw new Error('falls: the face line runs the wrong way'); // (at the back, outward is upstream: −z)
  // the normals smoothed over ±8 m (the cliff mesh's columns run back along them: along the line's
  // own, its wobbles crossed neighbouring columns over a few metres back and folded the cliff top)
  for (let i = 0; i < res.length; i++) {
    let x = 0;
    let z = 0;
    for (let k = Math.max(0, i - 32); k <= Math.min(res.length - 1, i + 32); k++) {
      x += res[k].nx;
      z += res[k].nz;
    }
    const l = Math.hypot(x, z);
    res[i].sx = x / l;
    res[i].sz = z / l;
  }
  return res;
})();

/** The point of the face line nearest φ (its points are 0.25 m apart). */
export function lineAt(phi) {
  const i = Math.round((phi - LINE[0].phi) / 0.25);
  return LINE[Math.max(0, Math.min(LINE.length - 1, i))];
}

/** The lip, where the creek goes over (the back of the U, φ = 0). */
export const LIP = LINE.find((p) => p.phi === 0);

/**
 * A smooth "how far round the U" coordinate at any point (≈ φ on the face line, − west, + east):
 * the angle round the back's half ellipse scaled to its arc length, then metres down the arms. The
 * nearest point's φ won't do behind the face: where the line bends it jumps (7 m in 2.5 m), and
 * the cliff's top, which depends on it, folded into sheets hanging over the face.
 */
const Q = (() => {
  // the back's quarter arc on each side, from the line itself
  const at0 = (sgn) => LINE.filter((p) => Math.sign(p.phi) === sgn).reduce((b, p) => (Math.abs(p.z - FALLS.z) < Math.abs(b.z - FALLS.z) ? p : b));
  return (Math.abs(at0(1).phi) + Math.abs(at0(-1).phi)) / 2;
})();
export function sAt(x, z) {
  const a = z - FALLS.z;
  const l = x - FALLS.x;
  const sgn = l < 0 ? -1 : 1;
  if (a >= 0) return sgn * (Q + a * Math.hypot(1, FALLS.flare));
  return sgn * Q * (Math.atan2(Math.abs(l) / FALLS.W, -a / FALLS.Lb) / (Math.PI / 2));
}

/** The alcove's depth behind the face at s (sAt; m): 0 along the arms. */
export function alcoveDepth(s) {
  return FALLS.alcove * (1 - smooth(FALLS.alcoveEnd - 9, FALLS.alcoveEnd, Math.abs(s)));
}
/** How much of the drop at s (sAt) is cliff: all of it round the back, none along the arms' lower reaches (steep wooded slopes). */
export function cliffShare(phi) {
  return 1 - smooth(45, 62, Math.abs(phi));
}
/** The grade of the slope above the cliff where it isn't all cliff (the arms). */
const GRADE = 0.55;
/**
 * How far behind the face the terrain stays at the floor, hidden under the cliff: one terrain cell's
 * diagonal past the alcove (none where there's no cliff to hide it).
 */
export const behind = (phi) => (alcoveDepth(phi) + 7.5) * smooth(0.02, 0.2, cliffShare(phi));
export const RISE = 5; // m over which it climbs back to the surface above

// Signed distance and φ on a 1 m grid over the U (built on first use)
const G = { x0: 0, z0: 0, nx: 0, nz: 0, d: null, phi: null };
function field() {
  if (G.d) return G;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of LINE) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const M = 32;
  G.x0 = Math.floor(minX - M);
  G.z0 = Math.floor(minZ - M);
  G.nx = Math.ceil(maxX + M) - G.x0 + 1;
  G.nz = Math.ceil(maxZ + 2) - G.z0 + 1;
  G.d = new Float32Array(G.nx * G.nz);
  G.phi = new Float32Array(G.nx * G.nz);
  const n = LINE.length;
  for (let j = 0; j < G.nz; j++) {
    const z = G.z0 + j;
    for (let i = 0; i < G.nx; i++) {
      const x = G.x0 + i;
      let best = Infinity;
      let bk = 0;
      for (let k = 0; k < n; k += 4) {
        const dx = x - LINE[k].x;
        const dz = z - LINE[k].z;
        const q = dx * dx + dz * dz;
        if (q < best) {
          best = q;
          bk = k;
        }
      }
      for (let k = Math.max(0, bk - 4); k <= Math.min(n - 1, bk + 4); k++) {
        const dx = x - LINE[k].x;
        const dz = z - LINE[k].z;
        const q = dx * dx + dz * dz;
        if (q < best) {
          best = q;
          bk = k;
        }
      }
      const p = LINE[bk];
      const side = (x - p.x) * p.nx + (z - p.z) * p.nz;
      // (past the arms' ends: outside, whatever the side)
      const dd = Math.sqrt(best);
      G.d[j * G.nx + i] = z > FALLS.z + FALLS.armEnd ? Math.max(dd, z - FALLS.z - FALLS.armEnd) : side >= 0 ? dd : -dd;
      G.phi[j * G.nx + i] = p.phi;
    }
  }
  return G;
}

const near = { d: 0, phi: 0, s: 0, a: 0 };
/**
 * Signed distance from the face (d > 0 in the rock), the nearest point's φ and sAt there, or null away from the falls.
 * One shared object, overwritten by the next call (copy what you need before calling anything else).
 */
export function fallsLocal(x, z) {
  const g = field();
  const fx = x - g.x0;
  const fz = z - g.z0;
  if (fx < 0 || fz < 0 || fx >= g.nx - 1 || fz >= g.nz - 1) return null;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const k = j * g.nx + i;
  const D = g.d;
  near.d = (D[k] * (1 - tx) + D[k + 1] * tx) * (1 - tz) + (D[k + g.nx] * (1 - tx) + D[k + g.nx + 1] * tx) * tz;
  // (φ: the nearest corner's, it jumps across the U's middle line)
  near.phi = g.phi[(j + (tz > 0.5 ? 1 : 0)) * g.nx + i + (tx > 0.5 ? 1 : 0)];
  near.s = sAt(x, z);
  near.a = z - FALLS.z;
  return near;
}

/** The bowl's floor level at (x, z). */
export function floorLevel(x, z) {
  const a = z - FALLS.z;
  return FALLS.floor - FALLS.slope * Math.max(0, a) + 0.25 * Math.sin(x * 0.31 + z * 0.17) * Math.sin(z * 0.23 - x * 0.11);
}

/**
 * The surface above the cliff at (x, z) (d > 0): the natural ground h0 behind a full cliff; along
 * the arms a steep slope up from the cliff's top (or the floor) to h0.
 */
export function topSurface(x, z, h0) {
  const f = fallsLocal(x, z);
  if (!f) return h0;
  const F = floorLevel(x, z);
  if (h0 <= F) return h0;
  return Math.min(h0, F + cliffShare(f.s) * (h0 - F) + GRADE * Math.max(0, f.d));
}

/**
 * The ground with the bowl cut into it: the floor inside the U and under the overhang, rising to
 * the surface above (topSurface) behind; a talus of rubble along the foot of the arms. h0 untouched
 * away from it, or where the natural ground is lower than the floor (past the mouth).
 */
export function cutBowl(x, z, h0) {
  const f = fallsLocal(x, z);
  if (!f) return h0;
  const F = floorLevel(x, z);
  if (h0 <= F) return h0;
  const D = alcoveDepth(f.s);
  const talus = 1.6 * smooth(-7, 0, f.d) * (1 - smooth(1, 5, D));
  const floor = Math.min(h0, F + talus);
  const top = Math.max(floor, topSurface(x, z, h0));
  const b = behind(f.s);
  if (f.d >= b + RISE) return top;
  return floor + (top - floor) * smooth(b, b + RISE, f.d);
}

/** The ground the streams see: the surface above the cliff over the overhang (the creek runs across its top to the lip), else cutBowl. */
export function streamGround(x, z, h0) {
  const f = fallsLocal(x, z);
  if (f && f.d > 0) return topSurface(x, z, h0);
  return cutBowl(x, z, h0);
}

/** The plunge pool: a bowl in the floor where the water lands (applied after the channels are carved). */
export function poolBowl(x, z, h) {
  const p = FALLS.pool;
  const r = Math.hypot((x - p.x) / p.rl, (z - p.z) / p.ra);
  if (r >= 1.3) return h;
  const bottom = FALLS.floor - 0.35 - p.depth * (1 - r * r);
  return Math.min(h, bottom + (h - bottom) * smooth(0.55, 1.3, r));
}
export const POOL_LEVEL = FALLS.floor - 0.35;

/** Over the overhang and the ground behind the cliff, where the cliff mesh is the surface (not the terrain). */
export function underCap(x, z) {
  const f = fallsLocal(x, z);
  if (!f || f.d <= 0 || cliffShare(f.s) < 0.02) return false;
  return f.d < behind(f.s) + RISE;
}

/**
 * The trail's way behind the falls, east to west: along the foot of the east arm's wall, into the
 * alcove (about halfway back under the overhang, ~12 m behind the falling water) and out along the
 * west wall. trail.js routes to its ends; this stretch is fixed.
 */
export function fallsPassage() {
  const out = [];
  for (let phi = 40; phi >= -40; phi -= 1.5) out.push(passageAt(phi, 0));
  return out;
}
/** The passage's line at φ, `off` m from it toward the rock (+) or the bowl (−); also its d there. */
export function passageAt(phi, off) {
  const p = lineAt(phi);
  const D = alcoveDepth(sAt(p.x, p.z));
  const d = D * 0.5 - 3 * (1 - D / FALLS.alcove) + off;
  return { x: p.x + p.nx * d, z: p.z + p.nz * d, d, D };
}

