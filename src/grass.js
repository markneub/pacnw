import * as THREE from 'three';
import { WORLD_SIZE, WATER_LEVEL } from './config.js';
import {
  terrainGrid, terrainSurface, cutUniforms, nForest, mulberry32, rawGroundAt, waterLevelAt, marshAt, MARSH, sandAt, SEA_LEVEL,
} from './terrain.js';
import { rockFieldAt } from './rockyslope.js';
import { shared, patchSunlight, sunKey } from './materials.js';

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
    { size: 22, count: 10000, fade: [0, 0, 6, 11] }, // ~21 tufts/m2 (~165 blades)
    { size: 56, count: 22000, fade: [6, 11, 16, 28] }, // ~7 tufts/m2
  ],
  phone: [
    // first phone version (3000 + 5600, no culling) cost 1.7 ms of a throttled
    // ~15 ms frame; culling now skips about half, which pays for wider fades
    { size: 16, count: 2800, fade: [0, 0, 4, 8] },
    { size: 36, count: 4500, fade: [4, 8, 10, 18] },
  ],
};
const CHUNKS = 6; // per side: each ring is CHUNKS^2 meshes, culled on the CPU
const SAMPLES = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.5, 0], [0, 0.5], [1, 0.5], [0.5, 1]];

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
const CELL = 16; // m, for skipping rings with no grass in reach
const LUSH = new THREE.Color('#566f2e');
const SEDGE = new THREE.Color(0x6f7a34); // marsh sedge, olive
const DRY = new THREE.Color('#857f4c');
const MARRAM = new THREE.Color(0x9a9a62); // dune grass: pale grey-green going to straw

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

  const surface = terrainSurface();
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
      for (let c = 0; c < 4; c++) layers[c] = surface.layers[k * 4 + c]; // (terrain.js groundLayers)
      // the baked canopy is soft and low (a closed crown reads ~0.3-0.5), so stretch it, as the
      // dappled sunlight does: under a closed canopy the floor is moss and ferns, not lawn
      const open = 1 - Math.min(1, canopyAt(x, z) * 2.2);
      const meadow = smooth(nForest(x * 0.011 + 31, z * 0.011 - 17) * 0.5 + 0.5, 0.3, 0.75);
      const wl = waterLevelAt(x, z);
      const shore = 1 - smooth(y, wl + 3, wl + 14);
      // no grass through snow (the 5 m map would smear it over the snow edge)
      const snowFree = 1 - smooth(layers[2], 0.03, 0.3);
      let density = layers[0] * snowFree * Math.min(1, 0.03 + 0.97 * open * open * (0.3 + 0.7 * meadow) + 0.8 * shore * open);
      density *= 1 - smooth(rockFieldAt(x, y, z, slope), 0.42, 0.56); // not on bare rock (rockyslope.js)
      // the marsh: tall sedge in clumps on the hummocks and out of the shallow water
      const m = marshAt(x, z);
      if (m > 0.05) density = Math.max(density, m * smooth(nForest(x * 0.08 + 5, z * 0.08) * 0.5 + 0.5, 0.25, 0.6) * (y > wl - 0.35 ? 1 : 0));
      else if (y < wl + 0.2) density = 0;
      // the dunes: tussocks of beach grass, thick on the crests and back dunes, none on the beach
      const sand = sandAt(x, z);
      const dune = sand * smooth(y, SEA_LEVEL + 3, SEA_LEVEL + 7) * (1 - smooth(slope, 0.15, 0.4));
      if (sand > 0.02) density = density * (1 - sand) + 0.75 * dune * smooth(nForest(x * 0.06 + 13, z * 0.06 - 4) * 0.5 + 0.5, 0.3, 0.62);

      col.fromArray(surface.color, k * 3); // (groundColor)
      const shade = Math.min(1.2, lum(shaded[k * 3], shaded[k * 3 + 1], shaded[k * 3 + 2]) / Math.max(1e-4, lum(col.r, col.g, col.b)));
      // greener by water and in meadows, drier higher up; a little of the
      // ground's own tint so it belongs to the place
      grass.copy(LUSH).lerp(DRY, smooth(y, 60, 150) * 0.7 + (1 - meadow) * 0.15).lerp(col, 0.25);
      // marsh sedge: olive, going to straw in patches
      if (m > 0.05) grass.lerp(SEDGE, m * 0.8).lerp(DRY, m * 0.35 * smooth(nForest(x * 0.05 - 9, z * 0.05) * 0.5 + 0.5, 0.45, 0.8));
      if (sand > 0.02) grass.lerp(MARRAM, sand * 0.85).lerp(DRY, sand * 0.4 * smooth(nForest(x * 0.04, z * 0.04 + 7) * 0.5 + 0.5, 0.4, 0.8));
      grass.multiplyScalar(shade);
      const srgb = grass.convertLinearToSRGB();
      data[k * 4] = Math.min(255, srgb.r * 255);
      data[k * 4 + 1] = Math.min(255, srgb.g * 255);
      data[k * 4 + 2] = Math.min(255, srgb.b * 255);
      data[k * 4 + 3] = Math.round(density * 255);
    }
  }
  surface.release();
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  const ht = new THREE.DataTexture(heights, n, n, THREE.RedFormat, THREE.FloatType);
  ht.needsUpdate = true; // read with texelFetch only (no filtering needed)
  // highest density per CELL-metre cell, so whole rings can be skipped where
  // there's no grass in reach (snowfields, deep forest, the lake)
  const cells = Math.ceil(WORLD_SIZE / CELL);
  const cellMax = new Uint8Array(cells * cells);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const c = Math.min(cells - 1, Math.floor((iz * step) / CELL)) * cells + Math.min(cells - 1, Math.floor((ix * step) / CELL));
      cellMax[c] = Math.max(cellMax[c], data[(iz * n + ix) * 4 + 3]);
    }
  }
  return { map: tex, height: ht, n, step, cellMax, cells };
}

