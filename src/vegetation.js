import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  WORLD_SIZE, CHUNK_SIZE, VIEW_DIST, WATER_LEVEL, SNOWLINE, TREELINE, SEED, SPAWN,
} from './config.js';
import {
  heightAt, groundAt, slopeAt, snowAmount, snowlineAt, nForest, mulberry32,
} from './terrain.js';
import { TRAIL_WIDTH } from './trail.js';
import { addWindSway, addGroundCover, addTrunkMoss, shared } from './materials.js';
import { bakePrototypeAO, bakeCanopy } from './bake.js';
import { NearPool } from './detail.js';
import { addSurfaceDetail, surfaceLayerFor } from './surfacedetail.js';
import { bakeImpostors, impostorGeometry, impostorMaterial } from './impostors.js';

const KIND = (name) => (/^(fern|salal|pebbles)/.test(name) ? 'ferns'
  : /^(boulder|log|stump|signpost|cairn|bench)/.test(name) ? 'rocks' : 'trees');

/** Deterministic 0..1 hash of a position (for choices that mustn't consume scatter rng). */
function hash2(x, z) {
  let h = Math.imul(Math.round(x * 100) | 0, 374761393) ^ Math.imul(Math.round(z * 100) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Nurse log (blender/build_assets.py nurse_log): length, base radius, axis height above ground (radii), lying along local X. */
const NURSE = { length: 18, r0: 1.1, sink: 0.72, plate: 1.1 * 2.5 };
/** Radius and top height (above its origin) of the nurse log at u = 0 (root end) .. 1 (broken end), at scale 1. */
const nurseAt = (u) => {
  const r = NURSE.r0 * (1 - 0.32 * u);
  return { r, top: r * NURSE.sink - 0.15 * Math.sin(u * Math.PI) + r };
};

/** Scanned boulders (blender/build_rocks.py). The same random draw picks one, so the scatter is unchanged. */
const BOULDERS = ['boulder_a', 'boulder_b', 'boulder_c', 'boulder_d', 'boulder_e', 'boulder_f', 'boulder_g', 'boulder_h', 'boulder_i'];

/** How far out a near pool must hold instances: trees also cover the crossfade band. */
const poolRadius = (key) => VIEW_DIST[key] + (key === 'treeDetail' ? shared.uLodBand.value : 0);

/** Collision radius (m, at scale 1) for a model without a COLLIDE entry: most of its narrower half-width. */
const footprint = (parts) => {
  const box = new THREE.Box3();
  for (const { geometry } of parts) {
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
  }
  return 0.4 * Math.min(box.max.x - box.min.x, box.max.z - box.min.z);
};

/** Numeric spatial-hash key (no string garbage in per-frame lookups). */
const cellKey = (gx, gz) => (gx + 32768) * 65536 + (gz + 32768);

// Trunk radius (m, at scale 1) used for walking collisions.
const COLLIDE = {
  fir: 0.75, fir_snow: 0.75, hemlock: 0.6, hemlock_snow: 0.6, cedar: 1.1,
  sapling: 0.25, sapling_snow: 0.25, snag: 0.65, vine_maple: 0.3,
  stump: 1.0, // boulders: from their footprint (buildVegetation)
  signpost: 0.25, cairn: 0.6, bench: 0.9,
};

/**
 * Load the model files (forest.glb, rocks.glb) and turn each top-level node
 * into a list of {geometry, material}. A node with a `<name>_lod` partner gets
 * two tiers: the full model for the near pool, the _lod one for far chunks.
 */
export async function loadPrototypes(urls) {
  const loader = new GLTFLoader();
  const scenes = await Promise.all(urls.map((url) => loader.loadAsync(url)));
  const roots = scenes.flatMap((gltf) => {
    gltf.scene.updateMatrixWorld(true);
    return [...gltf.scene.children];
  });
  const names = new Set(roots.map((r) => r.name));
  const materialCache = new Map();
  const protos = {};

  for (const root of roots) {
    const parts = [];
    const rootInv = root.matrixWorld.clone().invert();
    const lod = root.name.endsWith('_lod') ? 'far' : names.has(`${root.name}_lod`) ? 'near' : null;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const geometry = o.geometry.clone();
      geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld));
      geometry.computeBoundingSphere();
      parts.push({ geometry, material: convertMaterial(o.material, root.name, lod, materialCache) });
    });
    bakePrototypeAO(parts, KIND(root.name));
    protos[root.name] = parts;
  }
  return protos;
}

/**
 * Alpha-tested foliage cards: both faces shaded with the card's own normal
 * (three would flip it per face, which is arbitrary for cards), darkened where
 * you see the side facing away from that normal (crown undersides), and alpha
 * boosted with the mip level so sprays don't thin out
 * and vanish with distance (averaged alpha drops below the test threshold).
 */
