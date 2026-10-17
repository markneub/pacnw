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


def is_cards(mat):
    """Alpha-tested foliage cards (smooth, with custom normals and UVs)."""
    return mat.name.endswith("Cards")


def card_material(name, image_path):
    """Foliage card material: base colour + alpha from an RGBA image (embedded in the GLB)."""
    if name in _materials:
        return _materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(image_path)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.85
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
        self.face_flat = []  # faces that stay faceted even in a smooth material
        self.face_uvs = []  # per face: a UV per corner, or None
        self.custom_normals = {}  # vertex index -> shading normal (foliage cards)
        self.mats = []

    def mat_index(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def v(self, co):
        self.verts.append(tuple(co))
        return len(self.verts) - 1

    def face(self, idx, mat, flat=False, uvs=None):
        self.faces.append(tuple(idx))
        self.face_mats.append(self.mat_index(mat))
        self.face_flat.append(flat)
        self.face_uvs.append(uvs)

    def build(self, name, bake_colors=None):
        """
        bake_colors: a single material to use instead of the per-face ones, with
        each face's original base colour written to a vertex colour attribute.
        Used for far-LOD models so they draw in one call.
        """
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.verts, [], self.faces)
        mesh.validate()
        if bake_colors is not None:
            mesh.materials.append(bake_colors)
            col = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
            for poly, mi in zip(mesh.polygons, self.face_mats):
                rgba = self.mats[mi].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value
                for li in poly.loop_indices:
                    col.data[li].color = tuple(rgba)
                poly.use_smooth = False
            mesh.color_attributes.active_color = col
        else:
            for m in self.mats:
                mesh.materials.append(m)
            for poly, mi, flat in zip(mesh.polygons, self.face_mats, self.face_flat):
                poly.material_index = mi
                # bark is smooth-shaded so the close-up bark texture reads as a
                # round trunk; everything else keeps the faceted low-poly look
                poly.use_smooth = (self.mats[mi].name.endswith("Bark") or is_cards(self.mats[mi])) and not flat
        if any(self.face_uvs):
            uv = mesh.uv_layers.new(name="UVMap")
            for poly, uvs in zip(mesh.polygons, self.face_uvs):
                if uvs:
                    for li, co in zip(poly.loop_indices, uvs):
                        uv.data[li].uv = co
        if self.custom_normals:
            mesh.update()
            normals = [self.custom_normals.get(i, tuple(v.normal)) for i, v in enumerate(mesh.vertices)]
            mesh.normals_split_custom_set_from_vertices(normals)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

def mats():
    return {
        "bark": material("Bark", (0.36, 0.28, 0.21)),  # greyish brown, like Douglas fir
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
        "sign_post": material("SignPost", (0.33, 0.23, 0.15)),
        "lod": material("LodVertexColor", (1.0, 1.0, 1.0), 0.85),
        "fir_cards": card_material("FirCards", os.path.join(ROOT, "public", "textures", "foliage", "fir_spray.png")),
        "hemlock_cards": card_material("HemlockCards", os.path.join(ROOT, "public", "textures", "foliage", "hemlock_spray.png")),
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
            flare=1.3, snow=False, leader_lean=0.0, shape_pow=0.9, tier_overlap=2.2, lod=False):
    """lod=True builds the far-distance version: same silhouette, ~1/5 the triangles."""
    rng = random.Random(seed)
    b = MeshBuilder()
    if lod:
        tiers = max(3, round(tiers * 0.5))
        points = 5
        tier_overlap *= 1.5
    trunk(b, trunk_mat, height * 0.9, r_trunk, r_trunk * 0.18, flare=flare,
          lean=(leader_lean * 0.6, 0.0), sides=5 if lod else 10, rings=1 if lod else 4)

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
             # LOD tiers are taller, so the same reach would bury them in snow
             snow_reach=(0.72 + 0.16 * (1.0 - t)) * (0.62 if lod else 1.0))
    return b.build(name, bake_colors=M["lod"] if lod else None)


def _card(b, mat, centre, fwd, side, length, width, droop, trunk_xy, flip_u=False):
    """One foliage card (2 tris): u along `fwd`, v along `side`; the tip end droops.
    Shading normals point away from the trunk and up, so the crown shades as a volume."""
    corners = []
    for du, dv in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
        p = centre + fwd * (du * length) + side * (dv * width)
        p.z -= droop * max(0.0, du + 0.5) ** 2
        corners.append(p)
    idx = [b.v(p) for p in corners]
    for i, p in zip(idx, corners):
        out = Vector((p.x - trunk_xy[0], p.y - trunk_xy[1], 0.0))
        r = max(out.length, 0.3)
        n = (out / r + Vector((0.0, 0.0, 0.65))).normalized()
        b.custom_normals[i] = tuple(n)
    us = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    if flip_u:
        us = [(1.0 - u, v) for u, v in us]
    b.face(idx, mat, uvs=us)