/**
 * `density` scales the tuft counts (1 = default), for tuning on devices
 * (?grass=50 is half).
 */
export function buildGrass(terrain, canopyAt, { lowPower, density = 1 }) {
  const baked = bakeGrassMap(terrain, canopyAt);
  // past the tufts the ground itself takes on the grass's colour (terrain.js), so where they
  // fade out they fade into grassy ground instead of bare earth
  const outer = (lowPower ? RINGS.phone : RINGS.desktop).at(-1).fade;
  shared.uGrassMap.value = baked.map;
  shared.uGrassTint.value.set(outer[2], outer[3]);
  const tuft = tuftGeometry();
  const group = new THREE.Group();
  group.name = 'grass';
  const rings = (lowPower ? RINGS.phone : RINGS.desktop).map((ring, i) => {
    // spread the tufts over the tile, then bin them into CHUNKS x CHUNKS chunks
    const count = Math.max(1, Math.round(ring.count * density));
    const rng = mulberry32(4242 + i);
    const bins = Array.from({ length: CHUNKS * CHUNKS }, () => []);
    for (let k = 0; k < count; k++) {
      const u = rng();
      const v = rng();
      bins[Math.floor(v * CHUNKS) * CHUNKS + Math.floor(u * CHUNKS)].push(u, v);
    }
    const material = grassMaterial(baked, ring);
    const chunks = bins.map((offsets, c) => {
      const geo = new THREE.InstancedBufferGeometry();
      for (const name of ['position', 'normal', 'aT']) geo.setAttribute(name, tuft.attributes[name]);
      geo.setIndex(tuft.index);
      geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(offsets), 2));
      geo.instanceCount = offsets.length / 2;
      geo.userData.count = geo.instanceCount;
      const mesh = new THREE.Mesh(geo, material);
      mesh.frustumCulled = false; // culled per chunk in update()
      // the chunk's span of the tile, in metres from the tile corner
      mesh.userData.u = [(c % CHUNKS) * ring.size / CHUNKS, ((c % CHUNKS) + 1) * ring.size / CHUNKS];
      mesh.userData.v = [Math.floor(c / CHUNKS) * ring.size / CHUNKS, (Math.floor(c / CHUNKS) + 1) * ring.size / CHUNKS];
      group.add(mesh);
      return mesh;
    });
    return { ring, chunks, cam: material.userData.cam };
  });

  const frustum = new THREE.Frustum();
  const viewProj = new THREE.Matrix4();
  const box = new THREE.Box3();
  const xs = [0, 0, 0, 0];
  const zs = [0, 0, 0, 0];
  return {
    mesh: group,
    map: baked.map, // debugging: density in alpha
    /** Once per frame, after the camera moved (no allocation). */
    update(camera) {
      const { x, z } = camera.position;
      camera.updateMatrixWorld();
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProj);
      for (const { ring, chunks, cam } of rings) {
        cam.set(x, z);
        // a ring with no grass anywhere in reach isn't drawn at all
        const any = grassNear(baked, x, z, ring.fade[3]);
        const ox = x - ring.size / 2;
        const oz = z - ring.size / 2;
        for (const mesh of chunks) {
          if (!any) {
            mesh.visible = false;
            continue;
          }
          // where this chunk's tufts are this frame: its span of the tile,
          // wrapped into the window around the camera (1 or 2 pieces per axis)
          const nx = wrapSpan(mesh.userData.u, ox, ring.size, xs);
          const nz = wrapSpan(mesh.userData.v, oz, ring.size, zs);
          let vis = false;
          for (let a = 0; a < nx && !vis; a++) {
            for (let b = 0; b < nz && !vis; b++) {
              const x0 = xs[a * 2];
              const x1 = xs[a * 2 + 1];
              const z0 = zs[b * 2];
              const z1 = zs[b * 2 + 1];
              // nearest and farthest horizontal distance from the camera
              const nearX = Math.max(x0 - x, 0, x - x1);
              const nearZ = Math.max(z0 - z, 0, z - z1);
              const farX = Math.max(Math.abs(x0 - x), Math.abs(x1 - x));
              const farZ = Math.max(Math.abs(z0 - z), Math.abs(z1 - z));
              if (Math.hypot(nearX, nearZ) > ring.fade[3]) continue; // all beyond the ring
              if (Math.hypot(farX, farZ) < ring.fade[0]) continue; // all inside its fade-in
              // its real ground height range (a tall box behind a camera
              // looking slightly down reaches into the view and never culls)
              let lo = Infinity;
              let hi = -Infinity;
              for (const [sx, sz] of SAMPLES) {
                const h = rawGroundAt(x0 + (x1 - x0) * sx, z0 + (z1 - z0) * sz);
                lo = Math.min(lo, h);
                hi = Math.max(hi, h);
              }
              box.min.set(x0, lo - 2, z0);
              box.max.set(x1, hi + 2.5, z1); // humps between samples, blade height
              vis = frustum.intersectsBox(box);
            }
          }
          mesh.visible = vis;
        }
      }
    },
    /** Draw only a share (0..1) of the tufts that were built (?bench). */
    setShare(f) {
      for (const { chunks } of rings) {
        for (const m of chunks) m.geometry.instanceCount = Math.round(m.geometry.userData.count * f);
      }
    },
  };
}

