import * as THREE from 'three';
import { SUN_DIR, SUN_COLOR, FOG_POOL_BASE, FOG_POOL_FALLOFF } from './atmosphere.js';
import { shared } from './materials.js';

/**
 * Post-processing: the scene renders into a target that holds exactly what the
 * canvas used to (tone mapped, sRGB: see the constructor for why), then
 *  1. bright pass (quarter res): sky and sunlit haze near the sun, plus a
 *     general highlight extract for the glow
 *  2. light shafts: (a) volumetric: march each view ray through the mist (the
 *     fog's own density: valley pooling + drifting banks) and add sunlight
 *     scattered toward the eye wherever the canopy lets the sun through (the
 *     same canopy map and dapple noise as the sunflecks on the ground, so each
 *     shaft lands on its fleck); (b) a gentle radial blur of the bright sky
 *     toward the sun for the glare around it
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
    this.volStrength = 2.0; // light in the mist (before the saturation curve in the composite)
    this.size = new THREE.Vector2();
    const rt = (w, h) => new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, { samples, depthTexture: new THREE.DepthTexture(4, 4) });
    // three applies fog *after* tone mapping and the sRGB encode, so the fog
    // colours are tuned in display space. Into an ordinary (linear) target the
    // fog would mix before ACES and come out lighter and bluer. Flagged like an
    // XR target, the scene gets tone mapped and encoded here just as on the
    // canvas (stored as plain RGBA8, so nothing decodes it on read): with no
    // rays or glow the composite reproduces the old image.
    this.sceneRT.isXRRenderTarget = true;
    this.sceneRT.texture.colorSpace = THREE.SRGBColorSpace;
    this.sceneRT.texture.internalFormat = 'RGBA8'; // as the MSAA buffer it resolves from (an sRGB format would fail the blit)
    // volumetric light (quarter res, half float: lit mist toward the sun goes above 1),
    // its blur, and a ping-pong history for temporal accumulation
    const rtF = (w, h) => new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, type: THREE.HalfFloatType });
    this.vA = rtF(2, 2);
    this.vB = rtF(2, 2);
    this.hist = [rtF(2, 2), rtF(2, 2)];
    this.histValid = false;
    this.prevViewProj = new THREE.Matrix4();
    this.prevCamPos = new THREE.Vector3();

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
      uniform vec2 uTexel; // full-res texel
      varying vec2 vUv;
      void main() {
        // a 4x4 box (4 bilinear taps) per quarter-res pixel: one tap shimmered at leaf edges as you walk
        vec3 c = 0.25 * (texture2D(tScene, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tScene, vUv + uTexel * vec2(1.0, -1.0)).rgb
          + texture2D(tScene, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tScene, vUv + uTexel * vec2(1.0, 1.0)).rgb);
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        vec2 d = (vUv - uSunUv) * vec2(uAspect, 1.0);
        float nearSun = exp(-dot(d, d) * 1.0);
        float rays = smoothstep(0.62, 0.95, lum) * nearSun;
        gl_FragColor = vec4(c * rays, 1.0);
      }`, { tScene: { value: null }, uSunUv: { value: this.sunUv }, uAspect: { value: 1 }, uTexel: { value: new THREE.Vector2() } });

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

    // 2a. volumetric light in the mist (quarter res)
    const sunXZ = new THREE.Vector2(SUN_DIR.x / SUN_DIR.y, SUN_DIR.z / SUN_DIR.y); // horizontal drift per metre of climb
    this.volume = pass(/* glsl */ `
      uniform sampler2D tDepth;
      uniform mat4 uInvProj;
      uniform mat4 uCamWorld;
      uniform vec3 uCamPos;
      uniform sampler2D uCanopyMap;
      uniform vec4 uCanopyRect;
      uniform sampler2D uGround;
      uniform vec4 uGroundGrid; // min x, min z, size, -
      uniform float uDensity;   // the fog's base density
      uniform float uTime;
      uniform float uSun;
      uniform float uFrame;
      varying vec2 vUv;
      const vec2 SUN_XZ = vec2(${sunXZ.x.toFixed(4)}, ${sunXZ.y.toFixed(4)});
      const vec3 SUN = vec3(${SUN_DIR.x.toFixed(4)}, ${SUN_DIR.y.toFixed(4)}, ${SUN_DIR.z.toFixed(4)});
      float vHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vNoise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(vHash(i), vHash(i + vec2(1, 0)), f.x), mix(vHash(i + vec2(0, 1)), vHash(i + vec2(1, 1)), f.x), f.y);
      }
      float canopy(vec2 xz) { return texture2D(uCanopyMap, (xz - uCanopyRect.xy) / uCanopyRect.zw).r; }
      // is this point in the air sunlit? Same samples as the ground's dappled light
      // (materials.js sunVisibility), shifted by its height: the ray to the sun
      // crosses the crowns at the same spots as for the fleck it lands on.
      float sunlit(vec3 p, float above) {
        vec2 q = p.xz + SUN_XZ * max(0.0, 7.8 - above);
        float c1 = canopy(q);
        float c2 = canopy(p.xz + SUN_XZ * max(0.0, 18.0 - above));
        float c = 1.0 - (1.0 - min(1.0, c1 * 2.4)) * (1.0 - min(1.0, c2 * 2.4));
        vec2 dp = q * 0.45 + vec2(uTime * 0.04, uTime * 0.025);
        float n = vNoise(dp) * 0.6 + vNoise(dp * 2.7 + 7.3) * 0.4;
        return smoothstep(c - 0.07, c + 0.07, n * 1.15 - 0.08); // crisper than the ground's: beams have edges
      }
      void main() {
        float depth = texture2D(tDepth, vUv).r;
        vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec3 viewPos = vp.xyz / vp.w;
        float dist = depth >= 1.0 ? 1e4 : length(viewPos);
        vec3 dir = normalize((uCamWorld * vec4(viewPos, 0.0)).xyz);
        float maxD = min(dist, 55.0);
        const int N = 16;
        float stepLen = maxD / float(N);
        // interleaved gradient noise, rotating per frame: the blur and the eye average it out
        float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uFrame * 5.588238, vec2(0.06711056, 0.00583715))));
        float light = 0.0;
        float trans = 1.0;
        for (int i = 0; i < N; i++) {
          vec3 p = uCamPos + dir * ((float(i) + jit) * stepLen);
          float ground = texture2D(uGround, (p.xz - uGroundGrid.xy) / uGroundGrid.z).r;
          float above = p.y - ground;
          // the fog's density (atmosphere.js): pooled low in the valleys, in drifting banks
          float pool = exp(-max(p.y - ${FOG_POOL_BASE}, 0.0) / ${FOG_POOL_FALLOFF});
          vec2 fp = p.xz * 0.018 + vec2(uTime * 0.011, uTime * 0.004);
          float bank = vNoise(fp) * 0.65 + vNoise(fp * 2.7 + 13.1) * 0.35;
          float d = uDensity * (0.8 + 0.8 * pool) * (0.6 + 0.8 * bank) * (above > 0.0 ? 1.0 : 0.0);
          // mist hugs the ground: denser in the lowest few metres
          d *= 1.0 + 1.2 * exp(-max(above, 0.0) / 4.0);
          light += trans * d * stepLen * sunlit(p, above);
          trans *= exp(-d * stepLen);
        }
        // forward scattering: bright looking toward the sun, faint across it
        float mu = max(dot(dir, SUN), 0.0);
        float phase = 0.25 + 1.1 * pow(mu, 5.0) + 0.9 * pow(mu, 24.0);
        gl_FragColor = vec4(vec3(light * phase * uSun), 1.0);
      }`, {
      tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() }, uCanopyMap: shared.uCanopyMap, uCanopyRect: shared.uCanopyRect,
      uGround: { value: null }, uGroundGrid: { value: new THREE.Vector4() }, uDensity: { value: 0.01 },
      uTime: { value: 0 }, uSun: { value: 0 }, uFrame: { value: 0 },
    });

    // 2b. temporal accumulation of the mist light: reproject last frame's result
    // (by this pixel's depth) and blend a little of the new, noisy frame in;
    // clamped to the new frame's neighbourhood so moving edges don't ghost
    this.resolve = pass(/* glsl */ `
      uniform sampler2D tCur;
      uniform sampler2D tHist;
      uniform sampler2D tDepth;
      uniform mat4 uInvProj;
      uniform mat4 uCamWorld;
      uniform mat4 uPrevViewProj;
      uniform vec2 uTexel; // quarter-res texel
      uniform float uBlend; // share of the new frame (1 = no history)
      varying vec2 vUv;
      void main() {
        vec3 cur = texture2D(tCur, vUv).rgb;
        vec3 lo = cur, hi = cur;
        for (int k = 0; k < 4; k++) {
          vec2 o = vec2(k == 0 ? 1.0 : k == 1 ? -1.0 : 0.0, k == 2 ? 1.0 : k == 3 ? -1.0 : 0.0) * uTexel;
          vec3 n = texture2D(tCur, vUv + o).rgb;
          lo = min(lo, n);
          hi = max(hi, n);
        }
        // a little slack: the input is noisy by design
        vec3 pad = (hi - lo) * 0.5 + 0.02;
        lo -= pad;
        hi += pad;
        float depth = texture2D(tDepth, vUv).r;
        vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, min(depth, 0.9999) * 2.0 - 1.0, 1.0);
        vec4 world = uCamWorld * vec4(vp.xyz / vp.w, 1.0);
        vec4 prev = uPrevViewProj * world;
        vec2 puv = prev.xy / prev.w * 0.5 + 0.5;
        float inside = step(0.0, puv.x) * step(puv.x, 1.0) * step(0.0, puv.y) * step(puv.y, 1.0) * step(0.0, prev.w);
        vec3 hist = clamp(texture2D(tHist, puv).rgb, lo, hi);
        gl_FragColor = vec4(mix(cur, hist, (1.0 - uBlend) * inside), 1.0);
      }`, {
      tCur: { value: null }, tHist: { value: null }, tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() }, uBlend: { value: 1 },
    });

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
      uniform sampler2D tVol;
      uniform float uVol;
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
        vec3 add = texture2D(tRays, vUv).rgb * uSunColor * uRays * 0.8 + texture2D(tGlow, vUv).rgb * 0.22
          // mist light saturates (an open, sunlit clearing toward the sun added up to white);
          // shafts read by contrast with the shade around them, not by raw brightness
          + (1.0 - exp(-texture2D(tVol, vUv).rgb * uVol)) * uSunColor * 0.55;
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
      tScene: { value: null }, tRays: { value: null }, tGlow: { value: null }, tVol: { value: null }, uVol: { value: 0 },
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
    for (const t of [this.qA, this.qB, this.gA, this.gB, this.vA, this.vB, ...this.hist]) t.setSize(qw, qh);
    this.resolve.uniforms.uTexel.value.set(1 / qw, 1 / qh);
    this.bright.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.histValid = false;
    this.blurTexel = [1 / qw, 1 / qh];
  }

  /** Render the scene with post-processing to the screen (allocation-free). */
  render(scene, camera, forceRays = false) {
    const r = this.renderer;
    if (!this.enabled) {
      this.histValid = false;
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
    // light in the mist: only in a sun break, from any direction (strongest toward the sun)
    const sun = forceRays ? 1 : this.effects && this.volume.uniforms.uGround.value ? shared.uSun.value : 0;
    if (sun > 0.01) {
      const v = this.volume.uniforms;
      v.tDepth.value = this.sceneRT.depthTexture;
      v.uInvProj.value.copy(camera.projectionMatrixInverse);
      v.uCamWorld.value.copy(camera.matrixWorld);
      v.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      const fog = scene.fog;
      v.uDensity.value = fog ? fog.near % 1 : 0.01; // see installHeightFog: fract = density
      v.uTime.value = fog ? fog.far : 0;
      v.uSun.value = sun;
      v.uFrame.value = (v.uFrame.value + 1) % 64;
      blit(this.volume, this.vA);
      // accumulate over frames (the per-frame jitter averages out instead of shimmering)
      const camPos = v.uCamPos.value;
      const jumped = !this.histValid || camPos.distanceTo(this.prevCamPos) > 4;
      const rs = this.resolve.uniforms;
      rs.tCur.value = this.vA.texture;
      rs.tHist.value = this.hist[0].texture;
      rs.tDepth.value = this.sceneRT.depthTexture;
      rs.uInvProj.value.copy(camera.projectionMatrixInverse);
      rs.uCamWorld.value.copy(camera.matrixWorld);
      rs.uPrevViewProj.value.copy(this.prevViewProj);
      rs.uBlend.value = jumped ? 1 : 0.15;
      blit(this.resolve, this.hist[1]);
      this.hist.reverse(); // hist[0] is now this frame's result
      this.histValid = true;
      this.blur.uniforms.tSrc.value = this.hist[0].texture;
      this.blur.uniforms.uDir.value.set(this.blurTexel[0] * 0.75, 0);
      blit(this.blur, this.vB);
      this.blur.uniforms.tSrc.value = this.vB.texture;
      this.blur.uniforms.uDir.value.set(0, this.blurTexel[1] * 0.75);
      blit(this.blur, this.vA);
      this.prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.prevCamPos.copy(camPos);
    } else {
      this.histValid = false;
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
    u.tVol.value = this.vA.texture;
    u.uVol.value = sun > 0.01 ? this.volStrength : 0;
    u.uRays.value = rays > 0.01 ? rays : 0;
    u.uSun.value = shared.uSun.value;
    u.uTime.value = shared.uTime.value;
    blit(this.composite, null);
    r.info.render.calls = calls;
    r.info.render.triangles = triangles;
  }

  /**
   * The terrain's height grid (heights[iz * n + ix], `step` m apart from the world's
   * min corner), so the mist pass knows how high above the ground each point is.
   * Half-float so it can be linearly filtered everywhere.
   */
  setGround(heights, n, step, min) {
    const data = new Uint16Array(n * n);
    for (let i = 0; i < n * n; i++) data[i] = THREE.DataUtils.toHalfFloat(heights[i]);
    const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.volume.uniforms.uGround.value = tex;
    // texel centres sit on the grid points
    this.volume.uniforms.uGroundGrid.value.set(min - step / 2, min - step / 2, n * step, 0);
  }

  /** Compile every pass during loading (the rays only run in a sun break). */
  warmUp(scene, camera) {
    if (!this.enabled) return;
    this.render(scene, camera, true);
  }
}
