"""
The things on the coast: a shipwreck in the shallows (Poly Haven's CC0 "Dutch Ship Medium",
stripped of its sails, its masts snapped), some flotsam (Poly Haven barrel + crate), and a
lighthouse with its keeper's house (modelled here) for the headland.

    <bvenv>/bin/python blender/build_coast.py [--cache DIR]

Writes public/models/coast.glb with one object per thing, each at the origin, Y up:
  wreck          the hull (keel ~2 m below the origin) + what's left of the rigging; X = bow
  barrel, crate  flotsam (bottom at the origin)
  lighthouse     tower on a stone plinth (ground at the origin, 1 m of plinth below it for
                 slopes), gallery, lantern room (LhGlass), the lamp (LhLamp: the game lights it
                 at night), domed cap; its door faces +Y (Blender) = -Z (game)
  keeper_house   a gabled white house with a red roof and a brick chimney; door faces +Y

The Poly Haven glTFs (1k textures) are downloaded into the cache dir on first run (needs
api.polyhaven.com and dl.polyhaven.org); their textures are embedded in the GLB.
"""

import json
import math
import os
import sys
import urllib.request

import bpy  # (first: bmesh comes with it)
import bmesh  # noqa: E402
from mathutils import Matrix, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_GLB = os.path.join(ROOT, "public", "models", "coast.glb")
args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
CACHE = args[args.index("--cache") + 1] if "--cache" in args else os.path.join(ROOT, ".cache", "ph")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cascadia-woods-asset-fetch"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def fetch(asset, res="1k"):
    d = os.path.join(CACHE, asset)
    gltf = os.path.join(d, asset + ".gltf")
    if os.path.exists(gltf):
        return gltf
    f = json.loads(get(f"https://api.polyhaven.com/files/{asset}"))["gltf"][res]["gltf"]
    os.makedirs(d, exist_ok=True)
    for rel, inc in f["include"].items():
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(get(inc["url"]))
    with open(gltf, "wb") as fh:
        fh.write(get(f["url"]))
    return gltf


def import_gltf(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def select_only(objs, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def apply_all(o):
    select_only([o])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def decimate(o, target):
    n = tri_count(o)
    if n <= target:
        return
    m = o.modifiers.new("dec", "DECIMATE")
    m.ratio = target / n
    m.use_collapse_triangulate = True
    select_only([o])
    bpy.ops.object.modifier_apply(modifier=m.name)


# ---------------------------------------------------------------------------
# The wreck
# ---------------------------------------------------------------------------

def build_wreck():
    objs = import_gltf(fetch("dutch_ship_medium"))
    meshes = {o.name: o for o in objs if o.type == "MESH"}
    for o in objs:
        if o.type == "MESH":
            # (the import parents meshes to an empty: bake its transform in)
            mw = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = mw
            apply_all(o)
    hull = meshes["dutch_ship_medium_hull"]
    rig = meshes["dutch_ship_medium_rigging"]
    others = [o for o in objs if o.type != "MESH"]
    bpy.data.objects.remove(meshes["dutch_ship_medium_sails"], do_unlink=True)
    for o in others:
        bpy.data.objects.remove(o, do_unlink=True)

    # the masts snapped off (a slanting cut: each at a different height), the rigging above gone
    bm = bmesh.new()
    bm.from_mesh(rig.data)
    n = Vector((-0.16, 0.06, 1.0)).normalized()
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, 8.6), plane_no=n, clear_outer=True)
    # and the bowsprit's far end, and the odd loose spar end that's left floating
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(12.2, 0, 0), plane_no=(1, 0, 0), clear_outer=True)
    bm.to_mesh(rig.data)
    bm.free()
    # drop tiny islands the cut left hanging (bits of rope)
    select_only([rig])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    bm = bmesh.new()
    bm.from_mesh(rig.data)
    bm.verts.ensure_lookup_table()
    seen = set()
    drop = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack = [v]
        comp = []
        seen.add(v.index)
        while stack:
            a = stack.pop()
            comp.append(a)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b.index not in seen:
                    seen.add(b.index)
                    stack.append(b)
        if len(comp) < 12:
            zs = [c.co.z for c in comp]
            if min(zs) > 4.0:
                drop.extend(comp)
    bmesh.ops.delete(bm, geom=drop, context="VERTS")
    bm.to_mesh(rig.data)
    bm.free()

    # stove in: a ragged hole in the side that ends up on top once she's heeled over (+Y), and
    # one in the deck behind the mainmast
    bm = bmesh.new()
    bm.from_mesh(hull.data)
    holes = [((-2.5, 2.4, 1.6), (3.2, 2.2, 1.5)), ((-5.5, 0.9, 3.4), (1.8, 1.3, 1.5)), ((3.6, 2.5, 0.6), (1.4, 1.5, 1.1))]
    gone = []
    for f in bm.faces:
        c = f.calc_center_median()
        for (hx, hy, hz), (rx, ry, rz) in holes:
            jag = 0.25 * math.sin(c.x * 3.1 + c.z * 2.3) + 0.15 * math.sin(c.z * 7.7 - c.x * 1.9)
            if ((c.x - hx) / rx) ** 2 + ((c.y - hy) / ry) ** 2 + ((c.z - hz) / rz) ** 2 < 1 + jag:
                gone.append(f)
                break
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bm.to_mesh(hull.data)
    bm.free()
    decimate(hull, 16000)
    decimate(rig, 7000)
    select_only([hull, rig], active=hull)
    bpy.ops.object.join()
    hull.name = "wreck"
    hull.data.name = "wreck"
    print("wreck tris", tri_count(hull))
    return hull


