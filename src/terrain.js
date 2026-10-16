import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { WORLD_SIZE, TERRAIN_SEGMENTS, WATER_LEVEL, SNOWLINE, SEED } from './config.js';
import { shared, wetChunks } from './materials.js';

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

// Heights at the terrain mesh vertices, so groundAt() can return the height of
// the rendered (triangulated) surface rather than the smooth noise function.
const GRID_N = TERRAIN_SEGMENTS + 1;
const GRID_STEP = WORLD_SIZE / TERRAIN_SEGMENTS;
let grid = null;

function heightGrid() {
  if (grid) return grid;
  grid = new Float32Array(GRID_N * GRID_N);
  for (let iz = 0; iz < GRID_N; iz++) {
    for (let ix = 0; ix < GRID_N; ix++) {
      grid[iz * GRID_N + ix] = heightAt(ix * GRID_STEP - WORLD_SIZE / 2, iz * GRID_STEP - WORLD_SIZE / 2);
    }
  }
  return grid;
}

/**
 * Height of the terrain mesh surface at (x, z). Matches PlaneGeometry's
 * triangulation (diagonal from (ix, iz+1) to (ix+1, iz)), so things placed with
 * it sit exactly on the ground instead of floating or sinking between vertices.
 * Ignores the trail's bench cut; use groundAt() for the walkable surface.
 */
export function rawGroundAt(x, z) {
  const g = heightGrid();
  const gx = THREE.MathUtils.clamp((x + WORLD_SIZE / 2) / GRID_STEP, 0, TERRAIN_SEGMENTS - 1e-4);
  const gz = THREE.MathUtils.clamp((z + WORLD_SIZE / 2) / GRID_STEP, 0, TERRAIN_SEGMENTS - 1e-4);
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const ha = g[iz * GRID_N + ix];
  const hb = g[(iz + 1) * GRID_N + ix];
  const hc = g[(iz + 1) * GRID_N + ix + 1];
  const hd = g[iz * GRID_N + ix + 1];
  if (fx + fz <= 1) return ha + (hd - ha) * fx + (hb - ha) * fz;
  return hc + (hb - hc) * (1 - fx) + (hd - hc) * (1 - fz);
}

// The trail registers a modifier that cuts its level bench into the hillside.
let groundModifier = null;

/** Lets the trail reshape the ground: fn(x, z, rawHeight) -> height. */
export function setGroundModifier(fn) {
  groundModifier = fn;
}

/** Height of the walkable, rendered ground at (x, z), including the trail cut. */
export function groundAt(x, z) {
  const g = rawGroundAt(x, z);
  return groundModifier ? groundModifier(x, z, g) : g;
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

const tmpColor = new THREE.Color();

/**
 * Ground colour (linear) for a point at altitude y with the given slope
 * (0 flat .. 1 vertical): moss, litter, alpine meadow, mud, rock and snow.
 */
export function groundColor(x, y, z, slope, target = new THREE.Color()) {
  const c = target;
  const tmp = tmpColor;
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
  return c;
}

// The terrain hides itself wherever the trail corridor mesh takes over.
const cutUniforms = {
  uCutMask: { value: new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat) },
  uCutRect: { value: new THREE.Vector4(0, 0, 1, 1) }, // minX, minZ, sizeX, sizeZ
};
cutUniforms.uCutMask.value.needsUpdate = true;

/** mask: R8 texture covering rect (minX, minZ, sizeX, sizeZ); >0.5 = hidden. */
export function setTerrainCutout(mask, minX, minZ, sizeX, sizeZ) {
  cutUniforms.uCutMask.value = mask;
  cutUniforms.uCutRect.value.set(minX, minZ, sizeX, sizeZ);
}

const TILES = 8; // per side; each tile is culled on its own

/**
 * One terrain tile straight from the height grid. Same triangulation as
 * PlaneGeometry (diagonal (ix, iz+1)-(ix+1, iz)), so groundAt() stays exact,
 * and normals come from the shared grid so tiles meet without shading seams.
 */
