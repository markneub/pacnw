import * as THREE from 'three';
import { SNOWLINE } from './config.js';
import { SUN_DIR } from './atmosphere.js';

// Uniforms shared by every patched material, updated once per frame.
export const shared = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uSnowline: { value: SNOWLINE },
  uWet: { value: 1 }, // 0 dry .. 1 soaked: darker, glossier surfaces
  uRain: { value: 1 }, // 0 .. 1 rain falling here (weather.js): rings on the water
  uPuddle: { value: 1 }, // 0 dry .. 1 full: puddles fill in rain and dry slowly after (weather.js)
  uLodRadius: { value: 85 }, // m; full-detail trees inside, far LOD outside
  uLodBand: { value: 12 }, // m either side of uLodRadius over which the tiers crossfade
  uFernRadius: { value: 150 }, // m; ferns only exist inside this radius
  uSun: { value: 0 }, // 0 overcast .. 1 sun break (weather.js)
  uCanopyMap: { value: null }, // R8, 0 open sky .. 1 deep shade (bake.js bakeCanopy)
  uSunMap: { value: null }, // the same at 1 m, barely blurred: sunlight only (bake.js bakeSunMap)
  uCanopyRect: { value: new THREE.Vector4(-1000, -1000, 2000, 2000) }, // minX, minZ, sizeX, sizeZ
};

/**
 * Per-instance level-of-detail switch, decided in the vertex shader so the
 * near pool and the far chunks are exact complements. 'near' draws only
 * instances inside uLodRadius (horizontal distance from the camera), 'far'
 * only those outside. A hidden instance's vertices are moved outside the clip
 * volume, so its triangles are discarded before rasterisation.
 */
export function patchLod(shader, mode) {
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
    patchSunlight(shader);
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
  material.customProgramCacheKey = () => `wind${strength}|${wet}|${lod}|${sunKey()}`;
  return material;
}

/**
 * Moss (below the snowline) or snow (above it) on the upward-facing surfaces
 * of rocks, logs and stumps, driven by world-space normal and altitude.
 * `moss` scales the moss (scanned rocks already have their own); `lod` is the
 * near/far tier for models that have both (see patchLod).
 */
export function addGroundCover(material, { moss = 1, lod = null, snow = 1, film = 0 } = {}) {
  material.onBeforeCompile = (shader) => {
    patchWet(shader, 1);
    patchLod(shader, lod);
    patchSunlight(shader);
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
        `#define GROUND_COVER
        #include <common>
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
        float gcMoss = up * (1.0 - snowy) * ${(0.85 * moss).toFixed(3)}; // read by surfacedetail.js
        float gcSnow = up * snowy * ${snow.toFixed(2)};
        diffuseColor.rgb = mix(diffuseColor.rgb, moss, gcMoss);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.89, 0.94), gcSnow);
        // stone in rain: a film of water, patchy as it runs off, glosses the bare rock (not moss or snow)
        float gcFilm = ${film.toFixed(2)} * smoothstep(0.6, 0.95, uWet) * (1.0 - gcMoss) * (1.0 - gcSnow)
          * smoothstep(0.25, 0.55, 0.5 + 0.35 * sin(vCoverPos.x * 1.7 + sin(vCoverPos.z * 1.3) * 2.0) * sin(vCoverPos.y * 2.1 + vCoverPos.z * 0.9)
                                   + 0.25 * normalize(vCoverNormal).y);
        diffuseColor.rgb *= 1.0 - 0.18 * gcFilm;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.14, gcFilm);`,
      );
  };
  material.customProgramCacheKey = () => `groundcover|${moss}|${lod}|${snow}|${film}|${sunKey()}`;
  return material;
}

/**
 * Moss on tree trunks (valley rainforest): a green sleeve over the base of
 * the trunk with a ragged, patchy upper edge ~1-4 m up, climbing higher on the
 * wet side, plus a little on upward-facing branch tops. Fades out toward the
 * snowline. Chained after the material's own patches. Defines GROUND_COVER /
 * gcMoss like addGroundCover, so the bark photo (surfacedetail.js) fades under it.
 */
