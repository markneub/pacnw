import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { groundAt, coastZ, HEADLAND, headlandAt, buildTerrainPatch, terrainMaterial, SEA_LEVEL } from './terrain.js';
import { shared, addGroundCover } from './materials.js';

/**
 * Things on the coast (models: blender/build_coast.py → public/models/coast.glb):
 * - a lighthouse on the headland east of the dunes (terrain.js HEADLAND), its keeper's house
 *   landward of it; at night the lamp burns and two beams sweep round (one turn every 12 s),
 *   flashing as they pass the viewer
 * - a wreck (Poly Haven's Dutch ship: sails gone, masts snapped) heeled over in the shallows
 *   off the beach, with barrels and crates washed up along the drift line
 * The scatter keeps clear of them (plan.blocked); they're colliders.
 */

// (~85 m out, ~2.5 m deep all round: the deep-water rule keeps you off it and from getting behind it)
const WRECK = { x: 172, s: -85, yaw: 0.62, heel: 0.52, pitch: -0.09, sink: 1.9 };

/** Where everything goes (call once the terrain is ready). */
export function planCoast() {
  // the lighthouse: the highest, flattest spot toward the headland's seaward end
  let best = null;
  for (let x = HEADLAND.x - 40; x <= HEADLAND.x + 40; x += 2) {
    for (let z = HEADLAND.z + 30; z <= HEADLAND.z + 80; z += 2) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let a = 0; a < 8; a++) {
        const h = groundAt(x + 4 * Math.cos(a * 0.785), z + 4 * Math.sin(a * 0.785));
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      // (and back from the cliff edge: the ground 12 m seaward must still be high)
      const edge = groundAt(x, z + 12);
      const score = groundAt(x, z) - 3 * (hi - lo) + 0.5 * Math.min(edge, 10) + 0.05 * (z - HEADLAND.z);
      if (!best || score > best.score) best = { x, z, score, lo };
    }
  }
  const lh = { x: best.x, z: best.z, y: best.lo + 0.05, rotY: 0 };
  // the keeper's house: ~20 m landward, its door (local +Y in Blender = −z here) facing inland
  const hx = lh.x - 7;
  const hz = lh.z - 20;
  let hlo = Infinity;
  for (const [dx, dz] of [[-4.3, -3.3], [4.3, -3.3], [-4.3, 3.3], [4.3, 3.3], [0, 0]]) hlo = Math.min(hlo, groundAt(hx + dx, hz + dz));
  const house = { x: hx, z: hz, y: hlo + 0.05, rotY: 0.12 };
  // the wreck: heeled over on the sand ~50 m out, where the surf breaks round it
  const wz = coastZ(WRECK.x) - WRECK.s;
  const wreck = { x: WRECK.x, z: wz, y: groundAt(WRECK.x, wz) + WRECK.sink, yaw: WRECK.yaw };
  // flotsam along the drift line (and one barrel in the swash)
  const flotsam = [];
  const spots = [[-26, 34, 'barrel', 0.2, 1.4], [-21, 38, 'crate', 0.9, 0.1], [-12, 41, 'barrel', 2.1, 0.0],
    [9, 30, 'barrel', 0.6, 1.5], [24, 44, 'crate', 2.6, 0.15], [-3, 6, 'barrel', 1.1, 1.45]];
  for (const [dx, s, kind, yaw, lie] of spots) {
    const x = WRECK.x + dx;
    const z = coastZ(x) - s;
    flotsam.push({ kind, x, z, y: groundAt(x, z), yaw, lie });
  }
  /** tree: the placement's name if it's a tree, else false */
  const blocked = (x, z, margin, tree) => {
    // the headland's top is a windswept meadow: a few low, wind-bent shore pines and saplings
    // (no tall firs: from the beach they hid the light), none round the light itself
    if (tree && headlandAt(x, z) > 0.05) {
      const hsh = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
      if ((tree !== 'shore_pine' && !tree.startsWith('sapling')) || hsh > 0.3 || Math.hypot(x - lh.x, z - lh.z) < 30) return true;
    }
    if (Math.hypot(x - lh.x, z - lh.z) < 14 + margin) return true;
    if (Math.hypot(x - house.x, z - house.z) < 10 + margin) return true;
    return Math.hypot(x - wreck.x, z - wreck.z) < 15 + margin;
  };
  return { lighthouse: lh, house, wreck, flotsam, blocked };
}

