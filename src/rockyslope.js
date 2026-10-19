import * as THREE from 'three';

/**
 * Bare rock on steep ground, decided per pixel (terrain + trail corridor).
 *
 * The terrain's colour lives on its 5 m vertices, so steep slopes used to fade smoothly from
 * green to grey: a felt-covered mound. Here the slope (from the interpolated normal) only sets
 * how *likely* rock is; patchy noise and ledges that follow the contours decide where, with a
 * crisp, ragged outline at pixel scale. Between the outcrops the ground keeps its own colour
 * (moss, litter, alpine meadow). The rock gets jointed, bedded colour, lichen and moss on its
 * flatter tops, a debris fringe around it, and a bump in its lighting (triplanar, so faces
 * don't smear). Within the ground-detail range the rock photo takes over (GD_ROCK_MASK in
 * grounddetail.js). rockMaskAt() is the same mask in JS, for the scatter (stones gather below
 * the outcrops).
 *
 * Gentle ground (slope < 0.04) skips all of it in one branch.
 */

const ROCK_A = new THREE.Color(0x77756e); // weathered grey
const ROCK_B = new THREE.Color(0x58534b); // darker, browner
const ROCK_MOSS = new THREE.Color(0x56602f);

export const ROCKY_GLSL = /* glsl */ `
  float rkHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float rkNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = p - i;
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(rkHash(i), rkHash(i + vec2(1.0, 0.0)), f.x), mix(rkHash(i + vec2(0.0, 1.0)), rkHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // > 0.5: bare rock. s = slope (1 - normal.y)
  float rkField(vec2 q, float y, float s) {
    float likely = smoothstep(0.04, 0.3, s);
    float big = rkNoise(q * 0.04) * 0.35 + rkNoise(q * 0.12 + 7.1) * 0.4 + rkNoise(q * 0.4 + 3.3) * 0.25;
    // ledges: bands along the contours (heights warped by noise), the rock breaking out along them
    float band = abs(fract(y * 0.3 + rkNoise(q * 0.03 + 1.7) * 2.0) - 0.5) * 2.0;
    return likely * 1.3 + (big - 0.5) * 1.3 - 0.2 * band - 0.12;
  }
  // Fractured rock on one plane: cellular noise, blocks a little wider than tall (bedding).
  // x: how close to a crack (0 on it), y: the block's id (0..1), zw: the block face's tilt
  vec4 rkBlocks(vec2 p) {
    vec2 i = floor(p);
    vec2 f = p - i;
    float d1 = 9.0;
    float d2 = 9.0;
    vec2 c1 = vec2(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 r = g + vec2(rkHash(i + g), rkHash(i + g + 19.19)) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; c1 = i + g; } else if (d < d2) d2 = d;
      }
    }
    float id = rkHash(c1 + 7.3);
    return vec4(sqrt(d2) - sqrt(d1), id, rkHash(c1 + 2.9) - 0.5, rkHash(c1 + 5.7) - 0.5);
  }
  // Rock on a face: bedding layers (wavy, uneven thickness) cut by joints, staggered from layer
  // to layer, so it breaks into blocks the way a cliff does. p.x along the face, p.y up (m).
  // x: metres to the nearest crack, y: block id, z: height within its layer (0 bottom .. 1 top)
  vec4 rkStrata(vec2 p) {
    float v = p.y + (rkNoise(vec2(p.x * 0.06, 3.1)) - 0.5) * 4.0 + (rkNoise(vec2(p.x * 0.25, 8.3)) - 0.5) * 0.8;
    // layers ~1-6 m thick (the warp's slope stays below the base rate, so it never folds back)
    float rate = 0.6 + 1.2 * 0.25 * (rkNoise(vec2(v * 0.25 + 0.01, 0.5)) - rkNoise(vec2(v * 0.25 - 0.01, 0.5))) / 0.02;
    float lv = v * 0.6 + 1.2 * rkNoise(vec2(v * 0.25, 0.5));
    float L = floor(lv);
    float fy = lv - L;
    // joints ~1.5-18 m apart, shifted from layer to layer
    float u0 = p.x * 0.35 + rkHash(vec2(L, 1.7)) * 17.0;
    float u = u0 + 0.8 * rkNoise(vec2(u0 * 0.7, L + 0.5));
    float J = floor(u);
    float fx = u - J;
    // metres to the nearest crack; joints and bedding planes come and go along their length
    float bedGap = min(fy, 1.0 - fy) / max(rate, 0.15) + 0.12 * smoothstep(0.45, 0.6, rkNoise(vec2(p.x * 0.4, L * 2.1)));
    float jointGap = min(fx, 1.0 - fx) / 0.35 + 0.12 * smoothstep(0.4, 0.6, rkNoise(vec2(p.y * 0.5, J * 1.7)));
    return vec4(min(bedGap, jointGap), rkHash(vec2(L, J) + 7.3), fy, rkHash(vec2(L, J) + 2.9) - 0.5);
  }
`;

