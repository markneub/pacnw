import * as THREE from 'three';
import { rawGroundAt, coastZ, sandAt, LAKE, mulberry32 } from './terrain.js';
import { SNOWLINE, SEED } from './config.js';

// Birds in the sky: red-tailed hawks and a bald eagle circling on thermals over the valley and the
// lake, a pair of ravens anywhere (the mountains too), gulls along the beach. A few dozen
// instances at most: each bird is flown on the CPU (steering round a drifting thermal, banking
// into its turns, flapping in bursts), and its wings flap in the vertex shader (per-instance
// phase and amplitude). Every so often a bird picks a new thermal near the player within its
// own country, and glides over to it, so wherever you walk there's usually something overhead.

// ---------------------------------------------------------------------------
// Geometry: one low-poly bird per species, built here (bird frame: x across the wings, y up,
// z forward, metres, life size). Wings and tail are thin double layers (top and underside
// coloured apart); `aWing` = 1 on the wings (they flap), 0 on the body and tail.
// ---------------------------------------------------------------------------

class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.wing = [];
  }

  tri(a, b, c, ca, cb, cc, w = 0, up = null) {
    const e1 = new THREE.Vector3().subVectors(b, a);
    const e2 = new THREE.Vector3().subVectors(c, a);
    const n = e1.cross(e2).normalize();
    // (a face that should face a side, given: wind it that way)
    if (up && n.dot(up) < 0) {
      [b, c] = [c, b];
      [cb, cc] = [cc, cb];
      n.negate();
    }
    for (const [p, cl] of [[a, ca], [b, cb], [c, cc]]) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.col.push(cl.r, cl.g, cl.b);
      this.wing.push(w);
    }
  }

  /** A flat surface (a fan or strip of triangles) as two layers: top coloured by topCol, underside by underCol. */
  sheet(tris, topCol, underCol, w, thick = 0.006) {
    const UP = new THREE.Vector3(0, 1, 0);
    const DOWN = new THREE.Vector3(0, -1, 0);
    for (const [a, b, c] of tris) {
      const off = (p) => new THREE.Vector3(p.x, p.y + thick, p.z);
      this.tri(off(a), off(b), off(c), topCol(a), topCol(b), topCol(c), w, UP);
      this.tri(a, b, c, underCol(a), underCol(b), underCol(c), w, DOWN);
    }
  }

  /** A spindle along z: rings (z, half-width, half-height, y offset), `sides` around; colour by (angle, z). */
  body(rings, sides, colour) {
    const ring = (r) => Array.from({ length: sides }, (_, i) => {
      const a = (i / sides) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * r[1], r[3] + Math.sin(a) * r[2], r[0]);
    });
    const pts = rings.map(ring);
    for (let k = 0; k + 1 < rings.length; k++) {
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        const a = pts[k][i], b = pts[k][j], c = pts[k + 1][j], d = pts[k + 1][i];
        // outward: away from the axis
        const mid = new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5);
        const out = new THREE.Vector3(mid.x, mid.y - (rings[k][3] + rings[k + 1][3]) / 2, 0);
        this.tri(a, b, c, colour(a), colour(b), colour(c), 0, out);
        this.tri(a, c, d, colour(a), colour(c), colour(d), 0, out);
      }
    }
    // caps (the tail end and the beak tip close to points, so only where a ring has size)
    for (const k of [0, rings.length - 1]) {
      if (rings[k][1] < 1e-4) continue;
      const cz = new THREE.Vector3(0, rings[k][3], rings[k][0]);
      const out = new THREE.Vector3(0, 0, k === 0 ? -1 : 1);
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        this.tri(cz, pts[k][i], pts[k][j], colour(cz), colour(pts[k][i]), colour(pts[k][j]), 0, out);
      }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aWing', new THREE.Float32BufferAttribute(this.wing, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const C = (hex) => new THREE.Color(hex);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * A wing (both sides) from its planform: `le`/`te` = z of the leading and trailing edge at
 * span fractions `st` (0 at the body .. 1 at the hand's tip), half span `L`; then `fingers`
 * primaries splayed out of the hand (slotted tips: hawks, eagles, ravens) or none (gulls).
 * Colour functions get (s = span fraction, c = 0 leading .. 1 trailing edge, finger tip t).
 */
function wing(b, { L, st, le, te, root = 0.045, fingers = 0, fingerLen = 0.2, fingerW = 0.04, fingerSpread = 0.5, top, under }) {
  for (const side of [1, -1]) {
    const tris = [];
    const sc = new Map(); // vertex -> (s, c)
    const P = (s, c, i) => {
      const z = le[i] + (te[i] - le[i]) * c;
      const p = V(side * (root + s * (L - root)), 0, z);
      sc.set(p, [s, c, 0]);
      return p;
    };
    const ROWS = 4; // across the chord
    for (let i = 0; i + 1 < st.length; i++) {
      for (let r = 0; r < ROWS; r++) {
        const c0 = r / ROWS, c1 = (r + 1) / ROWS;
        const a = P(st[i], c0, i), bb = P(st[i + 1], c0, i + 1), c = P(st[i + 1], c1, i + 1), d = P(st[i], c1, i);
        tris.push([a, bb, c], [a, c, d]);
      }
    }
    // the primaries: from the hand's outer edge, fanned from forward-out to back-out
    const last = st.length - 1;
    for (let f = 0; f < fingers; f++) {
      const u = fingers === 1 ? 0.5 : f / (fingers - 1);
      const cMid = 0.12 + 0.76 * u;
      const zb = le[last] + (te[last] - le[last]) * cMid;
      const xb = side * L;
      const ang = (0.5 - u) * fingerSpread; // + forward
      const len = fingerLen * (0.8 + 0.35 * Math.sin(Math.PI * (0.25 + 0.6 * u)));
      const dx = Math.cos(ang) * side, dz = Math.sin(ang);
      const w = fingerW * (0.9 + 0.2 * (1 - u));
      // a tapered strip: base across the chord, a narrower mid, a point
      const nx = -dz * side, nz = dx * side; // (across the finger, in the wing plane)
      const mk = (along, half, t) => {
        const p = V(xb + dx * along * len + nx * half * side, 0, zb + dz * along * len + nz * half * side);
        sc.set(p, [1, cMid, t]);
        return p;
      };
      const b0 = mk(-0.15, w * 0.5, 0), b1 = mk(-0.15, -w * 0.5, 0);
      const m0 = mk(0.6, w * 0.42, 0.6), m1 = mk(0.6, -w * 0.42, 0.6);
      const tip = mk(1, 0, 1);
      tris.push([b0, b1, m1], [b0, m1, m0], [m0, m1, tip]);
    }
    const colourOf = (fn) => (p) => {
      const v = sc.get(p);
      return v ? fn(v[0], v[1], v[2]) : fn(0, 0, 0);
    };
    b.sheet(tris, colourOf(top), colourOf(under), 1);
  }
}

/** A tail: a fan from the rump (z0) out to radius `len`, `spread` radians wide; wedge > 0 makes the middle longer. */
function tail(b, { z0, len, spread, wedge = 0, notch = 0, top, under }) {
  const N = 6;
  const centre = V(0, 0.01, z0);
  const tris = [];
  const t = new Map();
  t.set(centre, 0);
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N - 0.5;
    const a = u * spread;
    const r = len * (1 + wedge * (1 - Math.abs(u) * 2) - notch * (1 - Math.abs(u) * 2) ** 4);
    const p = V(Math.sin(a) * r, 0.01, z0 - Math.cos(a) * r);
    t.set(p, 1);
    pts.push(p);
  }
  for (let i = 0; i < N; i++) tris.push([centre, pts[i], pts[i + 1]]);
  b.sheet(tris, (p) => top(t.get(p)), (p) => under(t.get(p)), 0, 0.004);
}

