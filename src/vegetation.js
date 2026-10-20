import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  WORLD_SIZE, CHUNK_SIZE, VIEW_DIST, SNOWLINE, TREELINE, SEED, CLEARING,
} from './config.js';
import {
  heightAt, groundAt, slopeAt, snowAmount, snowlineAt, nForest, mulberry32, streams, streamBed, waterLevelAt, marshAt, MARSH, sandAt, coastZ, SEA_LEVEL,
} from './terrain.js';
import { TRAIL_WIDTH } from './trail.js';
import { addWindSway, addGroundCover, addTrunkMoss, shared } from './materials.js';
import { bakePrototypeAO, bakeCanopy } from './bake.js';
import { NearPool } from './detail.js';
import { addSurfaceDetail, surfaceLayerFor } from './surfacedetail.js';
import { bakeImpostors, impostorGeometry, impostorMaterial } from './impostors.js';
import { streamRocks } from './streamwater.js';
import { rockFieldAt, valueNoise } from './rockyslope.js';
import { loadTick } from './loadprogress.js';

const KIND = (name) => (/^(fern|salal|pebbles)/.test(name) ? 'ferns'
  : /^(boulder|log|stump|signpost|cairn|bench|footbridge|boardwalk)/.test(name) ? 'rocks' : 'trees');

/** Metres from the edge of the nearest stream's water (negative in it). */
const offStream = (x, z) => {
  const c = streams().nearest(x, z);
  return c.seg ? c.d - c.half : Infinity;
};

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
  sapling: 0.25, sapling_snow: 0.25, snag: 0.65, vine_maple: 0.3, shore_pine: 0.3,
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
  return prototypesFrom(await Promise.all(urls.map((url) => loader.loadAsync(url))));
}

/** The prototypes from already-loaded glTFs (tools/bake_world.mjs parses them in node). */
export function prototypesFrom(scenes) {
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
  const maple = mat.name === 'MapleCards';
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    if (maple) {
      // early fall: where each leaf turns comes from its world position (smooth patches through
      // the crown, different on every tree), so the one spray texture doesn't repeat its red leaf
      shader.vertexShader = 'varying vec3 vFallP;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vFallP = transformed;
        #ifdef USE_INSTANCING
        vFallP = (instanceMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
      shader.fragmentShader = 'varying vec3 vFallP;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec3 q = vFallP * 0.55;
          float turn = sin(q.x * 1.3 + sin(q.z * 0.9 + q.y * 0.4)) * sin(q.z * 1.1 + q.y * 0.7 + sin(q.x * 0.6)) * 0.5 + 0.5;
          // the painted autumn leaves (redder than green) fall back to green where turn is low
          float green = (1.0 - smoothstep(0.35, 0.65, turn)) * smoothstep(0.0, 0.06, diffuseColor.r - diffuseColor.g);
          float l = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          diffuseColor.rgb = mix(diffuseColor.rgb, l * vec3(0.45, 1.25, 0.1), green);
        }`);
    }
    shader.fragmentShader = '#define CARD_SKY 1.6\n' + shader.fragmentShader
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
        #if ${maple ? 1 : 0}
        {
          // a broadleaf card seen edge-on smears its leaves into long streaks: thin it out
          // as its face (the triangle's, not the bent shading normal) turns away
          vec3 cardFace = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
          diffuseColor.a *= smoothstep(0.05, 0.25, abs(dot(cardFace, normalize(vViewPosition))));
        }
        #endif
        #include <alphatest_fragment>`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vNormal);
        // the side of a spray facing away from its (outward, up) normal is the
        // underside: seen from below, crowns should be darker, not sky-lit
        // (snow from below: you'd see the dark branch under it, not white)
        float cardBack = 0.0;
        {
          vec3 cardV = normalize(vViewPosition);
          float cardD = dot(normal, cardV);
          cardBack = smoothstep(0.0, -0.3, cardD);
          diffuseColor.rgb *= mix(${snow ? '0.22' : '0.75'}, 1.0, smoothstep(-0.35, 0.2, cardD));
          // seen from behind, mirror the normal toward the viewer (keeping its up/out
          // tilt): with N.V < 0 the specular term blows up and bleaches the spray
          if (cardD < 0.0) normal = normalize(normal - 2.0 * cardD * cardV);
        }`)
      // needles are matte: grazing-angle Fresnel off a low sun made sprays grey-white
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.directSpecular *= 0.15;
        // wet leaves pick up a soft sheen of the sky
        reflectedLight.indirectSpecular *= 0.35 + 0.45 * uWet;
        #if ${snow ? 0 : 1}
        #if NUM_HEMI_LIGHTS > 0
        if (cardBack > 0.0) {
          // from below, needles and leaves let daylight through: the mirrored normal faces down
          // and saw only ground bounce, so crowns overhead were near-black combs (the user).
          // The hemisphere's sky colour only (an env-map lookup per card pixel costs fill)
          reflectedLight.indirectDiffuse += material.diffuseColor * RECIPROCAL_PI * hemisphereLights[0].skyColor * (CARD_SKY * cardBack);
        }
        #endif
        #endif
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
  mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}|cards${snow ? 's' : moss ? 'm' : maple ? 'b' : ''}`;
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
  PineCards: [0.4, 0.47, 0.32], // shore pine: dark, a little yellower than the firs
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
    // logs: their ragged broken ends twist splinters and torn wood every which way, and a face
    // turned inward got culled, opening a window into the hollow trunk (the user saw the ground
    // and grass inside nurse logs), so log materials draw both sides
    side: (kind === 'ferns' && !pebble) || cards || swapXY ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (cards) {
    mat.map = src.map; // the needle spray (RGBA, embedded in the GLB)
    mat.alphaTest = 0.5;
    // broad maple leaves hang right over the trail: a hard alpha test stair-stepped their
    // outlines up close; alpha to coverage (the scene target is 4x MSAA) smooths them
    mat.alphaToCoverage = src.name === 'MapleCards';
    // the spray textures are painted bright; deepen them to each species' green
    // so they sit together (the impostor bake reads this colour too)
    mat.color.setRGB(...(CARD_TINT[src.name] ?? [0.6, 0.6, 0.6]));
  }
  // needles shed water and scatter light: keep sky reflections off foliage
  if (/Needles|Foliage|Fern|Cards/.test(src.name)) mat.envMapIntensity = 0.35;
  if (kind === 'trees') addWindSway(mat, undefined, undefined, lod);
  else if (kind === 'ferns' && !pebble) addWindSway(mat, 2.5, undefined, 'fade');
  // scans have their own moss; pebbles are never placed on snow (and the shader's global snowline frosted them white)
  else addGroundCover(mat, { lod: pebble ? 'fade' : lod, moss: scan ? 0.35 : pebble ? 0.6 : assetName === 'footbridge' || assetName === 'boardwalk' ? 0.2 : src.name === 'RootSoil' ? 0.25 : /BrokenWood|RotWood/.test(src.name) ? 0.1 : 1, snow: pebble ? 0 : 1, film: scan || pebble || src.name === 'Rock' ? 1 : 0, bleach: /Bark|Wood/.test(src.name) });
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
    // matte stone: at full strength the baked normals' fine crinkles caught the light as a plastic
    // sheen (found by A/B: the sheen went with the normal map, not the reflections)
    mat.normalScale.set(0.45, 0.45);
    mat.roughness = 1;
    mat.envMapIntensity = 0.6;
    mat.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------

/**
 * Rocks in the creeks (streamwater.js streamRocks: the water flows around the same list). Each is
 * a scanned boulder scaled so its half-width is the rock's radius, seated on the lowest bed under
 * it so it stands out of the water. Chunky variants only (the flat slab g would drown).
 */
function addStreamRocks(placements, protos, trail) {
  const kinds = BOULDERS.filter((b) => b !== 'boulder_g' && protos[b]);
  const half = Object.fromEntries(kinds.map((b) => {
    const box = new THREE.Box3();
    for (const { geometry } of protos[b]) {
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox);
    }
    return [b, 0.25 * (box.max.x - box.min.x + box.max.z - box.min.z)];
  }));
  for (const r of streamRocks(trail)) {
    const name = kinds[Math.floor(r.pick * kinds.length)];
    const scale = r.r / half[name];
    let y = groundAt(r.x, r.z);
    for (let k = 0; k < 6; k++) y = Math.min(y, groundAt(r.x + Math.cos(k * 1.047) * r.r * 0.7, r.z + Math.sin(k * 1.047) * r.r * 0.7));
    (placements[name] ||= []).push({ x: r.x, y, z: r.z, rotY: r.rotY, scale, tint: r.pick });
  }
}

