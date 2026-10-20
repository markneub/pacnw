import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAVE, SEED } from './config.js';
import { rawGroundAt, mulberry32, setWalkModifier } from './terrain.js';
import { shared, patchSunlight, sunKey } from './materials.js';
import { loadTextureSet } from './textures.js';

/**
 * The cave north of the trailhead (config.js CAVE): a natural tunnel in the south nose of a low
 * hillock, torches on its walls, and at the far end, ~130 m in, an opening onto the forest. Walk out
 * of it and you're walking out of the same mouth, and day has turned to night (or back): there is
 * no transition. The far end is the mouth turned round (its last S m mirror the first), its opening
 * shows the view out of the mouth at the other time of day (main.js renders it), and near the end
 * you're moved to the matching spot by the mouth, where nothing on screen differs.
 *
 * - The tunnel is one tube along a straight axis (wandering a little sideways), its floor falling
 *   8.5% so it's soon well under the hill (the terrain over it never dips into it); the crag
 *   around the mouth shares the tube's first ring and recedes into the hillside.
 * - Lit by its own torches (a standard material patched like the cabin's: no real three.js lights,
 *   which would cost every material in the scene). The four torches nearest the camera cast
 *   shadows from distance cube maps re-rendered as their flames flicker and sway; the rest light
 *   without. Outdoor light reaches only the first metres at either end.
 * - In the tunnel the player walks on its floor, kept between its walls; trees above don't
 *   collide. Outside, the crag is a collider.
 */

const L = CAVE.length;
const [DX, DZ] = CAVE.dir;
const GRADE = 0.085;
const DS = 0.33; // ring spacing (m)
const NA = 36; // vertices over the arch
const NF = 12; // floor segments
const M = NA + NF; // vertices per ring
const SH_FAR = 22; // m: shadow cube range
const SH_SLOTS = 4;
const TORCH_I = 6.5;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// The tunnel's shape, in its own frame: s along the axis (0 at the mouth), v across (positive to
// the right looking in), y up from the floor. GLSL copies below must match.
// ---------------------------------------------------------------------------
//
// The far end is the mouth again: its last S m are the first S m turned round (rotated 180° about
// the vertical through the tunnel's middle, and lower by D), walls, stones, torches and all, and
// through its opening you see what's outside the mouth (main.js renders the view from the matching
// spot there). So walking into it, you're moved to that spot without anything on screen changing.
let Y0 = 0; // floor height at the mouth (planCave)
const S = 20; // the mirrored stretch at each end
const SEAM = L - S - 3; // beyond it, the shaders texture the rock as at its counterpart by the mouth
const g0 = (s) => GRADE * Math.max(0, s - 3 * (1 - Math.exp(-Math.max(s, 0) / 3)));
const D = -GRADE * (L - 2 * S); // how much lower the far end is
export const floorAt = (s) => (s <= S ? Y0 - g0(s) : s >= L - S ? Y0 - g0(L - s) + D : Y0 - g0(S) - GRADE * (s - S));
const wiggle0 = (s) => (0.55 * Math.sin(0.047 * s + 1.0) + 0.3 * Math.sin(0.13 * s + 2.0) - (0.55 * Math.sin(1.0) + 0.3 * Math.sin(2.0)))
  * smooth(3, 14, s) * (1 - smooth(L / 2 - 20, L / 2, s));
const wiggle = (s) => (s <= L / 2 ? wiggle0(s) : -wiggle0(L - s)); // (turned round: the other side)
const halfW = (s) => {
  const m = Math.min(s, L - s);
  return 1.75 + 0.22 * Math.sin(0.21 * m + 0.3) + 0.15 * Math.sin(0.53 * m + 1.7) - 0.3 * (1 - smooth(0, 5, m));
};
const height = (s) => {
  const m = Math.min(s, L - s);
  return 3.1 + 0.35 * Math.sin(0.17 * m + 2.2) + 0.2 * Math.sin(0.41 * m) - 0.5 * (1 - smooth(0, 4, m));
};
/** The turn: maps a point near the far end to its counterpart near the mouth (it's its own inverse, apart from D). */
const MID = toWorldEarly(L / 2, 0);
function toMouth(p, out = p) {
  return out.set(2 * MID[0] - p.x, p.y - D, 2 * MID[1] - p.z);
}
function toEnd(p, out = p) {
  return out.set(2 * MID[0] - p.x, p.y + D, 2 * MID[1] - p.z);
}
function toWorldEarly(s, v) {
  return [CAVE.x + DX * s - DZ * v, CAVE.z + DZ * s + DX * v];
}
/** The same turns as matrices (for geometry and cameras). */
export const END_TO_MOUTH = new THREE.Matrix4().set(-1, 0, 0, 2 * MID[0], 0, 1, 0, -D, 0, 0, -1, 2 * MID[1], 0, 0, 0, 1);
const MOUTH_TO_END = new THREE.Matrix4().set(-1, 0, 0, 2 * MID[0], 0, 1, 0, D, 0, 0, -1, 2 * MID[1], 0, 0, 0, 1);
/** Half the walkable floor's width at s (the arch meets the floor at 0.79 of its half width; rubble along the edges). */
const floorHalf = (s) => 0.79 * halfW(s) - 0.3;

export const toLocal = (x, z) => {
  const ox = x - CAVE.x;
  const oz = z - CAVE.z;
  return [ox * DX + oz * DZ, -ox * DZ + oz * DX];
};
export const toWorld = (s, v) => [CAVE.x + DX * s - DZ * v, CAVE.z + DZ * s + DX * v];

