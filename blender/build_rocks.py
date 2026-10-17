"""
Scanned boulders: CC0 photogrammetry from Poly Haven, reduced to two detail
levels for the game, with the scan's fine detail baked into a normal map.

    <bvenv>/bin/python blender/build_rocks.py [--cache DIR]

Writes
  public/models/rocks.glb              boulder_a..f (near, ~1600 tris, with tangents)
                                       + boulder_a_lod..f_lod (far, ~220 tris)
  public/textures/rocks/               scanA/scanB albedo + normal at 2048 (desktop) and 1024 (phones)
                                       + manifest.json

The scans (glTF, 2k textures) are downloaded into the cache dir on first run
(needs api.polyhaven.com and dl.polyhaven.org). Materials in the GLB carry no
images: the game loads the textures itself (src/vegetation.js), so phones can
get smaller ones.

Per rock:
  1. import the scan (8-16k tris) and sit it on the ground: origin at the
     centre of its footprint, 18% of its height below ground so the scan's
     ragged underside is buried
  2. weld the import's seam splits, then decimate a near copy to ~1600 tris
     and a far copy to ~220 (UVs kept)
  3. bake the scan's shading normals (its mesh *and* its own normal map) onto
     the near copy, into a fresh atlas in the scan's UV layout
The albedo is the scan's own atlas; set 01 is warm sandstone, so it's shifted
toward set 02's lichen grey.
"""

import json
import os
import sys
import urllib.request

import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_GLB = os.path.join(ROOT, "public", "models", "rocks.glb")
OUT_TEX = os.path.join(ROOT, "public", "textures", "rocks")
args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
CACHE = args[args.index("--cache") + 1] if "--cache" in args else os.path.join(ROOT, ".cache", "scans")

