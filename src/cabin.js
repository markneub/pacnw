import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import L from './cabin_layout.json';
import { groundAt, setWalkModifier } from './terrain.js';
import { shared, patchSunlight, sunKey } from './materials.js';
import { loadTextureSet } from './textures.js';
import { addSurfaceDetail, surfaceLayerFor } from './surfacedetail.js';
import { buildNote } from './note.js';

/**
 * The mountain cabin at the end of the trail in the high basin (model: blender/build_cabin.py,
 * which also writes cabin_layout.json: walls, door, windows, smoke, all in the cabin's own frame,
 * Y up, the door wall facing +Z).
 *
 * - Placed past the trail's last point, its door facing back down the trail, its floor just
 *   above the highest ground under it (the foundation runs down into the snow).
 * - Lit inside without real lights (which would add cost to every material): the cabin's
 *   materials know where they are in the cabin, and a point inside gets only a little of the
 *   outdoor sky light (more near the windows and the open door), direct sun only where a ray to
 *   the sun leaves through a window or the open doorway (sun patches on the floor), and the warm,
 *   flickering light of the stove and the lantern.
 * - The door opens and closes when you tap (touch), click or press E near it; a hint says so.
 * - Smoke rises from the stovepipe: soft billboards animated entirely on the GPU.
 * - Walls, the door, the furniture and the porch posts are colliders; the floor and porch are
 *   walkable (terrain.js walk modifiers). No rain or snow falls under its roof (weather.js
 *   reads shared.uShelter*).
 */

const W = L.outer.hx - 0.15; // wall centre lines
const D = L.outer.hz - 0.15;
const PITCH = L.roof.pitch;
const RIDGE = L.roof.ridge;
const PORCH_FRONT = L.porch.z1; // outer edge of the step (local z)
const DOOR_W = L.door.width;
const HINGE = new THREE.Vector3(...L.door.hinge);
const DOOR_OPEN = 1.85; // rad (about 105°, inward)

/** Where the cabin goes: past the end of the trail, facing back down it. */
export function planCabin(trail) {
  const pts = trail.points;
  const n = pts.length;
  const e = pts[n - 1];
  const a = pts[n - 11];
  const dl = Math.hypot(e.x - a.x, e.y - a.y);
  const dx = (e.x - a.x) / dl;
  const dz = (e.y - a.y) / dl;
  const dist = 6.5 + PORCH_FRONT; // the step ~6.5 m past the trail's end (its tread fades out over 6 m)
  const x = e.x + dx * dist;
  const z = e.y + dz * dist;
  const rotY = Math.atan2(-dx, -dz); // local +Z (the door) toward the trail
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  // local -> world: (lx, lz) rotated by rotY (three's Y rotation)
  const toWorld = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  const toLocal = (wx, wz) => {
    const ox = wx - x;
    const oz = wz - z;
    return [ox * c - oz * s, ox * s + oz * c];
  };
  // floor just above the highest ground under the cabin and its porch
  let gMax = -Infinity;
  for (let lz = -D - 0.3; lz <= PORCH_FRONT; lz += 0.5) {
    for (let lx = -W - 0.3; lx <= W + 0.3; lx += 0.5) gMax = Math.max(gMax, groundAt(...toWorld(lx, lz)));
  }
  const y = gMax + 0.32;
  /** True where scatter must not put things (margin m around the cabin and its porch). */
  const blocked = (wx, wz, margin) => {
    const [lx, lz] = toLocal(wx, wz);
    return Math.abs(lx) < W + 0.9 + margin && lz > -D - 0.7 - margin && lz < PORCH_FRONT + margin;
  };
  return { x, y, z, rotY, toWorld, toLocal, blocked, trailEnd: [e.x, e.y] };
}

// uniforms shared by all of the cabin's materials
const U = {
  uCabInv: { value: new THREE.Matrix4() }, // world -> cabin
  uCabFire: { value: 1 },
  uCabDoor: { value: 0 }, // 0 closed .. 1 open
  uCabSunL: { value: new THREE.Vector3(0, 1, 0) }, // toward the key light, cabin frame
  uCabWin: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  uCabWinWall: { value: [0, 0, 0, 0] },
  uCabWood: { value: null },
  uCabWoodAvg: { value: new THREE.Color(1, 1, 1) },
  uCabWoodTile: { value: 1 },
};

