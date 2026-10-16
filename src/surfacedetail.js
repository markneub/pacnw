import * as THREE from 'three';
import { loadTextureSet } from './textures.js';

/**
 * Close-up surface detail for objects: photographic bark and rock (albedo +
 * normal) on trunks, logs, stumps and boulders near the camera, faded out with
 * distance like the ground detail (grounddetail.js), so far objects look and
 * cost the same as before.
 *
 * The models have no UVs, so the textures are projected three ways
 * (triplanar) in each instance's own space: the pattern sticks to the object
 * (it sways with the tree) and keeps the same size on big and small instances.
 * Vertical trunks get vertical bark furrows; logs lie along X, so they swap X
 * and Y to run the furrows along the log.
 *
 * As with the ground, the photo modulates the existing colour (albedo / its
 * average), so palettes, baked AO, moss and snow cover all keep working.
 *
 * Textures: public/textures/surface/ (tools/fetch_textures.py surface).
 */

// GLB material name -> texture layer
const MATERIAL_LAYER = { Bark: 'bark', CedarBark: 'cedar', SnagBark: 'snag', Rock: 'rock' };

export const surfaceDetail = {
  enabled: false,
  layers: {}, // layer name -> uniforms
  uSDRange: { value: new THREE.Vector2(20, 45) }, // m: full detail inside x, none beyond y
  uSDNormal: { value: 1.1 },
};

export const surfaceLayerFor = (materialName) => MATERIAL_LAYER[materialName] ?? null;

export async function loadSurfaceDetail(renderer, { lowPower }) {
  const layers = await loadTextureSet(renderer, 'surface', { lowPower });
  if (!layers) return false;
  for (const l of layers) {
    surfaceDetail.layers[l.name] = {
      uSDAlb: { value: l.alb },
      uSDNrm: { value: l.nrm },
      uSDAvg: { value: new THREE.Color().setRGB(...l.avg) }, // linear
      uSDTile: { value: 1 / l.tile },
      uSDStrength: { value: l.strength ?? 1 },
    };
  }
  if (lowPower) surfaceDetail.uSDRange.value.set(15, 32);
  surfaceDetail.enabled = true; // materials compile after this (warm-up)
  return true;
}

/**
 * Add surface detail to a material on top of its existing onBeforeCompile
 * patches. The detail only compiles in once loadSurfaceDetail has succeeded.
 */
export function addSurfaceDetail(material, layer, { swapXY = false } = {}) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    patchSurfaceDetail(shader, layer, swapXY);
  };
  material.customProgramCacheKey = () => {
    const on = surfaceDetail.enabled && surfaceDetail.layers[layer];
    return `${prevKey.call(material)}|${on ? `sd:${layer}${swapXY ? 'x' : ''}` : 'sd0'}`;
  };
  return material;
}

function patchSurfaceDetail(shader, layer, swapXY) {
  const u = surfaceDetail.enabled && surfaceDetail.layers[layer];
  if (!u) return;
  Object.assign(shader.uniforms, u, { uSDRange: surfaceDetail.uSDRange, uSDNormal: surfaceDetail.uSDNormal });
  const swz = swapXY ? '.yxz' : ''; // its own inverse
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      varying vec3 vSDPos;
      varying vec3 vSDN;
      varying vec3 vSDWorld;
      varying mat3 vSDToView;`)
    .replace('#include <project_vertex>', `#include <project_vertex>
      {
        #ifdef USE_INSTANCING
          mat4 sdModel = modelMatrix * instanceMatrix;
          mat3 sdInst = mat3(instanceMatrix);
        #else
          mat4 sdModel = modelMatrix;
          mat3 sdInst = mat3(1.0);
        #endif
        vSDPos = transformed${swz} * length(sdInst[0]); // metres, so every instance gets the same texel size
        vSDN = objectNormal${swz};
        vSDWorld = (sdModel * vec4(transformed, 1.0)).xyz;
        vSDToView = normalMatrix * sdInst;
      }`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      uniform sampler2D uSDAlb;
      uniform sampler2D uSDNrm;
      uniform vec3 uSDAvg;
      uniform float uSDTile;
      uniform float uSDStrength;
      uniform vec2 uSDRange;
      uniform float uSDNormal;
      varying vec3 vSDPos;
      varying vec3 vSDN;
      varying vec3 vSDWorld;
      varying mat3 vSDToView;`)
    // after the normal is set up and after every colour patch (moss/snow
    // cover, wetness), so mossy tops get the photo's relief too; lighting
    // hasn't read diffuseColor yet at this point
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        // gradients taken outside the branch so mip selection stays defined
        vec3 p = vSDPos * uSDTile;
        vec3 dx = dFdx(p);
        vec3 dy = dFdy(p);
        float sdFade = 1.0 - smoothstep(uSDRange.x, uSDRange.y, distance(vSDWorld, cameraPosition));
        if (sdFade > 0.001) {
          vec3 sdBase = normalize(vSDN);
          vec3 bw = pow(abs(sdBase), vec3(4.0));
          bw /= dot(bw, vec3(1.0));
          vec3 aX = textureGrad(uSDAlb, p.zy, dx.zy, dy.zy).rgb;
          vec3 aY = textureGrad(uSDAlb, p.xz, dx.xz, dy.xz).rgb;
          vec3 aZ = textureGrad(uSDAlb, p.xy, dx.xy, dy.xy).rgb;
          float sdStrength = uSDStrength;
          #ifdef GROUND_COVER
            // moss and snow lying on top hide most of the rock's own pattern
            sdStrength *= 1.0 - 0.9 * gcMoss - 0.85 * gcSnow;
          #endif
          vec3 detail = mix(vec3(1.0), (aX * bw.x + aY * bw.y + aZ * bw.z) / uSDAvg, sdStrength);
          diffuseColor.rgb *= mix(vec3(1.0), detail, sdFade);
          vec2 nX = textureGrad(uSDNrm, p.zy, dx.zy, dy.zy).xy * 2.0 - 1.0;
          vec2 nY = textureGrad(uSDNrm, p.xz, dx.xz, dy.xz).xy * 2.0 - 1.0;
          vec2 nZ = textureGrad(uSDNrm, p.xy, dx.xy, dy.xy).xy * 2.0 - 1.0;
          vec3 sdOff = (vec3(0.0, nX.y, nX.x) * bw.x + vec3(nY.x, 0.0, nY.y) * bw.y + vec3(nZ.x, nZ.y, 0.0) * bw.z) * uSDNormal;
          vec3 sdN = normalize(vSDToView * (sdBase + sdOff)${swz});
          normal = normalize(mix(normal, sdN, sdFade));
        }
      }`);
}
