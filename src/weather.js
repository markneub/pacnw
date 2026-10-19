import * as THREE from 'three';
import { snowlineAt } from './terrain.js';
import { createSky, SUN_DIR, SUN_COLOR } from './atmosphere.js';
import { shared } from './materials.js';

const smooth = THREE.MathUtils.smoothstep;

// Precipitation lives in a box that wraps around the camera, animated entirely
// on the GPU: each particle has a fixed random offset and the vertex shader
// moves it by time and wraps it back into the box.

const RAIN_BOX = new THREE.Vector3(70, 40, 70);
const SNOW_BOX = new THREE.Vector3(60, 30, 60);

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
  const off = SUN_DIR.clone().multiplyScalar(1 / SUN_DIR.y); // per metre of height, toward the sun
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
    },
    vertexShader: /* glsl */ `
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
        vec2 q = p.xz + vec2(${off.x.toFixed(3)}, ${off.z.toFixed(3)}) * 10.0;
        float c = texture2D(uCanopyMap, (q - uCanopyRect.xy) / uCanopyRect.zw).r;
        float lit = 1.0 - smoothstep(0.12, 0.38, c);
        // forward scattering: bright toward the sun, faint elsewhere
        vec3 toP = normalize(p - uCam);
        float phase = 0.12 + 1.6 * pow(max(dot(toP, ${'vec3(' + [SUN_DIR.x, SUN_DIR.y, SUN_DIR.z].map((v) => v.toFixed(4)).join(', ') + ')'}), 0.0), 6.0);
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
  }

  cycleOverride() {
    const order = [null, 'rain', 'snow', 'clear'];
    this.override = order[(order.indexOf(this.override) + 1) % order.length];
    return this.override ?? 'auto';
  }

  update(dt, time, camera) {
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
      u.uIntensity.value = sun * (1 - snowT);
      this.motes.visible = u.uIntensity.value > 0.01 && !this.particlesOff && !this.motesOff;
    }

    // Atmosphere follows altitude; sun breaks thin the fog (but leave a haze for
    // the light to show in) and warm everything up.
    const fog = this.scene.fog ?? this.fogOff; // ?off=fog keeps updating a detached copy
    fog.color.copy(LOW.fog).lerp(HIGH.fog, snowT).lerp(SUN_FOG, sun * (1 - 0.6 * snowT));
    // (sun breaks clear the high country more than the valley: clear mountain air, peaks in view)
    const density = THREE.MathUtils.lerp(LOW.density, HIGH.density, snowT) * THREE.MathUtils.lerp(1, 0.45 - 0.3 * snowT, sun); // clear air in sun: at 0.62 the far lake shore whited out looking into the sun; up high, peaks 300 m off were ghosts
    fog.near = Math.round(sun * 255) + Math.min(density, 0.999); // see installHeightFog
    // the mist the sunbeams show in (post.js) doesn't clear with the haze: clearing it with the
    // view (0.62 → 0.45) left the shafts too faint to notice
    fog.mist = THREE.MathUtils.lerp(LOW.density, HIGH.density, snowT) * MIST_GAIN;
    this.hemi.color.copy(LOW.hemiSky).lerp(HIGH.hemiSky, snowT).lerp(SUN_HEMI, sun * 0.6);
    this.hemi.groundColor.copy(LOW.hemiGround).lerp(HIGH.hemiGround, snowT);
    this.hemi.intensity = THREE.MathUtils.lerp(LOW.hemiIntensity, HIGH.hemiIntensity, snowT) * (1 - 0.4 * sun); // in sun, direct light dominates
    this.sun.intensity = THREE.MathUtils.lerp(LOW.sunIntensity, HIGH.sunIntensity, snowT) * (1 - sun) + 2.3 * sun;
    // a touch less exposure in sun, or sunlit foliage tone-maps to beige
    this.renderer.toneMappingExposure = this.baseExposure * (1 - 0.08 * sun);
    this.sun.color.setRGB(1, 0.96, 0.88).lerp(SUN_COLOR, sun);
    // overcast light comes from high up (soft, no low glints on wet ground);
    // the sun swings down to its low WNW position as a break arrives
    this.sun.position.copy(OVERCAST_DIR).lerp(SUN_DIR, sun).normalize().multiplyScalar(100);

    this.sky.uniforms.uHorizon.value.copy(fog.color);
    this.sky.uniforms.uZenith.value.copy(LOW.zenith).lerp(HIGH.zenith, snowT);
    this.sky.uniforms.uSun.value = sun;
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
    const fill = this.override === 'clear' || this.override === 'snow' ? 0 : this.override === 'rain' ? 1 : 1 - sun;
    const pk = fill > shared.uPuddle.value ? 1 / 40 : 1 / 200;
    shared.uPuddle.value = this.puddleStarted ? shared.uPuddle.value + (fill - shared.uPuddle.value) * Math.min(1, dt * pk) : fill;
    this.puddleStarted = true;

    shared.uWind.value = 0.7 + this.snowAmount * 0.8 + Math.sin(time * 0.13) * 0.3;

    if (this.audio) this.audio.update(this.rainAmount, this.snowAmount, time);
  }

  enableAudio() {
    if (!this.audio) this.audio = new Ambience();
    this.audio.resume();
  }
}

/** Rain hiss + gusting wind synthesised from filtered noise (no audio files). */
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

    // wind: slow, resonant low band
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 300;
    this.windFilter.Q.value = 1.4;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src(0.5).connect(this.windFilter).connect(this.windGain).connect(ctx.destination);
  }

  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  update(rain, snow, t) {
    const now = this.ctx.currentTime;
    const gust = 0.5 + 0.5 * Math.sin(t * 0.37) * Math.sin(t * 0.11 + 1.3);
    this.rainGain.gain.setTargetAtTime(rain * 0.55, now, 0.3);
    this.windGain.gain.setTargetAtTime(0.12 + (0.25 + snow * 0.9) * gust, now, 0.5);
    this.windFilter.frequency.setTargetAtTime(220 + gust * 380 + snow * 150, now, 0.5);
  }
}
