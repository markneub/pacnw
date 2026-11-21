import * as THREE from 'three';

// 1-bit mode (the user's, from another project: "Return of the Obra Dinn" style): pure black and
// white, tone drawn as dots that stick to surfaces (surface-stable fractal dithering, after Rune
// Skovbo Johansen), 1-pixel outlines, chunky pixels. The original patched every scene material to
// write the dot bit, a normal and an object id into a second target; this world has dozens of custom
// shaders (grass, water, impostors, the cave...), so here it's one full-screen pass at the end of
// post.js instead: each pixel's surface position comes back from the depth buffer, its normal from
// the neighbouring depths, and its tone from the finished colour image (fog, grade and all).
// Outlines come from depth steps (1/z is linear across any plane, so its second difference is zero
// on flat ground and steps at silhouettes) and sharp turns of the rebuilt normal.

const FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform vec2 uRes;
  uniform float uPix; // view-plane metres per pixel at 1 m: 2 tan(fov/2) / H
  uniform float uD; // dot spacing on screen, render pixels
  uniform float uLift; // tone exponent: < 1 lifts the dark (the cave's torchlight)
  uniform vec3 uDark;
  uniform vec3 uLight;
  varying vec2 vUv;
  layout(location = 0) out highp vec4 outColor; // (GLSL3: three declares no output for us)

  float rank(ivec2 p) {
    float r = 0.0, s = 0.25;
    for (int k = 0; k < 8; k++) {
      int bx = p.x & 1, by = p.y & 1;
      float d = bx == by ? float(bx) : (bx == 1 ? 2.0 : 3.0);
      r += d * s;
      s *= 0.25;
      p >>= 1;
    }
    return r;
  }
  // 1 for a white pixel, 0 for black
  float surf(vec2 uv, float lum, float sigma) {
    bool darkDots = lum > 0.5;
    float cov = darkDots ? 1.0 - lum : lum;
    if (cov < 0.03) return darkDots ? 1.0 : 0.0;
    cov = max(cov, 0.055);
    float l = log2(uD * sigma), L = floor(l), f = l - L, g = exp2(L);
    vec2 q = uv / g, c0 = floor(q), fr = q - c0;
    float t = exp2(-2.0 * f);
    float r = exp2(f) * sqrt(cov / 3.14159) * 1.07;
    float hit = 0.0;
    for (int i = 0; i < 4; i++) {
      vec2 o = vec2(float(i & 1), float(i >> 1));
      float rk = rank(ivec2(c0 + o));
      float w = smoothstep(0.0, 0.3, 1.0 - rk / t);
      if (length(fr - o) < r * w) hit = 1.0;
    }
    return darkDots ? 1.0 - hit : hit;
  }

  bool isSky(float d) { return d > 0.99998; }
  vec3 viewPos(vec2 uv, float d) {
    vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
  }
  // tone: the finished image's luminance (display space already), on a curve
  float tone(vec3 c) {
    float l = pow(dot(c, vec3(0.299, 0.587, 0.114)), uLift);
    return smoothstep(0.0, 1.0, clamp((l - 0.03) / 0.9, 0.0, 1.0));
  }
  vec2 project(vec3 p, vec3 n) {
    vec3 a = abs(n);
    return a.x >= a.y && a.x >= a.z ? p.zy : a.y >= a.z ? p.xz : p.xy;
  }

  void main() {
    vec2 px = 1.0 / uRes;
    float dc = texture2D(tDepth, vUv).r;
    float dr = texture2D(tDepth, vUv + vec2(px.x, 0.0)).r, dl = texture2D(tDepth, vUv - vec2(px.x, 0.0)).r;
    float du = texture2D(tDepth, vUv + vec2(0.0, px.y)).r, dd = texture2D(tDepth, vUv - vec2(0.0, px.y)).r;
    float lum = tone(texture2D(tColor, vUv).rgb);
    float bit;
    bool edge = false;
    if (isSky(dc)) {
      // the sky: dots on a sphere 100 m out (fixed to the world's directions, so they hold still as you turn)
      vec3 dir = normalize(mat3(uCamWorld) * viewPos(vUv, 0.5));
      bit = surf(project(dir * 100.0, dir), lum, 100.0 * uPix);
    } else {
      vec3 pc = viewPos(vUv, dc);
      // the normal from the neighbours, each axis from the side whose depth is nearer (not across a silhouette)
      vec3 pr = viewPos(vUv + vec2(px.x, 0.0), dr), pl = viewPos(vUv - vec2(px.x, 0.0), dl);
      vec3 pu = viewPos(vUv + vec2(0.0, px.y), du), pd = viewPos(vUv - vec2(0.0, px.y), dd);
      vec3 ex = abs(pr.z - pc.z) < abs(pc.z - pl.z) ? pr - pc : pc - pl;
      vec3 ey = abs(pu.z - pc.z) < abs(pc.z - pd.z) ? pu - pc : pc - pd;
      vec3 n = normalize(cross(ex, ey));
      vec3 v = normalize(-pc);
      if (dot(n, v) < 0.0) n = -n;
      vec3 wp = (uCamWorld * vec4(pc, 1.0)).xyz;
      vec3 wn = mat3(uCamWorld) * n;
      float dist = length(pc);
      float sigma = dist * uPix / sqrt(max(abs(dot(n, v)), 0.1));
      bit = surf(project(wp, wn), lum, sigma);
      // outlines: a silhouette against the sky, a step in depth (on the nearer side), a sharp crease
      if (isSky(dr) || isSky(du) || isSky(dl) || isSky(dd)) edge = true;
      else {
        float zc = -1.0 / pc.z, zr = -1.0 / pr.z, zl = -1.0 / pl.z, zu = -1.0 / pu.z, zd = -1.0 / pd.z;
        // (a bigger step needed further off, and none past ~70 m: every needle card and grass blade
        // outlined was a scribble over the whole forest)
        float k = mix(0.06, 0.4, smoothstep(8.0, 60.0, dist));
        // only where the near surface goes on to one side: a 1-pixel sliver with both neighbours behind
        // it (a grass blade, a twig) is drawn already and outlining it buried the meadows in scribble
        bool ex = zl + zr - 2.0 * zc < -k * zc && max(zl, zr) > 0.9 * zc;
        bool ey = zu + zd - 2.0 * zc < -k * zc && max(zu, zd) > 0.9 * zc;
        if (dist < 70.0 && (ex || ey)) edge = true;
      }
    }
    if (edge) {
      // black on bright ground, white on dark
      float l2 = max(lum, max(tone(texture2D(tColor, vUv + vec2(px.x, 0.0)).rgb), tone(texture2D(tColor, vUv + vec2(0.0, px.y)).rgb)));
      bit = l2 > 0.5 ? 0.0 : 1.0;
    }
    outColor = vec4(mix(uDark, uLight, bit), 1.0);
  }`;

/** The pass: a full-screen triangle with the dither material (post.js draws it). */
export function ditherPass() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const uniforms = {
    tColor: { value: null }, tDepth: { value: null },
    uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
    uRes: { value: new THREE.Vector2(1, 1) }, uPix: { value: 0.001 }, uD: { value: 4.5 }, uLift: { value: 1 },
    uDark: { value: new THREE.Vector3(0, 0, 0) }, uLight: { value: new THREE.Vector3(1, 1, 1) },
  };
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, // (bitwise ops)
    uniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, uniforms };
}

/**
 * The switch: a small translucent button under the map icon (and the 1 key), remembered between
 * visits. In 1-bit mode the scene renders at 1/k of the screen's pixels (k = 2 on a 3× phone) and
 * the canvas scales it up unsmoothed, so each rendered pixel is a crisp block.
 */
export class DitherToggle {
  constructor(renderer, post, { onChange } = {}) {
    this.renderer = renderer;
    this.post = post;
    this.onChange = onChange;
    this.savedRatio = renderer.getPixelRatio();
    this.button = document.createElement('button');
    this.button.id = 'dither-icon';
    this.button.setAttribute('aria-label', '1-bit mode');
    this.button.innerHTML = ICON_SVG;
    this.button.classList.add('waiting');
    document.body.appendChild(this.button);
    this.button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.set(!this.on);
    });
    this.button.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', (e) => { if (e.code === 'Digit1') this.set(!this.on); });
    window.addEventListener('resize', () => { if (this.on) this.applyRatio(); });
    this.on = false;
  }

  show() {
    this.button.classList.remove('waiting');
  }

  applyRatio() {
    const dpr = window.devicePixelRatio || 1;
    const k = Math.max(1, Math.round(dpr * 2 / 3));
    this.renderer.setPixelRatio(dpr / k);
  }

  set(on) {
    if (on === this.on) return;
    this.on = on;
    if (on) {
      this.savedRatio = this.renderer.getPixelRatio();
      this.applyRatio();
    } else {
      this.renderer.setPixelRatio(this.savedRatio);
    }
    this.post.dither = on;
    this.renderer.domElement.classList.toggle('pixelated', on);
    this.button.classList.toggle('active', on);
    try { localStorage.setItem('pacnw.dither', on ? '1' : '0'); } catch { /* (private mode) */ }
    this.onChange?.(on);
  }

  /** The remembered choice. */
  static stored() {
    try { return localStorage.getItem('pacnw.dither') === '1'; } catch { return false; }
  }
}

// two overlapping circles, one solid, one of dots
const ICON_SVG = `<svg viewBox="0 0 40 40" fill="none" stroke="#f4efe2" stroke-width="2">
  <circle cx="20" cy="20" r="13"/>
  <path d="M20 7a13 13 0 0 1 0 26z" fill="#f4efe2" stroke="none"/>
  <g fill="#f4efe2" stroke="none">
    <circle cx="13" cy="14" r="1.4"/><circle cx="13" cy="20" r="1.4"/><circle cx="13" cy="26" r="1.4"/>
    <circle cx="16.5" cy="17" r="1.1"/><circle cx="16.5" cy="23" r="1.1"/><circle cx="9.5" cy="17" r="0.9"/><circle cx="9.5" cy="23" r="0.9"/>
  </g></svg>`;