export function addTrunkMoss(material) {
  if (!addTrunkMoss.enabled) return material;
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uSnowline = shared.uSnowline;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTmPos;
        varying vec3 vTmNormal;
        varying float vTmHeight;
        varying float vTmAbove;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          mat4 tmModel = modelMatrix;
          #ifdef USE_INSTANCING
            tmModel = modelMatrix * instanceMatrix;
          #endif
          vTmPos = (tmModel * vec4(transformed, 1.0)).xyz;
          vTmNormal = normalize(mat3(tmModel) * objectNormal);
          vTmHeight = vTmPos.y - tmModel[3].y; // metres above the trunk's base
          vTmAbove = vTmHeight - 0.3 * length(tmModel[0].xyz); // above the ground (trees are planted 0.3 m deep)
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#define GROUND_COVER
        #include <common>
        uniform float uSnowline;
        varying vec3 vTmPos;
        varying vec3 vTmNormal;
        varying float vTmHeight;
        varying float vTmAbove;
        float tmDrift = 0.0;
        float tmHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float tmNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(tmHash(i), tmHash(i + vec2(1, 0)), f.x), mix(tmHash(i + vec2(0, 1)), tmHash(i + vec2(1, 1)), f.x), f.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gcSnow = 0.0;
        float gcMoss;
        float tmWet = 0.0;
        {
          vec3 n = normalize(vTmNormal);
          // around the trunk (angle) and up it: patchy, so the edge is ragged
          float around = atan(n.z, n.x);
          vec2 q = vec2(around * 2.2, vTmHeight * 0.9) + vTmPos.xz * 0.37;
          float patchy = tmNoise(q) * 0.65 + tmNoise(q * 3.1 + 5.0) * 0.35;
          float wetSide = 0.5 + 0.5 * dot(n.xz, normalize(vec2(0.55, 0.83))); // south-southwest, the rain side
          float reach = 0.6 + 2.2 * wetSide + 1.4 * patchy;
          float sleeve = 1.0 - smoothstep(reach - 0.9, reach + 0.3, vTmHeight);
          float tops = smoothstep(0.55, 0.9, n.y) * 0.7; // branch tops
          float dry = smoothstep(uSnowline - 45.0, uSnowline - 15.0, vTmPos.y);
          gcMoss = clamp(max(sleeve * smoothstep(0.35, 0.6, patchy + 0.1 * wetSide), tops * smoothstep(0.4, 0.7, patchy)), 0.0, 1.0) * (1.0 - dry) * 0.75;
          vec3 mossCol = mix(vec3(0.03, 0.055, 0.018), vec3(0.075, 0.105, 0.03), tmNoise(vTmPos.xz * 3.0 + vTmHeight * 2.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, mossCol, gcMoss);
          // ground blend (as AAA terrain blending): the bottom of the trunk and its roots take on
          // the damp forest floor's colour, with a ragged edge, so they grow out of the ground
          // instead of standing on it
          float snowy = smoothstep(uSnowline - 10.0, uSnowline + 6.0, vTmPos.y);
          float soil = (1.0 - smoothstep(0.0, 0.5, vTmAbove + (patchy - 0.5) * 0.35)) * (1.0 - snowy);
          vec3 duff = mix(vec3(0.07, 0.052, 0.035), vec3(0.045, 0.06, 0.028), tmNoise(vTmPos.xz * 2.3 + 11.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, duff, soil * 0.85);
          gcMoss = max(gcMoss, soil * 0.85); // the bark photo fades under it too
          // in the snow, a ragged drift banked against the trunk instead (a bare cut line read as
          // a trunk stood on the snow)
          float deep = 0.08 + 0.4 * tmNoise(vec2(around * 1.3, 0.0) + vTmPos.xz * 0.5) + 0.08 * tmNoise(vec2(around * 7.0, vTmHeight * 4.0));
          tmDrift = (1.0 - smoothstep(-0.04, 0.06, vTmAbove - deep)) * snowy;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.95), tmDrift);
          gcSnow = tmDrift;
          // rain runs down the trunks in rivulets: darker, glossy vertical streaks, most on the rain side
          float rivulet = tmNoise(vec2(around * 9.0 + vTmPos.x * 0.7, vTmHeight * 0.22));
          tmWet = smoothstep(0.5, 0.78, rivulet) * (0.35 + 0.65 * wetSide) * uWet * (1.0 - dry) * (1.0 - soil);
          diffuseColor.rgb *= 1.0 - 0.35 * tmWet;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.22, tmWet);`)
      // the drift's surface faces up like the snow it rises from, so it lights the same (after
      // every normal patch, the bark photo's included)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        normal = normalize(mix(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), tmDrift * 0.75));`);
  };
  material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|trunkmoss`;
  return material;
}
addTrunkMoss.enabled = true; // ?off=moss

/**
 * Sun glitter on water (GLSL, for the lake and the streams). The surface is
 * treated as tiny wave facets in world-anchored cells: a facet flashes when its
 * random slope happens to mirror the sun into the eye, which needs a tilt of
 * the half vector away from vertical; the chance of that falls off with the
 * wave slope spread (sigma), so the sparkles gather into the glitter path
 * toward the sun on their own. Each cell re-rolls its facet a few times a
 * second, staggered, so sparkles flash and go. Cells grow with distance in
 * power-of-two steps, blended, so distant glitter doesn't shimmer.
 * glitter(worldPos, toEye, sigma) returns HDR sunlight to add (times uGlSun).
 */
export const GLITTER_GLSL = /* glsl */ `
  uniform float uGlTime;
  uniform float uGlSun;
  float glHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float glLevel(vec2 xz, float cell, float pTilt) {
    vec2 c = floor(xz / cell);
    float phase = glHash(vec3(c, 7.0));
    float t = uGlTime * (3.0 + 4.0 * phase) + phase * 10.0;
    float roll = floor(t);
    float life = fract(t);
    float h = glHash(vec3(c, roll));
    // the facet is a round point somewhere in its cell (a whole lit cell reads as a square)
    vec2 o = vec2(glHash(vec3(c, roll + 0.37)), glHash(vec3(c, roll + 0.71))) * 0.5 + 0.25;
    float d = length(fract(xz / cell) - o);
    // a flash: on when this roll's facet mirrors the sun, brightest mid-life
    return step(h, pTilt) * smoothstep(0.3, 0.05, d) * smoothstep(0.0, 0.25, life) * smoothstep(1.0, 0.55, life);
  }
  float glitter(vec3 wp, vec3 toEye, float sigma) {
    vec3 sun = normalize(vec3(${SUN_DIR.x.toFixed(4)}, ${SUN_DIR.y.toFixed(4)}, ${SUN_DIR.z.toFixed(4)}));
    vec3 hv = normalize(sun + toEye);
    float cosT = max(hv.y, 1e-3);
    float tan2 = (1.0 - cosT * cosT) / (cosT * cosT);
    // chance that a facet tilts that far, times how many facets per cell flash
    float pTilt = exp(-tan2 / (sigma * sigma)) * 0.3;
    float dist = length(wp - cameraPosition);
    float lod = log2(max(dist * 0.004, 0.06) / 0.06);
    float l0 = floor(lod);
    float cell0 = 0.06 * exp2(l0);
    float g = mix(glLevel(wp.xz, cell0, pTilt), glLevel(wp.xz + 17.3, cell0 * 2.0, pTilt), fract(lod));
    // a soft sheen along the glitter path, under the sparkles
    float sheen = pow(max(dot(reflect(-toEye, vec3(0.0, 1.0, 0.0)), sun), 0.0), 60.0) * 0.25;
    return (g * 16.0 + sheen) * uGlSun;
  }
