import * as THREE from 'three';
import { SUN_DIR, SUN_COLOR } from './atmosphere.js';
import { shared } from './materials.js';

/**
 * Post-processing: the scene renders into a target that holds exactly what the
 * canvas used to (tone mapped, sRGB: see the constructor for why), then
 *  1. bright pass (quarter res): sky and sunlit haze near the sun, plus a
 *     general highlight extract for the glow
 *  2. light shafts: a radial blur of that toward the sun's screen position
 *     (two passes of 16 taps, so the streaks reach far) — the canopy and trunks
 *     cut it into god rays
 *  3. glow: a small separable blur of the highlights (bloom, very soft)
 *  4. composite (full res): scene + shafts + glow (screen blend), a gentle grade
 *     (cool shade, warm light in a sun break), a soft vignette and a fine
 *     grain that also hides banding in the fog
 *
 * Shafts only exist in a sun break and fade as you look away from the sun.
 * `?off=post` renders straight to the screen as before.
 */

const fsGeometry = new THREE.BufferGeometry();
fsGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

function pass(fragment, uniforms) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: vertex, fragmentShader: fragment, uniforms, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(fsGeometry, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, mat, uniforms };
}

const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

export class Post {
  constructor(renderer, { samples = 4 } = {}) {
    this.renderer = renderer;
    this.enabled = true;
    this.effects = true; // false: just the scene and the composite (bench row '- rays/glow')
    this.size = new THREE.Vector2();
    const rt = (w, h) => new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, { samples });
    // three applies fog *after* tone mapping and the sRGB encode, so the fog
    // colours are tuned in display space. Into an ordinary (linear) target the
    // fog would mix before ACES and come out lighter and bluer. Flagged like an
    // XR target, the scene gets tone mapped and encoded here just as on the
    // canvas (stored as plain RGBA8, so nothing decodes it on read): with no
    // rays or glow the composite reproduces the old image.
    this.sceneRT.isXRRenderTarget = true;
    this.sceneRT.texture.colorSpace = THREE.SRGBColorSpace;
    this.sceneRT.texture.internalFormat = 'RGBA8'; // as the MSAA buffer it resolves from (an sRGB format would fail the blit)
    this.qA = rt(2, 2);
    this.qB = rt(2, 2);
    this.gA = rt(2, 2);
    this.gB = rt(2, 2);

    this.sunUv = new THREE.Vector2(0.5, 0.5);
    this.sunScreen = new THREE.Vector3();
    this.dir = new THREE.Vector3();

    // 1. bright pass: rays source (rgb) — bright pixels, weighted toward the sun
    this.bright = pass(/* glsl */ `
      uniform sampler2D tScene;
      uniform vec2 uSunUv;
      uniform float uAspect;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tScene, vUv).rgb;
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        vec2 d = (vUv - uSunUv) * vec2(uAspect, 1.0);
        float nearSun = exp(-dot(d, d) * 1.0);
        float rays = smoothstep(0.62, 0.95, lum) * nearSun;
        gl_FragColor = vec4(c * rays, 1.0);
      }`, { tScene: { value: null }, uSunUv: { value: this.sunUv }, uAspect: { value: 1 } });