function buildTile(tx, tz) {
  const g = heightGrid();
  const seg = TERRAIN_SEGMENTS / TILES;
  const ix0 = tx * seg;
  const iz0 = tz * seg;
  const n = seg + 1;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const h = (ix, iz) => g[Math.min(GRID_N - 1, Math.max(0, iz)) * GRID_N + Math.min(GRID_N - 1, Math.max(0, ix))];
  const c = new THREE.Color();
  const nv = new THREE.Vector3();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ix = ix0 + i;
      const iz = iz0 + j;
      const k = (j * n + i) * 3;
      const x = ix * GRID_STEP - WORLD_SIZE / 2;
      const z = iz * GRID_STEP - WORLD_SIZE / 2;
      const y = h(ix, iz);
      positions[k] = x;
      positions[k + 1] = y;
      positions[k + 2] = z;
      nv.set(h(ix - 1, iz) - h(ix + 1, iz), 2 * GRID_STEP, h(ix, iz - 1) - h(ix, iz + 1)).normalize();
      normals[k] = nv.x;
      normals[k + 1] = nv.y;
      normals[k + 2] = nv.z;
      groundColor(x, y, z, 1 - nv.y, c);
      colors[k] = c.r;
      colors[k + 1] = c.g;
      colors[k + 2] = c.b;
    }
  }
  const index = [];
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * n + i;
      const b = (j + 1) * n + i;
      const cc = (j + 1) * n + i + 1;
      const d = j * n + i + 1;
      index.push(a, b, d, b, cc, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  return geo;
}

export function buildTerrain() {

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  // Mottle the vertex colours with a little world-space value noise so the
  // ground doesn't look like flat-shaded polygons up close.
  const wet = wetChunks(0.9);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, cutUniforms);
    shader.uniforms.uWet = shared.uWet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGroundPos;
        uniform float uWet;
        uniform sampler2D uCutMask;
        uniform vec4 uCutRect;
        float gHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float gNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x),
                     mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 cutUv = (vGroundPos.xz - uCutRect.xy) / uCutRect.zw;
        if (all(greaterThan(cutUv, vec2(0.0))) && all(lessThan(cutUv, vec2(1.0)))
            && texture2D(uCutMask, cutUv).r > 0.5) discard;
        float gn = gNoise(vGroundPos.xz * 0.9) * 0.5 + gNoise(vGroundPos.xz * 0.23) * 0.35 + gNoise(vGroundPos.xz * 3.1) * 0.15;
        diffuseColor.rgb *= 0.78 + gn * 0.44;
        ${wet.color}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        ${wet.roughness}`);
  };

  const group = new THREE.Group();
  group.name = 'terrain';
  for (let tz = 0; tz < TILES; tz++) {
    for (let tx = 0; tx < TILES; tx++) {
      const tile = new THREE.Mesh(buildTile(tx, tz), mat);
      tile.name = `terrain ${tx},${tz}`;
      group.add(tile);
    }
  }
  return group;
}

export function buildWater() {
  const geo = new THREE.CircleGeometry(LAKE.r * 1.6, 64);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x16262a,
    roughness: 0.06,
    metalness: 0.0,
    envMapIntensity: 1.6,
    transparent: true,
    opacity: 0.92,
  });
  // Wave normals: two slow swell layers plus expanding rain rings, scaled by
  // wetness. The reflection itself comes from the scene's environment map.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWet = shared.uWet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWaterXZ;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uWet;
        varying vec2 vWaterXZ;
        float wHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        vec2 rainRing(vec2 p, float t) {
          vec2 cell = floor(p);
          vec2 f = fract(p) - 0.5;
          float h = wHash(cell);
          float ph = fract(t * 0.8 + h * 7.0);
          vec2 c = (vec2(wHash(cell + 3.1), wHash(cell + 7.7)) - 0.5) * 0.5;
          vec2 d = f - c;
          float r = length(d) + 1e-4;
          float ring = exp(-pow((r - ph * 0.45) * 22.0, 2.0)) * (1.0 - ph);
          return d / r * ring;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vWaterXZ;
          vec2 g = vec2(cos(p.x * 0.31 + uTime * 0.8), cos(p.y * 0.27 - uTime * 0.65)) * 0.035
                 + vec2(cos(p.x * 1.1 + p.y * 0.6 + uTime * 1.9), cos(p.y * 0.9 - p.x * 0.4 + uTime * 1.6)) * 0.018;
          g += (rainRing(p * 0.9, uTime) + rainRing(p * 1.3 + 17.0, uTime * 1.1)) * 0.35 * uWet;
          vec3 nWorld = normalize(vec3(-g.x, 1.0, -g.y));
          normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
        }`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(LAKE.x, WATER_LEVEL, LAKE.z);
  mesh.scale.z = 1 / 1.4;
  mesh.name = 'lake';
  return mesh;
}
