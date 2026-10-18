import * as THREE from 'three';
import { rawGroundAt, streams } from './terrain.js';
import { shared, patchSunlight, sunKey } from './materials.js';

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
export function buildStreamWater() {
  const group = new THREE.Group();
  group.name = 'streams';
  const mat = streamMaterial();
  for (const s of streams().streams) {
    const geo = ribbon(s.points);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'stream';
    group.add(mesh);
  }
  return group;
}

const ACROSS = 6; // vertices across the ribbon

function ribbon(pts) {
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

function streamMaterial() {
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
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aFlow;
        varying vec3 vFlow;
        varying vec2 vWUv;
        varying vec3 vWPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFlow = aFlow;
        vWUv = uv;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uSwTime;
        uniform float uWet;
        uniform sampler2D uSwCanopy;
        uniform vec4 uSwCanopyRect;
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
          // stretched along the flow, finer than the stream: small standing waves and wrinkles
          vec2 a = vec2(q.x * 2.6, q.y * 1.1 - uSwTime * speed * 0.9);
          vec2 b = vec2(q.x * 6.3 + 4.1, q.y * 2.9 - uSwTime * speed * 1.5);
          vec2 c = vec2(q.x * 13.0 + 1.7, q.y * 6.1 - uSwTime * speed * 2.3);
          return swNoise(a) * 0.5 + swNoise(b) * 0.3 + swNoise(c) * 0.2;
        }
        float swFoam;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // white water: on fast (steep) runs, streaky along the flow, and a thin line at the banks
          float speed = vFlow.z;
          vec2 q = vec2(vWUv.x * 2.0, vWUv.y);
          float streaks = swNoise(vec2(q.x * 5.0, q.y * 0.6 - uSwTime * speed * 1.2)) * swNoise(vec2(q.x * 2.0 + 9.0, q.y * 1.4 - uSwTime * speed * 2.0));
          float fine = swNoise(vec2(q.x * 11.0, q.y * 3.5 - uSwTime * speed * 2.6));
          swFoam = smoothstep(1.5, 2.5, speed) * smoothstep(0.2, 0.62, streaks) * (0.3 + 0.7 * fine) * 0.55;
          swFoam = max(swFoam, smoothstep(0.8, 0.98, abs(vWUv.x)) * 0.18 * smoothstep(0.45, 0.9, fine));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.82, 0.82), swFoam);
          // clearer at the edges (you see the stones), deeper colour in the middle; edge fades into the bank
          diffuseColor.a = mix(0.55, 0.88, 1.0 - abs(vWUv.x)) * (1.0 - smoothstep(0.82, 1.0, abs(vWUv.x)));
          diffuseColor.a = max(diffuseColor.a, swFoam * 0.9);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 q = vec2(vWUv.x * 2.0, vWUv.y);
          float e = 0.12;
          float h0 = swRipples(q, vFlow.z);
          float hx = swRipples(q + vec2(e, 0.0), vFlow.z);
          float hy = swRipples(q + vec2(0.0, e), vFlow.z);
          float amp = 0.035 + 0.05 * smoothstep(0.4, 2.0, vFlow.z);
          vec3 along = normalize(vec3(vFlow.x, 0.0, vFlow.y));
          vec3 across = vec3(-along.z, 0.0, along.x);
          vec3 nWorld = normalize(vec3(0.0, 1.0, 0.0) - (across * (hx - h0) + along * (hy - h0)) / e * amp);
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
          float canopy = min(1.0, texture2D(uSwCanopy, (vWPos.xz + rW.xz / max(rW.y, 0.2) * 6.0 - uSwCanopyRect.xy) / uSwCanopyRect.zw).r * 2.2);
          sky = mix(sky, vec3(0.025, 0.04, 0.03), canopy * 0.85);
          vec3 refl = mix(bank, sky, smoothstep(-0.05, 0.45, rW.y));
          // (moving water is never a perfect mirror)
          float fres = 0.02 + 0.6 * pow(1.0 - clamp(dot(normal, wV), 0.0, 1.0), 5.0);
          reflectedLight.indirectSpecular = refl * fres * (1.0 - swFoam);
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => `stream|${sunKey()}`;
  return mat;
}
