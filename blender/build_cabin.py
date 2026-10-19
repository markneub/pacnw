"""
The mountain cabin in the high basin: a one-room log cabin, exported to public/models/cabin.glb
as three objects (the game finds them by name):

  cabin           the shell: log walls, gables, roof with its snow and icicles, porch, stone
                  foundation, window frames and glass, the stovepipe chimney, a woodpile
  cabin_door      the plank door, its origin on the hinge line (it swings inward about Z)
  cabin_interior  the furnishings: potbelly stove on a stone hearth, bed, table and chairs,
                  shelves, wash counter, wood box, rug, lantern, kettle...

and writes src/cabin_layout.json (door, windows, smoke, walls, colliders, in the game's Y-up
frame) so the game code always matches the model.

Blender frame (Z up): floor top at z = 0, the door in the front wall at -Y. The glTF exporter
maps (x, y, z) -> (x, z, -y), so in the game the front faces local +Z.

Run with the PyPI bpy module:  <venv>/bin/python blender/build_cabin.py
"""

import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from build_assets import MeshBuilder as _MeshBuilder, material, box as _box, recalc_normals, reset_scene, ROOT  # noqa: E402

OUT = os.path.join(ROOT, "public", "models", "cabin.glb")
LAYOUT = os.path.join(ROOT, "src", "cabin_layout.json")
TAU = math.tau

# ---- dimensions (m) ----------------------------------------------------------------------
R = 0.15  # log radius
C = 0.27  # course spacing (logs bedded into each other a little)
W = 2.3  # wall centre lines at x = +-W
D = 2.8  # and y = +-D
COURSES = 9
OVER = 0.32  # log ends run past the corners
PITCH = 0.65  # roof rise per metre
EAVE_Z = 2.6  # roof underside where it crosses the side walls
RIDGE_Z = EAVE_Z + PITCH * W
ROOF_T = 0.14  # boards + shakes
EAVE_OUT = 0.55  # roof runs past the side walls
FRONT_OUT = 1.6  # and past the front wall (over the porch)
BACK_OUT = 0.5
DOOR = (-0.46, 0.46, 1.98)  # x0, x1, top
WINDOWS = [  # wall, centre along the wall, width, sill, top
    ("left", -0.95, 0.8, 1.0, 1.75),
    ("right", -0.65, 0.75, 1.0, 1.75),
    ("back", 0.85, 0.8, 1.0, 1.75),
]
STOVE = (-1.3, 1.85)
WOOD_Y = (0.15, 2.5)  # the woodpile along the right wall, behind its window
DOOR_W = DOOR[1] - DOOR[0] - 2 * 0.07 - 0.02  # inside the jambs
DOOR_HINGE_X = DOOR[0] + 0.07 + 0.01
PIPE_R = 0.075


def roof_under(x):
    """Height of the roof's underside above x."""
    return RIDGE_Z - PITCH * abs(x)


def mats():
    return {
        "log": material("CabinLog", (0.5, 0.39, 0.28), 0.85),  # peeled logs, weathered honey-grey
        "log_end": material("CabinLogEnd", (0.6, 0.48, 0.34)),
        "board": material("CabinBoard", (0.44, 0.35, 0.26)),
        "floor": material("CabinFloor", (0.47, 0.35, 0.24), 0.8),
        "shake": material("CabinShake", (0.27, 0.22, 0.18)),
        "snow": material("CabinSnow", (0.86, 0.89, 0.93), 0.8),
        "ice": material("CabinIce", (0.8, 0.88, 0.95), 0.2),
        "trim": material("CabinTrim", (0.33, 0.25, 0.19)),
        "glass": material("CabinGlass", (0.6, 0.66, 0.7), 0.05),
        "stone": material("CabinStone", (0.47, 0.46, 0.43), 0.95),
        "iron": material("CabinIron", (0.07, 0.07, 0.075), 0.6),
        "glow": material("CabinGlow", (1.0, 0.45, 0.12)),
        "wood": material("CabinWood", (0.55, 0.4, 0.27), 0.8),
        "blanket": material("CabinBlanket", (0.5, 0.11, 0.09)),
        "cloth": material("CabinCloth", (0.74, 0.7, 0.6)),
        "rug": material("CabinRug", (0.42, 0.26, 0.17)),
        "tin": material("CabinTin", (0.46, 0.47, 0.46), 0.45),
        "lamp": material("CabinLamp", (1.0, 0.62, 0.3)),
        "bark": material("CabinBark", (0.36, 0.28, 0.21)),
    }


# ---- geometry helpers ----------------------------------------------------------------------

class MeshBuilder(_MeshBuilder):
    """
    Also records which way the wood grain runs on every face (`self.grain`, the axis set by the
    helper building it), written to the vertex colours in the game's frame (x, z, y), so the
    shader can lay the wood photo along each log and board.
    """

    def __init__(self):
        super().__init__()
        self.grain = (1.0, 0.0, 0.0)
        self.face_grain = []

    def face(self, idx, mat, flat=False, uvs=None):
        super().face(idx, mat, flat, uvs)
        self.face_grain.append(self.grain)

    def build(self, name, bake_colors=None):
        obj = super().build(name)
        mesh = obj.data
        assert len(mesh.polygons) == len(self.face_grain), "mesh.validate() dropped faces: grain would be misaligned"
        col = mesh.color_attributes.new(name="Grain", type="FLOAT_COLOR", domain="CORNER")
        for poly, (gx, gy, gz) in zip(mesh.polygons, self.face_grain):
            for li in poly.loop_indices:
                col.data[li].color = (abs(gx), abs(gz), abs(gy), 1.0)
        mesh.color_attributes.active_color = col
        return obj


def box(b, mat, cx, cy, cz, sx, sy, sz):
    """A box, its grain along its longest side."""
    dims = (sx, sy, sz)
    i = dims.index(max(dims))
    b.grain = tuple(1.0 if k == i else 0.0 for k in range(3))
    _box(b, mat, cx, cy, cz, sx, sy, sz)

def _frame(axis):
    """Two unit vectors perpendicular to `axis` (a normalised 3-tuple)."""
    ax, ay, az = axis
    ref = (0.0, 0.0, 1.0) if abs(az) < 0.9 else (1.0, 0.0, 0.0)
    ux = ay * ref[2] - az * ref[1]
    uy = az * ref[0] - ax * ref[2]
    uz = ax * ref[1] - ay * ref[0]
    l = math.sqrt(ux * ux + uy * uy + uz * uz)
    u = (ux / l, uy / l, uz / l)
    v = (ay * u[2] - az * u[1], az * u[0] - ax * u[2], ax * u[1] - ay * u[0])
    return u, v