// The openings as rectangles on the wall planes, cabin frame: [u0, u1, y0, y1] and which wall
// (0: x = -W, 1: x = +W, 2: z = -D (back), 3: z = +D (front)); u is z on the side walls, x on the others.
const OPENINGS = [];
for (const w of L.windows) {
  const side = w.along === 'z';
  const wall = { left: 0, right: 1, back: 2, front: 3 }[w.wall];
  // (Blender's y runs the other way from the game's z)
  const u0 = side ? -w.a1 : w.a0;
  const u1 = side ? -w.a0 : w.a1;
  OPENINGS.push({ wall, u0, u1, y0: w.z0, y1: w.z1 });
}
OPENINGS.push({ wall: 3, u0: L.door.x0, u1: L.door.x1, y0: 0, y1: L.door.top - 0.07, door: true });
OPENINGS.forEach((o, i) => {
  U.uCabWin.value[i].set(o.u0, o.u1, o.y0, o.y1);
  U.uCabWinWall.value[i] = o.wall;
});
const openingCentre = (o) => {
  const u = (o.u0 + o.u1) / 2;
  const y = (o.y0 + o.y1) / 2;
  return [[-W, y, u], [W, y, u], [u, y, -D], [u, y, D]][o.wall];
};
const WIN_GLSL = OPENINGS.filter((o) => !o.door).map((o) => `vec3(${openingCentre(o).map((v) => v.toFixed(3)).join(', ')})`).join(', ');
const DOOR_C = openingCentre(OPENINGS[OPENINGS.length - 1]);
const f3 = (v) => `vec3(${v.map((c) => (+c).toFixed(3)).join(', ')})`;

/**
 * The cabin's lighting (and the wood photo), patched into a standard material.
 * wood: lay the wood photo along the grain (aGrain, from the model's vertex colours).
 */
