"""
Procedural foliage textures for the branch cards in blender/build_assets.py.

    python3 tools/make_foliage.py

Writes public/textures/foliage/<name>.png for each entry in SPRAYS (Douglas fir,
western hemlock, ...) and the sword fern frond: a twig with alternating side shoots, needles flattened into
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
TAU = 2 * math.pi


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


def finish(img, size=(SIZE, SIZE)):
    """Downsample, and bleed colour into the transparent texels (for mipmaps)."""
    img = img.resize(size, Image.LANCZOS)
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
    out = np.zeros((size[1], size[0], 4), np.uint8)
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


def fern_frond(seed=17):
    """
    A western sword fern frond, 4:1 (u along the frond, base at u = 0): a short
    scaly stipe, then alternating narrow pinnae, each toothed, with a lighter
    midrib and a small ear (auricle) on the side facing the tip. The pinnae are
    longest a third of the way up and shrink to the tip. Dark, slightly glossy
    green, younger and lighter toward the tip.
    """
    rng = random.Random(seed)
    W, H = 1024 * SS, 256 * SS
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    y_mid = H / 2
    x0, x1 = 0.01 * W, 0.985 * W
    stipe_end = 0.14
    rachis = lambda t: (x0 + (x1 - x0) * t, y_mid + math.sin(t * 5.0 + 1.0) * H * 0.012)
    old, young = (38, 74, 34), (78, 120, 50)
    n = 30  # per side
    for i in range(n * 2):
        side = 1 if i % 2 else -1
        t = stipe_end + (0.985 - stipe_end) * (i + 0.5 * rng.random()) / (n * 2)
        u = (t - stipe_end) / (1 - stipe_end)  # 0 at the first pinna, 1 at the tip
        bx, by = rachis(t)
        # lanceolate outline: longest a third of the way up
        reach = (0.47 * H) * (1 - u) ** 0.8 * (0.6 + 0.4 * min(1.0, u / 0.3)) * rng.uniform(0.9, 1.05)
        reach = max(reach, 0.035 * H)
        ang = math.radians(rng.uniform(58, 68) + 14 * u)  # from the rachis, swept toward the tip
        dx, dy = math.cos(ang), side * math.sin(ang)
        px, py = -dy, dx  # across the pinna
        if dx * px < 0:
            px, py = -px, -py  # +p points toward the frond tip
        L = reach / math.sin(ang)
        wid = L * rng.uniform(0.11, 0.14)
        col = lerp(old, young, u ** 1.5)
        col = tuple(max(0, min(255, c + rng.randint(-8, 8))) for c in col)
        # outline: base -> along the tip-facing edge (with the ear) -> pinna tip -> back along the other edge
        pts_a, pts_b = [], []
        steps = 14
        for k in range(steps + 1):
            f = k / steps
            half = wid * 0.5 * (math.sin(math.pi * min(1.0, f * 0.9 + 0.1)) ** 0.55) * (1 - f) ** 0.25
            tooth = wid * 0.09 * (1 if k % 2 else -0.4) if 0 < k < steps else 0.0
            ear = wid * 0.45 * math.exp(-((f - 0.07) / 0.06) ** 2)
            cx, cy = bx + dx * L * f, by + dy * L * f
            pts_a.append((cx + px * (half + tooth + ear), cy + py * (half + tooth + ear)))
            pts_b.append((cx - px * (half + tooth * 0.6), cy - py * (half + tooth * 0.6)))
        d.polygon(pts_a + pts_b[::-1], fill=col + (255,))
        mid = lerp(col, (150, 175, 95), 0.35)
        d.line([(bx, by), (bx + dx * L * 0.9, by + dy * L * 0.9)], fill=mid + (255,), width=max(2, SS))
    # rachis + stipe (brown, with a few pale scales)
    pts = [rachis(k / 40) for k in range(41)]
    for k in range(40):
        t = k / 40
        w = int((0.022 * (1 - t) + 0.006) * H)
        c = (112, 92, 56) if t < stipe_end else lerp((92, 108, 54), (110, 140, 70), t)
        d.line([pts[k], pts[k + 1]], fill=c + (255,), width=max(2, w))
    for _ in range(30):
        t = rng.uniform(0.0, stipe_end + 0.05)
        sx, sy = rachis(t)
        r = H * 0.012
        d.ellipse([sx - r, sy - r * 0.6 + rng.uniform(-1, 1) * H * 0.012, sx + r, sy + r * 0.6], fill=(150, 128, 92, 255))
    return finish(img, (1024, 256))


def moss_strands(seed=23):
    """
    Hanging moss and lichen ("old man's beard"), 2:1 (u = down from where it
    hangs, at u = 0): wavy strands that start in a tuft and fan out as they
    fall, pale grey-green lichen mixed with yellow-green moss, thinning toward
    the tips.
    """
    rng = random.Random(seed)
    W, H = 512 * SS, 256 * SS
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    n_locks = rng.randint(6, 8)
    for li in range(n_locks):
        # a lock: a wavy rope that hangs from the tuft and fans slightly
        v0 = H * (0.5 + rng.uniform(-0.05, 0.05))  # pinched together where it hangs from
        drift = rng.uniform(-0.32, 0.32) * H
        length = W * rng.uniform(0.45, 0.97)
        phase, freq, amp = rng.uniform(0, TAU), rng.uniform(3, 7), H * rng.uniform(0.02, 0.05)
        thick = H * rng.uniform(0.05, 0.1)
        lichen = rng.random() < 0.5
        x0 = rng.uniform(0.01, 0.08) * W
        path = lambda f: (x0 + length * f, v0 + drift * f ** 0.8 + math.sin(phase + f * freq) * amp * f)
        for _ in range(30):
            base = (150, 162, 120) if lichen else (112, 132, 58)
            col = tuple(max(0, min(255, c + rng.randint(-16, 16))) for c in base)
            off = rng.gauss(0, 0.35) * thick
            reach = rng.uniform(0.5, 1.0)
            wob = rng.uniform(0, TAU)
            pts = []
            for k in range(31):
                f = k / 30 * reach
                x, y = path(f)
                y += off * (0.15 + 1.0 * f) + math.sin(wob + f * 14) * H * 0.006
                if y < H * 0.02 or y > H * 0.98:
                    break  # a strand that leaves the card just ends there
                pts.append((x, y))
            w0 = rng.uniform(2.0, 4.0) * SS
            for k in range(len(pts) - 1):
                f = k / 30
                d.line([pts[k], pts[k + 1]], fill=col + (255,), width=max(1, int(w0 * (1 - 0.55 * f))))
    # the attached tuft: a denser clump at the top
    for _ in range(25):
        x = rng.uniform(0.0, 0.08) * W
        y = H * (0.5 + rng.gauss(0, 0.07))
        r = rng.uniform(0.008, 0.018) * H
        col = (128, 145, 80) if rng.random() < 0.5 else (150, 160, 118)
        d.ellipse([x - r * 2, y - r, x + r * 2, y + r], fill=col + (255,))
    return finish(img, (512, 256))


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
    "fern_frond": fern_frond,
    "moss_strands": moss_strands,
}


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, params in SPRAYS.items():
        path = os.path.join(OUT, f"{name}.png")
        (params() if callable(params) else spray(**params)).save(path, optimize=True)
        print("wrote", path, os.path.getsize(path) // 1024, "KB")


if __name__ == "__main__":
    main()
