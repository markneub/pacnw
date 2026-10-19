import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { WORLD_SIZE, TERRAIN_SEGMENTS, WATER_LEVEL, SNOWLINE, SEED } from './config.js';
import { loadTick } from './loadprogress.js';
import { shared, wetChunks, patchSunlight, sunKey, GLITTER_GLSL, patchGlitter, patchPuddles } from './materials.js';
import { SUN_COLOR } from './atmosphere.js';
import { patchGroundDetail, groundDetailCacheKey } from './grounddetail.js';
import { buildStreams } from './streams.js';
import { patchRocky } from './rockyslope.js';

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
 * The high country, north of the valley: a staircase of broad, gentle benches
 * climbing between ridged peaks. Altitude of the stair (before local relief)
 * along z, from the foothills to the pass:
 *   ~50 m foothills (z > 250) → step → the lower snow bench (~150 m, z -420…-680)
 *   → step → the upper basin (~225 m, z -820…-1000) → step → the pass (~280 m, z < -1100).
 * The benches are what you can walk out onto in the snow; the peaks are backdrop.
 */
const STAIR = [
  // [start z, end z (north of start), rise m]
  [250, -260, 70],
  [-290, -420, 75],
  [-680, -820, 75],
  [-1000, -1100, 55],
];
/** The corridor of benches runs up the middle; peaks rise either side of it. */
const BENCH_X = 60;

function highCountry(x, z) {
  let stair = 0;
  for (const [a, b, rise] of STAIR) stair += rise * smoothstep(a, b, z);
  // the corridor wanders a little so the benches aren't a straight avenue
  const cx = BENCH_X + nBase(z * 0.0012, 3.7) * 120;
  const side = Math.abs(x - cx);
  // peaks flank the benches, and close in to the north (and the rim takes over beyond)
  const north = smoothstep(250, -450, z);
  // the walls close in around the high basin (a cirque) and the pass beyond it
  const flank = smoothstep(230, 520, side + smoothstep(-760, -900, z) * 90 + smoothstep(-980, -1250, z) * 140);
  const peaks = north * flank * (60 + ridged(x * 0.0021, z * 0.0021, 5) * 260);
  // gentle relief on the benches themselves (rolls and hollows, no cliffs)
  const relief = north * (1 - flank) * nDetail(x * 0.006 + 11, z * 0.006 - 5) * 7;
  return stair + peaks + relief;
}

let streamNet = null;
/** The streams (streams.js), built on first use from the uncarved terrain. */
export function streams() {
  if (!streamNet) streamNet = buildStreams(baseHeight, { size: WORLD_SIZE, waterLevel: WATER_LEVEL, lake: LAKE });
  return streamNet;
}

/**
 * Terrain height at world (x, z): the landscape (baseHeight) with the stream
 * channels cut into it.
 */
export function heightAt(x, z) {
  return streams().carve(x, z, baseHeight(x, z));
}

/**
 * The landscape before the streams: a low, rolling forested valley in the
 * south (+z) climbing north through a staircase of snowy benches to a pass,
 * between ridged peaks, with the whole map rimmed by mountains so the edges
 * feel natural.
 */