function patchCabin(shader, { wood, snow }) {
  Object.assign(shader.uniforms, U);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      uniform mat4 uCabInv;
      attribute vec3 aGrain;
      varying vec3 vCabP;
      varying vec3 vCabN;
      varying vec3 vGrain;`)
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vCabP = (uCabInv * modelMatrix * vec4(transformed, 1.0)).xyz;
      vCabN = normalize(mat3(uCabInv) * mat3(modelMatrix) * objectNormal);
      vGrain = aGrain;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      uniform float uCabFire;
      uniform float uCabDoor;
      uniform vec3 uCabSunL;
      uniform vec4 uCabWin[4];
      uniform float uCabWinWall[4];
      uniform sampler2D uCabWood;
      uniform vec3 uCabWoodAvg;
      uniform float uCabWoodTile;
      varying vec3 vCabP;
      varying vec3 vCabN;
      varying vec3 vGrain;
      float cabInside = 0.0;
      float cabHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
      float cabRoof(float x) { return ${RIDGE.toFixed(3)} - ${PITCH.toFixed(3)} * abs(x); }
      // how much direct sun reaches p inside: a ray to the sun has to leave through a window or the open door
      float cabSunLit(vec3 p) {
        vec3 l = uCabSunL;
        if (l.y < 0.02) return 0.0;
        float tx = abs(l.x) > 1e-4 ? (sign(l.x) * ${W.toFixed(3)} - p.x) / l.x : 1e6;
        float tz = abs(l.z) > 1e-4 ? (sign(l.z) * ${D.toFixed(3)} - p.z) / l.z : 1e6;
        float t = min(tx, tz);
        vec3 h = p + l * t;
        if (h.y > cabRoof(h.x) - 0.05) return 0.0;
        float wall = tx < tz ? (l.x < 0.0 ? 0.0 : 1.0) : (l.z < 0.0 ? 2.0 : 3.0);
        float u = tx < tz ? h.z : h.x;
        float lit = 0.0;
        for (int i = 0; i < 4; i++) {
          if (abs(uCabWinWall[i] - wall) > 0.5) continue;
          vec4 r = uCabWin[i];
          float k = smoothstep(r.x, r.x + 0.03, u) * smoothstep(r.y, r.y - 0.03, u) * smoothstep(r.z, r.z + 0.03, h.y) * smoothstep(r.w, r.w - 0.03, h.y);
          if (i == 3) k *= smoothstep(0.6, 0.95, uCabDoor);
          else k *= 0.85; // (the glass and the muntins)
          lit = max(lit, k);
        }
        return lit;
      }`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      ${snow ? `{
        // drifted snow isn't one flat white: soft lumps (3D value noise, Hoskins hash)
        vec3 sq = vCabP * vec3(2.1, 3.0, 2.1);
        vec3 si = floor(sq);
        vec3 sf = sq - si;
        sf = sf * sf * (3.0 - 2.0 * sf);
        float sn = mix(mix(mix(cabHash(si), cabHash(si + vec3(1, 0, 0)), sf.x), mix(cabHash(si + vec3(0, 1, 0)), cabHash(si + vec3(1, 1, 0)), sf.x), sf.y),
                       mix(mix(cabHash(si + vec3(0, 0, 1)), cabHash(si + vec3(1, 0, 1)), sf.x), mix(cabHash(si + vec3(0, 1, 1)), cabHash(si + vec3(1, 1, 1)), sf.x), sf.y), sf.z);
        diffuseColor.rgb *= 0.93 + 0.1 * sn;
      }` : ''}
      cabInside = step(abs(vCabP.x), ${W.toFixed(3)}) * step(abs(vCabP.z), ${D.toFixed(3)}) * step(vCabP.y, cabRoof(vCabP.x) + 0.04) * step(-0.3, vCabP.y);
      ${wood ? `{
        // the wood photo, its grain (the image's vertical) along each log and board: projected on
        // the two planes that contain the grain axis, blended by the normal; cut ends (looking
        // along the grain) get it across the grain, fine and faint (with only the first two, an
        // end's weights were both ~0 and it divided out to black: the woodpile's rounds)
        vec3 g = normalize(vGrain + vec3(1e-3, 2e-3, 3e-3));
        vec3 b1 = normalize(cross(g, abs(g.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 b2 = cross(g, b1);
        vec3 n = normalize(vCabN);
        float w1 = pow(abs(dot(n, b2)), 4.0);
        float w2 = pow(abs(dot(n, b1)), 4.0);
        float w3 = pow(abs(dot(n, g)), 4.0);
        float along = dot(vCabP, g) * 0.35;
        vec3 t1 = texture2D(uCabWood, vec2(dot(vCabP, b1), along) * uCabWoodTile).rgb;
        vec3 t2 = texture2D(uCabWood, vec2(dot(vCabP, b2) + 0.37, along) * uCabWoodTile).rgb;
        vec3 t3 = mix(uCabWoodAvg, texture2D(uCabWood, vec2(dot(vCabP, b1), dot(vCabP, b2)) * uCabWoodTile * 2.5).rgb, 0.5);
        vec3 wd = (t1 * w1 + t2 * w2 + t3 * w3) / max(w1 + w2 + w3, 1e-4) / uCabWoodAvg;
        diffuseColor.rgb *= mix(vec3(1.0), wd, 0.85);
      }` : ''}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      if (cabInside > 0.5) {
        vec3 p = vCabP;
        vec3 n = normalize(vCabN);
        // daylight through the windows and the open door: a little everywhere, more near them
        const vec3 WIN[3] = vec3[3](${WIN_GLSL});
        float day = 0.06;
        for (int i = 0; i < 3; i++) {
          vec3 dw = WIN[i] - p;
          float d2 = dot(dw, dw);
          day += 0.42 * exp(-d2 * 0.3) * (0.35 + 0.65 * max(dot(n, dw * inversesqrt(d2 + 1e-4)), 0.0));
        }
        {
          vec3 dw = ${f3(DOOR_C)} - p;
          float d2 = dot(dw, dw);
          day += 1.1 * uCabDoor * exp(-d2 * 0.18) * (0.35 + 0.65 * max(dot(n, dw * inversesqrt(d2 + 1e-4)), 0.0));
        }
        // corners and the floor's edges are darker
        float edge = min(${W.toFixed(3)} - abs(p.x), ${D.toFixed(3)} - abs(p.z));
        float ao = mix(0.6, 1.0, smoothstep(0.0, 1.3, p.y)) * mix(0.65, 1.0, smoothstep(0.0, 0.6, edge));
        reflectedLight.indirectDiffuse *= day * ao;
        reflectedLight.indirectSpecular *= day;
        // the stove's warm, flickering light, and the lantern on the table
        vec3 tf = ${f3(L.stove)} - p;
        float df = length(tf);
        vec3 fire = vec3(1.0, 0.48, 0.18) * uCabFire * 2.6 / (1.0 + df * df * 0.55) * (0.3 + 0.7 * max(dot(n, tf / df), 0.0));
        vec3 tl = ${f3(L.lamp)} - p;
        float dl = length(tl);
        vec3 lamp = vec3(1.0, 0.72, 0.4) * (0.9 + 0.1 * uCabFire) * 1.1 / (1.0 + dl * dl * 1.2) * (0.3 + 0.7 * max(dot(n, tl / dl), 0.0));
        reflectedLight.indirectDiffuse += (fire + lamp) * mix(0.75, 1.0, ao) * BRDF_Lambert(material.diffuseColor);
      }`);
  // direct light: inside, only the sun coming in through an opening
  const sunLine = 'getDirectionalLightInfo( directionalLight, directLight );';
  if (!shader.fragmentShader.includes(sunLine)) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin);
  }
  shader.fragmentShader = shader.fragmentShader.replace(sunLine,
    `${sunLine}\n\t\tdirectLight.color *= cabInside > 0.5 ? cabSunLit(vCabP) : 1.0;`);
}

const SPECS = {
  CabinGlass: { transparent: true, opacity: 0.16, roughness: 0.04, metalness: 0, envMapIntensity: 1.5, side: THREE.DoubleSide, depthWrite: false, plain: true },
  CabinIce: { roughness: 0.15, envMapIntensity: 1.2 },
  CabinSnow: { roughness: 0.85 },
  CabinTin: { metalness: 0.5, roughness: 0.4 },
  CabinIron: { metalness: 0.35, roughness: 0.55 },
  CabinGlow: { emissive: new THREE.Color(1.0, 0.36, 0.07), emissiveIntensity: 1.6 },
  CabinLamp: { emissive: new THREE.Color(1.0, 0.6, 0.28), emissiveIntensity: 1.3 },
};
const WOOD = new Set(['CabinLog', 'CabinLogEnd', 'CabinBoard', 'CabinFloor', 'CabinTrim', 'CabinWood', 'CabinShake']);
const SMOOTH = new Set(['CabinLog', 'CabinBark', 'CabinSnow']);

function convert(src, cache) {
  if (cache.has(src.name)) return cache.get(src.name);
  const spec = SPECS[src.name] ?? {};
  const { plain, ...opts } = spec;
  const mat = new THREE.MeshStandardMaterial({
    name: src.name,
    color: src.color.clone(),
    roughness: src.roughness ?? 0.9,
    metalness: 0,
    flatShading: !SMOOTH.has(src.name),
    ...opts,
  });
  if (!plain) {
    const wood = WOOD.has(src.name) && U.uCabWood.value !== null;
    const snow = src.name === 'CabinSnow';
    mat.onBeforeCompile = (shader) => {
      patchSunlight(shader);
      patchCabin(shader, { wood, snow });
    };
    mat.customProgramCacheKey = () => `cabin|${wood}|${snow}|${sunKey()}`;
    const layer = src.name === 'CabinStone' ? surfaceLayerFor('Rock') : src.name === 'CabinBark' ? surfaceLayerFor('Bark') : null;
    if (layer) addSurfaceDetail(mat, layer);
  }
  cache.set(src.name, mat);
  return mat;
}

/** The cabin's model and wood photo (started early in main.js, so they download during the load). */
export function loadCabinAssets(renderer, { lowPower }) {
  return Promise.all([
    new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/cabin.glb`),
    loadTextureSet(renderer, 'cabin', { lowPower }),
  ]);
}