const mix = (a, b, t) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hawkGeometry() {
  // red-tailed hawk: broad wings ~1.25 m across with slotted tips, a short rounded rufous tail,
  // brown above, pale below with a dark bar along the leading edge, dark wrist commas and tips
  const b = new Builder();
  const brown = C(0x463629), dark = C(0x2a1d14), pale = C(0xd9cdb4), buff = C(0xc2ae8c), rufous = C(0xa6542c);
  wing(b, {
    L: 0.56, st: [0, 0.15, 0.3, 0.45, 0.55, 0.65, 0.8, 1], le: [0.07, 0.085, 0.1, 0.108, 0.11, 0.1, 0.07, 0.01], te: [-0.22, -0.215, -0.21, -0.2, -0.19, -0.175, -0.14, -0.09],
    fingers: 5, fingerLen: 0.13, fingerW: 0.032, fingerSpread: 0.75,
    top: (s, c, t) => mix(brown, dark, smooth(0.7, 1, s) * 0.6 + t * 0.4),
    under: (s, c, t) => {
      let k = mix(pale, buff, 0.3 * (1 - c));
      k = mix(k, dark, (1 - smooth(0.05, 0.3, c)) * smooth(0.05, 0.15, s) * (1 - smooth(0.45, 0.55, s)) * 0.85); // patagial bar
      k = mix(k, dark, (1 - smooth(0.1, 0.35, c)) * smooth(0.5, 0.6, s) * (1 - smooth(0.68, 0.78, s))); // carpal comma
      k = mix(k, dark, smooth(0.75, 0.95, c) * 0.35 + t * 0.85); // trailing edge, finger tips
      return k;
    },
  });
  tail(b, { z0: -0.17, len: 0.21, spread: 0.95, top: () => rufous, under: (t) => mix(C(0xe8dccd), C(0xdcc0a8), t) });
  b.body([[-0.2, 0.0, 0.0, 0.01], [-0.14, 0.035, 0.03, 0.01], [0, 0.055, 0.05, 0.0], [0.12, 0.05, 0.05, 0.005], [0.2, 0.034, 0.034, 0.02], [0.25, 0.025, 0.024, 0.02], [0.29, 0.0, 0.0, 0.012]],
    6, (p) => (p.y > 0.012 ? brown : p.z > 0.15 ? buff : mix(pale, dark, smooth(0.0, 0.06, p.z) * smooth(0.12, 0.06, p.z) * 0.6)));
  return b.geometry();
}

