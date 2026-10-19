import * as THREE from 'three';
import { rawGroundAt, streams } from './terrain.js';
import { shared, patchSunlight, sunKey, GLITTER_GLSL, patchGlitter } from './materials.js';

/**
 * The streams' water: one ribbon per stream along its points, filling the
 * carved trough. The surface level falls steadily downstream (it sits a little
 * above the *rendered* terrain's bed, which the 5 m grid makes coarser than the
 * carve), about as wide as the stream's bed, with the edge faded out.
 *
 * The shader scrolls a ripple pattern along the flow at a speed set by the
 * stream's fall, adds white water on steep runs and in a thin line at the
 * banks, and reflects the sky and shore like the lake (with the sun's
 * glitter on top, see sunGlitter in materials.js).
 */
export function buildStreamWater(trail) {
  const group = new THREE.Group();
  group.name = 'streams';
  const mat = streamMaterial(rockTexture(streamRocks(trail)));
  for (const [si, s] of streams().streams.entries()) {
    const geo = ribbon(s.points, si);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'stream';
    // after the trail's transparent fringe: where the trail crosses, the fringe (sorted by distance
    // with the water) was drawn over the creek in a straight line across it
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  return group;
}

const ACROSS = 9; // vertices across the ribbon (6 showed as long flat facets)
const BUCKET = 4; // m of stream per rock-texture column (streams.js places at most 2 rocks per 4 m)

let rockList = null;
/**
 * The rocks in the creeks (streams.js), minus any under a footbridge. vegetation.js places
 * them and the water shader flows around them, so both take this same list.
 */
export function streamRocks(trail) {
  rockList ||= streams().rocks.filter((r) => trail.distanceTo(r.x, r.z) > 3.5 + r.r);
  return rockList;
}

/** RGBA32F, a column per BUCKET m of stream, 2 rows per stream: (across, along, radius, 1). */
function rockTexture(rocks) {
  const n = streams().streams.length;
  const w = Math.ceil(Math.max(...streams().streams.map((s) => s.points[s.points.length - 1].s)) / BUCKET) + 1;
  const data = new Float32Array(w * n * 2 * 4);
  for (const r of rocks) {
    const b = Math.floor(r.s / BUCKET);
    for (let slot = 0; slot < 2; slot++) {
      const k = ((r.stream * 2 + slot) * w + b) * 4;
      if (data[k + 2] > 0) continue;
      data.set([r.a, r.s, r.r, 1], k);
      break;
    }
  }
  const tex = new THREE.DataTexture(data, w, n * 2, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  return tex;
}

function ribbon(pts, si) {
  const n = pts.length;
  if (n < 2) return null;
  // water level: a little above the rendered bed, never rising downstream (beyond a few cm, so
  // a bump in the coarse mesh doesn't bury the water)
  const level = new Float32Array(n);
  let prev = Infinity;
  for (let i = 0; i < n; i++) {
    const g = rawGroundAt(pts[i].x, pts[i].z);
    const want = g + 0.12 + pts[i].width * 0.03;
    level[i] = Math.max(Math.min(want, prev), g + 0.06);
    prev = level[i];
  }
  // light smoothing of the level along the stream (no steps at grid edges)
  for (let pass = 0; pass < 2; pass++) for (let i = 1; i < n - 1; i++) level[i] = Math.min(level[i], (level[i - 1] + level[i] * 2 + level[i + 1]) / 4 + 0.02);

  const pos = [];
  const flow = []; // dir x, dir z, speed
  const uvs = []; // across (-1..1), along (m)
  const info = []; // half width (m), stream index, rapids (0..1)
  const idx = [];
  let along = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    if (i > 0) along += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const fall = Math.max(0, (level[Math.max(0, i - 1)] - level[Math.min(n - 1, i + 1)]) / l);
    const speed = 0.35 + Math.min(2.2, fall * 14);
    // the water's half width: the bed plus a little (the 5 m terrain grid only roughly holds the
    // channel, so searching for where the banks rise spread the water across flat valley floors)
    const reach = [pts[i].width / 2 + 0.7, pts[i].width / 2 + 0.7];
    for (let j = 0; j < ACROSS; j++) {
      const u = (j / (ACROSS - 1)) * 2 - 1;
      const r = u < 0 ? -u * reach[0] : u * reach[1];
      const side = Math.sign(u);
      pos.push(pts[i].x - dz * side * r, level[i], pts[i].z + dx * side * r);
      flow.push(dx, dz, speed);
      uvs.push(u, along);
      info.push(reach[0], si, pts[i].rapid || 0);
    }
    if (i > 0) {
      const r0 = (i - 1) * ACROSS;
      const r1 = i * ACROSS;
      for (let j = 0; j < ACROSS - 1; j++) idx.push(r0 + j, r1 + j, r0 + j + 1, r0 + j + 1, r1 + j, r1 + j + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // faces must point up: flip the winding if this order made them point down
  if (geo.attributes.normal.getY(0) < 0) {
    const ia = geo.index.array;
    for (let k = 0; k < ia.length; k += 3) [ia[k + 1], ia[k + 2]] = [ia[k + 2], ia[k + 1]];
    geo.computeVertexNormals();
  }
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A tileable field of small water waves (heights from a sum of waves whose wave numbers are whole
 * numbers per tile, so it wraps), as a normal map: RG = slope (x, y) remapped to 0..1, B = height.
 * The water's detail comes from this instead of value noise, which looked blobby and blocky.
 */
export function waveNormals(size = 256, seed = 7) {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const waves = [];
  for (let k = 0; k < 48; k++) {
    let kx;
    let ky;
    do {
      kx = Math.round((rnd() * 2 - 1) * 14);
      ky = Math.round((rnd() * 2 - 1) * 14);
    } while (kx * kx + ky * ky < 4);
    const kl = Math.hypot(kx, ky);
    waves.push({ kx, ky, a: 1 / kl ** 1.6, ph: rnd() * Math.PI * 2 });
  }
  const h = new Float32Array(size * size);
  // sin(kx·x + ky·y + φ) = sin(kx·x)cos(ky·y + φ) + cos(kx·x)sin(ky·y + φ): tables per wave, no sin per texel
  const sx = new Float32Array(size);
  const cx = new Float32Array(size);
  const sy = new Float32Array(size);
  const cy = new Float32Array(size);
  for (const w of waves) {
    for (let i = 0; i < size; i++) {
      const ax = (w.kx * i / size) * Math.PI * 2;
      const ay = (w.ky * i / size) * Math.PI * 2 + w.ph;
      sx[i] = Math.sin(ax) * w.a;
      cx[i] = Math.cos(ax) * w.a;
      sy[i] = Math.sin(ay);
      cy[i] = Math.cos(ay);
    }
    for (let y = 0; y < size; y++) {
      const r = y * size;
      const syy = sy[y];
      const cyy = cy[y];
      for (let x = 0; x < size; x++) h[r + x] += sx[x] * cyy + cx[x] * syy;
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of h) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  let maxS = 0;
  const sl = new Float32Array(size * size * 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = (at(x + 1, y) - at(x - 1, y)) / 2;
      const sy = (at(x, y + 1) - at(x, y - 1)) / 2;
      sl[(y * size + x) * 2] = sx;
      sl[(y * size + x) * 2 + 1] = sy;
      maxS = Math.max(maxS, Math.abs(sx), Math.abs(sy));
    }
  }
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round((sl[i * 2] / maxS * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((sl[i * 2 + 1] / maxS * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round(((h[i] - lo) / (hi - lo)) * 255);
    data[i * 4 + 3] = 255;
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
 * Tileable foam: clusters of bubbles (cellular noise: bright rims around dark cells, at two
 * sizes, broken up by a soft mask), R = foam density 0..1. Foam is drawn where this exceeds a
 * threshold set by how much white water there should be, so it grows in bubbly lacework.
 */
export function foamTexture(size = 256, seed = 11) {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  // cellular noise on a g×g grid of jittered points (one per cell; only the 3×3 neighbouring
  // cells are searched), wrapped so it tiles
  const layer = (g) => {
    const px = new Float32Array(g * g);
    const py = new Float32Array(g * g);
    for (let i = 0; i < g * g; i++) {
      px[i] = rnd();
      py[i] = rnd();
    }
    const out = new Float32Array(size * size);
    const cell = size / g;
    let m = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = x / cell;
        const fy = y / cell;
        const gx = Math.floor(fx);
        const gy = Math.floor(fy);
        let d1 = 9;
        let d2 = 9;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const k = ((gy + j + g) % g) * g + ((gx + i + g) % g);
            const dx = gx + i + px[k] - fx;
            const dy = gy + j + py[k] - fy;
            const d = dx * dx + dy * dy;
            if (d < d1) {
              d2 = d1;
              d1 = d;
            } else if (d < d2) d2 = d;
          }
        }
        const v = Math.sqrt(d2) - Math.sqrt(d1); // 0 on the cell walls
        out[y * size + x] = v;
        if (v > m) m = v;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = 1 - Math.min(1, out[i] / (m * 0.35)); // 1 on the walls
    return out;
  };
  const big = layer(8);
  const small = layer(16);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = Math.min(1, big[i] * 0.6 + small[i] * 0.55);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.round(v * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function streamMaterial(rockTex) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1d2a26,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const waves = waveNormals();
  const foam = foamTexture();
  mat.onBeforeCompile = (shader) => {
    patchSunlight(shader);
    shader.uniforms.uSwTime = shared.uTime; // (own name: patchSunlight declares uTime)
    shader.uniforms.uWet = shared.uWet;
    shader.uniforms.uSwCanopy = shared.uCanopyMap;
    shader.uniforms.uSwCanopyRect = shared.uCanopyRect;
    shader.uniforms.uSwRocks = { value: rockTex };
    shader.uniforms.uSwSun = shared.uSun;
    shader.uniforms.uSwWaves = { value: waves };
    shader.uniforms.uSwFoamTex = { value: foam };
    shader.uniforms.uSwGround = shared.uGroundH;
    shader.uniforms.uSwGrid = shared.uGroundGrid;
    patchGlitter(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aFlow;
        attribute vec3 aInfo;
        varying vec3 vSwInfo;
        varying vec3 vFlow;
        varying vec2 vWUv;
        varying vec3 vWPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFlow = aFlow;
        vSwInfo = aInfo;
        vWUv = uv;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uSwTime;
        uniform float uWet;
        uniform sampler2D uSwCanopy;
        uniform vec4 uSwCanopyRect;
        ${GLITTER_GLSL}
        uniform highp sampler2D uSwRocks;
        uniform float uSwSun;
        uniform sampler2D uSwWaves;
        uniform sampler2D uSwFoamTex;
        uniform highp sampler2D uSwGround;
        uniform vec4 uSwGrid; // min x, min z, step, n
        varying vec3 vSwInfo;
        varying vec3 vFlow;
        varying vec2 vWUv;
        varying vec3 vWPos;
        float swHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float swNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(swHash(i), swHash(i + vec2(1, 0)), f.x), mix(swHash(i + vec2(0, 1)), swHash(i + vec2(1, 1)), f.x), f.y);
        }
        // the rendered terrain's height under this point (same grid and triangulation as groundAt)
        float swGroundAt(vec2 xz) {
          vec2 g = clamp((xz - uSwGrid.xy) / uSwGrid.z, vec2(0.0), vec2(uSwGrid.w - 1.0001));
          ivec2 i = ivec2(floor(g));
          vec2 f = g - vec2(i);
          float ha = texelFetch(uSwGround, i, 0).r;
          float hb = texelFetch(uSwGround, i + ivec2(0, 1), 0).r;
          float hc = texelFetch(uSwGround, i + ivec2(1, 1), 0).r;
          float hd = texelFetch(uSwGround, i + ivec2(1, 0), 0).r;
          return f.x + f.y <= 1.0 ? ha + (hd - ha) * f.x + (hb - ha) * f.y
            : hc + (hb - hc) * (1.0 - f.x) + (hd - hc) * (1.0 - f.y);
        }
        float swFoam;
        float swSpeed; // m/s here (fast mid-channel, slow at the banks, faster in the rapids)
        vec2 swVel;    // the local current (across, along), m/s
        vec2 swPm;     // this point in the ribbon's frame (across, along), m
        float swPhase0;
        float swPhase1;
        float swMix;
        // Rocks: the (up to) 6 in this and the neighbouring 4 m of stream, in the ribbon's frame:
        // x = across (m), y = along (m, downstream +), z = radius
        vec3 swRk[6];
        int swRkN;
        void swLoadRocks() {
          swRkN = 0;
          int row = int(vSwInfo.y + 0.5) * 2;
          int w = textureSize(uSwRocks, 0).x;
          int b = int(floor(vWUv.y / ${BUCKET.toFixed(1)}));
          for (int db = -1; db <= 1; db++) {
            int bb = b + db;
            if (bb < 0 || bb >= w) continue;
            for (int k = 0; k < 2; k++) {
              vec4 t = texelFetch(uSwRocks, ivec2(bb, row + k), 0);
              // only rocks close enough to touch this spot's water (their effects end by ~10 radii):
              // most of a creek then skips the rock maths entirely
              if (t.z > 0.0 && length((vec2(vWUv.x * vSwInfo.x, vWUv.y) - t.xy) / t.z) < 10.0) { swRk[swRkN] = t.xyz; swRkN++; }
            }
          }
        }
        // the water surface's shape around the rocks (m): heaped against the upstream face, a trough
        // in the lee, then standing waves fanning out downstream
        float swRockH(vec2 pm, float sp) {
          float h = 0.0;
          for (int i = 0; i < 6; i++) {
            if (i >= swRkN) break;
            vec2 d = (pm - swRk[i].xy) / swRk[i].z;
            float rn = length(d);
            if (rn > 8.0) continue;
            h += 0.07 * (0.4 + sp) * exp(-pow((rn - 1.1) * 3.0, 2.0)) * smoothstep(0.3, -0.7, d.y) * swRk[i].z;
            if (d.y > 0.0) {
              float arm = abs(d.x) - (0.9 + 0.3 * d.y);
              h -= 0.06 * (0.3 + sp) * exp(-pow((d.y - 1.0) * 1.4, 2.0)) * smoothstep(1.3, 0.5, abs(d.x)) * swRk[i].z;
              h += 0.025 * (0.3 + sp) * sin(d.y * 3.4) * smoothstep(0.4, -0.6, arm) * exp(-d.y / (2.0 + 4.0 * sp)) * swRk[i].z;
            }
          }
          return h;
        }
        // around the rocks: white water (x) and the current's sideways push (y, m/s per m/s)
        vec2 swRockFlow(vec2 pm, float speed, float sp) {
          vec2 f = vec2(0.0);
          for (int i = 0; i < 6; i++) {
            if (i >= swRkN) break;
            float R = swRk[i].z;
            vec2 dm = pm - swRk[i].xy;
            vec2 d = dm / R;
            float rn = length(d);
            if (rn > 10.0) continue;
            // the current parts around the stone (flow round a cylinder) and closes behind it
            f.y += d.x / (rn * rn + 0.35) * smoothstep(6.0, 1.0, rn) * (d.y < 0.0 ? 1.0 : exp(-d.y * 0.4));
            // a collar of broken water where the current meets the stone, thickest upstream
            float face = smoothstep(0.6, -0.8, d.y / max(rn, 1e-3));
            f.x = max(f.x, smoothstep(0.98 + 0.3 * face, 0.75, rn) * (0.35 + 0.65 * face) * (0.4 + 0.6 * sp));
            // a wake of bubbles behind it, longer on fast water
            if (d.y > 0.0) {
              float arm = abs(d.x) - (0.55 + 0.15 * d.y);
              f.x = max(f.x, smoothstep(0.2, -0.4, arm) * exp(-d.y / (1.2 + 3.0 * sp)) * smoothstep(0.6, 1.1, rn) * (0.25 + 0.45 * sp));
            }
          }
          return f;
        }
        vec2 swRockF;
        // Flow-map advection (two phases half a cycle apart, crossfaded, each restarting where the
        // other is at full weight, so the pattern streams with the local current without ever
        // visibly resetting; the cycle is offset per spot so the water doesn't pulse as one)
        void swPhases() {
          float cyc = uSwTime / 0.9 + swNoise(swPm * vec2(0.6, 0.25)) * 1.7;
          swPhase0 = fract(cyc);
          swPhase1 = fract(cyc + 0.5);
          swMix = abs(1.0 - 2.0 * swPhase0); // weight of phase 1
        }
        vec4 swFlowTex(sampler2D tex, vec2 pm, float tile, vec2 off) {
          // (the pattern moves at most ~1.7 m/s and ~1.5 m per cycle: pushed further, it smeared
          // into streaks and swirled around the rocks)
          vec2 v = swVel * min(1.0, 1.7 / max(length(swVel), 1e-3));
          vec2 a = (pm - v * swPhase0 * 0.9) / tile + off;
          vec2 b = (pm - v * swPhase1 * 0.9) / tile + off + 0.5;
          return mix(texture2D(tex, a), texture2D(tex, b), swMix);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float rapid = vSwInfo.z;
          float u = vWUv.x;
          swPm = vec2(u * vSwInfo.x, vWUv.y);
          // The waterline. The flat ribbon meets the 5 m terrain triangles along straight lines, so
          // the water ends a little before that, where it's (noisy) 2–8 cm deep, and the ribbon's
          // own outline is ragged too: a wandering edge of little bays and points. (The water is
          // only ~0.2 m deep mid-stream, so the inner channel keeps its water.)
          float depth = vWPos.y - swGroundAt(vWPos.xz);
          float en = swNoise(vWPos.xz * 0.7) * 0.55 + swNoise(vWPos.xz * 2.3 + 7.0) * 0.3 + swNoise(vWPos.xz * 7.0 + 3.0) * 0.15;
          float edge = 0.02 + 0.06 * en * smoothstep(0.3, 0.7, abs(u)) + 0.008 * sin(uSwTime * 1.3 + en * 11.0);
          float rim = 1.0 - smoothstep(0.62 + 0.3 * en, 0.72 + 0.3 * en, abs(u));
          float wet = smoothstep(edge, edge + 0.03, depth) * rim;
          if (wet < 0.01) discard;
          swLoadRocks();
          float base = vFlow.z + 2.6 * rapid;
          float sp = smoothstep(0.3, 2.5, base);
          swRockF = swRkN > 0 ? swRockFlow(swPm, base, sp) : vec2(0.0);
          // the current: fastest mid-channel, dragging at the banks; it wanders in slow eddies
          // and parts around rocks, so each part of the creek moves at its own pace
          float profile = 0.3 + 0.7 * (1.0 - u * u);
          vec2 tq = swPm * vec2(0.45, 0.2) + vec2(0.0, -uSwTime * 0.12 * base);
          vec2 turb = vec2(swNoise(tq), swNoise(tq + 17.3)) - 0.5;
          swSpeed = base * profile * (0.8 + 0.5 * turb.y);
          swVel = vec2(turb.x * 0.5 * base + clamp(swRockF.y, -1.0, 1.0) * 0.3 * base, swSpeed);
          swPhases();
          // white water: fast runs and rapids (in drifting patches), standing-wave crests in the
          // rapids, rocks, and a thin line at the banks; drawn as advected bubbly foam
          float patches = swNoise(swPm * vec2(0.5, 0.18) + vec2(0.0, -uSwTime * 0.3 * base));
          float cov = smoothstep(1.4, 3.0, vFlow.z) * (0.15 + 0.5 * patches);
          // standing waves in the rapids: irregular ridges (not bands straight across), white on top
          if (rapid > 0.001) {
            float rn = swNoise(swPm * vec2(0.75, 0.55) + 3.1) * 0.65 + swNoise(swPm * vec2(1.7, 1.2) + 8.3) * 0.35;
            float crest = 1.0 - abs(2.0 * rn - 1.0);
            cov = max(cov, rapid * (0.1 + 0.7 * smoothstep(0.6, 0.95, crest)) * (0.45 + 0.55 * patches));
          }
          cov = max(cov, swRockF.x * 1.25);
          cov = max(cov, exp(-pow((depth - edge - 0.03) * 25.0, 2.0)) * rim * 0.3); // a thin line along the waterline
          // (stretched along the current: white water streaks, round bubbles read as a cow print)
          vec2 fq = swPm * vec2(1.0, 0.33);
          float ft = swFlowTex(uSwFoamTex, fq, 1.1, vec2(0.0)).r * 0.6 + swFlowTex(uSwFoamTex, fq, 0.4, vec2(0.31, 0.7)).r * 0.4;
          swFoam = cov <= 0.001 ? 0.0 : smoothstep(1.0 - cov, 1.0 - cov + 0.3, ft) * min(1.0, cov * 2.5);
          // rapids: churned, aerated water is milky and lighter between the foam
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.25, 0.24), rapid * 0.55 * (0.5 + 0.5 * patches));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.84, 0.84), swFoam * 0.95);
          // clearer at the edges (you see the stones), deeper colour in the middle; edge fades into the bank
          float shallow = smoothstep(edge, edge + 0.08, depth);
          diffuseColor.a = mix(0.55, 0.9, 1.0 - abs(u)) * mix(0.6, 1.0, shallow);
          diffuseColor.a = max(diffuseColor.a, swFoam * 0.92);
          // churned, aerated water hides the bed
          diffuseColor.a = mix(diffuseColor.a, 0.97, rapid);
          diffuseColor.a *= wet;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // wavelets streaming with the current at two scales; rougher where it's fast
          vec2 n1 = swFlowTex(uSwWaves, swPm, 1.7, vec2(0.0)).xy * 2.0 - 1.0;
          vec2 n2 = swFlowTex(uSwWaves, swPm * vec2(1.0, 0.8), 0.55, vec2(0.37, 0.11)).xy * 2.0 - 1.0;
          float rapid = vSwInfo.z;
          float base = vFlow.z + 2.6 * rapid;
          float amp = 0.1 + 0.16 * smoothstep(0.4, 2.5, base) + 0.12 * rapid;
          vec2 slope = (n1 * 0.6 + n2 * 0.55) * amp * (1.0 + 0.8 * swRockF.x);
          // rapids: standing waves (they stay put while the water runs through them)
          if (rapid > 0.001) { // (only in the rapids: 6 noise lookups)
            // (slopes of the same ridge field as the foam, by finite differences)
            float r0 = swNoise(swPm * vec2(0.75, 0.55) + 3.1) * 0.65 + swNoise(swPm * vec2(1.7, 1.2) + 8.3) * 0.35;
            float rx = swNoise((swPm + vec2(0.1, 0.0)) * vec2(0.75, 0.55) + 3.1) * 0.65 + swNoise((swPm + vec2(0.1, 0.0)) * vec2(1.7, 1.2) + 8.3) * 0.35;
            float ry = swNoise((swPm + vec2(0.0, 0.1)) * vec2(0.75, 0.55) + 3.1) * 0.65 + swNoise((swPm + vec2(0.0, 0.1)) * vec2(1.7, 1.2) + 8.3) * 0.35;
            float c0 = 1.0 - abs(2.0 * r0 - 1.0);
            slope += rapid * 0.55 * vec2((1.0 - abs(2.0 * rx - 1.0)) - c0, (1.0 - abs(2.0 * ry - 1.0)) - c0) / 0.1 * 0.35;
          }
          vec3 along = normalize(vec3(vFlow.x, 0.0, vFlow.y));
          vec3 across = vec3(-along.z, 0.0, along.x);
          vec3 nWorld = vec3(0.0, 1.0, 0.0) - across * slope.x - along * slope.y;
          if (swRkN > 0) {
            float sp = smoothstep(0.3, 2.5, base);
            float r0 = swRockH(swPm, sp);
            nWorld -= across * (swRockH(swPm + vec2(0.06, 0.0), sp) - r0) / 0.06 + along * (swRockH(swPm + vec2(0.0, 0.06), sp) - r0) / 0.06;
          }
          nWorld = normalize(nWorld);
          normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.7, swFoam);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #ifdef USE_FOG
        {
          // reflect the sky and the banks (as the lake does): dark banks low, sky above
          vec3 wV = normalize(vViewPosition);
          vec3 rW = (vec4(reflect(-wV, normal), 0.0) * viewMatrix).xyz;
          vec3 sky = fogColor * (1.05 + 0.35 * smoothstep(0.0, 0.6, rW.y));
          vec3 bank = mix(vec3(0.02, 0.03, 0.022), fogColor * 0.4, 0.3);
          // under trees a creek mirrors the dark canopy, not the sky: the canopy over the water
          // (three samples up the reflected ray, through the crowns at different heights: one sample
          // mirrored the crown map's gaps as hard-edged white patches)
          vec2 rr = rW.xz / max(rW.y, 0.2);
          float canopy = (texture2D(uSwCanopy, (vWPos.xz + rr * 4.0 - uSwCanopyRect.xy) / uSwCanopyRect.zw).r
                        + texture2D(uSwCanopy, (vWPos.xz + rr * 9.0 - uSwCanopyRect.xy) / uSwCanopyRect.zw).r
                        + texture2D(uSwCanopy, (vWPos.xz + rr * 16.0 - uSwCanopyRect.xy) / uSwCanopyRect.zw).r) / 3.0;
          canopy = min(1.0, canopy * 2.2);
          sky = mix(sky, vec3(0.025, 0.04, 0.03), canopy * 0.8);
          vec3 refl = mix(bank, sky, smoothstep(-0.2, 0.6, rW.y));
          // (moving water is never a perfect mirror)
          float fres = 0.02 + 0.6 * pow(1.0 - clamp(dot(normal, wV), 0.0, 1.0), 5.0);
          reflectedLight.indirectSpecular = refl * fres * (1.0 - swFoam);
          // the overcast key light is really the whole sky (reflected above): as a point light on
          // smooth water it threw hard glints, masked by the crowns into flat white blotches
          reflectedLight.directSpecular *= 0.5 * uSwSun * (1.0 - swFoam);
          // sun glitter where the sun reaches the water (the canopy along the ray toward it), wider
          // on faster, rougher water
          vec2 toSun = uGlDir.xz / uGlDir.y * 10.0;
          float shade = min(1.0, texture2D(uSwCanopy, (vWPos.xz + toSun - uSwCanopyRect.xy) / uSwCanopyRect.zw).r * 2.4);
          reflectedLight.indirectSpecular += uGlColor
            * glitter(vWPos, normalize(cameraPosition - vWPos), 0.2 + 0.12 * smoothstep(0.4, 2.5, vFlow.z + 2.6 * vSwInfo.z)) * (1.0 - shade) * (1.0 - swFoam);
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => `stream|${sunKey()}`;
  return mat;
}
