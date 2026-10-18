"""
Download the close-up textures (CC0, Poly Haven) and prepare them for
src/grounddetail.js (set "ground") and src/surfacedetail.js (set "surface"):
albedo + OpenGL normal map per layer, at 1024 px (desktop) and 512 px (phones),
plus a manifest.json per set with each layer's tile size and average linear
colour. Output: public/textures/<set>/.

    python3 tools/fetch_textures.py                  # fetch every set
    python3 tools/fetch_textures.py surface          # fetch one set
    python3 tools/fetch_textures.py --search moss forest leaves   # browse candidates

Needs network access to api.polyhaven.com and dl.polyhaven.org, and Pillow.
Ground layer order must match aLayers in terrain.js: floor, rock, snow, dirt (+ sand, swapped into snow's slot).
Surface layer names are looked up by material in src/surfacedetail.js.
"""

import io
import json
import os
import sys
import urllib.request

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "textures")
API = "https://api.polyhaven.com"

# (layer name, Poly Haven asset id, tile size in metres, detail strength 0..1)
SETS = {
    "ground": [
        ("floor", "forest_leaves_04", 2.2, 1.0),  # pine forest floor: needles, twigs, duff
        ("rock", "aerial_rocks_02", 6.0, 0.9),    # broken grey rock with moss in the cracks
        ("snow", "snow_02", 3.0, 0.45),           # clean snow; its dark specks need toning down
        ("dirt", "brown_mud_02", 2.0, 0.9),       # wet trail mud
        ("sand", "aerial_sand", 5.0, 0.8),        # trampled beach sand; shares snow's slot (grounddetail.js)
    ],
    "surface": [
        ("bark", "bark_brown_02", 1.6, 1.0),          # fir/hemlock, logs, stumps: furrows, moss
        ("cedar", "japanese_cedar_bark", 1.4, 1.0),   # fibrous strips, like western redcedar
        ("snag", "bark_willow_02", 1.6, 1.0),         # weathered silver-grey dead wood
        ("rock", "lichen_rock", 2.5, 0.85),           # dark basalt with grey lichen
        ("soil", "brown_mud_02", 1.2, 1.0),           # root wads: torn earth
    ],
}
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
    for set_name in sys.argv[1:] or SETS:
        fetch_set(set_name, SETS[set_name])


def fetch_set(set_name, layers):
    out = os.path.join(OUT, set_name)
    os.makedirs(out, exist_ok=True)
    manifest = {"source": "Poly Haven (CC0)", "layers": []}
    for name, asset, tile, strength in layers:
        files = json.loads(get(f"{API}/files/{asset}"))
        diff = Image.open(io.BytesIO(get(files["Diffuse"]["2k"]["jpg"]["url"]))).convert("RGB")
        nrm = Image.open(io.BytesIO(get(files["nor_gl"]["2k"]["jpg"]["url"]))).convert("RGB")
        for size in SIZES:
            diff.resize((size, size), Image.LANCZOS).save(os.path.join(out, f"{name}_{size}_albedo.jpg"), quality=86)
            nrm.resize((size, size), Image.LANCZOS).save(os.path.join(out, f"{name}_{size}_normal.jpg"), quality=92)
        small = diff.resize((64, 64), Image.BOX)
        px = list(small.get_flattened_data()) if hasattr(small, 'get_flattened_data') else list(small.getdata())
        avg = [sum(srgb_to_linear(p[i]) for p in px) / len(px) for i in range(3)]
        manifest["layers"].append({
            "name": name, "asset": asset, "tile": tile, "strength": strength, "avg": [round(a, 5) for a in avg],
            "url": f"https://polyhaven.com/a/{asset}",
        })
        print(f"{name}: {asset} avg={avg}")
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("wrote", os.path.join(out, "manifest.json"))


if __name__ == "__main__":
    main()