function eagleGeometry() {
  // bald eagle: long, plank-like wings ~2 m across with deep fingers, dark brown, white head and tail
  const b = new Builder();
  const brown = C(0x2b1e15), dark = C(0x1d140e), white = C(0xeeeae0), beak = C(0xd8b030);
  wing(b, {
    L: 0.88, st: [0, 0.3, 0.6, 0.85, 1], le: [0.1, 0.13, 0.13, 0.1, 0.05], te: [-0.32, -0.3, -0.27, -0.2, -0.14],
    fingers: 6, fingerLen: 0.24, fingerW: 0.042, fingerSpread: 0.7,
    top: (s, c, t) => mix(brown, dark, t * 0.5),
    under: (s, c, t) => mix(brown, dark, 0.3 + t * 0.5),
  });
  tail(b, { z0: -0.26, len: 0.3, spread: 0.7, top: () => white, under: () => white });
  b.body([[-0.3, 0.0, 0.0, 0.01], [-0.22, 0.05, 0.04, 0.01], [0, 0.085, 0.08, 0.0], [0.18, 0.075, 0.07, 0.01], [0.28, 0.05, 0.05, 0.03], [0.36, 0.045, 0.045, 0.035], [0.42, 0.02, 0.025, 0.025], [0.46, 0.0, 0.0, 0.015]],
    6, (p) => (p.z > 0.4 ? beak : p.z > 0.26 ? white : brown));
  return b.geometry();
}

function ravenGeometry() {
  // common raven: ~1.2 m, all glossy black, fingered wings, a long wedge tail, a heavy head and bill
  const b = new Builder();
  const black = C(0x111214), sheen = C(0x1b1d24);
  wing(b, {
    L: 0.55, st: [0, 0.3, 0.55, 0.8, 1], le: [0.07, 0.1, 0.1, 0.06, 0.0], te: [-0.2, -0.19, -0.17, -0.12, -0.08],
    fingers: 5, fingerLen: 0.14, fingerW: 0.03, fingerSpread: 0.7,
    top: (s) => mix(sheen, black, s), under: () => black,
  });
  tail(b, { z0: -0.17, len: 0.24, spread: 0.6, wedge: 0.3, top: () => black, under: () => black });
  b.body([[-0.19, 0.0, 0.0, 0.01], [-0.12, 0.035, 0.03, 0.01], [0, 0.052, 0.05, 0.0], [0.13, 0.045, 0.045, 0.01], [0.22, 0.035, 0.036, 0.02], [0.29, 0.016, 0.02, 0.012], [0.33, 0.0, 0.0, 0.006]],
    6, () => black);
  return b.geometry();
}