/**
 * Seat boulders and pebble clusters on the ground they actually cover. The scatter seats them
 * by a few ground samples near the centre, but the wider scans (slabs, long blocks) and spread
 * clusters hung off steep slopes by metres. Boulders lean 80% of the way into the slope (as
 * rocks settle on hillsides; clusters already lie on it), then each sinks until no vertex of
 * its base (the lowest quarter of the model) is above the rendered ground, but by at most 30%
 * of its height (round rocks on steep ground otherwise all but vanished). No rng.
 */
function seatStones(placements, protos) {
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const tq = new THREE.Quaternion();
  const n = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (const [name, list] of Object.entries(placements)) {
    const boulder = name.startsWith('boulder');
    if (!boulder && !name.startsWith('pebbles')) continue;
    const parts = protos[name];
    if (!parts) continue;
    // the base: vertices in the lowest quarter of the model, thinned to a few dozen
    let y0 = Infinity;
    let y1 = -Infinity;
    let reach = 0;
    for (const { geometry } of parts) {
      const a = geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        y0 = Math.min(y0, a.getY(i));
        y1 = Math.max(y1, a.getY(i));
        reach = Math.max(reach, Math.hypot(a.getX(i), a.getZ(i)));
      }
    }
    const base = [];
    for (const { geometry } of parts) {
      const a = geometry.attributes.position;
      for (let i = 0; i < a.count; i++) if (a.getY(i) < y0 + 0.25 * (y1 - y0)) base.push(new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)));
    }
    const step = Math.max(1, Math.floor(base.length / (boulder ? 48 : 24)));
    const pts = base.filter((_, i) => i % step === 0);
    for (const it of list) {
      if (boulder) {
        // the slope over the rock's own footprint, leaned into 80%
        const sp = Math.max(0.5, reach * 0.6 * it.scale);
        const dx = (groundAt(it.x + sp, it.z) - groundAt(it.x - sp, it.z)) / (2 * sp);
        const dz = (groundAt(it.x, it.z + sp) - groundAt(it.x, it.z - sp)) / (2 * sp);
        n.set(-dx, 1, -dz).normalize().lerp(up, 0.2).normalize();
        // at most 35° (on the rim's near-cliffs a full lean turned rocks into the wall)
        if (n.y < 0.819) n.set(n.x, 0, n.z).setLength(0.574).setY(0.819);
        it.normal = [n.x, n.y, n.z];
      }
      q.setFromAxisAngle(up, it.rotY);
      if (it.normal) q.premultiply(tq.setFromUnitVectors(up, n.fromArray(it.normal)));
      m.compose(p.set(it.x, it.y, it.z), q, s.setScalar(it.scale));
      let gap = 0;
      for (const b of pts) {
        v.copy(b).applyMatrix4(m);
        gap = Math.max(gap, v.y - groundAt(v.x, v.z));
      }
      if (gap > 0) it.y -= Math.min(gap + 0.02 * it.scale, 0.3 * (y1 - y0) * it.scale);
    }
  }
}

/**
 * Dead trees standing in the marsh (drowned when the water rose): snags on the hummocks, chosen
 * by a hash over a 9 m grid (no scatter rng, so nothing else moves), off the boardwalk.
 */
function addMarshSnags(placements, trail) {
  const { x: mx, z: mz, rx, rz } = MARSH;
  for (let z = mz - rz; z <= mz + rz; z += 9) {
    for (let x = mx - rx; x <= mx + rx; x += 9) {
      const h = hash2(x * 1.7, z * 1.3);
      const px = x + (hash2(x, z + 3) - 0.5) * 7;
      const pz = z + (hash2(x + 5, z) - 0.5) * 7;
      if (marshAt(px, pz) < 0.5 || h > 0.3) continue;
      if (trail.distanceTo(px, pz) < 4) continue;
      (placements.snag ||= []).push({ x: px, y: groundAt(px, pz) - 0.4, z: pz, rotY: h * 40, scale: 0.55 + h * 1.2, tint: h * 3 % 1 });
    }
  }
}

