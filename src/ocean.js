import * as THREE from 'three';
import { WORLD_SIZE } from './config.js';
import { coastZ, rawGroundAt, SEA_LEVEL } from './terrain.js';
import { shared, GLITTER_GLSL, patchGlitter } from './materials.js';
import { waveNormals, foamTexture } from './streamwater.js';
import { loadTick } from './loadprogress.js';

/**
 * The ocean along the south edge of the map, with surf breaking on the beach.
 *
 * Swell: one long-period train (PERIOD s) arriving from a little west of south. Its phase comes
 * from a travel-time field baked at load (`bakeCoast`): marching each column in from the open
 * sea, the swell slows as the water shoals (linear dispersion, ω² = g k tanh(k d)), so the
 * crests bunch up and swing round to follow the shore, as real swell refracts. Each crest has
 * its own height (`oWaveM`: hashed, with slow sets of bigger waves). On its way in a wave
 * shoals (Green's law, amplitude ∝ d^-1/4), peaks and leans forward, and breaks where its
 * height passes 0.78 of the depth; from there it's a bore (a sawtooth with a white face) whose
 * height is held to the depth. At the shoreline each bore runs up the beach as a thin sheet of
 * swash (a ballistic parabola in time, up to its run-up height) and drains back, leaving the
 * sand glossy for a few seconds.
 *
 * Mesh: a polar grid around the camera (fine near, coarse far, out to the far plane), moved
 * with it, its vertices raised to the water surface (or just under the ground where it's dry).
 * Everything that has to be sharp (the waterline, the swash's edge, the foam) is worked out
 * again per pixel from the ground under it (the terrain grid, as groundAt) and the interpolated
 * travel time, and the shading normal comes from screen-space derivatives of that height.
 *
 * Shading: transparent, depth-dependent water (turbid green-grey in the surf, darker offshore),
 * light through the face of a steepening wave, lacy foam (the streams' cellular foam texture) on
 * bore faces, behind them and along the swash edge, small wind chop (the streams' wave
 * normals), sun glitter, and a reflection of the sky (the sky dome's own colours: overcast or a
 * sun break) with Fresnel. Water and reflection are blended as one layer:
 * out = R·F + (1−F)(W·a + dst·(1−a)).
 */

const PERIOD = 10; // s
const OMEGA = (2 * Math.PI) / PERIOD;
const G = 9.81;
const K0 = (OMEGA * OMEGA) / G; // deep-water wavenumber
const ANGLE = 0.22; // rad: the swell's heading off shore-normal, out at sea
const KX = K0 * Math.sin(ANGLE); // conserved along the shore (Snell's law)
const STEP_X = 4;
const STEP_Z = 2;
const MASK_S = 75; // m inland of the shoreline: the ocean is never drawn beyond (the dune toe)

/** Wavenumber for depth d (Eckart's approximation to the dispersion relation, within ~5%). */
function wavenumber(d) {
  return K0 / Math.sqrt(Math.tanh(K0 * Math.max(d, 0.3)));
}

/**
 * Travel-time field (RGBA32F): R = seconds for the swell to get here (along z) from the south
 * edge, G = the same at this column's shoreline (for the swash), B = 1 where the sea may be drawn.
 */
