"""
Tight card outlines for the foliage textures: for each spray texture, a convex
polygon (in UV space) that encloses every visible texel, with a margin for the
mipmapped alpha (patchCards boosts alpha at coarser mips, so sprays grow a
little with distance). blender/build_assets.py builds cards as these polygons
instead of full quads: the GPU then never shades the empty corners of a card,
which on phones is most of what trees cost (alpha-tested fill).

Writes blender/card_hulls.json: {texture name: [[u, v], ...]} (counter-clockwise,
u along the card's length, v across it, Blender's UV convention: v = 0 at the
image's bottom). Run after tools/make_foliage.py: python3 tools/card_hulls.py
"""
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FOLIAGE = os.path.join(ROOT, "public", "textures", "foliage")
OUT = os.path.join(ROOT, "blender", "card_hulls.json")
TEXTURES = ["fir_spray", "hemlock_spray", "cedar_spray", "snow_clumps"]
CORNERS = 4  # before clipping to the card (4-6 after): 2-4 triangles; more corners trimmed only a few % more
MARGIN = 10  # texels (of 512) around the visible spray


def cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def convex_hull(pts):
    """Andrew's monotone chain; counter-clockwise, no repeated end point."""
    pts = sorted(set(map(tuple, pts)))
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def area(poly):
    return 0.5 * abs(sum(poly[i][0] * poly[i - 1][1] - poly[i - 1][0] * poly[i][1] for i in range(len(poly))))


def line_hit(p1, p2, p3, p4):
    """Intersection of the lines p1-p2 and p3-p4 (None if parallel)."""
    d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0])
    if abs(d) < 1e-12:
        return None
    a = p1[0] * p2[1] - p1[1] * p2[0]
    b = p3[0] * p4[1] - p3[1] * p4[0]
    return ((a * (p3[0] - p4[0]) - (p1[0] - p2[0]) * b) / d, (a * (p3[1] - p4[1]) - (p1[1] - p2[1]) * b) / d)


def reduce_hull(poly, k):
    """Fewer corners, still enclosing: repeatedly drop the edge whose removal (extending its
    neighbours to meet) adds the least area. The result may poke outside the card: clip it after."""
    poly = list(poly)
    while len(poly) > k:
        best = None
        n = len(poly)
        for i in range(n):
            a, b, c, d = poly[i - 1], poly[i], poly[(i + 1) % n], poly[(i + 2) % n]
            hit = line_hit(a, b, c, d)
            if hit is None or cross(b, c, hit) > 0:  # the neighbours must meet outside this edge
                continue
            added = abs(cross(b, hit, c)) / 2
            if best is None or added < best[0]:
                best = (added, i, hit)
        if best is None:
            break
        _, i, hit = best
        j = (i + 1) % n
        poly[i] = hit
        del poly[j]
    return poly


def clip_unit(poly):
    """Sutherland-Hodgman: the polygon inside the unit square (the card)."""
    for axis, lo in ((0, True), (0, False), (1, True), (1, False)):
        inside = (lambda p: p[axis] >= 0.0) if lo else (lambda p: p[axis] <= 1.0)
        edge = 0.0 if lo else 1.0
        out = []
        for i in range(len(poly)):
            cur, prev = poly[i], poly[i - 1]
            if inside(cur) != inside(prev):
                t = (edge - prev[axis]) / (cur[axis] - prev[axis])
                out.append((prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t))
            if inside(cur):
                out.append(cur)
        poly = out
    # drop near-duplicate corners the clipping can leave
    clean = []
    for p in poly:
        if not clean or abs(p[0] - clean[-1][0]) + abs(p[1] - clean[-1][1]) > 1e-4:
            clean.append(p)
    if len(clean) > 1 and abs(clean[0][0] - clean[-1][0]) + abs(clean[0][1] - clean[-1][1]) <= 1e-4:
        clean.pop()
    return clean


def hull_for(name):
    a = np.asarray(Image.open(os.path.join(FOLIAGE, name + ".png")))[:, :, 3] / 255.0
    H, W = a.shape
    ys, xs = np.nonzero(a > 0.02)
    # every visible texel's corners, pushed out by the margin in 16 directions
    ang = np.linspace(0, 2 * np.pi, 16, endpoint=False)
    pts = []
    hull0 = convex_hull(np.stack([xs, ys], 1).tolist())  # (only the hull's points matter)
    for x, y in hull0:
        for t in ang:
            pts.append((x + 0.5 + MARGIN * np.cos(t), y + 0.5 + MARGIN * np.sin(t)))
    # to UV: u = x / W, v = 1 - y / H (Blender: v up)
    uv = [(x / W, 1.0 - y / H) for x, y in pts]
    hull = convex_hull(uv)
    full = area(clip_unit(hull))
    red = clip_unit(reduce_hull(hull, CORNERS))
    return red, full, float((a > 0.5).mean())


def main():
    out = {}
    for name in TEXTURES:
        poly, full, opaque = hull_for(name)
        out[name] = [[round(u, 4), round(v, 4)] for u, v in poly]
        print(f"{name}: {len(poly)} corners, area {area(poly):.2f} of the quad (exact hull {full:.2f}, opaque {opaque:.2f})")
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