`;
export function patchGlitter(shader) {
  shader.uniforms.uGlTime = shared.uTime;
  shader.uniforms.uGlSun = shared.uSun;
}

/**
 * Puddles (GLSL, for the terrain and the trail tread). The material's own
 * shader declares `float puddle` (0..1 cover, set in its color_fragment) and
 * `vec3 vGroundPos`; this flattens the normal there (plus rain rings while it
 * rains) and swaps the specular for a still-water mirror of the sky, darkened
 * by the canopy above the reflected ray (dark banks for low rays), like the creeks. Direct sunlight
 * glints off it through the material's own roughness (set low in puddles).
 */
const PUDDLE_GLSL = /* glsl */ `
  uniform float uPdTime;
  uniform float uPdRain;
  uniform sampler2D uPdCanopy;
  uniform vec4 uPdCanopyRect;
  float pdHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec2 pdRing(vec2 p, float t) {
    vec2 cell = floor(p);
    vec2 f = fract(p) - 0.5;
    float h = pdHash(cell);
    float ph = fract(t * 0.9 + h * 7.0);
    vec2 c = (vec2(pdHash(cell + 3.1), pdHash(cell + 7.7)) - 0.5) * 0.5;
    vec2 d = f - c;
    float r = length(d) + 1e-4;
    float ring = exp(-pow((r - ph * 0.45) * 22.0, 2.0)) * (1.0 - ph);
    return d / r * ring;
  }
