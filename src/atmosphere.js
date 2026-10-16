import * as THREE from 'three';

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

/**
 * The scene uses a plain THREE.Fog purely as a carrier for two numbers, since
 * three refreshes fogNear/fogFar on every material that has fog:
 *   fog.near = density (exp² style), fog.far = time in seconds (drifts the banks).
 * Use setFog()/the Weather class rather than reading them as distances.
 */
export function installHeightFog() {
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying float vFogDepth;
      varying vec3 vFogWorld;
    #endif`;
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      // world position = camera + (view-space offset rotated back to world)
      vFogWorld = cameraPosition + vec3(
        dot(viewMatrix[0].xyz, mvPosition.xyz),
        dot(viewMatrix[1].xyz, mvPosition.xyz),
        dot(viewMatrix[2].xyz, mvPosition.xyz));
    #endif`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      uniform float fogNear; // density
      uniform float fogFar;  // time
      varying float vFogDepth;
      varying vec3 vFogWorld;
      float fogHash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float fogNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(fogHash(i), fogHash(i + vec2(1, 0)), f.x),
                   mix(fogHash(i + vec2(0, 1)), fogHash(i + vec2(1, 1)), f.x), f.y);
      }
    #endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      // thicker low down: fog pools in valleys, ridges poke out
      float fogMidY = mix(cameraPosition.y, vFogWorld.y, 0.5);
      float fogPool = exp(-max(fogMidY - ${FOG_POOL_BASE}, 0.0) / ${FOG_POOL_FALLOFF});
      // drifting mist banks: slow world-anchored noise, two octaves
      vec2 fogP = vFogWorld.xz * 0.018 + vec2(fogFar * 0.011, fogFar * 0.004);
      float bank = fogNoise(fogP) * 0.65 + fogNoise(fogP * 2.7 + 13.1) * 0.35;
      float fogD = fogNear * (0.8 + 0.8 * fogPool) * (0.6 + 0.8 * bank);
      float fogFactor = 1.0 - exp(-fogD * fogD * vFogDepth * vFogDepth);
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
  float sHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
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