/**
 * Dead trees fallen against living ones (Blender log_leaning: a snag along local +X from its base,
 * LEANER.length long, radius LEANER.r0 at the base tapering 62%). For ~0.6% of the valley's big
 * conifers, chosen by hash (no scatter rng), a snag stands its base on the ground 0.9-1.6x the
 * contact height away and rests against the side of the tree's trunk 5-11 m up, its top running
 * on past into the crown. Skipped where its low part would cross the trail, a creek or water, or
 * pass through another trunk. Its `axis`/`tilt` give colliders along the part below head height.
 */
const LEANER = { length: 20, r0: 0.42 };
const HOST = { fir: [0.62, 30], hemlock: [0.5, 26], cedar: [0.8, 27] }; // trunk radius at the base, height
const leanerR = (t) => LEANER.r0 * (1 - 0.62 * t);

function addLeaners(placements, trail) {
  // every trunk, on an 8 m grid, to keep leaners from passing through other trees
  const grid = new Map();
  for (const name of ['fir', 'hemlock', 'cedar', 'snag', 'sapling', 'shore_pine']) {
    for (const p of placements[name] ?? []) {
      const k = cellKey(Math.floor(p.x / 8), Math.floor(p.z / 8));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
  }
  const out = (placements.log_leaning ||= []);
  for (const host of ['fir', 'hemlock', 'cedar']) {
    const [r0, H] = HOST[host];
    for (const t of placements[host] ?? []) {
      const pick = hash2(t.x * 0.37 + 11, t.z * 0.61 - 7);
      if (pick > 0.006) continue;
      const u0 = pick / 0.006; // reused for the choices below
      if (t.y > snowlineAt(t.x, t.z) - 25) continue;
      const h = 5 + 6 * hash2(t.z + 3, t.x);
      const a = hash2(t.x - 9, t.z + 2) * Math.PI * 2;
      const ux = Math.cos(a);
      const uz = Math.sin(a);
      const d = h * (0.9 + 0.7 * u0);
      const side = hash2(t.z, t.x - 4) < 0.5 ? 1 : -1;
      // rest against the trunk's side: the axes pass (host radius + leaner radius) apart
      const rHost = r0 * (1 - 0.88 * (h / (0.97 * H))) * t.scale;
      const len = Math.hypot(d, h);
      const scale = Math.min(1.35, Math.max(0.75, (len + 4) / LEANER.length));
      const off = rHost + leanerR(len / (LEANER.length * scale)) * scale;
      const cx = t.x - uz * side * off;
      const cz = t.z + ux * side * off;
      const bx = cx - ux * d;
      const bz = cz - uz * d;
      const by = groundAt(bx, bz) - 0.12 * scale;
      const tilt = Math.atan2(t.y + h - by, d);
      // (between ~17° and 60°: a base far uphill would leave it lying flat or pointing down)
      let ok = by > waterLevelAt(bx, bz) + 0.5 && tilt > 0.3 && tilt < 1.05;
      // the part below ~3 m: off the trail and out of the creeks
      for (let s = 0; ok && s <= len; s += 1) {
        const px = bx + ux * s * Math.cos(tilt);
        const pz = bz + uz * s * Math.cos(tilt);
        const above = by + s * Math.sin(tilt) - groundAt(px, pz);
        if (above < 3 && (trail.distanceTo(px, pz) < TRAIL_WIDTH + 1.5 || offStream(px, pz) < 1)) ok = false;
        if (above < -0.6) ok = false; // the ground rises into it
        // no other trunk within reach of the axis (the host aside)
        for (let gz = Math.floor(pz / 8) - 1; ok && gz <= Math.floor(pz / 8) + 1; gz++) {
          for (let gx = Math.floor(px / 8) - 1; ok && gx <= Math.floor(px / 8) + 1; gx++) {
            for (const o of grid.get(cellKey(gx, gz)) ?? []) {
              if (o !== t && Math.hypot(o.x - px, o.z - pz) < 1.4 * o.scale + 0.4) { ok = false; break; }
            }
          }
        }
      }
      if (!ok) continue;
      out.push({ x: bx, y: by, z: bz, rotY: Math.atan2(-uz, ux), tilt, scale, tint: u0, axis: [ux, uz] });
    }
  }
}

/**
 * Driftwood: bleached trunks (the leaning snags' model, lying down) thrown up along the drift line
 * at the top of the beach and the foot of the dunes, mostly lying along the shore, some in
 * jumbles. By hash along the coast (no scatter rng). Each lies on the sand, half sunk in, and is
 * skipped where the ground under it would rise into it or fall away, near the trail, or on rock.
 */
function addDriftwood(placements, trail) {
  const out = (placements.log_leaning ||= []);
  const lim = WORLD_SIZE / 2 - 60;
  for (let x0 = -lim; x0 < lim; x0 += 6) {
    const pick = hash2(x0 * 0.71 + 3, 77.1);
    if (pick > 0.4) continue;
    const pile = pick < 0.06 ? 3 : 1;
    for (let k = 0; k < pile; k++) {
      const u = hash2(x0 + k * 13.1, 5.3 + k);
      const x = x0 + (hash2(x0, k + 9.7) - 0.5) * 5;
      const z = coastZ(x) - (40 + 36 * u * u); // mostly near the top of the beach
      const scale = 0.4 + 0.5 * hash2(x, z + 1) ** 1.5;
      const len = LEANER.length * scale;
      const along = hash2(z, x) < 0.75;
      const a = (along ? 0 : Math.PI / 2) + (hash2(x + 2, z - 3) - 0.5) * (along ? 0.9 : 3);
      const ux = Math.cos(a);
      const uz = Math.sin(a);
      const g0 = groundAt(x, z);
      const g1 = groundAt(x + ux * len, z + uz * len);
      const tilt = Math.atan2(g1 - g0, len);
      let ok = Math.abs(tilt) < 0.35 && g0 > SEA_LEVEL + 1.1 && g1 > SEA_LEVEL + 1.1;
      for (let t = 0; ok && t <= 1; t += 0.1) {
        const px = x + ux * len * t;
        const pz = z + uz * len * t;
        const r = leanerR(t) * scale;
        const axis = g0 + 0.25 * LEANER.r0 * scale + (g1 - g0) * t; // (its axis ~r/4 above the sand: a third sunk in)
        const dg = groundAt(px, pz) - axis;
        if (dg > 0.5 * r + 0.15 || dg < -0.6 * r - 0.1) ok = false; // buried, or bridging a hollow
        if (sandAt(px, pz) < 0.7 || trail.distanceTo(px, pz) < TRAIL_WIDTH + 1.2) ok = false;
      }
      if (!ok) continue;
      out.push({ x, y: g0 + 0.25 * LEANER.r0 * scale, z, rotY: Math.atan2(-uz, ux), tilt, scale, tint: u, axis: [ux, uz] });
    }
  }
}

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

  // the marsh boardwalk, a 3 m section at each spot (sections overlap a little on bends)
  for (const b of trail.boardwalk ?? []) {
    add('boardwalk', { x: b.x, y: b.y, z: b.z, rotY: Math.atan2(-b.dz, b.dx), scale: 1, scaleX: 1.06, tint: 0.5 });
  }

  // footbridges over the creeks (the model is 6.4 m long, along local X)
  for (const c of trail.crossings ?? []) {
    // long spans (the rapids) in two lengths end to end, so the planks keep their width
    const parts = c.span > 9 ? 2 : 1;
    for (let k = 0; k < parts; k++) {
      const off = parts === 1 ? 0 : (k - 0.5) * (c.span / 2);
      add('footbridge', { x: c.x + c.dx * off, y: c.deck, z: c.z + c.dz * off, rotY: Math.atan2(-c.dz, c.dx), scale: 1, scaleX: (c.span / parts + (parts > 1 ? 0.5 : 0)) / 6.4, tint: 0.5 }); // (halves overlap: no gap mid-deck)
    }
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

  // Cairns in the snow every ~45 m. Each takes the spot at the tread's edge or beside it (either
  // side, a few points along) where the ground under its base and just around it is most level,
  // so none perches on the edge of a bank as if about to tumble downhill; it sits into the slope.
  // On a steep traverse with no such spot there's no cairn.
  const ring = (x, z, r) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const g = groundAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    return { lo, hi };
  };
  for (let i = 0; i < points.length; i += 30) {
    const p = points[i];
    if (groundAt(p.x, p.y) < snowlineAt(p.x, p.y) - 15) continue;
    let best = null;
    for (let di = -6; di <= 6; di += 3) {
      const j = Math.min(points.length - 1, Math.max(0, i + di));
      for (const side of [1, -1]) {
        for (const off of [-0.3, 0.2, 0.6, 1.0, 1.5, 2.1]) { // (from the tread's edge out)
          const { x, z } = beside(j, side * (TRAIL_WIDTH + off));
          if (offStream(x, z) < 2) continue;
          const { lo, hi } = ring(x, z, 0.75);
          const outer = ring(x, z, 1.6); // and no drop just beyond it
          const score = hi - lo + 0.5 * (outer.hi - outer.lo) + 0.02 * Math.abs(di) + 0.03 * off;
          if (!best || score < best.score) best = { x, z, j, score, y: lo + 0.35 * (hi - lo) };
        }
      }
    }
    // nowhere level enough (a steep traverse): leave this one out
    if (best && best.score < 0.5) add('cairn', { x: best.x, y: best.y, z: best.z, rotY: best.j * 1.7, scale: 1, tint: 0.5 });
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
async function scatter(trail) {
  const rng = mulberry32(SEED * 7 + 3);
  const out = {};
  const add = (name, p) => (out[name] ||= []).push(p);
  const half = WORLD_SIZE / 2 - 20;
  // progress through the passes below (trees, rocks, ferns, salal, maples, logs, stones),
  // roughly weighted by how long each takes
  const SHARE = [0.15, 0.03, 0.25, 0.25, 0.04, 0.03, 0.25];
  const row = (k, gz) => {
    let f = 0;
    for (let i = 0; i < k; i++) f += SHARE[i];
    return loadTick(0.75 * (f + (SHARE[k] * (gz + half)) / (2 * half)));
  };

  // Trees -----------------------------------------------------------------
  const cell = 7.5;
  for (let gz = -half; gz < half; gz += cell) {
    for (let gx = -half; gx < half; gx += cell) {
      const x = gx + rng() * cell;
      const z = gz + rng() * cell;
      const h = heightAt(x, z);
      if (h < waterLevelAt(x, z) + 1.5) continue;
      if (Math.hypot(x - CLEARING.x, z - CLEARING.z) < 14) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 2.3) continue;
      if (offStream(x, z) < 2.5) continue; // trees stand back from the water
      const slope = slopeAt(x, z);
      if (slope > 0.45) continue;
      // open sand: no forest, but on the dunes (not the beach) the odd bushy shore pine
      const sand = sandAt(x, z);
      if (sand > 0.3) {
        if (h > SEA_LEVEL + 5 && rng() < 0.16 * sand) {
          add('shore_pine', { x, y: groundAt(x, z) - 0.15, z, rotY: rng() * Math.PI * 2, scale: 0.45 + rng() * 0.7, tint: rng() });
        }
        continue;
      }

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
      else if (coastZ(x) - z < 380) table = [['shore_pine', 4], ['fir', 2], ['hemlock', 2.5], ['sapling', 1.2]]; // the wind-pruned coastal forest behind the dunes
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
    await row(0, gz);
  }

  // Rocks, logs, stumps ------------------------------------------------------
  const rockCell = 16;
  for (let gz = -half; gz < half; gz += rockCell) {
    for (let gx = -half; gx < half; gx += rockCell) {
      const x = gx + rng() * rockCell;
      const z = gz + rng() * rockCell;
      const h = heightAt(x, z);
      if (h < waterLevelAt(x, z) - 2) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 2.5) continue;
      const slope = slopeAt(x, z);
      const r = rng();
      if (sandAt(x, z) > 0.4 && r > 0.03) continue; // the odd boulder on the beach, no logs or stumps (driftwood instead)
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
      } else if (r < 0.2 && h < SNOWLINE + 30 && slope < 0.25 && offStream(x, z) > 5) {
        // fallen logs lie across the slope (a random heading poked one end up into the air on hillsides),
        // seated at the lowest ground along them; the same three draws as before, so nothing else moves
        const rv = rng();
        const scale = 0.7 + rng() * 0.5;
        const tint = rng();
        const gxH = heightAt(x + 2, z) - heightAt(x - 2, z);
        const gzH = heightAt(x, z + 2) - heightAt(x, z - 2);
        const ang = Math.atan2(gxH, -gzH) + (rv < 0.5 ? 0 : Math.PI) + (rv * 2 % 1 - 0.5) * 0.5;
        const dx = Math.cos(ang);
        const dz = Math.sin(ang);
        // the log's axis sits ~0.8 r above its origin and r = 0.55: seat it on the mean ground along it
        let y = 0;
        for (let k = -2; k <= 2; k++) y += groundAt(x + dx * 2.2 * k * scale, z + dz * 2.2 * k * scale) / 5;
        add('log', { x, y: y - 0.12 * scale, z, rotY: Math.atan2(-dz, dx), scale, tint });
      } else if (r < 0.24 && h < SNOWLINE && slope < 0.3 && offStream(x, z) > 2) {
        add('stump', { x, y: groundAt(x, z) - 0.1, z, rotY: rng() * 6.28, scale: 0.7 + rng() * 0.6, tint: rng() });
      }
    }
    await row(1, gz);
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
      if (h < waterLevelAt(x, z) + 1 || h > SNOWLINE - 25) continue;
      if (slopeAt(x, z) > 0.35 || sandAt(x, z) > 0.3) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 0.4) continue;
      if (offStream(x, z) < 0.6) continue;
      add(rng() < 0.5 ? 'fern_a' : 'fern_b', {
        x, y: groundAt(x, z) - 0.05, z, rotY: rng() * 6.28, scale: 0.9 + rng() * 0.9, tint: rng(),
      });
    }
    await row(2, gz);
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
      if (h < waterLevelAt(x, z) + 1.5 || h > SNOWLINE - 40) continue;
      if (slopeAt(x, z) > 0.4 || sandAt(x, z) > 0.3) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 0.6) continue;
      if (offStream(x, z) < 1) continue;
      add('salal', { x, y: groundAt(x, z) - 0.05, z, rotY: rng() * 6.28, scale: 0.8 + rng() * 0.7, tint: rng() });
    }
    await row(3, gz);
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
      if (h < waterLevelAt(x, z) + 2 || h > 85) continue;
      if (slopeAt(x, z) > 0.4 || sandAt(x, z) > 0.3) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 1.5) continue;
      if (offStream(x, z) < 2) continue;
      if (Math.hypot(x - CLEARING.x, z - CLEARING.z) < 6) continue;
      add('vine_maple', { x, y: groundAt(x, z) - 0.25, z, rotY: rng() * 6.28, scale: 0.8 + rng() * 0.45, tint: rng() });
    }
    await row(4, gz);
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
      if (h < waterLevelAt(x, z) + 2 || slopeAt(x, z) > 0.22 || sandAt(x, z) > 0.3) continue;
      // along the contour (logs settle across the slope)
      const gxH = heightAt(x + 2, z) - heightAt(x - 2, z);
      const gzH = heightAt(x, z + 2) - heightAt(x, z - 2);
      let ang = Math.atan2(gxH, -gzH) + jitter; // direction (-gz, gx): across the gradient
      if (flip) ang += Math.PI;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      const half_ = (NURSE.length / 2) * scale;
      let ok = true;
      for (let k = -2; k <= 2; k++) {
        const px = x + dx * half_ * k * 0.5;
        const pz = z + dz * half_ * k * 0.5;
        if (trail.distanceTo(px, pz) < TRAIL_WIDTH + 2.5 || Math.hypot(px - CLEARING.x, pz - CLEARING.z) < 12 || offStream(px, pz) < 3) ok = false;
      }
      if (!ok) continue;
      // Seat it so that nowhere along or across it does the ground come up more than 0.9 of a
      // radius into the trunk (its top half always shows: a hump under the middle once swallowed
      // it to the top), and leave it out where that has it bridging a dip (its underside more
      // than 0.4 m off the ground). About 2/3 of the spots keep their log.
      let y = -Infinity;
      const under = []; // the ground minus the log's underside there (above its origin)
      for (let k = 0; k <= 16; k++) {
        const u = 0.02 + (0.96 * k) / 16;
        const along = (u - 0.5) * NURSE.length * scale;
        const { r, top } = nurseAt(u);
        for (const side of [-0.7, 0, 0.7]) {
          const px = x + dx * along - dz * r * scale * side;
          const pz = z + dz * along + dx * r * scale * side;
          const d = groundAt(px, pz) - (top - r - Math.sqrt(1 - side * side) * r) * scale;
          under.push(d);
          y = Math.max(y, d - 0.9 * r * scale);
        }
      }
      const seated = under.every((d) => y - d < 0.4);
      // three's rotation about Y maps local +X to (cos r, -sin r)
      const rotY = Math.atan2(-dz, dx);
      const tint = rng(); // (drawn either way, with what grows on it, so the rng sequence stays put)
      if (seated) add('log_nurse', { x, y, z, rotY, scale, tint, axis: [dx, dz] });
      // what grows on it
      for (let k = 0; k < 12; k++) {
        const u = 0.12 + 0.78 * rng();
        const along = (u - 0.5) * NURSE.length * scale;
        const { top } = nurseAt(u);
        const px = x + dx * along;
        const pz = z + dz * along;
        const py = y + top * scale - 0.05;
        const what = rng();
        const put = (name, it) => seated && add(name, it);
        if (what < 0.35) put('sapling', { x: px, y: py, z: pz, rotY: rng() * 6.28, scale: 0.2 + rng() * 0.18, tint: rng() });
        else if (what < 0.8) put(rng() < 0.5 ? 'fern_a' : 'fern_b', { x: px, y: py, z: pz, rotY: rng() * 6.28, scale: 0.5 + rng() * 0.35, tint: rng() });
      }
    }
    await row(5, gz);
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
      if (h < waterLevelAt(x, z) + 0.3 || sandAt(x, z) > 0.3) continue;
      // (slopeAt's own sums: the gradient also points uphill, below)
      const ux = heightAt(x + 1.5, z) - heightAt(x - 1.5, z);
      const uz = heightAt(x, z + 1.5) - heightAt(x, z - 1.5);
      const slope = 1 - 3 / Math.hypot(ux, 3, uz);
      const d = trail.distanceTo(x, z);
      if (d < TRAIL_WIDTH * 0.5 + 0.2) continue; // off the tread itself
      const edge = THREE.MathUtils.smoothstep(d, TRAIL_WIDTH * 0.5, TRAIL_WIDTH * 0.5 + 0.8) * (1 - THREE.MathUtils.smoothstep(d, TRAIL_WIDTH + 2, TRAIL_WIDTH + 5));
      // around and below the bare rock (rockyslope.js), where the stones come from; elsewhere a
      // few, in clusters (a stone every ~5 m everywhere read as polka dots on open slopes)
      let rock = rockFieldAt(x, h, z, slope);
      if (slope > 0.08 && rock > 0.05) {
        const ul = Math.hypot(ux, uz);
        const rise = ul / 3; // per metre
        for (const up of [3, 7]) rock = Math.max(rock, rockFieldAt(x + ux / ul * up, h + rise * up, z + uz / ul * up, slope) - up * 0.02);
      }
      const stony = THREE.MathUtils.smoothstep(rock, 0.3, 0.52);
      const cluster = THREE.MathUtils.smoothstep(nForest(x * 0.15 + 70, z * 0.15 - 30) * 0.5 + 0.5, 0.45, 0.75);
      const high = THREE.MathUtils.smoothstep(h, 60, 110) * cluster;
      const duff = THREE.MathUtils.smoothstep(nForest(x * 0.0045, z * 0.0045) * 0.5 + 0.5, 0.4, 0.7);
      const bed = streamBed(x, z); // cobbles and gravel line the streams
      const p = Math.min(0.95, 0.04 + 0.18 * cluster + 0.75 * edge + 0.85 * stony + 0.25 * high + 0.7 * bed) * (1 - 0.5 * duff * (1 - edge) * (1 - bed));
      if (r > p) continue;
      if (snowAmount(x, z, h, slope) > 0.3) continue;
      const kind = PEBBLES[Math.floor(pick * PEBBLES.length)];
      // on stony slopes the cobbles grow into scree: small talus blocks
      // (cobbles stay cobble-sized: blown up ×3.5 into talus, these 20-faced stones read as flat grey
      // polygons until you got close enough for their photo; the talus is scanned boulders, addTalus)
      const talus = kind === 'pebbles_d' ? 1 + 0.5 * stony : 1;
      const scale = (0.8 + r * 0.6 / Math.max(p, 0.1)) * talus;
      // the cluster lies on the slope (fitted over its own spread, ~0.8 m × scale): level, its
      // downhill stones floated up to ~2 m over steep ground
      const sp = 0.8 * scale;
      const dhx = (groundAt(x + sp, z) - groundAt(x - sp, z)) / (2 * sp);
      const dhz = (groundAt(x, z + sp) - groundAt(x, z - sp)) / (2 * sp);
      const nl = Math.hypot(dhx, 1, dhz);
      add(kind, { x, y: groundAt(x, z) - 0.02 * talus, z, rotY: pick * 97.3, scale, tint: rng(), normal: [-dhx / nl, 1 / nl, -dhz / nl] });
    }
    await row(6, gz);
  }

  placeTrailFurniture(trail, add);
  return out;
}

