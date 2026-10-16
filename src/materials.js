import * as THREE from 'three';
import { SNOWLINE } from './config.js';

// Uniforms shared by every patched material, updated once per frame.
export const shared = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uSnowline: { value: SNOWLINE },
  uWet: { value: 1 }, // 0 dry .. 1 soaked: darker, glossier surfaces
  uLodRadius: { value: 85 }, // m; full-detail trees inside, far LOD outside
  uLodBand: { value: 12 }, // m either side of uLodRadius over which the tiers crossfade
  uFernRadius: { value: 150 }, // m; ferns only exist inside this radius
};

/**
 * Per-instance level-of-detail switch, decided in the vertex shader so the
 * near pool and the far chunks are exact complements. 'near' draws only
 * instances inside uLodRadius (horizontal distance from the camera), 'far'
 * only those outside. A hidden instance's vertices are moved outside the clip
 * volume, so its triangles are discarded before rasterisation.
 */
function patchLod(shader, mode) {
  if (!mode) return;
  if (mode === 'fade') {
    // near-only objects (ferns): shrink into the ground over the last 15% of
    // the radius instead of popping out
    shader.uniforms.uFernRadius = shared.uFernRadius;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFernRadius;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 fadeD = (modelMatrix * instanceMatrix[3]).xz - cameraPosition.xz;
          transformed *= smoothstep(uFernRadius, uFernRadius * 0.85, length(fadeD));
        #endif`);
    return;
  }
  // Crossfade band: across uLodRadius ± uLodBand both tiers are drawn and each
  // pixel belongs to exactly one of them (complementary screen-space dither),
  // so trees dissolve between detail levels instead of snapping. Outside the
  // band the hidden tier is culled in the vertex shader as before.
  shader.uniforms.uLodRadius = shared.uLodRadius;
  shader.uniforms.uLodBand = shared.uLodBand;
  const cull = mode === 'near' ? 'lodDist >= uLodRadius + uLodBand' : 'lodDist < uLodRadius - uLodBand';
  const keep = mode === 'near' ? 'lodDither < vLodFade' : 'lodDither >= vLodFade';
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uLodRadius;\nuniform float uLodBand;\nvarying float vLodFade;')
    .replace('#include <project_vertex>', `#include <project_vertex>
      vLodFade = 1.0;
      #ifdef USE_INSTANCING
        float lodDist = length((modelMatrix * instanceMatrix[3]).xz - cameraPosition.xz);
        // 1 = fully near tier, 0 = fully far tier
        vLodFade = smoothstep(uLodRadius + uLodBand, uLodRadius - uLodBand, lodDist);
        if (${cull}) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
      #endif`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vLodFade;')
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      {
        // interleaved gradient noise: a fine, stable per-pixel threshold
        float lodDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        if (vLodFade < 1.0 && vLodFade > 0.0 && !(${keep})) discard;
      }`);
}

/**
 * GLSL for wet surfaces: water darkens porous materials and makes them
 * smoother, so they pick up sky reflections from the environment map.
 * `strength` scales the effect per material (bark soaks, needles shed water).
 */
export function wetChunks(strength = 1) {
  return {
    color: `diffuseColor.rgb *= mix(1.0, 0.72, uWet * ${strength.toFixed(2)});`,
    roughness: `roughnessFactor *= mix(1.0, 0.5, uWet * ${strength.toFixed(2)});`,
  };
}

function patchWet(shader, strength) {
  const w = wetChunks(strength);
  shader.uniforms.uWet = shared.uWet;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uWet;')
    .replace('#include <color_fragment>', `#include <color_fragment>\n${w.color}`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${w.roughness}`);
}

/**
 * Gentle wind sway for foliage. Displacement grows with height above the
 * instance origin so trunks stay planted. Phase comes from instance position
 * so neighbouring trees don't move in lockstep.
 */
export function addWindSway(material, strength = 0.012, wet = 0.25, lod = null) {
  material.onBeforeCompile = (shader) => {
    patchWet(shader, wet);
    patchLod(shader, lod);
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWind = shared.uWind;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uWind;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 swayPhase = instanceMatrix[3].xz * 0.07;
        #else
          vec2 swayPhase = vec2(0.0);
        #endif
        float swayH = max(transformed.y, 0.0);
        float sway = sin(uTime * 1.3 + swayPhase.x) * 0.7 + sin(uTime * 2.9 + swayPhase.y) * 0.3;
        transformed.x += sway * swayH * swayH * ${strength.toFixed(4)} * 0.05 * uWind;
        transformed.z += cos(uTime * 1.1 + swayPhase.y) * swayH * swayH * ${strength.toFixed(4)} * 0.03 * uWind;`,
      );
  };
  material.customProgramCacheKey = () => `wind${strength}|${wet}|${lod}`;
  return material;
}

/**
 * Moss (below the snowline) or snow (above it) on the upward-facing surfaces
 * of rocks, logs and stumps, driven by world-space normal and altitude.
 */
export function addGroundCover(material) {
  material.onBeforeCompile = (shader) => {
    patchWet(shader, 1);
    shader.uniforms.uSnowline = shared.uSnowline;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vCoverPos;
        varying vec3 vCoverNormal;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        mat4 coverModel = modelMatrix;
        #ifdef USE_INSTANCING
          coverModel = modelMatrix * instanceMatrix;
        #endif
        vCoverPos = (coverModel * vec4(transformed, 1.0)).xyz;
        vCoverNormal = normalize(mat3(coverModel) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uSnowline;
        varying vec3 vCoverPos;
        varying vec3 vCoverNormal;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float up = smoothstep(0.25, 0.75, normalize(vCoverNormal).y);
        float wob = sin(vCoverPos.x * 0.05) * 9.0 + cos(vCoverPos.z * 0.043) * 9.0;
        float snowy = smoothstep(uSnowline - 8.0, uSnowline + 6.0, vCoverPos.y + wob);
        vec3 sp3 = fract(vec3(floor(vCoverPos.xz * 4.0).xyx) * 0.1031);
        sp3 += dot(sp3, sp3.yzx + 33.33);
        float speck = fract((sp3.x + sp3.y) * sp3.z);
        vec3 moss = mix(vec3(0.045, 0.085, 0.02), vec3(0.08, 0.13, 0.03), speck);
        diffuseColor.rgb = mix(diffuseColor.rgb, moss, up * (1.0 - snowy) * 0.85);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.89, 0.94), up * snowy);`,
      );
  };
  material.customProgramCacheKey = () => 'groundcover';
  return material;
}
