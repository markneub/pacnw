import * as THREE from 'three';
import { WORLD_SIZE, WATER_LEVEL } from './config.js';
import {
  terrainGrid, cutUniforms, groundColor, groundLayers, nForest, mulberry32,
} from './terrain.js';
import { shared } from './materials.js';

/**
 * Grass blades around the camera: one draw call, no per-frame CPU work.
 *
 * Geometry is a single tuft (a few curved, tapered blades, real triangles, no
 * alpha test, which Apple GPUs dislike), drawn many times with instancing. Each
 * instance has a fixed spot in a square tile that wraps around the camera, like
 * the rain: as you walk, tufts behind you reappear ahead. In the vertex shader
 * each tuft
 *  - finds its world position (stable while it's in range, so nothing swims),
 *  - samples a baked map: density in alpha (meadows, clearings and lakeshore
 *    thick, forest floor under canopy sparse, none on rock, snow or water) and
 *    colour in rgb (grass palette x the ground's baked AO/canopy shade),
 *  - sits exactly on the rendered terrain (same triangulation as groundAt),
 *  - keeps off the trail (the terrain's cutout mask),
 *  - shrinks into the ground when its random threshold passes the density, and
 *    toward the edge of the radius, so nothing pops,
 *  - bends with travelling gusts plus a little flutter.
 * Tufts that aren't there collapse to a point: no pixels, only vertex work.
 */

const TUFT_BLADES = 8;
// Two rings, each its own wrapping tile and draw call: a dense one at your feet
// and a sparser one out to the edge, crossfading between `fade` radii
// [in start, in end, out start, out end] (m). A tile must be at least twice the
// ring's outer radius.
const RINGS = {
  desktop: [
    { size: 18, count: 7000, fade: [0, 0, 6.5, 9] }, // ~22 tufts/m2 (~170 blades)
    { size: 52, count: 20000, fade: [6.5, 9, 14, 26] }, // ~7 tufts/m2
  ],
  phone: [
    { size: 13, count: 3000, fade: [0, 0, 4.5, 6.5] },
    { size: 32, count: 5600, fade: [4.5, 6.5, 9, 16] },
  ],
};

/** One tuft: blades leaning outward, 2 segments each (5 vertices, 3 triangles). */
function tuftGeometry() {
  const rng = mulberry32(77);
  const pos = [];
  const nrm = [];
  const t = [];
  const index = [];
  for (let b = 0; b < TUFT_BLADES; b++) {
    const a = (b / TUFT_BLADES) * Math.PI * 2 + rng() * 0.8;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const base = dir.clone().multiplyScalar(0.03 + rng() * 0.13);
    const h = 0.24 + rng() * 0.42;
    const lean = 0.06 + rng() * 0.3;
    const w = 0.011 + rng() * 0.009;
    const n = dir.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, 0.85, 0)).normalize();
    const v0 = pos.length / 3;
    const ring = (f, width) => {
      const c = base.clone().addScaledVector(dir, lean * f ** 1.7).setY(h * f);
      if (width === 0) {
        pos.push(c.x, c.y, c.z);
        nrm.push(n.x, n.y, n.z);
        t.push(f);
        return;
      }
      for (const sgn of [-1, 1]) {
        const p = c.clone().addScaledVector(side, sgn * width);
        pos.push(p.x, p.y, p.z);
        nrm.push(n.x, n.y, n.z);
        t.push(f);
      }
    };
    ring(0, w);
    ring(0.55, w * 0.75);
    ring(1, 0);
    index.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2, v0 + 2, v0 + 3, v0 + 4);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
  geo.setIndex(index);
  return geo;
}

const smooth = THREE.MathUtils.smoothstep;
const LUSH = new THREE.Color('#566f2e');
const DRY = new THREE.Color('#857f4c');

/**
 * Density (alpha) and colour (rgb) per terrain vertex, from the same data as
 * the ground: layers (forest floor only), canopy, the terrain's baked shade.
 */