export function loadCoastAssets() {
  return new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/coast.glb`);
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** Chain a patch after a material's existing onBeforeCompile. */
function chain(mat, key, fn) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    fn(shader);
  };
  mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}|${key}`;
}

/** Old ship timbers: greyed and bleached, dark and weedy below the tide line, barnacles low down. */
function weather(mat) {
  addGroundCover(mat, { moss: 0, snow: 0, bleach: true });
  chain(mat, 'wreck', (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      {
        float lum = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * vec3(1.05, 1.0, 0.92), 0.5) * 0.7;
        float tide = 1.1 + 0.25 * sin(vCoverPos.x * 0.9 + sin(vCoverPos.z * 0.7) * 2.0) + 0.1 * sin(vCoverPos.z * 3.1);
        float wet = 1.0 - smoothstep(tide - 0.15, tide + 0.35, vCoverPos.y);
        // weed: soft dark-green patches (smooth, so up close it isn't a pattern)
        float wp = 0.5 + 0.25 * sin(vCoverPos.x * 1.7 + sin(vCoverPos.y * 2.3) * 1.5) + 0.25 * sin(vCoverPos.z * 2.1 + vCoverPos.y * 1.1);
        vec3 weed = mix(vec3(0.05, 0.065, 0.035), vec3(0.085, 0.1, 0.05), wp);
        diffuseColor.rgb = mix(diffuseColor.rgb, weed, wet * 0.8);
        // barnacles: small round crusts (3D dots, so they're round on any face), in a band under the tide line
        vec3 bq = vCoverPos * 22.0;
        vec3 bc = floor(bq);
        vec3 bh = fract(bc * 0.1031);
        bh += dot(bh, bh.yzx + 33.33);
        bh = fract((bh.xxy + bh.yzz) * bh.zyx);
        float bd = length(fract(bq) - 0.5 - (bh - 0.5) * 0.4);
        float band = smoothstep(tide - 0.9, tide - 0.5, vCoverPos.y) * (1.0 - smoothstep(tide - 0.05, tide + 0.1, vCoverPos.y));
        float barn = (1.0 - smoothstep(0.18, 0.26, bd)) * step(0.6, bh.x) * band;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.35, 0.31), barn * 0.6);
      }`);
  });
}

function convert(src, cache) {
  if (cache.has(src.name)) return cache.get(src.name);
  let mat;
  if (src.name === 'LhGlass') {
    mat = new THREE.MeshStandardMaterial({ name: src.name, color: 0x2a3a40, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.35, depthWrite: false });
  } else if (src.name === 'LhLamp') {
    // the lens: amber glass by day, the lamp lit at night (update sets the emissive intensity)
    mat = new THREE.MeshStandardMaterial({ name: src.name, color: 0x9a8a60, roughness: 0.15, metalness: 0.1, emissive: 0xffd9a0, emissiveIntensity: 0 });
  } else {
    mat = new THREE.MeshStandardMaterial({
      name: src.name,
      color: src.color.clone(),
      map: src.map,
      normalMap: src.normalMap,
      normalScale: src.normalScale?.clone() ?? new THREE.Vector2(1, 1),
      roughness: 0.85,
      metalness: src.name === 'LhIron' ? 0.3 : 0,
      flatShading: false,
    });
    if (src.name.startsWith('dutch_ship')) mat.side = THREE.DoubleSide; // (you see into her through the holes)
    if (src.name.startsWith('dutch_ship') || src.name === 'barrel_03' || src.name === 'wooden_crate_02') weather(mat);
    else addGroundCover(mat, { moss: src.name.startsWith('Lh') ? 0.12 : 0.25, snow: 0 });
  }
  cache.set(src.name, mat);
  return mat;
}

/** A model from the GLB as a group of meshes with converted materials. */
function part(gltf, name, cache) {
  const node = gltf.scene.getObjectByName(name);
  const g = new THREE.Group();
  g.name = name;
  node.traverse((o) => {
    if (!o.isMesh) return;
    const m = new THREE.Mesh(o.geometry, convert(o.material, cache));
    if (o.material.name === 'LhGlass') m.renderOrder = 2;
    g.add(m);
  });
  return g;
}

// ---------------------------------------------------------------------------
// The beam
// ---------------------------------------------------------------------------

const BEAM_LEN = 140;
function buildBeam() {
  // two cones (apex at the lamp, opening outward along ±X), open, seen from both sides
  const cone = new THREE.ConeGeometry(BEAM_LEN * 0.075, BEAM_LEN, 24, 1, true);
  cone.translate(0, -BEAM_LEN / 2, 0); // apex at the origin, opening along −Y
  const a = cone.clone().rotateZ(Math.PI / 2); // → +X
  const b = cone.clone().rotateZ(-Math.PI / 2); // → −X
  const geo = new THREE.BufferGeometry();
  const pos = [];
  const nrm = [];
  for (const g of [a, b]) {
    const ng = g.toNonIndexed();
    pos.push(...ng.getAttribute('position').array);
    nrm.push(...ng.getAttribute('normal').array);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uOn: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vT;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vT = length(position) / ${BEAM_LEN.toFixed(1)};
        vec4 w = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOn;
      varying float vT;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        // a soft shaft: thick through its middle, fading at its edges and with distance
        float face = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float a = uOn * face * pow(1.0 - vT, 1.8) * smoothstep(0.0, 0.03, vT) * 0.22;
        gl_FragColor = vec4(vec3(1.0, 0.9, 0.7) * a, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

/** The lamp's glare: a soft camera-facing disc, brighter as a beam swings past the viewer. */
function buildGlare() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec4 c = viewMatrix * modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        c.xy += position.xy * 6.0;
        gl_Position = projectionMatrix * c;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uI;
      varying vec2 vUv;
      void main() {
        float r = length(vUv);
        float a = uI * (exp(-r * r * 30.0) * 2.5 + exp(-r * 6.0) * 0.35) * (1.0 - smoothstep(0.8, 1.0, r));
        gl_FragColor = vec4(vec3(1.0, 0.88, 0.65) * a, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.frustumCulled = false;
  m.renderOrder = 4;
  return m;
}

// ---------------------------------------------------------------------------

const LAMP_Y = 15.9; // the lens's middle above the lighthouse's origin
const TURN = 12; // s per turn

// ---------------------------------------------------------------------------
// Past the far plane
// ---------------------------------------------------------------------------

// Seen from up the beach the headland is past the camera's far plane (420 m on phones): it was clipped away
// while the lighthouse (then pulled in toward the camera) floated over the horizon (the user). Now the
// headland's ground, the lighthouse, house, beams and glare are drawn where they are, and only their depth is
// squeezed: view depths past `uFarSqueeze.x` (90% of far) ease toward `.y` (97.5%), always in front of the
// sky (atmosphere.js draws it at depth 0.99999 w, i.e. ~98% of far) and still in order. Nothing moves on screen, and the fog is the fog at their real distance.
const uFarSqueeze = { value: new THREE.Vector2(378, 410) };

function squeezeFar(mat) {
  const cb = mat.onBeforeCompile;
  const key = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey') ? mat.customProgramCacheKey : null;
  const base = key ? () => key.call(mat) : () => cb.toString();
  mat.onBeforeCompile = (shader, renderer) => {
    cb.call(mat, shader, renderer);
    shader.uniforms.uFarSqueeze = uFarSqueeze;
    const vs = shader.vertexShader;
    const end = vs.lastIndexOf('}');
    shader.vertexShader = `uniform vec2 uFarSqueeze;\n${vs.slice(0, end)}
      {
        float fsD = gl_Position.w; // (the view depth)
        if (fsD > uFarSqueeze.x) {
          float fsR = uFarSqueeze.y - uFarSqueeze.x;
          float fsD2 = uFarSqueeze.x + fsR * (1.0 - exp(-(fsD - uFarSqueeze.x) / fsR));
          gl_Position.z = (projectionMatrix[3][2] - projectionMatrix[2][2] * fsD2) / fsD2 * gl_Position.w;
        }
      }
    ${vs.slice(end)}`;
  };
  mat.customProgramCacheKey = () => `${base()}|farSqueeze`;
  return mat;
}

export async function buildCoast(plan, assets) {
  const gltf = await assets;
  const cache = new Map();
  const group = new THREE.Group();
  group.name = 'coast';

  const lh = part(gltf, 'lighthouse', cache);
  lh.position.set(plan.lighthouse.x, plan.lighthouse.y, plan.lighthouse.z);
  lh.rotation.y = plan.lighthouse.rotY;
  const house = part(gltf, 'keeper_house', cache);
  house.position.set(plan.house.x, plan.house.y, plan.house.z);
  house.rotation.y = plan.house.rotY;
  const wreck = part(gltf, 'wreck', cache);
  wreck.position.set(plan.wreck.x, plan.wreck.y, plan.wreck.z);
  // (turned to its heading, then heeled over about its own length, then its bow a little down)
  wreck.rotation.set(WRECK.heel, plan.wreck.yaw, WRECK.pitch, 'YXZ');
  group.add(lh, house, wreck);

  // flotsam, as two instanced meshes
  const dummy = new THREE.Object3D();
  for (const kind of ['barrel', 'crate']) {
    const items = plan.flotsam.filter((f) => f.kind === kind);
    const src = part(gltf, kind, cache);
    for (const m of src.children) {
      const im = new THREE.InstancedMesh(m.geometry, m.material, items.length);
      items.forEach((f, i) => {
        dummy.position.set(f.x, f.y - (kind === 'barrel' ? 0.12 : 0.1), f.z);
        dummy.rotation.set(0, f.yaw, 0);
        if (f.lie > 0.5) dummy.rotateZ(f.lie); // (a barrel on its side, half in the sand)
        else dummy.rotateX(f.lie);
        if (f.lie > 0.5) dummy.position.y += 0.18;
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      im.computeBoundingSphere();
      group.add(im);
    }
  }

  // the light: lens glow, beams, glare
  const lamp = cache.get('LhLamp');
  const lampPos = new THREE.Vector3(plan.lighthouse.x, plan.lighthouse.y + LAMP_Y, plan.lighthouse.z);
  const beam = buildBeam();
  beam.position.copy(lampPos);
  const glare = buildGlare();
  glare.position.copy(lampPos);
  group.add(beam, glare);

  // the headland's ground, for when it's past the far plane: the terrain's own triangles and material
  // (drawn just behind it, so wherever the terrain itself is drawn, it wins)
  const hlMat = terrainMaterial.clone();
  hlMat.onBeforeCompile = terrainMaterial.onBeforeCompile;
  hlMat.customProgramCacheKey = terrainMaterial.customProgramCacheKey;
  hlMat.polygonOffset = true;
  hlMat.polygonOffsetFactor = 1;
  hlMat.polygonOffsetUnits = 1;
  squeezeFar(hlMat);
  const headland = new THREE.Mesh(buildTerrainPatch(405, 915, 655, 1215, SEA_LEVEL + 0.2), hlMat); // (and the stacks)
  headland.name = 'headland (far)';
  headland.frustumCulled = false;
  group.add(headland);
  const hlBox = new THREE.Box3().setFromBufferAttribute(headland.geometry.getAttribute('position'));
  const sq = new Set();
  for (const o of [lh, house, beam, glare, headland]) {
    o.traverse((m) => {
      if (!m.isMesh) return;
      m.frustumCulled = false; // (three's culling stops at the far plane)
      if (m.material !== hlMat && !sq.has(m.material)) sq.add(squeezeFar(m.material));
    });
  }

  // ---- colliders ----
  const wc = Math.cos(plan.wreck.yaw);
  const ws = Math.sin(plan.wreck.yaw);
  function collide(pos, r) {
    for (const [cx, cz, rr] of [[plan.lighthouse.x, plan.lighthouse.z, 3.3]]) {
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d = Math.hypot(dx, dz);
      if (d < rr + r && d > 1e-6) {
        pos.x = cx + (dx / d) * (rr + r);
        pos.z = cz + (dz / d) * (rr + r);
      }
    }
    // the house and the wreck: rectangles in their own frames
    rect(pos, r, plan.house.x, plan.house.z, Math.cos(plan.house.rotY), Math.sin(plan.house.rotY), 4.4, 3.4);
    rect(pos, r, plan.wreck.x, plan.wreck.z, wc, ws, 10.5, 2.4);
  }
  function rect(pos, r, cx, cz, c, s, hx, hz) {
    // local frame: x along the model's +X turned by rotY (three: x' = x cos + z sin, z' = −x sin + z cos)
    const ox = pos.x - cx;
    const oz = pos.z - cz;
    const lx = ox * c - oz * s;
    const lz = ox * s + oz * c;
    if (Math.abs(lx) > hx + r || Math.abs(lz) > hz + r) return;
    const qx = Math.max(-hx, Math.min(hx, lx));
    const qz = Math.max(-hz, Math.min(hz, lz));
    let nx = lx - qx;
    let nz = lz - qz;
    let d = Math.hypot(nx, nz);
    let px;
    let pz;
    if (d > 1e-6) {
      px = qx + (nx / d) * r;
      pz = qz + (nz / d) * r;
    } else {
      const pen = [lx + hx, hx - lx, lz + hz, hz - lz];
      const k = pen.indexOf(Math.min(...pen));
      px = k === 0 ? -hx - r : k === 1 ? hx + r : lx;
      pz = k === 2 ? -hz - r : k === 3 ? hz + r : lz;
    }
    pos.x = cx + px * c + pz * s;
    pos.z = cz - px * s + pz * c;
  }

  // ---- per frame ----
  const toCam = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let on = 0;
  const corner = new THREE.Vector3();
  function update(dt, t, camera) {
    uFarSqueeze.value.set(camera.far * 0.9, camera.far * 0.975);
    // (the headland's copy only while some of it is past where the squeeze starts)
    corner.set(camera.position.x < (hlBox.min.x + hlBox.max.x) / 2 ? hlBox.max.x : hlBox.min.x, hlBox.max.y,
      camera.position.z < (hlBox.min.z + hlBox.max.z) / 2 ? hlBox.max.z : hlBox.min.z);
    headland.visible = camera.position.distanceTo(corner) > camera.far * 0.89;
    // lit at night (eased, so the swap in the cave doesn't pop)
    const target = shared.uNight.value > 0.5 ? 1 : 0;
    on += (target - on) * Math.min(1, dt * 3);
    const yaw = (t / TURN) * Math.PI * 2;
    beam.rotation.y = yaw;
    beam.visible = on > 0.01;
    beam.material.uniforms.uOn.value = on;
    // flash as a beam sweeps past the viewer
    toCam.copy(camera.position).sub(lampPos);
    const dist = toCam.length();
    toCam.normalize();
    dir.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const align = Math.abs(dir.x * toCam.x + dir.z * toCam.z) / Math.max(1e-3, Math.hypot(toCam.x, toCam.z));
    const flash = Math.pow(Math.max(0, align), 60);
    glare.visible = on > 0.01;
    glare.material.uniforms.uI.value = on * (0.25 + 2.2 * flash) * Math.min(1, 60 / Math.max(dist, 1) + 0.4);
    lamp.emissiveIntensity = on * (2.2 + 4 * flash);
  }

  return { group, collide, update, plan, lampPos, headland };
}