/** Where the cave is: call once the terrain is ready. blocked() keeps the scatter off the crag and the approach. */
export function planCave() {
  // the floor at the mouth: level with the highest ground across the doorway (lower, and a view out
  // along the floor slipped under the lip of the ground in front)
  Y0 = -Infinity;
  for (let v = -1.8; v <= 1.8; v += 0.3) for (const ss of [0, -0.4, -0.8]) Y0 = Math.max(Y0, rawGroundAt(...toWorld(ss, v)));
  Y0 += 0.01;
  shared.uCaveO.value.set(CAVE.x, Y0, CAVE.z, L);
  shared.uCaveDir.value.set(DX, DZ);
  const blocked = (x, z, margin) => {
    const [s, v] = toLocal(x, z);
    const es = (s - 2) / (5 + margin);
    const ev = v / (6 + margin);
    if (es * es + ev * ev < 1) return true;
    return s > -6 - margin && s < 0 && Math.abs(v) < 2.5 + margin; // the way in
  };
  return { blocked, y: Y0 };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const rng = mulberry32(SEED + 4111);
const noise3 = createNoise3D(rng);
const fbm3 = (x, y, z) => 0.6 * noise3(x * 0.32, y * 0.32, z * 0.32) + 0.27 * noise3(x * 0.85 + 5, y * 0.85, z * 0.85) + 0.13 * noise3(x * 2.1, y * 2.1 + 3, z * 2.1);

/** Local (s, x, y) of ring vertex j at s (x is across, before the wiggle). Arch first, then the floor. */
function ringPoint(s, j, out) {
  const a = halfW(s);
  const H = height(s);
  const b = 0.62 * H;
  const c = H - b;
  const phi0 = Math.asin(c / b);
  const edge = a * Math.cos(phi0);
  let x;
  let y;
  let nx;
  let ny;
  if (j <= NA) {
    const phi = -phi0 + ((Math.PI + 2 * phi0) * j) / NA;
    x = a * Math.cos(phi);
    y = c + b * Math.sin(phi);
    nx = Math.cos(phi) / a;
    ny = Math.sin(phi) / b;
    const l = Math.hypot(nx, ny);
    nx /= l;
    ny /= l;
  } else {
    const k = j - NA; // 1 .. NF-1, left to right
    x = -edge + (2 * edge * k) / NF;
    const e = Math.abs(x) / edge;
    y = 0.2 * Math.pow(smooth(0.5, 1.0, e), 1.4); // the floor curls up into the walls (rubble, silt)
    nx = 0;
    ny = -1;
  }
  // rough rock: displaced along the section's outward normal (a little on the floor)
  const [wx, wz] = toWorld(s, x);
  const yy = floorAt(s) + y;
  const n = fbm3(wx, yy, wz);
  let d;
  if (j <= NA) {
    const ledge = 0.08 * smooth(0.35, 0.65, ((((y + 0.5 * noise3(wx * 0.2, yy * 0.2, wz * 0.2)) / 0.6) % 1) + 1) % 1);
    const nearFloor = smooth(0.0, 0.6, y);
    // (a ragged mouth, not a pipe's end: bigger, blockier lumps over the first metres)
    const mouth = 1 - smooth(0, 6, s);
    const lump = noise3(wx * 0.9 + 17, yy * 0.9, wz * 0.9) * 0.6 + noise3(wx * 1.9, yy * 1.9 - 4, wz * 1.9) * 0.4;
    d = (0.34 * n + ledge) * (0.35 + 0.65 * nearFloor) + mouth * nearFloor * (0.28 * lump + 0.12 * n);
  } else {
    d = 0.05 * n + 0.06 * Math.max(0, noise3(wx * 0.7, 0, wz * 0.7));
  }
  out[0] = s;
  out[1] = x + nx * d;
  out[2] = j <= NA ? y + ny * d : y + d; // (the floor: bumps up and down)
  return out;
}

/** Vertex j's counterpart on a ring turned round (the arch runs the other way, so does the floor). */
const mirrorJ = (j) => (j <= NA ? NA - j : M + NA - j);
/**
 * Ring vertex j at s, anywhere: near the far end, the mouth's ring turned round (blending into it
 * over the 6 m before, so the walls run on without a seam).
 */
function tunnelPoint(s, j, out) {
  if (s < L - S - 6) return ringPoint(s, j, out);
  ringPoint(L - s, mirrorJ(j), out);
  const mx = -out[1];
  const my = out[2];
  out[0] = s;
  if (s < L - S) {
    const k = smooth(L - S - 6, L - S, s);
    const own = ringPoint(s, j, [0, 0, 0]);
    out[1] = own[1] + (mx - own[1]) * k;
    out[2] = own[2] + (my - own[2]) * k;
  } else {
    out[1] = mx;
    out[2] = my;
  }
  return out;
}

/** World position of a local (s, x, y) point (the axis wiggles across). */
function localToWorld(s, x, y, out) {
  const [wx, wz] = toWorld(s, x + wiggle(s));
  out.set(wx, floorAt(s) + y, wz);
  return out;
}

/** The tunnel tube, in chunks of ~10 m (each culled on its own), plus its far opening. */
function buildTube() {
  // rings every DS m from the mouth; the far end's mirror those exactly
  const near = [];
  for (let s = 0; s <= S + 1e-6; s += DS) near.push(s);
  const rings = [...near];
  const n = Math.round((L - 2 * near[near.length - 1]) / DS);
  for (let k = 1; k < n; k++) rings.push(near[near.length - 1] + ((L - 2 * near[near.length - 1]) * k) / n);
  for (let k = near.length - 1; k >= 0; k--) rings.push(L - near[k]);
  const R = rings.length;
  const pos = new Float32Array(R * M * 3);
  const loc = new Float32Array(R * M * 3); // local (s, x, y), for the crag and the torches
  const p = [0, 0, 0];
  const w = new THREE.Vector3();
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < M; j++) {
      tunnelPoint(rings[i], j, p);
      loc.set(p, (i * M + j) * 3);
      localToWorld(p[0], p[1], p[2], w);
      pos.set([w.x, w.y, w.z], (i * M + j) * 3);
    }
  }
  // normals from the grid, pointing into the tunnel
  const nrm = new Float32Array(R * M * 3);
  const P = (i, j) => {
    const k = (Math.min(R - 1, Math.max(0, i)) * M + ((j + M) % M)) * 3;
    return new THREE.Vector3(pos[k], pos[k + 1], pos[k + 2]);
  };
  const c = new THREE.Vector3();
  for (let i = 0; i < R; i++) {
    const s = rings[i];
    localToWorld(s, 0, height(s) * 0.45, c);
    for (let j = 0; j < M; j++) {
      const ts = P(i + 1, j).sub(P(i - 1, j));
      const tj = P(i, j + 1).sub(P(i, j - 1));
      const n = new THREE.Vector3().crossVectors(tj, ts).normalize();
      if (n.dot(c.clone().sub(P(i, j))) < 0) n.negate();
      nrm.set([n.x, n.y, n.z], (i * M + j) * 3);
    }
  }
  // winding: front faces toward the inside (checked on the first quad)
  const a0 = P(0, 0);
  const tri = new THREE.Vector3().crossVectors(P(1, 0).sub(a0), P(0, 1).sub(a0));
  const n0 = new THREE.Vector3(nrm[0], nrm[1], nrm[2]);
  const flip = tri.dot(n0) < 0;
  const chunks = [];
  const PER = 30;
  for (let i0 = 0; i0 < R - 1; i0 += PER) {
    const i1 = Math.min(R - 1, i0 + PER);
    const n = i1 - i0 + 1;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.slice(i0 * M * 3, (i1 + 1) * M * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm.slice(i0 * M * 3, (i1 + 1) * M * 3), 3));
    g.setAttribute('aOut', new THREE.BufferAttribute(new Float32Array(n * M), 1)); // (0: inside)
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < M; j++) {
        const a = i * M + j;
        const b = (i + 1) * M + j;
        const cc = (i + 1) * M + ((j + 1) % M);
        const d = i * M + ((j + 1) % M);
        if (flip) idx.push(a, d, b, b, d, cc);
        else idx.push(a, b, d, b, cc, d);
      }
    }
    g.setIndex(idx);
    g.computeBoundingSphere();
    chunks.push(g);
  }
  // the far opening: the last ring, filled (main.js draws the view out of the mouth on it)
  const end = [];
  const ce = new THREE.Vector3();
  localToWorld(L, 0, height(L) * 0.4, ce);
  const last = (R - 1) * M;
  for (let j = 0; j < M; j++) {
    const k0 = (last + j) * 3;
    const k1 = (last + ((j + 1) % M)) * 3;
    end.push(ce.x, ce.y, ce.z, pos[k0], pos[k0 + 1], pos[k0 + 2], pos[k1], pos[k1 + 1], pos[k1 + 2]);
  }
  const endGeo = new THREE.BufferGeometry();
  endGeo.setAttribute('position', new THREE.Float32BufferAttribute(end, 3));
  const endRing = Array.from({ length: M }, (_, j) => new THREE.Vector3(pos[(last + j) * 3], pos[(last + j) * 3 + 1], pos[(last + j) * 3 + 2]));
  return { chunks, endGeo, endCentre: ce, endRing, loc, pos, rings };
}

/**
 * The crag around the mouth: rings around the opening (its first ring is the tube's), a rounded lip
 * that leans out, then rock receding into the hillside until the hill covers it.
 */
