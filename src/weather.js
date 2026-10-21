import * as THREE from 'three';
import { snowlineAt } from './terrain.js';
import { createSky, SUN_DIR, SUN_COLOR, MOON_DIR, MOON_COLOR } from './atmosphere.js';
import { shared } from './materials.js';

const smooth = THREE.MathUtils.smoothstep;

// Precipitation lives in a box that wraps around the camera, animated entirely
// on the GPU: each particle has a fixed random offset and the vertex shader
// moves it by time and wraps it back into the box.

const RAIN_BOX = new THREE.Vector3(70, 40, 70);
const SNOW_BOX = new THREE.Vector3(60, 30, 60);

/** No rain or snow under the cabin's roof (shared, not cloned: the cabin is placed later). */
function shelter(mat) {
  mat.uniforms.uShelterInv = shared.uShelterInv;
  mat.uniforms.uShelter = shared.uShelter;
  mat.uniforms.uShelterPitch = shared.uShelterPitch;
  mat.uniforms.uCaveIn = shared.uCaveIn; // (and none in the cave)
  mat.uniforms.uFallsShade = shared.uFallsShade;
  mat.uniforms.uFallsRect = shared.uFallsRect;
}

function createRain(count = 14000) {
  const offsets = new Float32Array(count * 2 * 3);
  const ends = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = Math.random();
    const y = Math.random();
    const z = Math.random();
    for (let e = 0; e < 2; e++) {
      offsets.set([x, y, z], (i * 2 + e) * 3);
      ends[i * 2 + e] = e;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(offsets, 3));
  geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: RAIN_BOX },
        uIntensity: { value: 1 },
        uWind: { value: new THREE.Vector2(2.5, 1.0) },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform sampler2D uCanopyMap;
      uniform vec4 uCanopyRect;
      attribute float aEnd;
      uniform float uTime;
      uniform vec3 uCam;
      uniform vec3 uBox;
      uniform vec2 uWind;
      varying float vAlpha;
      uniform mat4 uShelterInv;
      uniform vec4 uShelter;
      uniform float uShelterPitch;
      uniform float uCaveIn;
      uniform sampler2D uFallsShade;
      uniform vec4 uFallsRect;
      bool sheltered(vec3 p) {
        vec3 l = (uShelterInv * vec4(p, 1.0)).xyz;
        // (and under the waterfall's overhang: falls.js's shade map, below its ceiling)
        vec2 fsUv = (p.xz - uFallsRect.xy) / uFallsRect.zw;
        if (all(greaterThan(fsUv, vec2(0.0))) && all(lessThan(fsUv, vec2(1.0)))) {
          vec2 fs = texture2D(uFallsShade, fsUv).rg;
          if (fs.r > 0.31 && p.y < fs.g + 0.5) return true;
        }
        return abs(l.x) < uShelter.x && l.z > uShelter.y && l.z < uShelter.z && l.y > -2.0 && l.y < uShelter.w - uShelterPitch * abs(l.x);
      }
      void main() {
        float speed = 17.0 + fract(position.x * 91.7 + position.z * 13.1) * 6.0;
        vec3 vel = vec3(uWind.x, -speed, uWind.y);
        vec3 p = position * uBox + vel * uTime;
        vec3 origin = uCam - uBox * 0.5;
        p = mod(p - origin, uBox) + origin;
        p -= vel * aEnd * 0.045;           // streak tail
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        float d = length(p - uCam);
        vAlpha = (1.0 - smoothstep(18.0, 34.0, d)) * mix(1.0, 0.35, aEnd);
        // shelter: under a closed canopy most rain never reaches the floor, only drips from
        // the crowns, while clearings get the full shower (canopy map, as for the sunlight)
        float canopy = min(1.0, texture2D(uCanopyMap, (p.xz - uCanopyRect.xy) / uCanopyRect.zw).r * 2.2);
        float above = p.y - (uCam.y - 1.7); // ~height above the ground under the camera
        float shelter = canopy * smoothstep(18.0, 8.0, above);
        if (fract(position.y * 71.3 + position.x * 7.9) < 0.88 * shelter) vAlpha = 0.0;
        if (sheltered(p) || uCaveIn > 0.5) vAlpha = 0.0;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <fog_pars_fragment>
      uniform float uIntensity;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.0) discard;
        gl_FragColor = vec4(0.72, 0.78, 0.84, 0.42 * vAlpha * uIntensity);
        #include <fog_fragment>
      }
    `,
  });
  // shared (not cloned by merge): the canopy map is baked after the weather is built
  mat.uniforms.uCanopyMap = shared.uCanopyMap;
  mat.uniforms.uCanopyRect = shared.uCanopyRect;
  shelter(mat);
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 10;
  return lines;
}

function createSnow(count = 14000) {
  const offsets = new Float32Array(count * 3);
  for (let i = 0; i < offsets.length; i++) offsets[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(offsets, 3));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: SNOW_BOX },
        uIntensity: { value: 1 },
        uWind: { value: new THREE.Vector2(1.5, 0.6) },
        uPixelRatio: { value: 1 },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform float uTime;
      uniform vec3 uCam;
      uniform vec3 uBox;
      uniform vec2 uWind;
      uniform float uPixelRatio;
      varying float vAlpha;
      uniform mat4 uShelterInv;
      uniform vec4 uShelter;
      uniform float uShelterPitch;
      uniform float uCaveIn;
      uniform sampler2D uFallsShade;
      uniform vec4 uFallsRect;
      bool sheltered(vec3 p) {
        vec3 l = (uShelterInv * vec4(p, 1.0)).xyz;
        // (and under the waterfall's overhang: falls.js's shade map, below its ceiling)
        vec2 fsUv = (p.xz - uFallsRect.xy) / uFallsRect.zw;
        if (all(greaterThan(fsUv, vec2(0.0))) && all(lessThan(fsUv, vec2(1.0)))) {
          vec2 fs = texture2D(uFallsShade, fsUv).rg;
          if (fs.r > 0.31 && p.y < fs.g + 0.5) return true;
        }
        return abs(l.x) < uShelter.x && l.z > uShelter.y && l.z < uShelter.z && l.y > -2.0 && l.y < uShelter.w - uShelterPitch * abs(l.x);
      }
      void main() {
        float seed = fract(position.x * 53.1 + position.y * 17.3 + position.z * 7.7);
        float fall = 1.1 + seed * 0.9;
        vec3 p = position * uBox + vec3(uWind.x, -fall, uWind.y) * uTime;
        p.x += sin(uTime * (0.6 + seed) + seed * 40.0) * 0.8;
        p.z += cos(uTime * (0.5 + seed * 0.7) + seed * 23.0) * 0.8;
        vec3 origin = uCam - uBox * 0.5;
        p = mod(p - origin, uBox) + origin;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = (0.08 + seed * 0.1) * uPixelRatio * (500.0 / -mvPosition.z);
        float d = length(p - uCam);
        vAlpha = 1.0 - smoothstep(16.0, 29.0, d);
        if (sheltered(p) || uCaveIn > 0.5) {
          vAlpha = 0.0;
          gl_PointSize = 0.0;
        }
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <fog_pars_fragment>
      uniform float uIntensity;
      varying float vAlpha;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.15, r);
        gl_FragColor = vec4(vec3(0.96, 0.97, 1.0), a * vAlpha * uIntensity * 0.95);
        #include <fog_fragment>
      }
    `,
  });
  shelter(mat);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 11;
  return points;
}