async function bakeCoast([p0, p1]) {
  const half = WORLD_SIZE / 2;
  let zMin = Infinity;
  for (let x = -half; x <= half; x += STEP_X) zMin = Math.min(zMin, coastZ(x) - MASK_S - 40);
  zMin = Math.floor(zMin / STEP_Z) * STEP_Z;
  const nx = Math.round(WORLD_SIZE / STEP_X) + 1;
  const nz = Math.round((half - zMin) / STEP_Z) + 1;
  const data = new Float32Array(nx * nz * 4);
  for (let ix = 0; ix < nx; ix++) {
    const x = -half + ix * STEP_X;
    const coast = coastZ(x);
    let t = 0;
    let shore = -1;
    let wet = true;
    for (let iz = nz - 1; iz >= 0; iz--) {
      const z = zMin + iz * STEP_Z;
      const d = SEA_LEVEL - rawGroundAt(x, z);
      if (iz < nz - 1) {
        const k = wavenumber(d);
        t += (Math.sqrt(Math.max(k * k - KX * KX, 0.25 * k * k)) / OMEGA) * STEP_Z;
      }
      if (d <= 0 && wet) shore = t; // (the last way onto land: behind a sea stack, the beach)
      wet = d > 0;
      const o = (iz * nx + ix) * 4;
      data[o] = t;
      data[o + 2] = 1 - THREE.MathUtils.smoothstep(coast - z, MASK_S - 15, MASK_S + 15);
    }
    if (shore < 0) shore = t;
    for (let iz = 0; iz < nz; iz++) data[(iz * nx + ix) * 4 + 1] = shore;
    if (ix % 32 === 0) await loadTick(p0 + ((p1 - p0) * ix) / nx);
  }
  const tex = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  return { tex, rect: new THREE.Vector4(-half, zMin, STEP_X, STEP_Z), zMax: half };
}

/** Rings of vertices around the origin: 0.35 m apart near the centre, ~4% of the radius beyond. */
function polarGrid(radius, segments = 160) {
  const rings = [0];
  while (rings[rings.length - 1] < radius) {
    const r = rings[rings.length - 1];
    rings.push(r + Math.max(0.35, r * 0.04));
  }
  const pos = [0, 0, 0];
  for (let i = 1; i < rings.length; i++) {
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * rings[i], 0, Math.sin(a) * rings[i]);
    }
  }
  const index = [];
  for (let j = 0; j < segments; j++) index.push(0, 1 + ((j + 1) % segments), 1 + j);
  for (let i = 1; i < rings.length - 1; i++) {
    const a = 1 + (i - 1) * segments;
    const b = 1 + i * segments;
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      index.push(a + j, a + j1, b + j, a + j1, b + j1, b + j); // facing up
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(index);
  return geo;
}