function buildCrag(tube) {
  const RHO = [0, 0.3, 0.75, 1.3, 2.0, 2.7, 3.4];
  const K = RHO.length;
  const pos = [];
  const H0 = height(0);
  const cy = 0.38 * H0;
  const w = new THREE.Vector3();
  for (let k = 0; k < K; k++) {
    const rho = RHO[k];
    for (let j = 0; j < M; j++) {
      const k0 = j * 3;
      const lx = tube.loc[k0 + 1];
      const ly = tube.loc[k0 + 2];
      if (k === 0) {
        pos.push(tube.pos[k0], tube.pos[k0 + 1], tube.pos[k0 + 2]);
        continue;
      }
      let ox = j > NA ? 0 : lx;
      let oy = j > NA ? -1.5 : ly - cy;
      const ol = Math.hypot(ox, oy) || 1;
      ox /= ol;
      oy /= ol;
      let x = lx + ox * rho;
      let y = ly + oy * rho;
      let s = -(0.3 * smooth(0, 0.75, rho) - 0.9 * Math.pow(Math.max(0, rho - 1.0), 1.2));
      // craggy: blocky lumps (folded noise: sharp creases), and ledges along the bedding
      const [nx0, nz0] = toWorld(s, x);
      const n = fbm3(nx0 * 0.7 + 40, (Y0 + y) * 0.7, nz0 * 0.7);
      const crease = 1 - 2 * Math.abs(noise3(nx0 * 0.45 - 7, (Y0 + y) * 0.45, nz0 * 0.45));
      const amp = (0.22 + 0.07 * rho) * smooth(0, 0.6, rho);
      const ledge = 0.25 * smooth(0.3, 0.7, ((((y + 0.6 * n) / 0.9) % 1) + 1) % 1) * smooth(0.5, 1.5, rho);
      s -= (n * 0.7 + crease * 0.5) * amp + ledge;
      // (its inner rings stay out of the tunnel: seen from inside they'd be rock the far end lacks)
      if (rho < 1.5) s = Math.min(s, -0.03);
      x += ox * n * amp * 0.6;
      y += oy * n * amp * 0.6;
      // recede into the hill: far out, push each vertex in until the ground covers it
      // (back up to 4 m, then down: at the nose's sides the hill is low, and pushing in alone drew
      // long wedges along it)
      for (let it = 0; it < 56 && rho >= 2; it++) { // (nearer the rim, pushed in, they cut through the tunnel's roof)
        localToWorld(s, x, y, w);
        if (w.y < rawGroundAt(w.x, w.z) - (rho > 2 ? 0.3 : 0.05)) break;
        if (it < 16) s += 0.25;
        else y -= 0.25;
      }
      localToWorld(s, x, y, w);
      pos.push(w.x, w.y, w.z);
    }
  }
  const idx = [];
  for (let k = 0; k < K - 1; k++) {
    for (let j = 0; j < M; j++) {
      const a = k * M + j;
      const b = (k + 1) * M + j;
      const c = (k + 1) * M + ((j + 1) % M);
      const d = k * M + ((j + 1) % M);
      idx.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // outward (toward the approach, -dir): flip the winding if it came out the other way
  const nA = g.getAttribute('normal');
  let dot = 0;
  for (let j = 0; j < NA; j++) dot += -(nA.getX(2 * M + j) * DX + nA.getZ(2 * M + j) * DZ);
  if (dot < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  g.setAttribute('aOut', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(1), 1)); // outdoors
  g.computeBoundingSphere();
  return g;
}

/**
 * One rough stone: a rounded box (superellipsoid) of half-sizes (hx, hy, hz), its faces dented
 * by noise. Returns a geometry centred on the origin.
 */
function stoneGeometry(hx, hy, hz, seed, { round = 3.2, rough = 0.07, seg = 5 } = {}) {
  const g = new THREE.BoxGeometry(2, 2, 2, seg, seg, seg);
  const p = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // box -> superellipsoid: normalise in the L^round norm
    const l = Math.pow(Math.pow(Math.abs(v.x), round) + Math.pow(Math.abs(v.y), round) + Math.pow(Math.abs(v.z), round), 1 / round);
    v.divideScalar(l);
    const n = noise3(v.x * 1.3 + seed, v.y * 1.3, v.z * 1.3 - seed) * 0.7 + noise3(v.x * 3.1 - seed, v.y * 3.1, v.z * 3.1) * 0.3;
    v.multiplyScalar(1 + rough * n);
    p.setXYZ(i, v.x * hx, v.y * hy, v.z * hz);
  }
  g.deleteAttribute('uv');
  const m = mergeVertices(g);
  m.computeVertexNormals();
  return m;
}
// (BoxGeometry duplicates its edge vertices per face: weld them so the stone shades smoothly)
function mergeVertices(g) {
  const p = g.getAttribute('position');
  const map = new Map();
  const remap = [];
  const out = [];
  for (let i = 0; i < p.count; i++) {
    const key = `${Math.round(p.getX(i) * 1e4)},${Math.round(p.getY(i) * 1e4)},${Math.round(p.getZ(i) * 1e4)}`;
    let k = map.get(key);
    if (k === undefined) {
      k = out.length / 3;
      map.set(key, k);
      out.push(p.getX(i), p.getY(i), p.getZ(i));
    }
    remap.push(k);
  }
  const idx = Array.from(g.getIndex().array, (i) => remap[i]);
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  m.setIndex(idx);
  return m;
}

/** Place a stone geometry in the cave frame: at local (s, v, y-from-world), turned by yaw (about up) and tilted. */
function placeStone(geo, s, v, y, { yaw = 0, pitch = 0, roll = 0 } = {}) {
  const [x, z] = toWorld(s, v);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, Math.atan2(-DX, -DZ) + yaw, roll, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  );
  return geo.applyMatrix4(m);
}

/** Loose rock along the tunnel's floor, and stalactites. */
function buildRubble() {
  const parts = [];
  const near = []; // (by the mouth: the far end gets the same, turned round)
  const r = mulberry32(SEED + 919);
  for (let s = 2.5; s < L - S; s += 0.5 + r() * 1.4) {
    const side = r() < 0.5 ? -1 : 1;
    // (small stones only: the boulders against the walls looked out of place, the user)
    const size = 0.1 + r() * 0.22;
    const v = side * (floorHalf(s) + 0.25 - r() * 0.6) + wiggle(s);
    const g = stoneGeometry(size * (1 + r() * 0.5), size * (0.55 + r() * 0.3), size, r() * 90, { round: 2.4 + r(), rough: 0.18, seg: 3 });
    (s < S ? near : parts).push(placeStone(g, s, v, floorAt(s) + size * 0.25, { yaw: r() * 6, pitch: (r() - 0.5) * 0.4, roll: (r() - 0.5) * 0.4 }));
  }
  // stalactites: short, knobbly cones down from the roof
  const cone = (len, rad, seed) => {
    const g = new THREE.ConeGeometry(rad, len, 6, 3, true).rotateX(Math.PI).translate(0, -len / 2, 0); // base at 0, tip down
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const k = 1 + 0.25 * noise3(p.getX(i) * 9 + seed, p.getY(i) * 9, p.getZ(i) * 9);
      p.setXYZ(i, p.getX(i) * k, p.getY(i), p.getZ(i) * k);
    }
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    return g;
  };
  for (let s = 6; s < L - S; s += 1.5 + r() * 4) {
    const v = (r() - 0.5) * halfW(s) * 0.9 + wiggle(s);
    const len = 0.15 + r() * 0.55;
    const g = cone(len, 0.04 + len * 0.12, r() * 30);
    // (the cones are open at the top: their base sits up inside the rock)
    const top = floorAt(s) + height(s) * (0.92 - 0.25 * Math.pow(Math.abs(v - wiggle(s)) / halfW(s), 2)) + 0.12;
    (s < S ? near : parts).push(placeStone(g, s, v, top, { yaw: r() * 6 }));
  }
  for (const g of near) parts.push(g, g.clone().applyMatrix4(MOUTH_TO_END));
  const g = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  g.setAttribute('aOut', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count), 1));
  return g;
}

// ---------------------------------------------------------------------------
// Torches
// ---------------------------------------------------------------------------

/** Wall point at height y (local) on a side of the tube near s, from the generated rings. */
function wallAt(tube, s, side, y) {
  const i = Math.round(s / DS);
  let best = null;
  for (let j = 0; j <= NA; j++) {
    const k = (i * M + j) * 3;
    const lx = tube.loc[k + 1];
    const ly = tube.loc[k + 2];
    if (Math.sign(lx) !== side) continue;
    const d = Math.abs(ly - y);
    if (!best || d < best.d) best = { d, x: lx, y: ly };
  }
  return best;
}

