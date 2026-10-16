import * as THREE from 'three';

/**
 * Close-up ground detail: photographic albedo + normal textures blended onto
 * the terrain and trail near the camera, faded out with distance so the far
 * ground (and its cost) is unchanged.
 *
 * Four layers, matching the per-vertex `aLayers` weights built in terrain.js /
 * trail.js: [0] forest floor, [1] rock, [2] snow, [3] mud/dirt.
 *
 * The photo modulates the existing ground colour (albedo / its average), so the
 * painted palette and all baked shading (AO, canopy) keep working and there's
 * no colour shift where the detail fades out. Rock is projected three ways
 * (triplanar) so it doesn't smear on cliffs; the others are projected from above.
 *
 * Textures live in public/textures/ground/ with a manifest.json written by
 * tools/fetch_ground_textures.py. If the manifest is missing, the feature stays
 * off and the ground renders exactly as before.
 */

export const groundDetail = {
  enabled: false,
  uniforms: {
    uGDAlb: { value: [null, null, null, null] },
    uGDNrm: { value: [null, null, null, null] },
    uGDAvg: { value: [new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1)] },
    uGDTile: { value: new THREE.Vector4(0.5, 0.25, 0.33, 0.6) }, // 1 / tile size (m)
    uGDRange: { value: new THREE.Vector2(20, 45) }, // m: full detail inside x, none beyond y
    uGDNormal: { value: 0.8 },
    uGDStrength: { value: new THREE.Vector4(1, 1, 1, 1) }, // per-layer detail contrast
  },
};

/** Program cache key for ground materials, so toggling detail recompiles them. */
export const groundDetailCacheKey = () => (groundDetail.enabled ? 'gd1' : 'gd0');

/** Load the textures if they've been fetched; returns true when detail is available. */
export async function loadGroundDetail(renderer, { lowPower }) {
  const base = `${import.meta.env.BASE_URL}textures/ground/`;
  let manifest;
  try {
    const res = await fetch(`${base}manifest.json`);
    if (!res.ok) return false;
    manifest = await res.json();
  } catch {
    return false;
  }
  const size = lowPower ? 512 : 1024;
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), lowPower ? 4 : 8);
  const load = async (file, srgb) => {
    const tex = await loader.loadAsync(base + file);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = aniso;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return tex;
  };

  const u = groundDetail.uniforms;
  await Promise.all(manifest.layers.map(async (layer, i) => {
    const [alb, nrm] = await Promise.all([
      load(`${layer.name}_${size}_albedo.jpg`, true),
      load(`${layer.name}_${size}_normal.jpg`, false),
    ]);
    u.uGDAlb.value[i] = alb;
    u.uGDNrm.value[i] = nrm;
    u.uGDAvg.value[i].setRGB(...layer.avg); // linear
    u.uGDTile.value.setComponent(i, 1 / layer.tile);
    u.uGDStrength.value.setComponent(i, layer.strength ?? 1);
  }));
  if (lowPower) u.uGDRange.value.set(15, 32);

  groundDetail.enabled = true; // ground materials compile after this (warm-up)
  return true;
}

/**
 * Inject the detail shader into a ground material's onBeforeCompile. Call it
 * last, after the material's own chunk replacements, and give the material
 * `customProgramCacheKey = groundDetailCacheKey`. The detail code only compiles
 * in once loadGroundDetail has succeeded.
 */