/**
 * World interval(s) covered by tile span [lo, hi) (m) when the tile wraps
 * into the window [origin, origin + size): out = [a0, a1, b0, b1]; returns 1 or 2.
 */
function wrapSpan([lo, hi], origin, size, out) {
  const a = origin + ((((lo - origin) % size) + size) % size);
  const b = a + (hi - lo);
  out[0] = a;
  if (b <= origin + size) {
    out[1] = b;
    return 1;
  }
  out[1] = origin + size;
  out[2] = origin;
  out[3] = b - size;
  return 2;
}

/** Any grass within r of (x, z)? Checks the per-cell maxima (no allocation). */
function grassNear(baked, x, z, r) {
  const { cellMax, cells } = baked;
  const half = WORLD_SIZE / 2;
  const x0 = Math.max(0, Math.floor((x - r + half) / CELL));
  const x1 = Math.min(cells - 1, Math.floor((x + r + half) / CELL));
  const z0 = Math.max(0, Math.floor((z - r + half) / CELL));
  const z1 = Math.min(cells - 1, Math.floor((z + r + half) / CELL));
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) if (cellMax[cz * cells + cx] > 5) return true;
  }
  return false;
}

function grassMaterial(baked, ring) {
  const uniforms = {
    uGrassCam: { value: new THREE.Vector2() },
    uGrassSize: { value: ring.size },
    uGrassFade: { value: new THREE.Vector4(...ring.fade) },
    uGrassMap: { value: baked.map },
    uGrassHeight: { value: baked.height },
    uGrassGrid: { value: new THREE.Vector4(-WORLD_SIZE / 2, -WORLD_SIZE / 2, baked.step, baked.n) },
    uGrassSand: shared.uSandMap,
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  mat.envMapIntensity = 0.35; // like the needles: no sky sheen on foliage
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, cutUniforms, { uTime: shared.uTime, uWind: shared.uWind, uCaveO: shared.uCaveO, uCaveDir: shared.uCaveDir });
    patchSunlight(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aOffset;
        attribute float aT;
        uniform vec2 uGrassCam;
        uniform float uGrassSize;
        uniform vec4 uGrassFade;
        uniform sampler2D uGrassMap;
        uniform sampler2D uGrassHeight;
        uniform sampler2D uGrassSand;
        uniform vec4 uGrassGrid; // min x, min z, step, n
        uniform sampler2D uCutMask;
        uniform vec4 uCutRect;
        uniform vec4 uCaveO;
        uniform vec2 uCaveDir;
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
        // in the marsh (terrain.js MARSH, without its edge noise): taller, and out of shallow water
        float gMarsh = 1.0 - smoothstep(0.6, 0.95, length((gXZ - vec2(${MARSH.x.toFixed(1)}, ${MARSH.z.toFixed(1)})) / vec2(${MARSH.rx.toFixed(1)}, ${MARSH.rz.toFixed(1)})));
        float gDist = length(gXZ - uGrassCam);
        float gEdge = (uGrassFade.y > 0.0 ? smoothstep(uGrassFade.x, uGrassFade.y, gDist) : 1.0)
          * (1.0 - smoothstep(uGrassFade.z, uGrassFade.w, gDist));
        // whether a tuft exists depends only on the local density (so it never
        // pops); distance only scales it, smoothly across the fade bands
        float gScale = smoothstep(0.0, 0.12, gMap.a - gR1 * 0.999) * gEdge;
        // most tufts in sparse places are absent: skip the rest of their lookups
        float gY = 0.0;
        if (gScale > 0.0) {
          vec2 gCutUv = (gXZ - uCutRect.xy) / uCutRect.zw;
          if (all(greaterThan(gCutUv, vec2(0.0))) && all(lessThan(gCutUv, vec2(1.0)))
              && texture2D(uCutMask, gCutUv).r > 0.5) gScale = 0.0;
          gY = gGround(gXZ);
          if (gY < ${(WATER_LEVEL + 0.15).toFixed(2)} - 0.5 * gMarsh) gScale = 0.0;
          // none inside the cave's mouth (cave.js), where the ground runs up into the tunnel
          vec2 gCo = gXZ - uCaveO.xz;
          float gCs = dot(gCo, uCaveDir);
          if (gCs > -0.3 && gCs < 14.0 && abs(dot(gCo, vec2(-uCaveDir.y, uCaveDir.x))) < 3.0) gScale = 0.0;
        }
        float gHeight = mix(0.7, 1.35, gR3) * mix(0.55, 1.0, gMap.a); // sparse grass is shorter
        gHeight *= 1.0 + 2.2 * gMarsh; // marsh sedge: knee high
        // beach grass on the dunes: tall, and in separate tussocks with bare sand between (a 5 m
        // map can't hold that, so a ~1.5 m noise thins it here)
        float gSand = texture2D(uGrassSand, ((gXZ - uGrassGrid.xy) / uGrassGrid.z + 0.5) / uGrassGrid.w).r;
        gHeight *= 1.0 + 1.5 * gSand;
        if (gSand > 0.02) {
          vec2 tp = gXZ * 0.65;
          vec2 ti = floor(tp);
          vec2 tf = tp - ti;
          tf = tf * tf * (3.0 - 2.0 * tf);
          float tus = mix(mix(gHash(ti), gHash(ti + vec2(1.0, 0.0)), tf.x), mix(gHash(ti + vec2(0.0, 1.0)), gHash(ti + vec2(1.0, 1.0)), tf.x), tf.y);
          gScale *= mix(1.0, smoothstep(0.5, 0.62, tus), gSand);
        }
        float gA = gR2 * 6.2831853;
        mat2 gRot = mat2(cos(gA), -sin(gA), sin(gA), cos(gA));
        objectNormal.xz = gRot * objectNormal.xz;
        objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.5)); // soft, grassy shading`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.xz = gRot * transformed.xz;
        // blades are 1-2 cm wide: past a few metres that's under a pixel, so
        // widen the tuft (blades and spread) with distance to keep it visible
        transformed.xz *= 1.0 + 1.6 * smoothstep(3.0, 28.0, gDist);
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
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.directSpecular *= 0.15; // blades are matte (see patchCards)
        reflectedLight.indirectSpecular *= 0.35;`);
  };
  mat.customProgramCacheKey = () => `grass|${sunKey()}`;
  mat.userData.cam = uniforms.uGrassCam.value;
  return mat;
}
