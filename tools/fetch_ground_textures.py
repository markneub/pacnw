"""
Download the close-up ground textures (CC0, Poly Haven) and prepare them for
src/grounddetail.js: albedo + OpenGL normal map per layer, at 1024 px (desktop)
and 512 px (phones), plus manifest.json with each layer's tile size and
average linear colour.

    python3 tools/fetch_ground_textures.py            # fetch the layers below
    python3 tools/fetch_ground_textures.py --search moss forest leaves   # browse candidates

Needs network access to api.polyhaven.com and dl.polyhaven.org, and Pillow.
Layer order must match aLayers in terrain.js: floor, rock, snow, dirt.
"""

import io
import json
import os
import sys
import urllib.request

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "textures", "ground")
API = "https://api.polyhaven.com"

# (layer name, Poly Haven asset id, tile size in metres)
# Asset ids are chosen with --search once the API is reachable.
LAYERS = [
    ("floor", None, 2.0),  # conifer forest floor: needles, moss, twigs
    ("rock", None, 4.0),   # weathered grey rock
    ("snow", None, 3.0),   # packed / wind-blown snow
    ("dirt", None, 1.6),   # trail dirt, mud
]
SIZES = (1024, 512)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cascadia-woods-asset-fetch"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def search(words):
    assets = json.loads(get(f"{API}/assets?t=textures"))
    for asset_id, info in sorted(assets.items()):
        text = " ".join([asset_id, info.get("name", "")] + info.get("tags", []) + info.get("categories", [])).lower()
        if all(w.lower() in text for w in words):
            print(f"{asset_id:32s} {info.get('name', '')} [{', '.join(info.get('categories', []))}]")


def srgb_to_linear(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--search":
        search(sys.argv[2:])
        return
    missing = [name for name, asset, _ in LAYERS if not asset]
    if missing:
        sys.exit(f"Pick Poly Haven asset ids for: {', '.join(missing)} (use --search)")

    os.makedirs(OUT, exist_ok=True)
    manifest = {"source": "Poly Haven (CC0)", "layers": []}
    for name, asset, tile in LAYERS:
        files = json.loads(get(f"{API}/files/{asset}"))
        diff = Image.open(io.BytesIO(get(files["Diffuse"]["2k"]["jpg"]["url"]))).convert("RGB")
        nrm = Image.open(io.BytesIO(get(files["nor_gl"]["2k"]["jpg"]["url"]))).convert("RGB")
        for size in SIZES:
            diff.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"{name}_{size}_albedo.jpg"), quality=86)
            nrm.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"{name}_{size}_normal.jpg"), quality=92)
        small = diff.resize((64, 64), Image.BOX)
        px = list(small.getdata())
        avg = [sum(srgb_to_linear(p[i]) for p in px) / len(px) for i in range(3)]
        manifest["layers"].append({
            "name": name, "asset": asset, "tile": tile, "avg": [round(a, 5) for a in avg],
            "url": f"https://polyhaven.com/a/{asset}",
        })
        print(f"{name}: {asset} avg={avg}")
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("wrote", os.path.join(OUT, "manifest.json"))


if __name__ == "__main__":
    main()