const MOTE_BOX = new THREE.Vector3(16, 8, 16);
const MIST_GAIN = 1.7; // sunbeam mist (post.js) relative to the overcast fog density

/**
 * Dust motes and seed fluff drifting in the air: invisible in overcast, they
 * catch the light in a sun break, brightest looking toward the sun (forward
 * scattering) and only where the canopy lets the sun through, so they
 * gather in the shafts. Soft, close to the camera (≤7 m), additive, ~900 points.
 */
function createMotes(count = 900) {
  const offsets = new Float32Array(count * 3);
  for (let i = 0; i < offsets.length; i++) offsets[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(offsets, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uBox: { value: MOTE_BOX },
      uIntensity: { value: 0 },
      uPixelRatio: { value: 1 },
      uCanopyMap: shared.uSunMap,
      uCanopyRect: shared.uCanopyRect,
      uKeyDir: shared.uKeyDir,
    },
    vertexShader: /* glsl */ `
      uniform vec3 uKeyDir; // toward the sun (or the moon)
      uniform float uTime;
      uniform vec3 uCam;
      uniform vec3 uBox;
      uniform float uPixelRatio;
      uniform sampler2D uCanopyMap;
      uniform vec4 uCanopyRect;
      varying float vAlpha;
      void main() {
        float seed = fract(position.x * 53.1 + position.y * 17.3 + position.z * 7.7);
        // a slow drift on the breeze, rising and sinking a little
        vec3 p = position * uBox + vec3(0.25, 0.02 * sin(seed * 31.0), 0.12) * uTime;
        p.x += sin(uTime * (0.21 + 0.2 * seed) + seed * 40.0) * 0.6;
        p.y += sin(uTime * (0.17 + 0.15 * seed) + seed * 13.0) * 0.4;
        p.z += cos(uTime * (0.19 + 0.18 * seed) + seed * 23.0) * 0.6;
        vec3 origin = uCam - uBox * vec3(0.5, 0.35, 0.5);
        p = mod(p - origin, uBox) + origin;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = max(1.5, (0.03 + seed * 0.03) * uPixelRatio * (700.0 / -mvPosition.z));
        // in sunlight? (the canopy along the ray toward the sun, as for the ground)
        vec2 q = p.xz + uKeyDir.xz / uKeyDir.y * 10.0;
        float c = texture2D(uCanopyMap, (q - uCanopyRect.xy) / uCanopyRect.zw).r;
        float lit = 1.0 - smoothstep(0.12, 0.38, c);
        // forward scattering: bright toward the sun, faint elsewhere
        vec3 toP = normalize(p - uCam);
        float phase = 0.12 + 1.6 * pow(max(dot(toP, uKeyDir), 0.0), 6.0);
        float d = length(p - uCam);
        float fade = smoothstep(0.8, 2.0, d) * (1.0 - smoothstep(4.5, 7.5, d));
        vAlpha = lit * phase * fade * (0.5 + 0.5 * seed);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying float vAlpha;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, r);
        gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * (a * a * vAlpha * uIntensity * 0.45), 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'motes';
  points.frustumCulled = false;
  points.renderOrder = 12;
  return points;
}

// Atmosphere presets: overcast temperate rainforest vs. high-country snow.
const LOW = {
  fog: new THREE.Color(0x7d8b8c),
  density: 0.0106, // (was 0.0085: trunks now layer into the mist with depth) valley pooling in the height fog adds ~35% low down
  zenith: new THREE.Color(0xa9b5b9),
  hemiSky: new THREE.Color(0xaab8bd),
  hemiGround: new THREE.Color(0x2c3a22),
  hemiIntensity: 1.5,
  sunIntensity: 0.8,
};
const OVERCAST_DIR = new THREE.Vector3(-0.4, 1, 0.3).normalize(); // the diffuse "sun" behind the cloud deck
const SUN_FOG = new THREE.Color(0xa7b8c6); // sunlit haze: the pale blue-grey of a blue sky's aerial perspective
const SUN_HEMI = new THREE.Color(0xb4c8de); // blue sky between the clouds
// A clear night under the full moon (cave.js swaps day and night): blue-black haze, a cool sky
// light, and the moon as the key light (dappled through the crowns, beams in the mist)
const NIGHT = {
  fog: new THREE.Color(0x121c2a),
  fogHigh: new THREE.Color(0x1a2534),
  hemiSky: new THREE.Color(0x30466e),
  hemiGround: new THREE.Color(0x0a0e0b),
  hemiIntensity: 0.55,
  moonIntensity: 1.25,
  envIntensity: 0.35,
};
const KEY_DAY = { dir: SUN_DIR, color: SUN_COLOR.clone() };
const KEY_NIGHT = { dir: MOON_DIR, color: MOON_COLOR.clone().multiplyScalar(0.6) };
const HIGH = {
  fog: new THREE.Color(0xc4ccd4),
  density: 0.0145,
  zenith: new THREE.Color(0xe1e6ec),
  hemiSky: new THREE.Color(0xdfe6ee),
  hemiGround: new THREE.Color(0x8a96a3),
  hemiIntensity: 1.4,
  sunIntensity: 0.5,
};

export class Weather {
  constructor(scene, renderer, { particles = 1 } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.baseExposure = renderer.toneMappingExposure;
    this.sky = createSky();
    scene.add(this.sky.mesh);
    this.rain = createRain(Math.round(14000 * particles));
    this.snow = createSnow(Math.round(14000 * particles));
    this.snow.material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    this.motes = createMotes(Math.round(900 * particles));
    this.motes.material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    scene.add(this.rain, this.snow, this.motes);

    // THREE.Fog as a carrier: near = density, far = time (see installHeightFog)
    scene.fog = new THREE.Fog(LOW.fog.clone(), LOW.density, 0);
    scene.background = scene.fog.color;

    this.hemi = new THREE.HemisphereLight(LOW.hemiSky, LOW.hemiGround, LOW.hemiIntensity);
    this.sun = new THREE.DirectionalLight(0xfff4e0, LOW.sunIntensity);
    this.sun.position.copy(OVERCAST_DIR).multiplyScalar(100);
    scene.add(this.hemi, this.sun);

    this.audio = null;
    this.rainAmount = 1;
    this.snowAmount = 0;
    this.override = null; // 'rain' | 'snow' | 'clear' | null (automatic by altitude)
    this.sunAmount = 0; // 0 overcast .. 1 sun break (shared.uSun)
    this.sunCycle = true; // ?weather= or ?off=sun pin it
    this.night = false; // a clear, moonlit night (setNight)
    this.envs = null; // { day, night } environment maps (main.js)
    // set by main.js from the cave: how far in (0 outside .. 1 deep), the nearest torch (m)
    this.cave = { depth: 0, torch: 100 };
    this.falls = { dist: 1e9, under: 0 }; // (falls.js: m from the curtain; 0..1 under the overhang)
    this.outdoors = 1; // 0 in the cave (main.js): the exposure doesn't follow the weather in there
  }

  /** Day or night, at once (the cave swaps them while the screen is white). */
  setNight(on) {
    this.night = on;
    this.started = false; // snap the weather to its new state on the next update
    this.started2 = false;
    this.wetStarted = false;
    this.puddleStarted = false;
    const key = on ? KEY_NIGHT : KEY_DAY;
    shared.uNight.value = on ? 1 : 0;
    shared.uKeyDir.value.copy(key.dir);
    shared.uKeyColor.value.copy(key.color);
    shared.uKeyOff.value.set(key.dir.x * 12 / key.dir.y, key.dir.z * 12 / key.dir.y);
    if (this.envs && this.scene.environment) this.scene.environment = on ? this.envs.night : this.envs.day;
    this.scene.environmentIntensity = on ? NIGHT.envIntensity : 0.55;
  }

  /** Everything update() and setNight() set (to render a view at the other time of day, then put it all back). */
  stateRefs() {
    const fog = this.scene.fog ?? this.fogOff;
    const refs = [
      [this, 'rainAmount'], [this, 'snowAmount'], [this, 'sunAmount'], [this, 'started'], [this, 'started2'],
      [this, 'wetStarted'], [this, 'puddleStarted'], [this, 'night'],
      [this.scene, 'environment'], [this.scene, 'environmentIntensity'], [this.renderer, 'toneMappingExposure'],
      [fog, 'color'], [fog, 'near'], [fog, 'far'], [fog, 'mist'],
      [this.hemi, 'color'], [this.hemi, 'groundColor'], [this.hemi, 'intensity'],
      [this.sun, 'color'], [this.sun, 'intensity'], [this.sun, 'position'],
    ];
    for (const k of ['uSun', 'uWet', 'uRain', 'uPuddle', 'uWind', 'uNight', 'uKeyDir', 'uKeyColor', 'uKeyOff']) refs.push([shared[k], 'value']);
    for (const k of ['uHorizon', 'uZenith', 'uSun', 'uNight', 'uTime']) refs.push([this.sky.uniforms[k], 'value']);
    for (const o of [this.rain, this.snow, this.motes]) {
      refs.push([o, 'visible']);
      for (const k of ['uTime', 'uCam', 'uIntensity']) refs.push([o.material.uniforms[k], 'value']);
    }
    return refs;
  }

  capture() {
    return this.stateRefs().map(([o, k]) => (o[k]?.clone && !o[k].isTexture ? o[k].clone() : o[k]));
  }

  restore(saved) {
    this.stateRefs().forEach(([o, k], i) => {
      const v = saved[i];
      if (o[k]?.copy && v?.clone && !v.isTexture) o[k].copy(v);
      else o[k] = v;
    });
  }

  /** Run fn with the weather, sky and light as they'd be at the other time of day here (camera), then put them back. */
  atOtherTime(time, camera, fn) {
    const saved = this.capture();
    this.setNight(!this.night);
    this.update(0, time, camera, true);
    fn();
    this.restore(saved);
  }

  update(dt, time, camera, silent = false) {
    const y = camera.position.y;
    const line = snowlineAt(camera.position.x, camera.position.z);
    const snowT = smooth(y, line - 30, line + 10);
    // Sun breaks: a slow cycle (~6 min) between showers and spells of low,
    // warm sun. Starts in a break, so the first view is a sunlit one.
    let sunT = this.sunCycle ? smooth(0.5 + 0.5 * Math.cos((time / 360) * Math.PI * 2), 0.3, 0.7) : 0;
    if (this.override === 'clear') sunT = 1;
    if (this.override === 'rain' || this.override === 'snow') sunT = 0;
    let rain = (1 - smooth(y, line - 14, line)) * (1 - sunT);
    let snow = smooth(y, line - 22, line - 6) * (1 - 0.75 * sunT);
    if (this.override === 'rain') { rain = 1; snow = 0; }
    if (this.override === 'snow') { rain = 0; snow = 1; }
    if (this.override === 'clear') { rain = 0; snow = 0; }
    if (this.night) { sunT = 1; rain = 0; snow = 0; } // always a clear night

    // ease toward targets so overrides fade in/out (snap on the first frame)
    const k = this.started ? 1 - Math.exp(-dt * 1.5) : 1;
    this.started = true;
    this.rainAmount += (rain - this.rainAmount) * k;
    this.snowAmount += (snow - this.snowAmount) * k;
    this.sunAmount += (sunT - this.sunAmount) * (this.started2 ? 1 - Math.exp(-dt * 0.5) : 1);
    this.started2 = true;
    const sun = this.sunAmount;
    shared.uSun.value = sun;

    for (const [obj, amount] of [[this.rain, this.rainAmount], [this.snow, this.snowAmount]]) {
      const u = obj.material.uniforms;
      u.uTime.value = time;
      u.uCam.value.copy(camera.position);
      u.uIntensity.value = amount;
      obj.visible = amount > 0.01 && !this.particlesOff;
    }
    {
      const u = this.motes.material.uniforms;
      u.uTime.value = time;
      u.uCam.value.copy(camera.position);
      u.uIntensity.value = sun * (1 - snowT) * (this.night ? 0.3 : 1);
      this.motes.visible = u.uIntensity.value > 0.01 && !this.particlesOff && !this.motesOff && shared.uCaveIn.value < 0.5;
    }

    // Atmosphere follows altitude; sun breaks thin the fog (but leave a haze for
    // the light to show in) and warm everything up.
    const fog = this.scene.fog ?? this.fogOff; // ?off=fog keeps updating a detached copy
    fog.color.copy(LOW.fog).lerp(HIGH.fog, snowT).lerp(SUN_FOG, sun * (1 - 0.6 * snowT));
    // (sun breaks clear the high country more than the valley: clear mountain air, peaks in view)
    const density = THREE.MathUtils.lerp(LOW.density, HIGH.density, snowT) * THREE.MathUtils.lerp(1, 0.45 - 0.3 * snowT, sun); // clear air in sun: at 0.62 the far lake shore whited out looking into the sun; up high, peaks 300 m off were ghosts
    if (this.night) fog.color.copy(NIGHT.fog).lerp(NIGHT.fogHigh, snowT);
    fog.near = Math.round(sun * 255) + (this.night ? 256 : 0) + Math.min(density, 0.999); // see installHeightFog
    // the mist the sunbeams show in (post.js) doesn't clear with the haze: clearing it with the
    // view (0.62 → 0.45) left the shafts too faint to notice
    fog.mist = THREE.MathUtils.lerp(LOW.density, HIGH.density, snowT) * MIST_GAIN;
    this.hemi.color.copy(LOW.hemiSky).lerp(HIGH.hemiSky, snowT).lerp(SUN_HEMI, sun * 0.6);
    this.hemi.groundColor.copy(LOW.hemiGround).lerp(HIGH.hemiGround, snowT);
    this.hemi.intensity = THREE.MathUtils.lerp(LOW.hemiIntensity, HIGH.hemiIntensity, snowT) * (1 - 0.4 * sun); // in sun, direct light dominates
    this.sun.intensity = THREE.MathUtils.lerp(LOW.sunIntensity, HIGH.sunIntensity, snowT) * (1 - sun) + 2.3 * sun;
    // a touch less exposure in sun, or sunlit foliage tone-maps to beige
    this.renderer.toneMappingExposure = this.baseExposure * (1 - 0.08 * sun * this.outdoors);
    this.sun.color.setRGB(1, 0.96, 0.88).lerp(SUN_COLOR, sun);
    // overcast light comes from high up (soft, no low glints on wet ground);
    // the sun swings down to its low WNW position as a break arrives
    this.sun.position.copy(OVERCAST_DIR).lerp(SUN_DIR, sun).normalize().multiplyScalar(100);
    if (this.night) {
      this.hemi.color.copy(NIGHT.hemiSky);
      this.hemi.groundColor.copy(NIGHT.hemiGround);
      this.hemi.intensity = NIGHT.hemiIntensity;
      this.sun.intensity = NIGHT.moonIntensity;
      this.sun.color.copy(MOON_COLOR);
      this.sun.position.copy(MOON_DIR).multiplyScalar(100);
      this.renderer.toneMappingExposure = this.baseExposure;
    }

    this.sky.uniforms.uHorizon.value.copy(fog.color);
    this.sky.uniforms.uZenith.value.copy(LOW.zenith).lerp(HIGH.zenith, snowT);
    this.sky.uniforms.uSun.value = sun;
    this.sky.uniforms.uNight.value = this.night ? 1 : 0;
    this.sky.uniforms.uTime.value = time;
    fog.far = time; // drifts the mist banks

    // Surfaces stay damp in the rainforest even between showers; they dry out
    // in clear weather and there's no liquid water up in the snow.
    const wetTarget = (0.55 + 0.45 * this.rainAmount - 0.35 * sun) * (1 - snowT);
    shared.uWet.value += (wetTarget - shared.uWet.value) * (this.wetStarted ? 1 - Math.exp(-dt * 0.3) : 1);
    this.wetStarted = true;
    shared.uRain.value = this.rainAmount;
    // puddles fill over ~40 s of rain and dry over a few minutes (the first frame starts settled);
    // it rains in the valley whenever there's no sun break, wherever the player is
    const fill = this.night || this.override === 'clear' || this.override === 'snow' ? 0 : this.override === 'rain' ? 1 : 1 - sun;
    const pk = fill > shared.uPuddle.value ? 1 / 40 : 1 / 200;
    shared.uPuddle.value = this.puddleStarted ? shared.uPuddle.value + (fill - shared.uPuddle.value) * Math.min(1, dt * pk) : fill;
    this.puddleStarted = true;

    shared.uWind.value = 0.7 + this.snowAmount * 0.8 + Math.sin(time * 0.13) * 0.3;

    if (this.audio) this.audio.falls = this.falls;
    if (this.audio && !silent) this.audio.update(this.rainAmount, this.snowAmount, time, sun, this.night, this.cave, snowT);
  }

  enableAudio() {
    if (!this.audio) this.audio = new Ambience();
    this.audio.resume();
  }
}

/** Rain hiss, a breeze in gusts and occasional birdsong, all synthesised (no audio files). */
class Ambience {
  constructor() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1; // pinkish noise
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
      }
    }
    const src = (rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(0, Math.random() * 3);
      return s;
    };

    // rain: bright hiss
    const rainHp = ctx.createBiquadFilter();
    rainHp.type = 'highpass';
    rainHp.frequency.value = 500;
    const rainLp = ctx.createBiquadFilter();
    rainLp.type = 'lowpass';
    rainLp.frequency.value = 7000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    src(1).connect(rainHp).connect(rainLp).connect(this.rainGain).connect(ctx.destination);

    // wind: a breeze in the crowns, not a roar. The old low band (220-600 Hz, always on at
    // 0.12-0.37) read as a waterfall or pouring rain in calm, sunny weather (the user).
    // Now a soft rustle band (900-2500 Hz) that's near silent between gusts.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 1200;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src(1).connect(this.windFilter).connect(this.windGain).connect(ctx.destination);

    // birds: a little forest echo (feedback delay, damped) shared by every song
    this.birdBus = ctx.createGain();
    this.birdBus.gain.value = 1;
    const echo = ctx.createDelay(1);
    echo.delayTime.value = 0.23;
    const fb = ctx.createGain();
    fb.gain.value = 0.28;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2500;
    this.birdBus.connect(ctx.destination);
    this.birdBus.connect(echo).connect(damp).connect(fb).connect(echo);
    damp.connect(ctx.destination);
    this.nextBird = 2 + Math.random() * 4;

    // outdoors (rain, wind, birds, crickets) fades as you go into the cave
    this.outdoor = ctx.createGain();
    this.outdoor.connect(ctx.destination);
    this.rainGain.disconnect();
    this.rainGain.connect(this.outdoor);
    this.windGain.disconnect();
    this.windGain.connect(this.outdoor);
    this.birdBus.disconnect();
    this.birdBus.connect(this.outdoor);
    this.birdBus.connect(echo);

    // the cave: a long, dark reverb (synthesised impulse), a low room tone, drips, the torches' crackle
    const ir = ctx.createBuffer(2, ctx.sampleRate * 2.6, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const t = i / ctx.sampleRate;
        d[i] = (Math.random() * 2 - 1) * Math.exp(-t / 0.55) * (t < 0.012 ? t / 0.012 : 1);
      }
    }
    this.caveVerb = ctx.createConvolver();
    this.caveVerb.buffer = ir;
    const verbLp = ctx.createBiquadFilter();
    verbLp.type = 'lowpass';
    verbLp.frequency.value = 3200;
    this.caveVerb.connect(verbLp).connect(ctx.destination);
    this.caveBus = ctx.createGain(); // dry + into the reverb
    this.caveBus.connect(ctx.destination);
    this.caveBus.connect(this.caveVerb);
    this.roomLp = ctx.createBiquadFilter();
    this.roomLp.type = 'lowpass';
    this.roomLp.frequency.value = 160;
    this.roomGain = ctx.createGain();
    this.roomGain.gain.value = 0;
    src(0.7).connect(this.roomLp).connect(this.roomGain).connect(ctx.destination);
    this.crackleBus = ctx.createGain();
    this.crackleBus.gain.value = 0;
    this.crackleBus.connect(this.caveBus);
    this.noiseBuf = buf;
    // the waterfall (falls.js): a deep rumble and a broad roar, louder as you come near, echoing in its alcove
    const fallsLp = ctx.createBiquadFilter();
    fallsLp.type = 'lowpass';
    fallsLp.frequency.value = 320;
    this.fallsLow = ctx.createGain();
    this.fallsLow.gain.value = 0;
    src(0.55).connect(fallsLp).connect(this.fallsLow).connect(ctx.destination);
    const fallsBp = ctx.createBiquadFilter();
    fallsBp.type = 'bandpass';
    fallsBp.frequency.value = 1100;
    fallsBp.Q.value = 0.5;
    this.fallsMid = ctx.createGain();
    this.fallsMid.gain.value = 0;
    src(0.85).connect(fallsBp).connect(this.fallsMid).connect(ctx.destination);
    this.fallsVerb = ctx.createGain();
    this.fallsVerb.gain.value = 0;
    this.fallsMid.connect(this.fallsVerb).connect(this.caveVerb);
    this.falls = { dist: 1e9, under: 0 };
    this.nextDrip = 1;
    this.nextCrackle = 0;
    // crickets on a clear night: a few, each chirping steadily at its own pitch and pace
    this.crickets = [0, 1, 2].map(() => ({
      f: 3600 + Math.random() * 1400, period: 0.42 + Math.random() * 0.3, next: 0,
      pan: Math.random() * 1.6 - 0.8, vol: 0.004 + Math.random() * 0.006,
    }));
  }

  /** A short burst of noise (torch crackle) at t. */
  burst(t, dur, freq, vol, out) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp).connect(g).connect(out);
    s.start(t, Math.random() * 3, dur + 0.02);
  }

  /** A water drop into a pool somewhere in the dark: a quick falling pitch, a smaller ringing one. */
  drip(t) {
    const ctx = this.ctx;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.4 - 0.7;
    pan.connect(this.caveBus);
    const f = 900 + Math.random() * 1500;
    for (const [mul, vol, dur] of [[1, 0.05, 0.05], [1.9, 0.015, 0.03]]) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(f * mul * 0.7, t);
      o.frequency.exponentialRampToValueAtTime(f * mul * 1.35, t + dur * 0.5);
      const g = ctx.createGain();
      const v = vol * (0.3 + Math.random() * 0.7);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(pan);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  /** One cricket chirp: three quick pulses of a pure tone. */
  chirp(c, t) {
    const ctx = this.ctx;
    const pan = ctx.createStereoPanner();
    pan.pan.value = c.pan;
    pan.connect(this.outdoor);
    for (let k = 0; k < 3; k++) {
      const o = ctx.createOscillator();
      o.frequency.value = c.f * (1 + (Math.random() - 0.5) * 0.004);
      const g = ctx.createGain();
      const t0 = t + k * 0.028;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(c.vol, t0 + 0.004);
      g.gain.linearRampToValueAtTime(0, t0 + 0.016);
      o.connect(g).connect(pan);
      o.start(t0);
      o.stop(t0 + 0.03);
    }
  }

  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  update(rain, snow, t, sun = 0, night = false, cave = { depth: 0, torch: 100 }, high = 0) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const deep = cave.depth;
    this.outdoor.gain.setTargetAtTime(1 - 0.92 * deep, now, 0.4);
    this.roomGain.gain.setTargetAtTime(0.05 * deep, now, 0.5);
    this.crackleBus.gain.setTargetAtTime(Math.min(1, 1.6 / Math.max(cave.torch, 0.5)) * (deep > 0 || cave.torch < 8 ? 1 : 0), now, 0.2);
    if (ctx.state === 'running') {
      if (deep > 0.3 && now >= this.nextDrip) {
        this.drip(now + 0.02);
        this.nextDrip = now + 0.5 + Math.random() * 2.5;
      }
      // torches crackle and spit: short bursts, a few a second
      if (cave.torch < 10 && now >= this.nextCrackle) {
        const big = Math.random() < 0.15;
        this.burst(now + 0.01, big ? 0.05 : 0.012 + Math.random() * 0.02, 1500 + Math.random() * 4000, big ? 0.05 : 0.025, this.crackleBus);
        this.nextCrackle = now + 0.03 + Math.random() * (big ? 0.4 : 0.18);
      }
      if (night && high < 0.5 && deep < 0.9) {
        for (const c of this.crickets) {
          if (c.next < now) c.next = now + Math.random() * c.period;
          if (c.next < now + 0.1) {
            this.chirp(c, c.next);
            c.next += c.period * (0.95 + Math.random() * 0.1);
          }
        }
      }
    }
    {
      const g = 1 / (1 + Math.pow(this.falls.dist / 22, 1.4));
      this.fallsLow.gain.setTargetAtTime(0.9 * g, now, 0.3);
      this.fallsMid.gain.setTargetAtTime(0.45 * g * (1 - 0.3 * this.falls.under), now, 0.3);
      this.fallsVerb.gain.setTargetAtTime(0.6 * this.falls.under, now, 0.4);
    }
    const gust = Math.max(0, Math.sin(t * 0.37) * Math.sin(t * 0.11 + 1.3)); // calm about half the time
    this.rainGain.gain.setTargetAtTime(rain * 0.4, now, 0.3);
    this.windGain.gain.setTargetAtTime(0.008 + (0.05 + snow * 0.25) * gust * gust, now, 0.8);
    this.windFilter.frequency.setTargetAtTime(900 + gust * 1200 + snow * 300, now, 0.8);

    // birdsong: often in sun breaks, now and then under cloud, never in rain or up in the snow
    const birdy = night ? 0 : (1 - rain) * (1 - snow) * (0.25 + 0.75 * sun);
    if (now >= this.nextBird && ctx.state === 'running') {
      if (birdy > 0.05 && Math.random() < birdy) this.sing(now);
      this.nextBird = now + 3 + Math.random() * 9;
    }
  }

  /**
   * One synthesised song at a random spot around the listener (no audio files). Every song is
   * built from short chirps (quick downward sweeps, ~20-40 ms): long held sine whistles (the
   * thrush songs tried first) sounded robotic, the chirpy wren trill didn't (the user).
   */
  sing(t0) {
    const ctx = this.ctx;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    const dist = 0.35 + Math.random() * 0.65; // nearer = louder
    const out = ctx.createGain();
    out.gain.value = 0.05 * dist;
    out.connect(pan).connect(this.birdBus);
    const chirp = (start, dur, f0, f1, vol = 1) => {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(f0, start);
      o.frequency.exponentialRampToValueAtTime(f1, start + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(vol, start + Math.min(0.008, dur * 0.3));
      g.gain.setTargetAtTime(0, start + dur * 0.6, dur * 0.15);
      o.connect(g).connect(out);
      o.start(start);
      o.stop(start + dur + 0.1);
    };
    const jit = (f, a) => f * (1 + (Math.random() * 2 - 1) * a);
    const kind = Math.random();
    let t = t0 + 0.05;
    if (kind < 0.3) {
      // wren-like tumbling trill: fast chips at shifting pitches
      const n = 12 + Math.floor(Math.random() * 14);
      let f = 4000 + Math.random() * 1500;
      for (let i = 0; i < n; i++) {
        if (i % 4 === 0) f = 3500 + Math.random() * 3000;
        chirp(t, 0.035, f * 1.1, f * 0.85, 0.6);
        t += 0.055 + Math.random() * 0.02;
      }
    } else if (kind < 0.55) {
      // dark-eyed junco: one even, musical trill of identical chips
      const f = 3800 + Math.random() * 1800;
      const gap = 0.06 + Math.random() * 0.025;
      const n = 10 + Math.floor(Math.random() * 9);
      for (let i = 0; i < n; i++) {
        chirp(t, 0.03, jit(f * 1.25, 0.01), f * 0.82, 0.45 + 0.25 * Math.sin((Math.PI * i) / n));
        t += gap;
      }
    } else if (kind < 0.8) {
      // Pacific wren: a long, tumbling run of trills at different pitches and speeds
      const parts = 3 + Math.floor(Math.random() * 3);
      for (let p = 0; p < parts; p++) {
        const f = 4200 + Math.random() * 3200;
        const gap = 0.035 + Math.random() * 0.03;
        const n = 4 + Math.floor(Math.random() * 6);
        const up = Math.random() < 0.5;
        for (let i = 0; i < n; i++) {
          const fi = f * (up ? 1 + 0.03 * i : 1 - 0.025 * i);
          chirp(t, Math.min(0.03, gap * 0.8), jit(fi * 1.15, 0.02), fi * 0.85, 0.5);
          t += gap;
        }
        t += 0.02 + Math.random() * 0.06;
      }
    } else {
      // chickadee-like "chick-a-dee-dee": two high chips, then husky dees made of micro-chirps
      chirp(t, 0.03, 7200, 5400, 0.55);
      t += 0.09;
      chirp(t, 0.025, 6400, 5000, 0.45);
      t += 0.1;
      const dees = 2 + Math.floor(Math.random() * 3);
      const f = 3300 + Math.random() * 500;
      for (let d = 0; d < dees; d++) {
        for (let k = 0; k < 11; k++) chirp(t + k * 0.013, 0.016, jit(f * 1.06, 0.03), jit(f * 0.94, 0.03), 0.35 * Math.sin((Math.PI * (k + 0.5)) / 11));
        t += 0.2;
      }
    }
  }
}