`;
export function patchPuddles(shader) {
  shader.uniforms.uPdTime = shared.uTime;
  shader.uniforms.uPdRain = shared.uRain;
  shader.uniforms.uPdCanopy = shared.uCanopyMap;
  shader.uniforms.uPdCanopyRect = shared.uCanopyRect;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${PUDDLE_GLSL}`)
    // after every normal patch (ground detail included), before lighting
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      if (puddle > 0.0) {
        vec2 rg = (pdRing(vGroundPos.xz * 2.2, uPdTime) + pdRing(vGroundPos.xz * 3.1 + 17.0, uPdTime * 1.13)) * 0.45 * uPdRain;
        vec3 pdN = normalize((viewMatrix * vec4(normalize(vec3(-rg.x, 1.0, -rg.y)), 0.0)).xyz);
        normal = normalize(mix(normal, pdN, smoothstep(0.0, 0.5, puddle)));
      }`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      #ifdef USE_FOG
      if (puddle > 0.0) {
        vec3 pdV = normalize(vViewPosition);
        vec3 pdR = (vec4(reflect(-pdV, normal), 0.0) * viewMatrix).xyz;
        vec3 pdSky = fogColor * (0.85 + 0.3 * smoothstep(0.0, 0.6, pdR.y));
        float pdCanopy = min(1.0, texture2D(uPdCanopy, (vGroundPos.xz + pdR.xz / max(pdR.y, 0.2) * 8.0 - uPdCanopyRect.xy) / uPdCanopyRect.zw).r * 2.2);
        pdSky = mix(pdSky, vec3(0.025, 0.04, 0.03), pdCanopy * 0.85);
        // low reflected rays see the trunks and banks around, not the sky
        vec3 pdBank = mix(vec3(0.02, 0.03, 0.022), fogColor * 0.4, 0.3);
        vec3 pdRefl = mix(pdBank, pdSky, smoothstep(0.0, 0.4, pdR.y));
        float pdFres = 0.02 + 0.8 * pow(1.0 - clamp(dot(normal, pdV), 0.0, 1.0), 5.0);
        reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, pdRefl * pdFres, puddle);
        reflectedLight.indirectDiffuse *= 1.0 - 0.45 * puddle;
      }
      #endif`);
}

/**
 * Sunlight through the canopy, for everything outdoors: the sun's direct light
 * is scaled by how open the canopy is along the line toward the sun (the baked
 * canopy map, sampled where that line crosses the crown layer ~12 m up). In a
 * sun break that becomes dappled light: a world-anchored noise, drifting with
 * the wind, against the local canopy density, so clearings are sunlit, forest
 * interiors are in shade, and light falls through in patches in between. Under
 * overcast it's just a soft darkening. Cheap: one texture fetch and two noise
 * lookups per pixel. Call from a material's onBeforeCompile; `?off=dapple`
 * leaves it out (patchSunlight.enabled = false before materials compile).
 */
const SUN_OFFSET = SUN_DIR.clone().multiplyScalar(12 / SUN_DIR.y); // to the crown layer
const SUNLIGHT_CHUNK = THREE.ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= sunVis;',
);
export function patchSunlight(shader) {
  if (!patchSunlight.enabled || !shared.uCanopyMap.value) return;
  shader.uniforms.uCanopyMap = shared.uSunMap;
  shader.uniforms.uCanopyRect = shared.uCanopyRect;
  shader.uniforms.uSun = shared.uSun;
  shader.uniforms.uTime = shared.uTime;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      #define SUN_VIS
      uniform sampler2D uCanopyMap;
      uniform vec4 uCanopyRect;
      uniform float uSun;
      uniform float uTime;
      float svHash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float svNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(svHash(i), svHash(i + vec2(1, 0)), f.x), mix(svHash(i + vec2(0, 1)), svHash(i + vec2(1, 1)), f.x), f.y);
      }
      float sunVisibility(vec3 wp) {
        // two samples along the ray, through the lower and upper crowns; a low
        // sun's path crosses several crowns, so the (soft, baked) density is scaled up
        vec2 o = vec2(${SUN_OFFSET.x.toFixed(3)}, ${SUN_OFFSET.z.toFixed(3)});
        vec2 q = wp.xz + o * 0.65;
        float c1 = texture2D(uCanopyMap, (q - uCanopyRect.xy) / uCanopyRect.zw).r;
        float c2 = texture2D(uCanopyMap, (wp.xz + o * 1.5 - uCanopyRect.xy) / uCanopyRect.zw).r;
        float c = 1.0 - (1.0 - min(1.0, c1 * 2.4)) * (1.0 - min(1.0, c2 * 2.4));
        vec2 dp = q * 0.45 + vec2(uTime * 0.04, uTime * 0.025);
        float n = svNoise(dp) * 0.6 + svNoise(dp * 2.7 + 7.3) * 0.4;
        float dappled = smoothstep(c - 0.16, c + 0.16, n * 1.15 - 0.08);
        return mix(1.0 - 0.6 * c, dappled, uSun);
      }`)
    .replace('#include <lights_fragment_begin>', `
      float sunVis = 1.0;
      #ifdef USE_FOG
        sunVis = sunVisibility(vFogWorld);
      #endif
      ${SUNLIGHT_CHUNK}`);
}
patchSunlight.enabled = true;
export const sunKey = () => (patchSunlight.enabled && shared.uCanopyMap.value ? 'sv1' : 'sv0');
