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


def salal_spray(seed=29):
    """
    A salal shoot, 2:1 (u along the shoot, base at u = 0): a zig-zag reddish
    stem with alternate, leathery ovate leaves (pointed tips, a pale midrib,
    finely toothed edges), darker and older near the base, a lighter fresh
    pair at the tip.
    """
    rng = random.Random(seed)
    W, H = 512 * SS, 256 * SS
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    stem = []
    n = 9
    for i in range(n + 1):
        f = i / n
        stem.append((0.02 * W + 0.8 * W * f, H * 0.5 + (H * 0.03 if i % 2 else -H * 0.03) * (0.3 + f)))
    for i in range(n):
        d.line([stem[i], stem[i + 1]], fill=(110, 70, 48, 255), width=int((3.2 - 1.8 * i / n) * SS))
    old, young = (34, 62, 30), (88, 122, 46)
    for i in range(1, n + 1):
        f = i / n
        bx, by = stem[i] if i < n else stem[n]
        side = 1 if i % 2 else -1
        L = H * (0.36 + 0.1 * math.sin(f * math.pi)) * rng.uniform(0.85, 1.05) * (0.75 if i == n else 1.0)
        ang = math.radians(rng.uniform(40, 62)) if i < n else 0.0
        dx, dy = math.cos(ang), side * math.sin(ang)
        px, py = -dy, dx
        col = lerp(old, young, f ** 2)
        col = tuple(max(0, min(255, c + rng.randint(-8, 8))) for c in col)
        wid = L * rng.uniform(0.55, 0.65)
        pts_a, pts_b = [], []
        steps = 16
        for k in range(steps + 1):
            g = k / steps
            half = wid * 0.5 * math.sin(math.pi * min(1.0, g * 0.95 + 0.05)) ** 0.7 * (1 - g) ** 0.35
            tooth = wid * 0.025 * (1 if k % 2 else -1) if 0 < k < steps else 0.0
            cx, cy = bx + dx * L * g, by + dy * L * g
            pts_a.append((cx + px * (half + tooth), cy + py * (half + tooth)))
            pts_b.append((cx - px * (half - tooth), cy - py * (half - tooth)))
        d.polygon(pts_a + pts_b[::-1], fill=col + (255,))
        # a lighter, glossy band on one side of the midrib, and the midrib itself
        hi = lerp(col, (150, 175, 120), 0.25)
        d.polygon([(bx + dx * L * g + px * wid * 0.18 * math.sin(math.pi * g), by + dy * L * g + py * wid * 0.18 * math.sin(math.pi * g)) for g in [k / 10 for k in range(11)]]
                  + [(bx + dx * L * g, by + dy * L * g) for g in [1 - k / 10 for k in range(11)]], fill=hi + (255,))
        d.line([(bx, by), (bx + dx * L * 0.92, by + dy * L * 0.92)], fill=lerp(col, (170, 180, 120), 0.45) + (255,), width=max(2, SS))
    return finish(img, (512, 256))