function gullGeometry() {
  // western gull: long pointed wings ~1.35 m, dark grey mantle, white below, black tips with a
  // white spot, a white square tail, a yellow bill
  const b = new Builder();
  const grey = C(0x5a6068), white = C(0xf2f2ee), black = C(0x15161a), bill = C(0xe0c040);
  wing(b, {
    L: 0.62, st: [0, 0.3, 0.5, 0.65, 0.8, 1], le: [0.06, 0.08, 0.09, 0.06, 0.02, -0.1], te: [-0.14, -0.13, -0.1, -0.09, -0.085, -0.115],
    top: (s, c) => {
      let k = mix(grey, white, smooth(0.8, 1, c) * 0.8 * (1 - smooth(0.7, 0.8, s))); // white trailing edge
      k = mix(k, black, smooth(0.72, 0.85, s));
      return k;
    },
    under: (s, c) => mix(white, black, smooth(0.74, 0.9, s) * (0.75 + 0.25 * c)),
  });
  tail(b, { z0: -0.13, len: 0.13, spread: 0.7, top: () => white, under: () => white });
  b.body([[-0.15, 0.0, 0.0, 0.01], [-0.1, 0.03, 0.028, 0.01], [0, 0.045, 0.045, 0.0], [0.12, 0.04, 0.04, 0.005], [0.19, 0.03, 0.03, 0.018], [0.24, 0.022, 0.022, 0.018], [0.27, 0.008, 0.008, 0.014], [0.31, 0.0, 0.0, 0.012]],
    6, (p) => (p.z > 0.25 ? bill : p.y > 0.035 && p.z < 0.15 ? grey : white));
  return b.geometry();
}

// ---------------------------------------------------------------------------
// Species: how they fly and where
// ---------------------------------------------------------------------------

const SPECIES = {
  hawk: {
    geometry: hawkGeometry, half: 0.56, count: 2, size: 1.4, speed: 10.5, radius: [30, 55], alt: [35, 75], clear: 32,
    flapHz: 3.4, flapAmp: 0.6, burst: [14, 32], flaps: [3, 6], dihedral: 0.14, wrist: 0.03,
    // the valley and the foothills: below the snow
    home: (x, z, h) => h < SNOWLINE - 10 && h > -2,
  },
  eagle: {
    geometry: eagleGeometry, half: 0.88, count: 1, size: 1.25, speed: 11.5, radius: [45, 70], alt: [40, 90], clear: 36,
    flapHz: 2.3, flapAmp: 0.5, burst: [20, 45], flaps: [3, 5], dihedral: 0.03, wrist: 0.02,
    // over the lake and the coast
    home: (x, z, h) => Math.hypot(x - LAKE.x, z - LAKE.z) < 320 || z > coastZ(x) - 380,
  },
  raven: {
    geometry: ravenGeometry, half: 0.55, count: 2, size: 1.4, pair: true, speed: 11, radius: [25, 45], alt: [25, 60], clear: 28,
    flapHz: 4.2, flapAmp: 0.65, burst: [4, 11], flaps: [4, 10], dihedral: 0.08, wrist: 0.0,
    home: () => true,
  },
  gull: {
    geometry: gullGeometry, half: 0.62, count: 5, size: 1.35, speed: 9, radius: [20, 45], alt: [8, 30], clear: 7,
    flapHz: 2.9, flapAmp: 0.48, burst: [3, 9], flaps: [3, 9], dihedral: 0.2, wrist: -0.32,
    // the beach and the water off it
    home: (x, z) => { const s = coastZ(x) - z; return s > -140 && s < 170; },
  },
};

// starting thermals (so something's up there from the start): near the spawn, over the lake,
// the beach, the snowfield
const START = { hawk: [[60, 600], [-80, 520]], eagle: [[170, 380]], raven: [[40, 560]], gull: [[0, 960], [220, 990]] };

// ---------------------------------------------------------------------------
// The vertex shader: flap the wings (rotations at the shoulder and the wrist)
// ---------------------------------------------------------------------------