    // 2. radial blur toward the sun (run twice with different step lengths)
    this.radial = pass(/* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uSunUv;
      uniform float uStep;
      varying vec2 vUv;
      void main() {
        vec2 delta = (vUv - uSunUv) * uStep / 16.0;
        // start each pixel at a random fraction of a step: smooth shafts instead of 16 ghost copies
        vec3 p3 = fract(vec3(gl_FragCoord.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        vec2 uv = vUv - delta * fract((p3.x + p3.y) * p3.z);
        vec3 sum = vec3(0.0);
        float w = 1.0;
        float total = 0.0;
        for (int i = 0; i < 16; i++) {
          sum += texture2D(tSrc, uv).rgb * w;
          total += w;
          w *= 0.93;
          uv -= delta;
        }
        gl_FragColor = vec4(sum / total, 1.0);
      }`, { tSrc: { value: null }, uSunUv: { value: this.sunUv }, uStep: { value: 0.5 } });

    // 3. glow: highlight extract + separable 9-tap blur (quarter res)
    this.glowExtract = pass(/* glsl */ `
      uniform sampler2D tScene;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tScene, vUv).rgb;
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor = vec4(c * smoothstep(0.82, 1.0, lum), 1.0);
      }`, { tScene: { value: null } });
    this.blur = pass(/* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uDir;
      varying vec2 vUv;
      void main() {
        vec3 s = texture2D(tSrc, vUv).rgb * 0.2270;
        s += (texture2D(tSrc, vUv + uDir * 1.3846).rgb + texture2D(tSrc, vUv - uDir * 1.3846).rgb) * 0.3162;
        s += (texture2D(tSrc, vUv + uDir * 3.2308).rgb + texture2D(tSrc, vUv - uDir * 3.2308).rgb) * 0.0703;
        gl_FragColor = vec4(s, 1.0);
      }`, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });

    // 4. composite
    this.composite = pass(/* glsl */ `
      uniform sampler2D tScene;
      uniform sampler2D tRays;
      uniform sampler2D tGlow;
      uniform float uRays;
      uniform float uSun;
      uniform float uTime;
      uniform vec3 uSunColor;
      varying vec2 vUv;
      float hash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      void main() {
        vec3 s = texture2D(tScene, vUv).rgb; // display space, as the canvas had it
        vec3 add = texture2D(tRays, vUv).rgb * uSunColor * uRays * 1.6 + texture2D(tGlow, vUv).rgb * 0.22;
        s = 1.0 - (1.0 - s) * (1.0 - clamp(add, 0.0, 1.0)); // screen blend: light, never clipped
        float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
        // grade: highlights a little warmer in a sun break, shadows a touch cool (moist air)
        s *= mix(vec3(1.0), vec3(1.03, 1.0, 0.95), smoothstep(0.5, 0.95, l) * uSun);
        s += vec3(-0.004, 0.0, 0.010) * (1.0 - smoothstep(0.0, 0.3, l));
        // soft vignette
        vec2 v = vUv - 0.5;
        s *= 1.0 - 0.2 * smoothstep(0.25, 0.85, dot(v, v) * 2.0);
        // fine grain (also breaks up banding in the fog gradients)
        s += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0 * 2.0;
        gl_FragColor = vec4(s, 1.0);
      }`, {
      tScene: { value: null }, tRays: { value: null }, tGlow: { value: null },
      uRays: { value: 0 }, uSun: { value: 0 }, uTime: { value: 0 },
      uSunColor: { value: SUN_COLOR.clone() },
    });
  }

  resize() {
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    const w = this.size.x;
    const h = this.size.y;
    if (this.sceneRT.width === w && this.sceneRT.height === h) return;
    this.sceneRT.setSize(w, h);
    const qw = Math.max(1, Math.round(w / 4));
    const qh = Math.max(1, Math.round(h / 4));
    for (const t of [this.qA, this.qB, this.gA, this.gB]) t.setSize(qw, qh);
    this.blurTexel = [1 / qw, 1 / qh];
  }

  /** Render the scene with post-processing to the screen (allocation-free). */
  render(scene, camera, forceRays = false) {
    const r = this.renderer;
    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }
    this.resize();
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    // keep renderer.info (perf overlay, bench, budget) about the scene alone;
    // the post passes below add up to 7 full-screen triangles
    const { calls, triangles } = r.info.render;

    // where the sun is on screen, and how much we face it
    camera.getWorldDirection(this.dir);
    const facing = THREE.MathUtils.smoothstep(this.dir.dot(SUN_DIR), 0.1, 0.75);
    this.sunScreen.copy(SUN_DIR).multiplyScalar(500).add(camera.position).project(camera);
    this.sunUv.set(this.sunScreen.x * 0.5 + 0.5, this.sunScreen.y * 0.5 + 0.5);
    const rays = forceRays ? 1 : this.effects ? shared.uSun.value * facing : 0;

    const blit = (p, target) => {
      r.setRenderTarget(target);
      r.render(p.scene, cam);
    };
    if (rays > 0.01) {
      this.bright.uniforms.tScene.value = this.sceneRT.texture;
      this.bright.uniforms.uAspect.value = camera.aspect;
      blit(this.bright, this.qA);
      this.radial.uniforms.tSrc.value = this.qA.texture;
      this.radial.uniforms.uStep.value = 0.7;
      blit(this.radial, this.qB);
      this.radial.uniforms.tSrc.value = this.qB.texture;
      this.radial.uniforms.uStep.value = 0.14;
      blit(this.radial, this.qA);
    }
    // glow
    if (this.effects || forceRays) {
      this.glowExtract.uniforms.tScene.value = this.sceneRT.texture;
      blit(this.glowExtract, this.gA);
      this.blur.uniforms.tSrc.value = this.gA.texture;
      this.blur.uniforms.uDir.value.set(this.blurTexel[0], 0);
      blit(this.blur, this.gB);
      this.blur.uniforms.tSrc.value = this.gB.texture;
      this.blur.uniforms.uDir.value.set(0, this.blurTexel[1]);
      blit(this.blur, this.gA);
    } else {
      r.setRenderTarget(this.gA);
      r.clear(); // black: no glow
    }

    const u = this.composite.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.tRays.value = this.qA.texture;
    u.tGlow.value = this.gA.texture;
    u.uRays.value = rays > 0.01 ? rays : 0;
    u.uSun.value = shared.uSun.value;
    u.uTime.value = shared.uTime.value;
    blit(this.composite, null);
    r.info.render.calls = calls;
    r.info.render.triangles = triangles;
  }

  /** Compile every pass during loading (the rays only run in a sun break). */
  warmUp(scene, camera) {
    if (!this.enabled) return;
    this.render(scene, camera, true);
  }
}
