import * as THREE from 'three';

/**
 * Bare rock on steep ground, decided per pixel (terrain + trail corridor).
 *
 * The terrain's colour lives on its 5 m vertices, so steep slopes used to fade smoothly from
 * green to grey: a felt-covered mound. Here the slope (from the interpolated normal) only sets
 * how *likely* rock is; patchy noise and ledges that follow the contours decide where, with a
 * crisp, ragged outline at pixel scale. Between the outcrops the ground keeps its own colour
 * (moss, litter, alpine meadow). The rock is the ground-detail rock photo at every distance
 * (triplanar, so faces don't smear: the close-up layer near, GD_ROCK_MASK in grounddetail.js,
 * the same photo at the same scale beyond it, plus a 23 m scale against repeats), with tonal
 * drifts, dark water streaks, lichen, moss on its flatter tops and a debris fringe around it.
 * rockFieldAt() is the same field in JS, for the scatter (stones gather below the outcrops).
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
      ${ROCKY_GLSL}
      void main() {`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      {
        #ifdef GROUND_DETAIL
          // (gradients outside the branches below, so the photo's mip levels stay defined)
          vec3 rkDx = dFdx(vRkPos);
          vec3 rkDy = dFdy(vRkPos);
        #endif
        vec3 rn = normalize(vRkN);
        float s = 1.0 - rn.y;
        // not on snow, sand or mud (their layers), nor on a trail's tread
        float allow = (1.0 - smoothstep(0.03, 0.25, vRkLayers.z)) * (1.0 - vRkLayers.w)${tread ? ' * (1.0 - smoothstep(0.05, 0.4, vTread))' : ''};
        #ifdef RK_HOLLOW
          allow *= clamp(2.0 + vHollow, 0.0, 1.0); // the cave's ground patch: aHollow −1 (rock as usual) … −2 (none)
        #endif
        if (s > 0.04 && allow > 0.01) {
          vec2 q = vRkPos.xz;
          float m = rkField(q, vRkPos.y, s);
          rkMask = smoothstep(0.49, 0.53, m) * allow;
          float fringe = smoothstep(0.4, 0.49, m) * (1.0 - rkMask) * allow;
          diffuseColor.rgb *= 1.0 - 0.18 * fringe; // loose debris and shade around the rock
          if (rkMask > 0.0) {
            vec3 p = vRkPos;
            float tone = rkNoise(q * 0.06 + p.y * 0.04) * 0.6 + rkNoise(q * 0.5 + p.y * 0.3) * 0.4;
            vec3 rk = mix(uRkA, uRkB, tone);
            #ifdef GROUND_DETAIL
            {
              // The rock photo at every distance, so far rock looks like near rock: at its close-up
              // scale (uGDTile.y) taking over exactly where the close-up layer fades out, and at 23 m
              // everywhere, so its repeats don't show. Procedural bedding layers and blocks (lit ledge
              // tops, dark undersides) read as terraces beyond the close-up range, then a patchwork:
              // "half and half" (the user).
              vec3 bw = pow(abs(rn), vec3(4.0));
              bw /= bw.x + bw.y + bw.z;
              float farW = smoothstep(uGDRange.x, uGDRange.y, distance(p, cameraPosition));
              vec3 rr = vec3(0.0);
              for (int k = 0; k < 2; k++) {
                float sc = k == 0 ? uGDTile.y : 1.0 / 23.0;
                vec3 pp = p * sc + float(k) * 0.37;
                vec3 dx = rkDx * sc;
                vec3 dy = rkDy * sc;
                vec3 aX = textureGrad(uGDAlb[1], pp.zy, dx.zy, dy.zy).rgb;
                vec3 aY = textureGrad(uGDAlb[1], pp.xz, dx.xz, dy.xz).rgb;
                vec3 aZ = textureGrad(uGDAlb[1], pp.xy, dx.xy, dy.xy).rgb;
                vec3 r = (aX * bw.x + aY * bw.y + aZ * bw.z) / uGDAvg[1];
                r = mix(vec3(dot(r, vec3(0.3, 0.5, 0.2))), r, 0.35); // (as the close-up: grey, not lilac)
                rr = k == 0 ? mix(vec3(1.0), r, uGDStrength.y * farW) : rr * mix(vec3(1.0), r, 0.45);
              }
              rk *= rr;
            }
            #endif
            // dark water streaks running down the faces
            float along = dot(p.xz, normalize(vec2(-rn.z, rn.x) + 1e-4));
            float streak = smoothstep(0.55, 0.85, rkNoise(vec2(along * 1.3, p.y * 0.07))) * smoothstep(0.15, 0.4, s);
            rk *= 1.0 - 0.35 * streak;
            // pale lichen blotches, and moss on the flatter tops
            rk = mix(rk, rk * vec3(1.18, 1.16, 1.02), smoothstep(0.62, 0.8, rkNoise(q * 0.9 + p.y * 0.5)) * 0.6);
            rk = mix(rk, uRkMoss, smoothstep(0.6, 0.85, rn.y) * smoothstep(0.35, 0.7, rkNoise(q * 0.45 + 9.0)) * 0.7);
            diffuseColor.rgb = mix(diffuseColor.rgb, rk * vRkShade, rkMask);
          }
        }
      }`)
;
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