export function baseHeight(x, z) {
  const hills = fbm(nBase, x * 0.0016, z * 0.0016, 5) * 32 + 22;
  const detail = nDetail(x * 0.02, z * 0.02) * 1.2;

  // north: benches, then peaks (the hills fade under the benches so they stay walkable)
  const north = smoothstep(250, -450, z);
  const range = highCountry(x, z);

  // rim: mountains on the east, west and north edges (the south is the sea)
  const edge = Math.max(Math.abs(x), -z);
  const rim = smoothstep(WORLD_SIZE * 0.39, WORLD_SIZE * 0.5, edge);
  const rimH = rim * (140 + ridged(x * 0.003 + 7, z * 0.003 - 3, 4) * 120);

  let h = hills * (1 - 0.6 * north) + range + detail;

  // the coast: the valley runs down through dunes to a beach and the sea; the rim mountains run
  // out into the water as headlands at either end of the beach
  const s = coastZ(x) - z;
  if (s < 360) {
    const w = smoothstep(170, 340, s);
    h = coastProfile(x, z, s) * (1 - w) + h * w;
    h += rimH * smoothstep(-260, 60, s);
  } else h += rimH;

  // lake basin
  const dl = Math.hypot((x - LAKE.x) * 1.0, (z - LAKE.z) * 1.4);
  const wobble = nDetail(x * 0.01, z * 0.01) * 25;
  const basin = 1 - smoothstep(LAKE.r * 0.55, LAKE.r + wobble, dl);
  h = h * (1 - basin) + (WATER_LEVEL - 7) * basin;

  // the marsh on the south-east shore: a flat at lake level, tussocks and hummocks out of the
  // shallow water (the lake's surface covers it)
  // Higher ground eases down to it over ~55 m (within the marsh's own edge, the ground west of it
  // rose 25 m in ~20 m: a smooth curved wall, the user). Lower ground (the lake bed) is only
  // raised inside the marsh itself, or the lake turned to centimetre-deep shallows.
  const b = marshEase(x, z);
  if (b > 0) {
    const m = marshAt(x, z);
    const hummock = m > 0 ? nDetail(x * 0.09 + 3, z * 0.09 - 7) * 0.42 + nDetail(x * 0.3, z * 0.3) * 0.12 : 0;
    const level = WATER_LEVEL - 0.08 + hummock * m;
    const w = h > level ? b : m;
    h = h * (1 - w) + level * w;
  }
  return h;
}

/** Sea level: the ocean along the south edge (the lake sits higher, at WATER_LEVEL). */
export const SEA_LEVEL = 0;
/** z of the shoreline at x: the beach runs east–west across the south of the map, in gentle bays. */
export function coastZ(x) {
  return 1000 + nBase(x * 0.0011, 8.1) * 45 + nDetail(x * 0.0042, 2.2) * 14;
}

/**
 * Height across the coast at distance s inland of the shoreline (negative out to sea): a sandy
 * shelf shoaling gently to the beach, the foreshore (~4%), a flatter dry berm, then a foredune
 * face climbing ~12 m into hummocky back dunes (the inland terrain takes over beyond ~170 m).
 */
function coastProfile(x, z, s) {
  if (s < 0) {
    const o = -s;
    const deep = o * 0.026 + Math.max(0, o - 60) * 0.025 + Math.max(0, o - 250) * 0.03;
    return SEA_LEVEL - Math.min(28, deep) + nDetail(x * 0.02, z * 0.02) * 0.15 * smoothstep(0, 40, o);
  }
  s *= 1 + 0.22 * nBase(x * 0.004 - 3, 17.5); // the beach narrows and widens along the coast
  let h = Math.min(s, 32) * 0.042 + Math.max(0, Math.min(s, 62) - 32) * 0.02;
  const dn = nDetail(x * 0.012 + 31, z * 0.012 - 9);
  h += smoothstep(60 + dn * 12, 125 + dn * 15, s) * (11 + dn * 3);
  // hummocks and blowouts in the back dunes
  h += smoothstep(70, 140, s) * (nDetail(x * 0.035, z * 0.035) * 2.6 + nDetail(x * 0.09 + 5, z * 0.09) * 0.9 + nDetail(x * 0.2 - 3, z * 0.2) * 0.25);
  return h;
}

/** 0..1 open sand: the beach and the dunes, giving way to the forest ~190 m inland (ragged). */
export function sandAt(x, z) {
  const s = coastZ(x) - z;
  if (s > 300) return 0;
  const edge = 190 + nDetail(x * 0.02 + 3, z * 0.02) * 35 + nDetail(x * 0.07, z * 0.07) * 8;
  return 1 - smoothstep(edge - 15, edge + 15, s);
}

/** The marsh: 1 in its flat middle, easing to 0 at its edge (an irregular oval by the lake). */
export const MARSH = { x: 165, z: 478, rx: 62, rz: 30 };
export function marshAt(x, z) {
  // (cheap out first: this runs in every height lookup, and the noise was measurable at load)
  if (Math.abs(x - MARSH.x) > MARSH.rx * 1.3 || Math.abs(z - MARSH.z) > MARSH.rz * 1.3) return 0;
  const d = Math.hypot((x - MARSH.x) / MARSH.rx, (z - MARSH.z) / MARSH.rz) + nDetail(x * 0.03 + 11, z * 0.03) * 0.18;
  return 1 - smoothstep(0.65, 1.0, d);
}

