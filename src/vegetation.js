import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  WORLD_SIZE, CHUNK_SIZE, VIEW_DIST, WATER_LEVEL, SNOWLINE, TREELINE, SEED, SPAWN,
} from './config.js';
import {
  heightAt, groundAt, slopeAt, snowAmount, snowlineAt, nForest, mulberry32,
} from './terrain.js';
import { TRAIL_WIDTH } from './trail.js';
import { addWindSway, addGroundCover } from './materials.js';
import { bakePrototypeAO, bakeCanopy } from './bake.js';

const KIND = (name) => (name.startsWith('fern') ? 'ferns'
  : /^(rock|log|stump|signpost|cairn|bench)/.test(name) ? 'rocks' : 'trees');

/** Numeric spatial-hash key (no string garbage in per-frame lookups). */
const cellKey = (gx, gz) => (gx + 32768) * 65536 + (gz + 32768);

// Trunk radius (m, at scale 1) used for walking collisions.
const COLLIDE = {
  fir: 0.75, fir_snow: 0.75, hemlock: 0.6, hemlock_snow: 0.6, cedar: 1.1,
  sapling: 0.25, sapling_snow: 0.25, snag: 0.65,
  rock_a: 1.6, rock_b: 1.2, rock_c: 2.0, stump: 1.0,
  signpost: 0.25, cairn: 0.6, bench: 0.9,
};

/** Load forest.glb and turn each top-level node into a list of {geometry, material}. */
export async function loadPrototypes(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const materialCache = new Map();
  const protos = {};

  for (const root of gltf.scene.children) {
    const parts = [];
    const rootInv = root.matrixWorld.clone().invert();
    root.traverse((o) => {
      if (!o.isMesh) return;
      const geometry = o.geometry.clone();
      geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld));
      geometry.computeBoundingSphere();
      parts.push({ geometry, material: convertMaterial(o.material, root.name, materialCache) });
    });
    bakePrototypeAO(parts, KIND(root.name));
    protos[root.name] = parts;
  }
  return protos;
}

function convertMaterial(src, assetName, cache) {
  const kind = KIND(assetName);
  const key = `${src.name}|${kind}`;
  if (cache.has(key)) return cache.get(key);

  const mat = new THREE.MeshStandardMaterial({
    name: src.name,
    color: src.color.clone(),
    roughness: src.roughness ?? 0.9,
    metalness: 0,
    flatShading: true,
    side: kind === 'ferns' ? THREE.DoubleSide : THREE.FrontSide,
  });
  // needles shed water and scatter light: keep sky reflections off foliage
  if (/Needles|Foliage|Fern/.test(src.name)) mat.envMapIntensity = 0.35;
  if (kind === 'trees') addWindSway(mat);
  else if (kind === 'ferns') addWindSway(mat, 2.5);
  else addGroundCover(mat);
  cache.set(key, mat);
  return mat;
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

      const scale = (0.65 + rng() * 0.6) * (1 - alt * 0.35);
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
        const name = ['rock_a', 'rock_b', 'rock_c'][Math.floor(rng() * 3)];
        add(name, { x, y: groundAt(x, z) - 0.35, z, rotY: rng() * 6.28, scale: 0.5 + rng() * rng() * 2.2, tint: rng() });
      } else if (r < 0.2 && h < SNOWLINE + 30 && slope < 0.25) {
        add('log', { x, y: groundAt(x, z) - 0.25, z, rotY: rng() * 6.28, scale: 0.7 + rng() * 0.5, tint: rng() });
      } else if (r < 0.24 && h < SNOWLINE && slope < 0.3) {
        add('stump', { x, y: groundAt(x, z) - 0.1, z, rotY: rng() * 6.28, scale: 0.7 + rng() * 0.6, tint: rng() });
      }
    }
  }

  // Sword ferns ----------------------------------------------------------------
  const fernCell = 3.2;
  for (let gz = -half; gz < half; gz += fernCell) {
    for (let gx = -half; gx < half; gx += fernCell) {
      const x = gx + rng() * fernCell;
      const z = gz + rng() * fernCell;
      const f = nForest(x * 0.0045, z * 0.0045) * 0.5 + 0.5;
      const clump = nForest(x * 0.05 + 40, z * 0.05 - 17) * 0.5 + 0.5;
      if (rng() > f * clump * 0.9) continue;
      const h = heightAt(x, z);
      if (h < WATER_LEVEL + 1 || h > SNOWLINE - 25) continue;
      if (slopeAt(x, z) > 0.35) continue;
      if (trail.distanceTo(x, z) < TRAIL_WIDTH + 0.4) continue;
      add(rng() < 0.5 ? 'fern_a' : 'fern_b', {
        x, y: groundAt(x, z) - 0.05, z, rotY: rng() * 6.28, scale: 0.8 + rng() * 0.8, tint: rng(),
      });
    }
  }

  placeTrailFurniture(trail, add);
  return out;
}