/** Bake the far-tree impostors from every tree type's full-detail model (see impostors.js). */
export async function bakeTreeImpostors(renderer, protos, { lowPower }) {
  const trees = {};
  for (const [name, parts] of Object.entries(protos)) {
    if (KIND(name) === 'trees' && !name.endsWith('_lod') && protos[`${name}_lod`]) trees[name] = parts;
  }
  return bakeImpostors(renderer, trees, { frameW: lowPower ? 128 : 192 });
}

/** Shrubs (ferns, salal) that get a billboard far tier (see impostorMaterial's `shrubs`). */
const SHRUB = (name) => KIND(name) === 'ferns' && !name.startsWith('pebbles');

/** The same bake for the shrubs: low and wide, so square frames. */
export async function bakeShrubImpostors(renderer, protos, { lowPower }) {
  const shrubs = {};
  for (const [name, parts] of Object.entries(protos)) if (SHRUB(name) && !name.endsWith('_lod')) shrubs[name] = parts;
  return bakeImpostors(renderer, shrubs, { frameW: lowPower ? 64 : 96, aspect: 1 });
}

/**
 * Open hillsides (hash, no scatter rng): low shrubs in clumps, exactly where the terrain shader
 * paints its dark shrub patches (the same noise), so up close they're plants and beyond the
 * shrubs' range the same clumps carry on as speckles; and stunted conifers clinging on, sparse,
 * on slopes too steep for the forest (0.25-0.55), standing on the ground between the outcrops.
 * Open slopes used to be bare, even felt with stones dotted over them (the user).
 */
