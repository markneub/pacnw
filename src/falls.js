import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
import { SEED } from './config.js';
import { rawGroundAt, mulberry32, groundColor, groundLayers, terrainMaterial, fallsTopAt, streams, setWalkModifier, groundAt } from './terrain.js';
import { LINE, FALLS, LIP, POOL_LEVEL, alcoveDepth, cliffShare, behind, RISE, floorLevel, fallsLocal, underCap, lineAt, sAt, passageAt } from './fallsshape.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { horizonAO } from './bake.js';
import { shared, patchSunlight, sunKey } from './materials.js';

/**
 * The waterfall (fallsshape.js has its shape): the cliff, the falling water, the spray.
 *
 * The cliff is one mesh laid over the terrain round the bowl's U, a grid of columns along the face
 * line (0.5 m apart) by a fixed profile in each: from below the alcove's floor up its back wall,
 * out along its ceiling to the lip of the overhang, up the face of the cap to the rim, then back
 * over the top until it dips under the terrain (which is the bowl's floor under all of it, and
 * climbs to the top out of sight behind the alcove's back wall). Where there's no alcove (the
 * arms) the alcove part of the profile folds up to nothing at the foot of the face; where there's
 * less cliff (lower down the arms) the face is lower and the top is a steep slope.
 *
 * Basalt: the face stands in columns ~1.1 m wide, each set out or back by its own draw, broken by
 * a few ledges; the ceiling hangs in blocks. Drawn with the terrain's material (the rock photo
 * on the steep parts, the ground's own colours and detail on the top), single-sided, facing out.
 */

const rng = mulberry32(SEED + 2207);
const noise3 = createNoise3D(rng);
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const C = (hex) => new THREE.Color(hex);
const BASALT = C(0x3e3c37);
const BASALT_DARK = C(0x2a2926);
const MOSS = C(0x4a6129);
const MOSS_LIGHT = C(0x6a7f34);

const NB = 6; // alcove back wall (from under the floor)
const NC = 9; // its ceiling, back to the lip
const NF = 44; // the face
const NT = 14; // the top, back to where it dips under the terrain
const NV = NB + NC + NF + NT;
const PHI_MAX = 62;

/** The profile of one column: [d, y, part] (part 0 alcove, 1 face, 2 top), from the alcove's foot up over the rim. */
function profile(p, out) {
  const s0 = sAt(p.x, p.z);
  const F = floorLevel(p.x, p.z);
  const D = alcoveDepth(s0);
  const a = smooth(0, 3, D);
  const at = (d) => [p.x + p.sx * d, p.z + p.sz * d];
  const [rx, rz] = at(0.3);
  const rim = Math.max(F + 0.8, fallsTopAt(rx, rz));
  // the alcove: a back wall ~5 m high, the ceiling rising out to the lip ~8.5 m up (thinner under a low cap)
  const room = Math.max(0, Math.min(1, (rim - F - 6) / 12));
  const Hb = F + 0.3 + 4.6 * a * room;
  const Hc = F + 0.5 + 8.0 * a * room;
  let k = 0;
  out[k++] = [D + 0.5, F - 0.8, 0];
  for (let i = 1; i < NB; i++) {
    const t = i / (NB - 1);
    out[k++] = [D + 0.1 - 0.7 * a * t * t, F + 0.15 + (Hb - F - 0.15) * t, 0];
  }
  for (let i = 0; i < NC; i++) {
    const t = (i + 1) / NC;
    const y = Hb + 0.4 * a + (Hc - Hb - 0.4 * a) * (1 - (1 - t) * (1 - t));
    out[k++] = [(D - 0.9) * a * (1 - t) + (0.15 * a - 0.0) * t, y, 0];
  }
  // the face, up from the lip to the rim (in columns: see below)
  const y0 = Math.min(Hc + 0.5 * a + 0.05, rim - 0.4);
  for (let i = 0; i < NF; i++) {
    const t = i / (NF - 1);
    out[k++] = [-0.1 * a * (1 - t), y0 + (rim - 0.25 - y0) * t, 1];
  }
  // over the rim and back across the top, until it dips under the terrain
  // (as far back as the terrain is hidden anywhere along it: sAt changes a little going back)
  const end = Math.max(behind(s0), behind(sAt(p.x + p.sx * 15, p.z + p.sz * 15))) + RISE + 2.5;
  for (let i = 0; i < NT; i++) {
    const t = i / (NT - 1);
    const d = 0.35 + (end - 0.35) * t * t * (0.6 + 0.4 * t) / 1.0;
    const [x, z] = at(d);
    const y = i === NT - 1 ? rawGroundAt(x, z) - 0.4 : Math.max(fallsTopAt(x, z), rawGroundAt(x, z)) + 0.03;
    out[k++] = [d, y, 2];
  }
  return { F, D, a };
}

