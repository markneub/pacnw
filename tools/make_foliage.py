"""
Procedural foliage textures for the branch cards in blender/build_assets.py.

    python3 tools/make_foliage.py

Writes public/textures/foliage/<name>.png for each entry in SPRAYS (Douglas fir,
western hemlock): a twig with alternating side shoots, needles flattened into
two ranks, lighter new growth at the tips, on a transparent background. Card UVs: u runs along the branch
(0 = the end nearest the trunk), v across it.

The colour is bled into the transparent texels so mipmaps don't darken the
edges, and alpha is kept hard (the game alpha-tests it). Needs Pillow + numpy.
"""

import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "textures", "foliage")
SIZE = 512
SS = 3  # supersampling


def box_blur(a, r):
    """Separable box blur (twice, roughly Gaussian) of a 2D/3D float array, edge-clamped."""
    for _ in range(2):
        for axis in (0, 1):
            pad = [(0, 0)] * a.ndim
            pad[axis] = (r + 1, r)
            c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis)
            hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
            lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
            a = (hi - lo) / (2 * r + 1)
    return a


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(len(a)))


def finish(img):
    """Downsample, and bleed colour into the transparent texels (for mipmaps)."""
    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    a = np.asarray(img).astype(np.float32)
    alpha = a[:, :, 3] / 255.0
    hard = (alpha > 0.35).astype(np.float32)
    # bleed colour outward: repeated blurs of premultiplied colour
    rgb = a[:, :, :3] * hard[:, :, None]
    acc_rgb = rgb.copy()
    acc_w = hard.copy()
    cur_rgb, cur_w = rgb, hard
    for radius in (2, 4, 8, 16, 32):
        cur_rgb = box_blur(cur_rgb, radius)
        cur_w = box_blur(cur_w, radius)
        fill = (acc_w < 0.5) & (cur_w > 1e-3)
        acc_rgb[fill] = cur_rgb[fill] / cur_w[fill][:, None]
        acc_w[fill] = 1.0
    # anything the blurs didn't reach: the average needle colour
    acc_rgb[acc_w < 0.5] = rgb[hard > 0].mean(0)
    out = np.zeros((SIZE, SIZE, 4), np.uint8)
    out[:, :, :3] = np.clip(np.where(hard[:, :, None] > 0, a[:, :, :3], acc_rgb), 0, 255)
    out[:, :, 3] = (np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def spray(seed, old, new, needle_len=0.1, axis_spacing=0.0075, n_side=11, side_len=(0.46, 0.30),
          side_angle=(38, 52), side_spacing=0.008, sub_shoots=0, needle_angle=(48, 72), width=3):
    """
    A conifer spray: a main twig with alternating side shoots (optionally with
    their own sub-shoots, for lacy sprays like hemlock), needles flattened into
    two ranks. `old` -> `new` colours run from the base to the growing tips.
    """
    rng = random.Random(seed)
    W = SIZE * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    twig = (92, 70, 48)

    def needles(x0, y0, x1, y1, length, spacing, age0, age1, width):
        """Needles along a twig from (x0, y0) to (x1, y1), in two flattened ranks."""
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy)
        ux, uy = dx / L, dy / L
        px, py = -uy, ux
        n = max(2, int(L / spacing))
        for i in range(n):
            t = (i + rng.random() * 0.6) / n
            cx, cy = x0 + dx * t, y0 + dy * t
            age = age0 + (age1 - age0) * t
            col = lerp(old, new, age ** 1.6)
            col = tuple(max(0, min(255, c + rng.randint(-10, 10))) for c in col)
            for side in (-1, 1):
                a = math.radians(rng.uniform(*needle_angle))  # swept forward
                nl = length * rng.uniform(0.75, 1.1) * (0.75 + 0.25 * (1 - t))
                ex = cx + (ux * math.cos(a) + side * px * math.sin(a)) * nl
                ey = cy + (uy * math.cos(a) + side * py * math.sin(a)) * nl
                d.line([(cx, cy), (ex, ey)], fill=col + (255,), width=width)
        d.line([(x0, y0), (x1, y1)], fill=twig + (255,), width=max(2, int(width * 1.3)))

    margin = 0.06 * W
    y_mid = W / 2
    x0, x1 = margin * 0.3, W - margin
    # main axis: a gentle wiggle along u
    pts = [(x0 + (x1 - x0) * k / 6, y_mid + rng.uniform(-0.02, 0.02) * W) for k in range(7)]
    nlen = needle_len * W
    for k in range(6):
        (ax, ay), (bx, by) = pts[k], pts[k + 1]
        needles(ax, ay, bx, by, nlen, axis_spacing * W, k / 6, (k + 1) / 6, width * SS)
    # alternating side shoots, shorter toward the tip, angled forward
    for i in range(n_side):
        t = 0.08 + 0.82 * i / (n_side - 1)
        k = min(5, int(t * 6))
        f = t * 6 - k
        sx = pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f
        sy = pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f
        side = 1 if i % 2 else -1
        length = (side_len[0] - side_len[1] * t) * W * rng.uniform(0.85, 1.1)
        ang = math.radians(rng.uniform(*side_angle))
        ex = sx + math.cos(ang) * length
        ey = sy + side * math.sin(ang) * length
        # keep inside the card
        ey = min(W - margin, max(margin, ey))
        age0, age1 = t * 0.7, min(1.0, t * 0.7 + 0.45)
        needles(sx, sy, ex, ey, nlen * 0.8, side_spacing * W, age0, age1, width * SS)
        for j in range(sub_shoots):  # lacy: shoots off the side shoot, outward
            u = 0.3 + 0.55 * j / max(1, sub_shoots - 1) if sub_shoots > 1 else 0.5
            bx, by = sx + (ex - sx) * u, sy + (ey - sy) * u
            sl = length * (0.45 - 0.25 * u) * rng.uniform(0.8, 1.1)
            sa = ang + math.radians(rng.uniform(35, 50)) * (1 if j % 2 else -1)
            tx = bx + math.cos(sa) * sl
            ty = min(W - margin, max(margin, by + side * math.sin(sa) * sl))
            needles(bx, by, tx, ty, nlen * 0.7, side_spacing * W, age0 + 0.2, min(1.0, age1 + 0.2), width * SS)

    return finish(img)