/**
 * Talus: small scanned boulders where stones gather around and just below the bare rock
 * (rockyslope.js, the same field as the pebbles; hash, no scatter rng). Scans carry their photo
 * at every distance, unlike the low-poly cobbles that used to be scaled up for this.
 */
const TALUS = ['boulder_a', 'boulder_c', 'boulder_i'];
function addTalus(placements, trail) {
  const half = WORLD_SIZE / 2 - 20;
  const STEP = 4.5;
  for (let gz = -half; gz < half; gz += STEP) {
    for (let gx = -half; gx < half; gx += STEP) {
      const x = gx + hash2(gx - 3.3, gz + 1.1) * STEP;
      const z = gz + hash2(gx + 2.2, gz - 4.4) * STEP;
      const hv = hash2(x * 0.7, z * 1.3);
      if (hv > 0.5) continue; // (cheap out before the terrain lookups)
      const h = heightAt(x, z);
      const ux = heightAt(x + 1.5, z) - heightAt(x - 1.5, z);
      const uz = heightAt(x, z + 1.5) - heightAt(x, z - 1.5);
      const slope = 1 - 3 / Math.hypot(ux, 3, uz);
      if (slope < 0.1 || slope > 0.6) continue;
      let rock = rockFieldAt(x, h, z, slope);
      const ul = Math.hypot(ux, uz);
      for (const up of [3, 7]) rock = Math.max(rock, rockFieldAt(x + ux / ul * up, h + ul / 3 * up, z + uz / ul * up, slope) - up * 0.02);
      const stony = THREE.MathUtils.smoothstep(rock, 0.35, 0.55);
      if (hv > 0.5 * stony) continue;
      if (h < waterLevelAt(x, z) + 0.5 || sandAt(x, z) > 0.3 || snowAmount(x, z, h, slope) > 0.3) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 1.5 || offStream(x, z) < 1) continue;
      const k = hash2(z * 1.7, x * 0.3);
      // (three of the scans: each variant in a chunk is a draw, and all nine added ~19 on a rocky slope)
      const name = TALUS[Math.floor(k * TALUS.length)];
      const scale = 0.22 + 0.33 * hash2(x + 5.5, z - 5.5) ** 1.5;
      (placements[name] ||= []).push({ x, y: groundAt(x, z), z, rotY: k * 71, scale, tint: hash2(x - 9, z + 9) });
    }
  }
}