def branchy_conifer(M, name, cards, seed, height, crown_base, max_radius, r_trunk,
                    elev=(-0.12, 0.35), sag=(0.12, 0.28), card_droop=0.12, whorl=(4, 5, 5, 6),
                    spacing=(0.38, 0.6), fill=(0.2, 0.9), nod=0.0, flare=1.35):
    """
    A conifer up close: a tall trunk, bare (a few dead stubs) up to `crown_base`,
    then whorls of branches clothed in needle-spray cards, forming a ragged
    crown with gaps you can see through.
      elev       branch angle (rad) at the crown base and gained toward the top
      sag        range of how much branch tips sag (share of length)
      fill       the crown fills out over the first fill[0] of its height, then
                 tapers with exponent fill[1]
      nod        sideways bend (m) of the top of the trunk: hemlock's nodding leader
    """
    rng = random.Random(seed)
    b = MeshBuilder()
    trunk_h = height * 0.97
    taper = 0.12
    trunk(b, M["bark"], trunk_h, r_trunk, r_trunk * taper, flare=flare, sides=10, rings=8 if nod else 6,
          lean=(nod, 0.0))
    r_at = lambda z: r_trunk * (1.0 - (1.0 - taper) * z / trunk_h)
    axis_at = lambda z: Vector((nod * (z / trunk_h) ** 2, 0.0, 0.0))  # the trunk's centre line
    for _ in range(16):  # dead stubs on the bare lower trunk
        z = rng.uniform(2.5, max(3.0, crown_base + 1.0))
        a = rng.uniform(0, TAU)
        L = rng.uniform(0.3, 1.3)
        base = axis_at(z) + Vector((math.cos(a) * r_at(z) * 0.85, math.sin(a) * r_at(z) * 0.85, z))
        tip = base + Vector((math.cos(a) * L, math.sin(a) * L, -L * rng.uniform(0.1, 0.5)))
        _stick(b, M["snag"], base, tip, rng.uniform(0.03, 0.06))

    up = Vector((0.0, 0.0, 1.0))
    # normalise the crown profile so its widest point is max_radius
    prof_fn = lambda t: min(1.0, t / fill[0]) ** 0.5 * (1.0 - t) ** fill[1]
    prof_max = max(prof_fn(i / 200) for i in range(201))
    z = crown_base
    while z < height - 0.8:
        t = (z - crown_base) / (height - crown_base)
        prof = prof_fn(t) / prof_max
        nb = rng.choice(whorl)
        a0 = rng.uniform(0, TAU)
        centre = axis_at(z)
        for i in range(nb):
            if rng.random() < 0.12:
                continue  # gaps make the crown ragged and see-through
            a = a0 + TAU * i / nb + rng.uniform(-0.4, 0.4)
            L = max(0.45, max_radius * prof * rng.uniform(0.6, 1.25))
            horiz = Vector((math.cos(a), math.sin(a), 0.0))
            side0 = Vector((-math.sin(a), math.cos(a), 0.0))
            el = elev[1] * t + elev[0] + rng.uniform(-0.08, 0.08)
            sg = rng.uniform(*sag)
            base = centre + horiz * (r_at(z) * 0.8) + Vector((0.0, 0.0, z))

            def at(s):
                return base + horiz * (L * s) + up * (L * (el * s - sg * s * s))

            _stick(b, M["bark"], base, at(0.85), 0.03 + 0.025 * L)
            n_cards = max(2, round(L / 0.6))
            for k in range(n_cards):
                s = 0.22 + 0.78 * (k + 0.5) / n_cards
                c = at(s)
                fwd = (at(min(1.0, s + 0.05)) - at(max(0.0, s - 0.05))).normalized()
                roll = rng.uniform(-0.6, 0.6)
                side = side0 * math.cos(roll) + fwd.cross(side0).normalized() * math.sin(roll)
                cl = min(1.6, 0.8 + L * 0.3) * rng.uniform(0.85, 1.1)
                _card(b, cards, c, fwd, side, cl, cl * 0.9, card_droop * cl, (centre.x, centre.y), flip_u=rng.random() < 0.5)
                if rng.random() < 0.7:  # a crossed card for volume seen from the side
                    side2 = side0 * math.cos(roll + 1.4) + fwd.cross(side0).normalized() * math.sin(roll + 1.4)
                    _card(b, cards, c, fwd, side2, cl * 0.8, cl * 0.6, card_droop * 0.7 * cl, (centre.x, centre.y))
        z += rng.uniform(*spacing) * (1.0 - 0.35 * t)
    # leader: a few sprays at the top, following the trunk's bend
    top = axis_at(trunk_h)
    lead = (Vector((nod * 0.6, 0.0, 1.0)) if nod else up).normalized()
    for k in range(3):
        a = k * TAU / 3 + rng.uniform(0, 0.5)
        horiz = Vector((math.cos(a), math.sin(a), 0.0))
        c = top + Vector((horiz.x * 0.15, horiz.y * 0.15, -0.9))
        _card(b, cards, c, lead, horiz.cross(lead).normalized(), 1.4, 0.7, 0.3 if nod else 0.0, (top.x, top.y))
    return b.build(name)


