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
    // per build: Pages lets browsers keep it 10 min, and a stale one lacks new layers (the bench seat's wood)
    const res = await fetch(`${base}manifest.json?v=${__BUILD_SHA__}`);
    if (!res.ok) return null;
    manifest = await res.json();
  } catch {
    return null;
  }
  const [big, small] = manifest.sizes ?? [1024, 512];
  const size = lowPower ? small : big;
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), lowPower ? 4 : 8);
  const load = async (dir, file, srgb) => {
    const tex = await loader.loadAsync(dir + file);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = aniso;
    tex.flipY = flipY;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return tex;
  };
  return Promise.all(manifest.layers.map(async (layer) => {
    // (a layer can borrow another set's files: `dir`, e.g. the surface set's "wood" is the cabin's)
    const dir = layer.dir ? `${import.meta.env.BASE_URL}textures/${layer.dir}/` : base;
    const [alb, nrm] = await Promise.all([
      load(dir, `${layer.name}_${size}_albedo.jpg`, true),
      load(dir, `${layer.name}_${size}_normal.jpg`, false),
    ]);
    return { ...layer, alb, nrm };
  }));
}