function addSlopeGrowth(placements, trail) {
  const half = WORLD_SIZE / 2 - 20;
  const put = (name, p) => (placements[name] ||= []).push(p);
  const STEP = 2.2;
  for (let gz = -half; gz < half; gz += STEP) {
    for (let gx = -half; gx < half; gx += STEP) {
      const x = gx + hash2(gx, gz + 0.5) * STEP;
      const z = gz + hash2(gx + 0.5, gz) * STEP;
      // the shader's shrub clumps (terrain.js), before anything costly
      const n1 = valueNoise(x * 0.55 + 2, z * 0.55 + 2) * 0.7 + valueNoise(x * 1.9, z * 1.9) * 0.3;
      const clump = THREE.MathUtils.smoothstep(n1, 0.52, 0.72) * THREE.MathUtils.smoothstep(valueNoise(x * 0.07 - 6, z * 0.07 - 6), 0.3, 0.6);
      const hv = hash2(x * 1.3, z * 0.7);
      if (hv > 0.05 + clump) continue;
      const f = nForest(x * 0.0045, z * 0.0045) * 0.5 + 0.5;
      const open = 1 - THREE.MathUtils.smoothstep(f, 0.25, 0.45); // (the forest has its own salal and ferns)
      if (hash2(x + 3.1, z) > open) continue;
      const h = heightAt(x, z);
      if (h < waterLevelAt(x, z) + 1.5 || h > SNOWLINE + 10 || sandAt(x, z) > 0.2) continue;
      const slope = slopeAt(x, z);
      if (slope < 0.05 || slope > 0.42 || snowAmount(x, z, h, slope) > 0.15) continue;
      if (rockFieldAt(x, h, z, slope) > 0.44) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 0.6 || offStream(x, z) < 1.2) continue;
      const k = hash2(z, x);
      const name = h < 70 && k < 0.25 ? (k < 0.12 ? 'fern_a' : 'fern_b') : 'salal';
      put(name, { x, y: groundAt(x, z) - 0.05, z, rotY: k * 97, scale: 0.75 + hash2(x - 7, z) * 0.6, tint: hash2(x, z - 7) });
    }
  }
  const TREE_STEP = 8;
  for (let gz = -half; gz < half; gz += TREE_STEP) {
    for (let gx = -half; gx < half; gx += TREE_STEP) {
      const x = gx + hash2(gx + 0.25, gz - 0.75) * TREE_STEP;
      const z = gz + hash2(gx - 0.75, gz + 0.25) * TREE_STEP;
      const slope = slopeAt(x, z);
      const steep = THREE.MathUtils.smoothstep(slope, 0.25, 0.32) * (1 - THREE.MathUtils.smoothstep(slope, 0.45, 0.55));
      const f = nForest(x * 0.0045, z * 0.0045) * 0.5 + 0.5;
      if (hash2(x * 0.9, z * 1.1) > steep * (0.12 + 0.3 * f)) continue;
      const h = heightAt(x, z);
      if (h < waterLevelAt(x, z) + 1.5 || h > TREELINE - 30 || sandAt(x, z) > 0.2) continue;
      if (rockFieldAt(x, h, z, slope) > 0.5) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 2.3 || offStream(x, z) < 2.5) continue;
      const snow = snowAmount(x, z, h, slope) > 0.1;
      const k = hash2(x - 1.7, z + 2.3);
      const name = snow ? (k < 0.5 ? 'fir_snow' : k < 0.75 ? 'hemlock_snow' : 'sapling_snow') : (k < 0.45 ? 'fir' : k < 0.75 ? 'hemlock' : 'sapling');
      const alt = THREE.MathUtils.clamp(h / TREELINE, 0, 1);
      put(name, { x, y: groundAt(x, z) - 0.3, z, rotY: k * 63, scale: (0.5 + hash2(z + 9, x) * 0.45) * (1 - alt * 0.35), tint: hash2(x + 9, z) });
    }
  }
}