const ROCKY_UNIFORMS = {
  uRkA: { value: ROCK_A },
  uRkB: { value: ROCK_B },
  uRkMoss: { value: ROCK_MOSS },
};

/**
 * Patch a ground material (terrain or corridor). Call it after patchGroundDetail, so the rock
 * decides the colour (and the detail layer) before the photo is applied.
 * `tread`: the corridor, whose level tread (vTread) never shows rock.
 */
export function patchRocky(shader, { tread = false } = {}) {
  Object.assign(shader.uniforms, ROCKY_UNIFORMS);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      #ifndef GROUND_DETAIL
        attribute vec4 aLayers;
      #endif
      attribute float aShade;
      varying vec4 vRkLayers;
      varying vec3 vRkPos;
      varying vec3 vRkN;
      varying float vRkShade;`)
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vRkLayers = aLayers;
      vRkPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vRkN = normalize(mat3(modelMatrix) * objectNormal);
      vRkShade = aShade;`);
  shader.fragmentShader = `#define GD_ROCK_MASK\n${shader.fragmentShader}`
    .replace('void main() {', `
      uniform vec3 uRkA;
      uniform vec3 uRkB;
      uniform vec3 uRkMoss;
      varying vec4 vRkLayers;
      varying vec3 vRkPos;
      varying vec3 vRkN;
      varying float vRkShade;
      float rkMask = 0.0; // bare rock here (0..1): the detail layer and the grass tint read it
      vec3 rkBump = vec3(0.0); // world-space normal perturbation on the rock
      ${ROCKY_GLSL}
      void main() {`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec3 rn = normalize(vRkN);
        float s = 1.0 - rn.y;
        // not on snow, sand or mud (their layers), nor on a trail's tread
        float allow = (1.0 - smoothstep(0.03, 0.25, vRkLayers.z)) * (1.0 - vRkLayers.w)${tread ? ' * (1.0 - smoothstep(0.05, 0.4, vTread))' : ''};
        if (s > 0.04 && allow > 0.01) {
          vec2 q = vRkPos.xz;
          float m = rkField(q, vRkPos.y, s);
          rkMask = smoothstep(0.49, 0.53, m) * allow;
          float fringe = smoothstep(0.4, 0.49, m) * (1.0 - rkMask) * allow;
          diffuseColor.rgb *= 1.0 - 0.18 * fringe; // loose debris and shade around the rock
          if (rkMask > 0.0) {
            vec3 p = vRkPos;
            // the planes the rock is projected on, sharply blended (weaker ones skipped)
            vec3 tw = pow(abs(rn), vec3(4.0));
            tw /= tw.x + tw.y + tw.z;
            float far = 1.0 - smoothstep(110.0, 240.0, distance(p, cameraPosition)); // (cracks would shimmer)
            // faces: strata on the two vertical planes; gentler slabs seen from above: cellular cracks
            float crack = 0.0;
            float id = 0.0;
            float step_ = 0.0; // dark under each ledge, lit along its top
            vec3 tilt = vec3(0.0);
            if (tw.z > 0.05) {
              vec4 b = rkStrata(p.xy);
              crack += (1.0 - smoothstep(0.03, 0.1, b.x)) * tw.z; id += b.y * tw.z; step_ += (b.z - 0.5) * tw.z;
              tilt += vec3(b.w, b.z - 0.4, 0.0) * tw.z;
            }
            if (tw.x > 0.05) {
              vec4 b = rkStrata(p.zy + vec2(31.0, 0.0));
              crack += (1.0 - smoothstep(0.03, 0.1, b.x)) * tw.x; id += b.y * tw.x; step_ += (b.z - 0.5) * tw.x;
              tilt += vec3(0.0, b.z - 0.4, b.w) * tw.x;
            }
            if (tw.y > 0.05) {
              vec4 b = rkBlocks(p.xz * 0.38 + 57.0);
              crack += (1.0 - smoothstep(0.0, 0.07, b.x)) * 0.6 * tw.y; id += b.y * 0.6 * tw.y;
              tilt += vec3(b.z, 0.0, b.w) * 0.25 * tw.y;
            }
            crack *= far;
            // each block its own shade of grey, broad tonal drifts across the face
            float tone = id * 0.45 + rkNoise(q * 0.06 + p.y * 0.04) * 0.35 + rkNoise(q * 0.5 + p.y * 0.3) * 0.2;
            vec3 rk = mix(uRkA, uRkB, tone);
            rk *= (1.0 - 0.45 * crack) * (1.0 + 0.15 * step_ * far);
            // dark water streaks running down the faces
            float along = dot(p.xz, normalize(vec2(-rn.z, rn.x) + 1e-4));
            float streak = smoothstep(0.55, 0.85, rkNoise(vec2(along * 1.3, p.y * 0.07))) * smoothstep(0.15, 0.4, s);
            rk *= 1.0 - 0.35 * streak;
            // pale lichen blotches, and moss on the flatter tops
            rk = mix(rk, rk * vec3(1.18, 1.16, 1.02), smoothstep(0.62, 0.8, rkNoise(q * 0.9 + p.y * 0.5)) * 0.6);
            rk = mix(rk, uRkMoss, smoothstep(0.6, 0.85, rn.y) * smoothstep(0.35, 0.7, rkNoise(q * 0.45 + 9.0)) * 0.7);
            diffuseColor.rgb = mix(diffuseColor.rgb, rk * vRkShade, rkMask);
            // relief: every block faces a little differently, ledge tops tilt up
            vec3 g = tilt * 0.8 * far;
            g -= rn * dot(g, rn); // along the surface only
            rkBump = g * rkMask;
          }
        }
      }`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      if (rkMask > 0.0) normal = normalize(normal + (viewMatrix * vec4(rkBump, 0.0)).xyz);`);
}