function patchFlap(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aWing;
        attribute vec4 aBird; // flap phase, flap amplitude (rad), dihedral, wrist bend
        attribute float aHalf; // half span, m
        vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
        // a wing point (and normal) on the right side (x > 0): the hand turns at the wrist, then
        // the whole wing at the shoulder (about the body's axis); on the upstroke the hand sweeps back
        void flap(inout vec3 p, inout vec3 n, float side) {
          float ph = aBird.x;
          float amp = aBird.y;
          float shoulder = aBird.z + amp * sin(ph);
          float wrist = aBird.w + amp * 0.55 * sin(ph - 0.9);
          float sweep = amp * 0.6 * max(0.0, -cos(ph - 0.4)) * smoothstep(0.0, 0.6, amp);
          float xs = 0.04;
          float xw = xs + (aHalf - xs) * 0.52;
          if (p.x > xw) {
            vec3 q = p - vec3(xw, 0.0, 0.0);
            q.xz = rot2(q.xz, -sweep); // (the tip back)
            n.xz = rot2(n.xz, -sweep);
            q.xy = rot2(q.xy, wrist);
            n.xy = rot2(n.xy, wrist);
            p = q + vec3(xw, 0.0, 0.0);
          }
          vec3 q = p - vec3(xs, 0.0, 0.0);
          q.xy = rot2(q.xy, shoulder);
          n.xy = rot2(n.xy, shoulder);
          p = q + vec3(xs, 0.0, 0.0);
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        vec3 birdP = position;
        if (aWing > 0.5) {
          float side = birdP.x < 0.0 ? -1.0 : 1.0;
          birdP.x *= side;
          objectNormal.x *= side;
          flap(birdP, objectNormal, side);
          birdP.x *= side;
          objectNormal.x *= side;
        }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed = birdP;`);
    // Seen from below, a bird against the sky isn't lit only by the ground: daylight comes through
    // the feathers (wings and tail are thin) and the sky's light wraps round. Down-facing
    // surfaces get the sky's colour and a share of the sun through them.
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      #if NUM_HEMI_LIGHTS > 0 && NUM_DIR_LIGHTS > 0
      {
        vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        float below = max(0.0, -dot(normal, upV));
        vec3 through = hemisphereLights[0].skyColor * 0.55 + directionalLights[0].color * 0.22 * max(0.0, dot(directionalLights[0].direction, upV));
        reflectedLight.indirectDiffuse += diffuseColor.rgb * through * below;
      }
      #endif`);
  };
  material.customProgramCacheKey = () => 'birds1';
}

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------

const G = 9.81;
const tmpF = new THREE.Vector3();
const tmpX = new THREE.Vector3();
const tmpY = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3();

const groundOrSea = (x, z) => Math.max(rawGroundAt(x, z), 0);

class Bird {
  constructor(sp, rand, cx, cz, leader = null) {
    this.sp = sp;
    this.rand = rand;
    this.leader = leader;
    this.centre = new THREE.Vector2(cx, cz);
    this.radius = sp.radius[0] + rand() * (sp.radius[1] - sp.radius[0]);
    this.dir = rand() < 0.5 ? 1 : -1;
    this.altBase = sp.alt[0] + rand() * (sp.alt[1] - sp.alt[0]);
    const a = rand() * Math.PI * 2;
    this.pos = new THREE.Vector3(cx + Math.cos(a) * this.radius, 0, cz + Math.sin(a) * this.radius);
    this.pos.y = groundOrSea(cx, cz) + this.altBase;
    this.heading = a + this.dir * Math.PI / 2;
    this.vy = 0;
    this.yawRate = 0;
    this.speed = sp.speed * (0.9 + 0.2 * rand());
    this.latA = 0; // lateral acceleration (banking)
    this.phase = rand() * 6.28;
    this.amp = 0;
    this.flapsLeft = 0;
    this.nextBurst = rand() * sp.burst[1];
    this.replanIn = 8 + rand() * 40;
    this.seed = rand() * 100;
    this.scale = sp.size * (0.92 + 0.16 * rand()); // (larger than life: life size is a speck at 80 m)
  }