/**
 * Where everything goes: the scatter plus the hand-placed extras, seated on the ground, as
 * { name: [{ x, y, z, rotY, scale, tint, ... }] }. The slow, deterministic part of loading,
 * so the world bake (world.js) stores its result.
 */
export async function placeVegetation(protos, trail) {
  const placements = await scatter(trail);
  addStreamRocks(placements, protos, trail);
  addMarshSnags(placements, trail);
  addLeaners(placements, trail);
  addDriftwood(placements, trail);
  addSlopeGrowth(placements, trail);
  addTalus(placements, trail);
  // no loose stones on the footbridges' berms (filtered after the scatter: its rng sequence stays put)
  for (const name of Object.keys(placements)) {
    if (!name.startsWith('pebbles')) continue;
    placements[name] = placements[name].filter((q) => !trail.crossings.some((b) => Math.hypot(q.x - b.x, q.z - b.z) < b.reach + 8));
  }
  await loadTick(0.77);
  seatStones(placements, protos);
  return placements;
}

/**
 * Builds the vegetation as per-chunk InstancedMeshes so far-away chunks can be
 * hidden cheaply, and a spatial hash of trunks/rocks for player collisions.
 * With `impostors` (bakeTreeImpostors), far trees are billboards: one draw per
 * chunk for all tree types, instead of the *_lod models per type.
 */