export function buildCliff() {
  const cols = LINE.filter((p, i) => i % 2 === 0 && Math.abs(p.phi) <= PHI_MAX);
  const nc = cols.length;
  const pos = new Float32Array(nc * NV * 3);
  const col = new Float32Array(nc * NV * 3);
  const lay = new Float32Array(nc * NV * 4);
  const shade = new Float32Array(nc * NV);
  const hollow = new Float32Array(nc * NV);
  const prof = new Array(NV);
  const c = new THREE.Color();
  const tmp = new THREE.Color();
  const lw = [0, 0, 0, 0];
  for (let ci = 0; ci < nc; ci++) {
    const p = cols[ci];
    const { F, D, a } = profile(p, prof);
    // basalt columns ~1.1 m wide, each set out from the face by its own draw (sharper at the edges
    // with the 0.5 m spacing they are drawn at), and a ledge or two across them
    const cid = Math.floor((p.phi + 0.3 * Math.sin(p.phi * 0.37)) / 1.1);
    const out = 0.15 + 0.55 * hash(cid) + 0.25 * hash(cid * 3 + 1) * hash(cid * 7 + 2);
    const ledgeY = F + 14 + 6 * hash(Math.floor(p.phi / 9) + 40);
    const end = Math.min(1, (PHI_MAX - Math.abs(p.phi)) / 3); // (the last metres tuck under the ground)
    const k = cliffShare(sAt(p.x, p.z));
    for (let j = 0; j < NV; j++) {
      let [d, y, part] = prof[j];
      let x = p.x + p.sx * d;
      let z = p.z + p.sz * d;
      if (part !== 2) {
        // rough rock: blocky lumps on the ceiling, columns on the face, a ledge set back
        const n = noise3(x * 0.35, y * 0.35, z * 0.35) * 0.6 + noise3(x * 1.1, y * 1.1 + 5, z * 1.1) * 0.25;
        let push = n * (part === 0 ? 0.45 : 0.3);
        if (part === 1) {
          const ledge = smooth(ledgeY - 0.6, ledgeY, y) * (1 - smooth(ledgeY + 1.5, ledgeY + 3, y));
          const foot = 1 - smooth(F + 1, F + 4, y); // (columns stand on a broken plinth)
          push -= out * (1 - foot * 0.6) * k - ledge * 0.6 * k;
          // the columns' heads at the rim: a little lower or higher each
          if (j === NB + NC + NF - 1) y += (hash(cid * 5 + 3) - 0.5) * 0.5;
        }
        if (part === 0 && j > 0) {
          // blocks hanging from the ceiling: coarse steps by a cellular-ish draw
          const bk = hash(Math.floor(x / 1.7) * 13 + Math.floor(z / 1.7) * 7);
          if (j >= NB) y -= 0.35 * bk * a;
        }
        x -= p.sx * push;
        z -= p.sz * push;
      }
      if (end < 1) y = y * end + (rawGroundAt(x, z) - 1.0) * (1 - end);
      const v = ci * NV + j;
      pos.set([x, y, z], v * 3);
      // colour and shade
      const up = j > 0 ? prof[j][1] - prof[j - 1][1] : 1;
      if (part === 2) {
        const slope = j > NB + NC + NF + 1 ? 0.25 : 0.6;
        groundColor(x, y, z, slope, c);
        groundLayers(x, y, z, slope, lw);
        lay.set(lw, v * 4);
        shade[v] = horizonAO(x, z);
        hollow[v] = -2.4; // (terrain.js: not cut away over the trail; rockyslope.js: no outcrops)
      } else {
        // dark basalt, wet and darker near the falls; moss in patches, on ledges and over the lip
        const m = noise3(x * 0.12 + 3, y * 0.18, z * 0.12) * 0.5 + 0.5;
        c.copy(BASALT).lerp(BASALT_DARK, smooth(0.3, 0.8, noise3(x * 0.5, y * 0.08, z * 0.5) * 0.5 + 0.5));
        const wet = 1 - smooth(4, 14, Math.hypot(x - LIP.x, z - LIP.z));
        c.multiplyScalar(1 - 0.35 * wet);
        let moss = smooth(0.55, 0.72, m) * (part === 1 ? 0.9 : 0.5);
        moss = Math.max(moss, part === 1 ? smooth(ledgeY - 0.2, ledgeY + 0.3, y) * (1 - smooth(ledgeY + 0.8, ledgeY + 1.6, y)) * 0.9 : 0);
        if (part === 0 && j >= NB + NC - 2) moss = Math.max(moss, 0.8); // (the lip of the overhang)
        if (part === 1 && y < F + 2.5) moss = Math.max(moss, 0.7 * (1 - smooth(F + 1, F + 2.5, y))); // (its foot, in the damp)
        tmp.copy(MOSS).lerp(MOSS_LIGHT, hash(Math.floor(x * 2) + Math.floor(y * 2) * 7) * 0.5);
        c.lerp(tmp, moss * (1 - 0.6 * smooth(FALLS.floor + 30, FALLS.floor + 45, y)));
        lay.set([0, 1, 0, 0], v * 4);
        // (the overhang's own shade comes from the shade map: materials.js uFallsShade)
        shade[v] = (part === 0 ? 0.8 : 0.9) * (0.85 + 0.15 * horizonAO(x, z));
        hollow[v] = -3; // (rockyslope.js: the rock photo over these colours)
      }
      c.multiplyScalar(shade[v]);
      col.set([c.r, c.g, c.b], v * 3);
    }
  }
  const idx = [];
  for (let ci = 0; ci < nc - 1; ci++) {
    for (let j = 0; j < NV - 1; j++) {
      const a = ci * NV + j;
      const b = a + NV;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aLayers', new THREE.BufferAttribute(lay, 4));
  g.setAttribute('aShade', new THREE.BufferAttribute(shade, 1));
  g.setAttribute('aHollow', new THREE.BufferAttribute(hollow, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  // faces out of the rock: at the top of the middle column the normal points up
  const mid = Math.floor(nc / 2) * NV + NV - 4;
  if (g.getAttribute('normal').getY(mid) < 0) {
    for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  g.computeBoundingSphere();
  return g;
}

/** The alcove's ceiling over a point at φ, d behind the face (the profile's back wall top to its lip, roughly). */
function ceilingAt(phi, d) {
  const p = lineAt(phi);
  const F = floorLevel(p.x, p.z);
  const D = alcoveDepth(sAt(p.x, p.z));
  const a = smooth(0, 3, D);
  const rim = Math.max(F + 0.8, fallsTopAt(p.x + p.nx * 0.3, p.z + p.nz * 0.3));
  const room = Math.max(0, Math.min(1, (rim - F - 6) / 12));
  const t = Math.min(1, Math.max(0, d / Math.max(D, 0.1)));
  return F + 0.5 + 8.0 * a * room + (4.6 - 8.0 - 0.2) * a * room * t;
}

/**
 * materials.js uFallsShade: over the bowl, how much sky the overhang hides (most at the alcove's
 * back, some just in front of its lip) and the ceiling's height, so anything below it is shaded.
 */
function shadeMap() {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of LINE) {
    if (alcoveDepth(sAt(p.x, p.z)) <= 0) continue;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const x0 = Math.floor(minX - 16);
  const z0 = Math.floor(minZ - 16);
  const nx = Math.ceil(maxX + 16) - x0;
  const nz = Math.ceil(maxZ + 16) - z0;
  const data = new Uint16Array(nx * nz * 2);
  const toH = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i + 0.5;
      const z = z0 + j + 0.5;
      const f = fallsLocal(x, z);
      let occ = 0;
      let ceil = -1000;
      if (f) {
        const D = alcoveDepth(f.s);
        const a = smooth(0, 3, D);
        if (a > 0 && f.d > -4 && f.d < behind(f.s) + RISE) {
          occ = a * (f.d < 0 ? 0.3 * smooth(-4, 0, f.d) : 0.3 + 0.3 * smooth(0, D, f.d));
          ceil = ceilingAt(f.phi, Math.max(0, f.d));
        }
      }
      data[(j * nx + i) * 2] = toH(occ);
      data[(j * nx + i) * 2 + 1] = toH(ceil);
    }
  }
  const tex = new THREE.DataTexture(data, nx, nz, THREE.RGFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, rect: new THREE.Vector4(x0, z0, nx, nz) };
}

// ---- the falling water ------------------------------------------------------------------------

const G = 9.81;
const V0 = 2.2; // m/s out over the lip

/** Where the water goes over: the lip's middle, its level, the way out (unit, horizontal), and the creek's width there. */
function lipInfo() {
  const out = new THREE.Vector2(-LIP.nx, -LIP.nz).normalize();
  const c = streams().nearest(LIP.x + LIP.nx * 1.5, LIP.z + LIP.nz * 1.5);
  const width = c.seg ? c.half * 2 : 4;
  const y = fallsTopAt(LIP.x + LIP.nx * 0.6, LIP.z + LIP.nz * 0.6) + 0.32;
  const fall = y - POOL_LEVEL;
  return { x: LIP.x, z: LIP.z, y, out, side: new THREE.Vector2(-out.y, out.x), width, T: Math.sqrt((2 * (fall + 0.4)) / G) };
}

/**
 * A tileable streak texture: R long vertical strands (sums of waves with whole wave numbers per
 * tile, so it wraps; far more variation across than along), G rounder clumps of aerated water.
 */
function streakTexture(size = 256) {
  const r = mulberry32(SEED + 31);
  const waves = (n, kx, ky) => Array.from({ length: n }, () => {
    const fx = 1 + Math.floor(r() * kx);
    const fy = Math.floor(r() * ky);
    return [fx, fy * (r() < 0.5 ? -1 : 1), r() * Math.PI * 2, 1 / Math.pow(Math.hypot(fx, fy * 3) + 1, 0.8)];
  });
  const wr = waves(40, 36, 3);
  const wg = waves(30, 10, 10);
  const R = new Float32Array(size * size);
  const Gc = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      let a = 0;
      let b = 0;
      for (const [fx, fy, ph, amp] of wr) a += Math.cos(2 * Math.PI * (fx * u + fy * v) + ph) * amp;
      for (const [fx, fy, ph, amp] of wg) b += Math.cos(2 * Math.PI * (fx * u + fy * v) + ph) * amp;
      R[j * size + i] = a;
      Gc[j * size + i] = b;
    }
  }
  const norm = (A) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of A) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return (v) => (v - lo) / (hi - lo);
  };
  const nr = norm(R);
  const ng = norm(Gc);
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = Math.round(255 * nr(R[k]));
    data[k * 4 + 1] = Math.round(255 * ng(Gc[k]));
    data[k * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The curtain: a sheet falling from the lip on the free-fall parabola, spreading as it goes,
 * in two layers (the inner one a little behind and narrower), so the white water has depth.
 * uv = (across −1..1, seconds since it left the lip); aW = its width there.
 */
function curtainGeometry(lip, { back = 0, narrow = 1 } = {}) {
  const AC = 13;
  const DN = 56;
  const pos = [];
  const uvs = [];
  const ws = [];
  const idx = [];
  for (let i = 0; i < DN; i++) {
    const t = lip.T * Math.pow(i / (DN - 1), 0.62);
    const w = (lip.width * 0.95 + 1.2 * t) * narrow;
    for (let j = 0; j < AC; j++) {
      const u = (j / (AC - 1)) * 2 - 1;
      // the middle runs faster and bows out a little; the edges peel back
      const fwd = V0 * t * (1 + 0.12 * (1 - u * u)) - back - 0.25 * u * u * Math.min(1, t);
      const y = lip.y - 0.5 * G * t * t;
      pos.push(lip.x + lip.out.x * fwd + lip.side.x * u * w / 2, y, lip.z + lip.out.y * fwd + lip.side.y * u * w / 2);
      uvs.push(u, t);
      ws.push(w);
    }
    if (i > 0) for (let j = 0; j < AC - 1; j++) {
      const a = (i - 1) * AC + j;
      idx.push(a, a + AC, a + 1, a + 1, a + AC, a + AC + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aW', new THREE.Float32BufferAttribute(ws, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const U = { uFTime: { value: 0 }, uFStreak: { value: null }, uFT: { value: 3 } };

function curtainMaterial(phase, veil = false) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.45, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  mat.envMapIntensity = 0.5;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aW;\nvarying vec2 vFU;\nvarying float vFW;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFU = uv;\nvFW = aW;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uFTime;
        uniform float uFT;
        uniform sampler2D uFStreak;
        varying vec2 vFU;
        varying float vFW;
        float fDens;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float u = vFU.x;
          float tau = vFU.y;
          // the pattern moves with the water: at a fixed (across, seconds since the lip - time) it's the
          // same parcel, so it speeds up and stretches into streaks as it falls
          float tt = tau - uFTime + ${phase.toFixed(2)};
          vec2 st = vec2(u * vFW * 0.11 + ${(phase * 0.37).toFixed(2)}, tt * 0.42);
          float s1 = texture2D(uFStreak, st).r;
          float s2 = texture2D(uFStreak, st * vec2(2.1, 1.6) + vec2(0.31, 0.17)).g;
          float s3 = texture2D(uFStreak, st * vec2(4.3, 3.1) + vec2(0.71, 0.53)).r;
          fDens = s1 * 0.5 + s2 * 0.3 + s3 * 0.2;
          // glassy over the lip, white and aerated within half a second
          float aer = smoothstep(0.04, 0.55, tau);
          vec3 glass = vec3(0.16, 0.22, 0.2);
          vec3 white = vec3(0.86, 0.89, 0.9) * (0.72 + 0.38 * fDens);
          diffuseColor.rgb = mix(glass, white, aer * (0.6 + 0.4 * fDens));
          // ragged edges: strands peel off the sides, more as it falls
          float edge = 1.0 - abs(u);
          float fray = smoothstep(0.0, 0.18 + 0.25 * aer, edge - (0.25 * aer + 0.05) * (s2 - 0.45));
          float a = mix(0.45, 0.95, smoothstep(0.25, 0.75, fDens)) * fray;
          a = mix(0.8 * fray, a, aer);
          ${veil ? `// the veil: thin spray blown off the sheet, thickening as it falls, in drifting streaks
          a = fray * smoothstep(0.3, 1.0, fDens + 0.35 * tau / uFT) * 0.35 * smoothstep(0.3, 1.5, tau);` : ''}
          // it breaks up into spray toward the pool
          a *= 1.0 - smoothstep(uFT - 0.35, uFT, tau + 0.15 * (s3 - 0.5));
          diffuseColor.a *= a;
          if (diffuseColor.a < 0.01) discard;
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // white water lets light through: the side away from the light glows too
        #if NUM_HEMI_LIGHTS > 0
          for (int i = 0; i < NUM_HEMI_LIGHTS; i++) reflectedLight.indirectDiffuse += BRDF_Lambert(diffuseColor.rgb) * getHemisphereLightIrradiance(hemisphereLights[i], -geometryNormal) * 0.55;
        #endif
        #if NUM_DIR_LIGHTS > 0
          reflectedLight.directDiffuse += BRDF_Lambert(diffuseColor.rgb) * directionalLights[0].color * max(0.0, dot(-geometryNormal, directionalLights[0].direction)) * 0.45;
        #endif`);
  };
  mat.customProgramCacheKey = () => `falls-curtain-${phase}-${veil}`;
  return mat;
}

// ---- spray at the foot ------------------------------------------------------------------------

/** Spray and mist boiling up where the water hits the pool: soft puffs, animated on the GPU. */
function buildSpray(lip, count = 48) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) seeds[i] = i / count + (((i * 7919) % 97) / 97) * (0.5 / count);
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geo.instanceCount = count;
  const fwd = V0 * lip.T;
  const foot = new THREE.Vector3(lip.x + lip.out.x * fwd, POOL_LEVEL, lip.z + lip.out.y * fwd);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 }, uFoot: { value: foot }, uOut: { value: new THREE.Vector2(lip.out.x, lip.out.y) },
        uSide: { value: new THREE.Vector2(lip.side.x, lip.side.y) }, uWidth: { value: lip.width + 2.5 }, uLight: { value: new THREE.Color(1, 1, 1) },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      attribute float aSeed;
      uniform float uTime;
      uniform vec3 uFoot;
      uniform vec2 uOut;
      uniform vec2 uSide;
      uniform float uWidth;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vSeed;
      const float LIFE = 5.0;
      void main() {
        float age = fract(uTime / LIFE + aSeed) * LIFE;
        float s = aSeed * 61.3;
        float h1 = fract(s * 0.137);
        float h2 = fract(s * 0.731);
        // thrown up and out of the plunge, billowing and settling as it drifts away from the falls
        vec3 p = uFoot;
        p.xz += uSide * (h1 - 0.5) * uWidth;
        float drift = (0.5 + 2.5 * h2) * (1.0 - exp(-age * 0.8)) + age * 0.35;
        p.xz += uOut * drift;
        p.y += (1.5 + 4.5 * h2) * (1.0 - exp(-age * 1.1)) - 0.05 * age * age;
        p.xz += vec2(sin(age * 0.9 + s), cos(age * 0.7 + s * 1.3)) * 0.25 * age;
        float size = 2.0 + age * 1.5 + 1.5 * h1;
        float rot = s + age * (h2 - 0.5) * 0.6;
        vec2 q = position.xy * size;
        q = vec2(q.x * cos(rot) - q.y * sin(rot), q.x * sin(rot) + q.y * cos(rot));
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 wp = p + right * q.x + up * q.y;
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vUv = uv;
        vSeed = s;
        // (fades in and out; and up close, so a puff never shows its edge in your face)
        vAlpha = smoothstep(0.0, 0.6, age) * (1.0 - smoothstep(LIFE * 0.35, LIFE, age)) * smoothstep(1.5, 5.0, -mvPosition.z);
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <fog_pars_fragment>
      uniform vec3 uLight;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vSeed;
      float sHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float sNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec2 c = vUv - 0.5;
        float r = length(c) * 2.0;
        float n = sNoise(vUv * 3.0 + vSeed) * 0.6 + sNoise(vUv * 7.0 - vSeed) * 0.4;
        float a = smoothstep(1.0, 0.0, r + (n - 0.5) * 0.8) * vAlpha * 0.3;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uLight * (0.85 + 0.15 * c.y), a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  mesh.name = 'falls spray';
  mesh.position.copy(foot);
  return mesh;
}

// ---- foam on the pool -------------------------------------------------------------------------

/** White water spreading out across the plunge pool from where the falls hit it. */
function buildPoolFoam(lip) {
  const fwd = V0 * lip.T;
  const cx = lip.x + lip.out.x * fwd;
  const cz = lip.z + lip.out.y * fwd;
  const R = 9;
  const g = new THREE.CircleGeometry(R, 48, 0, Math.PI * 2);
  g.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, transparent: true, depthWrite: false });
  const fu = { uFTime: U.uFTime, uFStreak: U.uFStreak, uFC: { value: new THREE.Vector2(cx, cz) }, uFOut: { value: new THREE.Vector2(lip.out.x, lip.out.y) }, uFHalf: { value: lip.width / 2 + 1 } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, fu);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFP = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uFTime;
        uniform sampler2D uFStreak;
        uniform vec2 uFC;
        uniform vec2 uFOut;
        uniform float uFHalf;
        varying vec2 vFP;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // distance from the line where the curtain lands (it's a few metres wide), and the angle round it
          vec2 d = vFP - uFC;
          vec2 side = vec2(-uFOut.y, uFOut.x);
          float along = dot(d, side);
          float r = length(vec2(max(abs(along) - uFHalf, 0.0), dot(d, uFOut)));
          float ang = atan(d.y, d.x);
          // boiling foam pushed outward: the pattern runs out from the plunge, thinning as it goes
          vec2 st = vec2(ang * 1.3, sqrt(r) * 0.9 - uFTime * 0.35);
          float f = texture2D(uFStreak, st).g * 0.6 + texture2D(uFStreak, st * 2.3 + 0.4).r * 0.4;
          float cover = 1.0 - smoothstep(0.0, 4.0, r);
          float a = smoothstep(1.05 - 0.75 * cover, 1.3 - 0.75 * cover, f + 0.1 * cover) * 0.65;
          diffuseColor.rgb = vec3(0.8, 0.83, 0.83) * (0.8 + 0.2 * f);
          diffuseColor.a *= a;
          if (diffuseColor.a < 0.01) discard;
        }`);
  };
  mat.customProgramCacheKey = () => 'falls-foam';
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(cx, POOL_LEVEL + 0.03, cz);
  mesh.renderOrder = 2;
  mesh.name = 'falls foam';
  return mesh;
}

// ---- the fence along the way behind the falls ---------------------------------------------------

const FENCE_OFF = -1.75; // m from the passage's line, on the bowl's side
/**
 * A rail fence of peeled logs on the bowl's side of the path through the alcove (as at Silver
 * Falls): posts every ~2.4 m, two rails, laid along the passage where it's under the overhang
 * and a little beyond. Returns the mesh and its segments (colliders).
 */
function buildFence() {
  const parts = [];
  const segs = [];
  const post = new THREE.CylinderGeometry(0.1, 0.11, 1.0, 7, 1);
  const top = new THREE.SphereGeometry(0.1, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  const rail = new THREE.CylinderGeometry(0.065, 0.065, 1, 6, 1);
  rail.rotateZ(Math.PI / 2);
  const col = (g, c) => {
    const n = g.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const wood = new THREE.Color(0x4a3a2c);
  const c = new THREE.Color();
  let prev = null;
  let k = 0;
  for (let phi = 36; phi >= -36; phi -= 2.4) {
    const q = passageAt(phi, FENCE_OFF);
    const y = groundAt(q.x, q.z);
    const cur = new THREE.Vector3(q.x, y, q.z);
    const lean = (hash(k * 3.1) - 0.5) * 0.06;
    c.copy(wood).multiplyScalar(0.8 + 0.35 * hash(k * 1.7));
    const pg = post.clone();
    pg.rotateZ(lean);
    pg.translate(q.x, y + 0.42, q.z);
    parts.push(col(pg, c));
    const tg = top.clone();
    tg.translate(q.x, y + 0.92, q.z);
    parts.push(col(tg, c));
    if (prev) {
      for (const h of [0.45, 0.85]) {
        const a = prev.clone().setY(prev.y + h);
        const b = cur.clone().setY(cur.y + h);
        const len = a.distanceTo(b);
        const rg = rail.clone();
        rg.scale(len + 0.1, 1, 1);
        const m = new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(0, 1, 0));
        rg.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
        rg.applyMatrix4(m);
        rg.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        parts.push(col(rg, c.clone().multiplyScalar(0.9 + 0.2 * hash(k + h))));
      }
      segs.push([prev.x, prev.z, cur.x, cur.z]);
    }
    prev = cur;
    k++;
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  mat.onBeforeCompile = (shader) => patchSunlight(shader);
  mat.customProgramCacheKey = () => `falls-fence|${sunKey()}`;
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'falls fence';
  return { mesh, segs };
}

export function buildFalls() {
  const group = new THREE.Group();
  group.name = 'falls';
  const cliff = new THREE.Mesh(buildCliff(), terrainMaterial);
  cliff.name = 'falls cliff';
  group.add(cliff);
  const shade = shadeMap();
  shared.uFallsShade.value = shade.tex;
  shared.uFallsRect.value.copy(shade.rect);
  const lip = lipInfo();
  U.uFStreak.value = streakTexture();
  U.uFT.value = lip.T;
  const outer = new THREE.Mesh(curtainGeometry(lip), curtainMaterial(0));
  const inner = new THREE.Mesh(curtainGeometry(lip, { back: 0.35, narrow: 0.8 }), curtainMaterial(0.53));
  const veil = new THREE.Mesh(curtainGeometry(lip, { back: -0.45, narrow: 1.45 }), curtainMaterial(0.21, true));
  outer.name = inner.name = veil.name = 'falls curtain';
  veil.renderOrder = 12;
  outer.renderOrder = 11;
  inner.renderOrder = 10;
  const spray = buildSpray(lip);
  group.add(outer, inner, veil, spray, buildPoolFoam(lip));
  const fence = buildFence();
  group.add(fence.mesh);

  // ---- the player: on the alcove's floor (the terrain), or up on the cliff top (its own surface)
  const state = { up: false };
  setWalkModifier((x, z, g) => {
    if (!underCap(x, z)) return g;
    const f = fallsLocal(x, z);
    return state.up || f.d > alcoveDepth(f.s) - 0.3 ? Math.max(g, fallsTopAt(x, z)) : g;
  });
  /** Kept out of the rock below (the alcove's back wall, the arms' faces); the fence. */
  function collide(pos, r) {
    // the fence (from either side)
    for (const [ax, az, bx, bz] of fence.segs) {
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((pos.x - ax) * dx + (pos.z - az) * dz) / (dx * dx + dz * dz)));
      const ox = pos.x - ax - dx * t;
      const oz = pos.z - az - dz * t;
      const o = Math.hypot(ox, oz);
      const lim = r + 0.12;
      if (o < lim && o > 1e-6) {
        pos.x += (ox / o) * (lim - o);
        pos.z += (oz / o) * (lim - o);
      }
    }
    // the rock: from below, out of the alcove's back wall and the faces, where there's a real cliff
    // (over 2.5 m: lower lips you walk up onto, like any steep ground). Nothing up top: you can step off
    // the edge (a collider keeping you back from it stood across the foot of the arms' slopes, where the
    // cliff fades out: an invisible wall, the user)
    if (state.up) return;
    const f = fallsLocal(pos.x, pos.z);
    if (!f || cliffShare(f.s) < 0.02) return;
    // (copied: fallsLocal returns one shared object, and fallsTopAt below calls it for the face point. Read
    // after that, the face's distance stood in for the player's: a push of ~1 m anywhere near the arms, the
    // user's invisible wall)
    const { d, s: fs, phi } = f;
    const wall = alcoveDepth(fs) - 0.1 - r;
    if (d <= wall || d > behind(fs) + RISE + 3) return;
    const p = lineAt(phi);
    const step = fallsTopAt(p.x + p.nx * 0.5, p.z + p.nz * 0.5) - floorLevel(pos.x, pos.z); // (how much cliff there is here)
    if (step < 2.5) return;
    pos.x += p.nx * (wall - d);
    pos.z += p.nz * (wall - d);
  }
  /** Up on the cliff top or down in the bowl (from where the player stands). */
  function track(player) {
    if (!fallsLocal(player.pos.x, player.pos.z)) {
      state.up = false;
      return;
    }
    state.up = player.pos.y > floorLevel(player.pos.x, player.pos.z) + 3;
  }

  const fallFrom = new THREE.Vector3(lip.x, lip.y, lip.z);
  const fallTo = new THREE.Vector3(lip.x + lip.out.x * V0 * lip.T * 0.8, POOL_LEVEL, lip.z + lip.out.y * V0 * lip.T * 0.8);
  const seg = new THREE.Line3(fallFrom, fallTo);
  const near = new THREE.Vector3();
  function update(dt, t, weather, camera) {
    U.uFTime.value = t;
    // for the sound: how far the water is, and whether you're under the overhang
    seg.closestPointToPoint(camera.position, true, near);
    weather.falls.dist = Math.max(0, near.distanceTo(camera.position) - lip.width / 2);
    const f = fallsLocal(camera.position.x, camera.position.z);
    weather.falls.under = f && f.d > 0 && f.d < alcoveDepth(f.s) && camera.position.y < floorLevel(camera.position.x, camera.position.z) + 6 ? 1 : 0;
    spray.material.uniforms.uTime.value = t;
    // the spray takes the light of the moment: the sky's and a little of the sun's
    const l = spray.material.uniforms.uLight.value;
    l.copy(weather.hemi.color).multiplyScalar(weather.hemi.intensity * 0.9);
    l.r += weather.sun.color.r * weather.sun.intensity * 0.25;
    l.g += weather.sun.color.g * weather.sun.intensity * 0.25;
    l.b += weather.sun.color.b * weather.sun.intensity * 0.25;
  }
  return { group, cliff, lip, update, collide, track, state };
}

/**
 * Where the scatter keeps clear (main.js's exclude): the pool and the curtain's foot, the rock
 * and the cliff top over the overhang (the terrain under it is the bowl's floor: anything placed
 * there would stand inside the cliff), trees too near the walls (their crowns in the rock). Low
 * plants and stones may stand on the alcove's floor.
 */
export function fallsBlocked(x, z, margin, tree) {
  const f = fallsLocal(x, z);
  if (!f) return false;
  const p = FALLS.pool;
  if (Math.hypot((x - p.x) / p.rl, (z - p.z) / p.ra) < 1.25 + margin / p.rl) return true;
  const k = cliffShare(f.s);
  if (k < 0.02) return false;
  const D = alcoveDepth(f.s);
  if (f.d > -margin && f.d < behind(f.s) + RISE + margin) return tree || f.d > D - 0.8 - margin;
  return !!tree && f.d > -5 * k - margin;
}