export async function buildCabin(plan, assets) {
  const [gltf, wood] = await assets;
  if (wood) {
    U.uCabWood.value = wood[0].alb;
    U.uCabWoodAvg.value.setRGB(...wood[0].avg);
    U.uCabWoodTile.value = 1 / wood[0].tile;
  }
  const group = new THREE.Group();
  group.name = 'cabin';
  group.position.set(plan.x, plan.y, plan.z);
  group.rotation.y = plan.rotY;
  const cache = new Map();
  const parts = {};
  for (const name of ['cabin', 'cabin_door', 'cabin_interior']) {
    const node = gltf.scene.getObjectByName(name);
    const holder = new THREE.Group();
    holder.name = name;
    node.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry;
      geo.setAttribute('aGrain', geo.getAttribute('color'));
      geo.deleteAttribute('color');
      const mesh = new THREE.Mesh(geo, convert(o.material, cache));
      if (o.material.name === 'CabinGlass') mesh.renderOrder = 2;
      holder.add(mesh);
    });
    parts[name] = holder;
    group.add(holder);
  }
  const door = parts.cabin_door;
  door.position.copy(HINGE);
  const interior = parts.cabin_interior;
  group.updateMatrixWorld(true);
  U.uCabInv.value.copy(group.matrixWorld).invert();

  // no rain or snow under the roof (weather.js)
  shared.uShelterInv.value.copy(U.uCabInv.value);
  shared.uShelter.value.set(W + L.roof.eaveOut, -D - L.roof.back, D + L.roof.front, RIDGE + 0.3);
  shared.uShelterPitch.value = PITCH;

  const path = buildPath(plan);
  const smoke = buildSmoke();
  const smokeOrigin = new THREE.Vector3(...L.smoke).applyMatrix4(group.matrixWorld);
  smoke.material.uniforms.uOrigin.value.copy(smokeOrigin);
  smoke.position.copy(smokeOrigin); // (for sorting; the vertex shader places the puffs)
  const root = new THREE.Group();
  root.add(group, smoke, path);

  // a handwritten note on the table, by the lantern (note.js: tap it to read it)
  const note = await buildNote(group.matrixWorld.clone().multiply(new THREE.Matrix4().compose(
    new THREE.Vector3(L.lamp[0] + 0.39, 0.779, L.lamp[2] - 0.1),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0.35)),
    new THREE.Vector3(1, 1, 1),
  )));
  root.add(note.mesh);
  let canRead = false;

  // ---- the door, the hint ----
  const hint = document.createElement('div');
  hint.id = 'hint';
  document.body.appendChild(hint);
  const touch = document.body.classList.contains('touch');
  let open = false;
  let angle = 0;
  let canToggle = false;
  const doorCentre = new THREE.Vector3(L.door.x0 + DOOR_W / 2, 1.0, D).applyMatrix4(group.matrixWorld);
  const fwd = new THREE.Vector3();
  const lp = { x: 0, z: 0 };
  const local = (wx, wz) => {
    const [x, z] = plan.toLocal(wx, wz);
    lp.x = x;
    lp.z = z;
    return lp;
  };
  // where the door leaf sweeps (cabin frame): don't swing it shut on the player
  const inSwing = (x, z, r) => x > HINGE.x - r && x < HINGE.x + DOOR_W + r && z > D - DOOR_W - r && z < D + 0.5 * r;

  function interact(player) {
    if (note.held) {
      note.held = false; // (put it back down)
      return true;
    }
    if (canRead) {
      note.held = true;
      return true;
    }
    if (!canToggle) return false;
    open = !open;
    return true;
  }

  // ---- colliders (cabin frame) ----
  const rects = [...L.walls, ...L.furniture];
  function pushOutOfRect(p, r, cx, cz, hx, hz) {
    const qx = Math.max(cx - hx, Math.min(cx + hx, p.x));
    const qz = Math.max(cz - hz, Math.min(cz + hz, p.z));
    let ox = p.x - qx;
    let oz = p.z - qz;
    const d2 = ox * ox + oz * oz;
    if (d2 >= r * r) return;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      p.x = qx + (ox / d) * r;
      p.z = qz + (oz / d) * r;
    } else {
      // centre inside: out through the nearest side
      const pen = [p.x - (cx - hx), cx + hx - p.x, p.z - (cz - hz), cz + hz - p.z];
      const k = pen.indexOf(Math.min(...pen));
      if (k === 0) p.x = cx - hx - r;
      else if (k === 1) p.x = cx + hx + r;
      else if (k === 2) p.z = cz - hz - r;
      else p.z = cz + hz + r;
      ox = oz = 0;
    }
  }
  function pushOutOfSegment(p, r, ax, az, bx, bz) {
    const vx = bx - ax;
    const vz = bz - az;
    const t = Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.z - az) * vz) / (vx * vx + vz * vz)));
    const qx = ax + vx * t;
    const qz = az + vz * t;
    const ox = p.x - qx;
    const oz = p.z - qz;
    const d2 = ox * ox + oz * oz;
    if (d2 < r * r && d2 > 1e-10) {
      const d = Math.sqrt(d2);
      p.x = qx + (ox / d) * r;
      p.z = qz + (oz / d) * r;
    }
  }
  const c = Math.cos(plan.rotY);
  const s = Math.sin(plan.rotY);
  function collide(pos, radius) {
    const [lx, lz] = plan.toLocal(pos.x, pos.z);
    if (Math.abs(lx) > W + 4 || lz < -D - 4 || lz > PORCH_FRONT + 3) return;
    const p = { x: lx, z: lz };
    for (const [cx, cz, hx, hz] of rects) pushOutOfRect(p, radius, cx, cz, hx, hz);
    for (const [cx, cz, r] of L.posts) {
      const ox = p.x - cx;
      const oz = p.z - cz;
      const d = Math.hypot(ox, oz);
      if (d < r + radius && d > 1e-6) {
        p.x = cx + (ox / d) * (r + radius);
        p.z = cz + (oz / d) * (r + radius);
      }
    }
    // the door leaf, a thin slab from the hinge
    pushOutOfSegment(p, radius + 0.03, HINGE.x, HINGE.z, HINGE.x + Math.cos(angle) * DOOR_W, HINGE.z - Math.sin(angle) * DOOR_W);
    if (p.x !== lx || p.z !== lz) {
      pos.x = plan.x + p.x * c + p.z * s;
      pos.z = plan.z - p.x * s + p.z * c;
    }
  }

  // ---- the floor, the porch and its step are walkable ----
  setWalkModifier((x, z, g) => {
    const [lx, lz] = plan.toLocal(x, z);
    if (Math.abs(lx) < W + 0.2 && lz > -D - 0.2 && lz < D + 0.2) return plan.y;
    if (Math.abs(lx) < 1.7 && lz >= D && lz < L.porch.z1 - 0.45) return plan.y;
    if (Math.abs(lx) < 0.6 && lz >= L.porch.z1 - 0.45 && lz < L.porch.z1) return Math.max(g, plan.y - 0.225);
    return g;
  });

  /** Is (x, z) inside the cabin? (the HUD) */
  const contains = (x, z) => {
    const [lx, lz] = plan.toLocal(x, z);
    return Math.abs(lx) < W && Math.abs(lz) < D;
  };

  // the key light's direction, in the cabin frame (found once: weather.js moves it)
  let keyLight = null;
  let hintShownFor = 0; // (the put-down hint fades after a moment, so it doesn't sit over the words)
  const v = new THREE.Vector3();
  const inv3 = new THREE.Matrix3().setFromMatrix4(U.uCabInv.value);

  function update(dt, t, camera, player, scene) {
    // the door eases open or shut
    const target = open ? DOOR_OPEN : 0;
    angle += (target - angle) * (1 - Math.exp(-dt * 4.5));
    door.rotation.y = angle;
    U.uCabDoor.value = angle / DOOR_OPEN;
    // firelight flicker: a few incommensurate wobbles
    const f = 0.82 + 0.08 * Math.sin(t * 7.3) + 0.06 * Math.sin(t * 13.7 + 1.3) + 0.04 * Math.sin(t * 23.1 + 0.4);
    U.uCabFire.value = f;
    const glow = cache.get('CabinGlow');
    if (glow) glow.emissiveIntensity = 1.3 + 0.8 * (f - 0.82) / 0.18;
    smoke.material.uniforms.uTime.value = t;
    smoke.material.uniforms.uSun.value = shared.uSun.value;
    if (!keyLight) scene.traverse((o) => { if (o.isDirectionalLight && !keyLight) keyLight = o; });
    if (keyLight) {
      v.copy(keyLight.position).sub(keyLight.target.position).normalize().applyMatrix3(inv3).normalize();
      U.uCabSunL.value.copy(v);
    }
    // the furnishings only near (they're behind walls and glass from further off)
    const dist = camera.position.distanceTo(doorCentre);
    interior.visible = dist < 45;
    note.mesh.visible = dist < 45;
    // the note: readable when you're by the table looking at it; laid down if you walk off
    camera.getWorldDirection(fwd);
    const nd = camera.position.distanceTo(note.restPos);
    v.copy(note.restPos).sub(camera.position).normalize();
    canRead = !note.held && nd < 1.9 && fwd.dot(v) > 0.88;
    if (note.held && nd > 2.6) note.held = false;
    note.update(dt, camera, 0.4 * (0.92 + 0.08 * f));

    // the hint: near the door and looking at it
    const pl = local(player.pos.x, player.pos.z);
    camera.getWorldDirection(fwd);
    const tx = doorCentre.x - camera.position.x;
    const tz = doorCentre.z - camera.position.z;
    const dd = Math.hypot(tx, tz);
    const facing = (fwd.x * tx + fwd.z * tz) / Math.max(1e-4, dd * Math.hypot(fwd.x, fwd.z));
    const near = Math.abs(pl.x - (L.door.x0 + DOOR_W / 2)) < 1.6 && Math.abs(pl.z - D) < 2.2;
    canToggle = near && (facing > 0.45 || dd < 0.9) && !(open && inSwing(pl.x, pl.z, 0.45)) && !canRead && !note.held;
    let text = null;
    if (note.held) text = touch ? 'Tap to put it down' : 'Click or press E to put it down';
    else if (canRead) text = touch ? 'Tap to read the note' : 'Click or press E to read the note';
    else if (canToggle) {
      const verb = open ? 'close' : 'open';
      text = touch ? `Tap to ${verb} the door` : `Click or press E to ${verb} the door`;
    }
    if (text && hint.textContent !== text) hint.textContent = text;
    hint.classList.toggle('show', !!text && !(note.held && !note.moving && hintShownFor > 2.5));
    hintShownFor = note.held ? hintShownFor + dt : 0;
  }

  /** (dev: ?door=open, for screenshots) */
  const setOpen = (v) => {
    open = v;
    angle = v ? DOOR_OPEN : 0;
  };
  return { group: root, collide, update, interact, contains, plan, setOpen, note };
}