def cedar_spray(seed=13):
    """
    Western redcedar: no needles; flat, fern-like fans of tiny overlapping
    scales. A main axis with alternating branchlets that branch again, each
    drawn as a chain of small scale lobes, yellow-green with lighter tips.
    """
    rng = random.Random(seed)
    W = SIZE * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    old, new = (52, 88, 34), (124, 150, 62)

    def frond(x0, y0, x1, y1, w, age0, age1):
        """A scale-covered shoot: overlapping lobes tapering toward the tip."""
        L = math.hypot(x1 - x0, y1 - y0)
        n = max(3, int(L / (w * 0.55)))
        for i in range(n + 1):
            t = i / n
            cx, cy = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            r = w * (1.0 - 0.55 * t) * rng.uniform(0.85, 1.1)
            col = lerp(old, new, (age0 + (age1 - age0) * t) ** 1.4)
            col = tuple(max(0, min(255, c + rng.randint(-8, 8))) for c in col)
            d.ellipse([cx - r, cy - r * 0.8, cx + r, cy + r * 0.8], fill=col + (255,))

    margin = 0.06 * W
    y_mid = W / 2
    x0, x1 = margin * 0.3, W - margin
    pts = [(x0 + (x1 - x0) * k / 6, y_mid + rng.uniform(-0.015, 0.015) * W) for k in range(7)]
    branchlets = []
    n_side = 16
    for i in range(n_side):
        t = 0.05 + 0.88 * i / (n_side - 1)
        k = min(5, int(t * 6))
        f = t * 6 - k
        sx = pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f
        sy = pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f
        side = 1 if i % 2 else -1
        length = (0.44 - 0.30 * t) * W * rng.uniform(0.85, 1.1)
        ang = math.radians(rng.uniform(40, 55))
        ex, ey = sx + math.cos(ang) * length, sy + side * math.sin(ang) * length
        ey = min(W - margin, max(margin, ey))
        branchlets.append((sx, sy, ex, ey, side, t, length, ang))
    # draw finest first so the main axis sits on top
    for sx, sy, ex, ey, side, t, length, ang in branchlets:
        for j in range(5):
            u = 0.2 + 0.16 * j
            bx, by = sx + (ex - sx) * u, sy + (ey - sy) * u
            sl = length * (0.5 - 0.3 * u)
            sa = ang + math.radians(rng.uniform(30, 45)) * (1 if j % 2 else -1)
            tx = bx + math.cos(sa) * sl
            ty = min(W - margin, max(margin, by + side * math.sin(sa) * sl))
            frond(bx, by, tx, ty, 0.02 * W, t * 0.6 + 0.2, min(1.0, t * 0.6 + 0.6))
    for sx, sy, ex, ey, side, t, length, ang in branchlets:
        frond(sx, sy, ex, ey, 0.026 * W, t * 0.6, min(1.0, t * 0.6 + 0.4))
    for k in range(6):
        (ax, ay), (bx, by) = pts[k], pts[k + 1]
        frond(ax, ay, bx, by, 0.032 * W, k / 6 * 0.7, (k + 1) / 6 * 0.7)
    return finish(img)