function torchPlan(tube) {
  const torches = [];
  // two a few metres in, one on each wall (they light the ground outside too)
  for (const side of [-1, 1]) {
    const ss = 3;
    const lo = wallAt(tube, ss, side, 1.45);
    const hi = wallAt(tube, ss, side, 2.05);
    torches.push({ s: ss, v: lo.x - side * 0.03, y: floorAt(ss) + lo.y, top: [hi.x - side * 0.36, hi.y], side });
  }
  // inside, every 12 m, alternating sides: the bracket on the wall at ~1.5 m, the stick leaning
  // out so its flame burns ~0.3 m clear of the wall (which curves in above ~1.1 m)
  let side = 1;
  for (let s = 15; s <= L - 27; s += 12) {
    const lo = wallAt(tube, s, side, 1.5);
    const hi = wallAt(tube, s, side, 2.15);
    const w = wiggle(s);
    const base = [lo.x - side * 0.03 + w, lo.y];
    const top = [hi.x - side * 0.36 + w, hi.y];
    torches.push({ s, v: base[0], y: floorAt(s) + base[1], top, side });
    side = -side;
  }
  for (const t of torches) {
    const [x, z] = toWorld(t.s, t.v);
    t.base = new THREE.Vector3(x, t.y, z);
    if (t.top) {
      // the stick runs from the bracket to just under the flame
      const [tx, tz] = toWorld(t.s, t.top[0]);
      t.axis = new THREE.Vector3(tx, floorAt(t.s) + t.top[1] - 0.16, tz).sub(t.base).normalize();
      t.out = [-DZ * -t.side, DX * -t.side]; // toward the axis (the bracket's strap points the other way)
    } else {
      // the stick leans out from the wall and up
      t.axis = new THREE.Vector3(t.out[0] * t.lean, 1, t.out[1] * t.lean).normalize();
    }
    t.head = t.base.clone().addScaledVector(t.axis, 0.5);
    t.flame = t.head.clone().addScaledVector(t.axis, 0.04).add(new THREE.Vector3(0, 0.09, 0)); // (just over the head's top: the flame grows out of it)
    t.phase = t.s * 1.7 + t.v * 3.1;
    t.light = t.flame.clone();
    t.intensity = TORCH_I;
  }
  // and the far end's, turned round from the mouth's (the same flicker: they're the same torches)
  for (const t of torches.filter((tc) => tc.s <= S)) {
    const m = { ...t, mirror: true, s: L - t.s };
    m.base = toEnd(t.base.clone());
    m.head = toEnd(t.head.clone());
    m.flame = toEnd(t.flame.clone());
    m.light = m.flame.clone();
    m.axis = new THREE.Vector3(-t.axis.x, t.axis.y, -t.axis.z);
    m.out = [-t.out[0], -t.out[1]];
    torches.push(m);
  }
  return torches;
}

