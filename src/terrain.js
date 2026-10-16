import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { WORLD_SIZE, TERRAIN_SEGMENTS, WATER_LEVEL, SNOWLINE, SEED } from './config.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const nBase = createNoise2D(rand);
const nRidge = createNoise2D(rand);
const nDetail = createNoise2D(rand);
const nSnow = createNoise2D(rand);
export const nForest = createNoise2D(rand);

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function fbm(noise, x, z, octaves) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function ridged(x, z, octaves) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  let prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(nRidge(x * freq, z * freq));
    n *= n;
    sum += n * amp * prev;
    prev = n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

// The lake sits in the valley just north-east of the spawn point.
const LAKE = { x: 170, z: 380, r: 150 };

/**
 * Terrain height at world (x, z). Layout: a low, rolling forested valley in the
 * south (+z) climbing into a ridged, snowy range in the north (-z), with the
 * whole map rimmed by mountains so the edges feel natural.
 */
export function heightAt(x, z) {
  const hills = fbm(nBase, x * 0.0016, z * 0.0016, 5) * 32 + 22;
  const detail = nDetail(x * 0.02, z * 0.02) * 1.2;

  // north range
  const north = smoothstep(250, -450, z);
  const range = north * (95 + ridged(x * 0.0021, z * 0.0021, 5) * 230);

  // rim
  const edge = Math.max(Math.abs(x), Math.abs(z));
  const rim = smoothstep(WORLD_SIZE * 0.36, WORLD_SIZE * 0.5, edge);
  const rimH = rim * (140 + ridged(x * 0.003 + 7, z * 0.003 - 3, 4) * 120);

  let h = hills + range + rimH + detail;

  // lake basin
  const dl = Math.hypot((x - LAKE.x) * 1.0, (z - LAKE.z) * 1.4);
  const wobble = nDetail(x * 0.01, z * 0.01) * 25;
  const basin = 1 - smoothstep(LAKE.r * 0.55, LAKE.r + wobble, dl);
  h = h * (1 - basin) + (WATER_LEVEL - 7) * basin;

  return h;
}

/** Local snowline altitude; wanders ±18 m so the snow edge isn't a contour line. */
export function snowlineAt(x, z) {
  return SNOWLINE + nSnow(x * 0.006, z * 0.006) * 18;
}

/** 0..1 how snow-covered the ground is at this point. */
export function snowAmount(x, z, h, slope = 0) {
  const line = snowlineAt(x, z);
  const s = smoothstep(line - 6, line + 10, h);
  return s * (1 - smoothstep(0.62, 0.85, slope) * 0.7);
}

export function slopeAt(x, z) {
  const e = 1.5;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  // 0 = flat, 1 = vertical
  const ny = 2 * e / Math.hypot(dx, 2 * e, dz);
  return 1 - ny;
}

const C = (hex) => new THREE.Color(hex); // sRGB hex -> linear working colour
const COL = {
  moss: C(0x4a6129),
  mossLight: C(0x6a7f34),
  litter: C(0x5e4a30),
  mud: C(0x4a4030),
  rock: C(0x6f6e69),
  rockDark: C(0x504f4b),
  snow: C(0xeef2f6),
  snowShade: C(0xc9d4e0),
  alpine: C(0x6d7055),
};

export function buildTerrain() {
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const slope = 1 - nrm.getY(i);

    const n1 = nDetail(x * 0.035, z * 0.035) * 0.5 + 0.5;
    const n2 = nForest(x * 0.004, z * 0.004) * 0.5 + 0.5;

    // forest floor: moss and needle litter
    c.copy(COL.moss).lerp(COL.litter, smoothstep(0.35, 0.75, n1 * 0.6 + n2 * 0.4));
    c.lerp(COL.mossLight, smoothstep(0.7, 0.95, n1) * 0.5);

    // drier alpine meadow near the snowline
    c.lerp(COL.alpine, smoothstep(SNOWLINE - 50, SNOWLINE - 5, y) * 0.7);

    // muddy lake shore
    c.lerp(COL.mud, 1 - smoothstep(WATER_LEVEL - 1, WATER_LEVEL + 2.5, y));

    // rock on steep faces
    tmp.copy(COL.rock).lerp(COL.rockDark, n1);
    c.lerp(tmp, smoothstep(0.22, 0.42, slope));

    // snow
    const s = snowAmount(x, z, y, slope);
    tmp.copy(COL.snow).lerp(COL.snowShade, n1 * 0.5 + slope);
    c.lerp(tmp, s);

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  // Mottle the vertex colours with a little world-space value noise so the
  // ground doesn't look like flat-shaded polygons up close.
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGroundPos;
        float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x),
                     mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gn = gNoise(vGroundPos.xz * 0.9) * 0.5 + gNoise(vGroundPos.xz * 0.23) * 0.35 + gNoise(vGroundPos.xz * 3.1) * 0.15;
        diffuseColor.rgb *= 0.78 + gn * 0.44;`);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  return mesh;
}

export function buildWater() {
  const geo = new THREE.CircleGeometry(LAKE.r * 1.6, 64);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1d2f33,
    roughness: 0.08,
    metalness: 0.2,
    transparent: true,
    opacity: 0.88,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(LAKE.x, WATER_LEVEL, LAKE.z);
  mesh.scale.z = 1 / 1.4;
  mesh.name = 'lake';
  return mesh;
}