const MARSH_EASE = 55; // m beyond the flat (marshAt = 1) over which the ground rises back to its own height
function marshEase(x, z) {
  const dx = x - MARSH.x;
  const dz = z - MARSH.z;
  if (Math.abs(dx) > MARSH.rx + MARSH_EASE + 15 || Math.abs(dz) > MARSH.rz + MARSH_EASE + 15) return 0;
  const d0 = Math.hypot(dx / MARSH.rx, dz / MARSH.rz);
  const d = d0 + nDetail(x * 0.03 + 11, z * 0.03) * 0.18; // (marshAt's ragged edge)
  const out = (d - 0.65) * (d0 > 1e-6 ? Math.hypot(dx, dz) / d0 : 0); // metres outside the flat
  return 1 - smoothstep(0, MARSH_EASE, out);
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

/** Fill the height grid ahead of buildTerrain, a row at a time, reporting progress (loadprogress.js). */
export async function prepareTerrain() {
  if (grid) return;
  const g = new Float32Array(GRID_N * GRID_N);
  for (let iz = 0; iz < GRID_N; iz++) {
    for (let ix = 0; ix < GRID_N; ix++) {
      g[iz * GRID_N + ix] = heightAt(ix * GRID_STEP - WORLD_SIZE / 2, iz * GRID_STEP - WORLD_SIZE / 2);
    }
    await loadTick((0.7 * iz) / GRID_N);
  }
  grid = g;
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

/** Open sand (sandAt) on the terrain grid, as an R8 texture laid out like the height grid (materials.js uSandMap). */
export function sandMap() {
  const data = new Uint8Array(GRID_N * GRID_N);
  for (let iz = 0; iz < GRID_N; iz++) {
    const z = iz * GRID_STEP - WORLD_SIZE / 2;
    for (let ix = 0; ix < GRID_N; ix++) data[iz * GRID_N + ix] = Math.round(255 * sandAt(ix * GRID_STEP - WORLD_SIZE / 2, z));
  }
  const tex = new THREE.DataTexture(data, GRID_N, GRID_N, THREE.RedFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1; // (rows of 561 bytes)
  tex.needsUpdate = true;
  return tex;
}

/** The raw height grid behind the terrain mesh: heights[iz * n + ix] at (ix * step - WORLD_SIZE / 2, iz * step - WORLD_SIZE / 2). */
export function terrainGrid() {
  return { heights: heightGrid(), n: GRID_N, step: GRID_STEP };
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

// What you stand on: the ground, or a structure over it (the trail's footbridges).
let walkModifier = null;
export function setWalkModifier(fn) {
  walkModifier = fn;
}
/** Height the player stands at: groundAt, raised onto any footbridge deck. */
export function walkAt(x, z) {
  const g = groundAt(x, z);
  return walkModifier ? walkModifier(x, z, g) : g;
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
  sand: C(0xcfc0a0), // pale, warm dune sand, like the Oregon coast
  sandDamp: C(0x9b8f78), // below the reach of the waves
  sandShade: C(0xbcab88),
  sandFirm: C(0xb3a183), // packed by the waves, a little damp
};

const tmpColor = new THREE.Color();

/**
 * Visible snow cover on the ground (0..1) from snowAmount: sharper and patchier
 * than the raw amount, so near the snowline snow lies in irregular patches over
 * the forest floor instead of a pale wash. Shared by the colour and the detail
 * layers so they always agree.
 */
function snowCover(x, z, y, slope) {
  const patch = nDetail(x * 0.035, z * 0.035) * 0.15;
  // snow can't hold on steep rock: faces past ~50° shed it and show dark ribs, with snow left in
  // the gullies (finer noise). Visual only: snowAmount (trees, weather) is unchanged.
  const ribs = nDetail(x * 0.09 + 17, z * 0.09 - 5) * 0.12 + patch * 0.5;
  return smoothstep(0.3, 0.65, snowAmount(x, z, y, slope) + patch) * (1 - smoothstep(0.4, 0.56, slope + ribs));
}

/** The open water's level at (x, z): the lake's, or a pond's where one lies (compare with the ground). */
export function waterLevelAt(x, z) {
  if (coastZ(x) - z < 220) return SEA_LEVEL; // the coast: the sea (the lake is far inland)
  return Math.max(WATER_LEVEL, streams().pondLevel(x, z));
}

/**
 * The level of open water you'd be standing in at (x, z) (the lake, a pond or the sea), or
 * -Infinity where there's none. Unlike waterLevelAt, only where water is actually drawn.
 */
export function openWaterLevel(x, z) {
  if (coastZ(x) - z < 75) return SEA_LEVEL;
  if (Math.hypot(x - LAKE.x, (z - LAKE.z) * 1.4) < LAKE.r * 1.6) return WATER_LEVEL;
  return streams().pondLevel(x, z);
}

/** 0..1: the stream bed and its wet, stony margin (1 in the channel, fading over the lower bank). */
export function streamBed(x, z) {
  const c = streams().nearest(x, z);
  return c.seg ? 1 - smoothstep(c.half + 0.5, c.half + 3.5, c.d) : 0;
}

/**
 * How much of each ground surface a point is, for close-up detail textures:
 * [forest floor, rock, snow, mud/dirt], summing to 1. Mirrors groundColor().
 */
export function groundLayers(x, y, z, slope, out = [0, 0, 0, 0]) {
  const bed = streamBed(x, z);
  const snow = snowCover(x, z, y, slope) * (1 - bed); // running water keeps its bed clear of snow
  const rock = Math.max(smoothstep(0.42, 0.62, slope), bed) * (1 - snow);
  const sand = sandAt(x, z) * (1 - rock) * (1 - snow);
  const wl = waterLevelAt(x, z);
  const mud = (1 - smoothstep(wl - 1, wl + 2.5, y)) * (1 - rock) * (1 - snow) * (1 - sand);
  out[0] = Math.max(0, 1 - snow - rock - mud - sand);
  out[1] = rock;
  // (one slot: grounddetail.js shows snow up high and sand at the coast). The lower beach is firm,
  // smooth, wave-packed sand: little of the trampled photo there (the rest of the weight is plain)
  out[2] = snow + sand * (0.25 + 0.75 * smoothstep(SEA_LEVEL + 1.6, SEA_LEVEL + 3.2, y));
  out[3] = mud;
  return out;
}

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
  const wl = waterLevelAt(x, z);
  const sand = sandAt(x, z);
  c.lerp(COL.mud, (1 - smoothstep(wl - 1, wl + 2.5, y)) * (1 - sand));

  // the beach and dunes: pale sand, damp and darker where the waves reach (and under the sea)
  if (sand > 0) {
    tmp.copy(COL.sand).lerp(COL.sandShade, n1 * 0.6);
    tmp.lerp(COL.sandFirm, 1 - smoothstep(SEA_LEVEL + 1.4, SEA_LEVEL + 2.6, y)); // the firm lower beach: tan
    tmp.lerp(COL.sandDamp, 1 - smoothstep(SEA_LEVEL + 0.4, SEA_LEVEL + 1.3, y));
    c.lerp(tmp, sand);
  }

  // rock on cliffs (on merely steep ground the shader breaks it into outcrops: rockyslope.js)
  tmp.copy(COL.rock).lerp(COL.rockDark, n1);
  c.lerp(tmp, smoothstep(0.42, 0.62, slope));

  // stream beds: wet, dark cobbles, no snow
  const bed = streamBed(x, z);
  tmp.copy(COL.rockDark).lerp(COL.mud, 0.35 + 0.3 * n1).multiplyScalar(0.8);
  c.lerp(tmp, bed);

  // snow
  const s = snowCover(x, z, y, slope) * (1 - bed);
  tmp.copy(COL.snow).lerp(COL.snowShade, n1 * 0.5 + slope);
  c.lerp(tmp, s);
  return c;
}

// The terrain hides itself wherever the trail corridor mesh takes over
// (grass.js uses the same mask to keep blades off the trail).
export const cutUniforms = {
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
  const layers = new Float32Array(n * n * 4);
  const hollow = new Float32Array(n * n);
  const lw = [0, 0, 0, 0];
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
      layers.set(groundLayers(x, y, z, 1 - nv.y, lw), (j * n + i) * 4);
      // where rain pools: flat, concave forest floor or mud (not rock, snow, stream beds or the lake)
      const lap = (h(ix - 1, iz) + h(ix + 1, iz) + h(ix, iz - 1) + h(ix, iz + 1)) / 4 - y;
      hollow[j * n + i] = smoothstep(0.02, 0.3, lap) * (1 - smoothstep(0.004, 0.012, 1 - nv.y))
        * (lw[0] + lw[3]) * smoothstep(waterLevelAt(x, z) + 0.3, waterLevelAt(x, z) + 1.2, y);
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
  geo.setAttribute('aLayers', new THREE.BufferAttribute(layers, 4));
  geo.setAttribute('aHollow', new THREE.BufferAttribute(hollow, 1));
  geo.setAttribute('aShade', new THREE.BufferAttribute(new Float32Array(n * n).fill(1), 1));
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
    patchSunlight(shader);
    shader.uniforms.uWet = shared.uWet;
    shader.uniforms.uPuddle = shared.uPuddle;
    shader.uniforms.uGrassMap = shared.uGrassMap;
    shader.uniforms.uGrassTint = shared.uGrassTint;
    shader.uniforms.uGrassGrid = shared.uGroundGrid;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHollow;\nvarying float vHollow;\nvarying vec3 vGroundPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvHollow = aHollow;\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGroundPos;
        varying float vHollow;
        uniform float uWet;
        uniform float uPuddle;
        float puddle;
        uniform sampler2D uCutMask;
        uniform vec4 uCutRect;
        uniform sampler2D uGrassMap;
        uniform vec2 uGrassTint;
        uniform vec4 uGrassGrid;
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
        {
          // distant grass: as the tufts (grass.js) shrink away with distance, the ground takes on
          // their colour by their density, so grassy places stay grassy instead of popping
          float gFar = smoothstep(uGrassTint.x, uGrassTint.y, distance(vGroundPos.xz, cameraPosition.xz));
          if (gFar > 0.0) {
            vec4 gm = texture2D(uGrassMap, ((vGroundPos.xz - uGrassGrid.xy) / uGrassGrid.z + 0.5) / uGrassGrid.w);
            diffuseColor.rgb = mix(diffuseColor.rgb, gm.rgb * (0.68 + 0.2 * gn), gm.a * 0.85 * gFar * (1.0 - rkMask));
          }
          // patches over the vegetated ground at every distance: drier, straw-coloured stretches,
          // lusher hollows and dark clumps of low shrubs (an open slope was one flat green)
          float pv = gNoise(vGroundPos.xz * 0.045 + 3.0) * 0.6 + gNoise(vGroundPos.xz * 0.13 + 4.0) * 0.4;
          vec3 patchTint = mix(vec3(0.82, 0.93, 0.76), vec3(1.22, 1.1, 0.78), smoothstep(0.32, 0.72, pv));
          float shrub = smoothstep(0.52, 0.72, gNoise(vGroundPos.xz * 0.55 + 2.0) * 0.7 + gNoise(vGroundPos.xz * 1.9) * 0.3);
          patchTint *= 1.0 - 0.38 * shrub * smoothstep(0.3, 0.6, gNoise(vGroundPos.xz * 0.07 - 6.0)); // (vegetation.js addSlopeGrowth puts shrubs here)
          diffuseColor.rgb *= mix(vec3(1.0), patchTint, vRkLayers.x * (1.0 - rkMask));
        }
        ${wet.color}
        // rain pools in hollows, filling from the deepest spot out as uPuddle rises
        puddle = 0.0;
        if (vHollow > 0.01 && uPuddle > 0.01) {
          float pd = vHollow * (0.7 + 0.3 * gNoise(vGroundPos.xz * 0.31 + 5.3)) + (gNoise(vGroundPos.xz * 1.4) - 0.5) * 0.18;
          float pt = 1.0 - 0.55 * uPuddle;
          puddle = smoothstep(pt, pt + 0.04, pd);
          diffuseColor.rgb *= mix(1.0, 0.45, puddle);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        ${wet.roughness}
        roughnessFactor = mix(roughnessFactor, 0.05, puddle);`);
    patchGroundDetail(shader);
    patchRocky(shader);
    patchPuddles(shader);
  };
  mat.customProgramCacheKey = () => `${groundDetailCacheKey()}|${sunKey()}`;

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
  // Wave normals: two slow swell layers plus expanding rain rings while it
  // rains. The reflection itself comes from the scene's environment map.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWet = shared.uWet;
    shader.uniforms.uRain = shared.uRain;
    shader.uniforms.uShoreGround = shared.uGroundH;
    shader.uniforms.uShoreGrid = shared.uGroundGrid;
    patchGlitter(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWaterXZ;\nvarying float vWaterY;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterXZ = (modelMatrix * vec4(transformed, 1.0)).xz;\nvWaterY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uWet;
        uniform float uRain;
        varying vec2 vWaterXZ;
        varying float vWaterY;
        ${GLITTER_GLSL}
        uniform highp sampler2D uShoreGround;
        uniform vec4 uShoreGrid; // min x, min z, step, n
        float shoreLine = 0.0; // the thin wet glint where the water meets the shore
        float wHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float wNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = p - i;
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        // the rendered terrain's height under this point (same grid and triangulation as groundAt)
        float shoreGround(vec2 xz) {
          vec2 g = clamp((xz - uShoreGrid.xy) / uShoreGrid.z, vec2(0.0), vec2(uShoreGrid.w - 1.0001));
          ivec2 i = ivec2(floor(g));
          vec2 f = g - vec2(i);
          float ha = texelFetch(uShoreGround, i, 0).r;
          float hb = texelFetch(uShoreGround, i + ivec2(0, 1), 0).r;
          float hc = texelFetch(uShoreGround, i + ivec2(1, 1), 0).r;
          float hd = texelFetch(uShoreGround, i + ivec2(1, 0), 0).r;
          return f.x + f.y <= 1.0 ? ha + (hd - ha) * f.x + (hb - ha) * f.y
            : hc + (hb - hc) * (1.0 - f.x) + (hd - hc) * (1.0 - f.y);
        }
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
      .replace('#include <color_fragment>', `#include <color_fragment>
        // marsh water: shallow, still and stained brown with tannins from the peat
        float mw = 1.0 - smoothstep(0.55, 1.0, length((vWaterXZ - vec2(${MARSH.x.toFixed(1)}, ${MARSH.z.toFixed(1)})) / vec2(${MARSH.rx.toFixed(1)}, ${MARSH.rz.toFixed(1)})));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.021, 0.01), mw * 0.9);
        {
          // The shore. The terrain's 5 m triangles cut the flat water along straight lines, so the
          // water ends a little before that, where it is (noisy) 3–30 cm deep: a ragged, wandering
          // waterline that laps slowly up and back. Shallows are clearer and take the bed's colour,
          // with a faint wet glint along the edge.
          float depth = vWaterY - shoreGround(vWaterXZ);
          float en = wNoise(vWaterXZ * 0.45) * 0.6 + wNoise(vWaterXZ * 1.7 + 11.0) * 0.3 + wNoise(vWaterXZ * 6.0 + 5.0) * 0.1;
          float edge = 0.03 + 0.27 * en + 0.025 * sin(uTime * 0.7 + en * 9.0);
          edge = mix(edge, 0.005 + 0.03 * en, mw); // the marsh is only ~8 cm deep between the tussocks
          float wet = smoothstep(edge, edge + 0.05, depth);
          if (wet < 0.01) discard;
          float shallow = smoothstep(edge, edge + 0.9, depth);
          diffuseColor.rgb = mix(vec3(0.05, 0.045, 0.03), diffuseColor.rgb, shallow);
          diffuseColor.a *= wet * mix(0.45, 1.0, shallow);
          shoreLine = exp(-pow((depth - edge - 0.03) * 40.0, 2.0)) * wNoise(vWaterXZ * 3.0 + uTime * 0.3) * (1.0 - mw);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vWaterXZ;
          vec2 g = vec2(cos(p.x * 0.31 + uTime * 0.8), cos(p.y * 0.27 - uTime * 0.65)) * 0.035
                 + vec2(cos(p.x * 1.1 + p.y * 0.6 + uTime * 1.9), cos(p.y * 0.9 - p.x * 0.4 + uTime * 1.6)) * 0.018;
          g += (rainRing(p * 0.9, uTime) + rainRing(p * 1.3 + 17.0, uTime * 1.1)) * 0.35 * uRain;
          vec3 nWorld = normalize(vec3(-g.x, 1.0, -g.y));
          normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
        }`)
      // The environment map is the load-time overcast sky: no shore, no sun
      // break. Reflect an analytic scene instead: the far shore's treeline
      // (dark, fogged, with jagged spire tops), faint ridges above it, then sky.
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #ifdef USE_FOG
        {
          vec3 wV = normalize(vViewPosition);
          vec3 rW = (vec4(reflect(-wV, normal), 0.0) * viewMatrix).xyz; // world space
          float az = atan(rW.z, rW.x);
          float e = rW.y;
          float n1 = wHash(vec2(floor(az * 60.0), 3.0));
          float n2 = wHash(vec2(floor(az * 60.0) + 1.0, 3.0));
          float spires = mix(n1, n2, smoothstep(0.0, 1.0, fract(az * 60.0)));
          float treeTop = 0.07 + 0.06 * spires + 0.04 * sin(az * 5.0 + 1.3);
          float ridge = 0.16 + 0.07 * sin(az * 3.0 + 0.5) + 0.03 * sin(az * 11.0);
          vec3 haze = fogColor;
          vec3 sky = haze * (1.05 + 0.35 * smoothstep(0.0, 0.6, e));
          vec3 hills = mix(haze * 0.82, sky, 0.25);
          vec3 shore = mix(vec3(0.018, 0.03, 0.022), haze * 0.55, 0.45);
          vec3 refl = e < treeTop ? shore : (e < ridge ? hills : sky);
          // a soft edge so the bands don't alias
          refl = mix(shore, refl, smoothstep(treeTop - 0.01, treeTop + 0.01, e));
          float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(normal, wV), 0.0, 1.0), 5.0);
          reflectedLight.indirectSpecular = refl * fres * 1.15;
          reflectedLight.indirectSpecular += fogColor * shoreLine * 0.15;
          // sun glitter (calm open water: a moderate wave-slope spread; rain roughens it)
          vec3 glP = vec3(vWaterXZ.x, vWaterY, vWaterXZ.y);
          reflectedLight.indirectSpecular += ${'vec3(' + [SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b].map((v) => v.toFixed(3)).join(', ') + ')'} * glitter(glP, normalize(cameraPosition - glP), 0.16 + 0.06 * uWet);
        }
        #endif`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(LAKE.x, WATER_LEVEL, LAKE.z);
  mesh.scale.z = 1 / 1.4;
  mesh.name = 'lake water';
  const group = new THREE.Group();
  group.name = 'lake';
  group.add(mesh);
  // ponds where a stream ends in a closed basin (streams.js): the pond's grid cells plus a ring
  // around them, at its level; the terrain hides what lies over dry ground
  for (const p of streams().ponds) {
    const pos = [];
    const s = p.cell / 2;
    const cells = new Set();
    for (const [x, z] of p.cells) for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) cells.add(`${x + dx * p.cell},${z + dz * p.cell}`);
    for (const c of cells) {
      const [x, z] = c.split(',').map(Number);
      pos.push(x - s, 0, z - s, x - s, 0, z + s, x + s, 0, z + s, x - s, 0, z - s, x + s, 0, z + s, x + s, 0, z - s);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const pond = new THREE.Mesh(g, mat);
    pond.position.y = p.level;
    pond.name = 'pond';
    group.add(pond);
  }
  return group;
}