/** The torches' sticks, pitch-soaked heads and iron brackets (vertex colours). */
function torchGeometry(torches) {
  const parts = [];
  const col = (g, c) => {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const wood = new THREE.Color(0.2, 0.12, 0.06);
  const pitch = new THREE.Color(0.035, 0.028, 0.022);
  const iron = new THREE.Color(0.05, 0.048, 0.046);
  const up = new THREE.Vector3(0, 1, 0);
  for (const t of torches) {
    const q = new THREE.Quaternion().setFromUnitVectors(up, t.axis);
    const at = (g, along) => g.applyQuaternion(q).translate(...t.base.clone().addScaledVector(t.axis, along).toArray());
    parts.push(col(at(new THREE.CylinderGeometry(0.026, 0.02, 0.56, 7), 0.22), wood));
    // the head: rags wound round and soaked in pitch, charred and lumpy
    const head = new THREE.CylinderGeometry(0.05, 0.042, 0.16, 9, 3);
    const p = head.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const k = 1 + 0.18 * noise3(p.getX(i) * 30 + t.phase, p.getY(i) * 30, p.getZ(i) * 30);
      p.setXYZ(i, p.getX(i) * k, p.getY(i), p.getZ(i) * k);
    }
    col(head, pitch);
    // the top of the head burns: embers glowing through the charred pitch (colours above 1 glow, caveMaterial 'plain')
    {
      const hp = head.getAttribute('position');
      const hc = head.getAttribute('color');
      for (let i = 0; i < hp.count; i++) {
        const y = hp.getY(i); // -0.08 .. 0.08
        const n = noise3(hp.getX(i) * 40 + t.phase, y * 40, hp.getZ(i) * 40);
        const hot = smooth(-0.04, 0.07, y + 0.03 * n) * (0.55 + 0.45 * n);
        if (hot > 0.05) hc.setXYZ(i, 1 + 1.6 * hot, 1 + 0.45 * hot, 1 + 0.08 * hot);
      }
    }
    parts.push(at(head, 0.46));
    // bracket: a ring round the stick and a strap back to the wall
    const ring = new THREE.TorusGeometry(0.034, 0.008, 5, 10).rotateX(Math.PI / 2);
    parts.push(col(at(ring, 0.16), iron));
    const strapLen = 0.16;
    const strap = new THREE.BoxGeometry(0.022, 0.012, strapLen).translate(0, 0, -strapLen / 2);
    const yaw = Math.atan2(t.out[0], t.out[1]);
    strap.rotateY(yaw).translate(...t.base.clone().addScaledVector(t.axis, 0.16).toArray());
    parts.push(col(strap, iron));
    const plate = new THREE.BoxGeometry(0.09, 0.16, 0.015).rotateY(yaw);
    plate.translate(...t.base.clone().addScaledVector(t.axis, 0.16).add(new THREE.Vector3(-t.out[0] * strapLen, -0.02, -t.out[1] * strapLen)).toArray());
    parts.push(col(plate, iron));
    for (const g of parts) if (g.getAttribute('normal') === undefined) g.computeVertexNormals();
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

const FLAME_GLSL = /* glsl */ `
  float fHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float fNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(fHash(i), fHash(i + vec2(1, 0)), f.x), mix(fHash(i + vec2(0, 1)), fHash(i + vec2(1, 1)), f.x), f.y);
  }
  float fFbm(vec2 p) { return fNoise(p) * 0.55 + fNoise(p * 2.1 + 3.7) * 0.3 + fNoise(p * 4.3 + 1.3) * 0.15; }
`;

/** Flames (and the soft glow round each): camera-facing quads, animated in the shader. */
function buildFlames(torches) {
  const quad = (glow) => {
    const centre = [];
    const corner = [];
    const seed = [];
    const idx = [];
    torches.forEach((t, i) => {
      for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        centre.push(t.flame.x, t.flame.y, t.flame.z);
        corner.push(cx, cy);
        seed.push(t.phase, i);
      }
      idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(centre, 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...toWorld(L / 2, 0), Y0), L);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime, uFlick: { value: new Array(torches.length).fill(1) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec2 aCorner;
        attribute vec2 aSeed;
        uniform float uTime;
        uniform float uFlick[${torches.length}];
        varying vec2 vUv;
        varying float vSeed;
        varying float vFlick;
        void main() {
          float flick = uFlick[int(aSeed.y + 0.5)];
          vec3 c = position;
          vec3 toCam = cameraPosition - c;
          ${glow ? `
          vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
          vec3 upv = normalize(cross(toCam, right));
          float r = 0.85 * (0.85 + 0.3 * flick);
          vec3 p = c + (right * aCorner.x + upv * aCorner.y) * r + normalize(toCam) * 0.3;` : `
          // upright (cylindrical) billboard, leaning with the draught
          toCam.y = 0.0;
          vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam + vec3(1e-4)));
          float h = 0.36 * (0.8 + 0.35 * flick);
          float lean = sin(uTime * 1.3 + aSeed.x) * 0.03;
          float yy = aCorner.y * 0.5 + 0.5;
          // (its foot wraps the burning head, a little below its rim)
          vec3 p = c + right * (aCorner.x * 0.12 + lean * yy) + vec3(0.0, yy * h - 0.15, 0.0) + normalize(cameraPosition - c) * 0.05;`}
          vUv = aCorner * 0.5 + 0.5;
          vSeed = aSeed.x;
          vFlick = flick;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying float vSeed;
        varying float vFlick;
        ${FLAME_GLSL}
        void main() {
          ${glow ? `
          vec2 d = vUv * 2.0 - 1.0;
          float g = exp(-dot(d, d) * 4.5) * (1.0 - smoothstep(0.6, 1.0, length(d)));
          gl_FragColor = vec4(vec3(1.0, 0.5, 0.18) * g * 0.16 * vFlick, 1.0);` : `
          float t = uTime;
          vec2 q = vec2(vUv.x * 2.0 - 1.0, vUv.y);
          float n = fFbm(vec2(q.x * 2.5 + vSeed, q.y * 3.5 - t * 3.2));
          float n2 = fFbm(vec2(q.x * 5.0 - vSeed, q.y * 6.0 - t * 5.5));
          // a teardrop that wavers and tears at the tip
          float x = q.x + (n - 0.5) * 0.7 * q.y;
          // wide and ragged at the foot (licking round the head), narrowing to a tip
          float w = mix(0.82, 0.04, pow(q.y, 0.75)) * (0.75 + 0.5 * n) * (1.0 + 0.25 * smoothstep(0.3, 0.0, q.y) * (n2 - 0.4));
          // a rounded foot, lowest in the middle (no straight edge across the head), soft and dim
          float foot = q.y - 0.16 * pow(abs(x) / max(w, 1e-3), 2.0);
          float body = smoothstep(w, w * 0.25, abs(x)) * smoothstep(0.0, 0.16, foot);
          float tip = 1.0 - smoothstep(0.35 + 0.35 * n2, 0.95, q.y);
          float f = body * tip;
          float heat = f * (1.15 - q.y);
          vec3 col = mix(vec3(0.55, 0.08, 0.01), vec3(1.0, 0.42, 0.07), smoothstep(0.05, 0.4, heat));
          col = mix(col, vec3(1.0, 0.86, 0.55), smoothstep(0.45, 0.85, heat));
          // a little blue where it's hottest, low down
          col += vec3(0.0, 0.03, 0.12) * smoothstep(0.15, 0.0, q.y) * body;
          gl_FragColor = vec4(col * f * 1.5 * (0.8 + 0.25 * vFlick), 1.0);`}
        }`,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = glow ? 21 : 20;
    mesh.frustumCulled = false;
    return mesh;
  };
  return [quad(false), quad(true)];
}

// ---------------------------------------------------------------------------
// Materials: the cave's own lighting
// ---------------------------------------------------------------------------

const U = {
  uCvWall: { value: null },
  uCvWallN: { value: null },
  uCvFloor: { value: null },
  uCvFloorN: { value: null },
  uCvWallAvg: { value: new THREE.Color(1, 1, 1) },
  uCvFloorAvg: { value: new THREE.Color(1, 1, 1) },
  uCvTile: { value: new THREE.Vector2(1 / 3.5, 1 / 2.5) },
  uTorch: { value: [] },
  uTorchCol: { value: new THREE.Color(1.0, 0.5, 0.2) },
  uSh: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  uShMap0: { value: null },
  uShMap1: { value: null },
  uShMap2: { value: null },
  uShMap3: { value: null },
  uCvMirror: { value: new THREE.Vector4() }, // 2 * middle x, D, 2 * middle z, SEAM (the far end's turn)
  uOutA: { value: new THREE.Color() }, // daylight (or moonlight) in at the mouth, this time of day
  uOutB: { value: new THREE.Color() }, // in at the far end: the other time of day (main.js)
};

function caveGLSL(nTorch) {
  return /* glsl */ `
  uniform vec4 uCaveO;
  uniform vec2 uCaveDir;
  uniform sampler2D uCvWall;
  uniform sampler2D uCvWallN;
  uniform sampler2D uCvFloor;
  uniform sampler2D uCvFloorN;
  uniform vec3 uCvWallAvg;
  uniform vec3 uCvFloorAvg;
  uniform vec2 uCvTile;
  uniform vec4 uTorch[${nTorch}];
  uniform vec3 uTorchCol;
  uniform vec4 uSh[4];
  uniform samplerCube uShMap0;
  uniform samplerCube uShMap1;
  uniform samplerCube uShMap2;
  uniform samplerCube uShMap3;
  uniform vec4 uCvMirror;
  uniform vec3 uOutA;
  uniform vec3 uOutB;
  varying vec3 vCvW;
  varying vec3 vCvN;
  varying float vCvOut; // 1: outdoor rock (the crag)
  vec3 cvN; // the shading normal, world space
  float cvS; // how far in (m along the axis)
  float cvFloorY; // the tunnel's floor there
  float cvSm; // how far from the nearer end
  vec3 cvP; // where to texture: near the far end, its counterpart by the mouth
  float cvG0(float s) { return ${GRADE} * max(0.0, s - 3.0 * (1.0 - exp(-max(s, 0.0) / 3.0))); }
  float cvFloor(float s) {
    float L = uCaveO.w;
    return s <= ${S.toFixed(1)} ? uCaveO.y - cvG0(s) : s >= L - ${S.toFixed(1)} ? uCaveO.y - cvG0(L - s) + uCvMirror.y
      : uCaveO.y - cvG0(${S.toFixed(1)}) - ${GRADE} * (s - ${S.toFixed(1)});
  }
  float cvOut; // 1 outdoors
  float cvRough = 0.9;
  float cvHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float cvNoise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(cvHash(i), cvHash(i + vec3(1, 0, 0)), f.x), mix(cvHash(i + vec3(0, 1, 0)), cvHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(cvHash(i + vec3(0, 0, 1)), cvHash(i + vec3(1, 0, 1)), f.x), mix(cvHash(i + vec3(0, 1, 1)), cvHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  // distance cube shadow (RGBA-packed distance / far), 5 taps across a flame-sized light
  float cvShadow(samplerCube m, vec3 lp) {
    vec3 L = vCvW + cvN * 0.05 - lp;
    float d = length(L);
    // slope-scaled: at grazing angles the wall shadowed itself, and the cube's face edges showed on it
    float ndl = abs(dot(cvN, L / d));
    float bias = 0.04 + d * 0.02 + 0.12 * (1.0 - ndl);
    vec3 a = normalize(cross(L, abs(L.y) < 0.9 * d ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 b = cross(normalize(L), a);
    float r = d * 0.018;
    float s = step(d - bias, unpackRGBAToDepth(textureCube(m, L)) * ${SH_FAR.toFixed(1)});
    s += step(d - bias, unpackRGBAToDepth(textureCube(m, L + a * r)) * ${SH_FAR.toFixed(1)});
    s += step(d - bias, unpackRGBAToDepth(textureCube(m, L - a * r)) * ${SH_FAR.toFixed(1)});
    s += step(d - bias, unpackRGBAToDepth(textureCube(m, L + b * r)) * ${SH_FAR.toFixed(1)});
    s += step(d - bias, unpackRGBAToDepth(textureCube(m, L - b * r)) * ${SH_FAR.toFixed(1)});
    return s * 0.2;
  }
  void cvLight(vec3 lp, float I, float sh, vec3 V, inout vec3 dif, inout vec3 spec) {
    vec3 L = lp - vCvW;
    float d2 = dot(L, L);
    float win = clamp(1.0 - d2 * d2 / ${(18 ** 4).toFixed(1)}, 0.0, 1.0);
    float att = I * win * win / (d2 + 1.2);
    L *= inversesqrt(d2);
    float ndl = max(dot(cvN, L), 0.0);
    dif += uTorchCol * att * ndl * sh;
    vec3 H = normalize(L + V);
    spec += uTorchCol * att * ndl * sh * pow(max(dot(cvN, H), 0.0), mix(6.0, 80.0, 1.0 - cvRough)) * 0.35 * (1.0 - cvRough);
  }`;
}

/**
 * kind: 'rock' (tube, crag: the rock photo, the floor photo on the floor), 'stone' (lighter,
 * lighter, lichen, moss outside), 'plain' (vertex colours: the torches).
 */
function caveMaterial(kind, nTorch) {
  const mat = new THREE.MeshStandardMaterial({
    color: kind === 'stone' ? new THREE.Color(0.17, 0.16, 0.15) : kind === 'rock' ? new THREE.Color(0.125, 0.115, 0.105) : 0xffffff,
    roughness: kind === 'plain' ? 0.8 : 0.92,
    metalness: 0,
    vertexColors: kind === 'plain',
    // (double-sided: where the crag's rings fold at the doorway's corners, a crack shows rock, not sky)
    side: kind === 'rock' ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    patchSunlight(shader, { torches: false }); // (outside: the canopy's shade and dapple, like everything else; its own torches below)
    Object.assign(shader.uniforms, U);
    shader.uniforms.uCaveO = shared.uCaveO;
    shader.uniforms.uCaveDir = shared.uCaveDir;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCvW;\nvarying vec3 vCvN;\nvarying float vCvOut;\n${kind === 'rock' ? 'attribute float aOut;' : ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vCvW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vCvN = normalize(mat3(modelMatrix) * objectNormal);
        vCvOut = ${kind === 'rock' ? 'aOut' : '0.0'};`);
    const textured = kind !== 'plain';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <packing>', `#include <packing>\n${caveGLSL(nTorch)}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        cvN = normalize(vCvN) * (gl_FrontFacing ? 1.0 : -1.0); // (rock is double-sided)
        cvS = dot(vCvW.xz - uCaveO.xz, uCaveDir);
        cvSm = min(cvS, uCaveO.w - cvS);
        cvFloorY = cvFloor(cvS);
        // outdoors: in front of the mouth, the crag (aOut), and the tunnel's outside (back faces,
        // only seen from outdoors over the mouth); inside, a model of the light that comes in at both ends
        cvOut = max(vCvOut, max(step(cvS, 0.0), gl_FrontFacing ? 0.0 : 1.0));
        bool cvM = cvS > uCvMirror.w;
        cvP = cvM ? vec3(uCvMirror.x - vCvW.x, vCvW.y - uCvMirror.y, uCvMirror.z - vCvW.z) : vCvW;
        vec3 cvNt = cvM ? vec3(-cvN.x, cvN.y, -cvN.z) : cvN;
        ${textured ? `{
          // triplanar rock photo (modulating the base colour), the floor photo on the floor inside
          vec3 bw = pow(abs(cvNt), vec3(4.0));
          bw /= bw.x + bw.y + bw.z;
          vec2 px = cvP.zy * uCvTile.x, py = cvP.xz * uCvTile.x, pz = cvP.xy * uCvTile.x;
          vec3 tw = (texture2D(uCvWall, px).rgb * bw.x + texture2D(uCvWall, py).rgb * bw.y + texture2D(uCvWall, pz).rgb * bw.z) / uCvWallAvg;
          vec3 tnx = texture2D(uCvWallN, px).xyz * 2.0 - 1.0;
          vec3 tny = texture2D(uCvWallN, py).xyz * 2.0 - 1.0;
          vec3 tnz = texture2D(uCvWallN, pz).xyz * 2.0 - 1.0;
          vec3 pert = vec3(0.0, tnx.y, tnx.x) * bw.x + vec3(tny.x, 0.0, tny.y) * bw.y + vec3(tnz.x, tnz.y, 0.0) * bw.z;
          float fl = ${kind === 'rock' ? '1.0' : '0.0'} * smoothstep(0.55, 0.85, cvN.y) * smoothstep(-0.5, 1.0, cvSm) * step(vCvW.y, cvFloorY + 0.6);
          vec2 pf = cvP.xz * uCvTile.y;
          vec3 tf = texture2D(uCvFloor, pf).rgb / uCvFloorAvg;
          vec3 tfn = texture2D(uCvFloorN, pf).xyz * 2.0 - 1.0;
          float tone = 0.8 + 0.4 * cvNoise(cvP * 0.35); // big patches of lighter and darker rock
          diffuseColor.rgb *= mix(clamp(tw, 0.0, 3.0), clamp(tf, 0.0, 3.0) * vec3(1.15, 1.0, 0.9), fl) * tone;
          pert = mix(pert, vec3(tfn.x, 0.0, tfn.y), fl);
          if (cvM) pert.xz = -pert.xz; // (back from the counterpart's frame)
          cvN = normalize(cvN + pert * 0.9);
          // damp: seeping water darkens and glosses streaks down the walls (it glints in the torchlight)
          float seep = smoothstep(0.55, 0.8, cvNoise(vec3(cvP.x * 1.6, cvP.y * 0.25, cvP.z * 1.6))) * smoothstep(1.0, 4.0, cvSm) * (1.0 - fl);
          diffuseColor.rgb *= 1.0 - 0.35 * seep;
          cvRough = mix(0.9, 0.3, seep);
          ${kind === 'stone' ? `
          // outside: lichen, and moss on the tops
          float lich = smoothstep(0.55, 0.75, cvNoise(cvP * 2.3));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.45, 0.36), lich * 0.5);` : ''}
          float moss = smoothstep(0.45, 0.85, cvN.y + 0.25 * cvNoise(cvP * 1.7)) * max(cvOut, 1.0 - smoothstep(0.5, 3.0, cvSm));
          // soot: years of smoke have blackened the rock above each torch
          float soot = 0.0;
          for (int i = 0; i < ${nTorch}; i++) {
            vec3 d = vCvW - uTorch[i].xyz;
            if (d.y > -0.1 && d.y < 2.0) {
              float r2 = d.x * d.x + d.z * d.z;
              soot = max(soot, exp(-r2 / (0.06 + 0.22 * d.y)) * smoothstep(-0.1, 0.35, d.y) * (1.0 - smoothstep(1.2, 2.0, d.y)));
            }
          }
          diffuseColor.rgb *= 1.0 - 0.7 * soot * (0.75 + 0.5 * cvNoise(cvP * 6.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.1, 0.035) * (0.7 + 0.6 * cvNoise(cvP * 4.0)), moss * 0.85);
        }` : ''}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = cvRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(cvN, 0.0)).xyz);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          // inside: only the light that comes in at either end reaches the walls, over the first few
          // metres (the same model at both ends, so the far end, lit as the mouth is at the other
          // time of day, matches the mouth when you come out of it)
          float interior = 1.0 - cvOut;
          vec3 toMouth = vec3(-uCaveDir.x, 0.0, -uCaveDir.y);
          vec3 amb = uOutA * exp(-max(cvS, 0.0) / 2.5) * (0.55 + 0.45 * max(dot(cvN, toMouth), 0.0))
            + uOutB * exp(-max(uCaveO.w - cvS, 0.0) / 2.5) * (0.55 + 0.45 * max(dot(cvN, -toMouth), 0.0));
          reflectedLight.directDiffuse *= 1.0 - interior;
          reflectedLight.directSpecular *= 1.0 - interior;
          reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, diffuseColor.rgb * amb, interior);
          reflectedLight.indirectSpecular *= 1.0 - interior;
          vec3 V = normalize(cameraPosition - vCvW);
          vec3 dif = vec3(0.0);
          vec3 spec = vec3(0.0);
          for (int i = 0; i < ${nTorch}; i++) {
            if (uTorch[i].w > 0.0) cvLight(uTorch[i].xyz, uTorch[i].w, 1.0, V, dif, spec);
          }
          if (uSh[0].w > 0.0) cvLight(uSh[0].xyz, uSh[0].w, cvShadow(uShMap0, uSh[0].xyz), V, dif, spec);
          if (uSh[1].w > 0.0) cvLight(uSh[1].xyz, uSh[1].w, cvShadow(uShMap1, uSh[1].xyz), V, dif, spec);
          if (uSh[2].w > 0.0) cvLight(uSh[2].xyz, uSh[2].w, cvShadow(uShMap2, uSh[2].xyz), V, dif, spec);
          if (uSh[3].w > 0.0) cvLight(uSh[3].xyz, uSh[3].w, cvShadow(uShMap3, uSh[3].xyz), V, dif, spec);
          // a faint fill, so the darkest stretches between torches are dim, not black
          dif += vec3(0.02, 0.019, 0.022) * smoothstep(0.0, 6.0, cvSm) * interior;
          reflectedLight.directDiffuse += diffuseColor.rgb * dif;
          reflectedLight.directSpecular += spec;
        }`)
      // no fog for the part of the view inside the cave (down the tunnel it hid the light at the end)
      .replace('#include <fog_fragment>', `
        float cvCamS = dot(cameraPosition.xz - uCaveO.xz, uCaveDir);
        float cvLo = min(cvCamS, cvS), cvHi = max(cvCamS, cvS);
        float caveFogK = 1.0 - clamp((cvHi - max(cvLo, 0.0)) / max(cvHi - cvLo, 1e-3), 0.0, 1.0);
        ${THREE.ShaderChunk.fog_fragment.replaceAll('vFogDepth', '(vFogDepth * caveFogK)')}`);
    if (kind === 'plain') {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // vertex colours above 1 are glowing embers (the torches' burning heads)
          vec3 hot = max(vColor.rgb - 1.0, 0.0);
          if (hot.r > 0.0) {
            diffuseColor.rgb = vec3(0.03, 0.02, 0.015);
            totalEmissiveRadiance += hot * vec3(1.6, 0.9, 0.5) * (0.8 + 0.2 * sin(vCvW.x * 50.0 + vCvW.y * 30.0));
          }
        }`);
    }
  };
  mat.customProgramCacheKey = () => `cave|${kind}|${nTorch}|${sunKey()}`;
  return mat;
}