def maple_spray(seed=37):
    """
    A vine maple spray seen from above, 1:1 at 1024 px (u along the twig, base at u = 0):
    a slender twig with short side twigs, carrying opposite pairs of leaves on long
    petioles. Leaves are near-round and palmate (7-9 shallow, pointed lobes, finely
    double-toothed edges, veins from the petiole to each lobe tip with fainter side
    veins), 10-20 cm across on the card, smaller toward the tips. Each leaf is tilted
    (foreshortened along a random axis), cupped and folded along its veins (lobes
    alternately lighter/darker), lit from one side, mottled, and casts a soft shadow
    on the leaves beneath. The first version's few big flat stars read as cartoon
    cut-outs up close (the user, walking under the maples).
    """
    rng = random.Random(seed)
    nrng = np.random.default_rng(seed)
    crng = random.Random(seed + 1)  # early-fall colours: own rng, so the leaf layout is unchanged
    S2 = 2  # supersampling (1024 * 2 work size)
    N = 1024
    W = N * S2
    img = np.zeros((W, W, 4), np.float32)
    mottle = box_blur(nrng.random((W, W)).astype(np.float32), 5 * S2)
    mottle = (mottle - mottle.mean()) / (mottle.std() + 1e-6)
    fine = box_blur(nrng.random((W, W)).astype(np.float32), S2)
    fine = (fine - fine.mean()) / (fine.std() + 1e-6)
    light = (-0.55, -0.65)  # direction the light comes from (image x, y), normalised below
    ll = math.hypot(*light)
    light = (light[0] / ll, light[1] / ll)

    def stroke(pts, col, width):
        """Draw a polyline (twig, petiole) straight into the image."""
        x0 = int(max(0, min(p[0] for p in pts) - width - 2)); x1 = int(min(W, max(p[0] for p in pts) + width + 3))
        y0 = int(max(0, min(p[1] for p in pts) - width - 2)); y1 = int(min(W, max(p[1] for p in pts) + width + 3))
        if x1 <= x0 or y1 <= y0:
            return
        m_img = Image.new("L", (x1 - x0, y1 - y0), 0)
        dd = ImageDraw.Draw(m_img)
        for k in range(len(pts) - 1):
            dd.line([(pts[k][0] - x0, pts[k][1] - y0), (pts[k + 1][0] - x0, pts[k + 1][1] - y0)], fill=255,
                    width=max(1, int(round(width))))
        m = np.asarray(m_img, np.float32) / 255.0
        win = img[y0:y1, x0:x1]
        win[:, :, :3] = win[:, :, :3] * (1 - m[:, :, None]) + np.array(col, np.float32) * m[:, :, None]
        win[:, :, 3] = np.maximum(win[:, :, 3], m * 255)

    def leaf(cx, cy, R, base_ang, col, rim_col=None):
        """One leaf, its petiole arriving from direction base_ang (radians, image space)."""
        lobes = rng.choice((7, 7, 9, 9, 9))
        sinus = rng.uniform(0.6, 0.72)  # lobes cut about a third in
        tilt_ax = rng.uniform(0, TAU)
        squash = rng.uniform(0.55, 1.0)  # foreshortened: the leaf tilts away from the camera
        cup = rng.uniform(-0.25, 0.35)
        rot = base_ang  # lobes point away from the petiole; the notch at the petiole
        pts = []
        steps = lobes * 24
        tooth_ph = rng.uniform(0, 1)
        for k in range(steps):
            a = TAU * k / steps
            f = (a / TAU * lobes + 0.5) % 1.0  # 0.5 = lobe tip, 0/1 = sinus
            tip = (1.0 - abs(f - 0.5) * 2.0)
            # broad, rounded lobes with a short point, narrow V sinuses between them
            lobe = sinus + (1.0 - sinus) * (0.86 * (1.0 - (1.0 - tip) ** 2) + 0.14 * tip ** 6)
            # a deep notch where the petiole joins (the cordate base)
            da = math.atan2(math.sin(a), math.cos(a))
            notch = 1.0 - 0.28 * math.exp(-(da / 0.22) ** 2)
            # double teeth: big teeth with small ones between
            t1 = ((a / TAU * lobes * 6 + tooth_ph) % 1.0)
            t2 = ((a / TAU * lobes * 12 + tooth_ph) % 1.0)
            tooth = 0.045 * (1.0 - t1) + 0.018 * (1.0 - t2)
            r = R * (lobe * notch + tooth * (0.4 + 0.6 * tip))
            # local frame: angle 0 points back toward the petiole
            pa = a + rot + math.pi
            px, py = math.cos(pa) * r, math.sin(pa) * r
            # foreshorten along tilt_ax
            ca, sa = math.cos(tilt_ax), math.sin(tilt_ax)
            u_, v_ = px * ca + py * sa, -px * sa + py * ca
            u_ *= squash
            pts.append((cx + u_ * ca - v_ * sa, cy + u_ * sa + v_ * ca))
        x0, y0 = max(0, int(cx - R * 1.25)), max(0, int(cy - R * 1.25))
        x1, y1 = min(W, int(cx + R * 1.25) + 1), min(W, int(cy + R * 1.25) + 1)
        if x1 <= x0 or y1 <= y0:
            return
        m_img = Image.new("L", (x1 - x0, y1 - y0), 0)
        ImageDraw.Draw(m_img).polygon([(x - x0, y - y0) for x, y in pts], fill=255)
        m = np.asarray(m_img, np.float32) / 255.0
        win = img[y0:y1, x0:x1]
        # the leaf's soft shadow on what's already there (away from the light)
        off = max(1, int(R * 0.14))
        sh = np.zeros_like(m)
        sh[off:, off:] = m[:-off, :-off]
        sh = box_blur(sh, max(1, int(R * 0.08)))
        win[:, :, :3] *= (1.0 - 0.5 * sh * (win[:, :, 3] / 255.0))[:, :, None]
        # leaf-space coordinates (undo the foreshortening) for veins and shading
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        dx, dy = xx - cx, yy - cy
        ca, sa = math.cos(tilt_ax), math.sin(tilt_ax)
        u_, v_ = dx * ca + dy * sa, -dx * sa + dy * ca
        u_ /= squash
        lx, ly = u_ * ca - v_ * sa, u_ * sa + v_ * ca
        rr = np.hypot(lx, ly) / R
        ang = np.arctan2(ly, lx) - (rot + math.pi)
        fl = (ang / TAU * lobes + 0.5) % 1.0  # 0.5 on a lobe's midline
        # veins: main ones to each lobe tip, fading out, and faint side veins off them
        dv = np.abs(fl - 0.5) * (TAU / lobes) * rr * R  # distance (px) from the lobe's main vein
        vw = S2 * (1.6 - 1.1 * np.clip(rr, 0, 1))
        main_v = np.clip(1.0 - dv / vw, 0, 1) * np.clip(1.0 - rr * 0.9, 0, 1) ** 0.5
        side_ph = (rr * 9.0 - np.abs(fl - 0.5) * 4.0) % 1.0
        side_v = np.clip(1.0 - np.abs(side_ph - 0.5) * 2.0 * 7.0, 0, 1) * 0.35 * np.clip(1.0 - rr, 0, 1)
        veins = np.clip(main_v + side_v, 0, 1)
        # fold along the veins: each lobe's two halves face slightly different ways
        fold = np.where(fl > 0.5, 1.0, -1.0) * np.clip(np.abs(fl - 0.5) * 2.0, 0, 1) ** 0.5
        # a cupped / tilted leaf, lit from one side: brightness from a fake normal
        nx = lx / R * cup + 0.12 * fold * np.cos(ang + rot + math.pi + math.pi / 2)
        ny = ly / R * cup + 0.12 * fold * np.sin(ang + rot + math.pi + math.pi / 2)
        lit = 1.0 - 0.45 * (nx * light[0] + ny * light[1])
        tilt_lit = 0.85 + 0.3 * squash  # tilted-away leaves catch less of the overhead light
        rim = 1.0 - box_blur(m, max(1, int(R * 0.04)))
        shade = (lit * tilt_lit * (1.04 - 0.16 * np.clip(rr, 0, 1.2) ** 2 - 0.2 * rim)
                 * (1.0 + 0.06 * mottle[y0:y1, x0:x1] + 0.025 * fine[y0:y1, x0:x1]))
        base = np.array(col, np.float32)
        vein_col = np.array(lerp(col, (196, 214, 138), 0.32), np.float32)
        leaf_rgb = np.broadcast_to(base[None, None, :], m.shape + (3,)).copy()
        if rim_col is not None:  # a leaf starting to turn: colour creeping in from the lobe tips
            turn = np.clip((rr - 0.35) / 0.6, 0, 1)[:, :, None] ** 1.5 * 0.85
            leaf_rgb = leaf_rgb * (1 - turn) + np.array(rim_col, np.float32) * turn
        leaf_rgb = leaf_rgb * shade[:, :, None]
        leaf_rgb = leaf_rgb * (1 - 0.55 * veins[:, :, None]) + vein_col[None, None, :] * shade[:, :, None] * 0.55 * veins[:, :, None]
        win[:, :, :3] = win[:, :, :3] * (1 - m[:, :, None]) + leaf_rgb * m[:, :, None]
        win[:, :, 3] = np.maximum(win[:, :, 3], m * 255)

    def autumn(col):
        """Early fall: most leaves stay green, some turn yellow-green or gold, a few orange or red,
        and some green ones are just turning at the edges. (Saturated: CARD_TINT mutes them.) Few reds:
        red edges and leaves shrank to red dots a few metres off and read as berries. Painted yellower than
        meant: CARD_TINT applies in linear light and pushes warm colours redder (orange came out red)."""
        r = crng.random()
        if r < 0.66:
            return col, None
        if r < 0.78:
            return col, crng.choice(((210, 172, 56), (200, 182, 62), (214, 152, 52)))
        if r < 0.88:
            return lerp(col, (170, 178, 48), 0.75), None
        if r < 0.95:
            return (206, 180, 60), None
        if r < 0.99:
            return (214, 150, 54), None
        # (rare: whole red leaves shrank to red dots a few metres off, read as berries)
        return (190, 104, 50), None

    greens = [(68, 118, 36), (82, 132, 40), (96, 144, 44), (110, 152, 48), (124, 160, 54)]
    twig_col = (112, 84, 56)

    def leaf_pair(tx, ty, dir_a, scale, n_tip=False):
        """Opposite leaves on long petioles, angled forward off the twig."""
        for side in (-1, 1):
            if rng.random() < 0.1:
                continue
            R = W * rng.uniform(0.06, 0.082) * scale
            pet = R * rng.uniform(0.6, 1.0)
            a = dir_a + side * math.radians(rng.uniform(40, 75))
            px, py = tx + math.cos(a) * pet, ty + math.sin(a) * pet
            cx, cy = px + math.cos(a) * R * 0.85, py + math.sin(a) * R * 0.85
            # keep the leaf on the card (pull it in along its petiole)
            cx = min(W - R * 1.02, max(R * 1.02, cx))
            cy = min(W - R * 1.02, max(R * 1.02, cy))
            a = math.atan2(cy - ty, cx - tx)
            stroke([(tx, ty), (cx - math.cos(a) * R * 0.75, cy - math.sin(a) * R * 0.75)], (128, 108, 62), 1.7 * S2)
            col = rng.choice(greens)
            col = tuple(max(0, min(255, c + rng.randint(-8, 8))) for c in col)
            col, rim = autumn(col)
            leaf(cx, cy, R, a + math.pi, col, rim)
        if n_tip:
            R = W * 0.04 * scale
            cx, cy = tx + math.cos(dir_a) * R * 1.5, ty + math.sin(dir_a) * R * 1.5
            cx = min(W - R * 1.02, cx)
            stroke([(tx, ty), (cx - math.cos(dir_a) * R * 0.8, cy - math.sin(dir_a) * R * 0.8)], (128, 108, 62), 1.2 * S2)
            leaf(cx, cy, R, dir_a + math.pi, greens[-1])

    def twig(x, y, a, length, n_nodes, width, scale, depth):
        pts = [(x, y)]
        nodes = []
        for k in range(1, n_nodes + 1):
            # the main twig stays on the card's centre line: a real twig runs under it (build_assets.py)
            a = rng.uniform(-0.015, 0.015) if depth == 0 else a + rng.uniform(-0.1, 0.1)
            seg = length / n_nodes
            x, y = x + math.cos(a) * seg, y + math.sin(a) * seg
            pts.append((x, y))
            nodes.append((x, y, a, k))
        for k in range(len(pts) - 1):
            stroke(pts[k:k + 2], twig_col, width * (1.0 - 0.5 * k / len(pts)) * S2)
        # side twigs first (beneath), in opposite pairs like the leaves, then this twig's own leaves on top
        if depth == 0:
            for (nx_, ny_, na, k) in nodes[:-2]:
                for side in (-1, 1):
                    if rng.random() < 0.8:
                        sl = length * rng.uniform(0.34, 0.46) * (1.0 - 0.4 * k / n_nodes)
                        twig(nx_, ny_, na + side * math.radians(rng.uniform(35, 58)), sl, 3, width * 0.75, scale * 0.9, 1)
        for (nx_, ny_, na, k) in nodes:
            sc = scale * (1.0 - 0.3 * (k / n_nodes) ** 2)
            leaf_pair(nx_, ny_, na, sc, n_tip=(k == n_nodes))

    twig(0.02 * W, 0.5 * W, 0.0, 0.78 * W, 6, 5.0, 1.0, 0)
    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGBA")
    return finish(out, (N, N))


