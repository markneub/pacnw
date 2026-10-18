import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Height fog
// ---------------------------------------------------------------------------
//
// Replaces three's fog chunks for every material (built-in and custom) so fog
// is thicker low down and thins with altitude: it pools in the valleys and you
// can look down into it from a ridge. World height is reconstructed from the
// view-space position, so it works for instanced meshes, points and lines alike.

export const FOG_POOL_BASE = '18.0'; // m; fully "pooled" below this

/** Direction *toward* the sun: low in the west-northwest, so shafts slant across the view. */
export const SUN_DIR = new THREE.Vector3(-0.78, 0.34, -0.52).normalize();
export const SUN_COLOR = new THREE.Color(1.0, 0.8, 0.56);
const v3 = (v) => `vec3(${(v.x ?? v.r).toFixed(4)}, ${(v.y ?? v.g).toFixed(4)}, ${(v.z ?? v.b).toFixed(4)})`;
export const FOG_POOL_FALLOFF = '45.0'; // m; e-folding height above the base

/**
 * The scene uses a plain THREE.Fog purely as a carrier for two numbers, since
 * three refreshes fogNear/fogFar on every material that has fog:
 *   fog.near = round(sun * 255) + density (density < 1, exp² style; the integer
 *              part is how much the sun is out, 0..255, for the forward-scattering glow)
 *   fog.far  = time in seconds (drifts the banks).
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
      float fogSun = floor(fogNear) / 255.0;
      // (in a sun break the low valley mist burns off: across the lake in sun it whited out the
      // far shore 200 m away, worst looking into the sun)
      float fogD = fract(fogNear) * (0.8 + 0.8 * fogPool * (1.0 - 0.7 * fogSun)) * (0.6 + 0.8 * bank);
      float fogFactor = 1.0 - exp(-fogD * fogD * vFogDepth * vFogDepth);
      // sunlit haze: mist glows warm toward the sun (forward scattering), more
      // where the mist is thick, so banks catch the light
      vec3 fogView = normalize(vFogWorld - cameraPosition);
      float fogMie = max(dot(fogView, ${v3(SUN_DIR)}), 0.0);
      vec3 fogCol = fogColor + ${v3(SUN_COLOR)} * fogSun * (0.2 * pow(fogMie, 8.0) + 0.06 * pow(fogMie, 2.0)) * (0.6 + 0.6 * bank);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, fogFactor);
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
    gl_Position.z = gl_Position.w * 0.99999; // on the far plane: only pixels nothing else covered get shaded
  }`;

const skyFragment = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform float uTime;
  uniform float uSun; // 0 overcast .. 1 sun break
  varying vec3 vDir;
  float sHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float sNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm3(vec2 p) { return sNoise(p) * 0.55 + sNoise(p * 2.03 + 1.7) * 0.3 + sNoise(p * 4.1 + 3.1) * 0.15; }
  float fbm(vec2 p) { return sNoise(p) * 0.5 + sNoise(p * 2.03 + 1.7) * 0.28 + sNoise(p * 4.1 + 3.1) * 0.14 + sNoise(p * 8.3 + 7.7) * 0.08; }
  void main() {
    vec3 d = normalize(vDir);
    float up = clamp(d.y, 0.0, 1.0);
    float sunCos = dot(d, SUN_DIR);

    // --- overcast: a mottled deck of heavier and lighter masses in slow rolls,
    // with a lower, darker layer of ragged scud drifting faster beneath it
    vec2 deck = d.xz / max(d.y, 0.06);
    vec3 col = mix(uHorizon, uZenith, smoothstep(0.02, 0.55, up));
    // (uniform branches: the whole screen takes the same path, so skipping is cheap)
    if (uSun < 0.99) {
      vec2 dp = deck * vec2(0.9, 1.6) + vec2(uTime * 0.010, uTime * 0.003); // stretched: rolls
      float mass = fbm(dp * 0.8);
      float shadeDeck = mix(0.82, 1.1, smoothstep(0.3, 0.75, mass));
      float scud = smoothstep(0.55, 0.8, fbm3(deck * 1.7 + vec2(uTime * 0.035, uTime * 0.012)));
      float lowDeck = smoothstep(0.0, 0.35, up); // fades into the fog toward the horizon
      col *= mix(1.0, shadeDeck * (1.0 - 0.18 * scud), lowDeck);
    }
    if (uSun > 0.01) {

    // --- sun break: blue sky with a few fair-weather cumulus and the sun itself
    vec3 zen = vec3(0.035, 0.1, 0.27);
    vec3 hor = vec3(0.2, 0.28, 0.38);
    vec3 blue = mix(hor, zen, pow(smoothstep(0.0, 0.85, up), 0.6));
    // cumulus: their own, larger noise; only the tops of it become cloud, so there are few
    // a softer projection than the deck's (clouds near the horizon foreshorten instead of smearing)
    vec2 cp = d.xz / (d.y + 0.18) * 0.9 + vec2(uTime * 0.006, uTime * 0.002);
    float cd = fbm(cp);
    float cloud = smoothstep(0.63, 0.7, cd) * smoothstep(0.04, 0.2, up);
    // shading: denser toward the sun = that side is in the cloud's own shadow
    vec2 toSun = normalize(SUN_DIR.xz) * 0.06;
    float self = clamp((fbm3(cp + toSun) - fbm3(cp)) * 6.0, -1.0, 1.0); // low octaves are enough for shading
    vec3 lit = vec3(1.0, 0.96, 0.9) * 0.62; // white after exposure, not blown
    vec3 base = vec3(0.42, 0.46, 0.52);
    vec3 cumulus = mix(lit, base, clamp(0.35 + 0.65 * self, 0.0, 1.0) * smoothstep(0.63, 0.92, cd));
    // thin edges near the sun light up (silver lining)
    cumulus += vec3(1.0, 0.85, 0.6) * pow(max(sunCos, 0.0), 60.0) * (1.0 - smoothstep(0.63, 0.69, cd)) * 0.6;
    vec3 sunny = mix(blue, cumulus, cloud);
    // haze low down, meeting the fog
    sunny = mix(sunny, uHorizon * 1.05, 1.0 - smoothstep(0.0, 0.16, up));
    // the sun: a distinct ~1 degree disk, a tight halo, and a softer glow (dimmed behind cloud)
    float disk = smoothstep(0.99995, 0.99998, sunCos);
    float s = max(sunCos, 0.0);
    vec3 sunLight = SUN_COLOR * (disk * 14.0 * (1.0 - 0.6 * cloud) + pow(s, 6000.0) * 0.6 + pow(s, 300.0) * 0.12 + pow(s, 8.0) * 0.06);
    col = mix(col, sunny, uSun);
    col += sunLight * uSun;
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function createSky() {
  const uniforms = {
    uHorizon: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uTime: { value: 0 },
    uSun: { value: 0 },
  };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
      uniforms,
      defines: { SUN_DIR: v3(SUN_DIR), SUN_COLOR: v3(SUN_COLOR) },
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      // drawn after the other opaque objects, at the far plane with the depth test on, so its
      // (fairly heavy) cloud noise only runs where the sky is actually visible
      depthTest: true,
      fog: false,
    }),
  );
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = 100; // last of the opaques; transparents (lake, rain) still come after
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