def cyl(b, mat, p0, p1, r0, r1=None, sides=10, cap=None, rot=0.0, caps=True, flat_caps=True):
    """A (tapered) cylinder from p0 to p1; `cap` is the end material (default: mat)."""
    r1 = r0 if r1 is None else r1
    d = [p1[i] - p0[i] for i in range(3)]
    L = math.sqrt(sum(c * c for c in d))
    axis = tuple(c / L for c in d)
    b.grain = axis
    u, v = _frame(axis)
    rings = []
    for p, r in ((p0, r0), (p1, r1)):
        ring = []
        for k in range(sides):
            a = rot + TAU * k / sides
            c, s = math.cos(a) * r, math.sin(a) * r
            ring.append(b.v(tuple(p[i] + u[i] * c + v[i] * s for i in range(3))))
        rings.append(ring)
    for k in range(sides):
        j = (k + 1) % sides
        b.face((rings[0][k], rings[0][j], rings[1][j], rings[1][k]), mat)
    if caps:
        b.face(list(reversed(rings[0])), cap or mat, flat=flat_caps)
        b.face(list(rings[1]), cap or mat, flat=flat_caps)


def lathe(b, mat, profile, cx, cy, z0=0.0, sides=14, sx=1.0, sy=1.0, top_cap=True, bottom_cap=True):
    """Revolve a profile [(r, z), ...] (bottom to top) about a vertical axis at (cx, cy)."""
    b.grain = (0.0, 0.0, 1.0)
    rings = []
    for r, z in profile:
        ring = []
        for k in range(sides):
            a = TAU * k / sides
            ring.append(b.v((cx + math.cos(a) * r * sx, cy + math.sin(a) * r * sy, z0 + z)))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for k in range(sides):
            j = (k + 1) % sides
            b.face((rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k]), mat)
    if bottom_cap and profile[0][0] > 0:
        b.face(list(reversed(rings[0])), mat)
    if top_cap and profile[-1][0] > 0:
        b.face(list(rings[-1]), mat)


def quad(b, mat, a, bb, c, d, flat=True):
    b.face((b.v(a), b.v(bb), b.v(c), b.v(d)), mat, flat=flat)


def slab(b, mat, outline_top, outline_bottom, flat=True):
    """A closed solid from two matching loops of points (top and bottom)."""
    top = [b.v(p) for p in outline_top]
    bot = [b.v(p) for p in outline_bottom]
    n = len(top)
    b.face(top, mat, flat=flat)
    b.face(list(reversed(bot)), mat, flat=flat)
    for i in range(n):
        j = (i + 1) % n
        b.face((bot[i], bot[j], top[j], top[i]), mat, flat=flat)


# ---- the shell -----------------------------------------------------------------------------

def wall_openings(wall):
    """Openings in a wall as (a0, a1, z0, z1) along the wall's own axis."""
    out = []
    if wall == "front":
        out.append((DOOR[0], DOOR[1], 0.0, DOOR[2]))
    for w, c, width, sill, top in WINDOWS:
        if w == wall:
            out.append((c - width / 2, c + width / 2, sill, top))
    return out


def log_walls(b, M, rng, layout):
    """Round logs, front/back and side courses offset by half a course so they cross at the corners."""
    snapped = []  # openings snapped to the logs actually cut
    walls = {"front": (-D, "x"), "back": (D, "x"), "left": (-W, "y"), "right": (W, "y")}
    for wall, (pos, along) in walls.items():
        half = (W if along == "x" else D) + OVER
        z_off = 0.0 if along == "x" else C / 2
        opens = wall_openings(wall)
        cuts = [[o[0], o[1], 99.0, -99.0] for o in opens]  # a0, a1, lowest cut log bottom, highest cut log top
        for k in range(COURSES):
            zc = R * 0.95 + k * C + z_off
            r = R * rng.uniform(0.94, 1.06)
            # pieces of this log, split around any opening it crosses
            pieces = [(-half, half)]
            for (a0, a1, z0, z1), cut in zip(opens, cuts):
                if zc + r > z0 + 0.03 and zc - r < z1 - 0.03:
                    cut[2] = min(cut[2], zc - r)
                    cut[3] = max(cut[3], zc + r)
                    new = []
                    for p0, p1 in pieces:
                        if p1 <= a0 or p0 >= a1:
                            new.append((p0, p1))
                        else:
                            if p0 < a0:
                                new.append((p0, a0))
                            if p1 > a1:
                                new.append((a1, p1))
                    pieces = new
            rot = rng.uniform(0, TAU)
            for p0, p1 in pieces:
                if along == "x":
                    a, c = (p0, pos, zc), (p1, pos, zc)
                else:
                    a, c = (pos, p0, zc), (pos, p1, zc)
                cyl(b, M["log"], a, c, r, r * rng.uniform(0.96, 1.0), sides=10, cap=M["log_end"], rot=rot)
        for (a0, a1, z0, z1), cut in zip(opens, cuts):
            snapped.append((wall, pos, along, a0, a1, z0, z1, min(cut[2], z0), max(cut[3], z1)))
    # sill beams under the side walls (their first course sits half a course up)
    for x in (-W, W):
        box(b, M["log_end"], x, 0, C / 4 - 0.01, 0.26, 2 * D + 0.3, C / 2)
    # frames in the openings: jambs, sill and head boards through the wall's thickness
    t = 2 * R + 0.04
    for wall, pos, along, a0, a1, bottom, top, z0, z1 in snapped:
        door = wall == "front" and bottom == 0.0
        def put(ca, cz, sa, sz):
            if along == "x":
                box(b, M["trim"], ca, pos, cz, sa, t, sz)
            else:
                box(b, M["trim"], pos, ca, cz, t, sa, sz)
        fw = 0.07
        put(a0 + fw / 2, (bottom + top) / 2, fw, top - bottom)  # jambs
        put(a1 - fw / 2, (bottom + top) / 2, fw, top - bottom)
        put((a0 + a1) / 2, top - fw / 2, a1 - a0, fw)  # head
        # fill the gap between the head and the logs above it with a board
        above = z1 - top
        if above > 0.01:
            put((a0 + a1) / 2, top + above / 2, a1 - a0, above)
        if not door:
            put((a0 + a1) / 2, bottom + fw / 2, a1 - a0 + 0.08, fw)  # sill
            below = bottom - max(z0, 0.0)
            if below > 0.01:
                put((a0 + a1) / 2, z0 + below / 2, a1 - a0, below)
            # glass and muntins (a cross) in the middle of the wall
            g0, g1, gb, gt = a0 + fw, a1 - fw, bottom + fw, top - fw
            if along == "x":
                quad(b, M["glass"], (g0, pos, gb), (g1, pos, gb), (g1, pos, gt), (g0, pos, gt))
                box(b, M["trim"], (g0 + g1) / 2, pos, (gb + gt) / 2, 0.035, 0.06, gt - gb)
                box(b, M["trim"], (g0 + g1) / 2, pos, (gb + gt) / 2, g1 - g0, 0.06, 0.035)
            else:
                quad(b, M["glass"], (pos, g0, gb), (pos, g1, gb), (pos, g1, gt), (pos, g0, gt))
                box(b, M["trim"], pos, (g0 + g1) / 2, (gb + gt) / 2, 0.06, 0.035, gt - gb)
                box(b, M["trim"], pos, (g0 + g1) / 2, (gb + gt) / 2, 0.06, g1 - g0, 0.035)
            layout["windows"].append({"wall": wall, "a0": g0, "a1": g1, "z0": gb, "z1": gt})
    layout["door"]["top"] = DOOR[2]