/**
 * Builds the vegetation as per-chunk InstancedMeshes so far-away chunks can be
 * hidden cheaply, and a spatial hash of trunks/rocks for player collisions.
 */
export function buildVegetation(protos, trail) {
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

  for (const [name, list] of Object.entries(placements)) {
    const parts = protos[name];
    if (!parts) {
      console.warn('missing prototype', name);
      continue;
    }
    counts[name] = list.length;
    const kind = KIND(name);

    // bucket placements per chunk
    const buckets = new Map();
    for (const inst of list) {
      const cx = Math.floor(inst.x / CHUNK_SIZE);
      const cz = Math.floor(inst.z / CHUNK_SIZE);
      const key = `${cx},${cz}`;
      if (!buckets.has(key)) buckets.set(key, { cx, cz, items: [] });
      buckets.get(key).items.push(inst);

      const r = COLLIDE[name];
      if (r) {
        const ck = cellKey(Math.floor(inst.x / COLL_CELL), Math.floor(inst.z / COLL_CELL));
        if (!colliders.has(ck)) colliders.set(ck, []);
        colliders.get(ck).push({ x: inst.x, z: inst.z, r: r * inst.scale });
      }
    }

    for (const [key, { cx, cz, items }] of buckets) {
      if (!chunks.has(key)) {
        chunks.set(key, {
          center: new THREE.Vector2((cx + 0.5) * CHUNK_SIZE, (cz + 0.5) * CHUNK_SIZE),
          trees: [], rocks: [], ferns: [],
        });
      }
      const chunk = chunks.get(key);
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, items.length);
        const tintable = /Needles|Foliage|Fern|Rock/.test(part.material.name);
        items.forEach((it, i) => {
          q.setFromAxisAngle(up, it.rotY);
          s.setScalar(it.scale);
          p.set(it.x, it.y, it.z);
          m.compose(p, q, s);
          im.setMatrixAt(i, m);
          if (tintable) {
            const t = it.tint;
            col.setRGB(0.85 + t * 0.3, 0.88 + t * 0.24, 0.85 + (1 - t) * 0.25);
          } else {
            col.setRGB(1, 1, 1);
          }
          // baked shade: understory under a closed canopy gets much less light
          const occ = canopyAt(it.x, it.z);
          col.multiplyScalar(1 - occ * (kind === 'trees' ? 0.22 : 0.45));
          im.setColorAt(i, col);
        });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.name = `${name}:${part.material.name}@${key}`;
        group.add(im);
        chunk[kind].push(im);
      }
    }
  }

  console.info('vegetation instances', JSON.stringify(counts));

  function updateVisibility(cameraPos) {
    const halfDiag = CHUNK_SIZE * 0.7072;
    for (const chunk of chunks.values()) {
      const d = Math.hypot(chunk.center.x - cameraPos.x, chunk.center.y - cameraPos.z) - halfDiag;
      for (const kind of ['trees', 'rocks', 'ferns']) {
        const vis = d < VIEW_DIST[kind];
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

  return { group, updateVisibility, collide, counts, canopyAt, chunks };
}
