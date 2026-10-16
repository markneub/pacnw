"""
Procedurally builds the low-poly Pacific Northwest asset set and exports it to
public/models/forest.glb.

Run with either:
    blender -b -P blender/build_assets.py
or, with the `bpy` module from PyPI installed (pip install bpy):
    python blender/build_assets.py

Every asset is a single object (one primitive per material) sitting at the
origin, Z-up in Blender (the glTF exporter converts to Y-up). The object names
are what the three.js side looks up, so keep them in sync with src/assets.js.
"""

import math
import os
import random
import sys

import bpy
import mathutils
from mathutils import Vector, noise

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "models", "forest.glb")

TAU = math.tau


# ---------------------------------------------------------------------------
# Scene / material helpers
# ---------------------------------------------------------------------------

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


_materials = {}


def material(name, rgb, roughness=0.9):
    """Flat-coloured Principled material; colours are given in sRGB."""
    if name in _materials:
        return _materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    lin = [srgb_to_linear(c) for c in rgb]
    bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    _materials[name] = mat
    return mat


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


class MeshBuilder:
    """Accumulates triangles/quads per material, then emits one object."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.face_mats = []
        self.mats = []

    def mat_index(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def v(self, co):
        self.verts.append(tuple(co))
        return len(self.verts) - 1

    def face(self, idx, mat):
        self.faces.append(tuple(idx))
        self.face_mats.append(self.mat_index(mat))

    def build(self, name):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.verts, [], self.faces)
        mesh.validate()
        for m in self.mats:
            mesh.materials.append(m)
        for poly, mi in zip(mesh.polygons, self.face_mats):
            poly.material_index = mi
            poly.use_smooth = False
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

def mats():
    return {
        "bark": material("Bark", (0.27, 0.19, 0.14)),
        "cedar_bark": material("CedarBark", (0.42, 0.24, 0.16)),
        "snag": material("SnagBark", (0.48, 0.45, 0.41)),
        "needles": material("Needles", (0.13, 0.27, 0.15), 0.85),
        "needles_dark": material("NeedlesDark", (0.09, 0.2, 0.13), 0.85),
        "cedar": material("CedarFoliage", (0.19, 0.33, 0.14), 0.85),
        "needles_frost": material("NeedlesFrost", (0.16, 0.25, 0.22), 0.85),
        "snow": material("Snow", (0.93, 0.95, 0.98), 0.7),
        "rock": material("Rock", (0.45, 0.45, 0.43), 0.95),
        "fern": material("Fern", (0.2, 0.38, 0.12), 0.8),
        "wood": material("Wood", (0.62, 0.47, 0.3)),
    }


# ---------------------------------------------------------------------------
# Conifer construction
# ---------------------------------------------------------------------------

def trunk(b, mat, height, r_base, r_top, sides=7, flare=1.0, lean=(0.0, 0.0), rings=4):
    """Tapered cylinder along +Z, optionally flared at the base."""
    loops = []
    for k in range(rings + 1):
        t = k / rings
        z = height * t
        r = r_base + (r_top - r_base) * t
        if k == 0:
            r *= flare
        ox, oy = lean[0] * t * t, lean[1] * t * t
        loop = []
        for i in range(sides):
            a = TAU * i / sides
            jitter = 1.0 + (0.12 if (k == 0 and i % 2 == 0 and flare > 1.0) else 0.0)
            loop.append(b.v((ox + math.cos(a) * r * jitter, oy + math.sin(a) * r * jitter, z)))
        loops.append(loop)
    for k in range(rings):
        lo, hi = loops[k], loops[k + 1]
        for i in range(sides):
            j = (i + 1) % sides
            b.face((lo[i], lo[j], hi[j], hi[i]), mat)
    top = b.v((lean[0], lean[1], height + r_top))
    for i in range(sides):
        j = (i + 1) % sides
        b.face((loops[-1][i], loops[-1][j], top), mat)


def tier(b, rng, mat, apex, z_bottom, radius, points, droop, inner=0.72, twist=0.0,
         jitter=0.15, snow_mat=None, snow_reach=0.6, offset=(0.0, 0.0)):
    """
    One whorl of foliage: a spiky, drooping cone skirt closed underneath.
    Optionally adds a draped snow cap over the upper part of the skirt.
    """
    ax, ay, az = apex
    n = points * 2
    ring = []
    ring_co = []
    for i in range(n):
        a = twist + TAU * i / n + rng.uniform(-0.08, 0.08)
        tip = i % 2 == 0
        r = radius * (1.0 if tip else inner) * (1.0 + rng.uniform(-jitter, jitter))
        z = z_bottom - (droop * (1.0 + rng.uniform(-0.3, 0.3)) if tip else droop * 0.35)
        z = max(z, 0.25)
        co = (offset[0] + math.cos(a) * r, offset[1] + math.sin(a) * r, z)
        ring_co.append(co)
        ring.append(b.v(co))
    top = b.v(apex)
    under = b.v((offset[0], offset[1], z_bottom + (az - z_bottom) * 0.28))
    for i in range(n):
        j = (i + 1) % n
        b.face((top, ring[i], ring[j]), mat)
        b.face((under, ring[j], ring[i]), mat)

    if snow_mat is None:
        return

    # Snow cap: follows the cone surface from the apex down to `snow_reach`
    # of the way to each ring vertex, pushed slightly outward so it never
    # z-fights with the foliage underneath.
    cap_top = b.v((ax, ay, az + 0.06 * radius + 0.05))
    cap = []
    for i, co in enumerate(ring_co):
        reach = snow_reach * (1.0 + rng.uniform(-0.18, 0.12)) * (1.0 if i % 2 == 0 else 0.92)
        px = ax + (co[0] - ax) * reach
        py = ay + (co[1] - ay) * reach
        pz = az + (co[2] - az) * reach
        out = Vector((px - offset[0], py - offset[1], 0.0))
        if out.length > 1e-6:
            out.normalize()
        lift = 0.035 * radius + 0.03
        cap.append(b.v((px + out.x * lift, py + out.y * lift, pz + lift * 1.6)))
    for i in range(n):
        j = (i + 1) % n
        b.face((cap_top, cap[i], cap[j]), snow_mat)
    # Thin underside lip so the cap reads as a solid layer from below.
    lip = b.v((ax, ay, az - (az - z_bottom) * snow_reach * 0.55))
    for i in range(n):
        j = (i + 1) % n
        b.face((lip, cap[j], cap[i]), snow_mat)


def conifer(name, M, seed, height, crown_base, max_radius, tiers, points,
            foliage, trunk_mat, droop=0.35, top_radius=0.35, r_trunk=0.45,
            flare=1.3, snow=False, leader_lean=0.0, shape_pow=0.9, tier_overlap=2.2):
    rng = random.Random(seed)
    b = MeshBuilder()
    trunk(b, trunk_mat, height * 0.9, r_trunk, r_trunk * 0.18, flare=flare,
          lean=(leader_lean * 0.6, 0.0))

    span = height - crown_base
    step = span / tiers
    for k in range(tiers):
        t = k / max(1, tiers - 1)
        z_bottom = crown_base + span * t * 0.94
        # crown silhouette: wide at the bottom, narrowing to the leader
        radius = top_radius + (max_radius - top_radius) * (1.0 - t) ** shape_pow
        radius *= 1.0 + rng.uniform(-0.08, 0.08)
        tier_h = min(step * tier_overlap, radius * 1.6 + 0.6)
        lean = leader_lean * t * t
        apex_z = min(z_bottom + tier_h, height)
        if k == tiers - 1:
            apex_z = height
        mat = foliage[k % len(foliage)]
        tier(b, rng, mat,
             apex=(lean, 0.0, apex_z), z_bottom=z_bottom, radius=radius,
             points=points, droop=droop * radius * (0.6 + 0.6 * (1.0 - t)),
             twist=rng.uniform(0, TAU), offset=(lean * 0.85, 0.0),
             snow_mat=M["snow"] if snow else None,
             snow_reach=0.72 + 0.16 * (1.0 - t))
    return b.build(name)


def douglas_fir(M, name, snow, seed=1):
    return conifer(name, M, seed, height=26.0, crown_base=6.0, max_radius=4.4, tiers=11,
                   points=7, foliage=[M["needles_frost"] if snow else M["needles"],
                                      M["needles_dark"]],
                   trunk_mat=M["bark"], droop=0.45, r_trunk=0.6, snow=snow)


def hemlock(M, name, snow, seed=2):
    return conifer(name, M, seed, height=22.0, crown_base=3.5, max_radius=4.0, tiers=13,
                   points=8, foliage=[M["needles_dark"],
                                      M["needles_frost"] if snow else M["needles"]],
                   trunk_mat=M["bark"], droop=0.7, r_trunk=0.5, snow=snow,
                   leader_lean=1.4, shape_pow=1.1)


def cedar(M, name, seed=3):
    return conifer(name, M, seed, height=21.0, crown_base=2.2, max_radius=5.2, tiers=10,
                   points=9, foliage=[M["cedar"], M["needles"]], trunk_mat=M["cedar_bark"],
                   droop=0.9, r_trunk=0.75, flare=1.7, shape_pow=0.75, top_radius=0.6)


def sapling(M, name, snow, seed=4):
    return conifer(name, M, seed, height=6.5, crown_base=0.4, max_radius=2.0, tiers=6,
                   points=6, foliage=[M["needles_frost"] if snow else M["needles"]],
                   trunk_mat=M["bark"], droop=0.35, r_trunk=0.16, flare=1.1, snow=snow,
                   top_radius=0.2)


def snag(M, name, seed=5):
    """Dead standing tree: grey tapered trunk, broken top, a few stub branches."""
    rng = random.Random(seed)
    b = MeshBuilder()
    h = 15.0
    trunk(b, M["snag"], h, 0.55, 0.22, flare=1.25, rings=5)
    for _ in range(9):
        z = rng.uniform(4.0, h - 1.0)
        a = rng.uniform(0, TAU)
        r_at = 0.55 + (0.22 - 0.55) * (z / h)
        length = rng.uniform(0.8, 2.6) * (1.2 - z / h)
        base = Vector((math.cos(a) * r_at * 0.8, math.sin(a) * r_at * 0.8, z))
        tip = base + Vector((math.cos(a) * length, math.sin(a) * length, -length * 0.25))
        _stick(b, M["snag"], base, tip, 0.09)
    return b.build(name)


def _stick(b, mat, p0, p1, r, sides=4):
    axis = (p1 - p0).normalized()
    side = axis.cross(Vector((0, 0, 1)))
    if side.length < 1e-3:
        side = Vector((1, 0, 0))
    side.normalize()
    up = side.cross(axis).normalized()
    base = []
    for i in range(sides):
        a = TAU * i / sides
        base.append(b.v(p0 + (side * math.cos(a) + up * math.sin(a)) * r))
    tip = b.v(p1)
    for i in range(sides):
        j = (i + 1) % sides
        b.face((base[i], base[j], tip), mat)


# ---------------------------------------------------------------------------
# Ground clutter
# ---------------------------------------------------------------------------

def rock(M, name, seed, scale=(1.5, 1.1, 0.8), subdiv=2):
    import bmesh
    rng = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    off = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
    for v in bm.verts:
        n = noise.noise(v.co * 1.3 + off)
        n2 = noise.noise(v.co * 3.1 + off * 2.0)
        v.co *= 1.0 + 0.32 * n + 0.1 * n2
        v.co.x *= scale[0]
        v.co.y *= scale[1]
        v.co.z *= scale[2]
        if v.co.z < -0.25:
            v.co.z = -0.25 - (v.co.z + 0.25) * 0.15
        v.co.z += 0.2
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(M["rock"])
    for p in me.polygons:
        p.use_smooth = False
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def fern(M, name, seed, fronds=11):
    """Western sword fern: arching, tapering fronds with serrated edges."""
    rng = random.Random(seed)
    b = MeshBuilder()
    segs = 7
    for f in range(fronds):
        a = TAU * f / fronds + rng.uniform(-0.25, 0.25)
        length = rng.uniform(0.75, 1.15)
        elev0 = math.radians(rng.uniform(48, 72))
        width = rng.uniform(0.09, 0.12)
        d = Vector((math.cos(a), math.sin(a), 0.0))
        side = Vector((-math.sin(a), math.cos(a), 0.0))
        p = Vector((d.x * 0.03, d.y * 0.03, 0.02))
        spine, left, right = [], [], []
        for s in range(segs + 1):
            t = s / segs
            elev = elev0 - t * (elev0 + math.radians(35))
            if s > 0:
                step = length / segs
                p = p + (d * math.cos(elev) + Vector((0, 0, math.sin(elev)))) * step
            w = width * math.sin(math.pi * min(1.0, t * 1.15 + 0.08)) ** 0.6
            w *= 1.25 if s % 2 else 0.8  # serrated leaflets
            fold = Vector((0, 0, -w * 0.35))
            spine.append(b.v(p))
            left.append(b.v(p + side * w + fold))
            right.append(b.v(p - side * w + fold))
        for s in range(segs):
            b.face((spine[s], spine[s + 1], left[s + 1], left[s]), M["fern"])
            b.face((spine[s], right[s], right[s + 1], spine[s + 1]), M["fern"])
    return b.build(name)


def log(M, name, seed, length=9.0, radius=0.55, sides=8):
    """Fallen, slightly bent log lying along X with exposed wood at the ends."""
    rng = random.Random(seed)
    b = MeshBuilder()
    rings = 6
    loops = []
    for k in range(rings + 1):
        t = k / rings
        x = -length / 2 + length * t
        r = radius * (1.0 - 0.3 * t) * (1.0 + rng.uniform(-0.05, 0.05))
        bend = math.sin(t * math.pi) * 0.25
        loop = []
        for i in range(sides):
            a = TAU * i / sides
            loop.append(b.v((x, math.cos(a) * r + bend, math.sin(a) * r + r * 0.82)))
        loops.append(loop)
    for k in range(rings):
        for i in range(sides):
            j = (i + 1) % sides
            b.face((loops[k][i], loops[k + 1][i], loops[k + 1][j], loops[k][j]), M["bark"])
    for loop, flip in ((loops[0], True), (loops[-1], False)):
        cx = sum(b.verts[i][0] for i in loop) / sides
        cy = sum(b.verts[i][1] for i in loop) / sides
        cz = sum(b.verts[i][2] for i in loop) / sides
        c = b.v((cx + (-0.1 if flip else 0.1), cy, cz))
        for i in range(sides):
            j = (i + 1) % sides
            b.face((c, loop[j], loop[i]) if flip else (c, loop[i], loop[j]), M["wood"])
    # a couple of broken branch stubs
    for _ in range(4):
        x = rng.uniform(-length * 0.35, length * 0.35)
        a = rng.uniform(0.3, math.pi - 0.3)
        base = Vector((x, math.cos(a) * radius * 0.8, math.sin(a) * radius * 0.8 + radius * 0.82))
        tip = base + Vector((rng.uniform(-0.3, 0.3), math.cos(a) * 1.1, math.sin(a) * 1.1))
        _stick(b, M["bark"], base, tip, 0.08)
    return b.build(name)


def stump(M, name, seed, radius=0.8, height=1.1, sides=9):
    rng = random.Random(seed)
    b = MeshBuilder()
    bottom, top = [], []
    for i in range(sides):
        a = TAU * i / sides
        rb = radius * (1.45 if i % 3 == 0 else 1.15)
        bottom.append(b.v((math.cos(a) * rb, math.sin(a) * rb, -0.1)))
        h = height * (1.0 + rng.uniform(-0.25, 0.35))
        top.append(b.v((math.cos(a) * radius, math.sin(a) * radius, h)))
    for i in range(sides):
        j = (i + 1) % sides
        b.face((bottom[i], bottom[j], top[j], top[i]), M["bark"])
    inner = []
    for i in range(sides):
        a = TAU * i / sides
        inner.append(b.v((math.cos(a) * radius * 0.85, math.sin(a) * radius * 0.85,
                          b.verts[top[i]][2] - 0.04)))
    c = b.v((0, 0, height * 0.92))
    for i in range(sides):
        j = (i + 1) % sides
        b.face((top[i], top[j], inner[j], inner[i]), M["bark"])
        b.face((inner[i], inner[j], c), M["wood"])
    return b.build(name)


# ---------------------------------------------------------------------------

def main():
    reset_scene()
    M = mats()

    douglas_fir(M, "fir", snow=False)
    douglas_fir(M, "fir_snow", snow=True)
    hemlock(M, "hemlock", snow=False)
    hemlock(M, "hemlock_snow", snow=True)
    cedar(M, "cedar")
    sapling(M, "sapling", snow=False)
    sapling(M, "sapling_snow", snow=True)
    snag(M, "snag")

    rock(M, "rock_a", 11, (1.5, 1.1, 0.8))
    rock(M, "rock_b", 12, (1.1, 1.0, 1.05))
    rock(M, "rock_c", 13, (2.2, 1.4, 0.65))
    fern(M, "fern_a", 21)
    fern(M, "fern_b", 22, fronds=9)
    log(M, "log", 31)
    stump(M, "stump", 41)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_texcoords=False,
        export_materials="EXPORT",
    )
    total = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
    print(f"Exported {len(bpy.data.objects)} assets ({total} faces) to {OUT}")


if __name__ == "__main__":
    main()