export function patchGroundDetail(shader) {
  if (!groundDetail.enabled) return;
  shader.vertexShader = `#define GROUND_DETAIL\n${shader.vertexShader}`;
  shader.fragmentShader = `#define GROUND_DETAIL\n${shader.fragmentShader}`;
  Object.assign(shader.uniforms, groundDetail.uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      #ifdef GROUND_DETAIL
        attribute vec4 aLayers;
        varying vec4 vGDLayers;
        varying vec3 vGDPos;
        varying vec3 vGDNormal;
      #endif`)
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      #ifdef GROUND_DETAIL
        vGDLayers = aLayers;
        vGDPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGDNormal = normalize(mat3(modelMatrix) * objectNormal);
      #endif`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      #ifdef GROUND_DETAIL
        uniform sampler2D uGDAlb[4];
        uniform sampler2D uGDNrm[4];
        uniform vec3 uGDAvg[4];
        uniform vec4 uGDTile;
        uniform vec2 uGDRange;
        uniform float uGDNormal;
        uniform vec4 uGDStrength;
        varying vec4 vGDLayers;
        varying vec3 vGDPos;
        varying vec3 vGDNormal;
        float gdFade = 0.0;
        vec3 gdOffset = vec3(0.0); // world-space normal perturbation
      #endif`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      #ifdef GROUND_DETAIL
      {
        // gradients taken outside any branch so mip selection stays defined
        vec3 dPdx = dFdx(vGDPos);
        vec3 dPdy = dFdy(vGDPos);
        gdFade = 1.0 - smoothstep(uGDRange.x, uGDRange.y, distance(vGDPos, cameraPosition));
        if (gdFade > 0.001) {
          vec4 w = vGDLayers;
          vec3 detail = vec3(0.0);
          vec3 off = vec3(0.0);
          vec2 n;
          float s;
          // forest floor (top-down)
          s = uGDTile.x;
          if (w.x > 0.02) {
            detail += w.x * mix(vec3(1.0), textureGrad(uGDAlb[0], vGDPos.xz * s, dPdx.xz * s, dPdy.xz * s).rgb / uGDAvg[0], uGDStrength.x);
            n = textureGrad(uGDNrm[0], vGDPos.xz * s, dPdx.xz * s, dPdy.xz * s).xy * 2.0 - 1.0;
            off += w.x * vec3(n.x, 0.0, n.y);
          } else detail += w.x;
          // rock (triplanar, so cliffs don't smear)
          s = uGDTile.y;
          if (w.y > 0.02) {
            vec3 nW = normalize(vGDNormal);
            vec3 bw = pow(abs(nW), vec3(4.0));
            bw /= dot(bw, vec3(1.0));
            vec3 aX = textureGrad(uGDAlb[1], vGDPos.zy * s, dPdx.zy * s, dPdy.zy * s).rgb;
            vec3 aY = textureGrad(uGDAlb[1], vGDPos.xz * s, dPdx.xz * s, dPdy.xz * s).rgb;
            vec3 aZ = textureGrad(uGDAlb[1], vGDPos.xy * s, dPdx.xy * s, dPdy.xy * s).rgb;
            detail += w.y * mix(vec3(1.0), (aX * bw.x + aY * bw.y + aZ * bw.z) / uGDAvg[1], uGDStrength.y);
            vec2 nX = textureGrad(uGDNrm[1], vGDPos.zy * s, dPdx.zy * s, dPdy.zy * s).xy * 2.0 - 1.0;
            vec2 nY = textureGrad(uGDNrm[1], vGDPos.xz * s, dPdx.xz * s, dPdy.xz * s).xy * 2.0 - 1.0;
            vec2 nZ = textureGrad(uGDNrm[1], vGDPos.xy * s, dPdx.xy * s, dPdy.xy * s).xy * 2.0 - 1.0;
            off += w.y * (vec3(0.0, nX.y, nX.x) * bw.x + vec3(nY.x, 0.0, nY.y) * bw.y + vec3(nZ.x, nZ.y, 0.0) * bw.z);
          } else detail += w.y;
          // snow (top-down)
          s = uGDTile.z;
          if (w.z > 0.02) {
            detail += w.z * mix(vec3(1.0), textureGrad(uGDAlb[2], vGDPos.xz * s, dPdx.xz * s, dPdy.xz * s).rgb / uGDAvg[2], uGDStrength.z);
            n = textureGrad(uGDNrm[2], vGDPos.xz * s, dPdx.xz * s, dPdy.xz * s).xy * 2.0 - 1.0;
            off += w.z * vec3(n.x, 0.0, n.y);
          } else detail += w.z;
          // mud / trail dirt (top-down)
          s = uGDTile.w;
          if (w.w > 0.02) {
            detail += w.w * mix(vec3(1.0), textureGrad(uGDAlb[3], vGDPos.xz * s, dPdx.xz * s, dPdy.xz * s).rgb / uGDAvg[3], uGDStrength.w);
            n = textureGrad(uGDNrm[3], vGDPos.xz * s, dPdx.xz * s, dPdy.xz * s).xy * 2.0 - 1.0;
            off += w.w * vec3(n.x, 0.0, n.y);
          } else detail += w.w;
          detail /= max(dot(w, vec4(1.0)), 1e-3);
          diffuseColor.rgb *= mix(vec3(1.0), detail, gdFade);
          gdOffset = off * gdFade * uGDNormal;
        }
      }
      #endif`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      #ifdef GROUND_DETAIL
        if (gdFade > 0.001) {
          normal = normalize((viewMatrix * vec4(normalize(normalize(vGDNormal) + gdOffset), 0.0)).xyz);
        }
      #endif`);
}