// The surf model, shared by the vertex (mesh height) and fragment (coverage, foam, normal) shaders.
const SURF_GLSL = /* glsl */ `
  uniform float uOTime;
  uniform float uOSwell; // deep-water amplitude, m
  uniform highp sampler2D uOCoast;
  uniform vec4 uOCoastRect; // min x, min z, step x, step z
  uniform float uODeep; // s/m: the swell's arrival time gradient south of the baked field
  uniform highp sampler2D uOGround;
  uniform vec4 uOGrid; // min x, min z, step, n
  #define O_PERIOD ${PERIOD.toFixed(1)}
  #define O_SEA ${SEA_LEVEL.toFixed(2)}
  float oHash(float n) { vec2 p = fract(vec2(n) * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.y); }
  // the height of wave n relative to the mean: random, in slow sets of bigger waves
  float oWaveM(float n) { return clamp(0.45 + 0.5 * oHash(n) + 0.3 * sin(n * 0.71), 0.3, 1.35); }
  float oGroundAt(vec2 xz) {
    vec2 g = clamp((xz - uOGrid.xy) / uOGrid.z, vec2(0.0), vec2(uOGrid.w - 1.0001));
    ivec2 i = ivec2(floor(g));
    vec2 f = g - vec2(i);
    float ha = texelFetch(uOGround, i, 0).r;
    float hb = texelFetch(uOGround, i + ivec2(0, 1), 0).r;
    float hc = texelFetch(uOGround, i + ivec2(1, 1), 0).r;
    float hd = texelFetch(uOGround, i + ivec2(1, 0), 0).r;
    return f.x + f.y <= 1.0 ? ha + (hd - ha) * f.x + (hb - ha) * f.y
      : hc + (hb - hc) * (1.0 - f.x) + (hd - hc) * (1.0 - f.y);
  }
  // travel time (x), at the shoreline (y), may-draw mask (z); bilinear by hand (float texture)
  vec3 oCoast(vec2 xz) {
    vec2 sz = vec2(textureSize(uOCoast, 0));
    vec2 g = clamp((xz - uOCoastRect.xy) / uOCoastRect.zw, vec2(0.0), sz - 1.0001);
    ivec2 i = ivec2(floor(g));
    vec2 f = g - vec2(i);
    vec4 v = mix(mix(texelFetch(uOCoast, i, 0), texelFetch(uOCoast, i + ivec2(1, 0), 0), f.x),
                 mix(texelFetch(uOCoast, i + ivec2(0, 1), 0), texelFetch(uOCoast, i + ivec2(1, 1), 0), f.x), f.y);
    float over = xz.y - (uOCoastRect.y + (sz.y - 1.0) * uOCoastRect.w);
    if (over > 0.0) v.x -= over * uODeep; // open sea beyond the field: earlier with distance
    return v.xyz;
  }
  // The sea surface over still depth d at swell cycle cyc (crest n passes at cyc = n).
  // Out: foam (0..1 white water), lit (light through a steep wave face), brk (broken: 0..1).
  float oSea(float d, float cyc, out float foam, out float lit, out float brk) {
    float n = floor(cyc);
    float u = cyc - n; // 0: crest n just passed .. 1: crest n+1 arriving
    float m = mix(oWaveM(n), oWaveM(n + 1.0), smoothstep(0.3, 0.8, u));
    float dd = max(d, 0.02);
    float A = uOSwell * m * clamp(pow(20.0 / max(dd, 0.3), 0.25), 1.0, 2.0);
    float db = pow(2.0 * uOSwell * m * 2.115 / 0.78, 0.8); // where it breaks: H = 0.78 d
    brk = smoothstep(db * 1.02, db * 0.78, dd);
    float sh = 1.0 - smoothstep(db, db * 3.5, dd); // shoaling: peaking, leaning forward
    // unbroken: a peaked crest with flat troughs, its front face steeper than its back
    float uu = pow(u, 1.0 + 1.4 * sh);
    float k = 1.0 + 2.5 * sh;
    float pk = pow(0.5 + 0.5 * cos(6.2832 * uu), k);
    float eU = 2.0 * A * (pk - 0.5 * pow(k, -0.42));
    // broken: a bore, a sawtooth with a steep white face, its height held to the depth
    float Hb = min(2.0 * A, 0.78 * dd * 0.85);
    float bf = 0.9;
    float saw = u < bf ? 1.0 - u / bf : smoothstep(0.0, 1.0, (u - bf) / (1.0 - bf));
    float eB = Hb * (saw - 0.45);
    // foam: the bore's face and the roller just behind it, lace fading over the wave behind,
    // and the crest whitening as it pitches over at the break
    float face = exp(-(1.0 - u) / 0.06) + exp(-u / 0.22);
    float vigour = smoothstep(0.05, 0.4, Hb);
    foam = brk * (face * (0.6 + 0.4 * vigour) + 0.75 * pow(1.0 - u, 1.2) * vigour);
    foam += smoothstep(db * 1.25, db * 0.98, dd) * (1.0 - brk) * smoothstep(0.8, 0.98, uu) * 0.9;
    lit = (1.0 - brk) * sh * smoothstep(0.55, 0.97, uu);
    return mix(eU, eB, brk);
  }
  // Swash at the beach: the sheet's leading edge rises up the sand and falls back with each bore.
  // Returns the run-up elevation above sea level now; age = s since this wave reached the shore
  // (fraction of its run), rmax = its run-up height.
  float oSwash(float cycShore, out float run, out float rmax) {
    float n = floor(cycShore);
    float u = cycShore - n;
    rmax = (0.2 + 0.55 * oWaveM(n)) * uOSwell / 0.55;
    run = clamp(u / 0.92, 0.0, 1.0);
    float v = pow(run, 0.8); // quick uprush, slower backwash
    return rmax * 4.0 * v * (1.0 - v) - 0.06;
  }
`;