def gables(b, M, rng):
    """Vertical boards closing the gable triangles above the front and back walls."""
    z_base = R * 0.95 + (COURSES - 1) * C + R * 0.6
    for y in (-D, D):
        x = -W - 0.05
        while x < W + 0.05:
            w = rng.uniform(0.17, 0.23)
            x1 = min(x + w, W + 0.05)
            zt0, zt1 = roof_under(x) - 0.02, roof_under(x1) - 0.02
            t = 0.05
            b.grain = (0.0, 0.0, 1.0)
            pts_top = [(x, y - t, z_base), (x1, y - t, z_base), (x1, y - t, zt1), (x, y - t, zt0)]
            pts_bot = [(x, y + t, z_base), (x1, y + t, z_base), (x1, y + t, zt1), (x, y + t, zt0)]
            slab(b, M["board"], pts_top, pts_bot)
            x = x1
        # sheathing behind the boards (no daylight through the seams)
        zt = roof_under(0) - 0.05
        b.grain = (1.0, 0.0, 0.0)
        side = -1 if y < 0 else 1
        pts = [(-W, y - side * 0.07, z_base), (W, y - side * 0.07, z_base), (0.0, y - side * 0.07, zt)]
        slab(b, M["board"], pts, [(px, py - side * 0.015, pz) for px, py, pz in pts])
        # battens over the board seams, outside only
        side = -1 if y < 0 else 1
        x = -W + 0.2
        while x < W - 0.1:
            zt = roof_under(x) - 0.06
            if zt > z_base + 0.1:
                box(b, M["trim"], x, y + side * 0.075, (z_base + zt) / 2, 0.05, 0.03, zt - z_base)
            x += 0.42


def roof(b, M, rng, layout):
    y0, y1 = -D - FRONT_OUT, D + BACK_OUT
    xe = W + EAVE_OUT
    n = math.sqrt(1 + PITCH * PITCH)
    for s in (-1, 1):
        # the roof deck: boards underneath (the ceiling), shakes on top and at the edges
        ze = roof_under(xe)
        dz = ROOF_T * n  # vertical thickness
        top = [(0, y0, RIDGE_Z + dz), (s * xe, y0, ze + dz), (s * xe, y1, ze + dz), (0, y1, RIDGE_Z + dz)]
        bot = [(0, y0, RIDGE_Z), (s * xe, y0, ze), (s * xe, y1, ze), (0, y1, RIDGE_Z)]
        if s < 0:
            top, bot = top[::-1], bot[::-1]
        b.grain = (0.0, 1.0, 0.0)
        slab(b, M["shake"], top, bot)
        # ceiling boards just under it (a separate thin layer, so the inside reads as boards)
        under = [(0, -D, RIDGE_Z - 0.005), (s * W, -D, roof_under(W) - 0.005), (s * W, D, roof_under(W) - 0.005), (0, D, RIDGE_Z - 0.005)]
        under2 = [(p[0], p[1], p[2] - 0.03) for p in under]
        if s < 0:
            under, under2 = under[::-1], under2[::-1]
        slab(b, M["board"], under, under2)
        # snow on it: a lumpy slab, thickest mid-slope, curling over the eave and the gable ends
        NX, NY = 6, 10
        grid = []
        for j in range(NY + 1):
            yy = y0 - 0.05 + (y1 - y0 + 0.1) * j / NY
            row = []
            for i in range(NX + 1):
                u = i / NX  # 0 ridge .. 1 eave
                xx = s * (0.02 + (xe + 0.06) * u)
                edge_y = min(j, NY - j) / NY
                thick = 0.24 * (0.55 + 0.45 * math.sin(math.pi * min(1, u * 1.15))) * (0.6 + 0.4 * min(1, edge_y * 5))
                thick *= rng.uniform(0.85, 1.15)
                row.append((xx, yy, roof_under(xx) + dz + thick))
            grid.append(row)
        base = [[(p[0], p[1], roof_under(p[0]) + dz - 0.01) for p in row] for row in grid]
        vt = [[b.v(p) for p in row] for row in grid]
        vb = [[b.v(p) for p in row] for row in base]
        for j in range(NY):
            for i in range(NX):
                f = (vt[j][i], vt[j][i + 1], vt[j + 1][i + 1], vt[j + 1][i])
                b.face(f if s > 0 else f[::-1], M["snow"])
        # the slab's edges (eave, gable ends): faces down to the base
        for j in range(NY):
            f = (vb[j][NX], vb[j + 1][NX], vt[j + 1][NX], vt[j][NX])
            b.face(f if s > 0 else f[::-1], M["snow"])
        for j in range(NY):
            for i in range(NX):
                f = (vb[j][i], vb[j + 1][i], vb[j + 1][i + 1], vb[j][i + 1])
                b.face(f if s > 0 else f[::-1], M["snow"])
            f = (vb[j][0], vt[j][0], vt[j + 1][0], vb[j + 1][0])
            b.face(f if s > 0 else f[::-1], M["snow"])
        for jj, sgn in ((0, -1), (NY, 1)):
            for i in range(NX):
                f = (vb[jj][i], vb[jj][i + 1], vt[jj][i + 1], vt[jj][i])
                b.face(f if (s * sgn) < 0 else f[::-1], M["snow"])
        # icicles along the eave
        yy = y0 + 0.1
        while yy < y1 - 0.1:
            L = rng.uniform(0.06, 0.45) if rng.random() < 0.75 else 0.0
            if L > 0:
                xx = s * (xe - 0.03)
                zz = roof_under(xe) + 0.01
                cyl(b, M["ice"], (xx, yy, zz), (xx, yy, zz - L), rng.uniform(0.018, 0.035), 0.002, sides=5)
            yy += rng.uniform(0.12, 0.3)
    # ridge cap of snow
    cyl(b, M["snow"], (0, y0 - 0.05, RIDGE_Z + ROOF_T * n + 0.12), (0, y1 + 0.05, RIDGE_Z + ROOF_T * n + 0.12), 0.13, sides=8, rot=0.4)
    # ridge beam and a tie beam inside
    cyl(b, M["log"], (0, -D - FRONT_OUT + 0.1, RIDGE_Z - 0.12), (0, D + BACK_OUT - 0.1, RIDGE_Z - 0.12), 0.12, sides=10, cap=M["log_end"])
    cyl(b, M["log"], (-W - 0.2, 0.2, EAVE_Z - 0.05), (W + 0.2, 0.2, EAVE_Z - 0.05), 0.11, sides=10, cap=M["log_end"])
    # purlins under the porch roof, carried by posts
    zb = roof_under(1.8) - 0.12
    for x in (-1.55, 1.55):
        cyl(b, M["log"], (x, -D - FRONT_OUT + 0.25, -0.12), (x, -D - FRONT_OUT + 0.25, zb), 0.09, sides=8, cap=M["log_end"])
    cyl(b, M["log"], (-1.8, -D - FRONT_OUT + 0.25, zb), (1.8, -D - FRONT_OUT + 0.25, zb), 0.1, sides=8, cap=M["log_end"])
    layout["roof"] = {"ridge": RIDGE_Z, "pitch": PITCH, "eaveOut": EAVE_OUT, "front": FRONT_OUT, "back": BACK_OUT}