def snow_clumps(seed=17):
    """
    Snow lying on a spray: lumpy white clumps, heaviest along the middle
    (where the branch is) and thinning toward the tip, faintly blue in the
    hollows. Same card layout as the sprays (u along the branch).
    """
    rng = random.Random(seed)
    W = SIZE * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for _ in range(220):
        u = rng.random() ** 1.3  # more near the trunk end
        spread = 0.3 * (1.0 - 0.5 * u)
        v = 0.5 + rng.gauss(0, spread * 0.55)
        if abs(v - 0.5) > spread:
            continue
        r = W * rng.uniform(0.03, 0.07) * (1.0 - 0.45 * u)
        cx, cy = (0.14 + 0.72 * u) * W, v * W  # clear of the card edges (no straight cuts)
        shade = rng.uniform(0.86, 1.0)
        col = (int(232 * shade), int(238 * shade), int(248 * shade))
        d.ellipse([cx - r * 1.3, cy - r, cx + r * 1.3, cy + r], fill=col + (255,))
    # highlights on the clump tops
    for _ in range(60):
        u = rng.random() ** 1.3
        v = 0.5 + rng.gauss(0, 0.08)
        r = W * rng.uniform(0.012, 0.03) * (1.0 - 0.5 * u)
        cx, cy = (0.14 + 0.72 * u) * W, v * W
        d.ellipse([cx - r * 1.3, cy - r, cx + r * 1.3, cy + r], fill=(250, 252, 255, 255))
    return finish(img)


SPRAYS = {
    # Douglas fir: longer needles, a few stiff side shoots
    "fir_spray": dict(seed=7, old=(34, 64, 36), new=(92, 128, 52)),
    # western hemlock: short fine needles, many side shoots that fork again
    # (lacy, flat sprays), darker green with lighter tips
    "hemlock_spray": dict(seed=11, old=(26, 54, 36), new=(70, 112, 56), needle_len=0.05, axis_spacing=0.005,
                          n_side=13, side_len=(0.44, 0.26), side_angle=(48, 62), side_spacing=0.0055,
                          sub_shoots=3, needle_angle=(65, 85), width=2),
    "cedar_spray": cedar_spray,
    "snow_clumps": snow_clumps,
}


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, params in SPRAYS.items():
        path = os.path.join(OUT, f"{name}.png")
        (params() if callable(params) else spray(**params)).save(path, optimize=True)
        print("wrote", path, os.path.getsize(path) // 1024, "KB")


if __name__ == "__main__":
    main()