/**
 * Build the ocean. `skyUniforms` are the sky dome's (weather.js), so the reflection follows the
 * weather. Call update(camera) every frame. `progress`: the share of the loading step it reports through.
 */
export async function buildOcean(skyUniforms, { lowPower, progress = [0, 1] }) {
  const coast = await bakeCoast(progress);
  const waves = waveNormals(256, 23);
  const foam = foamTexture(256, 5);
  const uniforms = {
    uOTime: shared.uTime,
    uOSwell: { value: 0.7 },
    uOCoast: { value: coast.tex },
    uOCoastRect: { value: coast.rect },
    uODeep: { value: (K0 * Math.cos(ANGLE)) / OMEGA },
    uOGround: shared.uGroundH,
    uOGrid: shared.uGroundGrid,
    uOKx: { value: KX / OMEGA },
    uOCentre: { value: new THREE.Vector2() },
    uOWaves: { value: waves },
    uOFoam: { value: foam },
    uOHorizon: skyUniforms.uHorizon,
    uOZenith: skyUniforms.uZenith,
    uOSun: shared.uSun,
    uONight: shared.uNight,
    uOWet: shared.uWet,
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0x10201f,
    roughness: 0.07,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchGlitter(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        ${SURF_GLSL}
        uniform float uOKx;
        uniform vec2 uOCentre;
        varying vec3 vOPos;
        varying vec2 vOT;
        varying float vOMask;`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position.x + uOCentre.x, 0.0, position.z + uOCentre.y);
        {
          vec3 cst = oCoast(transformed.xz);
          vOT = cst.xy + transformed.x * uOKx;
          vOMask = cst.z;
          float g = oGroundAt(transformed.xz);
          float d = O_SEA - g;
          float f, l, b, run, rmax;
          float y = g - 0.3; // dry: just under the ground (hidden)
          if (cst.z > 0.0) {
            if (d > 0.0) y = O_SEA + oSea(d, (uOTime - vOT.x) / O_PERIOD, f, l, b);
            // the swash and the wet sand it leaves: drawn just over the ground up to the highest run-up
            if (g - O_SEA < 1.1) y = max(y, g + 0.04 + 0.3 * max(0.0, oSwash((uOTime - vOT.y) / O_PERIOD, run, rmax) - (g - O_SEA)));
          }
          transformed.y = y;
          vOPos = transformed;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${SURF_GLSL}
        ${GLITTER_GLSL}
        uniform sampler2D uOWaves;
        uniform sampler2D uOFoam;
        uniform vec3 uOHorizon;
        uniform vec3 uOZenith;
        uniform float uOSun;
        uniform float uONight;
        uniform float uOWet;
        varying vec3 vOPos;
        varying vec2 vOT;
        varying float vOMask;
        float oF = 0.0;      // Fresnel weight of the reflection
        float oFoam = 0.0;
        float oFilm = 0.0;   // 1: only a wet film on the sand, no water
        vec3 oP;             // this pixel's point on the water
        // the sky dome's colour in direction e (elevation sin), as atmosphere.js draws it, without clouds
        vec3 oSky(float e) {
          vec3 over = mix(uOHorizon, uOZenith, smoothstep(0.02, 0.55, e));
          float up = clamp(e, 0.0, 1.0);
          vec3 blue = mix(vec3(0.2, 0.28, 0.38), vec3(0.035, 0.1, 0.27), pow(smoothstep(0.0, 0.85, up), 0.6));
          blue = mix(blue, uOHorizon * 1.05, 1.0 - smoothstep(0.0, 0.16, up));
          vec3 c = mix(over, blue, uOSun);
          // a clear night: the sky's deep blue (the moon's glitter path is the key light's glitter)
          if (uONight > 0.5) c = mix(uOHorizon * 1.1, vec3(0.006, 0.012, 0.03), smoothstep(0.0, 0.6, up));
          return e < 0.0 ? uOHorizon * 0.55 : c;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          if (vOMask < 0.01) discard;
          vec2 xz = vOPos.xz;
          float g = oGroundAt(xz);
          float d = O_SEA - g;
          float cyc = (uOTime - vOT.x) / O_PERIOD;
          float foam = 0.0, lit = 0.0, brk = 0.0;
          float y = -1e3;
          if (d > 0.0) y = O_SEA + oSea(d, cyc, foam, lit, brk);
          // swash: a thin sheet up to the run-up's edge, ragged with noise
          float run, rmax;
          float e = oSwash((uOTime - vOT.y) / O_PERIOD, run, rmax);
          vec4 fq = texture2D(uOFoam, xz * 0.11 + vec2(0.0, uOTime * 0.012));
          float rag = (fq.r - 0.5) * 0.05;
          float ws = e + rag - (g - O_SEA); // depth of the run-up's reach over this sand
          float sheet = g + 0.3 * max(ws, 0.0);
          if (ws > 0.0 && sheet > y) {
            y = sheet;
            // churned white at the leading edge and while rushing up, thin lace draining back
            foam = max(foam, exp(-ws / 0.03) * 0.9 + (1.0 - smoothstep(0.0, 0.35, run)) * 0.6 + 0.25 * (1.0 - run));
            brk = 1.0;
          }
          float depth = y - g;
          if (depth < 0.004) {
            // dry sand: glossy for a few seconds after the backwash drains (time since this wave's
            // edge passed down over it), then just damp (the terrain's own colour)
            float h = g - O_SEA - rag;
            float hr = clamp((h + 0.06) / max(rmax, 0.05), 0.0, 1.0);
            float vDown = hr < 1.0 ? 0.5 + 0.5 * sqrt(1.0 - hr) : 2.0;
            float since = (pow(run, 0.8) - vDown) * 0.92 * O_PERIOD;
            float gloss = since > 0.0 ? exp(-since / 3.0) : exp(-(since + O_PERIOD) / 3.0) * 0.5;
            gloss *= 1.0 - smoothstep(0.75, 1.15, h);
            if (gloss < 0.02) discard;
            oFilm = gloss;
            depth = 0.0;
            y = g;
          }
          oP = vec3(xz.x, y, xz.y);
          // the water itself: turbid green-grey in the surf, darker and clearer offshore
          float turbid = 1.0 - smoothstep(2.0, 9.0, d);
          vec3 deep = vec3(0.012, 0.04, 0.045);
          vec3 surf = vec3(0.075, 0.12, 0.1);
          vec3 water = mix(deep, surf, turbid);
          water += vec3(0.05, 0.17, 0.14) * lit; // light through the wave's face
          float a = 1.0 - exp(-depth * mix(0.5, 1.6, turbid));
          // foam: lacy, from the cellular texture, its threshold set by how much there is
          vec2 fp = xz * 0.17;
          float tex = texture2D(uOFoam, fp + vec2(uOTime * 0.01, -uOTime * 0.03)).r * 0.6
                    + texture2D(uOFoam, fp * 2.3 + vec2(-uOTime * 0.02, uOTime * 0.015)).r * 0.4;
          float fmask = smoothstep(1.0 - foam, 1.3 - foam, tex + 0.2 * foam) * 0.92;
          float fdist = smoothstep(80.0, 300.0, distance(cameraPosition, oP)); // far off foam reads as soft white
          oFoam = clamp(mix(fmask, foam * 0.7, fdist), 0.0, 1.0) * (1.0 - oFilm);
          diffuseColor.rgb = mix(water, vec3(0.82, 0.86, 0.86), oFoam);
          diffuseColor.a = max(a, oFoam);
          if (oFilm > 0.0) { diffuseColor.rgb = vec3(0.0); diffuseColor.a = 0.22 * oFilm; }
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // the surface's own slope (per pixel, from the height worked out above), faded out far
          // off where the derivatives get coarse, plus small wind chop
          vec3 dx = dFdx(oP);
          vec3 dy = dFdy(oP);
          vec3 nG = normalize(cross(dy, dx));
          if (nG.y < 0.0) nG = -nG;
          float dist = distance(cameraPosition, oP);
          nG = normalize(mix(nG, vec3(0.0, 1.0, 0.0), smoothstep(40.0, 160.0, dist) * 0.8 + oFilm));
          vec2 wp = oP.xz * 0.045;
          vec2 s1 = texture2D(uOWaves, wp + vec2(uOTime * 0.011, -uOTime * 0.017)).rg * 2.0 - 1.0;
          vec2 s2 = texture2D(uOWaves, wp * 2.7 + vec2(-uOTime * 0.02, uOTime * 0.013)).rg * 2.0 - 1.0;
          vec2 chop = (s1 * 0.6 + s2 * 0.4) * mix(0.16, 0.05, oFilm) * (1.0 - 0.6 * oFoam) * (0.8 + 0.4 * uOWet);
          vec3 nW = normalize(nG + vec3(chop.x, 0.0, chop.y));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.9, oFoam);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          vec3 wV = normalize(cameraPosition - oP);
          vec3 nW = (vec4(normal, 0.0) * viewMatrix).xyz;
          vec3 r = reflect(-wV, nW);
          float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(nW, wV), 0.0, 1.0), 5.0);
          oF = fres * (1.0 - oFoam) * (oFilm > 0.0 ? oFilm * 0.85 : 1.0);
          reflectedLight.indirectSpecular = oSky(r.y);
          // at night the moon itself and its aureole, broken up by the waves into a path of light
          if (uONight > 0.5) {
            float mc = max(dot(r, uGlDir), 0.0);
            reflectedLight.indirectSpecular += uGlColor * (pow(mc, 900.0) * 6.0 + pow(mc, 60.0) * 0.5 + pow(mc, 8.0) * 0.06) / max(fres, 0.05) * (1.0 - oFoam);
          }
          // sun glitter on the open water (not the foam)
          reflectedLight.indirectSpecular += uGlColor
            * glitter(oP, wV, 0.2 + 0.08 * uOWet) * (1.0 - oFoam) / max(fres, 0.05);
        }`)
      .replace('#include <opaque_fragment>', `
        {
          // one layer of water under a reflecting surface: R·F + (1 − F)(W·a + dst·(1 − a))
          vec3 body = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular * (1.0 - oFilm * 0.5);
          float a = diffuseColor.a;
          float alphaOut = 1.0 - (1.0 - oF) * (1.0 - a);
          vec3 col = reflectedLight.indirectSpecular * oF + (1.0 - oF) * a * body;
          gl_FragColor = vec4(col / max(alphaOut, 1e-3), alphaOut);
        }`);
  };

  const geo = polarGrid(lowPower ? 430 : 920, lowPower ? 128 : 160);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ocean';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  const coastLine = coast.rect.y + MASK_S + 40; // (the field's north edge sits MASK_S + 40 m inland of the furthest-north shore)

  // the grid follows whichever camera draws it (snapped to 0.5 m: its finest spacing)
  mesh.onBeforeRender = (renderer, scene, camera) => {
    uniforms.uOCentre.value.set(Math.round(camera.position.x * 2) / 2, Math.round(camera.position.z * 2) / 2);
  };
  return {
    mesh,
    uniforms,
    /** Hide it when the sea is out of range. */
    update(camera) {
      mesh.visible = camera.position.z > coastLine - camera.far;
    },
  };
}

