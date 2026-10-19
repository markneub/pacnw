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
/** Toward the full moon at night (cave.js swaps day and night): low in the south-south-west, over the sea. */
export const MOON_DIR = new THREE.Vector3(-0.22, 0.45, 0.87).normalize();
export const MOON_COLOR = new THREE.Color(0.62, 0.74, 1.0); // moonlight as the eye sees it: cool silver-blue
const v3 = (v) => `vec3(${(v.x ?? v.r).toFixed(4)}, ${(v.y ?? v.g).toFixed(4)}, ${(v.z ?? v.b).toFixed(4)})`;
export const FOG_POOL_FALLOFF = '45.0'; // m; e-folding height above the base

/**
 * The scene uses a plain THREE.Fog purely as a carrier for two numbers, since
 * three refreshes fogNear/fogFar on every material that has fog:
 *   fog.near = round(sun * 255) + 256 * night + density (density < 1, exp² style; the integer
 *              part is how much the sun is out, 0..255, for the forward-scattering glow, plus
 *              256 at night, when the glow is the moon's)
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
      float fogSun = mod(floor(fogNear), 256.0) / 255.0;
      float fogNight = step(255.5, floor(fogNear));
      // (in a sun break the low valley mist burns off: across the lake in sun it whited out the
      // far shore 200 m away, worst looking into the sun)
      float fogD = fract(fogNear) * (0.8 + 0.8 * fogPool * (1.0 - 0.7 * fogSun)) * (0.6 + 0.8 * bank);
      // sea haze: spray from the surf hangs low over the beach in a sun break (terrain.js coastZ ~1000)
      fogD *= 1.0 + 0.35 * fogSun * smoothstep(760.0, 1000.0, mix(cameraPosition.z, vFogWorld.z, 0.5)) * exp(-max(fogMidY, 0.0) / 30.0);
      float fogFactor = 1.0 - exp(-fogD * fogD * vFogDepth * vFogDepth);
      // sunlit haze: mist glows warm toward the sun (forward scattering), more
      // where the mist is thick, so banks catch the light
      vec3 fogView = normalize(vFogWorld - cameraPosition);
      float fogMie = max(dot(fogView, fogNight > 0.5 ? ${v3(MOON_DIR)} : ${v3(SUN_DIR)}), 0.0);
      vec3 fogCol = fogColor + (fogNight > 0.5 ? ${v3(MOON_COLOR)} * 0.05 : ${v3(SUN_COLOR)}) * fogSun * (0.2 * pow(fogMie, 8.0) + 0.06 * pow(fogMie, 2.0)) * (0.6 + 0.6 * bank);
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
  uniform float uNight; // 1: a clear night under the full moon
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
  vec3 h3s(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
  // one layer of stars: a grid of cells on the cube around the sky, at most one star per cell,
  // drawn as a soft dot about a pixel across (pix: radians per pixel) so they don't shimmer
  vec3 starLayer(vec3 d, float n, float density, float bMin, float bMax, float pw, float pix, float wash, float tw) {
    vec3 a = abs(d);
    vec2 uv;
    float face;
    if (a.x >= a.y && a.x >= a.z) { uv = d.yz / a.x; face = d.x > 0.0 ? 0.0 : 1.0; }
    else if (a.y >= a.z) { uv = d.xz / a.y; face = d.y > 0.0 ? 2.0 : 3.0; }
    else { uv = d.xy / a.z; face = d.z > 0.0 ? 4.0 : 5.0; }
    vec2 g = (uv * 0.5 + 0.5) * n;
    vec2 c = floor(g);
    vec3 r = h3s(vec3(c, face * 61.0 + n));
    if (r.x > density) return vec3(0.0);
    vec3 r2 = h3s(vec3(c + 17.3, face * 13.0 - n));
    vec2 o = r.yz * 0.7 + 0.15;
    float th = length(g - c - o) / n * 2.0 / (1.0 + 0.5 * dot(uv, uv)); // ~radians
    float b = bMin + bMax * pow(r2.x, pw);
    // twinkling: some stars, more of it low in the sky where the air is thicker
    if (r2.y < 0.45) b *= 1.0 - tw * (0.5 + 0.5 * sin(uTime * (3.0 + 9.0 * r2.z) + r2.y * 80.0)) * (0.55 + 0.45 * sin(uTime * (1.3 + 2.0 * r2.x) + r2.z * 31.0));
    b = max(b - wash, 0.0); // the moonlit sky drowns the faint ones
    float rad = pix * (0.8 + 0.45 * sqrt(min(b, 4.0)));
    vec3 tint = mix(vec3(1.0, 0.82, 0.64), vec3(0.78, 0.86, 1.0), smoothstep(0.15, 0.85, r2.z));
    return tint * b * exp(-th * th / (rad * rad)) * (pix * pix) / (rad * rad);
  }
  vec3 nightSky(vec3 d, float up) {
    float mc = dot(d, MOON_DIR);
    float mg = max(mc, 0.0);
    vec3 col = mix(vec3(0.03, 0.046, 0.075), vec3(0.003, 0.007, 0.02), pow(smoothstep(0.0, 0.75, up), 0.7));
    // the moonlit sky: a broad brightening toward the moon and a tight aureole
    vec3 glow = MOON_COLOR * (0.045 * pow(mg, 3.0) + 0.1 * pow(mg, 40.0) + 0.3 * pow(mg, 400.0) + 0.5 * pow(mg, 2500.0));
    col += glow;
    float wash = 0.008 + 1.4 * pow(mg, 10.0) + 0.22 * pow(mg, 2.0);
    float pix = 0.5 * length(fwidth(d)); // ~radians per pixel
    // the Milky Way: a faint, mottled band with dark lanes, across the northern sky (away from the moon)
    vec3 N = normalize(vec3(0.55, 0.35, 0.76));
    vec3 B1 = normalize(cross(N, vec3(0.0, 1.0, 0.0)));
    vec3 B2 = cross(N, B1);
    float off = dot(d, N);
    vec2 bp = vec2(atan(dot(d, B2), dot(d, B1)) * 3.0, off * 9.0);
    float clump = fbm(bp * 1.3 + 4.0);
    float band = exp(-off * off / (0.018 + 0.02 * clump)) * smoothstep(0.35, 0.8, clump + 0.25);
    float lanes = smoothstep(0.5, 0.75, fbm3(bp * 2.6 + 9.0)) * exp(-off * off / 0.004);
    band *= (1.0 - 0.75 * lanes) * (1.0 - smoothstep(0.0, 0.5, wash)) * smoothstep(0.05, 0.3, up);
    col += vec3(0.05, 0.055, 0.07) * band;
    float horizon = smoothstep(0.0, 0.22, up);
    vec3 stars = starLayer(d, 60.0, 0.35, 0.06, 2.6, 9.0, pix, wash, 0.7)
      + starLayer(d, 150.0, 0.4 + 0.4 * band, 0.04, 0.4, 5.0, pix, wash, 0.45)
      + starLayer(d, 300.0, 0.35 + 0.6 * band, 0.03, 0.09, 2.0, pix, wash * 1.3, 0.25);
    col += stars * horizon * horizon;
    // the full moon itself: large, low over the sea, its seas darker than the bright highlands
    vec3 mR = normalize(cross(MOON_DIR, vec3(0.0, 1.0, 0.0)));
    vec3 mU = cross(mR, MOON_DIR);
    vec2 mp = vec2(dot(d, mR), dot(d, mU)) / 0.04; // ~2.3 degrees in radius: big, as a low moon looks
    float mr = length(mp);
    if (mc > 0.0 && mr < 1.5) {
      float e = max(fwidth(mr), 1e-3);
      float disk = 1.0 - smoothstep(1.0 - e, 1.0 + e, mr);
      float maria = smoothstep(0.42, 0.6, fbm(mp * 1.25 + vec2(2.3, 7.1)));
      maria = max(maria, 0.7 * smoothstep(0.5, 0.62, fbm3(mp * 2.2 - vec2(4.0, 1.0))));
      float alb = mix(1.0, 0.58, maria) * (0.9 + 0.2 * sNoise(mp * 11.0)) * (0.93 + 0.07 * sNoise(mp * 30.0));
      // a bright young crater with faint rays, low on the disk
      vec2 ty = mp - vec2(-0.12, -0.62);
      alb += 0.35 * exp(-dot(ty, ty) * 900.0) + 0.06 * exp(-dot(ty, ty) * 18.0) * smoothstep(0.6, 0.9, sNoise(vec2(atan(ty.y, ty.x) * 7.0, 1.0)));
      float limb = 0.82 + 0.18 * sqrt(max(1.0 - mr * mr, 0.0));
      col = mix(col, vec3(1.0, 0.97, 0.9) * 1.25 * alb * limb, disk);
    }
    return col;
  }
  void main() {
    vec3 d = normalize(vDir);
    float up = clamp(d.y, 0.0, 1.0);
    float sunCos = dot(d, SUN_DIR);

    // --- overcast: a mottled deck of heavier and lighter masses in slow rolls,
    // with a lower, darker layer of ragged scud drifting faster beneath it
    vec2 deck = d.xz / max(d.y, 0.06);
    vec3 col = mix(uHorizon, uZenith, smoothstep(0.02, 0.55, up));
    if (uNight > 0.5) {
      col = nightSky(d, up);
      // haze low down, meeting the fog
      col = mix(col, uHorizon, (1.0 - smoothstep(0.0, 0.1, up)) * 0.85);
    } else {
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
    uNight: { value: 0 },
  };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
      uniforms,
      defines: { SUN_DIR: v3(SUN_DIR), SUN_COLOR: v3(SUN_COLOR), MOON_DIR: v3(MOON_DIR), MOON_COLOR: v3(MOON_COLOR) },
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
export function createEnvironment(renderer, { night = false } = {}) {
  const envScene = new THREE.Scene();
  const { mesh, uniforms } = createSky();
  mesh.onBeforeRender = () => {};
  mesh.scale.setScalar(10);
  uniforms.uHorizon.value.set(night ? 0x0d1522 : 0x8a989a);
  uniforms.uZenith.value.set(0xb7c3c8);
  uniforms.uNight.value = night ? 1 : 0;
  envScene.add(mesh);
  // dark forest "ground" below the horizon
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(9, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: night ? 0x030504 : 0x1f2a1c }),
  );
  ground.position.y = -1.5;
  envScene.add(ground);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0.02);
  pmrem.dispose();
  return rt.texture;
}