def porch_and_foundation(b, M, rng, layout):
    # porch deck: planks across, on a frame, at floor level
    y_front = -D - FRONT_OUT + 0.15
    x = -1.7
    while x < 1.7:
        w = rng.uniform(0.15, 0.19)
        box(b, M["board"], x + w / 2, (-D - R + 0.04 + y_front) / 2, -0.03 + rng.uniform(-0.006, 0.004), w - 0.012, -D - R + 0.04 - y_front, 0.05)
        x += w
    for xx in (-1.6, 0.0, 1.6):
        box(b, M["log_end"], xx, (-D + y_front) / 2, -0.15, 0.12, -D - y_front, 0.18)
    # the threshold: a sill through the wall's thickness under the door (snow showed in the gap)
    box(b, M["log_end"], 0, -D, -0.06, DOOR[1] - DOOR[0] + 0.1, 2 * R + 0.12, 0.12)
    # skirt boards from the deck down into the snow on its open sides
    sk = 1.1
    box(b, M["trim"], 0, y_front + 0.03, -0.06 - sk / 2, 3.42, 0.04, sk)
    for xx in (-1.71, 1.71):
        box(b, M["trim"], xx, (-D + y_front) / 2, -0.06 - sk / 2, 0.04, -D - y_front, sk)
    # a step down to the snow: a solid block of timber under its tread
    box(b, M["board"], 0, y_front - 0.25, -0.25, 1.2, 0.34, 0.05)
    box(b, M["log_end"], 0, y_front - 0.25, -0.75, 1.1, 0.3, 0.95)
    layout["porch"] = {"y0": y_front - 0.45, "y1": -D, "x": 1.7}
    # the floor: planks along Y over the whole inside, on a subfloor (no snow showing in the seams)
    box(b, M["shake"], 0, 0, -0.07, 2 * W, 2 * D, 0.04)
    x = -W + R
    while x < W - R:
        w = rng.uniform(0.16, 0.2)
        x1 = min(x + w, W - R)
        box(b, M["floor"], (x + x1) / 2, 0, -0.025 + rng.uniform(-0.004, 0.003), x1 - x - 0.008, 2 * (D - R), 0.05)
        x = x1
    # stone foundation under the walls, down into the ground, with rough stones along its face
    depth = 1.4
    for (cx, cy, sx, sy) in ((0, -D, 2 * W + 0.4, 0.42), (0, D, 2 * W + 0.4, 0.42), (-W, 0, 0.42, 2 * D), (W, 0, 0.42, 2 * D)):
        box(b, M["stone"], cx, cy, -depth / 2 - 0.02, sx, sy, depth)
    import bmesh  # noqa: F401  (stones as squashed, jittered boxes)
    for k in range(70):
        side = k % 4
        t = rng.uniform(-1, 1)
        if side < 2:
            cx, cy = t * (W + 0.15), (-D if side == 0 else D) + (-1 if side == 0 else 1) * 0.2
        else:
            cx, cy = (-W if side == 2 else W) + (-1 if side == 2 else 1) * 0.2, t * (D + 0.15)
        s = rng.uniform(0.18, 0.34)
        box(b, M["stone"], cx, cy, rng.uniform(-0.45, -0.08), s * rng.uniform(1.0, 1.6), s * rng.uniform(0.6, 1.0), s * rng.uniform(0.5, 0.8))


def drifts(b, M, rng):
    """Snow banked against the back and side walls: a lumpy wedge along each, buried at its foot."""
    b.grain = (1.0, 0.0, 0.0)
    for wall in ("left", "right", "back"):
        n = 9
        if wall == "back":
            pts = [(-W - 0.4 + (2 * W + 0.8) * i / n, D + R) for i in range(n + 1)]
            out = (0.0, 1.0)
        else:
            sx = -1 if wall == "left" else 1
            y_end = D + 0.4
            y_start = -D - 0.2 if wall == "left" else WOOD_Y[0] - 0.2  # (the woodpile stands on the rest)
            pts = [(sx * (W + R), y_start + (y_end - y_start) * i / n) for i in range(n + 1)]
            out = (sx, 0.0)
        top, foot, base = [], [], []
        for k, (px, py) in enumerate(pts):
            h = rng.uniform(0.12, 0.3) * (0.5 if k in (0, n) else 1.0)
            reach = rng.uniform(0.75, 1.1)
            top.append(b.v((px - out[0] * 0.02, py - out[1] * 0.02, h)))
            foot.append(b.v((px + out[0] * reach, py + out[1] * reach, -0.45)))
            base.append(b.v((px - out[0] * 0.05, py - out[1] * 0.05, -0.6)))
        for k in range(n):
            b.face((top[k], top[k + 1], foot[k + 1], foot[k]), M["snow"])
            b.face((base[k], base[k + 1], top[k + 1], top[k]), M["snow"])
            b.face((foot[k], foot[k + 1], base[k + 1], base[k]), M["snow"])
        b.face((top[0], foot[0], base[0]), M["snow"])
        b.face((top[n], base[n], foot[n]), M["snow"])