# scan set -> (texture set name in the game, GLB material name)
SETS = {
    "rock_moss_set_02": ("scanA", "ScanRockA"),  # grey basalt with lichen
    "rock_moss_set_01": ("scanB", "ScanRockB"),  # angular blocks; warm, regraded grey
}
ROCKS = [  # (game name, scan set, object in the scan)
    ("boulder_a", "rock_moss_set_02", "rock_moss_set_02_rock10"),
    ("boulder_b", "rock_moss_set_02", "rock_moss_set_02_rock11"),
    ("boulder_c", "rock_moss_set_02", "rock_moss_set_02_rock13"),
    ("boulder_d", "rock_moss_set_02", "rock_moss_set_02_rock07"),
    ("boulder_e", "rock_moss_set_01", "rock_moss_set_01_rock01"),
    ("boulder_f", "rock_moss_set_01", "rock_moss_set_01_rock04"),
    ("boulder_g", "rock_moss_set_01", "rock_moss_set_01_rock02"),  # a broad, flat slab
    ("boulder_h", "rock_moss_set_01", "rock_moss_set_01_rock05"),  # a long block
    ("boulder_i", "rock_moss_set_02", "rock_moss_set_02_rock12"),  # squat basalt
]
NEAR_TRIS = 1600
FAR_TRIS = 220
SINK = 0.18  # share of the height below ground
BAKE_SIZE = 2048
SIZES = (2048, 1024)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cascadia-woods-asset-fetch"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def fetch_scan(asset):
    d = os.path.join(CACHE, asset)
    gltf = os.path.join(d, asset + ".gltf")
    if os.path.exists(gltf):
        return gltf
    files = json.loads(get(f"https://api.polyhaven.com/files/{asset}"))
    g = files["gltf"]["2k"]["gltf"]
    os.makedirs(os.path.join(d, "textures"), exist_ok=True)
    with open(gltf, "wb") as f:
        f.write(get(g["url"]))
    for name, v in g.get("include", {}).items():
        with open(os.path.join(d, name), "wb") as f:
            f.write(get(v["url"]))
    return gltf


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def decimated(src, name, tris):
    import bmesh
    obj = src.copy()
    obj.data = src.data.copy()
    obj.name = name
    bpy.context.scene.collection.objects.link(obj)
    # glTF import splits vertices along UV seams; weld them (UVs stay per
    # corner) or decimation pulls the pieces apart and opens cracks
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(obj.data)
    bm.free()
    mod = obj.modifiers.new("dec", "DECIMATE")
    mod.ratio = min(1.0, tris / tri_count(src))
    mod.use_collapse_triangulate = True
    with bpy.context.temp_override(object=obj):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def settle(objs):
    """Origin at the footprint centre, SINK of the height below ground."""
    hi = objs[0]
    pts = [hi.matrix_world @ v.co for v in hi.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    up = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    origin = Vector(((lo.x + up.x) / 2, (lo.y + up.y) / 2, lo.z + (up.z - lo.z) * SINK))
    for o in objs:
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(mw)
        o.matrix_world = Matrix.Identity(4)
        o.data.transform(Matrix.Translation(-origin))
    return up - lo


def bake_normals(set_asset, pairs):
    """Bake each (scan, near) pair into one atlas image (the scan's UV layout)."""
    img = bpy.data.images.new(f"bake_{set_asset}", BAKE_SIZE, BAKE_SIZE, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    img.generated_color = (0.5, 0.5, 1.0, 1.0)
    mat = bpy.data.materials.new(f"bake_{set_asset}")
    mat.use_nodes = True
    node = mat.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = img
    mat.node_tree.nodes.active = node

    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = 4
    scn.render.bake.use_selected_to_active = True
    scn.render.bake.cage_extrusion = 0.04
    scn.render.bake.max_ray_distance = 0.15
    scn.render.bake.margin = 8
    scn.render.bake.normal_space = "TANGENT"
    for scan, near in pairs:
        near.data.materials.clear()
        near.data.materials.append(mat)
        bpy.ops.object.select_all(action="DESELECT")
        scan.select_set(True)
        near.select_set(True)
        bpy.context.view_layer.objects.active = near
        bpy.ops.object.bake(type="NORMAL", use_clear=False)
        print(f"  baked {near.name}")
    return img


def save_jpg(pixels, size, path, quality):
    """pixels: float RGB array (h, w, 3), bottom row first (Blender order)."""
    img = bpy.data.images.new("out", pixels.shape[1], pixels.shape[0], alpha=False)
    rgba = np.concatenate([pixels, np.ones(pixels.shape[:2] + (1,), np.float32)], axis=2)
    img.pixels.foreach_set(rgba.ravel())
    if pixels.shape[0] != size:
        img.scale(size, size)
    img.file_format = "JPEG"
    img.save(filepath=path, quality=quality)  # raw values, no colour management
    bpy.data.images.remove(img)


def image_array(img):
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)[:, :, :3]


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    os.makedirs(OUT_TEX, exist_ok=True)
    scans = {}
    for asset in SETS:
        bpy.ops.import_scene.gltf(filepath=fetch_scan(asset))
        scans[asset] = {o.name: o for o in bpy.context.scene.objects if o.type == "MESH" and o.name.startswith(asset)}

    export, pairs = [], {a: [] for a in SETS}
    for name, asset, obj_name in ROCKS:
        scan = scans[asset][obj_name]
        near = decimated(scan, name, NEAR_TRIS)
        far = decimated(scan, f"{name}_lod", FAR_TRIS)
        size = settle([scan, near, far])
        print(f"{name}: scan {tri_count(scan)} -> near {tri_count(near)}, far {tri_count(far)} tris, "
              f"size {size.x:.2f} x {size.y:.2f} x {size.z:.2f} m")
        pairs[asset].append((scan, near))
        export += [(near, far, asset)]

    manifest = {"source": "Poly Haven (CC0)", "sizes": list(SIZES), "layers": []}
    albedo = {}
    for asset, (tex_name, _) in SETS.items():
        normal = image_array(bake_normals(asset, pairs[asset]))
        src = os.path.join(CACHE, asset, "textures", f"{asset}_diff_2k.jpg")
        diff = image_array(bpy.data.images.load(src))
        albedo[tex_name] = diff
        for s in SIZES:
            save_jpg(normal, s, os.path.join(OUT_TEX, f"{tex_name}_{s}_normal.jpg"), 92)
    # regrade set 01's warm sandstone toward set 02's grey (keep its own detail)
    ref = srgb_to_linear(albedo["scanA"]).reshape(-1, 3).mean(0)
    b = albedo["scanB"]
    lum_w = np.array([0.2126, 0.7152, 0.0722], np.float32)
    lum = (b @ lum_w)[..., None]
    grey = lum * (ref / (ref @ lum_w))[None, None, :] ** (1 / 2.2)
    albedo["scanB"] = np.clip(b * 0.3 + grey * 0.7, 0, 1).astype(np.float32)
    for asset, (tex_name, _) in SETS.items():
        for s in SIZES:
            save_jpg(albedo[tex_name], s, os.path.join(OUT_TEX, f"{tex_name}_{s}_albedo.jpg"), 88)
        avg = srgb_to_linear(albedo[tex_name]).reshape(-1, 3).mean(0)
        manifest["layers"].append({
            "name": tex_name, "asset": asset, "avg": [round(float(a), 5) for a in avg],
            "url": f"https://polyhaven.com/a/{asset}",
        })
    with open(os.path.join(OUT_TEX, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    # export: plain named materials (the game supplies the textures)
    mats = {}
    for asset, (_, mat_name) in SETS.items():
        m = bpy.data.materials.new(mat_name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
        bsdf.inputs["Roughness"].default_value = 0.9
        mats[asset] = m
    keep = set()
    for near, far, asset in export:
        for o in (near, far):
            o.data.materials.clear()
            o.data.materials.append(mats[asset])
            keep.add(o)
    for o in list(bpy.context.scene.objects):
        if o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB, export_format="GLB", export_tangents=True, export_normals=True,
        export_texcoords=True, export_materials="EXPORT", export_image_format="NONE",
        export_animations=False, export_yup=True,
    )
    print(f"wrote {OUT_GLB} and {OUT_TEX}")


main()