/** Writes each fragment's distance from the light, packed into RGBA8 (cvShadow reads it). */
function distanceMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uLightPos: { value: new THREE.Vector3() } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform vec3 uLightPos;
      varying vec3 vW;
      void main() {
        gl_FragColor = packDepthToRGBA(min(length(vW - uLightPos) / ${SH_FAR.toFixed(1)}, 0.9999));
      }`,
  });
}

// ---------------------------------------------------------------------------

export function loadCaveAssets(renderer, { lowPower }) {
  return loadTextureSet(renderer, 'cave', { lowPower });
}

/**
 * Build the cave. Returns { group, update, collide, inside, contains }, plus onExit (set by main.js):
 * called with the player at the mouth after walking into the light.
 */
export async function buildCave(plan, texReady, { lowPower }) {
  const tex = await texReady;
  if (tex) {
    const [wall, floor] = tex;
    U.uCvWall.value = wall.alb;
    U.uCvWallN.value = wall.nrm;
    U.uCvFloor.value = floor.alb;
    U.uCvFloorN.value = floor.nrm;
    U.uCvWallAvg.value.setRGB(...wall.avg);
    U.uCvFloorAvg.value.setRGB(...floor.avg);
    U.uCvTile.value.set(1 / wall.tile, 1 / floor.tile);
  } else {
    // (no photos: a flat grey texel keeps the shaders the same)
    const grey = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    const flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    grey.needsUpdate = flat.needsUpdate = true;
    U.uCvWall.value = U.uCvFloor.value = grey;
    U.uCvWallN.value = U.uCvFloorN.value = flat;
    U.uCvWallAvg.value.setRGB(0.21, 0.21, 0.21);
    U.uCvFloorAvg.value.setRGB(0.21, 0.21, 0.21);
  }
  const group = new THREE.Group();
  group.name = 'cave';

  const tube = buildTube();
  const torches = torchPlan(tube);
  const NT = torches.length;
  U.uTorch.value = torches.map(() => new THREE.Vector4());
  const rock = caveMaterial('rock', NT);
  const plain = caveMaterial('plain', NT);
  const casters = [];
  const tubeMeshes = [];
  for (const g of tube.chunks) {
    const m = new THREE.Mesh(g, rock);
    m.renderOrder = -1; // first: it fills the depth buffer, so little else gets shaded in there
    tubeMeshes.push(m);
    group.add(m);
    casters.push(g);
  }
  const crag = new THREE.Mesh(buildCrag(tube), rock);
  group.add(crag); // (not a shadow caster: the far end has no crag, and its shadows must match the mouth's)
  // a strip of floor under the threshold, a little below the ground: it fills any sliver between
  // the tunnel's floor and the terrain in front
  {
    const e = 0.79 * halfW(0) + 1.3;
    const pts = [[-0.9, -e], [-0.9, e], [0.9, e], [0.9, -e]].map(([ss, v]) => {
      const [x, z] = toWorld(ss, v);
      return new THREE.Vector3(x, Y0 - 0.06, z);
    });
    const g = new THREE.BufferGeometry().setFromPoints([pts[0], pts[2], pts[1], pts[0], pts[3], pts[2]]);
    g.computeVertexNormals();
    if (g.getAttribute('normal').getY(0) < 0) g.setFromPoints([pts[0], pts[1], pts[2], pts[0], pts[2], pts[3]]).computeVertexNormals();
    g.setAttribute('aOut', new THREE.BufferAttribute(new Float32Array(6).fill(1), 1));
    group.add(new THREE.Mesh(g, rock));
  }
  const rubble = new THREE.Mesh(buildRubble(), rock);
  group.add(rubble);
  casters.push(rubble.geometry);
  // from outside, the tunnel and the crag as one draw (inside: the tunnel in culled chunks, drawn first)
  const rockAll = new THREE.Mesh(mergeGeometries([...tube.chunks, crag.geometry]), rock);
  rockAll.renderOrder = 50; // (last among the opaques: the hill in front hides most of it)
  group.add(rockAll);
  const insideOnly = [...tubeMeshes, crag];
  group.add(new THREE.Mesh(torchGeometry(torches), plain));
  const [flames, glows] = buildFlames(torches);
  group.add(flames, glows, buildSparks(torches));
  U.uCvMirror.value.set(2 * MID[0], D, 2 * MID[1], SEAM);
  // the far opening: shows the view out of the mouth (main.js renders it into tPortal, the part of
  // the screen the opening covers: uRect, in drawing-buffer pixels; uUvMax, how much of the target that is)
  const portalU = {
    tPortal: { value: null }, uRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uUvMax: { value: new THREE.Vector2(1, 1) },
    uVP: { value: new THREE.Matrix4() }, uBuf: { value: new THREE.Vector2(1, 1) },
    uOn: { value: 0 }, uFallback: { value: new THREE.Color(0.5, 0.5, 0.5) },
  };
  // (projected with the view it was rendered for, uVP, so a view a few frames old still sits on the
  // opening: main.js refreshes a small, far one only every few frames)
  const cap = new THREE.Mesh(tube.endGeo, new THREE.ShaderMaterial({
    uniforms: portalU,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tPortal;
      uniform vec4 uRect;
      uniform vec2 uUvMax;
      uniform mat4 uVP;
      uniform vec2 uBuf;
      uniform float uOn;
      uniform vec3 uFallback;
      varying vec3 vW;
      void main() {
        vec4 c = uVP * vec4(vW, 1.0);
        vec2 px = (c.xy / c.w * 0.5 + 0.5) * uBuf;
        vec2 uv = clamp((px - uRect.xy) / uRect.zw, 0.0, 1.0) * uUvMax;
        gl_FragColor = uOn > 0.5 ? vec4(texture2D(tPortal, uv).rgb, 1.0) : vec4(uFallback, 1.0);
      }`,
  }));
  cap.frustumCulled = false;
  group.add(cap);

  // shadow cubes for the nearest torches
  const shadowScene = new THREE.Scene();
  const distMat = distanceMaterial();
  for (const g of casters) shadowScene.add(new THREE.Mesh(g, distMat));
  const SH_SIZE = lowPower ? 192 : 256;
  const slots = [];
  for (let k = 0; k < SH_SLOTS; k++) {
    const rt = new THREE.WebGLCubeRenderTarget(SH_SIZE, {
      type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    const cam = new THREE.CubeCamera(0.03, SH_FAR, rt);
    shadowScene.add(cam);
    U[`uShMap${k}`].value = rt.texture;
    slots.push({ rt, cam, torch: -1, age: 0 });
  }

  // ---- the player
  const state = { inside: false, s: -10, v: 0 };
  setWalkModifier((x, z, g) => {
    if (!state.inside) return g;
    const [s] = toLocal(x, z);
    return s > -1 ? floorAt(Math.max(0, s)) : g;
  });

  /** Push the player (pos.x/z, radius r) out of the crag, or keep them in the tunnel. */
  function collide(pos, r) {
    const [s, v] = toLocal(pos.x, pos.z);
    if (state.inside) {
      const cs = Math.min(Math.max(s, -1.5), L - 0.8);
      const half = Math.max(0.3, floorHalf(Math.max(0, cs)) - r + 0.2);
      const w = wiggle(Math.max(0, cs));
      [pos.x, pos.z] = toWorld(cs, Math.min(Math.max(v, w - half), w + half));
      return;
    }
    let ns = s;
    let nv = v;
    // the crag: an ellipse over its footprint, except the way in
    const door = 0.79 * halfW(0) - r;
    if (!(Math.abs(nv) < door && ns < 1.5)) {
      const es = (ns - 2.5) / 3.2;
      const ev = nv / 4.5;
      const e = Math.hypot(es, ev);
      if (e < 1 && e > 1e-6) {
        ns = 2.5 + (es / e) * 3.2;
        nv = (ev / e) * 4.5;
      }
    }
    if (ns !== s || nv !== v) [pos.x, pos.z] = toWorld(ns, nv);
  }

  /** Track whether the player is in the tunnel (they go in through the doorway, on foot). */
  function track(player) {
    const [s, v] = toLocal(player.pos.x, player.pos.z);
    state.s = s;
    state.v = v;
    if (!state.inside) {
      if (s > -0.2 && s < 1.5 && Math.abs(v) < 0.79 * halfW(0) && Math.abs(player.pos.y - floorAt(0)) < 1.2) state.inside = true;
    } else if (s < -0.25) state.inside = false;
  }

  // ---- per frame: flicker, shadow slots, the light at the end
  const tmp = new THREE.Vector3();
  const order = torches.map((_, i) => i);
  const clear = new THREE.Color();
  let frame = 0;
  function update(dt, t, camera, renderer) {
    frame++;
    const [cs] = toLocal(camera.position.x, camera.position.z);
    const near = cs > -40 && cs < L + 5 && camera.position.distanceTo(tube.endCentre) < L + 60;
    group.visible = near || camera.position.distanceTo(torches[0].base) < 220;
    shared.uCaveIn.value = state.inside && cs > 1.5 ? 1 : 0;
    for (let i = 0; i < NT; i++) {
      const tc = torches[i];
      const ph = tc.phase;
      const flick = 0.8 + 0.09 * Math.sin(t * 11.3 + ph) + 0.06 * Math.sin(t * 23.1 + ph * 2.3) + 0.05 * Math.sin(t * 5.7 + ph * 0.7) * Math.sin(t * 17.9 + ph);
      tc.flick = flick;
      flames.material.uniforms.uFlick.value[i] = flick;
      const sx = tc.mirror ? -1 : 1;
      tc.light.copy(tc.flame).add(tmp.set(sx * Math.sin(t * 9.1 + ph) * 0.025, Math.sin(t * 13.3 + ph) * 0.02 + 0.03, sx * Math.cos(t * 7.7 + ph) * 0.025));
      tc.dist = tc.light.distanceTo(camera.position);
    }
    for (let i = 0; i < 2; i++) shared.uCaveTorch.value[i].set(torches[i].light.x, torches[i].light.y, torches[i].light.z, torches[i].intensity * torches[i].flick);
    for (const m of insideOnly) m.visible = state.inside;
    rockAll.visible = !state.inside;
    if (!near) return;
    // the nearest torches get the shadow slots (a torch keeps its slot while it stays near)
    order.sort((a, b) => torches[a].dist - torches[b].dist);
    const want = order.slice(0, SH_SLOTS).filter((i) => torches[i].dist < SH_FAR + 6);
    for (const slot of slots) if (!want.includes(slot.torch)) slot.torch = -1;
    for (const i of want) {
      if (slots.some((sl) => sl.torch === i)) continue;
      const free = slots.find((sl) => sl.torch === -1);
      free.torch = i;
      free.age = 1e9; // render now
    }
    for (let i = 0; i < NT; i++) {
      const tc = torches[i];
      const shadowed = slots.some((sl) => sl.torch === i);
      U.uTorch.value[i].set(tc.light.x, tc.light.y, tc.light.z, shadowed ? 0 : tc.intensity * tc.flick);
    }
    // re-render: the two nearest every frame (their shadows sway with the flame), the others every
    // third (phones: the nearest every frame, the others every fourth)
    renderer.getClearColor(clear);
    const alpha = renderer.getClearAlpha();
    const target = renderer.getRenderTarget();
    renderer.setClearColor(0xffffff, 1);
    slots.forEach((slot, k) => {
      const u = U.uSh.value[k];
      if (slot.torch < 0) {
        u.w = 0;
        return;
      }
      const tc = torches[slot.torch];
      slot.age++;
      const rank = order.indexOf(slot.torch);
      if (slot.age >= (rank < (lowPower ? 1 : 2) ? 1 : lowPower ? 4 : 3) && tc.dist < SH_FAR + 6) {
        slot.age = 0;
        slot.cam.position.copy(tc.light);
        slot.cam.updateMatrixWorld();
        distMat.uniforms.uLightPos.value.copy(tc.light);
        slot.cam.update(renderer, shadowScene);
        slot.pos = (slot.pos ?? new THREE.Vector3()).copy(tc.light);
      }
      // shade from where the cube was rendered from, so the shadows stay put on the surfaces
      const lp = slot.pos ?? tc.light;
      u.set(lp.x, lp.y, lp.z, tc.intensity * tc.flick);
    });
    renderer.setClearColor(clear, alpha);
    renderer.setRenderTarget(target);
  }

  /** Render every shadow slot once (warm-up: the programs and targets are ready before play). */
  function warmUp(renderer) {
    for (const slot of slots) {
      slot.cam.position.copy(torches[0].light);
      slot.cam.updateMatrixWorld();
      slot.cam.update(renderer, shadowScene);
    }
  }

  return {
    group,
    update,
    track,
    collide,
    warmUp,
    state,
    torches,
    end: tube.endCentre,
    /** The far opening (main.js renders the view out of the mouth onto it) and the turn that maps the far end onto the mouth. */
    portal: { cap, uniforms: portalU, ring: tube.endRing, toMouth: END_TO_MOUTH },
    /** Where you're moved to the mouth: this far in (the counterpart of the spot L - TURN_AT in from the mouth). */
    turnAt: L - 8,
    /**
     * Could the far opening be in view? Always from inside; from outside only when the line to it
     * passes through the mouth (else the hill hides it, and its view out isn't rendered).
     */
    canSeeFarEnd: (camera) => {
      if (state.inside) return true;
      const [sc, vc] = toLocal(camera.position.x, camera.position.z);
      if (sc >= 0) return false;
      const k = -sc / (L - sc); // where the line crosses the mouth
      const v0 = vc * (1 - k);
      const y0 = camera.position.y + (tube.endCentre.y - camera.position.y) * k - Y0;
      return Math.abs(v0) < 0.79 * halfW(0) + 0.3 && y0 > -0.3 && y0 < height(0) + 0.3;
    },
    /** The light coming in at the mouth (a) and at the far end (b), for the walls (colours, linear). */
    setDaylight: (a, b) => {
      U.uOutA.value.copy(a);
      if (b) U.uOutB.value.copy(b);
    },
    mouth: new THREE.Vector3(CAVE.x, Y0 + 1.5, CAVE.z),
    /** A spot 12 m in, facing out. */
    exitPoint: () => {
      const s = 12;
      const [x, z] = toWorld(s, wiggle(s));
      return { x, z, s, yaw: Math.atan2(DX, DZ) };
    },
    contains: () => state.inside,
    nearestTorch: () => torches.reduce((m, tc) => Math.min(m, tc.dist ?? 1e9), 1e9),
    /** A spot on the tunnel's axis s m in. */
    debug: { slots, shadowScene, U },
    pointAt: (s) => {
      const [x, z] = toWorld(s, wiggle(s));
      return { x, z };
    },
    floorAt,
    toLocal,
    length: L,
  };
}

/** Sparks: a few embers spat up from each flame, rising and winking out (points, animated on the GPU). */
function buildSparks(torches) {
  const PER = 8;
  const pos = [];
  const seed = [];
  for (const t of torches) {
    for (let k = 0; k < PER; k++) {
      pos.push(t.flame.x, t.flame.y, t.flame.z);
      seed.push(Math.random(), Math.random());
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 2));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uPixelRatio: { value: Math.min(window.devicePixelRatio ?? 1, 2) } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec2 aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vA;
      void main() {
        // each spark lives ~0.6-1.4 s, then waits its turn again (most of the time it's out)
        float period = 2.5 + 4.0 * aSeed.x;
        float t = fract(uTime / period + aSeed.y) * period;
        float life = 0.6 + 0.8 * aSeed.y;
        float k = t / life;
        vec3 p = position + vec3(sin(aSeed.x * 40.0 + t * 3.0) * 0.08 * k, 0.05 + k * (0.5 + 0.5 * aSeed.x), cos(aSeed.y * 40.0 + t * 2.5) * 0.08 * k);
        vA = k < 1.0 ? (1.0 - k) * (0.6 + 0.4 * sin(t * 40.0 + aSeed.x * 9.0)) : 0.0;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = vA > 0.0 ? max(1.0, 0.025 * uPixelRatio * 600.0 / -mv.z) : 0.0;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vec3(1.0, 0.6, 0.2) * vA * smoothstep(0.5, 0.1, r), 1.0);
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 21;
  return pts;
}