function bakeGrassMap(terrain, canopyAt) {
  const { heights, n, step } = terrainGrid();
  const half = WORLD_SIZE / 2;
  // the ground's baked shade (horizon AO x canopy) = shaded / unshaded colour
  const shaded = new Float32Array(n * n * 3);
  terrain.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    const c = o.geometry.attributes.color;
    for (let i = 0; i < p.count; i++) {
      const k = Math.round((p.getZ(i) + half) / step) * n + Math.round((p.getX(i) + half) / step);
      shaded.set([c.getX(i), c.getY(i), c.getZ(i)], k * 3);
    }
  });

  const data = new Uint8Array(n * n * 4);
  const h = (ix, iz) => heights[Math.min(n - 1, Math.max(0, iz)) * n + Math.min(n - 1, Math.max(0, ix))];
  const nv = new THREE.Vector3();
  const col = new THREE.Color();
  const grass = new THREE.Color();
  const layers = [0, 0, 0, 0];
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const k = iz * n + ix;
      const x = ix * step - half;
      const z = iz * step - half;
      const y = heights[k];
      nv.set(h(ix - 1, iz) - h(ix + 1, iz), 2 * step, h(ix, iz - 1) - h(ix, iz + 1)).normalize();
      const slope = 1 - nv.y;
      groundLayers(x, y, z, slope, layers);
      const open = 1 - canopyAt(x, z);
      const meadow = smooth(nForest(x * 0.011 + 31, z * 0.011 - 17) * 0.5 + 0.5, 0.3, 0.75);
      const shore = 1 - smooth(y, WATER_LEVEL + 3, WATER_LEVEL + 14);
      // no grass through snow (the 5 m map would smear it over the snow edge)
      const snowFree = 1 - smooth(layers[2], 0.03, 0.3);
      let density = layers[0] * snowFree * Math.min(1, 0.05 + 0.95 * open * open * (0.3 + 0.7 * meadow) + 0.8 * shore * open);
      if (y < WATER_LEVEL + 0.2) density = 0;

      groundColor(x, y, z, slope, col);
      const shade = Math.min(1.2, lum(shaded[k * 3], shaded[k * 3 + 1], shaded[k * 3 + 2]) / Math.max(1e-4, lum(col.r, col.g, col.b)));
      // greener by water and in meadows, drier higher up; a little of the
      // ground's own tint so it belongs to the place
      grass.copy(LUSH).lerp(DRY, smooth(y, 60, 150) * 0.7 + (1 - meadow) * 0.15).lerp(col, 0.25).multiplyScalar(shade);
      const srgb = grass.convertLinearToSRGB();
      data[k * 4] = Math.min(255, srgb.r * 255);
      data[k * 4 + 1] = Math.min(255, srgb.g * 255);
      data[k * 4 + 2] = Math.min(255, srgb.b * 255);
      data[k * 4 + 3] = Math.round(density * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  const ht = new THREE.DataTexture(heights, n, n, THREE.RedFormat, THREE.FloatType);
  ht.needsUpdate = true; // read with texelFetch only (no filtering needed)
  return { map: tex, height: ht, n, step };
}

/**
 * `density` scales the tuft counts (1 = default), for tuning on devices
 * (?grass=50 is half).
 */
export function buildGrass(terrain, canopyAt, { lowPower, density = 1 }) {
  const baked = bakeGrassMap(terrain, canopyAt);
  const tuft = tuftGeometry();
  const rings = (lowPower ? RINGS.phone : RINGS.desktop).map((ring, i) => {
    const count = Math.max(1, Math.round(ring.count * density));
    const geo = new THREE.InstancedBufferGeometry();
    for (const name of ['position', 'normal', 'aT']) geo.setAttribute(name, tuft.attributes[name]);
    geo.setIndex(tuft.index);
    const rng = mulberry32(4242 + i);
    const offsets = new Float32Array(count * 2);
    for (let k = 0; k < offsets.length; k++) offsets[k] = rng();
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 2));
    geo.instanceCount = count;
    geo.userData.count = count;
    const mesh = new THREE.Mesh(geo, grassMaterial(baked, ring));
    mesh.frustumCulled = false; // the tile follows the camera; the GPU clips
    return mesh;
  });
  const group = new THREE.Group();
  group.name = 'grass';
  group.add(...rings);
  const cams = rings.map((m) => m.material.userData.cam);

  return {
    mesh: group,
    map: baked.map, // debugging: density in alpha
    /** Once per frame (no allocation). */
    update(cameraPos) {
      for (const c of cams) c.set(cameraPos.x, cameraPos.z);
    },
    /** Draw only a share (0..1) of the tufts that were built (?bench). */
    setShare(f) {
      for (const m of rings) m.geometry.instanceCount = Math.max(1, Math.round(m.geometry.userData.count * f));
    },
  };
}

