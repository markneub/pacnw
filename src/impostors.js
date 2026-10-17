import * as THREE from 'three';
import { patchLod, patchSunlight, sunKey } from './materials.js';

/**
 * Far trees as impostors: each tree type is rendered at load from VIEWS
 * directions around it into an atlas (colour + surface normal). Far away,
 * every tree is one camera-facing quad that shows the baked view nearest to
 * the camera's direction, lit like the 3D trees using the baked normals. One
 * atlas for all types means one draw call per chunk for every far tree in it.
 *
 * Compared with the old far LOD models (~65 triangles each, one draw per type
 * per chunk) that's 2 triangles per tree and a fraction of the draw calls. The
 * cost moves to pixels: the quad's cut-out edge needs `discard`.
 *
 * The near/far crossfade (patchLod 'far') works as before: impostors inside
 * the LOD radius are culled in the vertex shader, and across the band they
 * dither against the full-detail near pool.
 */

const VIEWS = 8;

/**
 * Unlit bake shaders: colour (gamma-2 encoded into 8 bits) and view-space
 * normal. Faceted parts use their flat face normal (as three's flatShading
 * does); foliage cards (with a map) use their own vertex normals and are cut
 * out by the map's alpha, like in the game.
 */
function bakeMaterial(kind, src) {
  const cards = !!src.map;
  return new THREE.ShaderMaterial({
    vertexColors: true,
    side: cards ? THREE.DoubleSide : THREE.FrontSide,
    defines: cards ? { CARDS: '' } : {},
    uniforms: { uColor: { value: src.color.clone() }, uMap: { value: src.map ?? null } },
    vertexShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec3 vCol;
      varying vec3 vViewPos;
      varying vec3 vN;
      varying vec2 vUv;
      void main() {
        vCol = uColor * color.rgb; // material colour x baked prototype AO
        vN = normalMatrix * normal;
        #ifdef CARDS
          vUv = uv;
        #endif
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec3 vCol;
      varying vec3 vViewPos;
      varying vec3 vN;
      varying vec2 vUv;
      void main() {
        vec3 col = vCol;
        #ifdef CARDS
          vec4 t = texture2D(uMap, vUv);
          if (t.a < 0.5) discard;
          col *= t.rgb; // sRGB texture: the GPU decodes to linear on read
          vec3 n = normalize(vN);
        #else
          // the same flat normal three uses for flatShading, in the bake camera's space
          vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
        #endif
        gl_FragColor = ${kind === 'albedo' ? 'vec4(sqrt(col), 1.0)' : 'vec4(n * 0.5 + 0.5, 1.0)'};
      }`,
  });
}

/**
 * Spread colours into the empty texels around each silhouette (both atlases
 * at once), so mipmaps don't pull black into the edges. Grows outward one ring
 * per pass from the silhouette, touching only the texels it fills.
 */
function dilate(maps, alphaFrom, w, h, passes) {
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = alphaFrom[i * 4 + 3] > 0 ? 1 : 0;
  // first frontier: empty texels next to a filled one
  let frontier = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!filled[i] && (filled[i - 1] || filled[i + 1] || filled[i - w] || filled[i + w])) frontier.push(i);
    }
  }
  for (let pass = 0; pass < passes && frontier.length; pass++) {
    const done = [];
    for (const i of frontier) {
      if (filled[i]) continue;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (filled[j] !== 1) continue; // only from texels filled before this pass
        for (const m of maps) {
          m[i * 4] = m[j * 4];
          m[i * 4 + 1] = m[j * 4 + 1];
          m[i * 4 + 2] = m[j * 4 + 2];
        }
        filled[i] = 2; // filled this pass
        done.push(i);
        break;
      }
    }
    const next = [];
    for (const i of done) {
      filled[i] = 1;
      const x = i % w;
      const y = (i - x) / w;
      if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
      for (const j of [i - 1, i + 1, i - w, i + w]) if (!filled[j]) next.push(j);
    }
    frontier = next;
  }
}

/**
 * Render every tree type from VIEWS directions into colour + normal atlases.
 * protoParts: { name: [{geometry, material}] } (the full-detail models).
 */
export function bakeImpostors(renderer, protoParts, { frameW = 128 } = {}) {
  const names = Object.keys(protoParts);
  const fw = frameW;
  const fh = frameW * 2;
  const aw = fw * VIEWS;
  const ah = fh * names.length;
  const targets = ['albedo', 'normal'].map(() => new THREE.WebGLRenderTarget(aw, ah, { depthBuffer: true }));

  const info = {};
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera();
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);

  names.forEach((name, row) => {
    const parts = protoParts[name];
    // extent: height range and the widest reach around the trunk (any rotation)
    let yMin = Infinity;
    let yMax = -Infinity;
    let reach = 0;
    for (const { geometry } of parts) {
      const pos = geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        yMin = Math.min(yMin, pos.getY(i));
        yMax = Math.max(yMax, pos.getY(i));
        reach = Math.max(reach, Math.hypot(pos.getX(i), pos.getZ(i)));
      }
    }
    info[name] = { row, yMin, height: yMax - yMin, halfWidth: reach };

    ['albedo', 'normal'].forEach((kind, t) => {
      scene.clear();
      for (const { geometry, material } of parts) scene.add(new THREE.Mesh(geometry, bakeMaterial(kind, material)));
      cam.left = -reach;
      cam.right = reach;
      cam.top = yMax;
      cam.bottom = yMin;
      cam.near = 0.1;
      cam.far = reach * 4;
      cam.updateProjectionMatrix();
      const rt = targets[t];
      for (let k = 0; k < VIEWS; k++) {
        const a = (k / VIEWS) * Math.PI * 2;
        cam.position.set(Math.sin(a) * reach * 2, 0, Math.cos(a) * reach * 2);
        cam.lookAt(0, 0, 0);
        rt.viewport.set(k * fw, row * fh, fw, fh);
        rt.scissor.set(k * fw, row * fh, fw, fh);
        rt.scissorTest = true;
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
      }
      scene.traverse((o) => { if (o.material) o.material.dispose(); });
    });
  });

  // read back, fix the edges, and turn into mipmapped textures
  const read = (rt) => {
    const buf = new Uint8Array(aw * ah * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, aw, ah, buf);
    return buf;
  };
  const albedo = read(targets[0]);
  const normal = read(targets[1]);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  for (const rt of targets) rt.dispose();
  dilate([albedo, normal], albedo, aw, ah, 6);
  const tex = (data) => {
    const t = new THREE.DataTexture(data, aw, ah, THREE.RGBAFormat);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: tex(albedo), normal: tex(normal), info, rows: names.length };
}

/** A unit quad: x in [-0.5, 0.5], y in [0, 1]. Placed and sized per instance in the shader. */
export function impostorGeometry(maxSize) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0);
  // culling uses this per instance: big enough for the largest tree at scale 1
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, maxSize / 2, 0), maxSize);
  return geo;
}

/** Billboard material; aFrame (per instance) = [yMin, height, halfWidth, atlas row]. */
export function impostorMaterial(baked) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  mat.envMapIntensity = 0.35; // foliage, like the near trees
  mat.onBeforeCompile = (shader) => {
    patchLod(shader, 'far');
    patchSunlight(shader);
    shader.uniforms.uImpAlbedo = { value: baked.albedo };
    shader.uniforms.uImpNormal = { value: baked.normal };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aFrame;
        varying vec2 vImpUv;
        varying vec3 vImpRight;
        varying vec3 vImpToward;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          mat3 iM = mat3(instanceMatrix);
          float iS = length(iM[0]);
          float iRot = atan(iM[2].x, iM[2].z); // the instance's yaw
          vec3 iOrigin = (modelMatrix * instanceMatrix[3]).xyz;
          vec2 iD = cameraPosition.xz - iOrigin.xz;
          float iAng = atan(iD.x, iD.y); // direction to the camera
          float iStep = 6.2831853 / ${VIEWS.toFixed(1)};
          float iK = mod(floor((iAng - iRot) / iStep + 0.5), ${VIEWS.toFixed(1)}); // nearest baked view
          float iTheta = iK * iStep + iRot;
          // the quad faces the camera (never edge-on) and shows that view
          vec3 iRight = vec3(cos(iAng), 0.0, -sin(iAng));
          vec3 w = iRight * (position.x * 2.0 * aFrame.z) + vec3(0.0, aFrame.x + position.y * aFrame.y, 0.0);
          // into instance space (rotation + uniform scale), since three applies instanceMatrix after this
          transformed = transpose(iM) * (w * iS) / (iS * iS);
          vImpUv = vec2((iK + position.x + 0.5) / ${VIEWS.toFixed(1)}, (aFrame.w + position.y) / ${baked.rows.toFixed(1)});
          // the baked view's axes, to turn its normals back into world space
          vImpRight = vec3(cos(iTheta), 0.0, -sin(iTheta));
          vImpToward = vec3(sin(iTheta), 0.0, cos(iTheta));
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uImpAlbedo;
        uniform sampler2D uImpNormal;
        varying vec2 vImpUv;
        varying vec3 vImpRight;
        varying vec3 vImpToward;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec4 iAlb = texture2D(uImpAlbedo, vImpUv);
        if (iAlb.a < 0.4) discard;
        diffuseColor.rgb *= iAlb.rgb * iAlb.rgb; // stored gamma-2`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          vec3 iN = texture2D(uImpNormal, vImpUv).xyz * 2.0 - 1.0;
          vec3 iW = vImpRight * iN.x + vec3(0.0, iN.y, 0.0) + vImpToward * iN.z;
          normal = normalize((viewMatrix * vec4(iW, 0.0)).xyz);
        }`);
  };
  mat.customProgramCacheKey = () => `impostor|${sunKey()}`;
  return mat;
}
