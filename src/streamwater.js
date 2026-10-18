import * as THREE from 'three';
import { rawGroundAt, streams } from './terrain.js';
import { shared, patchSunlight, sunKey, GLITTER_GLSL, patchGlitter } from './materials.js';
import { SUN_DIR, SUN_COLOR } from './atmosphere.js';

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
    group.add(mesh);
  }
  return group;
}

const ACROSS = 6; // vertices across the ribbon
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
  const info = []; // half width (m), stream index
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
      info.push(reach[0], si);
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
  geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 2));
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
  mat.onBeforeCompile = (shader) => {
    patchSunlight(shader);
    shader.uniforms.uSwTime = shared.uTime; // (own name: patchSunlight declares uTime)
    shader.uniforms.uWet = shared.uWet;
    shader.uniforms.uSwCanopy = shared.uCanopyMap;
    shader.uniforms.uSwCanopyRect = shared.uCanopyRect;
    shader.uniforms.uSwRocks = { value: rockTex };
    shader.uniforms.uSwSun = shared.uSun;
    patchGlitter(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aFlow;
        attribute vec2 aInfo;
        varying vec2 vSwInfo;
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
        varying vec2 vSwInfo;
        varying vec3 vFlow;
        varying vec2 vWUv;
        varying vec3 vWPos;
        float swHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float swNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(swHash(i), swHash(i + vec2(1, 0)), f.x), mix(swHash(i + vec2(0, 1)), swHash(i + vec2(1, 1)), f.x), f.y);
        }
        // ripples drifting downstream: two layers at different scales and speeds
        float swRipples(vec2 q, float speed) {
          // q in metres (across, along). Stretched along the flow, small: wavelets of ~0.1-0.5 m
          // (metre-scale ones mirrored the sky as big flat white blotches)
          vec2 a = vec2(q.x * 2.2, q.y * 1.1 - uSwTime * speed * 0.9);
          vec2 b = vec2(q.x * 5.5 + 4.1, q.y * 2.8 - uSwTime * speed * 1.5);
          vec2 c = vec2(q.x * 12.0 + 1.7, q.y * 6.5 - uSwTime * speed * 2.3);
          return swNoise(a) * 0.5 + swNoise(b) * 0.3 + swNoise(c) * 0.2;
        }
        float swFoam;
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
              if (t.z > 0.0) { swRk[swRkN] = t.xyz; swRkN++; }
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
        // foam (x) and the sideways shift of the flow (y, m) around the rocks
        vec2 swRockFlow(vec2 pm, float speed, float sp) {
          vec2 f = vec2(0.0);
          for (int i = 0; i < 6; i++) {
            if (i >= swRkN) break;
            float R = swRk[i].z;
            vec2 dm = pm - swRk[i].xy;
            vec2 d = dm / R;
            float rn = length(d);
            if (rn > 10.0) continue;
            // streamlines part around the stone (potential flow round a cylinder) and close up behind
            f.y += dm.x / (rn * rn + 0.35) * smoothstep(6.0, 1.0, rn) * (d.y < 0.0 ? 1.0 : exp(-d.y * 0.4));
            // a collar of white water where the current meets the stone
            // (thin and broken, thickest on the upstream face where the water piles up)
            float face = smoothstep(0.6, -0.8, d.y / max(rn, 1e-3));
            float n = swNoise(vec2(atan(d.y, d.x) * 4.0, rn * 9.0 - uSwTime * speed * 3.0)) * 0.6
                    + swNoise(vec2(atan(d.y, d.x) * 11.0, rn * 21.0 - uSwTime * speed * 4.0)) * 0.4;
            // (the stone is narrower at the waterline than its footprint: ~0.8 R)
            float collar = smoothstep(0.95 + 0.25 * face, 0.75, rn) * smoothstep(0.45, 0.8, n + 0.2 * face);
            f.x = max(f.x, collar * (0.35 + 0.45 * sp) * (0.3 + 0.7 * face));
            // a turbulent wake widening downstream, longer on fast water
            if (d.y > 0.0) {
              // (narrow and short: a trail of bubbles a few radii long, not a sheet of white water)
              float arm = abs(d.x) - (0.55 + 0.15 * d.y);
              float wake = smoothstep(0.15, -0.35, arm) * exp(-d.y / (1.2 + 2.5 * sp)) * smoothstep(0.6, 1.1, rn);
              float t = swNoise(vec2(d.x * 7.0, d.y * 1.4 - uSwTime * speed * 1.8)) * 0.6
                      + swNoise(vec2(d.x * 15.0 + 3.0, d.y * 3.5 - uSwTime * speed * 3.0)) * 0.4;
              f.x = max(f.x, wake * smoothstep(0.5, 0.8, t) * (0.2 + 0.4 * sp));
              // the V's arms: a thin line of broken water along each
              f.x = max(f.x, exp(-arm * arm * 30.0) * exp(-d.y / (1.5 + 3.0 * sp)) * smoothstep(0.45, 0.75, t) * (0.15 + 0.35 * sp));
            }
          }
          return f;
        }
        vec2 swRockF;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // white water: on fast (steep) runs, streaky along the flow, and a thin line at the banks
          float speed = vFlow.z;
          swLoadRocks();
          swRockF = swRkN > 0 ? swRockFlow(vec2(vWUv.x * vSwInfo.x, vWUv.y), speed, smoothstep(0.3, 2.0, speed)) : vec2(0.0);
          vec2 q = vec2(vWUv.x * 2.0 + swRockF.y * 2.0 / vSwInfo.x, vWUv.y);
          // (long thin streaks broken into flecks: broad noise blobs read as flat white patches)
          float streaks = swNoise(vec2(q.x * 9.0, q.y * 0.45 - uSwTime * speed * 1.2)) * swNoise(vec2(q.x * 3.5 + 9.0, q.y * 1.1 - uSwTime * speed * 2.0));
          float fine = swNoise(vec2(q.x * 22.0, q.y * 3.0 - uSwTime * speed * 2.6)) * 0.6 + swNoise(vec2(q.x * 47.0, q.y * 7.0 - uSwTime * speed * 3.4)) * 0.4;
          swFoam = smoothstep(1.5, 2.5, speed) * smoothstep(0.28, 0.6, streaks) * smoothstep(0.3, 0.75, fine) * 0.5;
          swFoam = max(swFoam, smoothstep(0.8, 0.98, abs(vWUv.x)) * 0.18 * smoothstep(0.45, 0.9, fine));
          swFoam = max(swFoam, swRockF.x);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.82, 0.82), swFoam);
          // clearer at the edges (you see the stones), deeper colour in the middle; edge fades into the bank
          diffuseColor.a = mix(0.55, 0.88, 1.0 - abs(vWUv.x)) * (1.0 - smoothstep(0.82, 1.0, abs(vWUv.x)));
          diffuseColor.a = max(diffuseColor.a, swFoam * 0.9);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 q = vec2(vWUv.x * vSwInfo.x + swRockF.y, vWUv.y);
          float e = 0.05;
          float h0 = swRipples(q, vFlow.z);
          float hx = swRipples(q + vec2(e, 0.0), vFlow.z);
          float hy = swRipples(q + vec2(0.0, e), vFlow.z);
          float amp = 0.012 + 0.018 * smoothstep(0.4, 2.0, vFlow.z);
          vec3 along = normalize(vec3(vFlow.x, 0.0, vFlow.y));
          vec3 across = vec3(-along.z, 0.0, along.x);
          // rougher just downstream of a rock
          amp *= 1.0 + 1.5 * swRockF.x;
          vec3 nWorld = vec3(0.0, 1.0, 0.0) - (across * (hx - h0) + along * (hy - h0)) / e * amp;
          if (swRkN > 0) {
            float sp = smoothstep(0.3, 2.0, vFlow.z);
            vec2 pm = vec2(vWUv.x * vSwInfo.x, vWUv.y);
            float r0 = swRockH(pm, sp);
            nWorld -= across * (swRockH(pm + vec2(0.06, 0.0), sp) - r0) / 0.06 + along * (swRockH(pm + vec2(0.0, 0.06), sp) - r0) / 0.06;
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
          reflectedLight.directSpecular *= 0.5 * uSwSun;
          // sun glitter where the sun reaches the water (the canopy along the ray toward it), wider
          // on faster, rougher water
          vec2 toSun = vec2(${(SUN_DIR.x / SUN_DIR.y).toFixed(3)}, ${(SUN_DIR.z / SUN_DIR.y).toFixed(3)}) * 10.0;
          float shade = min(1.0, texture2D(uSwCanopy, (vWPos.xz + toSun - uSwCanopyRect.xy) / uSwCanopyRect.zw).r * 2.4);
          reflectedLight.indirectSpecular += ${'vec3(' + [SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b].map((v) => v.toFixed(3)).join(', ') + ')'}
            * glitter(vWPos, normalize(cameraPosition - vWPos), 0.2 + 0.12 * smoothstep(0.4, 2.0, vFlow.z)) * (1.0 - shade) * (1.0 - swFoam);
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => `stream|${sunKey()}`;
  return mat;
}