export async function buildVegetation(protos, trail, { impostors = null, shrubImpostors = null, exclude = null, placements: baked = null } = {}) {
  const placements = baked ?? await placeVegetation(protos, trail);
  // nothing where the cabin stands (filtered, so the scatter's rng sequence stays put; and after the
  // world bake, which doesn't know the cabin: every step before is per item, so the order doesn't matter)
  if (exclude) {
    for (const name of Object.keys(placements)) {
      if (name === 'signpost') continue;
      const tree = KIND(name) === 'trees';
      const margin = tree ? 3.5 : 0.8;
      // logs lie along their local X: test points along their length (a nurse log centred just outside
      // the cave's clear zone lay across its mouth: the user)
      let reach = null;
      if (name.startsWith('log') && protos[name]) {
        reach = [0, 0];
        for (const { geometry } of protos[name]) {
          geometry.computeBoundingBox();
          reach[0] = Math.min(reach[0], geometry.boundingBox.min.x);
          reach[1] = Math.max(reach[1], geometry.boundingBox.max.x);
        }
      }
      const out = (q) => {
        if (!reach) return exclude(q.x, q.z, margin, tree && name);
        const k = q.scale * (q.scaleX ?? 1);
        const c = Math.cos(q.rotY);
        const sn = Math.sin(q.rotY);
        for (let i = 0; i <= 6; i++) {
          const t = (reach[0] + ((reach[1] - reach[0]) * i) / 6) * k;
          if (exclude(q.x + c * t, q.z - sn * t, margin, false)) return true;
        }
        return false;
      };
      placements[name] = placements[name].filter((q) => !out(q));
    }
  }
  await loadTick(0.8);
  const canopyAt = bakeCanopy(placements);
  await loadTick(0.82);
  const nPlaced = Object.keys(placements).length;
  let placed = 0;
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
  const zAxis = new THREE.Vector3(0, 0, 1);
  const tiltQ = new THREE.Quaternion();
  const normalV = new THREE.Vector3();
  const col = new THREE.Color();
  const counts = {};

  const nearPools = [];
  const impostorBuckets = new Map(); // chunk key -> [{ matrices, idx, colors, frame }]
  const shrubBuckets = new Map(); // the same for the shrubs' billboards

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
    await loadTick(0.82 + (0.18 * placed++) / nPlaced);
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
      if (it.normal) q.premultiply(tiltQ.setFromUnitVectors(up, normalV.fromArray(it.normal))); // laid on the slope
      if (it.tilt) q.multiply(tiltQ.setFromAxisAngle(zAxis, it.tilt)); // pitched along local X (footbridges on a grade)
      s.setScalar(it.scale);
      if (it.scaleX) s.x *= it.scaleX; // stretched along local X only (footbridges)
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
      if (name === 'log_leaning') {
        // circles along the part you could walk into (below ~2 m off its base's ground)
        const [dx, dz] = it.axis;
        for (let s = 0; s * Math.sin(it.tilt) < 2 && s < LEANER.length * it.scale; s += 0.7) {
          const r = leanerR(s / (LEANER.length * it.scale)) * it.scale;
          addCollider(it.x + dx * s * Math.cos(it.tilt), it.z + dz * s * Math.cos(it.tilt), r + 0.1);
        }
      }
    });
    const farColors = farParts.map((part) => instanceColors(part.material.name, tints, shades, n));
    const frame = kind === 'trees' && impostors?.info[name];
    const shrubFrame = SHRUB(name) && shrubImpostors?.info[name];
    const impColors = frame || shrubFrame ? instanceColors('LodVertexColor', tints, shades, n) : null;

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
          trees: [], rocks: [], ferns: [], shrubs: [],
        });
      }
      const chunk = chunks.get(key);
      if (shrubFrame) {
        if (!shrubBuckets.has(key)) shrubBuckets.set(key, []);
        for (const it of items) shrubBuckets.get(key).push({ matrices, idx: it.idx, colors: impColors, frame: shrubFrame });
      }
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
      pool.name = name;
      for (const im of pool.meshes) {
        im.name = `${name}:${im.material.name}@near`;
        im.userData.kind = kind;
        group.add(im);
      }
      nearPools.push(pool);
    }
  }

  for (const [baked, buckets, shrubs] of [[impostors, impostorBuckets, false], [shrubImpostors, shrubBuckets, true]]) {
    if (!baked) continue;
    const tallest = Math.max(...Object.values(baked.info).map((f) => Math.max(f.height + f.yMin, f.halfWidth * 2)));
    const geo = impostorGeometry(tallest * (shrubs ? 1.8 : 1)); // (shrubs are scaled up to ~1.8)
    const mat = impostorMaterial(baked, { shrubs });
    for (const [key, items] of buckets) {
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
      im.name = `${shrubs ? 'shrub ' : ''}impostors@${key}`;
      im.userData.kind = shrubs ? 'ferns' : 'trees';
      group.add(im);
      chunks.get(key)[shrubs ? 'shrubs' : 'trees'].push(im);
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
      // the shrubs' billboards: from where the near shrubs give way out to where they dissolve
      const far = shared.uShrubFar.value;
      const showShrubs = !disabled.has('ferns') && d < far && d + 2 * halfDiag > shared.uFernRadius.value * 0.86;
      for (const mesh of chunk.shrubs) mesh.visible = showShrubs;
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