def chimney(b, M, layout):
    sx, sy = STOVE
    z_roof = roof_under(sx)
    top = RIDGE_Z + 0.75
    cyl(b, M["iron"], (sx, sy, z_roof - 0.4), (sx, sy, top), PIPE_R + 0.01, sides=12)
    # flashing cone where it goes through the roof, a collar, and the rain cap on three legs
    lathe(b, M["tin"], [(0.26, 0.0), (0.11, 0.16), (0.09, 0.22)], sx, sy, z_roof + ROOF_T * math.sqrt(1 + PITCH * PITCH) - 0.06, sides=12, bottom_cap=False)
    lathe(b, M["iron"], [(0.21, 0.0), (0.05, 0.12)], sx, sy, top + 0.12, sides=12)
    for k in range(3):
        a = TAU * k / 3
        cyl(b, M["iron"], (sx + math.cos(a) * 0.07, sy + math.sin(a) * 0.07, top - 0.02), (sx + math.cos(a) * 0.13, sy + math.sin(a) * 0.13, top + 0.13), 0.008, sides=4)
    layout["smoke"] = [sx, top + 0.15, -sy]


def porch_lantern(b, M):
    """A tin lantern on an iron bracket beside the door."""
    lx, ly = DOOR[1] + 0.42, -D - R - 0.22
    cyl(b, M["iron"], (lx, -D - R + 0.02, 2.05), (lx, ly, 2.05), 0.012, sides=5)
    cyl(b, M["iron"], (lx, ly, 2.05), (lx, ly, 1.94), 0.006, sides=4)
    lathe(b, M["tin"], [(0.0, 0.0), (0.07, 0.0), (0.07, 0.04), (0.03, 0.05)], lx, ly, 1.62, sides=10)
    lathe(b, M["lamp"], [(0.03, 0.05), (0.05, 0.1), (0.045, 0.2), (0.03, 0.23)], lx, ly, 1.62, sides=10)
    lathe(b, M["tin"], [(0.04, 0.23), (0.06, 0.25), (0.0, 0.3)], lx, ly, 1.62, sides=10)
    for k in range(4):
        a = TAU * (k + 0.5) / 4
        cyl(b, M["tin"], (lx + math.cos(a) * 0.055, ly + math.sin(a) * 0.055, 1.66), (lx + math.cos(a) * 0.05, ly + math.sin(a) * 0.05, 1.86), 0.005, sides=4)
    cyl(b, M["iron"], (lx - 0.05, ly, 1.94), (lx + 0.05, ly, 1.94), 0.005, sides=4)


def woodpile(b, M, rng, layout):
    """Split rounds stacked against the right wall outside, under the eave, with snow on top."""
    x0 = W + 0.5
    for row in range(5):
        z = 0.12 + row * 0.21
        y = WOOD_Y[0]
        while y < WOOD_Y[1]:
            r = rng.uniform(0.08, 0.11)
            off = rng.uniform(-0.03, 0.03)
            cyl(b, M["bark"], (x0 - 0.25 + off, y, z), (x0 + 0.25 + off, y, z), r, sides=7, cap=M["log_end"], rot=rng.uniform(0, TAU))
            y += 2 * r + 0.01
    box(b, M["snow"], x0, sum(WOOD_Y) / 2, 0.12 + 4 * 0.21 + 0.16, 0.55, WOOD_Y[1] - WOOD_Y[0] + 0.1, 0.08)


# ---- the door ------------------------------------------------------------------------------

def door(M):
    """Plank door, hinged on its left edge (seen from outside) at the origin, opening toward +Y."""
    b = MeshBuilder()
    rng = random.Random(9)
    width = DOOR_W
    h = DOOR[2] - 0.07 - 0.015
    x = 0.0
    while x < width - 0.01:
        w = min(width / 5, width - x)
        box(b, M["board"], x + w / 2, 0, h / 2 + 0.005, w - 0.008, 0.045, h - rng.uniform(0, 0.01))
        x += w
    # braces on the inside: two battens and a diagonal
    for z in (0.3, h - 0.3):
        box(b, M["trim"], width / 2, 0.045, z, width - 0.1, 0.04, 0.12)
    ang = math.atan2(h - 0.6, width - 0.2)
    L = math.hypot(h - 0.6, width - 0.2)
    cxm, czm = width / 2, h / 2
    ca, sa = math.cos(ang), math.sin(ang)
    corners = []
    for dx, dz in ((-L / 2, -0.06), (L / 2, -0.06), (L / 2, 0.06), (-L / 2, 0.06)):
        corners.append((cxm + dx * ca - dz * sa, czm + dx * sa + dz * ca))
    top = [(px, 0.065, pz) for px, pz in corners]
    b.grain = (ca, 0.0, sa)
    bot = [(px, 0.025, pz) for px, pz in corners]
    slab(b, M["trim"], top, bot)
    # latch and handle (outside), a pull ring inside, strap hinges
    cyl(b, M["iron"], (width - 0.12, -0.03, 1.0), (width - 0.12, -0.09, 1.0), 0.015, sides=6)
    cyl(b, M["iron"], (width - 0.12, -0.09, 0.93), (width - 0.12, -0.09, 1.07), 0.014, sides=6)
    cyl(b, M["iron"], (width - 0.12, 0.03, 1.0), (width - 0.12, 0.07, 1.0), 0.012, sides=6)
    for z in (0.35, h - 0.35):
        box(b, M["iron"], 0.22, -0.026, z, 0.42, 0.008, 0.05)
    return recalc_normals(b.build("cabin_door"))


# ---- the furnishings -----------------------------------------------------------------------