  /**
   * A new thermal: near the player if that's in this bird's country (else near the old one),
   * over the most open ground of a few tries: meadows, water, sand, where you can see the sky
   * (and where hawks hunt). Under closed canopy a bird overhead is hidden anyway.
   */
  replan(player, canopyAt) {
    const sp = this.sp;
    const rand = this.rand;
    this.replanIn = 50 + rand() * 80;
    if (this.leader) return; // (the pair's second follows the first)
    let best = Infinity, bx = 0, bz = 0;
    for (let pass = 0; pass < 2 && best === Infinity; pass++) {
      for (let i = 0; i < 10; i++) {
        const ox = pass === 0 ? player.x : this.centre.x;
        const oz = pass === 0 ? player.y : this.centre.y; // (player: a Vector2 of x, z)
        const a = rand() * Math.PI * 2;
        const d = pass === 0 ? 30 + rand() * 110 : 40 + rand() * 150;
        const x = ox + Math.cos(a) * d, z = oz + Math.sin(a) * d;
        if (Math.abs(x) > 1250 || Math.abs(z) > 1300) continue;
        if (!sp.home(x, z, rawGroundAt(x, z))) continue;
        const score = (canopyAt ? canopyAt(x, z) : 0) + d / 400;
        if (score < best) { best = score; bx = x; bz = z; }
      }
    }
    if (best === Infinity) return;
    this.centre.set(bx, bz);
    this.radius = sp.radius[0] + rand() * (sp.radius[1] - sp.radius[0]);
    this.altBase = sp.alt[0] + rand() * (sp.alt[1] - sp.alt[0]);
    if (rand() < 0.3) this.dir = -this.dir;
  }

  update(dt, t, player, canopyAt) {
    const sp = this.sp;
    this.replanIn -= dt;
    if (this.replanIn <= 0) this.replan(player, canopyAt);
    if (this.leader) {
      // the pair: the same thermal, a little wider and behind
      this.centre.copy(this.leader.centre);
      this.radius = this.leader.radius * 1.08 + 4;
      this.dir = this.leader.dir;
      this.altBase = this.leader.altBase + 3;
    }
    // the thermal drifts downwind
    this.centre.x += 0.35 * dt;
    this.centre.y += 0.2 * dt;

    // steer: along the circle, pulled onto it (from far away that's straight toward it)
    const dx = this.pos.x - this.centre.x, dz = this.pos.z - this.centre.y;
    const dist = Math.hypot(dx, dz) + 1e-6;
    const rx = dx / dist, rz = dz / dist;
    const tx = -rz * this.dir, tz = rx * this.dir;
    const k = Math.max(-1, Math.min(2.5, (dist - this.radius) / this.radius * 1.6));
    const wx = tx - rx * k, wz = tz - rz * k;
    const want = Math.atan2(wz, wx);
    let diff = want - this.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    // (a slow wander so the circles aren't perfect)
    const wander = 0.06 * Math.sin(t * 0.21 + this.seed) + 0.04 * Math.sin(t * 0.53 + this.seed * 2.1);
    const maxRate = this.speed / (sp.radius[0] * 0.7);
    const target = Math.max(-maxRate, Math.min(maxRate, diff * 0.9 + wander));
    this.yawRate += (target - this.yawRate) * Math.min(1, dt * 1.2);
    this.heading += this.yawRate * dt;
    // the lateral acceleration of the turn, for the bank (a coordinated turn: lift along "up")
    this.latA = this.speed * this.yawRate;

    // height: the thermal's base over the ground under it, a slow climb and sink, never too
    // low over the ground under the bird
    const gC = groundOrSea(this.centre.x, this.centre.y);
    const gB = groundOrSea(this.pos.x, this.pos.z);
    // (gulls skim the beach, but over the trees everyone keeps above the crowns)
    const clear = gB > 1 ? Math.max(sp.clear, 42 * (1 - sandAt(this.pos.x, this.pos.z))) : sp.clear;
    const alt = Math.max(gC + this.altBase + 10 * Math.sin(t * 0.045 + this.seed), gB + clear);
    const vyT = Math.max(-2.2, Math.min(1.6, (alt - this.pos.y) * 0.25));
    this.vy += (vyT - this.vy) * Math.min(1, dt * 0.8);
    const climbing = this.vy > 0.9;

    // flapping: bursts every so often, and while climbing hard or catching up a long way
    this.nextBurst -= dt;
    if (this.nextBurst <= 0 && this.flapsLeft <= 0) {
      this.flapsLeft = sp.flaps[0] + Math.floor(this.rand() * (sp.flaps[1] - sp.flaps[0] + 1));
      this.nextBurst = sp.burst[0] + this.rand() * (sp.burst[1] - sp.burst[0]);
    }
    const hurry = k > 2 && sp.flapHz > 3;
    const flapping = this.flapsLeft > 0 || climbing || hurry;
    const before = this.phase;
    this.phase += Math.PI * 2 * sp.flapHz * dt;
    if (this.flapsLeft > 0 && Math.floor(before / (Math.PI * 2)) !== Math.floor(this.phase / (Math.PI * 2))) this.flapsLeft--;
    this.amp += ((flapping ? sp.flapAmp : 0) - this.amp) * Math.min(1, dt * 5);

    const sp2 = this.speed * (1 + 0.08 * this.amp);
    this.pos.x += Math.cos(this.heading) * sp2 * dt;
    this.pos.z += Math.sin(this.heading) * sp2 * dt;
    this.pos.y += this.vy * dt;
  }