def branchy_fir(M, name, seed=1):
    """Douglas fir: tall, bare for the lower third, narrow ragged crown."""
    return branchy_conifer(M, name, M["fir_cards"], seed, height=30.0, crown_base=10.5, max_radius=3.6, r_trunk=0.62)


def branchy_hemlock(M, name, seed=2):
    """Western hemlock: shade-tolerant, so the crown starts low; branches sweep
    down with pendulous tips, lacy sprays, and the leader nods over."""
    return branchy_conifer(M, name, M["hemlock_cards"], seed, height=26.0, crown_base=4.5, max_radius=4.2,
                           r_trunk=0.5, elev=(-0.3, 0.3), sag=(0.3, 0.5), card_droop=0.3,
                           spacing=(0.42, 0.62), fill=(0.1, 1.15), nod=1.3, flare=1.25)


def douglas_fir(M, name, snow, seed=1, lod=False):
    return conifer(name, M, seed, height=26.0, crown_base=6.0, max_radius=4.4, tiers=11,
                   points=7, foliage=[M["needles_frost"] if snow else M["needles"],
                                      M["needles_dark"]],
                   trunk_mat=M["bark"], droop=0.45, r_trunk=0.6, snow=snow, lod=lod)


def hemlock(M, name, snow, seed=2, lod=False):
    return conifer(name, M, seed, height=22.0, crown_base=3.5, max_radius=4.0, tiers=13,
                   points=8, foliage=[M["needles_dark"],
                                      M["needles_frost"] if snow else M["needles"]],
                   trunk_mat=M["bark"], droop=0.7, r_trunk=0.5, snow=snow,
                   leader_lean=1.4, shape_pow=1.1, lod=lod)


def cedar(M, name, seed=3, lod=False):
    return conifer(name, M, seed, height=21.0, crown_base=2.2, max_radius=5.2, tiers=10,
                   points=9, foliage=[M["cedar"], M["needles"]], trunk_mat=M["cedar_bark"],
                   droop=0.9, r_trunk=0.75, flare=1.7, shape_pow=0.75, top_radius=0.6, lod=lod)


def sapling(M, name, snow, seed=4, lod=False):
    return conifer(name, M, seed, height=6.5, crown_base=0.4, max_radius=2.0, tiers=6,
                   points=6, foliage=[M["needles_frost"] if snow else M["needles"]],
                   trunk_mat=M["bark"], droop=0.35, r_trunk=0.16, flare=1.1, snow=snow,
                   top_radius=0.2, lod=lod)


def snag_lod(M, name):
    b = MeshBuilder()
    trunk(b, M["snag"], 15.0, 0.55, 0.22, flare=1.25, sides=5, rings=1)
    return b.build(name, bake_colors=M["lod"])


def snag(M, name, seed=5):
    """Dead standing tree: grey tapered trunk, broken top, a few stub branches."""
    rng = random.Random(seed)
    b = MeshBuilder()
    h = 15.0
    trunk(b, M["snag"], h, 0.55, 0.22, flare=1.25, sides=10, rings=5)
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


def log(M, name, seed, length=9.0, radius=0.55, sides=10):
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
# Trail furniture
# ---------------------------------------------------------------------------

def recalc_normals(obj):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def prism(b, mat, outline, y0, y1, origin=(0.0, 0.0, 0.0)):
    """Extrude a convex outline given in the XZ plane between y0 and y1."""
    ox, oy, oz = origin
    front = [b.v((ox + x, oy + y0, oz + z)) for x, z in outline]
    back = [b.v((ox + x, oy + y1, oz + z)) for x, z in outline]
    b.face(front, mat, flat=True)
    b.face(list(reversed(back)), mat, flat=True)
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        b.face((front[i], front[j], back[j], back[i]), mat, flat=True)


def box(b, mat, cx, cy, cz, sx, sy, sz):
    hx, hz = sx / 2, sz / 2
    prism(b, mat, [(-hx, -hz), (hx, -hz), (hx, hz), (-hx, hz)], -sy / 2, sy / 2, (cx, cy, cz))