/**
 * A trodden path in the snow from the end of the trail to the porch step: a strip draped on the
 * ground that darkens and cools the snow under it (multiply), most down its middle, fading out at
 * its sides and where it meets the trail. (Painted in the snow's colour, it read as a pale streak:
 * the ground's own snow is darker with its baked shade and photo.)
 */
function buildPath(plan) {
  const [ex, ez] = plan.toLocal(...plan.trailEnd);
  const z0 = L.porch.z1 - 0.15; // (local) at the step
  const STEPS = 24;
  const ACROSS = 6;
  const HALF = 0.75;
  const pos = [];
  const col = [];
  const idx = [];
  const trodden = new THREE.Color(0.8, 0.84, 0.9); // what the groove multiplies the snow by
  const c = new THREE.Color();
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    // a gentle S between the step and the trail's end, wandering a little
    const lz = z0 + (ez - z0) * t;
    const lx = ex * t * t * (3 - 2 * t) + Math.sin(t * 5.1) * 0.18;
    const fadeEnd = 1 - THREE.MathUtils.smoothstep(t, 0.75, 1.0);
    for (let j = 0; j <= ACROSS; j++) {
      const u = (j / ACROSS) * 2 - 1;
      const [wx, wz] = plan.toWorld(lx + u * HALF * (1 + 0.15 * Math.sin(t * 9 + j)), lz);
      pos.push(wx, groundAt(wx, wz) + 0.03, wz);
      const groove = (1 - u * u) * fadeEnd * THREE.MathUtils.smoothstep(t, 0.0, 0.04);
      c.setRGB(1, 1, 1).lerp(trodden, groove);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < STEPS; i++) {
    for (let j = 0; j < ACROSS; j++) {
      const a = i * (ACROSS + 1) + j;
      const b = a + ACROSS + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // face up whichever way the strip winds
  const n = geo.attributes.normal;
  if (n.getY(0) < 0) {
    for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
    geo.setIndex(idx);
    geo.computeVertexNormals();
  }
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.MultiplyBlending,
    premultipliedAlpha: true, fog: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'cabin path';
  mesh.renderOrder = 1;
  return mesh;
}

/** Wood smoke from the stovepipe: soft puffs that rise, spread, drift downwind and fade. */
function buildSmoke(count = 30) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) seeds[i] = i / count + (((i * 7919) % 97) / 97) * (0.5 / count);
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geo.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uTime: { value: 0 }, uOrigin: { value: new THREE.Vector3() }, uSun: { value: 0 } },
    ]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      attribute float aSeed;
      uniform float uTime;
      uniform vec3 uOrigin;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vSeed;
      varying float vAge;
      const float LIFE = 12.0;
      void main() {
        float age = fract(uTime / LIFE + aSeed) * LIFE;
        float s = aSeed * 43.7;
        // rises quickly out of the pipe, then slows and leans downwind, wandering
        vec3 p = uOrigin;
        p.y += 1.6 * (1.0 - exp(-age * 0.55)) + age * 0.22;
        p.xz += vec2(0.55, 0.25) * age * age * 0.035;
        p.xz += vec2(sin(age * 0.7 + s), cos(age * 0.6 + s * 1.3)) * 0.12 * age;
        float size = 0.42 + age * 0.3;
        float rot = s + age * (fract(s) - 0.5) * 0.4;
        vec2 q = position.xy * size;
        q = vec2(q.x * cos(rot) - q.y * sin(rot), q.x * sin(rot) + q.y * cos(rot));
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 wp = p + right * q.x + up * q.y;
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vUv = uv;
        vSeed = s;
        vAge = age / LIFE;
        vAlpha = smoothstep(0.0, 0.25, age) * (1.0 - smoothstep(LIFE * 0.3, LIFE, age));
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <fog_pars_fragment>
      uniform float uSun;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vSeed;
      varying float vAge;
      float sHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float sNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec2 c = vUv - 0.5;
        float r = length(c) * 2.0;
        // lumpy, soft-edged puff (never a hard disc edge)
        float n = sNoise(vUv * 3.0 + vSeed) * 0.6 + sNoise(vUv * 7.0 - vSeed) * 0.4;
        float a = smoothstep(1.0, 0.15, r + (n - 0.5) * 0.7) * vAlpha;
        a *= 0.62 * (1.0 - 0.55 * vAge);
        if (a < 0.004) discard;
        // lit from above: a little lighter on top; grey-blue wood smoke, whiter in sun
        // darker and denser fresh out of the pipe, paler as it spreads; bright where the sun's out
        float shade = clamp(0.2 + 0.3 * c.y + 0.7 * vAge, 0.0, 1.0);
        // (linear values: this shader writes straight into the sRGB target, untone-mapped)
        vec3 col = mix(mix(vec3(0.12, 0.13, 0.155), vec3(0.34, 0.35, 0.38), shade),
                       mix(vec3(0.2, 0.21, 0.26), vec3(0.56, 0.57, 0.6), shade), uSun);
        gl_FragColor = vec4(col, a);
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  mesh.name = 'cabin smoke';
  return mesh;
}