  matrix(out) {
    tmpF.set(Math.cos(this.heading), this.vy / this.speed * 0.8, Math.sin(this.heading)).normalize();
    // banked into the turn: lift = gravity + the turn's centripetal pull, toward increasing heading
    // (heading turns from +x toward +z) when latA > 0
    const lx = -Math.sin(this.heading), lz = Math.cos(this.heading);
    tmpUp.set(lx * this.latA, G, lz * this.latA).normalize();
    tmpX.crossVectors(tmpUp, tmpF).normalize();
    tmpY.crossVectors(tmpF, tmpX);
    tmpM.makeBasis(tmpX, tmpY, tmpF);
    tmpM.setPosition(this.pos);
    const s = this.scale;
    out.copy(tmpM).scale(tmpS.set(s, s, s));
    return out;
  }
}

export function buildBirds({ canopyAt = null } = {}) {
  const group = new THREE.Group();
  group.name = 'birds';
  const rand = mulberry32(SEED + 6161);
  const flocks = [];
  for (const [name, sp] of Object.entries(SPECIES)) {
    const geo = sp.geometry();
    const n = sp.count;
    const bird = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    bird.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aBird', bird);
    geo.setAttribute('aHalf', new THREE.InstancedBufferAttribute(new Float32Array(n).fill(sp.half), 1));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.6 });
    if (name === 'raven') mat.roughness = 0.55; // (a little gloss)
    patchFlap(mat);
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = `birds ${name}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // (they're spread over the sky: a few dozen tris each, cheaper not to test)
    group.add(mesh);
    const birds = [];
    const starts = START[name];
    for (let i = 0; i < n; i++) {
      const [cx, cz] = starts[i % starts.length];
      const leader = sp.pair && i % 2 === 1 ? birds[i - 1] : null;
      const b = new Bird(sp, rand, cx + (leader ? 0 : (rand() - 0.5) * 60), cz + (leader ? 0 : (rand() - 0.5) * 60), leader);
      if (leader) { b.pos.copy(leader.pos).add(new THREE.Vector3(-8, 3, 6)); b.heading = leader.heading; }
      birds.push(b);
    }
    flocks.push({ name, sp, mesh, birds, attr: bird });
  }

  const m = new THREE.Matrix4();
  const player = new THREE.Vector2();
  let placed = false;
  return {
    group,
    flocks,
    /** Fly them on (dt s), and hide them at night (they roost). */
    update(dt, t, camera, night) {
      group.visible = !night;
      if (night) return;
      player.set(camera.position.x, camera.position.z);
      if (!placed) {
        // at the start (wherever that is): thermals near the player, birds already on them
        placed = true;
        for (const f of flocks) for (const b of f.birds) {
          if (b.leader) continue;
          b.replan(player, canopyAt);
          const a = b.seed; // (0..100: any angle)
          b.pos.set(b.centre.x + Math.cos(a) * b.radius, groundOrSea(b.centre.x, b.centre.y) + b.altBase, b.centre.y + Math.sin(a) * b.radius);
          b.heading = a + b.dir * Math.PI / 2;
        }
        for (const f of flocks) for (const b of f.birds) {
          if (!b.leader) continue;
          b.pos.set(b.leader.pos.x - 8 * Math.cos(b.leader.heading), b.leader.pos.y + 3, b.leader.pos.z - 8 * Math.sin(b.leader.heading));
          b.heading = b.leader.heading;
        }
      }
      for (const f of flocks) {
        const a = f.attr.array;
        for (let i = 0; i < f.birds.length; i++) {
          const b = f.birds[i];
          b.update(dt, t, player, canopyAt);
          f.mesh.setMatrixAt(i, b.matrix(m));
          a[i * 4] = b.phase % (Math.PI * 2);
          a[i * 4 + 1] = b.amp;
          a[i * 4 + 2] = f.sp.dihedral;
          a[i * 4 + 3] = f.sp.wrist;
        }
        f.mesh.instanceMatrix.needsUpdate = true;
        f.attr.needsUpdate = true;
      }
    },
  };
}