function patchCards(mat) {
  const snow = mat.name === 'SnowCards';
  const moss = mat.name === 'MossCards';
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <alphatest_fragment>', `
        #ifdef USE_MAP
        {
          vec2 cardTexel = vMapUv * vec2(textureSize(map, 0));
          float cardMip = max(0.0, 0.5 * log2(max(dot(dFdx(cardTexel), dFdx(cardTexel)), dot(dFdy(cardTexel), dFdy(cardTexel)))));
          // snow and moss strands cover little of their cards: boosting them would turn
          // distant cards into white slabs / pale paper tags
          diffuseColor.a *= 1.0 + cardMip * ${snow ? '0.12' : moss ? '0.05' : '0.3'};
        }
        #endif
        #include <alphatest_fragment>`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vNormal);
        // the side of a spray facing away from its (outward, up) normal is the
        // underside: seen from below, crowns should be darker, not sky-lit
        // (snow from below: you'd see the dark branch under it, not white)
        {
          vec3 cardV = normalize(vViewPosition);
          float cardD = dot(normal, cardV);
          diffuseColor.rgb *= mix(${snow ? '0.22' : '0.6'}, 1.0, smoothstep(-0.35, 0.2, cardD));
          // seen from behind, mirror the normal toward the viewer (keeping its up/out
          // tilt): with N.V < 0 the specular term blows up and bleaches the spray
          if (cardD < 0.0) normal = normalize(normal - 2.0 * cardD * cardV);
        }`)
      // needles are matte: grazing-angle Fresnel off a low sun made sprays grey-white
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.directSpecular *= 0.15;
        // wet leaves pick up a soft sheen of the sky
        reflectedLight.indirectSpecular *= 0.35 + 0.45 * uWet;
        #if defined(SUN_VIS) && NUM_DIR_LIGHTS > 0 && ${snow ? 0 : 1}
        {
          // backlight: thin leaves glow when you look toward the sun through them
          // (in a sun break, where the canopy lets the sun through)
          float back = max(dot(-normalize(vViewPosition), directionalLights[0].direction), 0.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color
            * vec3(1.0, 1.0, 0.6) * (back * back * back * back * 0.75 * uSun * sunVis);
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}|cards${snow ? 's' : moss ? 'm' : ''}`;
}

/** Colour multiplier per foliage-card material. */
const CARD_TINT = {
  FirCards: [0.55, 0.6, 0.52],
  HemlockCards: [0.68, 0.72, 0.66],
  CedarCards: [0.5, 0.56, 0.46],
  // up high: frostier, bluer needles under the snow
  FirFrostCards: [0.46, 0.56, 0.56],
  HemlockFrostCards: [0.56, 0.66, 0.66],
  SnowCards: [0.95, 0.97, 1.0],
  FernCards: [0.8, 0.85, 0.74],
  MossCards: [0.55, 0.58, 0.5],
  SalalCards: [0.72, 0.76, 0.68],
  MapleCards: [0.62, 0.7, 0.5],
};

// Scanned-rock materials waiting for their textures (applyRockTextures).
const scanMaterials = [];