def _leaf(d, bx, by, ang, L, wid, col, rng, teeth=14, tooth=0.05, tip=0.35, vein=True):
    """An ovate leaf from (bx, by) along `ang` (radians, image space), toothed edge, midrib and a lit half."""
    dx, dy = math.cos(ang), math.sin(ang)
    px, py = -dy, dx
    pts_a, pts_b = [], []
    steps = max(teeth * 2, 12)
    for k in range(steps + 1):
        g = k / steps
        half = wid * 0.5 * math.sin(math.pi * min(1.0, g * 0.92 + 0.08)) ** 0.8 * (1 - g) ** tip
        t = wid * tooth * (1 if k % 2 else -0.3) if 0 < k < steps else 0.0
        cx, cy = bx + dx * L * g, by + dy * L * g
        pts_a.append((cx + px * (half + t), cy + py * (half + t)))
        pts_b.append((cx - px * (half + t), cy - py * (half + t)))
    d.polygon(pts_a + pts_b[::-1], fill=col + (255,))
    hi = lerp(col, (170, 200, 120), 0.22)
    d.polygon([(bx + dx * L * g + px * wid * 0.22 * math.sin(math.pi * g), by + dy * L * g + py * wid * 0.22 * math.sin(math.pi * g)) for g in [k / 10 for k in range(11)]]
              + [(bx + dx * L * g, by + dy * L * g) for g in [1 - k / 10 for k in range(11)]], fill=hi + (255,))
    if vein:
        d.line([(bx, by), (bx + dx * L * 0.9, by + dy * L * 0.9)], fill=lerp(col, (190, 205, 140), 0.4) + (255,), width=max(2, SS))
        for k in range(1, 5):
            g = k / 5.5
            for sgn in (1, -1):
                ex = bx + dx * L * (g + 0.12) + px * sgn * wid * 0.3 * (1 - g)
                ey = by + dy * L * (g + 0.12) + py * sgn * wid * 0.3 * (1 - g)
                d.line([(bx + dx * L * g, by + dy * L * g), (ex, ey)], fill=lerp(col, (150, 175, 110), 0.25) + (255,), width=max(1, SS // 2))


def salmonberry_spray(seed=43):
    """
    A salmonberry shoot (Rubus spectabilis), 2:1, u along it (base at u = 0): a pale brown,
    slightly zig-zag stem with alternate trifoliate leaves on petioles (a big, doubly toothed,
    pointed terminal leaflet and two smaller lopsided side ones), fresh mid-green. (The berries are
    3D, on the model: painted ones read flat.)
    """
    rng = random.Random(seed)
    W, H = 512 * SS, 256 * SS
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    n = 5
    stem = [(0.02 * W + 0.86 * W * i / n, H * 0.5 + (H * 0.035 if i % 2 else -H * 0.035) * (i > 0)) for i in range(n + 1)]
    for i in range(n):
        d.line([stem[i], stem[i + 1]], fill=(128, 98, 70, 255), width=int((4.0 - 2.0 * i / n) * SS))
    old, young = (48, 88, 36), (96, 140, 52)
    for i in range(1, n + 1):
        f = i / n
        bx, by = stem[i]
        side = 1 if i % 2 else -1
        if i == n:
            ang, pet = 0.0, 0.0
        else:
            ang = side * math.radians(rng.uniform(40, 58))
            pet = H * 0.09
        ex, ey = bx + math.cos(ang) * pet, by + math.sin(ang) * pet
        d.line([(bx, by), (ex, ey)], fill=(110, 120, 60, 255), width=int(2 * SS))
        col = lerp(old, young, f ** 1.5)
        col = tuple(max(0, min(255, c + rng.randint(-10, 10))) for c in col)
        sc = (0.95 if i < n else 0.8) * rng.uniform(0.88, 1.05)
        L = H * 0.37 * sc
        # side leaflets first (under the terminal one)
        for sg in (1, -1):
            _leaf(d, ex, ey, ang + sg * math.radians(rng.uniform(62, 78)), L * 0.72, L * 0.62, lerp(col, (30, 60, 25), 0.12), rng, teeth=11)
        _leaf(d, ex, ey, ang + math.radians(rng.uniform(-8, 8)), L, L * 0.66, col, rng, teeth=14)
    return finish(img, (512, 256))


def huckleberry_spray(seed=47):
    """
    A red huckleberry spray (Vaccinium parvifolium), 2:1, u along it (base at u = 0): bright green,
    angular zig-zag twigs (the main one with forking side twigs, all in one plane, as the shrub holds
    them) with small, smooth-edged oval leaves alternating along them, sparse and light. (The berries are
    3D, on the model: painted ones read flat. The draws that placed them stay, so the leaves don't move.)
    """
    rng = random.Random(seed)
    W, H = 512 * SS, 256 * SS
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    twig_col = (92, 132, 58)
    leaves = []

    def twig(x, y, ang, length, width, depth):
        n = max(3, int(length / (H * 0.07)))
        pts = [(x, y)]
        for k in range(1, n + 1):
            zig = (1 if k % 2 else -1) * math.radians(14)
            a = ang + zig
            x, y = x + math.cos(a) * length / n, y + math.sin(a) * length / n
            pts.append((x, y))
        for k in range(n):
            d.line([pts[k], pts[k + 1]], fill=twig_col + (255,), width=max(SS, int(width * (1 - 0.5 * k / n))))
        for k in range(1, n + 1):
            px, py = pts[k]
            side = 1 if k % 2 else -1
            leaves.append((px, py, ang + side * math.radians(rng.uniform(35, 60)), depth, k / n))
            if depth < 2 and k < n and rng.random() < (0.55 if depth == 0 else 0.3):
                sa = ang + side * math.radians(rng.uniform(22, 38))
                sl = length * rng.uniform(0.3, 0.42)
                # (kept on the card: shortened to what fits above/below)
                room = (py - 0.08 * H if math.sin(sa) < 0 else 0.92 * H - py) / max(0.2, abs(math.sin(sa)))
                twig(px, py, sa, min(sl, room), width * 0.7, depth + 1)
            rng.random()  # (once chose a painted berry here; kept so the leaves stay put)

    twig(0.02 * W, H * 0.5, 0.0, 0.92 * W, 3.2 * SS, 0)
    for (px, py, a, depth, f) in leaves:
        if not (0.02 * H < py < 0.98 * H):
            continue
        col = lerp((58, 104, 40), (110, 156, 60), rng.random() * 0.6 + 0.2 * f)
        L = H * rng.uniform(0.1, 0.135) * (0.8 if depth else 1.0)
        _leaf(d, px, py, a, L, L * rng.uniform(0.55, 0.65), col, rng, teeth=6, tooth=0.0, tip=0.45, vein=True)
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
    "salal_spray": salal_spray,
    "maple_spray": maple_spray,
    "salmonberry_spray": salmonberry_spray,
    "huckleberry_spray": huckleberry_spray,
}


def main():
    os.makedirs(OUT, exist_ok=True)
    import sys
    only = sys.argv[1:]  # (names to write; default all)
    for name, params in SPRAYS.items():
        if only and name not in only:
            continue
        path = os.path.join(OUT, f"{name}.png")
        (params() if callable(params) else spray(**params)).save(path, optimize=True)
        print("wrote", path, os.path.getsize(path) // 1024, "KB")


if __name__ == "__main__":
    main()