function grassMaterial(baked, ring) {
  const uniforms = {
    uGrassCam: { value: new THREE.Vector2() },
    uGrassSize: { value: ring.size },
    uGrassFade: { value: new THREE.Vector4(...ring.fade) },
    uGrassMap: { value: baked.map },
    uGrassHeight: { value: baked.height },
    uGrassGrid: { value: new THREE.Vector4(-WORLD_SIZE / 2, -WORLD_SIZE / 2, baked.step, baked.n) },
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  mat.envMapIntensity = 0.35; // like the needles: no sky sheen on foliage
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, cutUniforms, { uTime: shared.uTime, uWind: shared.uWind });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aOffset;
        attribute float aT;
        uniform vec2 uGrassCam;
        uniform float uGrassSize;
        uniform vec4 uGrassFade;
        uniform sampler2D uGrassMap;
        uniform sampler2D uGrassHeight;
        uniform vec4 uGrassGrid; // min x, min z, step, n
        uniform sampler2D uCutMask;
        uniform vec4 uCutRect;
        uniform float uTime;
        uniform float uWind;
        varying vec3 vGrassCol;
        float gHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        // the rendered terrain's height: same grid and triangulation as groundAt()
        float gGround(vec2 xz) {
          vec2 g = clamp((xz - uGrassGrid.xy) / uGrassGrid.z, vec2(0.0), vec2(uGrassGrid.w - 1.0001));
          ivec2 i = ivec2(floor(g));
          vec2 f = g - vec2(i);
          float ha = texelFetch(uGrassHeight, i, 0).r;
          float hb = texelFetch(uGrassHeight, i + ivec2(0, 1), 0).r;
          float hc = texelFetch(uGrassHeight, i + ivec2(1, 1), 0).r;
          float hd = texelFetch(uGrassHeight, i + ivec2(1, 0), 0).r;
          return f.x + f.y <= 1.0 ? ha + (hd - ha) * f.x + (hb - ha) * f.y
            : hc + (hb - hc) * (1.0 - f.x) + (hd - hc) * (1.0 - f.y);
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        // this tuft's world position: its copy of the tile nearest the camera
        vec2 gOrigin = uGrassCam - 0.5 * uGrassSize;
        vec2 gXZ = gOrigin + mod(aOffset * uGrassSize - gOrigin, uGrassSize);
        float gR1 = gHash(gXZ * 1.37);
        float gR2 = gHash(gXZ * 0.71 + 13.1);
        float gR3 = gHash(gXZ * 2.13 - 7.7);
        vec4 gMap = texture2D(uGrassMap, ((gXZ - uGrassGrid.xy) / uGrassGrid.z + 0.5) / uGrassGrid.w);
        float gDist = length(gXZ - uGrassCam);
        float gEdge = (uGrassFade.y > 0.0 ? smoothstep(uGrassFade.x, uGrassFade.y, gDist) : 1.0)
          * (1.0 - smoothstep(uGrassFade.z, uGrassFade.w, gDist));
        float gScale = smoothstep(0.0, 0.12, gMap.a * gEdge - gR1 * 0.999);
        vec2 gCutUv = (gXZ - uCutRect.xy) / uCutRect.zw;
        if (all(greaterThan(gCutUv, vec2(0.0))) && all(lessThan(gCutUv, vec2(1.0)))
            && texture2D(uCutMask, gCutUv).r > 0.5) gScale = 0.0;
        float gY = gGround(gXZ);
        if (gY < ${(WATER_LEVEL + 0.15).toFixed(2)}) gScale = 0.0;
        float gHeight = mix(0.7, 1.35, gR3) * mix(0.55, 1.0, gMap.a); // sparse grass is shorter
        float gA = gR2 * 6.2831853;
        mat2 gRot = mat2(cos(gA), -sin(gA), sin(gA), cos(gA));
        objectNormal.xz = gRot * objectNormal.xz;
        objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.5)); // soft, grassy shading`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.xz = gRot * transformed.xz;
        // blades are 1-2 cm wide: past a few metres that's under a pixel, so
        // widen the tuft (blades and spread) with distance to keep it visible
        transformed.xz *= 1.0 + 1.6 * smoothstep(3.0, 26.0, gDist);
        transformed *= gScale * vec3(1.0, gHeight, 1.0); // gScale 0: collapses to a point
        // wind: gusts travelling across the field, plus a little flutter
        vec2 gWind = vec2(0.912, 0.41);
        float gGust = sin(dot(gXZ, gWind) * 0.22 - uTime * 1.6) * 0.5 + 0.5;
        float gFlutter = sin(uTime * 4.1 + gR1 * 40.0);
        float gBend = aT * aT * (0.05 + 0.2 * gGust * gGust + 0.03 * gFlutter) * uWind * gScale * gHeight;
        transformed.xz += gWind * gBend;
        transformed.y -= gBend * gBend * 0.8;
        transformed += vec3(gXZ.x, gY, gXZ.y);
        vGrassCol = gMap.rgb * mix(0.4, 1.05, aT) * mix(0.8, 1.12, gR2);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vGrassCol;')
      // both faces lit alike (three would flip the normal on back faces)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  };
  mat.customProgramCacheKey = () => 'grass';
  mat.userData.cam = uniforms.uGrassCam.value;
  return mat;
}