function convertMaterial(src, assetName, lod, cache) {
  const kind = KIND(assetName);
  const swapXY = assetName.startsWith('log'); // lies along X: run the bark furrows along it
  const scan = src.name.startsWith('ScanRock');
  const cards = src.name.endsWith('Cards');
  const pebble = assetName.startsWith('pebbles'); // near-pool ground clutter, but stone: no sway, no double-sided
  const key = `${src.name}|${kind}|${lod}|${swapXY}`;
  if (cache.has(key)) return cache.get(key);

  const mat = new THREE.MeshStandardMaterial({
    name: src.name,
    // scans: plain grey until their photo arrives (applyRockTextures)
    color: scan ? new THREE.Color(0.3, 0.3, 0.29) : src.color.clone(),
    roughness: src.roughness ?? 0.9,
    metalness: 0,
    // bark is smooth so trunks read as round; scans have real smooth surfaces;
    // foliage cards carry their own (outward-pointing) normals
    flatShading: !src.name.endsWith('Bark') && !src.name.endsWith('Soil') && !scan && !cards,
    side: (kind === 'ferns' && !pebble) || cards ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (cards) {
    mat.map = src.map; // the needle spray (RGBA, embedded in the GLB)
    mat.alphaTest = 0.5;
    // the spray textures are painted bright; deepen them to each species' green
    // so they sit together (the impostor bake reads this colour too)
    mat.color.setRGB(...(CARD_TINT[src.name] ?? [0.6, 0.6, 0.6]));
  }
  // needles shed water and scatter light: keep sky reflections off foliage
  if (/Needles|Foliage|Fern|Cards/.test(src.name)) mat.envMapIntensity = 0.35;
  if (kind === 'trees') addWindSway(mat, undefined, undefined, lod);
  else if (kind === 'ferns' && !pebble) addWindSway(mat, 2.5, undefined, 'fade');
  // scans have their own moss; pebbles are never placed on snow (and the shader's global snowline frosted them white)
  else addGroundCover(mat, { lod: pebble ? 'fade' : lod, moss: scan ? 0.35 : pebble ? 0.6 : 1, snow: pebble ? 0 : 1 });
  if (cards) patchCards(mat);
  // moss sleeves on valley trunks (near tier; impostors bake the plain bark colour)
  if (kind === 'trees' && lod !== 'far' && (src.name === 'Bark' || src.name === 'CedarBark')) addTrunkMoss(mat);
  // close-up bark / rock photos (not on far tiers: they're never close).
  // On scans the tiling lichen is only a fine grain over their own photo.
  const layer = surfaceLayerFor(src.name);
  if (layer && lod !== 'far') addSurfaceDetail(mat, layer, { swapXY, amount: scan ? 0.3 : 1 });
  if (scan) scanMaterials.push({ mat, set: `scan${src.name.slice(-1)}`, near: lod !== 'far' });
  cache.set(key, mat);
  return mat;
}

/**
 * Give the scanned rocks their photo (both tiers) and baked normal map (near
 * tier only; far away it's sub-pixel). Call before the warm-up compiles them.
 */
export function applyRockTextures(layers) {
  if (!layers) return;
  const byName = Object.fromEntries(layers.map((l) => [l.name, l]));
  for (const { mat, set, near } of scanMaterials) {
    const tex = byName[set];
    if (!tex) continue;
    mat.color.setRGB(1, 1, 1);
    mat.map = tex.alb;
    if (near) mat.normalMap = tex.nrm; // tangent-space, with the GLB's tangents
    mat.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------

/** Signposts at each stop, a bench at the lake, cairns along the snowy section. */
function placeTrailFurniture(trail, add) {
  const { points, stops } = trail;
  const tangent = (i) => {
    const a = points[Math.max(0, i - 2)];
    const b = points[Math.min(points.length - 1, i + 2)];
    return new THREE.Vector2(b.x - a.x, b.y - a.y).normalize();
  };
  const beside = (i, offset) => {
    const t = tangent(i);
    const p = points[i];
    return { x: p.x - t.y * offset, z: p.y + t.x * offset, t };
  };
  const put = (name, x, z, rotY) => add(name, { x, y: groundAt(x, z), z, rotY, scale: 1, tint: 0.5 });

  for (const stop of stops) {
    // boards point along local +X; rotate that onto the trail direction
    const i = Math.min(stop.index + 3, points.length - 3);
    const { x, z, t } = beside(i, TRAIL_WIDTH + 0.6);
    put('signpost', x, z, Math.atan2(-t.y, t.x));
  }

  const lake = stops.find((s) => s.name === 'lake');
  if (lake) {
    // bench on whichever side is lower (the water side), facing away from the
    // trail; the bench model faces local +Z
    let best = null;
    for (const side of [1, -1]) {
      const c = beside(lake.index, side * (TRAIL_WIDTH + 1.4));
      const h = groundAt(c.x, c.z);
      if (!best || h < best.h) best = { ...c, h, side };
    }
    const fx = -best.t.y * best.side;
    const fz = best.t.x * best.side;
    put('bench', best.x, best.z, Math.atan2(fx, fz));
  }

  let side = 1;
  for (let i = 0; i < points.length; i += 30) {
    const p = points[i];
    if (groundAt(p.x, p.y) < snowlineAt(p.x, p.y) - 15) continue;
    const { x, z } = beside(i, side * (TRAIL_WIDTH + 1.0));
    put('cairn', x, z, i * 1.7);
    side = -side;
  }
}

function pickWeighted(rng, table) {
  let total = 0;
  for (const [, w] of table) total += w;
  let r = rng() * total;
  for (const [name, w] of table) {
    if ((r -= w) <= 0) return name;
  }
  return table[table.length - 1][0];
}

/**
 * Scatter instances over the terrain on a jittered grid, keeping the trail
 * clear. Returns placements grouped by prototype name:
 * [{x, y, z, rotY, scale, tint}].
 */
function scatter(trail) {
  const rng = mulberry32(SEED * 7 + 3);
  const out = {};
  const add = (name, p) => (out[name] ||= []).push(p);
  const half = WORLD_SIZE / 2 - 20;

  // Trees -----------------------------------------------------------------
  const cell = 7.5;
  for (let gz = -half; gz < half; gz += cell) {
    for (let gx = -half; gx < half; gx += cell) {
      const x = gx + rng() * cell;
      const z = gz + rng() * cell;
      const h = heightAt(x, z);
      if (h < WATER_LEVEL + 1.5) continue;
      if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 14) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 2.3) continue;
      const slope = slopeAt(x, z);
      if (slope > 0.45) continue;

      // big soft patches of forest with clearings between
      const f = nForest(x * 0.0045, z * 0.0045) * 0.5 + 0.5;
      let density = THREE.MathUtils.smoothstep(f, 0.18, 0.5) * 0.85 + 0.05;
      density *= 1 - THREE.MathUtils.smoothstep(h, TREELINE - 70, TREELINE);
      density *= 1 - THREE.MathUtils.smoothstep(slope, 0.25, 0.45);
      if (rng() > density) continue;

      const snow = snowAmount(x, z, h, slope) > 0.1;
      const alt = THREE.MathUtils.clamp(h / TREELINE, 0, 1);
      let table;
      if (snow) table = [['fir_snow', 5], ['hemlock_snow', 3], ['sapling_snow', 3]];
      else if (h < 45) table = [['fir', 4], ['hemlock', 3], ['cedar', 3], ['sapling', 1], ['snag', 0.35]];
      else table = [['fir', 5], ['hemlock', 4], ['sapling', 1.5], ['snag', 0.4]];
      const name = pickWeighted(rng, table);

      let scale = (0.65 + rng() * 0.6) * (1 - alt * 0.35);
      // old-growth veterans: in the low, dense forest about 1 in 8 big conifers is a
      // giant (up to ~60 m, trunks ~2 m across). From a position hash, not rng, so
      // nothing else moves.
      if (name === 'fir' || name === 'hemlock' || name === 'cedar') {
        const oldGrowth = THREE.MathUtils.smoothstep(f, 0.42, 0.7) * (1 - THREE.MathUtils.smoothstep(h, 50, 95));
        const share = 0.13 * oldGrowth;
        const hv = hash2(x, z);
        if (hv < share) scale *= 1.45 + 0.4 * (hv / share);
      }
      add(name, { x, y: groundAt(x, z) - 0.3, z, rotY: rng() * Math.PI * 2, scale, tint: rng() });
    }
  }

  // Rocks, logs, stumps ------------------------------------------------------
  const rockCell = 16;
  for (let gz = -half; gz < half; gz += rockCell) {
    for (let gx = -half; gx < half; gx += rockCell) {
      const x = gx + rng() * rockCell;
      const z = gz + rng() * rockCell;
      const h = heightAt(x, z);
      if (h < WATER_LEVEL - 2) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 2.5) continue;
      const slope = slopeAt(x, z);
      const r = rng();
      if (r < 0.12 + slope * 0.5) {
        const name = BOULDERS[Math.floor(rng() * BOULDERS.length)];
        const rotY = rng() * 6.28;
        // scans are real size, 1.6-3.4 m across; on steep ground some grow into outcrops (no extra rng)
        const scale = (0.6 + rng() * rng() * 1.9) * (1 + 1.2 * THREE.MathUtils.smoothstep(slope, 0.3, 0.6));
        // seat it on the lowest ground under its footprint, so on a slope the
        // uphill side is buried instead of the downhill side floating
        const rr = 0.8 * scale;
        let y = groundAt(x, z);
        for (let k = 0; k < 6; k++) y = Math.min(y, groundAt(x + Math.cos(k * 1.047) * rr, z + Math.sin(k * 1.047) * rr));
        add(name, { x, y: y - 0.12 * scale, z, rotY, scale, tint: rng() });
      } else if (r < 0.2 && h < SNOWLINE + 30 && slope < 0.25) {
        add('log', { x, y: groundAt(x, z) - 0.25, z, rotY: rng() * 6.28, scale: 0.7 + rng() * 0.5, tint: rng() });
      } else if (r < 0.24 && h < SNOWLINE && slope < 0.3) {
        add('stump', { x, y: groundAt(x, z) - 0.1, z, rotY: rng() * 6.28, scale: 0.7 + rng() * 0.6, tint: rng() });
      }
    }
  }

  // Sword ferns ----------------------------------------------------------------
  const fernCell = 2.3; // misty old growth: a sea of ferns under the big trees
  for (let gz = -half; gz < half; gz += fernCell) {
    for (let gx = -half; gx < half; gx += fernCell) {
      const x = gx + rng() * fernCell;
      const z = gz + rng() * fernCell;
      const f = nForest(x * 0.0045, z * 0.0045) * 0.5 + 0.5;
      const clump = nForest(x * 0.05 + 40, z * 0.05 - 17) * 0.5 + 0.5;
      if (rng() > f * clump * 1.45) continue;
      const h = heightAt(x, z);
      if (h < WATER_LEVEL + 1 || h > SNOWLINE - 25) continue;
      if (slopeAt(x, z) > 0.35) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 0.4) continue;
      add(rng() < 0.5 ? 'fern_a' : 'fern_b', {
        x, y: groundAt(x, z) - 0.05, z, rotY: rng() * 6.28, scale: 0.9 + rng() * 0.9, tint: rng(),
      });
    }
  }

  // Salal: dense patches of low leathery shrubs (after the ferns, so nothing above moves)
  const salalCell = 2.0;
  for (let gz = -half; gz < half; gz += salalCell) {
    for (let gx = -half; gx < half; gx += salalCell) {
      const x = gx + rng() * salalCell;
      const z = gz + rng() * salalCell;
      const f = nForest(x * 0.0045, z * 0.0045) * 0.5 + 0.5;
      const patch = THREE.MathUtils.smoothstep(nForest(x * 0.028 + 90, z * 0.028 + 11) * 0.5 + 0.5, 0.52, 0.72);
      if (rng() > f * patch * 1.1) continue;
      const h = heightAt(x, z);
      if (h < WATER_LEVEL + 1.5 || h > SNOWLINE - 40) continue;
      if (slopeAt(x, z) > 0.4) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 0.6) continue;
      add('salal', { x, y: groundAt(x, z) - 0.05, z, rotY: rng() * 6.28, scale: 0.8 + rng() * 0.7, tint: rng() });
    }
  }

  // Vine maple: arching understory trees in loose groves, mostly at forest edges and in
  // open forest at low elevations (after the salal, so nothing above moves)
  const mapleCell = 9;
  for (let gz = -half; gz < half; gz += mapleCell) {
    for (let gx = -half; gx < half; gx += mapleCell) {
      const x = gx + rng() * mapleCell;
      const z = gz + rng() * mapleCell;
      const f = nForest(x * 0.0045, z * 0.0045) * 0.5 + 0.5;
      const edge = THREE.MathUtils.smoothstep(f, 0.3, 0.45) * (1 - THREE.MathUtils.smoothstep(f, 0.65, 0.85));
      const grove = THREE.MathUtils.smoothstep(nForest(x * 0.02 - 60, z * 0.02 + 33) * 0.5 + 0.5, 0.45, 0.7);
      if (rng() > edge * grove * 0.8) continue;
      const h = heightAt(x, z);
      if (h < WATER_LEVEL + 2 || h > 85) continue;
      if (slopeAt(x, z) > 0.4) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 1.5) continue;
      if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 6) continue;
      add('vine_maple', { x, y: groundAt(x, z) - 0.25, z, rotY: rng() * 6.28, scale: 0.8 + rng() * 0.45, tint: rng() });
    }
  }

  // Nurse logs: fallen giants in the old growth, lying along the contour, with an upturned root
  // wad at one end, and ferns and seedling hemlocks growing on top (after the maples: nothing above moves)
  const logCell = 34;
  for (let gz = -half; gz < half; gz += logCell) {
    for (let gx = -half; gx < half; gx += logCell) {
      const x = gx + rng() * logCell;
      const z = gz + rng() * logCell;
      const f = nForest(x * 0.0045, z * 0.0045) * 0.5 + 0.5;
      const h = heightAt(x, z);
      const oldGrowth = THREE.MathUtils.smoothstep(f, 0.42, 0.7) * (1 - THREE.MathUtils.smoothstep(h, 50, 95));
      const flip = rng() < 0.5;
      const jitter = (rng() - 0.5) * 0.4;
      const scale = 0.85 + rng() * 0.3;
      if (rng() > oldGrowth * 0.6) continue;
      if (h < WATER_LEVEL + 2 || slopeAt(x, z) > 0.22) continue;
      // along the contour (logs settle across the slope)
      const gxH = heightAt(x + 2, z) - heightAt(x - 2, z);
      const gzH = heightAt(x, z + 2) - heightAt(x, z - 2);
      let ang = Math.atan2(gxH, -gzH) + jitter; // direction (-gz, gx): across the gradient
      if (flip) ang += Math.PI;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      const half_ = (NURSE.length / 2) * scale;
      let ok = true;
      let y = Infinity;
      for (let k = -2; k <= 2; k++) {
        const px = x + dx * half_ * k * 0.5;
        const pz = z + dz * half_ * k * 0.5;
        if (trail.distanceTo(px, pz) < TRAIL_WIDTH + 2.5 || Math.hypot(px - SPAWN.x, pz - SPAWN.z) < 12) ok = false;
        y = Math.min(y, groundAt(px, pz));
      }
      if (!ok) continue;
      // three's rotation about Y maps local +X to (cos r, -sin r)
      const rotY = Math.atan2(-dz, dx);
      add('log_nurse', { x, y: y - 0.1, z, rotY, scale, tint: rng(), axis: [dx, dz] });
      // what grows on it
      for (let k = 0; k < 12; k++) {
        const u = 0.12 + 0.78 * rng();
        const along = (u - 0.5) * NURSE.length * scale;
        const { top } = nurseAt(u);
        const px = x + dx * along;
        const pz = z + dz * along;
        const py = y - 0.1 + top * scale - 0.05;
        const what = rng();
        if (what < 0.35) add('sapling', { x: px, y: py, z: pz, rotY: rng() * 6.28, scale: 0.2 + rng() * 0.18, tint: rng() });
        else if (what < 0.8) add(rng() < 0.5 ? 'fern_a' : 'fern_b', { x: px, y: py, z: pz, rotY: rng() * 6.28, scale: 0.5 + rng() * 0.35, tint: rng() });
      }
    }
  }

  // Loose stones: clusters of pebbles, cobbles and gravel (near pool, like the ferns). Kicked
  // to the trail edges, on stony slopes and high open ground; sparse in deep moss and duff;
  // none on snow or in water. Last, so nothing above moves.
  const PEBBLES = ['pebbles_a', 'pebbles_b', 'pebbles_c', 'pebbles_e', 'pebbles_a', 'pebbles_c', 'pebbles_e', 'pebbles_d'];
  const stoneCell = 2.5;
  for (let gz = -half; gz < half; gz += stoneCell) {
    for (let gx = -half; gx < half; gx += stoneCell) {
      const x = gx + rng() * stoneCell;
      const z = gz + rng() * stoneCell;
      const pick = rng();
      const r = rng();
      const h = heightAt(x, z);
      if (h < WATER_LEVEL + 0.3) continue;
      const slope = slopeAt(x, z);
      const d = trail.distanceTo(x, z);
      if (d < TRAIL_WIDTH * 0.5 + 0.2) continue; // off the tread itself
      const edge = THREE.MathUtils.smoothstep(d, TRAIL_WIDTH * 0.5, TRAIL_WIDTH * 0.5 + 0.8) * (1 - THREE.MathUtils.smoothstep(d, TRAIL_WIDTH + 2, TRAIL_WIDTH + 5));
      const stony = THREE.MathUtils.smoothstep(slope, 0.12, 0.45);
      const high = THREE.MathUtils.smoothstep(h, 60, 110);
      const duff = THREE.MathUtils.smoothstep(nForest(x * 0.0045, z * 0.0045) * 0.5 + 0.5, 0.4, 0.7);
      const p = Math.min(0.95, 0.22 + 0.75 * edge + 0.6 * stony + 0.4 * high) * (1 - 0.5 * duff * (1 - edge));
      if (r > p) continue;
      if (snowAmount(x, z, h, slope) > 0.3) continue;
      const kind = PEBBLES[Math.floor(pick * PEBBLES.length)];
      // on stony slopes the cobbles grow into scree: small talus blocks
      const talus = kind === 'pebbles_d' ? 1 + 2.5 * stony : 1;
      add(kind, { x, y: groundAt(x, z) - 0.02 * talus, z, rotY: pick * 97.3, scale: (0.8 + r * 0.6 / Math.max(p, 0.1)) * talus, tint: rng() });
    }
  }

  placeTrailFurniture(trail, add);
  return out;
}

