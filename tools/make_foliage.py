"""
Procedural foliage textures for the branch cards in blender/build_assets.py.

    python3 tools/make_foliage.py

Writes public/textures/foliage/fir_spray.png: a Douglas fir spray (a twig with
alternating side shoots, needles flattened into two ranks, lighter new growth
at the tips) on a transparent background. Card UVs: u runs along the branch
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


def fir_spray(seed=7):
    rng = random.Random(seed)
    W = SIZE * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    old = (34, 64, 36)  # older needles, near the twig base
    new = (92, 128, 52)  # new growth at the tips
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
                a = math.radians(rng.uniform(48, 72))  # swept forward
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
    nlen = 0.1 * W
    for k in range(6):
        (ax, ay), (bx, by) = pts[k], pts[k + 1]
        needles(ax, ay, bx, by, nlen, 0.0075 * W, k / 6, (k + 1) / 6, 3 * SS)
    # alternating side shoots, shorter toward the tip, angled forward
    n_side = 11
    for i in range(n_side):
        t = 0.08 + 0.82 * i / (n_side - 1)
        k = min(5, int(t * 6))
        f = t * 6 - k
        sx = pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f
        sy = pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f
        side = 1 if i % 2 else -1
        length = (0.46 - 0.30 * t) * W * rng.uniform(0.85, 1.1)
        ang = math.radians(rng.uniform(38, 52))
        ex = sx + math.cos(ang) * length
        ey = sy + side * math.sin(ang) * length
        # keep inside the card
        ey = min(W - margin, max(margin, ey))
        needles(sx, sy, ex, ey, nlen * 0.8, 0.008 * W, t * 0.7, min(1.0, t * 0.7 + 0.45), 3 * SS)

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


def main():
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "fir_spray.png")
    fir_spray().save(path, optimize=True)
    print("wrote", path, os.path.getsize(path) // 1024, "KB")


if __name__ == "__main__":
    main()