def build_flotsam(asset, name, target):
    objs = import_gltf(fetch(asset))
    meshes = [o for o in objs if o.type == "MESH"]
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
        apply_all(o)
    for o in objs:
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    select_only(meshes)
    if len(meshes) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    decimate(o, target)
    o.name = name
    o.data.name = name
    print(name, "tris", tri_count(o))
    return o


# ---------------------------------------------------------------------------
# Modelled pieces: a tiny mesh builder (faces with a material slot each)
# ---------------------------------------------------------------------------

def material(name, color, rough=0.8, metal=0.0, emit=None, alpha=None):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1.0)
        p.inputs["Emission Strength"].default_value = 1.0
    if alpha is not None:
        p.inputs["Alpha"].default_value = alpha
        m.blend_method = "BLEND"
    return m


class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []
        self.smooth = set()

    def slot(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def face(self, pts, mat, smooth=False):
        vs = [self.bm.verts.new(p) for p in pts]
        f = self.bm.faces.new(vs)
        f.material_index = self.slot(mat)
        f.smooth = smooth
        return f

    def quad_strip(self, rings, mat, smooth=False, close=True):
        """rings: lists of points, each ring the same length; faces between consecutive rings."""
        vr = [[self.bm.verts.new(p) for p in ring] for ring in rings]
        n = len(rings[0])
        for a, b in zip(vr, vr[1:]):
            for j in range(n if close else n - 1):
                k = (j + 1) % n
                f = self.bm.faces.new((a[j], a[k], b[k], b[j]))
                f.material_index = self.slot(mat)
                f.smooth = smooth
        return vr

    def lathe(self, profile, mat, sides=16, cap_top=False, cap_bottom=False, smooth=True, cx=0.0, cy=0.0, phase=0.0):
        rings = []
        for r, z in profile:
            rings.append([(cx + r * math.cos(phase + 2 * math.pi * j / sides), cy + r * math.sin(phase + 2 * math.pi * j / sides), z) for j in range(sides)])
        vr = self.quad_strip(rings, mat, smooth)
        if cap_top:
            f = self.bm.faces.new(vr[-1])
            f.material_index = self.slot(mat)
        if cap_bottom:
            f = self.bm.faces.new(list(reversed(vr[0])))
            f.material_index = self.slot(mat)

    def box(self, c, size, mat, rz=0.0, rx=0.0):
        sx, sy, sz = (s / 2 for s in size)
        rot = Matrix.Rotation(rz, 3, "Z") @ Matrix.Rotation(rx, 3, "X")
        P = [Vector(c) + rot @ Vector((x * sx, y * sy, z * sz)) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
        idx = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        vs = [self.bm.verts.new(p) for p in P]
        for q in idx:
            f = self.bm.faces.new([vs[i] for i in q])
            f.material_index = self.slot(mat)

    def cyl(self, p0, p1, r, mat, sides=8, smooth=True):
        a = Vector(p0)
        b = Vector(p1)
        d = (b - a).normalized()
        u = d.orthogonal().normalized()
        w = d.cross(u)
        ring = lambda c: [c + (u * math.cos(2 * math.pi * j / sides) + w * math.sin(2 * math.pi * j / sides)) * r for j in range(sides)]
        self.quad_strip([ring(a), ring(b)], mat, smooth)

    def prism(self, section, x0, x1, mat):
        """A section [(y, z)] (counter-clockwise seen from +X) extruded along X, with both ends capped."""
        r0 = [(x0, y, z) for y, z in section]
        r1 = [(x1, y, z) for y, z in section]
        vr = self.quad_strip([r0, r1], mat)
        f = self.bm.faces.new(list(reversed(vr[0])))
        f.material_index = self.slot(mat)
        f = self.bm.faces.new(vr[1])
        f.material_index = self.slot(mat)

    def build(self, name):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        print(name, "tris", tri_count(o))
        return o


def tower_r(z):
    """The tower's radius at height z (a gentle taper)."""
    return 2.35 - 0.055 * z


def build_lighthouse():
    WHITE = material("LhWhite", (0.86, 0.85, 0.8), 0.85)
    STONE = material("LhStone", (0.42, 0.41, 0.38), 0.95)
    IRON = material("LhIron", (0.05, 0.055, 0.06), 0.55, 0.3)
    RED = material("LhRed", (0.45, 0.07, 0.05), 0.6)
    GLASS = material("LhGlass", (0.12, 0.16, 0.18), 0.08, alpha=0.3)
    LAMP = material("LhLamp", (0.9, 0.8, 0.55), 0.2, emit=(1.0, 0.85, 0.55))
    DOOR = material("LhDoor", (0.08, 0.2, 0.15), 0.6)
    PANE = material("LhPane", (0.05, 0.06, 0.07), 0.15)
    b = Builder()
    S = 24
    # the stone plinth (runs a metre into the ground for slopes)
    b.lathe([(3.4, -1.0), (3.4, 0.55), (3.1, 0.8), (tower_r(0.8) + 0.05, 0.8)], STONE, sides=12, smooth=False, phase=math.pi / 12)
    # the tower
    zs = [0.8 + i * (13.2 / 8) for i in range(9)]
    b.lathe([(tower_r(z), z) for z in zs], WHITE, sides=S)
    top = zs[-1]  # 14.0
    # the gallery: a flared iron corbel ring, the deck, a railing
    b.lathe([(tower_r(top - 0.9), top - 0.9), (tower_r(top) + 0.25, top - 0.25), (2.45, top - 0.05), (2.45, top + 0.2), (1.5, top + 0.2)], IRON, sides=S)
    for j in range(16):
        a = 2 * math.pi * (j + 0.5) / 16
        b.box((2.0 * math.cos(a), 2.0 * math.sin(a), top - 0.45), (0.9, 0.12, 0.5), IRON, rz=a)
    for j in range(20):
        a = 2 * math.pi * j / 20
        b.cyl((2.35 * math.cos(a), 2.35 * math.sin(a), top + 0.2), (2.35 * math.cos(a), 2.35 * math.sin(a), top + 1.25), 0.03, IRON, sides=4)
    for h, rr in ((top + 1.25, 0.04), (top + 0.75, 0.025)):
        ring = [(2.35 * math.cos(2 * math.pi * j / 20), 2.35 * math.sin(2 * math.pi * j / 20), h) for j in range(21)]
        for p, q in zip(ring, ring[1:]):
            b.cyl(p, q, rr, IRON, sides=4)
    # the lantern room: an iron base, glazing between mullions, a band, the cap
    L0 = top + 0.2
    b.lathe([(1.5, L0), (1.5, L0 + 0.75), (1.35, L0 + 0.75)], IRON, sides=10, smooth=False, phase=math.pi / 10)
    g0, g1 = L0 + 0.75, L0 + 2.75
    b.lathe([(1.35, g0), (1.35, g1)], GLASS, sides=10, smooth=False, phase=math.pi / 10)
    for j in range(10):
        a = math.pi / 10 + 2 * math.pi * j / 10
        b.box((1.36 * math.cos(a), 1.36 * math.sin(a), (g0 + g1) / 2), (0.07, 0.07, g1 - g0), IRON, rz=a)
    b.lathe([(1.4, g1), (1.4, g1 + 0.15)], IRON, sides=10, smooth=False, phase=math.pi / 10)
    b.lathe([(1.62, g1 + 0.15), (1.35, g1 + 0.5), (0.9, g1 + 0.95), (0.35, g1 + 1.2), (0.0, g1 + 1.25)], RED, sides=S)
    b.lathe([(0.0, g1 + 1.2), (0.18, g1 + 1.3), (0.22, g1 + 1.45), (0.16, g1 + 1.6), (0.0, g1 + 1.65)], IRON, sides=10)
    b.cyl((0, 0, g1 + 1.6), (0, 0, g1 + 2.6), 0.02, IRON, sides=4)
    # the lamp: a Fresnel lens (a ribbed barrel) on a pedestal
    b.cyl((0, 0, L0 + 0.75), (0, 0, L0 + 1.1), 0.12, IRON, sides=8)
    prof = []
    for i in range(9):
        t = i / 8
        z = L0 + 1.1 + t * 1.25
        prof.append((0.38 + 0.12 * math.sin(math.pi * t) + 0.025 * (i % 2), z))
    b.lathe(prof, LAMP, sides=16, cap_top=True, cap_bottom=True)
    # the door (+Y) under a little pediment, and windows climbing round the tower
    r0 = tower_r(1.9)
    b.box((0, r0 + 0.02, 1.9), (1.0, 0.16, 2.1), DOOR)
    b.box((0, r0 + 0.08, 3.08), (1.4, 0.2, 0.18), WHITE)
    for k, (z, a) in enumerate(((5.0, math.pi / 2 + 0.6), (8.2, -math.pi / 2 + 0.3), (11.2, math.pi / 2 - 0.5))):
        r = tower_r(z)
        b.box((r * math.cos(a), r * math.sin(a), z), (0.14, 0.62, 0.95), PANE, rz=a)
        b.box(((r - 0.01) * math.cos(a), (r - 0.01) * math.sin(a), z + 0.55), (0.18, 0.78, 0.12), WHITE, rz=a)
    return b.build("lighthouse")


def build_keeper_house():
    WALL = material("HouseWall", (0.83, 0.81, 0.75), 0.85)
    ROOF = material("HouseRoof", (0.4, 0.08, 0.06), 0.7)
    TRIM = material("HouseTrim", (0.08, 0.2, 0.15), 0.6)
    BRICK = material("HouseBrick", (0.42, 0.2, 0.14), 0.95)
    STONE = material("LhStone", (0.42, 0.41, 0.38), 0.95)
    PANE = material("LhPane", (0.05, 0.06, 0.07), 0.15)
    b = Builder()
    hx, hy, wall = 4.2, 3.2, 3.0
    rise = hy * math.tan(math.radians(36))
    base = 0.45
    # a stone footing running into the ground, the walls and gables in one piece
    b.box((0, 0, base / 2 - 0.5), (2 * hx + 0.2, 2 * hy + 0.2, base + 1.0), STONE)
    b.prism([(-hy, base), (hy, base), (hy, base + wall), (0, base + wall + rise), (-hy, base + wall)], -hx, hx, WALL)
    # the roof: two slabs over the ridge, overhanging
    ang = math.radians(36)
    over = 0.45  # eave overhang (horizontal)
    run = (hy + over) / math.cos(ang)
    for side in (-1, 1):
        cy = side * (hy + over) / 2
        cz = base + wall + rise - (hy + over) / 2 * math.tan(ang) + 0.07 / math.cos(ang)
        b.box((0, cy, cz), (2 * hx + 0.7, run + 0.05, 0.14), ROOF, rx=-side * ang)
    # the chimney
    b.box((hx - 1.1, 0.6, base + wall + rise / 2 + 0.6), (0.65, 0.65, rise + 1.6), BRICK)
    b.box((hx - 1.1, 0.6, base + wall + rise + 0.8), (0.8, 0.8, 0.15), BRICK)
    # door (+Y), windows with trim
    b.box((-1.2, hy + 0.03, base + 1.05), (0.95, 0.12, 2.05), TRIM)
    b.box((-1.2, hy + 0.04, base + 2.15), (1.2, 0.14, 0.14), TRIM)
    for x in (1.3, 2.9):
        b.box((x - 0.4, hy + 0.04, base + 1.6), (0.85, 0.1, 1.15), PANE)
        b.box((x - 0.4, hy + 0.02, base + 1.6), (1.05, 0.08, 1.35), TRIM)
    for x in (-2.6, 0.0, 2.6):
        b.box((x, -hy - 0.04, base + 1.6), (0.85, 0.1, 1.15), PANE)
        b.box((x, -hy - 0.02, base + 1.6), (1.05, 0.08, 1.35), TRIM)
    for y in (-1.3, 1.3):
        b.box((hx + 0.04, y, base + 1.6), (0.1, 0.85, 1.15), PANE)
        b.box((hx + 0.02, y, base + 1.6), (0.08, 1.05, 1.35), TRIM)
    b.box((-hx - 0.04, 0, base + 1.6), (0.1, 0.85, 1.15), PANE)
    b.box((-hx - 0.02, 0, base + 1.6), (0.08, 1.05, 1.35), TRIM)
    # a step at the door
    b.box((-1.2, hy + 0.45, base / 2 - 0.1), (1.4, 0.7, base + 0.2), STONE)
    return b.build("keeper_house")


def slim_textures():
    """Smaller downloads: no metal/roughness/AO maps (wood: plain rough), 512 px except the hull's."""
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        nt = m.node_tree
        p = nt.nodes.get("Principled BSDF")
        if not p:
            continue
        for name in ("Metallic", "Roughness"):
            for link in list(p.inputs[name].links):
                nt.links.remove(link)
        p.inputs["Metallic"].default_value = 0.0
        p.inputs["Roughness"].default_value = 0.85
    for img in bpy.data.images:
        if img.size[0] == 0:
            continue
        size = 1024 if "hull" in img.name else 512
        if img.size[0] > size:
            img.scale(size, size)
        else:
            img.pixels = img.pixels[:]  # (re-encoded at the export's quality, not copied as is)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    os.makedirs(CACHE, exist_ok=True)
    wreck = build_wreck()
    barrel = build_flotsam("barrel_03", "barrel", 1500)
    crate = build_flotsam("wooden_crate_02", "crate", 2500)
    lh = build_lighthouse()
    house = build_keeper_house()
    for o in (wreck, barrel, crate, lh, house):
        o.location = (0, 0, 0)
    slim_textures()
    select_only([wreck, barrel, crate, lh, house])
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="JPEG",
        export_jpeg_quality=80,
        export_cameras=False,
        export_lights=False,
    )
    print("wrote", OUT_GLB, os.path.getsize(OUT_GLB) // 1024, "KB")


main()