/** Bake the far-tree impostors from every tree type's full-detail model (see impostors.js). */
export function bakeTreeImpostors(renderer, protos, { lowPower }) {
  const trees = {};
  for (const [name, parts] of Object.entries(protos)) {
    if (KIND(name) === 'trees' && !name.endsWith('_lod') && protos[`${name}_lod`]) trees[name] = parts;
  }
  return bakeImpostors(renderer, trees, { frameW: lowPower ? 128 : 192 });
}

/**
 * Builds the vegetation as per-chunk InstancedMeshes so far-away chunks can be
 * hidden cheaply, and a spatial hash of trunks/rocks for player collisions.
 * With `impostors` (bakeTreeImpostors), far trees are billboards: one draw per
 * chunk for all tree types, instead of the *_lod models per type.
 */
export function buildVegetation(protos, trail, { impostors = null } = {}) {
  const placements = scatter(trail);
  const canopyAt = bakeCanopy(placements);
  const group = new THREE.Group();
  group.name = 'vegetation';
  const chunks = new Map(); // key -> { cx, cz, kind -> Object3D[] }
  const colliders = new Map(); // grid key -> [{x, z, r}]
  const COLL_CELL = 8;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const counts = {};

  const nearPools = [];
  const impostorBuckets = new Map(); // chunk key -> [{ matrices, idx, colors, frame }]

  // Instance colour for one part: foliage/rock parts get the per-instance
  // tint, everything gets the baked canopy shade.
  const TINTABLE = /Needles|Foliage|Fern|Rock|LodVertexColor|Cards/;
  const instanceColors = (partName, tints, shades, n) => {
    const out = new Float32Array(n * 3);
    const tinted = TINTABLE.test(partName);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) out[i * 3 + c] = (tinted ? tints[i * 3 + c] : 1) * shades[i];
    }
    return out;
  };

  for (const [name, list] of Object.entries(placements)) {
    const kind = KIND(name);
    // trees: far LOD chunks + full-detail near pool; ferns: near pool only
    // (they're invisible past a short radius); everything else: chunks only
    const farParts = kind === 'ferns' ? [] : protos[`${name}_lod`] ?? protos[name];
    const nearParts = kind === 'ferns' ? protos[name] : protos[`${name}_lod`] ? protos[name] : null;
    if (!farParts || (kind === 'ferns' && !nearParts)) {
      console.warn('missing prototype', name);
      continue;
    }
    counts[name] = list.length;
    const collideR = COLLIDE[name] ?? (name.startsWith('boulder') ? footprint(nearParts ?? farParts) : 0);

    // per-instance data, computed once and shared by both tiers
    const n = list.length;
    const matrices = new Float32Array(n * 16);
    const tints = new Float32Array(n * 3);
    const shades = new Float32Array(n);
    const xz = new Float32Array(n * 2);
    list.forEach((it, i) => {
      q.setFromAxisAngle(up, it.rotY);
      s.setScalar(it.scale);
      p.set(it.x, it.y, it.z);
      m.compose(p, q, s).toArray(matrices, i * 16);
      const t = it.tint;
      tints.set([0.85 + t * 0.3, 0.88 + t * 0.24, 0.85 + (1 - t) * 0.25], i * 3);
      // baked shade: understory under a closed canopy gets much less light
      shades[i] = 1 - canopyAt(it.x, it.z) * (kind === 'trees' ? 0.22 : 0.45);
      xz[i * 2] = it.x;
      xz[i * 2 + 1] = it.z;
      it.idx = i;

      const r = collideR;
      const addCollider = (cx, cz, cr) => {
        const ck = cellKey(Math.floor(cx / COLL_CELL), Math.floor(cz / COLL_CELL));
        if (!colliders.has(ck)) colliders.set(ck, []);
        colliders.get(ck).push({ x: cx, z: cz, r: cr });
      };
      if (r) addCollider(it.x, it.z, r * it.scale);
      if (name === 'log_nurse') {
        // a row of circles along the trunk, and the root plate at the -X end
        const [dx, dz] = it.axis;
        for (let u = 0.04; u <= 0.97; u += 0.07) {
          const along = (u - 0.5) * NURSE.length * it.scale;
          addCollider(it.x + dx * along, it.z + dz * along, nurseAt(u).r * it.scale * 0.95);
        }
        const plate = (-0.5 * NURSE.length - 0.4) * it.scale;
        addCollider(it.x + dx * plate, it.z + dz * plate, NURSE.plate * 0.55 * it.scale);
      }
    });
    const farColors = farParts.map((part) => instanceColors(part.material.name, tints, shades, n));
    const frame = kind === 'trees' && impostors?.info[name];
    const impColors = frame ? instanceColors('LodVertexColor', tints, shades, n) : null;

    // far tier (or the only tier, for non-trees): one InstancedMesh per chunk per part
    const buckets = new Map();
    for (const inst of list) {
      const cx = Math.floor(inst.x / CHUNK_SIZE);
      const cz = Math.floor(inst.z / CHUNK_SIZE);
      const key = `${cx},${cz}`;
      if (!buckets.has(key)) buckets.set(key, { cx, cz, items: [] });
      buckets.get(key).items.push(inst);
    }
    for (const [key, { cx, cz, items }] of buckets) {
      if (!chunks.has(key)) {
        chunks.set(key, {
          center: new THREE.Vector2((cx + 0.5) * CHUNK_SIZE, (cz + 0.5) * CHUNK_SIZE),
          trees: [], rocks: [], ferns: [],
        });
      }
      const chunk = chunks.get(key);
      if (frame) {
        // billboards: gathered per chunk across all tree types, built below
        if (!impostorBuckets.has(key)) impostorBuckets.set(key, []);
        for (const it of items) impostorBuckets.get(key).push({ matrices, idx: it.idx, colors: impColors, frame });
        continue;
      }
      farParts.forEach((part, pi) => {
        const im = new THREE.InstancedMesh(part.geometry, part.material, items.length);
        im.setColorAt(0, col.setRGB(1, 1, 1)); // allocate instanceColor
        items.forEach((it, j) => {
          im.instanceMatrix.array.set(matrices.subarray(it.idx * 16, it.idx * 16 + 16), j * 16);
          im.instanceColor.array.set(farColors[pi].subarray(it.idx * 3, it.idx * 3 + 3), j * 3);
        });
        im.instanceMatrix.needsUpdate = true;
        im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        im.name = `${name}:${part.material.name}@${key}`;
        im.userData.kind = kind;
        group.add(im);
        chunk[kind].push(im);
      });
    }

    // near tier: full-detail models around the camera
    if (nearParts) {
      const nearColors = nearParts.map((part) => instanceColors(part.material.name, tints, shades, n));
      const radiusKey = kind === 'ferns' ? 'ferns' : 'treeDetail';
      const pool = new NearPool(nearParts, matrices, nearColors, xz, poolRadius(radiusKey));
      pool.radiusKey = radiusKey;
      for (const im of pool.meshes) {
        im.name = `${name}:${im.material.name}@near`;
        im.userData.kind = kind;
        group.add(im);
      }
      nearPools.push(pool);
    }
  }

  if (impostors) {
    const tallest = Math.max(...Object.values(impostors.info).map((f) => Math.max(f.height + f.yMin, f.halfWidth * 2)));
    const geo = impostorGeometry(tallest);
    const mat = impostorMaterial(impostors);
    for (const [key, items] of impostorBuckets) {
      const im = new THREE.InstancedMesh(geo, mat, items.length);
      im.setColorAt(0, col.setRGB(1, 1, 1)); // allocate instanceColor
      const frames = new Float32Array(items.length * 4);
      items.forEach((it, j) => {
        im.instanceMatrix.array.set(it.matrices.subarray(it.idx * 16, it.idx * 16 + 16), j * 16);
        im.instanceColor.array.set(it.colors.subarray(it.idx * 3, it.idx * 3 + 3), j * 3);
        frames.set([it.frame.yMin, it.frame.height, it.frame.halfWidth, it.frame.row], j * 4);
      });
      im.geometry = geo.clone(); // own attribute set per chunk (aFrame differs)
      im.geometry.boundingSphere = geo.boundingSphere;
      im.geometry.setAttribute('aFrame', new THREE.InstancedBufferAttribute(frames, 4));
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.name = `impostors@${key}`;
      im.userData.kind = 'trees';
      group.add(im);
      chunks.get(key).trees.push(im);
    }
  }

  console.info('vegetation instances', JSON.stringify(counts));

  const disabled = new Set(); // kinds switched off for perf testing (?off=)

  function updateVisibility(cameraPos) {
    const halfDiag = CHUNK_SIZE * 0.7072;
    for (const chunk of chunks.values()) {
      const d = Math.hypot(chunk.center.x - cameraPos.x, chunk.center.y - cameraPos.z) - halfDiag;
      for (const kind of ['trees', 'rocks', 'ferns']) {
        const vis = !disabled.has(kind) && d < VIEW_DIST[kind];
        for (const mesh of chunk[kind]) mesh.visible = vis;
      }
    }
  }

  /** Push a circle (x, z, radius) out of any colliding trunks/rocks. */
  function collide(pos, radius) {
    const gx = Math.floor(pos.x / COLL_CELL);
    const gz = Math.floor(pos.z / COLL_CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = colliders.get(cellKey(gx + dx, gz + dz));
        if (!list) continue;
        for (const c of list) {
          const ox = pos.x - c.x;
          const oz = pos.z - c.z;
          const min = c.r + radius;
          const d2 = ox * ox + oz * oz;
          if (d2 < min * min && d2 > 1e-8) {
            const d = Math.sqrt(d2);
            pos.x = c.x + (ox / d) * min;
            pos.z = c.z + (oz / d) * min;
          }
        }
      }
    }
  }

  // Near-pool culling (see detail.js): re-cull when the view has turned more
  // than TURN or moved more than STEP; the cull frustum is widened by WIDEN on
  // every side, which is more than TURN, so nothing is ever missing on screen.
  const TURN = THREE.MathUtils.degToRad(8);
  const WIDEN = THREE.MathUtils.degToRad(12);
  const STEP = 1.5;
  const wide = new THREE.PerspectiveCamera();
  const frustum = new THREE.Frustum();
  const viewProj = new THREE.Matrix4();
  const lastPos = new THREE.Vector3(Infinity, 0, 0);
  const lastDir = new THREE.Vector3();
  const dir = new THREE.Vector3();

  function wideFrustum(camera) {
    const v = THREE.MathUtils.degToRad(camera.fov);
    const h = Math.atan(Math.tan(v / 2) * camera.aspect);
    wide.fov = THREE.MathUtils.radToDeg(v + 2 * WIDEN);
    wide.aspect = Math.tan(h + WIDEN) / Math.tan(v / 2 + WIDEN);
    wide.near = camera.near;
    wide.far = camera.far;
    wide.updateProjectionMatrix();
    viewProj.multiplyMatrices(wide.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProj);
  }

  /**
   * Keep the full-detail near ring filled around the camera (refills every few
   * metres) and culled to what can be seen (re-culls when the view changes).
   * Once per frame; allocation-free.
   */
  function updateNear(camera, force = false) {
    camera.updateMatrixWorld();
    camera.getWorldDirection(dir);
    const moved = force || camera.position.distanceTo(lastPos) > STEP || dir.dot(lastDir) < Math.cos(TURN);
    let built = false;
    for (const pool of nearPools) {
      const refilled = pool.update(camera.position, poolRadius(pool.radiusKey), force);
      if (!refilled && !moved) continue;
      if (!built) {
        wideFrustum(camera);
        built = true;
      }
      pool.cull(frustum, camera.position);
    }
    if (moved) {
      lastPos.copy(camera.position);
      lastDir.copy(dir);
    }
  }

  /** Switch a kind on or off (perf testing: ?off= and ?bench). Chunks follow on the next updateVisibility. */
  function setEnabled(kind, on) {
    if (on) disabled.delete(kind);
    else disabled.add(kind);
    for (const pool of nearPools) for (const im of pool.meshes) if (im.userData.kind === kind) im.visible = on;
  }
  const disable = (kind) => setEnabled(kind, false);

  return { group, placements, updateVisibility, updateNear, disable, setEnabled, collide, counts, canopyAt, chunks, nearPools };
}
