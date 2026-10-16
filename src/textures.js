import * as THREE from 'three';

/**
 * Load one texture set written by tools/fetch_textures.py or blender/build_rocks.py
 * (public/textures/<set>/manifest.json + <layer>_<size>_albedo/normal.jpg).
 * Phones get the smaller size (manifest `sizes`: [desktop, phone], default
 * [1024, 512]). Returns the manifest layers, each with `alb` (sRGB) and `nrm`
 * (linear) textures, or null if the set isn't there. `flipY: false` for
 * textures mapped with glTF UVs (scanned models).
 */
export async function loadTextureSet(renderer, set, { lowPower, flipY = true }) {
  const base = `${import.meta.env.BASE_URL}textures/${set}/`;
  let manifest;
  try {
    const res = await fetch(`${base}manifest.json`);
    if (!res.ok) return null;
    manifest = await res.json();
  } catch {
    return null;
  }
  const [big, small] = manifest.sizes ?? [1024, 512];
  const size = lowPower ? small : big;
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), lowPower ? 4 : 8);
  const load = async (file, srgb) => {
    const tex = await loader.loadAsync(base + file);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = aniso;
    tex.flipY = flipY;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return tex;
  };
  return Promise.all(manifest.layers.map(async (layer) => {
    const [alb, nrm] = await Promise.all([
      load(`${layer.name}_${size}_albedo.jpg`, true),
      load(`${layer.name}_${size}_normal.jpg`, false),
    ]);
    return { ...layer, alb, nrm };
  }));
}
