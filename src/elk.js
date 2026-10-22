import * as THREE from 'three';
import { groundAt, openWaterLevel, sandAt, mulberry32 } from './terrain.js';
import { SEED, SNOWLINE } from './config.js';
import { patchSunlight, sunKey, shared, wetChunks } from './materials.js';

// Roosevelt elk. The model is built here (no Blender): lofted tubes along a skeleton (a body,
// a two-piece neck with the dark mane hanging under it, a head, ears, a tail, four legs of three
// bones each, and on the bull a pair of six-point antlers), skinned to 17 bones. It's posed
// procedurally every frame: the body rides over its feet, each foot is planted on the ground
// while it bears weight and swung to its next footfall (a lateral-sequence walk, a trot), the
// legs reach their feet by two-bone IK, and the neck lowers the head to graze or lifts it to watch.

// ---------------------------------------------------------------------------
// The model, in the bind pose (standing square; the elk's frame: x its left side, y up, z forward,
// metres, a cow ~1.35 m at the shoulder)
// ---------------------------------------------------------------------------

const BONES = ['body', 'neck1', 'neck2', 'head', 'tail',
  'frontL1', 'frontL2', 'frontL3', 'frontR1', 'frontR2', 'frontR3',
  'hindL1', 'hindL2', 'hindL3', 'hindR1', 'hindR2', 'hindR3'];
const B = Object.fromEntries(BONES.map((n, i) => [n, i]));

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

// joints in the bind pose
const BODY0 = v3(0, 1.1, 0); // the body's pivot
const NECK0 = v3(0, 1.3, 0.6); // neck base (in the body)
const NECKM0 = v3(0, 1.56, 0.86);
const HEAD0 = v3(0, 1.76, 1.04); // the head's joint (atlas)
const MUZZLE0 = v3(0, 1.52, 1.5);
const TAIL0 = v3(0, 1.27, -0.84);
const HEAD_PITCH0 = Math.atan2(HEAD0.y - MUZZLE0.y, MUZZLE0.z - HEAD0.z); // (the face's slope in the bind pose: nose down)
// legs (left side; the right mirrors x): socket, joint, joint, hoof
const FRONT0 = [v3(0.16, 1.08, 0.45), v3(0.18, 0.8, 0.34), v3(0.165, 0.44, 0.41), v3(0.165, 0.0, 0.43)];
const HIND0 = [v3(0.15, 1.1, -0.55), v3(0.185, 0.76, -0.32), v3(0.16, 0.52, -0.68), v3(0.16, 0.0, -0.6)];

const COL = {
  body: new THREE.Color(0x917b5f),
  bodyDark: new THREE.Color(0x6e5640),
  neck: new THREE.Color(0x4a3627),
  mane: new THREE.Color(0x35261b),
  leg: new THREE.Color(0x3e2d21),
  rump: new THREE.Color(0xd6c29c),
  muzzle: new THREE.Color(0x2a201a),
  hoof: new THREE.Color(0x1a1512),
  ear: new THREE.Color(0x5a4532),
  antler: new THREE.Color(0x7d6a52),
  antlerTip: new THREE.Color(0xe2d8c2),
};

const sm = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The coat's colour on (or just under) the body's surface at p: tan, a darker belly, the dark cape
 * over the shoulders and chest, the pale rump patch. `below` = 0 on the back .. 1 under the belly. */
function coat(p, below) {
  const z = p.z;
  const c = COL.body.clone();
  c.lerp(COL.bodyDark, below * 0.6);
  c.lerp(COL.neck, sm(0.42, 0.78, z) * (0.55 + 0.45 * below));
  // the rump patch: round the tail and down the backs of the thighs
  const rump = sm(-0.5, -0.8, z) * sm(0.55, 1.0, p.y) * (1 - 0.6 * sm(0.18, 0.26, Math.abs(p.x)) * sm(-0.65, -0.55, z));
  c.lerp(COL.rump, rump);
  return c;
}

class Builder {
  constructor() {
    this.pos = [];
    this.col = [];
    this.idx = [];
    this.si = [];
    this.sw = [];
  }

  vert(p, c, w) {
    this.pos.push(p.x, p.y, p.z);
    this.col.push(c.r, c.g, c.b);
    // up to 4 (bone, weight) pairs
    const ws = w.slice(0, 4);
    const sum = ws.reduce((a, [, x]) => a + x, 0);
    for (let k = 0; k < 4; k++) {
      this.si.push(ws[k] ? ws[k][0] : 0);
      this.sw.push(ws[k] ? ws[k][1] / sum : 0);
    }
    return this.pos.length / 3 - 1;
  }

