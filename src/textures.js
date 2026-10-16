import * as THREE from 'three';

/**
 * Load one texture set written by tools/fetch_textures.py
 * (public/textures/<set>/manifest.json + <layer>_<size>_albedo/normal.jpg).
 * Phones get the 512 px versions. Returns the manifest layers, each with
 * `alb` (sRGB) and `nrm` (linear) textures, or null if the set isn't there.
 */
export async function loadTextureSet(renderer, set, { lowPower }) {
  const base = `${import.meta.env.BASE_URL}textures/${set}/`;
  let manifest;
  try {
    const res = await fetch(`${base}manifest.json`);
    if (!res.ok) return null;
    manifest = await res.json();
  } catch {
    return null;
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
  return Promise.all(manifest.layers.map(async (layer) => {
    const [alb, nrm] = await Promise.all([
      load(`${layer.name}_${size}_albedo.jpg`, true),
      load(`${layer.name}_${size}_normal.jpg`, false),
    ]);
    return { ...layer, alb, nrm };
  }));
}
