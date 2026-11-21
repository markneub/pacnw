import * as THREE from 'three';

// Colour depth modes, like the stages of old games' graphics: 1-bit (black and white, "Return of
// the Obra Dinn": the user's dither effect from another project), 2-bit (the Game Boy's four
// greens), 4-bit (EGA's 16 colours: LucasArts' Loom and Monkey Island in EGA), 8-bit (256 colours,
// a VGA-style palette made for this world) and true colour (the game as it is).
//
// All of them draw tone as dots that stick to surfaces (surface-stable fractal dithering, after Rune
// Skovbo Johansen). The original patched every scene material to write the dot bit, a normal and an
// object id into a second target; this world has dozens of custom shaders (grass, water, impostors,
// the cave...), so here it's one full-screen pass at the end of post.js instead: each pixel's
// surface position comes back from the depth buffer, its normal from the neighbouring depths, and
// its colour from the finished image (fog, grade and all). In colour modes a pixel dithers between
// its nearest palette colour A and a second one B (the nearest to 2c − A, the classic trick), with
// B's share of the dots = how far c lies from A toward B. The nearest colour comes from a 32³ lookup
// table built at load. Outlines (1- and 2-bit only) come from depth steps: 1/z is linear across any
// plane, so its second difference is zero on flat ground and steps at silhouettes.

const LUT_N = 32;

const FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler3D;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler3D tLut; // (4- and 8-bit) the nearest palette colour for each cell of RGB
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform vec2 uRes;
  uniform float uPix; // view-plane metres per pixel at 1 m: 2 tan(fov/2) / H
  uniform float uD; // dot spacing on screen, render pixels
  uniform float uLift; // tone exponent: < 1 lifts the dark (the cave's torchlight)
  uniform int uMode; // 1, 2, 4 or 8 bits
  uniform vec2 uGrade; // (4/8-bit) saturation, contrast: a small palette needs the colour pushed (EGA art was bold)
  uniform vec3 uRamp[4]; // 1-bit: black, white; 2-bit: the four shades, dark to light
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
  // 1 for a "light" pixel (about \`lum\` of them), 0 for "dark"
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
  vec3 nearest(vec3 c) {
    return texture(tLut, (clamp(c, 0.0, 1.0) * ${(LUT_N - 1).toFixed(1)} + 0.5) / ${LUT_N.toFixed(1)}).rgb;
  }

  void main() {
    vec2 px = 1.0 / uRes;
    float dc = texture2D(tDepth, vUv).r;
    float dr = texture2D(tDepth, vUv + vec2(px.x, 0.0)).r, dl = texture2D(tDepth, vUv - vec2(px.x, 0.0)).r;
    float du = texture2D(tDepth, vUv + vec2(0.0, px.y)).r, dd = texture2D(tDepth, vUv - vec2(0.0, px.y)).r;
    vec3 col = texture2D(tColor, vUv).rgb;
    if (uMode >= 4) {
      col = pow(max(col, 0.0), vec3(uLift));
      float y = dot(col, vec3(0.299, 0.587, 0.114));
      col = clamp((mix(vec3(y), col, uGrade.x) - 0.5) * uGrade.y + 0.5, 0.0, 1.0);
    }
    // what to dither between: two colours (dark, light) and the share of light dots
    vec3 ca, cb;
    float share;
    float lum = tone(col);
    if (uMode == 1) {
      ca = uRamp[0]; cb = uRamp[1]; share = lum;
    } else if (uMode == 2) {
      float x = lum * 2.999;
      int i = int(floor(x));
      ca = uRamp[i]; cb = uRamp[min(i + 1, 3)]; share = x - float(i);
    } else {
      ca = nearest(col);
      cb = nearest(col * 2.0 - ca);
      vec3 ab = cb - ca;
      float ll = dot(ab, ab);
      share = ll > 1e-6 ? clamp(dot(col - ca, ab) / ll, 0.0, 1.0) : 0.0;
    }
    float bit;
    bool edge = false;
    if (isSky(dc)) {
      // the sky: dots on a sphere 100 m out (fixed to the world's directions, so they hold still as you turn)
      vec3 dir = normalize(mat3(uCamWorld) * viewPos(vUv, 0.5));
      bit = surf(project(dir * 100.0, dir), share, 100.0 * uPix);
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
      bit = surf(project(wp, wn), share, sigma);
      // outlines (1- and 2-bit): a silhouette against the sky, a step in depth (on the nearer side)
      if (uMode <= 2) {
        if (isSky(dr) || isSky(du) || isSky(dl) || isSky(dd)) edge = true;
        else {
          float zc = -1.0 / pc.z, zr = -1.0 / pr.z, zl = -1.0 / pl.z, zu = -1.0 / pu.z, zd = -1.0 / pd.z;
          // (a bigger step needed further off, and none past ~70 m: every needle card and grass blade
          // outlined was a scribble over the whole forest)
          float k = mix(0.06, 0.4, smoothstep(8.0, 60.0, dist));
          // only where the near surface goes on to one side: a 1-pixel sliver with both neighbours behind
          // it (a grass blade, a twig) is drawn already and outlining it buried the meadows in scribble
          bool ex2 = zl + zr - 2.0 * zc < -k * zc && max(zl, zr) > 0.9 * zc;
          bool ey2 = zu + zd - 2.0 * zc < -k * zc && max(zu, zd) > 0.9 * zc;
          if (dist < 70.0 && (ex2 || ey2)) edge = true;
        }
      }
    }
    vec3 o = mix(ca, cb, bit);
    if (edge) {
      // the darkest shade on bright ground, the lightest on dark
      float l2 = max(lum, max(tone(texture2D(tColor, vUv + vec2(px.x, 0.0)).rgb), tone(texture2D(tColor, vUv + vec2(0.0, px.y)).rgb)));
      vec3 lo = uRamp[0], hi = uMode == 1 ? uRamp[1] : uRamp[3];
      o = l2 > 0.5 ? lo : hi;
    }
    outColor = vec4(o, 1.0);
  }`;

const hex = (h) => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];

// 2-bit: the original Game Boy's four greens
const DMG = [0x0f380f, 0x306230, 0x8bac0f, 0x9bbc0f].map(hex);
// 4-bit: the EGA palette (16 fixed colours: Loom, Monkey Island, Indiana Jones and the Last Crusade in EGA)
const EGA = [0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa,
  0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff].map(hex);
// 8-bit: VGA games picked their own 256 colours per scene; this one is for these woods: 16 greys
// and 15 ramps of 16 (dark, mid, light) for the things here
const RAMPS = [
  [0x0a1a0e, 0x2f5a2a, 0xa9c98c], // forest green
  [0x1c2410, 0x6b7d2c, 0xe0e6a0], // grass, yellow-green
  [0x0b1a1a, 0x2e5450, 0xa8c8c0], // fir, blue-green
  [0x1a2208, 0x5a7020, 0xc8d870], // moss
  [0x1a0f08, 0x6a4a30, 0xd8c0a0], // bark, soil
  [0x200c06, 0x7a3a22, 0xe8b090], // cedar, red-brown earth
  [0x2a2418, 0xa89870, 0xfff4dc], // sand, driftwood
  [0x0a1830, 0x3a70b8, 0xe0f0ff], // sky
  [0x141a22, 0x6a7a8a, 0xeef2f6], // fog, overcast
  [0x06201e, 0x2a6a66, 0xc0e8e0], // sea
  [0x20283a, 0x8aa0c0, 0xffffff], // snow in shade
  [0x2a1a04, 0xc09030, 0xfff0b0], // sunlight, gold
  [0x200404, 0xa02020, 0xffc0b0], // red: berries, the lighthouse
  [0x02040c, 0x1a2850, 0x8090d0], // night
  [0x140a1a, 0x5a3a6a, 0xd8c0e8], // heather, dusk
];
function vgaPalette() {
  const out = [];
  for (let i = 0; i < 16; i++) out.push([i / 15, i / 15, i / 15]);
  for (const [a, m, b] of RAMPS.map((r) => r.map(hex))) {
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const [p, q, u] = t < 0.5 ? [a, m, t * 2] : [m, b, t * 2 - 1];
      out.push(p.map((v, k) => v + (q[k] - v) * u));
    }
  }
  return out;
}

/** A 32³ table of the nearest palette colour (weighted RGB, the eye's sensitivity) for each cell. */
function lut(palette) {
  const n = LUT_N;
  const data = new Uint8Array(n * n * n * 4);
  const P = palette.flat();
  const m = palette.length;
  let o = 0;
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const R = r / (n - 1), G = g / (n - 1), B = b / (n - 1);
    let best = 0, bd = Infinity;
    // (in luma + two colour-difference axes, the colour weighted up: by brightness alone, muted
    // greens and blues all went to EGA's greys)
    const Y = 0.299 * R + 0.587 * G + 0.114 * B;
    for (let i = 0; i < m; i++) {
      const y = 0.299 * P[i * 3] + 0.587 * P[i * 3 + 1] + 0.114 * P[i * 3 + 2];
      const dy = Y - y, du = (B - Y) - (P[i * 3 + 2] - y), dv = (R - Y) - (P[i * 3] - y);
      const d = dy * dy + 0.6 * (du * du + dv * dv);
      if (d < bd) { bd = d; best = i; }
    }
    data[o++] = Math.round(P[best * 3] * 255);
    data[o++] = Math.round(P[best * 3 + 1] * 255);
    data[o++] = Math.round(P[best * 3 + 2] * 255);
    data[o++] = 255;
  }
  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Per mode: dot spacing, the two/four shades (1/2-bit), the lookup table (4/8-bit). */
export const MODES = {
  1: { d: 4.5, ramp: [[0, 0, 0], [1, 1, 1], [1, 1, 1], [1, 1, 1]] },
  2: { d: 4.0, ramp: DMG },
  4: { d: 3.0, palette: EGA, grade: [2.2, 1.15] },
  8: { d: 2.5, palette: null, grade: [1.2, 1.05] }, // (vgaPalette(), built with the pass)
};

/** The pass: a full-screen triangle with the dither material (post.js draws it). */
export function ditherPass() {
  MODES[8].palette = vgaPalette();
  for (const k of [4, 8]) MODES[k].lut = lut(MODES[k].palette);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const uniforms = {
    tColor: { value: null }, tDepth: { value: null }, tLut: { value: MODES[4].lut },
    uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
    uRes: { value: new THREE.Vector2(1, 1) }, uPix: { value: 0.001 }, uD: { value: 4.5 }, uLift: { value: 1 },
    uMode: { value: 1 }, uGrade: { value: new THREE.Vector2(1, 1) }, uRamp: { value: MODES[1].ramp.map((c) => new THREE.Vector3(...c)) },
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
  return {
    scene, uniforms,
    /** Switch the pass to 1, 2, 4 or 8 bits. */
    setMode(bits) {
      const m = MODES[bits];
      uniforms.uMode.value = bits;
      uniforms.uD.value = m.d;
      if (m.ramp) m.ramp.forEach((c, i) => uniforms.uRamp.value[i].set(...c));
      if (m.lut) uniforms.tLut.value = m.lut;
      if (m.grade) uniforms.uGrade.value.set(...m.grade);
    },
  };
}

const CHOICES = [
  { bits: 0, label: 'True Color' },
  { bits: 8, label: '8-bit' },
  { bits: 4, label: '4-bit' },
  { bits: 2, label: '2-bit' },
  { bits: 1, label: '1-bit' },
];

/**
 * The picker: a small translucent button under the map icon opens a list of colour depths (the 1
 * key steps through them), remembered between visits. In the dithered modes the scene renders at
 * 1/k of the screen's pixels (k = 2 on a 3× phone) and the canvas scales it up unsmoothed, so each
 * rendered pixel is a crisp block.
 */
export class DitherToggle {
  constructor(renderer, post, { onChange } = {}) {
    this.renderer = renderer;
    this.post = post;
    this.onChange = onChange;
    this.savedRatio = renderer.getPixelRatio();
    this.bits = 0;
    this.button = document.createElement('button');
    this.button.id = 'dither-icon';
    this.button.setAttribute('aria-label', 'Colour depth');
    this.button.innerHTML = ICON_SVG;
    this.button.classList.add('waiting');
    document.body.appendChild(this.button);
    this.menu = document.createElement('div');
    this.menu.id = 'depth-menu';
    this.items = CHOICES.map(({ bits, label }) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.set(bits);
        this.open(false);
      });
      b.addEventListener('click', (e) => e.stopPropagation());
      this.menu.appendChild(b);
      return { bits, el: b };
    });
    document.body.appendChild(this.menu);
    this.button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.open(!this.menu.classList.contains('open'));
    });
    this.button.addEventListener('click', (e) => e.stopPropagation());
    // a touch anywhere else closes it
    document.addEventListener('pointerdown', () => this.open(false));
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Digit1') return;
      const i = CHOICES.findIndex((c) => c.bits === this.bits);
      this.set(CHOICES[(i + 1) % CHOICES.length].bits);
    });
    window.addEventListener('resize', () => { if (this.bits) this.applyRatio(); });
    this.mark();
  }

  show() {
    this.button.classList.remove('waiting');
  }

  open(on) {
    this.menu.classList.toggle('open', on);
    this.button.classList.toggle('active', on || this.bits !== 0);
  }

  mark() {
    for (const { bits, el } of this.items) el.classList.toggle('chosen', bits === this.bits);
  }

  applyRatio() {
    const dpr = window.devicePixelRatio || 1;
    const k = Math.max(1, Math.round(dpr * 2 / 3));
    this.renderer.setPixelRatio(dpr / k);
  }

  /** 0 = true colour, else 1, 2, 4 or 8 bits. */
  set(bits) {
    if (!(bits in MODES)) bits = 0;
    if (bits === this.bits) return;
    const was = this.bits;
    this.bits = bits;
    if (bits && !was) {
      this.savedRatio = this.renderer.getPixelRatio();
      this.applyRatio();
    } else if (!bits && was) {
      this.renderer.setPixelRatio(this.savedRatio);
    }
    if (bits) this.post.ditherP.setMode(bits);
    this.post.dither = bits !== 0;
    this.renderer.domElement.classList.toggle('pixelated', bits !== 0);
    this.button.classList.toggle('active', bits !== 0);
    this.mark();
    try { localStorage.setItem('pacnw.depth', String(bits)); } catch { /* (private mode) */ }
    this.onChange?.(bits);
  }

  /** The remembered choice (0 = true colour). */
  static stored() {
    try {
      const v = localStorage.getItem('pacnw.depth');
      if (v !== null) return parseInt(v, 10) || 0;
      return localStorage.getItem('pacnw.dither') === '1' ? 1 : 0; // (the 1-bit switch before the picker)
    } catch { return 0; }
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