  /**
   * A tube through rings. Each ring: { c: centre, t: along (unit), u: its "up" (unit, ⊥ t),
   * w: half width, up: half height above, dn: below, p: squareness (2 = ellipse), w8: weights }.
   * colour(ring index, angle, point). capStart/capEnd close the ends to a point a bit beyond.
   */
  loft(rings, sides, colour, { capStart = 0, capEnd = 0 } = {}) {
    const ids = [];
    rings.forEach((r, i) => {
      const side = new THREE.Vector3().crossVectors(r.u, r.t).normalize(); // (the elk's left for a forward tube)
      const row = [];
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const e = 2 / (r.p ?? 2);
        const x = Math.sign(ca) * Math.abs(ca) ** e * r.w;
        const y = Math.sign(sa) * Math.abs(sa) ** e * (sa > 0 ? r.up : r.dn);
        const p = r.c.clone().addScaledVector(side, x).addScaledVector(r.u, y);
        row.push(this.vert(p, colour(i, a, p), r.w8));
      }
      ids.push(row);
    });
    for (let i = 0; i + 1 < rings.length; i++) {
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        const a = ids[i][k], b = ids[i][k2], c = ids[i + 1][k2], d = ids[i + 1][k];
        this.idx.push(a, c, b, a, d, c);
      }
    }
    const cap = (i, ext, flip) => {
      const r = rings[i];
      const p = r.c.clone().addScaledVector(r.t, ext);
      const c = this.vert(p, colour(i, 0, p), r.w8);
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        if (flip) this.idx.push(c, ids[i][k], ids[i][k2]);
        else this.idx.push(c, ids[i][k2], ids[i][k]);
      }
    };
    if (capStart !== false) cap(0, -capStart, true);
    if (capEnd !== false) cap(rings.length - 1, capEnd, false);
  }

  /** A flat leaf (an ear): base, tip, half width; both sides. */
  leaf(base, tip, normal, half, c, w8) {
    const along = new THREE.Vector3().subVectors(tip, base);
    const across = new THREE.Vector3().crossVectors(along, normal).normalize().multiplyScalar(half);
    const pts = [
      base.clone().addScaledVector(across, 0.5),
      base.clone().addScaledVector(along, 0.45).add(across),
      tip,
      base.clone().addScaledVector(along, 0.45).sub(across),
      base.clone().addScaledVector(across, -0.5),
    ];
    const cup = normal.clone().multiplyScalar(-0.02);
    pts[1].add(cup);
    pts[3].add(cup);
    const id = pts.map((p) => this.vert(p, c, w8));
    const id2 = pts.map((p) => this.vert(p, c, w8));
    for (const [a, b, d] of [[0, 1, 4], [1, 3, 4], [1, 2, 3]]) {
      this.idx.push(id[a], id[b], id[d]);
      this.idx.push(id2[a], id2[d], id2[b]);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

const UPV = v3(0, 1, 0);
const FWD = v3(0, 0, 1);

/** Rings along a polyline (points, per-point half sizes), the frame carried along so it doesn't twist. */
function chainRings(pts, sizes, weights, upHint = UPV) {
  const rings = [];
  let u = upHint.clone();
  for (let i = 0; i < pts.length; i++) {
    const t = new THREE.Vector3().subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize();
    u = u.clone().addScaledVector(t, -u.dot(t)).normalize();
    const s = sizes[i];
    rings.push({ c: pts[i].clone(), t, u, w: s[0], up: s[1], dn: s[2] ?? s[1], p: s[3] ?? 2, w8: weights[i] });
  }
  return rings;
}

const lerpV = (a, b, t) => a.clone().lerp(b, t);

function buildElkGeometry(bull) {
  const b = new Builder();
  const W = (name) => [[B[name], 1]];
  const W2 = (n1, n2, t) => [[B[n1], 1 - t], [B[n2], t]];

  // --- the body: rings along z (z, top, bottom, half width, squareness)
  const T = [
    [-0.86, 1.27, 1.06, 0.09, 2.2], [-0.8, 1.31, 0.95, 0.17, 2.4], [-0.68, 1.33, 0.86, 0.23, 2.5],
    [-0.5, 1.33, 0.8, 0.26, 2.5], [-0.28, 1.33, 0.75, 0.27, 2.4], [0.0, 1.36, 0.69, 0.29, 2.3],
    [0.22, 1.42, 0.69, 0.28, 2.3], [0.4, 1.47, 0.74, 0.245, 2.4], [0.56, 1.45, 0.8, 0.21, 2.4],
    [0.7, 1.38, 0.9, 0.165, 2.3], [0.8, 1.3, 1.0, 0.11, 2.2],
  ];
  const bodyRings = T.map(([z, top, bot, w, p]) => {
    const cy = (top + bot) / 2;
    return { c: v3(0, cy, z), t: FWD, u: UPV, w, up: top - cy, dn: cy - bot, p, w8: W('body') };
  });
  b.loft(bodyRings, 16, (i, a, p) => coat(p, Math.max(0, -Math.sin(a))), { capStart: 0.04, capEnd: false });

  // --- the neck: base inside the chest, the mane hanging below
  const neckPts = [lerpV(NECK0, v3(0, 1.2, 0.45), 0.6), NECK0, lerpV(NECK0, NECKM0, 0.5), NECKM0, lerpV(NECKM0, HEAD0, 0.55), HEAD0];
  const mane = bull ? 1.25 : 1;
  const neckSizes = [[0.19, 0.22, 0.28], [0.18, 0.19, 0.28 * mane], [0.155, 0.16, 0.25 * mane], [0.135, 0.135, 0.22 * mane], [0.11, 0.11, 0.16 * mane], [0.095, 0.1, 0.11]];
  const neckW = [W('body'), W2('body', 'neck1', 0.5), W('neck1'), W2('neck1', 'neck2', 0.5), W('neck2'), W2('neck2', 'head', 0.5)];
  b.loft(chainRings(neckPts, neckSizes, neckW), 12, (i, a) => {
    const below = Math.max(0, -Math.sin(a));
    return COL.neck.clone().lerp(COL.mane, below);
  }, { capStart: false, capEnd: false });

  // --- the head: from behind the ears to the muzzle
  const hd = new THREE.Vector3().subVectors(MUZZLE0, HEAD0).normalize();
  const hu = UPV.clone().addScaledVector(hd, -UPV.dot(hd)).normalize();
  const H = (t, up = 0) => HEAD0.clone().addScaledVector(hd, t * HEAD0.distanceTo(MUZZLE0) - 0.05).addScaledVector(hu, up);
  const headPts = [H(-0.06, 0.01), H(0.06, 0.02), H(0.25, 0.0), H(0.5, -0.02), H(0.75, -0.03), H(0.92, -0.035), H(1.0, -0.04)];
  const headSizes = [[0.09, 0.1, 0.105], [0.098, 0.11, 0.1], [0.092, 0.092, 0.092], [0.074, 0.075, 0.08], [0.062, 0.062, 0.072], [0.058, 0.054, 0.064], [0.042, 0.042, 0.048]];
  const headRings = chainRings(headPts, headSizes, headPts.map(() => W('head')), hu);
  b.loft(headRings, 12, (i, a, p) => {
    let c = COL.neck.clone().lerp(COL.ear, 0.3);
    if (i >= 4) c.lerp(COL.muzzle, sm(4, 6, i) * 0.9);
    // the eyes: dark spots on the sides
    if (i === 2 && Math.abs(Math.cos(a)) > 0.85 && Math.sin(a) > 0.1) c = COL.muzzle.clone().multiplyScalar(0.4);
    return c;
  }, { capStart: 0.03, capEnd: 0.03 });
  // ears: up, out and back from behind the eyes
  for (const s of [1, -1]) {
    const base = H(0.08, 0.07).add(v3(s * 0.06, 0, 0));
    const tip = base.clone().add(v3(s * 0.15, 0.12, -0.08));
    b.leaf(base, tip, v3(0, 0.3, 1).normalize(), 0.055, COL.ear, W('head'));
  }

  // --- the tail: short, pale
  const tailPts = [TAIL0.clone().add(v3(0, 0.02, 0.05)), TAIL0, TAIL0.clone().add(v3(0, -0.08, -0.06)), TAIL0.clone().add(v3(0, -0.16, -0.08))];
  b.loft(chainRings(tailPts, [[0.05, 0.04], [0.045, 0.035], [0.035, 0.03], [0.02, 0.02]], tailPts.map(() => W('tail')), FWD.clone().negate()), 6,
    () => COL.rump.clone().lerp(COL.bodyDark, 0.25), { capStart: false, capEnd: 0.02 });

  // --- legs: a tube from inside the body down to the hoof, three bones
  const leg = (J, s, names, isFront) => {
    const P = J.map((p) => v3(p.x * s, p.y, p.z));
    const top = P[0].clone().add(v3(-s * 0.04, 0.12, isFront ? -0.02 : 0.04));
    const pts = [top, P[0], lerpV(P[0], P[1], 0.5), P[1], lerpV(P[1], P[2], 0.35), lerpV(P[1], P[2], 0.75), P[2],
      lerpV(P[2], P[3], 0.35), lerpV(P[2], P[3], 0.78), lerpV(P[2], P[3], 0.9), P[3].clone().add(v3(0, 0.07, 0)), P[3]];
    const sizes = isFront
      ? [[0.13, 0.16], [0.13, 0.16], [0.105, 0.135], [0.092, 0.11], [0.076, 0.086], [0.056, 0.06], [0.046, 0.052],
        [0.034, 0.037], [0.032, 0.035], [0.038, 0.042], [0.042, 0.047], [0.045, 0.052]]
      : [[0.15, 0.2], [0.15, 0.2], [0.13, 0.17], [0.105, 0.135], [0.085, 0.1], [0.058, 0.066], [0.045, 0.055],
        [0.034, 0.038], [0.032, 0.036], [0.038, 0.042], [0.042, 0.047], [0.045, 0.052]];
    const [n1, n2, n3] = names;
    const wts = [W('body'), W2('body', n1, 0.7), W(n1), W2(n1, n2, 0.5), W(n2), W(n2), W2(n2, n3, 0.5), W(n3), W(n3), W(n3), W(n3), W(n3)];
    const rings = chainRings(pts, sizes, wts, FWD);
    b.loft(rings, 9, (i, a, p) => {
      // the coat on the upper leg (where it comes out of the body), dark brown below
      const c = coat(p, 0.3 * sm(0.9, 0.75, p.y)).lerp(COL.leg, sm(0.72, 0.45, p.y));
      return i >= 10 ? COL.hoof.clone() : c;
    }, { capStart: false, capEnd: 0.01 });
  };
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    leg(FRONT0, s, [`front${side}1`, `front${side}2`, `front${side}3`], true);
    leg(HIND0, s, [`hind${side}1`, `hind${side}2`, `hind${side}3`], false);
  }

  // --- antlers (bulls): a main beam sweeping up and back from the top of the skull, six points
  if (bull) {
    for (const s of [1, -1]) {
      const X = (x, y, z) => v3(s * x, y, z);
      const beam = [X(0.06, 1.84, 1.08), X(0.14, 1.99, 1.05), X(0.25, 2.22, 0.97), X(0.33, 2.47, 0.84), X(0.37, 2.68, 0.68), X(0.34, 2.84, 0.54), X(0.27, 2.93, 0.47)];
      const r = (t) => 0.034 - 0.022 * t;
      const sizes = beam.map((_, i) => { const t = i / (beam.length - 1); return [r(t), r(t)]; });
      const col = (i, n) => COL.antler.clone().lerp(COL.antlerTip, sm(n * 0.6, n, i));
      b.loft(chainRings(beam, sizes, beam.map(() => W('head')), FWD), 6, (i) => col(i, beam.length - 1), { capStart: false, capEnd: 0.02 });
      // tines: from points along the beam, mostly forward and up
      const tines = [
        [0.08, X(0.12, 0.02, 0.32), 0.35], // brow tine, forward over the face
        [0.2, X(0.1, 0.1, 0.27), 0.3], // bez
        [0.45, X(0.06, 0.22, 0.22), 0.3], // trez
        [0.66, X(0.02, 0.3, 0.25), 0.42], // royal (the "dagger"), the longest
        [0.84, X(-0.04, 0.25, 0.14), 0.28],
      ];
      for (const [u, dir, len] of tines) {
        const f = u * (beam.length - 1);
        const i0 = Math.floor(f);
        const base = lerpV(beam[i0], beam[Math.min(i0 + 1, beam.length - 1)], f - i0);
        const d = dir.clone().normalize();
        const pts = [base.clone().addScaledVector(d, -0.02), base.clone().addScaledVector(d, len * 0.35).add(v3(0, len * 0.04, 0)),
          base.clone().addScaledVector(d, len * 0.7).add(v3(0, len * 0.12, 0)), base.clone().addScaledVector(d, len).add(v3(0, len * 0.25, 0))];
        const r0 = r(u) * 0.75;
        b.loft(chainRings(pts, pts.map((_, i) => [r0 * (1 - i * 0.28), r0 * (1 - i * 0.28)]), pts.map(() => W('head')), UPV), 5,
          (i) => col(i, 3), { capStart: false, capEnd: 0.015 });
      }
    }
  }
  return b.geometry();
}

// ---------------------------------------------------------------------------
// The rig: bone matrices from a pose
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _x0 = new THREE.Vector3();
const _y0 = new THREE.Vector3();
const _z0 = new THREE.Vector3();
const _x1 = new THREE.Vector3();
const _y1 = new THREE.Vector3();
const _z1 = new THREE.Vector3();
const _bind = new THREE.Matrix4();
const _pose = new THREE.Matrix4();

/** out = the rigid transform taking segment A0→B0 (bind) onto A→B (posed), keeping `lat` as the sideways axis. */
function segmentMatrix(out, A0, B0, A, B, lat0, lat) {
  _z0.subVectors(B0, A0).normalize();
  _x0.copy(lat0).addScaledVector(_z0, -lat0.dot(_z0)).normalize();
  _y0.crossVectors(_z0, _x0);
  _z1.subVectors(B, A).normalize();
  _x1.copy(lat).addScaledVector(_z1, -lat.dot(_z1)).normalize();
  _y1.crossVectors(_z1, _x1);
  _bind.makeBasis(_x0, _y0, _z0);
  _pose.makeBasis(_x1, _y1, _z1);
  out.copy(_pose).multiply(_bind.transpose()); // R = pose · bindᵀ
  // then about A: T(A) · R · T(−A0)
  _a.copy(A0).applyMatrix4(out);
  out.setPosition(A.x - _a.x, A.y - _a.y, A.z - _a.z);
  return out;
}

/** Two-bone IK: the middle joint for a chain root → target with lengths l1, l2, bending toward pole. */
function ik(out, root, target, l1, l2, pole) {
  _c.subVectors(target, root);
  let d = _c.length();
  const dir = _c.divideScalar(d || 1);
  d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _b.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
  return out.copy(root).addScaledVector(dir, a).addScaledVector(_b, h);
}

const LEGS = [
  { name: 'frontL', J: FRONT0, s: 1, front: true },
  { name: 'frontR', J: FRONT0, s: -1, front: true },
  { name: 'hindL', J: HIND0, s: 1, front: false },
  { name: 'hindR', J: HIND0, s: -1, front: false },
].map((L) => {
  const P = L.J.map((p) => v3(p.x * L.s, p.y, p.z));
  return { ...L, P, l1: P[0].distanceTo(P[1]), l2: P[1].distanceTo(P[2]), l3: P[2].distanceTo(P[3]), bones: [1, 2, 3].map((k) => B[`${L.name}${k}`]) };
});

/**
 * The pose (all in the elk's own frame, the mesh's): body = matrix placing the body (pivot BODY0);
 * feet[4] = hoof positions (front L, front R, hind L, hind R); lift[4] = 0..1 how far through a
 * swing each is (the lower leg folds); neck1/neck2/head pitch (+ = down) and yaw; tail swish.
 */
export class ElkRig {
  constructor(bull) {
    this.geometry = buildElkGeometry(bull);
    this.bones = BONES.map((n) => {
      const bone = new THREE.Bone();
      bone.name = n;
      bone.matrixAutoUpdate = false;
      return bone;
    });
    // bind: every bone's frame is the elk's frame (identity), so a bone's matrix is just its pose
    this.skeleton = new THREE.Skeleton(this.bones, this.bones.map(() => new THREE.Matrix4()));
    this.pos = {
      body: new THREE.Matrix4(),
      feet: LEGS.map((L) => L.P[3].clone()),
      lift: [0, 0, 0, 0],
      neck1: 0, neck2: 0, head: 0, yaw: 0, tail: 0,
      stride: 1, // 0..1: how hard the legs fold in the swing (a slow grazing step barely lifts them)
    };
    this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._lat = new THREE.Vector3();
  }

  /** Where a point fixed to the body (bind position) is now. */
  bodyPoint(p, out) {
    return out.copy(p).sub(BODY0).applyMatrix4(this.pos.body);
  }

  /** Bone matrices from this.pos. */
  apply() {
    const P = this.pos;
    const M = this.bones.map((b) => b.matrix);
    // body: T(body) · T(−BODY0)
    M[B.body].copy(P.body).multiply(_m.makeTranslation(-BODY0.x, -BODY0.y, -BODY0.z));
    // neck and head: a chain of pitches (and a yaw at the base) about their joints
    const rotAbout = (out, parent, j, pitch, yaw) => {
      _m.makeRotationY(yaw).multiply(_m2.makeRotationX(pitch));
      out.copy(parent).multiply(_m2.makeTranslation(j.x, j.y, j.z)).multiply(_m).multiply(_m2.makeTranslation(-j.x, -j.y, -j.z));
    };
    rotAbout(M[B.neck1], M[B.body], NECK0, P.neck1, P.yaw * 0.6);
    rotAbout(M[B.neck2], M[B.neck1], NECKM0, P.neck2, P.yaw * 0.4);
    rotAbout(M[B.head], M[B.neck2], HEAD0, P.head, 0);
    rotAbout(M[B.tail], M[B.body], TAIL0, 0.15 * Math.abs(P.tail), P.tail);
    // legs
    const lat = this._lat.set(1, 0, 0).transformDirection(M[B.body]);
    const [S, J1, J2, F, tmp] = this._v;
    LEGS.forEach((L, i) => {
      S.copy(L.P[0]).applyMatrix4(M[B.body]); // the socket, with the body
      F.copy(P.feet[i]);
      // the cannon: from the hoof up toward the socket's side, folding back as the foot swings
      // (front: the knee bends back; hind: the hock lifts back)
      const fold = Math.sin(Math.PI * Math.min(1, P.lift[i])) * (L.front ? 1.05 : 0.6) * P.stride;
      const bodyF = tmp.set(0, 0, 1).transformDirection(M[B.body]);
      const up = _a.set(0, 1, 0);
      // lean the cannon a little toward the socket (fore and aft) so a reaching leg stays straight-ish
      const reach = _b.subVectors(S, F);
      const lean = THREE.MathUtils.clamp(reach.dot(bodyF) / L.l3 * 0.35, -0.5, 0.5);
      J2.copy(up).multiplyScalar(Math.cos(lean)).addScaledVector(bodyF, Math.sin(lean));
      // fold: the hoof tucks back under the joint (the cannon, hoof → joint, tips forward)
      J2.applyAxisAngle(lat, fold);
      J2.normalize().multiplyScalar(L.l3).add(F);
      // the upper joint by IK: elbow behind (front), stifle ahead (hind)
      const pole = tmp.set(0, 0, L.front ? -1 : 1).transformDirection(M[B.body]).addScaledVector(lat, L.s * 0.15);
      ik(J1, S, J2, L.l1, L.l2, pole);
      segmentMatrix(M[L.bones[0]], L.P[0], L.P[1], S, J1, _x0.set(1, 0, 0), lat);
      segmentMatrix(M[L.bones[1]], L.P[1], L.P[2], J1, J2, _x0.set(1, 0, 0), lat);
      segmentMatrix(M[L.bones[2]], L.P[2], L.P[3], J2, F, _x0.set(1, 0, 0), lat);
    });
    for (const b of this.bones) b.matrixWorldNeedsUpdate = true;
  }

  /** The muzzle's position (elk frame) under the current head bone. */
  muzzle(out) {
    return out.copy(MUZZLE0).applyMatrix4(this.bones[B.head].matrix);
  }
}

export const ELK_BIND = { BODY0, FRONT0, HIND0, NECK0, HEAD0, MUZZLE0, LEGS };

function elkMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0.5 });
  // dappled like everything else under the crowns, and a wet coat darkens in the rain
  const wet = wetChunks(0.6);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWet = shared.uWet;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWet;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${wet.color}`);
    patchSunlight(shader);
  };
  mat.customProgramCacheKey = () => `elk-${sunKey()}`;
  return mat;
}

// ---------------------------------------------------------------------------
// Walking: a gait clock, feet planted while they bear weight and swung to their next footfall
// ---------------------------------------------------------------------------

// leg order: front L, front R, hind L, hind R. Offsets in the cycle; the swing is the last (1 − duty).
// A walk is a lateral sequence (LH, LF, RH, RF a quarter apart), a trot moves diagonal pairs.
const GAITS = {
  walk: { offs: [0.25, 0.75, 0, 0.5], duty: 0.68, stride: 1.55, lift: 0.1 },
  trot: { offs: [0, 0.5, 0.5, 0], duty: 0.42, stride: 2.6, lift: 0.2 },
};

const _w = new THREE.Vector3();
const _h = new THREE.Vector3();
const _q = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _rot = new THREE.Matrix4();
const _rot2 = new THREE.Matrix4();
const ease = (t) => t * t * (3 - 2 * t);

export class ElkBody {
  /** ground(x, z) = height of the ground; size: 1 cow, ~1.1 a bull, ~0.7 a calf. */
  constructor(rig, mesh, ground, size = 1) {
    this.rig = rig;
    this.mesh = mesh;
    this.ground = ground;
    this.size = size;
    this.x = 0;
    this.z = 0;
    this.heading = 0;
    this.speed = 0; // m/s, forward
    this.turn = 0; // rad/s (for the feet's prediction)
    this.gait = GAITS.walk;
    this.phase = 0;
    this.feet = LEGS.map(() => ({ p: new THREE.Vector3(), from: new THREE.Vector3(), swing: false, skip: false, t: 0, gy: null }));
    this.neck = { n1: 0.2, n2: 0.1, head: 0.35, yaw: 0 }; // eased pose
    this.look = { n1: 0.2, n2: 0.1, head: 0.35, yaw: 0 }; // its target
    this.graze = 0; // 0..1: lowering the head to the ground (the neck reaches for it)
    this.time = Math.random() * 100;
    this.bob = 0;
  }

  /** Stand here, feet square under the body. */
  place(x, z, heading) {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.syncRoot();
    LEGS.forEach((L, i) => {
      this.home(i, 0, this.feet[i].p);
      this.feet[i].swing = false;
      this.feet[i].gy = null;
    });
  }

  syncRoot() {
    const m = this.mesh;
    m.position.set(this.x, this.ground(this.x, this.z), this.z);
    m.rotation.set(0, this.heading, 0);
    m.scale.setScalar(this.size);
    m.updateMatrix();
    m.updateMatrixWorld();
  }

  /** Where leg i's hoof rests (world), with the body moved on by `ahead` seconds. */
  home(i, ahead, out, withY = true) {
    const L = LEGS[i];
    const h = this.heading + this.turn * ahead;
    const d = this.speed * ahead;
    const fx = this.x + Math.sin(this.heading + this.turn * ahead * 0.5) * d;
    const fz = this.z + Math.cos(this.heading + this.turn * ahead * 0.5) * d;
    const s = this.size;
    const lx = L.P[3].x * s * 1.05, lz = L.P[3].z * s;
    out.set(fx + Math.cos(h) * lx + Math.sin(h) * lz, 0, fz - Math.sin(h) * lx + Math.cos(h) * lz);
    out.y = withY ? this.ground(out.x, out.z) : 0;
    return out;
  }

  update(dt) {
    this.time += dt;
    this.heading += this.turn * dt;
    this.x += Math.sin(this.heading) * this.speed * dt;
    this.z += Math.cos(this.heading) * this.speed * dt;
    const g = this.gait;
    // the clock: by the stride while moving; when standing, only while some foot is out of place
    const moving = this.speed > 0.05 || Math.abs(this.turn) > 0.08;
    let anySwing = false;
    let anyFar = false;
    for (let i = 0; i < 4; i++) {
      const f = this.feet[i];
      if (f.swing && !f.skip) anySwing = true;
      this.home(i, 0, _h, false);
      if ((_h.x - f.p.x) ** 2 + (_h.z - f.p.z) ** 2 > (0.16 * this.size) ** 2) anyFar = true;
    }
    const freq = moving ? Math.max(this.speed / (g.stride * this.size), 0.55) : anyFar || anySwing ? 0.8 : 0;
    this.phase += freq * dt;
    const swingDur = freq > 0 ? (1 - g.duty) / freq : 0.4;
    const stanceDur = freq > 0 ? g.duty / freq : 1;

    for (let i = 0; i < 4; i++) {
      const f = this.feet[i];
      const lp = ((this.phase + g.offs[i]) % 1 + 1) % 1;
      const swing = lp >= g.duty;
      if (swing && !f.swing) {
        // lift off, unless standing and already where it should be
        this.home(i, 0, _h, false);
        f.skip = !moving && (_h.x - f.p.x) ** 2 + (_h.z - f.p.z) ** 2 < (0.1 * this.size) ** 2;
        f.from.copy(f.p);
      }
      f.swing = swing;
      if (swing && !f.skip) {
        const t = (lp - g.duty) / (1 - g.duty);
        f.t = t;
        // the footfall: the rest spot where the body will be half way through the next stance
        this.home(i, (1 - t) * swingDur + stanceDur * 0.5 * (moving ? 1 : 0), _h);
        const e = ease(t);
        f.p.lerpVectors(f.from, _h, e);
        f.p.y = THREE.MathUtils.lerp(f.from.y, _h.y, e) + Math.sin(Math.PI * t) * g.lift * this.size * (0.6 + 0.4 * Math.min(1, this.speed));
      } else {
        f.t = 0;
        // planted (settle onto the ground: after a gait change a foot can be caught in the air)
        f.gy ??= this.ground(f.p.x, f.p.z);
        f.p.y += (f.gy - f.p.y) * Math.min(1, dt * 12);
      }
      if (swing && !f.skip) f.gy = null; // (looked up again where it lands)
    }
    this.pose(dt);
  }

  pose(dt) {
    const rig = this.rig;
    const P = rig.pos;
    this.syncRoot();
    _inv.copy(this.mesh.matrixWorld).invert();
    // feet into the elk's frame
    let fy = 0, hy = 0, ly = 0, low = Infinity;
    for (let i = 0; i < 4; i++) {
      P.feet[i].copy(this.feet[i].p).applyMatrix4(_inv);
      P.lift[i] = this.feet[i].swing && !this.feet[i].skip ? this.feet[i].t : 0;
      if (i < 2) fy += P.feet[i].y / 2;
      else hy += P.feet[i].y / 2;
      ly += (i % 2 ? -1 : 1) * P.feet[i].y / 2; // (left − right)
      if (!P.lift[i]) low = Math.min(low, P.feet[i].y);
    }
    if (low === Infinity) low = Math.min(fy, hy);
    // the body over them: pitched with the slope, a little bob and sway with the steps
    const len = (FRONT0[3].z - HIND0[3].z);
    const pitch = Math.atan2(hy - fy, len);
    const g = this.gait;
    const step = this.speed > 0.05 ? 1 : 0;
    this.bob += (step - this.bob) * Math.min(1, dt * 3);
    const ph = this.phase * Math.PI * 2;
    const bobY = this.bob * (g === GAITS.trot ? 0.035 * Math.cos(ph * 2) : 0.015 * Math.cos(ph * 2));
    const sway = this.bob * 0.02 * Math.sin(ph);
    // (across a slope the body leans a little uphill, and never stands so high the downhill legs can't reach)
    const roll = this.bob * 0.025 * Math.sin(ph) - Math.atan2(ly, 0.33) * 0.35;
    const y = Math.min((fy + hy) / 2 + BODY0.y - 0.02, low + BODY0.y + 0.03) + bobY - this.graze * 0.04;
    P.body.makeRotationX(pitch + this.graze * 0.07).premultiply(_rot.makeTranslation(sway, y, 0)).multiply(_rot2.makeRotationZ(roll));
    // the neck eases toward its target; grazing, the first joint servos until the muzzle is at the ground
    const k = Math.min(1, dt * 2.2);
    const N = this.neck, L = this.look;
    N.n2 += (L.n2 - N.n2) * k;
    N.head += (L.head - N.head) * k;
    N.yaw += (L.yaw - N.yaw) * k;
    if (this.graze > 0.5) {
      rig.muzzle(_q);
      const target = Math.min(fy, hy) + 0.1 - _q.y; // (m: + → the muzzle is below where it should be)
      N.n1 = THREE.MathUtils.clamp(N.n1 - target * 1.2 * dt * 3, -0.6, 1.75);
      // the face held ~65° nose down whatever the neck does (tucked further, a bull's antlers lay along the ground)
      N.head += (THREE.MathUtils.clamp(1.15 - HEAD_PITCH0 - N.n1 - N.n2, -0.6, 0.8) - N.head) * Math.min(1, dt * 6);
    } else {
      N.n1 += (L.n1 - N.n1) * k;
    }
    P.neck1 = N.n1;
    P.neck2 = N.n2 + (this.graze > 0.5 ? 0.04 * Math.sin(this.time * 5.3) : 0); // (chewing, tearing at the grass)
    P.head = N.head;
    P.yaw = N.yaw;
    P.tail = 0.25 * Math.sin(this.time * 2.1) * Math.max(0, Math.sin(this.time * 0.37));
    P.stride = THREE.MathUtils.clamp(0.35 + this.speed * 0.5, 0.35, 1);
    rig.apply();
  }
}

// head poses: grazing (the neck servos down), walking, alert (head high, looking)
export const LOOKS = {
  graze: { n1: 1.0, n2: 0.3, head: 0.25, yaw: 0 },
  walk: { n1: 0.05, n2: 0.0, head: 0.38, yaw: 0 },
  alert: { n1: -0.3, n2: -0.15, head: 0.2, yaw: 0 },
};
export { GAITS };


// ---------------------------------------------------------------------------
// Herds: where they live, what they do
// ---------------------------------------------------------------------------

// three herds in open meadows beside the trail: just west of the trailhead (ahead of you as you
// start), between the dunes and the marsh, and in the clearings by Forest Road 2840 near the rapids.
// (bull, cows, calves)
const HERDS = [
  { x: -45, z: 702, bulls: 1, cows: 3, calves: 1 },
  { x: 268, z: 612, bulls: 0, cows: 3, calves: 1 },
  { x: 192, z: -250, bulls: 1, cows: 2, calves: 0 },
];
const ALERT_R = 48; // m: heads come up
const FLEE_R = 21; // m: they trot off
const SIM_R = 320; // m: herds further than this from the player stand still (unseen)
const SHOW_R = 260; // m: and elk further than this aren't drawn (a few pixels, in the haze)

const slope = (x, z) => {
  const e = 2;
  return Math.max(Math.abs(groundAt(x + e, z) - groundAt(x - e, z)), Math.abs(groundAt(x, z + e) - groundAt(x, z - e))) / (2 * e);
};
/** Somewhere an elk can walk: dry, not too steep, below the snow, off the sand. */
function walkable(x, z) {
  if (Math.abs(x) > 1250 || Math.abs(z) > 1250) return false;
  const h = groundAt(x, z);
  return h > openWaterLevel(x, z) + 0.3 && h < SNOWLINE - 25 && slope(x, z) < 0.38 && sandAt(x, z) < 0.4;
}

const _p = new THREE.Vector3();

class Elk {
  constructor(herd, body, kind, rand) {
    this.herd = herd;
    this.body = body;
    this.kind = kind; // 'bull' | 'cow' | 'calf'
    this.rand = rand;
    this.state = 'graze';
    this.timer = rand() * 8;
    this.tx = body.x;
    this.tz = body.z;
    this.want = 0; // desired speed
    this.lookUp = 0; // a grazing elk now and then lifts its head and looks round
    this.r = 0.5 * body.size; // (for spacing and the player's collider)
    this.acc = 0;
    this.tick = 0;
  }

  pickNear(cx, cz, rMin, rMax) {
    for (let i = 0; i < 8; i++) {
      const a = this.rand() * Math.PI * 2;
      const d = rMin + this.rand() * (rMax - rMin);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (walkable(x, z)) {
        this.tx = x;
        this.tz = z;
        return true;
      }
    }
    return false;
  }

  update(dt, player, distP) {
    const b = this.body;
    const h = this.herd;
    this.timer -= dt;
    // the herd's mood comes first: fleeing, or wary of the player
    if (h.flee > 0 && this.state !== 'flee') {
      this.state = 'flee';
      this.tx = h.fx + (this.rand() - 0.5) * 14;
      this.tz = h.fz + (this.rand() - 0.5) * 14;
    } else if (this.state !== 'flee' && distP < ALERT_R && this.state !== 'alert' && (distP < ALERT_R * 0.7 || player.moving)) {
      this.state = 'alert';
      this.timer = 4 + this.rand() * 4;
    }

    let look = LOOKS.walk;
    let graze = 0;
    switch (this.state) {
      case 'graze': {
        // head down, now and then a step or two on; sometimes the head comes up for a look round
        this.want = this.moveOn ? 0.35 : 0;
        if (this.moveOn && Math.hypot(this.tx - b.x, this.tz - b.z) < 0.6) this.moveOn = false;
        if (this.timer <= 0) {
          this.timer = 4 + this.rand() * 10;
          const far = Math.hypot(b.x - h.cx, b.z - h.cz) > h.spread;
          if (far) {
            this.pickNear(h.cx, h.cz, 0, h.spread * 0.6);
            this.state = 'walk';
          } else if (this.rand() < 0.55) {
            // a few steps to fresh grass, mostly ahead
            const a = b.heading + (this.rand() - 0.5) * 1.6;
            const d = 1.5 + this.rand() * 3;
            const x = b.x + Math.sin(a) * d, z = b.z + Math.cos(a) * d;
            if (walkable(x, z)) { this.tx = x; this.tz = z; this.moveOn = true; }
          } else if (this.rand() < 0.4) {
            this.lookUp = 2.5 + this.rand() * 3;
          }
        }
        this.lookUp -= dt;
        if (this.lookUp > 0) look = LOOKS.alert;
        else { look = LOOKS.graze; graze = 1; }
        break;
      }
      case 'walk':
        this.want = this.kind === 'calf' ? 1.4 : 1.2;
        if (Math.hypot(this.tx - b.x, this.tz - b.z) < 1.5) {
          this.state = 'graze';
          this.timer = 3 + this.rand() * 6;
        }
        break;
      case 'alert': {
        // stand and watch (the head turns to the player; the body follows if it has to)
        this.want = 0;
        look = LOOKS.alert;
        if (distP > ALERT_R + 8 && this.timer <= 0) {
          this.state = 'graze';
          this.timer = 2 + this.rand() * 5;
        } else if (distP < ALERT_R) this.timer = Math.max(this.timer, 3);
        break;
      }
      case 'flee':
        this.want = this.kind === 'calf' ? 4.8 : 4.5;
        if (Math.hypot(this.tx - b.x, this.tz - b.z) < 3 || h.flee <= 0) {
          this.state = 'alert';
          this.timer = 8 + this.rand() * 6;
        }
        break;
    }

    // steering: toward the target (standing: toward the player when alert)
    let wantHeading = b.heading;
    let moving = this.want > 0.01 && (this.state !== 'graze' || this.moveOn);
    if (moving) wantHeading = Math.atan2(this.tx - b.x, this.tz - b.z);
    let diff = Math.atan2(Math.sin(wantHeading - b.heading), Math.cos(wantHeading - b.heading));
    // watching: the head turns first; past ~70° the body comes round too
    let headYaw = 0;
    if (this.state === 'alert' || (this.state === 'graze' && this.lookUp > 0 && distP < ALERT_R * 1.5)) {
      const toP = Math.atan2(player.x - b.x, player.z - b.z);
      const d = Math.atan2(Math.sin(toP - b.heading), Math.cos(toP - b.heading));
      headYaw = THREE.MathUtils.clamp(d, -1.1, 1.1);
      if (!moving && Math.abs(d) > 1.2) diff = d - Math.sign(d) * 0.9;
    }
    const maxTurn = this.want > 2 ? 1.5 : 0.9;
    const turn = THREE.MathUtils.clamp(diff * 1.5, -maxTurn, maxTurn);
    b.turn += (turn - b.turn) * Math.min(1, dt * 4);
    // slow down to turn; keep apart from the others
    let speed = moving ? this.want * Math.max(0.2, Math.cos(Math.min(Math.abs(diff), 1.5))) : 0;
    for (const o of h.members) {
      if (o === this) continue;
      const dx = o.body.x - b.x, dz = o.body.z - b.z;
      const d = Math.hypot(dx, dz);
      const min = (this.r + o.r) * 2.2;
      if (d < min && d > 1e-3) {
        // someone close ahead: slow; and both ease apart
        const ahead = (dx * Math.sin(b.heading) + dz * Math.cos(b.heading)) / d;
        if (ahead > 0.5) speed *= 0.3;
        const push = (min - d) * 0.5 * dt;
        b.x -= dx / d * push;
        b.z -= dz / d * push;
      }
    }
    b.speed += (speed - b.speed) * Math.min(1, dt * (speed > b.speed ? 1.5 : 3));
    b.gait = b.speed > 2.4 ? GAITS.trot : b.speed < 1.9 ? GAITS.walk : b.gait;
    Object.assign(b.look, look);
    b.look.yaw = headYaw;
    b.graze += (graze - b.graze) * Math.min(1, dt * 1.5);
  }
}

export function buildElk({ collide = null } = {}) {
  const group = new THREE.Group();
  group.name = 'elk';
  const rand = mulberry32(SEED + 9091);
  const material = elkMaterial();
  const geoms = { cow: null, bull: null };
  const herds = [];
  const all = [];

  // contact shadows: a soft dark oval under each (no shadow maps in this world)
  const sc = document.createElement('canvas');
  sc.width = sc.height = 64;
  const sg = sc.getContext('2d');
  const grad = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  sg.fillStyle = grad;
  sg.fillRect(0, 0, 64, 64);
  const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.42, alphaMap: new THREE.CanvasTexture(sc), depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });

  for (const H of HERDS) {
    const herd = { cx: H.x, cz: H.z, spread: 16, members: [], flee: 0, fx: 0, fz: 0, moveIn: 60 + rand() * 60, home: H };
    const kinds = [...Array(H.bulls).fill('bull'), ...Array(H.cows).fill('cow'), ...Array(H.calves).fill('calf')];
    for (const kind of kinds) {
      const bull = kind === 'bull';
      const key = bull ? 'bull' : 'cow';
      const rig = new ElkRig(bull);
      if (geoms[key]) rig.geometry = geoms[key];
      else geoms[key] = rig.geometry;
      const mesh = new THREE.SkinnedMesh(rig.geometry, material);
      mesh.name = `elk ${kind}`;
      for (const bn of rig.bones) mesh.add(bn);
      mesh.bind(rig.skeleton, new THREE.Matrix4());
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.3, 0.2), 2.6);
      mesh.matrixAutoUpdate = false;
      const size = bull ? 1.1 : kind === 'calf' ? 0.64 : 0.94 + rand() * 0.1;
      const body = new ElkBody(rig, mesh, groundAt, size);
      // somewhere open near the herd's middle, facing anywhere
      let x = H.x, z = H.z;
      for (let i = 0; i < 20; i++) {
        const a = rand() * Math.PI * 2, d = 3 + rand() * 12;
        if (walkable(H.x + Math.cos(a) * d, H.z + Math.sin(a) * d)) { x = H.x + Math.cos(a) * d; z = H.z + Math.sin(a) * d; break; }
      }
      body.place(x, z, rand() * Math.PI * 2);
      body.phase = rand();
      const elk = new Elk(herd, body, kind, rand);
      herd.members.push(elk);
      all.push(elk);
      group.add(mesh);
    }
    herds.push(herd);
  }
  const shadows = new THREE.InstancedMesh(shadowGeo, shadowMat, all.length);
  shadows.name = 'elk shadows';
  shadows.frustumCulled = false;
  shadows.renderOrder = 1;
  group.add(shadows);

  const player = { x: 0, z: 0, moving: false };
  let lastX = 0, lastZ = 0;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const n = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const fa = new THREE.Vector3();
  const fb = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const hide = new THREE.Matrix4().makeScale(0, 0, 0);

  return {
    group,
    herds,
    all,
    update(dt, camera) {
      player.x = camera.position.x;
      player.z = camera.position.z;
      const pv = Math.hypot(player.x - lastX, player.z - lastZ) / Math.max(dt, 1e-3);
      player.moving = pv > 0.8;
      lastX = player.x;
      lastZ = player.z;
      let k = 0;
      for (const h of herds) {
        const dh = Math.hypot(h.cx - player.x, h.cz - player.z);
        const active = dh < SIM_R;
        // the herd drifts on to fresh grazing now and then, within its meadows
        h.moveIn -= dt;
        if (active && h.moveIn <= 0 && h.flee <= 0) {
          h.moveIn = 70 + rand() * 90;
          for (let i = 0; i < 10; i++) {
            const a = rand() * Math.PI * 2, d = 10 + rand() * 30;
            const x = h.cx + Math.cos(a) * d, z = h.cz + Math.sin(a) * d;
            if (Math.hypot(x - h.home.x, z - h.home.z) < 70 && walkable(x, z)) { h.cx = x; h.cz = z; break; }
          }
        }
        // too close: the whole herd trots off, away from the player, then settles there
        if (active) {
          let nearest = Infinity;
          for (const e of h.members) nearest = Math.min(nearest, Math.hypot(e.body.x - player.x, e.body.z - player.z));
          if (h.flee <= 0 && nearest < FLEE_R) {
            const away = Math.atan2(h.cx - player.x, h.cz - player.z);
            for (let i = 0; i < 12; i++) {
              const a = away + (i % 2 ? 1 : -1) * Math.floor((i + 1) / 2) * 0.35;
              const d = 55 + rand() * 25;
              const x = h.cx + Math.sin(a) * d, z = h.cz + Math.cos(a) * d;
              // (the way there walkable too, roughly)
              if (walkable(x, z) && walkable((x + h.cx) / 2, (z + h.cz) / 2)) {
                h.fx = x; h.fz = z;
                h.flee = 14;
                break;
              }
            }
          }
          if (h.flee > 0) {
            h.flee -= dt;
            if (h.flee <= 0) { h.cx = h.fx; h.cz = h.fz; h.moveIn = 90 + rand() * 60; }
          }
        }
        for (const e of h.members) {
          const b = e.body;
          const d = Math.hypot(b.x - player.x, b.z - player.z);
          const show = active && d < SHOW_R;
          b.mesh.visible = show;
          if (active) {
            e.update(dt, player, d);
            const ox = b.x, oz = b.z;
            // (further off, the legs and pose are worked out every other or third frame)
            e.acc += dt;
            const every = d < 70 ? 1 : d < 140 ? 2 : 3;
            if (++e.tick % every === 0 || e.acc > 0.1) {
              b.update(e.acc);
              e.acc = 0;
            }
            // round the trunks (as the player); a step into deep water or up a cliff is undone
            if (collide) {
              _p.set(b.x, 0, b.z);
              collide(_p, 0.45 * b.size);
              b.x = _p.x;
              b.z = _p.z;
            }
            if (b.speed > 0.05 && !walkable(b.x, b.z) && walkable(ox, oz)) {
              b.x = ox;
              b.z = oz;
              e.pickNear(b.x, b.z, 4, 12);
            }
          }
          // its shadow, on the ground under the body, tilted with the slope
          if (show) {
            // (the plane through the hooves: front − hind and left − right)
            const F = b.feet;
            fa.addVectors(F[0].p, F[1].p).sub(F[2].p).sub(F[3].p);
            fb.addVectors(F[0].p, F[2].p).sub(F[1].p).sub(F[3].p);
            n.crossVectors(fa, fb).normalize();
            if (n.y < 0) n.negate();
            q.setFromUnitVectors(up, n);
            m.makeRotationY(b.heading).premultiply(_rot.makeRotationFromQuaternion(q));
            m.scale(sv.set(0.95 * b.size, 1, 2.3 * b.size));
            m.setPosition(b.x, (F[0].p.y + F[1].p.y + F[2].p.y + F[3].p.y) / 4 + 0.05, b.z);
            shadows.setMatrixAt(k, m);
          } else shadows.setMatrixAt(k, hide);
          k++;
        }
      }
      shadows.instanceMatrix.needsUpdate = true;
    },
    /** Keep the player out of them (two circles along each body). */
    collide(pos, r) {
      for (const e of all) {
        const b = e.body;
        if (!b.mesh.visible) continue;
        const dx0 = pos.x - b.x, dz0 = pos.z - b.z;
        if (dx0 * dx0 + dz0 * dz0 > 16) continue;
        for (const off of [0.45, -0.45]) {
          const cx = b.x + Math.sin(b.heading) * off * b.size, cz = b.z + Math.cos(b.heading) * off * b.size;
          const dx = pos.x - cx, dz = pos.z - cz;
          const d = Math.hypot(dx, dz);
          const min = r + 0.42 * b.size;
          if (d < min && d > 1e-4) {
            pos.x = cx + dx / d * min;
            pos.z = cz + dz / d * min;
          }
        }
      }
    },
  };
}