// ---- the same field in JS (scatter) -------------------------------------------------------

const fract = (v) => v - Math.floor(v);
function hash(px, py) {
  let x = fract(px * 0.1031);
  let y = fract(py * 0.1031);
  let z = fract(px * 0.1031);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d; y += d; z += d;
  return fract((x + y) * z);
}
export function valueNoise(px, py) {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  let fx = px - ix;
  let fy = py - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * fx;
  const b = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * fx;
  return a + (b - a) * fy;
}
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The rock field's value at a point (> 0.5 bare rock), as the shader computes it. */
export function rockFieldAt(x, y, z, slope) {
  if (slope <= 0.04) return -1; // (the shader skips gentle ground)
  const likely = smooth(0.04, 0.3, slope);
  const big = valueNoise(x * 0.04, z * 0.04) * 0.35 + valueNoise(x * 0.12 + 7.1, z * 0.12 + 7.1) * 0.4 + valueNoise(x * 0.4 + 3.3, z * 0.4 + 3.3) * 0.25;
  const band = Math.abs(fract(y * 0.3 + valueNoise(x * 0.03 + 1.7, z * 0.03 + 1.7) * 2) - 0.5) * 2;
  return likely * 1.3 + (big - 0.5) * 1.3 - 0.2 * band - 0.12;
}