def signpost(M, name):
    """Trailhead post with two arrow boards pointing along local +X / -X."""
    b = MeshBuilder()
    box(b, M["sign_post"], 0, 0, 1.15, 0.14, 0.14, 2.3)
    prism(b, M["sign_post"], [(-0.07, 0), (0.07, 0), (0, 0.1)], -0.07, 0.07, (0, 0, 2.3))
    for z, d, length in ((1.85, 1, 0.95), (1.55, -1, 0.8)):
        h = 0.22
        tip = 0.16
        pts = [(0.0, -h / 2), (length, -h / 2), (length + tip, 0.0), (length, h / 2), (0.0, h / 2)]
        if d < 0:
            pts = [(-x, zz) for x, zz in reversed(pts)]
        prism(b, M["wood"], pts, 0.075, 0.115, (d * -0.05, 0, z))
    return recalc_normals(b.build(name))


def cairn(M, name, seed=51):
    """A stack of flat stones marking the route above the treeline."""
    import bmesh
    rng = random.Random(seed)
    bm = bmesh.new()
    z = 0.0
    r = 0.55
    for k in range(6):
        h = r * rng.uniform(0.45, 0.6)
        ret = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
        verts = ret["verts"]
        off = Vector((rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06), 0))
        for v in verts:
            v.co.x *= r * rng.uniform(0.9, 1.1)
            v.co.y *= r * rng.uniform(0.85, 1.05)
            v.co.z *= h / 2
            v.co += off + Vector((0, 0, z + h / 2))
        z += h * 0.85
        r *= 0.78
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(M["rock"])
    for p in me.polygons:
        p.use_smooth = False
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def bench(M, name):
    """Split-log bench; the seat runs along local X, sitter faces -Y."""
    b = MeshBuilder()
    for x in (-0.65, 0.65):
        box(b, M["bark"], x, 0, 0.22, 0.32, 0.36, 0.44)
    # half-round seat running along X: flat top, rounded underside
    n = 6
    loops = []
    for x in (-0.95, 0.95):
        loop = []
        for i in range(n + 1):
            a = math.pi + math.pi * i / n
            loop.append(b.v((x, math.cos(a) * 0.22, 0.56 + math.sin(a) * 0.12)))
        loops.append(loop)
    for i in range(n):
        b.face((loops[0][i], loops[0][i + 1], loops[1][i + 1], loops[1][i]), M["bark"])
    b.face((loops[0][0], loops[0][n], loops[1][n], loops[1][0]), M["wood"])  # flat top
    b.face(list(loops[0]), M["wood"])
    b.face(list(reversed(loops[1])), M["wood"])
    return recalc_normals(b.build(name))


# ---------------------------------------------------------------------------

def main():
    reset_scene()
    M = mats()

    branchy_fir(M, "fir")
    douglas_fir(M, "fir_snow", snow=True)
    branchy_hemlock(M, "hemlock")
    hemlock(M, "hemlock_snow", snow=True)
    cedar(M, "cedar")
    sapling(M, "sapling", snow=False)
    sapling(M, "sapling_snow", snow=True)
    snag(M, "snag")

    # far-distance versions (one material, colours in vertex colours)
    # matches the branchy fir's silhouette (only used by ?farTrees=lod; impostors bake the near model)
    conifer("fir_lod", M, 1, height=30.0, crown_base=10.5, max_radius=3.0, tiers=6, points=5,
            foliage=[M["needles"], M["needles_dark"]], trunk_mat=M["bark"], droop=0.3,
            r_trunk=0.62, lod=True)
    douglas_fir(M, "fir_snow_lod", snow=True, lod=True)
    # matches the branchy hemlock (only for ?farTrees=lod)
    conifer("hemlock_lod", M, 2, height=26.0, crown_base=4.5, max_radius=3.8, tiers=8, points=5,
            foliage=[M["needles_dark"], M["needles"]], trunk_mat=M["bark"], droop=0.8, r_trunk=0.5,
            leader_lean=1.3, shape_pow=1.1, lod=True)
    hemlock(M, "hemlock_snow_lod", snow=True, lod=True)
    cedar(M, "cedar_lod", lod=True)
    sapling(M, "sapling_lod", snow=False, lod=True)
    sapling(M, "sapling_snow_lod", snow=True, lod=True)
    snag_lod(M, "snag_lod")

    fern(M, "fern_a", 21)
    fern(M, "fern_b", 22, fronds=9)
    log(M, "log", 31)
    stump(M, "stump", 41)

    signpost(M, "signpost")
    cairn(M, "cairn")
    bench(M, "bench")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_texcoords=True,
        export_materials="EXPORT",
        export_vertex_color="ACTIVE",
    )
    total = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
    print(f"Exported {len(bpy.data.objects)} assets ({total} faces) to {OUT}")


if __name__ == "__main__":
    main()
