import * as THREE from 'three';
import { groundAt, snowlineAt } from './terrain.js';

// ---------------------------------------------------------------------------
// Height fog
// ---------------------------------------------------------------------------
//
// Replaces three's fog chunks for every material (built-in and custom) so fog
// is thicker low down and thins with altitude: it pools in the valleys and you
// can look down into it from a ridge. World height is reconstructed from the
// view-space position, so it works for instanced meshes, points and lines alike.

const FOG_POOL_BASE = '18.0'; // m; fully "pooled" below this
const FOG_POOL_FALLOFF = '45.0'; // m; e-folding height above the base

export function installHeightFog() {
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying float vFogDepth;
      varying float vFogHeight;
    #endif`;
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      // world y = camera y + (view-space offset rotated back to world)
      vFogHeight = cameraPosition.y + dot(viewMatrix[1].xyz, mvPosition.xyz);
    #endif`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying float vFogDepth;
      varying float vFogHeight;
      #ifdef FOG_EXP2
        uniform float fogDensity;
      #else
        uniform float fogNear;
        uniform float fogFar;
      #endif
    #endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogMidY = mix(cameraPosition.y, vFogHeight, 0.5);
        float fogPool = exp(-max(fogMidY - ${FOG_POOL_BASE}, 0.0) / ${FOG_POOL_FALLOFF});
        float fogD = fogDensity * (0.8 + 0.8 * fogPool);
        float fogFactor = 1.0 - exp(-fogD * fogD * vFogDepth * vFogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
    #endif`;
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const skyFragment = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform float uTime;
  varying vec3 vDir;
  float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float sNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec3 d = normalize(vDir);
    float up = clamp(d.y, 0.0, 1.0);
    // overcast skies are brightest overhead and fade into the fog at the horizon
    vec3 col = mix(uHorizon, uZenith, smoothstep(0.02, 0.55, up));
    // slow-moving cloud mottling, projected onto a flat cloud deck
    vec2 deck = d.xz / max(d.y, 0.08) * 1.4 + vec2(uTime * 0.012, uTime * 0.004);
    float c = sNoise(deck) * 0.55 + sNoise(deck * 2.3) * 0.3 + sNoise(deck * 5.1) * 0.15;
    col *= 0.93 + 0.12 * c * smoothstep(0.0, 0.3, up);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function createSky() {
  const uniforms = {
    uHorizon: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uTime: { value: 0 },
  };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false, // drawn first, behind everything
      fog: false,
    }),
  );
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    mesh.position.copy(camera.position);
    mesh.scale.setScalar(camera.far * 0.95);
    mesh.updateMatrixWorld();
  };
  return { mesh, uniforms };
}

/**
 * Image-based lighting from an overcast sky: gives wet surfaces and the lake
 * something to reflect, and soft sky light from above. Built once at load.
 */
export function createEnvironment(renderer) {
  const envScene = new THREE.Scene();
  const { mesh, uniforms } = createSky();
  mesh.onBeforeRender = () => {};
  mesh.scale.setScalar(10);
  uniforms.uHorizon.value.set(0x8a989a);
  uniforms.uZenith.value.set(0xb7c3c8);
  envScene.add(mesh);
  // dark forest "ground" below the horizon
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(9, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x1f2a1c }),
  );
  ground.position.y = -1.5;
  envScene.add(ground);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0.02);
  pmrem.dispose();
  return rt.texture;
}

// ---------------------------------------------------------------------------
// Mist
// ---------------------------------------------------------------------------

function mistTexture() {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // overlapping soft blobs make an irregular wisp, faded at every edge
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = w * (0.15 + 0.7 * rnd());
    const y = h * (0.35 + 0.3 * rnd());
    const r = h * (0.18 + 0.25 * rnd());
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Low wisps of mist drifting between the trees: a handful of camera-facing
 * sprites recycled around the walker. Fewer on phones (they cost fill-rate).
 */
export class Mist {
  constructor(scene, count) {
    this.sprites = [];
    const map = mistTexture();
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({
        map,
        color: 0xdfe5e6,
        transparent: true,
        depthWrite: false,
        opacity: 0,
        fog: true,
      });
      const s = new THREE.Sprite(mat);
      s.renderOrder = 5;
      s.userData = { life: 0, fade: 0, drift: new THREE.Vector2() };
      scene.add(s);
      this.sprites.push(s);
    }
    this.amount = 1;
    this.tmp = new THREE.Vector3();
  }

  respawn(s, cam, first) {
    // ahead of the camera, 18–70 m out, skewed toward the view direction
    cam.getWorldDirection(this.tmp);
    const yaw = Math.atan2(this.tmp.x, this.tmp.z) + (Math.random() - 0.5) * 2.2;
    const dist = 18 + Math.random() * (first ? 50 : 52);
    const x = cam.position.x + Math.sin(yaw) * dist;
    const z = cam.position.z + Math.cos(yaw) * dist;
    const width = 26 + Math.random() * 26;
    s.position.set(x, groundAt(x, z) + 2.5 + Math.random() * 6, z);
    s.scale.set(width, width * 0.32, 1);
    s.material.rotation = (Math.random() - 0.5) * 0.15;
    s.userData.life = 14 + Math.random() * 16;
    s.userData.fade = first ? 1 : 0; // mist is already there when you arrive
    s.userData.drift.set((Math.random() - 0.3) * 0.6, (Math.random() - 0.5) * 0.4);
  }

  update(dt, camera, amount) {
    this.amount += (amount - this.amount) * Math.min(1, dt * 0.5);
    for (const s of this.sprites) {
      const u = s.userData;
      u.life -= dt;
      const dx = s.position.x - camera.position.x;
      const dz = s.position.z - camera.position.z;
      const d = Math.hypot(dx, dz);
      if (u.life <= 0 || d > 95 || d < 6) {
        if (u.fade > 0.02 && d >= 6) {
          u.fade = Math.max(0, u.fade - dt * 0.4); // fade out before recycling
        } else {
          this.respawn(s, camera, s.material.opacity === 0);
        }
      } else {
        u.fade = Math.min(1, u.fade + dt * 0.25);
      }
      s.position.x += u.drift.x * dt;
      s.position.z += u.drift.y * dt;
      // thin out close up so you walk "into" it instead of through a card
      const near = THREE.MathUtils.smoothstep(d, 8, 22);
      s.material.opacity = u.fade * near * this.amount * 0.55;
      s.visible = s.material.opacity > 0.003;
    }
  }

  /** How much mist suits this spot: thick in the wet valley, thin up high. */
  static amountAt(pos, rain, clearSky) {
    const line = snowlineAt(pos.x, pos.z);
    const low = 1 - THREE.MathUtils.smoothstep(pos.y, line - 40, line + 20);
    return (0.35 + 0.65 * low) * (0.6 + 0.4 * rain) * (clearSky ? 0.25 : 1);
  }
}