def stove(b, M, rng):
    sx, sy = STOVE
    # stone hearth pad and a tin heat shield on standoffs behind the stove
    box(b, M["stone"], sx, sy, 0.025, 1.05, 1.05, 0.05)
    for k in range(6):
        box(b, M["stone"], sx + rng.uniform(-0.4, 0.4), sy + rng.uniform(-0.4, 0.4), 0.05, rng.uniform(0.2, 0.35), rng.uniform(0.2, 0.35), 0.012)
    box(b, M["tin"], sx, D - R - 0.06, 0.95, 1.1, 0.012, 1.4)
    box(b, M["tin"], -W + R + 0.06, sy - 0.05, 0.95, 0.012, 1.1, 1.4)
    # legs, base plate, the belly, its neck and top, ash lip
    for k in range(4):
        a = TAU * (k + 0.5) / 4
        cyl(b, M["iron"], (sx + math.cos(a) * 0.2, sy + math.sin(a) * 0.2, 0.05), (sx + math.cos(a) * 0.17, sy + math.sin(a) * 0.17, 0.27), 0.025, 0.02, sides=6)
    profile = [(0.0, 0.25), (0.25, 0.25), (0.27, 0.3), (0.2, 0.34), (0.26, 0.4), (0.31, 0.52), (0.32, 0.64), (0.29, 0.76),
               (0.22, 0.84), (0.2, 0.9), (0.25, 0.92), (0.25, 0.96), (0.17, 0.99), (0.0, 1.0)]
    lathe(b, M["iron"], profile, sx, sy, 0.0, sides=18)
    # the fire door on the front (+X toward the room), its grate glowing, and the draft vents
    fx = sx + 0.3
    box(b, M["iron"], fx + 0.015, sy, 0.6, 0.03, 0.26, 0.22)
    for k in range(4):
        box(b, M["glow"], fx + 0.032, sy - 0.08 + k * 0.053, 0.6, 0.005, 0.025, 0.15)
    cyl(b, M["iron"], (fx + 0.03, sy + 0.1, 0.6), (fx + 0.09, sy + 0.1, 0.6), 0.012, sides=5)
    box(b, M["glow"], sx + 0.255, sy, 0.36, 0.01, 0.16, 0.025)  # the ash door's draft slot
    # the stovepipe up through the ceiling, with a damper handle
    cyl(b, M["iron"], (sx, sy, 0.99), (sx, sy, roof_under(sx) - 0.38), PIPE_R, sides=12)
    cyl(b, M["iron"], (sx - 0.09, sy, 1.45), (sx + 0.12, sy, 1.45), 0.01, sides=5)
    # a kettle on top
    kx, ky = sx - 0.05, sy - 0.08
    lathe(b, M["tin"], [(0.0, 0.0), (0.1, 0.0), (0.12, 0.05), (0.11, 0.12), (0.06, 0.16), (0.03, 0.17), (0.0, 0.175)], kx, ky, 1.0, sides=12)
    cyl(b, M["tin"], (kx + 0.09, ky, 1.06), (kx + 0.19, ky, 1.14), 0.018, 0.01, sides=6)
    cyl(b, M["iron"], (kx - 0.07, ky, 1.17), (kx + 0.07, ky, 1.17), 0.008, sides=4)
    # wood box with split rounds, an axe leaning on it
    bx, by = -W + R + 0.35, 0.75
    for dx, dy, sx_, sy_ in ((0, -0.42, 0.55, 0.03), (0, 0.42, 0.55, 0.03), (-0.26, 0, 0.03, 0.85), (0.26, 0, 0.03, 0.85)):
        box(b, M["wood"], bx + dx, by + dy, 0.24, sx_, sy_, 0.48)
    box(b, M["wood"], bx, by, 0.03, 0.55, 0.85, 0.03)
    for k in range(9):
        y = by - 0.32 + (k % 4) * 0.2 + rng.uniform(-0.03, 0.03)
        z = 0.12 + (k // 4) * 0.14
        cyl(b, M["bark"], (bx - 0.24, y, z), (bx + 0.24, y + rng.uniform(-0.05, 0.05), z), rng.uniform(0.05, 0.07), sides=6, cap=M["log_end"], rot=rng.uniform(0, TAU))
    cyl(b, M["wood"], (bx + 0.32, by + 0.5, 0.0), (bx + 0.29, by + 0.42, 0.75), 0.016, sides=6)
    box(b, M["iron"], bx + 0.29, by + 0.39, 0.78, 0.04, 0.16, 0.07)


def bed(b, M, rng):
    x0, x1 = W - R - 0.98, W - R - 0.02
    y0, y1 = 0.45, D - R - 0.02
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for x in (x0 + 0.04, x1 - 0.04):
        for y in (y0 + 0.04, y1 - 0.04):
            box(b, M["log_end"], x, y, 0.3 if y > 1 else 0.25, 0.08, 0.08, 0.6 if y > 1 else 0.5)
    box(b, M["wood"], cx, y0 + 0.04, 0.3, x1 - x0, 0.05, 0.16)
    box(b, M["wood"], cx, y1 - 0.04, 0.42, x1 - x0, 0.05, 0.3)  # headboard
    for x in (x0 + 0.03, x1 - 0.03):
        box(b, M["wood"], x, cy, 0.3, 0.05, y1 - y0, 0.16)
    box(b, M["cloth"], cx, cy, 0.43, x1 - x0 - 0.08, y1 - y0 - 0.1, 0.14)  # mattress
    # the blanket: draped over the foot two thirds, hanging down the open side, folded back at the top
    yb0, yb1 = y0 + 0.03, y1 - 0.5
    top = [(x0 + 0.02, yb0, 0.515), (x1 - 0.02, yb0, 0.515), (x1 - 0.02, yb1, 0.515), (x0 + 0.02, yb1, 0.515)]
    bot = [(p[0], p[1], 0.49) for p in top]
    slab(b, M["blanket"], top, bot)
    slab(b, M["blanket"], [(x0 - 0.01, yb0, 0.51), (x0 + 0.02, yb0, 0.51), (x0 + 0.02, yb1, 0.51), (x0 - 0.01, yb1, 0.51)],
         [(x0 - 0.01, yb0, 0.2), (x0 + 0.02, yb0, 0.2), (x0 + 0.02, yb1, 0.2), (x0 - 0.01, yb1, 0.2)])
    box(b, M["blanket"], cx, yb1 + 0.06, 0.53, x1 - x0 - 0.04, 0.14, 0.04)  # the fold
    box(b, M["cloth"], cx, y1 - 0.25, 0.55, 0.62, 0.32, 0.11)  # pillow
    # a trunk at the foot of the bed: planked, iron-bound, its lid domed
    tx, ty = cx, y0 - 0.35
    box(b, M["wood"], tx, ty, 0.22, 0.8, 0.45, 0.44)
    b.grain = (1.0, 0.0, 0.0)
    cyl(b, M["wood"], (tx - 0.4, ty, 0.44), (tx + 0.4, ty, 0.44), 0.225, sides=12)
    for dx in (-0.3, 0.3):
        box(b, M["iron"], tx + dx, ty, 0.33, 0.04, 0.47, 0.67)
    box(b, M["iron"], tx, ty - 0.235, 0.4, 0.08, 0.01, 0.1)


def table_and_chairs(b, M, rng):
    tx, ty = -W + R + 0.55, -0.95
    sxw, syw = 0.8, 1.2
    box(b, M["wood"], tx, ty, 0.75, sxw, syw, 0.045)
    for dx in (-1, 1):
        for dy in (-1, 1):
            box(b, M["wood"], tx + dx * (sxw / 2 - 0.06), ty + dy * (syw / 2 - 0.08), 0.365, 0.055, 0.055, 0.73)
    box(b, M["wood"], tx, ty, 0.18, 0.04, syw - 0.2, 0.04)  # stretcher

    def chair(cx, cy, face):
        """face: direction the sitter looks (unit 2-vector)."""
        fx, fy = face
        rx, ry = -fy, fx
        box(b, M["wood"], cx, cy, 0.45, 0.42, 0.42, 0.035)
        for a in (-1, 1):
            for c in (-1, 1):
                px, py = cx + (rx * a + fx * c) * 0.17, cy + (ry * a + fy * c) * 0.17
                tall = c < 0
                box(b, M["wood"], px, py, 0.45 if tall else 0.225, 0.035, 0.035, 0.9 if tall else 0.45)
        bxx, byy = cx - fx * 0.17, cy - fy * 0.17
        box(b, M["wood"], bxx, byy, 0.78, 0.36 if abs(fy) > 0.5 else 0.03, 0.03 if abs(fy) > 0.5 else 0.36, 0.09)
        box(b, M["wood"], bxx, byy, 0.62, 0.36 if abs(fy) > 0.5 else 0.03, 0.03 if abs(fy) > 0.5 else 0.36, 0.06)

    chair(tx + 0.62, ty - 0.2, (-1, 0))
    chair(tx + 0.05, ty - 0.88, (0, 1))
    # on the table: the lantern, a mug, a plate, a book
    lx, ly = tx - 0.15, ty + 0.3
    lathe(b, M["tin"], [(0.0, 0.0), (0.075, 0.0), (0.075, 0.05), (0.03, 0.06)], lx, ly, 0.775, sides=10)
    lathe(b, M["lamp"], [(0.03, 0.06), (0.055, 0.11), (0.05, 0.19), (0.03, 0.22)], lx, ly, 0.775, sides=10)
    lathe(b, M["tin"], [(0.04, 0.22), (0.06, 0.24), (0.0, 0.27)], lx, ly, 0.775, sides=10)
    cyl(b, M["iron"], (lx - 0.06, ly, 1.04), (lx + 0.06, ly, 1.04), 0.005, sides=4)
    lathe(b, M["tin"], [(0.0, 0.0), (0.04, 0.0), (0.042, 0.09), (0.0, 0.09)], tx + 0.12, ty - 0.25, 0.775, sides=10)
    lathe(b, M["tin"], [(0.0, 0.0), (0.09, 0.0), (0.12, 0.02), (0.0, 0.02)], tx + 0.1, ty + 0.05, 0.775, sides=12)
    box(b, M["blanket"], tx - 0.12, ty - 0.35, 0.79, 0.16, 0.22, 0.035)
    box(b, M["cloth"], tx - 0.12, ty - 0.35, 0.79, 0.15, 0.215, 0.028)


def shelves_and_counter(b, M, rng):
    # shelves on the front wall, right of the door
    y = -D + R + 0.13
    for z in (1.25, 1.65):
        box(b, M["board"], 1.35, y, z, 1.25, 0.24, 0.03)
        for x in (0.85, 1.85):
            box(b, M["trim"], x, y + 0.02, z - 0.08, 0.03, 0.18, 0.14)
    xs = 0.82
    for k in range(7):  # cans, jars, a coffee pot, books
        kind = k % 4
        z0 = 1.265 if k < 4 else 1.665
        if kind == 0:
            lathe(b, M["tin"], [(0.0, 0.0), (0.04, 0.0), (0.04, 0.11), (0.0, 0.11)], xs, y, z0, sides=8)
            xs += 0.12
        elif kind == 1:
            lathe(b, M["glass"], [(0.0, 0.0), (0.05, 0.0), (0.05, 0.13), (0.03, 0.16), (0.0, 0.16)], xs, y, z0, sides=8)
            lathe(b, M["rug"], [(0.0, 0.0), (0.045, 0.0), (0.045, 0.07), (0.0, 0.07)], xs, y, z0 + 0.005, sides=8)
            xs += 0.13
        elif kind == 2:
            for j in range(4):
                box(b, [M["blanket"], M["rug"], M["trim"], M["cloth"]][j], xs + j * 0.035, y, z0 + 0.1, 0.03, 0.17, 0.2 - j * 0.015)
            xs += 0.17
        else:
            lathe(b, M["tin"], [(0.0, 0.0), (0.07, 0.0), (0.06, 0.15), (0.04, 0.2), (0.0, 0.21)], xs, y, z0, sides=10)
            xs += 0.15
        if k == 3:
            xs = 0.82
    # wash counter under the right window: a plank top on legs, an enamel basin, a bucket below
    cx, cy = W - R - 0.27, WINDOWS[1][1]
    box(b, M["wood"], cx, cy, 0.85, 0.5, 0.95, 0.04)
    for dx in (-0.2, 0.2):
        for dy in (-0.42, 0.42):
            box(b, M["wood"], cx + dx, cy + dy, 0.42, 0.045, 0.045, 0.84)
    box(b, M["wood"], cx, cy, 0.2, 0.46, 0.9, 0.025)  # low shelf
    lathe(b, M["tin"], [(0.0, 0.0), (0.12, 0.0), (0.18, 0.09), (0.19, 0.1), (0.17, 0.1), (0.11, 0.015), (0.0, 0.015)], cx, cy - 0.15, 0.87, sides=14)
    lathe(b, M["tin"], [(0.0, 0.0), (0.11, 0.0), (0.13, 0.25), (0.12, 0.25), (0.1, 0.02), (0.0, 0.02)], cx - 0.02, cy + 0.25, 0.215, sides=12)
    # a broom leaning against the wall left of the door
    cyl(b, M["wood"], (DOOR[0] - 0.24, -D + R + 0.1, 0.28), (DOOR[0] - 0.14, -D + R + 0.04, 1.42), 0.015, sides=6)
    lathe(b, M["rug"], [(0.03, 0.0), (0.13, 0.02), (0.1, 0.25), (0.03, 0.3)], DOOR[0] - 0.25, -D + R + 0.11, 0.0, sides=8, sy=0.4)
    # pegs by the door with a coat and a hat, snowshoes leaning in the corner
    for k in range(3):
        cyl(b, M["trim"], (-1.0 - k * 0.3, -D + R + 0.01, 1.62), (-1.0 - k * 0.3, -D + R + 0.12, 1.65), 0.018, sides=6)
    slab(b, M["rug"], [(-1.17, -D + R + 0.05, 1.62), (-0.85, -D + R + 0.05, 1.62), (-0.8, -D + R + 0.05, 0.95), (-1.22, -D + R + 0.05, 0.95)],
         [(-1.17, -D + R + 0.15, 1.62), (-0.85, -D + R + 0.15, 1.62), (-0.8, -D + R + 0.17, 0.95), (-1.22, -D + R + 0.17, 0.95)])
    lathe(b, M["trim"], [(0.0, 0.0), (0.16, 0.0), (0.16, 0.012), (0.09, 0.02), (0.085, 0.11), (0.0, 0.12)], -1.6, -D + R + 0.12, 1.58, sides=12)
    for k, x in enumerate((-1.95, -1.68)):  # snowshoes on the floor by the door
        lathe(b, M["trim"], [(0.0, 0.0), (0.24, 0.0), (0.24, 0.02), (0.0, 0.02)], x, -D + R + 0.3 + k * 0.04, 0.0, sides=12, sx=0.5, sy=1.0)
        lathe(b, M["rug"], [(0.0, 0.0), (0.2, 0.0), (0.2, 0.024), (0.0, 0.024)], x, -D + R + 0.3 + k * 0.04, 0.0, sides=12, sx=0.42, sy=1.0)
    # rug: concentric braided ovals in the middle of the floor
    for k, (r, m) in enumerate(((1.0, M["rug"]), (0.78, M["blanket"]), (0.55, M["rug"]), (0.3, M["cloth"]))):
        lathe(b, m, [(0.0, 0.0), (r, 0.0), (r, 0.012 + k * 0.001), (0.0, 0.012 + k * 0.001)], 0.15, 0.35, 0.001, sides=24, sx=1.0, sy=0.7)


def interior(M):
    rng = random.Random(21)
    b = MeshBuilder()
    stove(b, M, rng)
    bed(b, M, rng)
    table_and_chairs(b, M, rng)
    shelves_and_counter(b, M, rng)
    return recalc_normals(b.build("cabin_interior"))


def shell(M, layout):
    rng = random.Random(11)
    b = MeshBuilder()
    log_walls(b, M, rng, layout)
    gables(b, M, rng)
    roof(b, M, rng, layout)
    porch_and_foundation(b, M, rng, layout)
    chimney(b, M, layout)
    woodpile(b, M, rng, layout)
    porch_lantern(b, M)
    drifts(b, M, rng)
    obj = recalc_normals(b.build("cabin"))
    for poly in obj.data.polygons:  # round logs read round
        if obj.data.materials[poly.material_index].name in ("CabinLog", "CabinBark", "CabinSnow"):
            poly.use_smooth = True
    return obj


def to_game(x, y, z):
    """Blender (Z up, front -Y) -> game local (Y up, front +Z)."""
    return [round(x, 4), round(z, 4), round(-y, 4)]


def main():
    reset_scene()
    M = mats()
    layout = {"windows": [], "door": {}}
    shell(M, layout)
    door_obj = door(M)
    hinge = (DOOR_HINGE_X, -D, 0.0)
    door_obj.location = hinge  # (its own origin stays on the hinge)
    interior(M)

    # ---- layout for the game (Y up, front = +Z) ----
    inner_x, inner_y = W - R, D - R
    layout["inner"] = {"hx": inner_x, "hz": inner_y}
    layout["outer"] = {"hx": W + R, "hz": D + R}
    layout["door"].update({"hinge": to_game(*hinge), "width": DOOR_W, "x0": DOOR[0] + 0.07, "x1": DOOR[1] - 0.07})
    layout["stove"] = to_game(STOVE[0], STOVE[1], 0.62)
    layout["lamp"] = to_game(-W + R + 0.4, -0.65, 0.92)
    layout["eave"] = EAVE_Z
    for wdw in layout["windows"]:
        wdw["along"] = "x" if wdw["wall"] in ("front", "back") else "z"
    # walls as boxes in game local coords [cx, cz, hx, hz], split around the door
    t = R + 0.02
    walls = [
        [0, D, W + R, t], [-W, 0, t, D + R], [W, 0, t, D + R],
        [(-W - R + DOOR[0]) / 2, -D, (DOOR[0] - (-W - R)) / 2, t],
        [(DOOR[1] + W + R) / 2, -D, (W + R - DOOR[1]) / 2, t],
    ]
    layout["walls"] = [[cx, -cz, hx, hz] for cx, cz, hx, hz in walls]
    # furniture you walk around [cx, cz, hx, hz]
    sx, sy = STOVE
    furn = [
        [sx, sy, 0.36, 0.36],  # stove
        [-W + R + 0.35, 0.75, 0.3, 0.45],  # wood box
        [W - R - 0.5, (0.45 + D - R) / 2, 0.5, (D - R - 0.45) / 2],  # bed
        [-W + R + 0.55, -0.95, 0.42, 0.62],  # table
        [W - R - 0.27, WINDOWS[1][1], 0.27, 0.5],  # wash counter
        [(W - R - 0.98 + W - R - 0.02) / 2, 0.1, 0.42, 0.25],  # trunk
        [W + 0.5, sum(WOOD_Y) / 2, 0.32, (WOOD_Y[1] - WOOD_Y[0]) / 2 + 0.05],  # woodpile outside
    ]
    layout["furniture"] = [[cx, -cz, hx, hz] for cx, cz, hx, hz in furn]
    layout["posts"] = [[x, D + FRONT_OUT - 0.25, 0.1] for x in (-1.55, 1.55)]
    layout["porch"]["z0"] = -layout["porch"].pop("y1")
    layout["porch"]["z1"] = -layout["porch"].pop("y0")
    with open(LAYOUT, "w") as f:
        json.dump(layout, f, indent=1)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
        export_normals=True, export_texcoords=False, export_materials="EXPORT", export_vertex_color="ACTIVE",
    )
    total = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
    print(f"Exported cabin ({total} faces) to {OUT}")


if __name__ == "__main__":
    main()
