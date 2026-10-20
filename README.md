# Cascadia Woods

A small walkable Pacific Northwest world built with three.js. You start in a wet, foggy valley
of Douglas fir, western hemlock and red cedar with sword ferns, grassy clearings and mossy boulders, beside a misty
lake, with the Pacific surf breaking on a dune-backed beach to the south. A hiking trail leads from the trailhead at
your feet down through the dunes to the beach, along the sand and back up, past a marsh boardwalk to a lakeside bench,
then switchbacks north and up. Follow it and the land climbs where the rain turns to sleet, then snow, out onto a broad
snowfield in a forest of snow-laden firs, then up again into a high basin walled by peaks, below a pass, where the trail
ends at a log cabin with smoke rising from its stovepipe. Open the door and step in out of the snow.

Just north of the trailhead, a cave runs into the nose of a low, mossy hillock, torches burning on its walls. Far
down the tunnel the forest shows through its other end. Walk out of it and you're walking out of the same mouth
you went in by, and day has turned to night: a full moon low over the sea, a sky full of stars, moonlight falling
through the crowns. Go through again and it's day.

**Play it online:** https://markneub.github.io/pacnw/

## Running

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/ (relative paths, so it can be hosted from any sub-path)
```

The build also bakes the world (terrain heights, the trail's route and every tree, fern and stone placement) in node
into `dist/world.bin`, so the page loads it instead of generating it (~30 s of the build; cached in `.cache/world/`
until the sources change). The dev server serves the bake once it has one for the current sources; until then the
page generates the world itself while it bakes in the background. `?world=live` always generates it in the page.

Controls: click to start · **WASD** move · **Shift** run · mouse look ·
**R** cycle weather (auto → rain → snow → clear) · **H** toggle HUD · **E** or click to open a door · **Esc** release the mouse.

Pushes to the default branch are built and published to GitHub Pages by
`.github/workflows/pages.yml` (other branches just get a build check).

On phones and tablets, put your thumb down anywhere: slide up to walk (further up to run, down to back up)
and slide sideways to turn. A second finger looks up and down. Tap to open the cabin door. Nothing is drawn on screen, and weather always
follows altitude on phones. Touch devices also get a
lighter render profile (lower resolution, shorter draw distance, fewer particles); force either with
`?quality=low` or `?quality=high`.

Add `?off=trees,ferns,...` to switch parts of the scene off (see CLAUDE.md for the list) when hunting for what
costs the most on a device.

Add `?perf` to show frame times (average and worst, which is the one to watch for stutter), draw calls
and triangles, and how long each loading step took (logged, and listed on the start screen). The second line shows CPU time per frame,
plus GPU time where the browser can measure it (not Safari/iOS).

`?bench` is the accurate way to measure a device (`?bench=trees,grass&views=spawn&heat=30` runs just those rows at one
spot, after 30 s of heating the GPU up to its throttled state). After you start, it times frames at three spots with
each part of the scene switched off in turn, and at other resolutions. It then shows a table with a Copy button.

URL params for bookmarking a spot: `?x=-60&z=-250&yaw=0.4&pitch=0&weather=snow`. `?night` starts at night, `?cave=40` starts 40 m into the cave.

## How it's put together

| File | What it does |
| --- | --- |
| `blender/build_assets.py` | Procedurally models trees, ferns, logs and furniture in Blender → `public/models/forest.glb` |
| `blender/build_cabin.py` | Models the mountain cabin (shell, door, furnishings) → `public/models/cabin.glb` + `src/cabin_layout.json` |
| `src/cave.js` | The cave north of the trailhead: its tunnel and the bank it opens out of, torches (flames, flickering light, cube-map shadows), a far end that opens onto its own mouth at the other time of day; walking in and out |
| `src/cabin.js` | Places the cabin at the trail's end; its door, colliders, walkable floor, chimney smoke and interior lighting |
| `blender/build_rocks.py` | Turns photogrammetry scans into game boulders with two detail levels → `public/models/rocks.glb` |
| `src/terrain.js` | Height function (valley, lake basin, a staircase of snowy benches between ridged peaks, mountain rim, the beach and dunes in the south), vertex-coloured terrain with moss, rock and snow |
| `src/vegetation.js` | Loads the GLB, scatters ~70k trees/rocks/ferns by altitude, slope and forest-density noise, chunked `InstancedMesh`es with distance culling, trunk collisions |
| `src/trail.js` | Hiking trail: A* route over the terrain (grade-penalised, so it switchbacks), smoothed and draped as a dirt/packed-snow ribbon; distance queries keep vegetation off the tread; HUD guide to the next stop |
| `src/materials.js` | Shader patches: wind sway for foliage, moss/snow cover on rocks and logs |
| `src/atmosphere.js` | Height fog (pools in valleys), overcast sky dome, environment map for reflections, drifting mist |
| `src/detail.js` | Near pools: full-detail trees and ferns around the walker, refilled as you move |
| `src/grounddetail.js` | Close-up photographic ground detail |
| `src/surfacedetail.js` | Close-up photographic bark and rock on trees, logs, stumps and boulders |
| `src/textures.js` | Loads a texture set fetched by `tools/fetch_textures.py` |
| `src/world.js` + `tools/bake_world.mjs` | The world bake: the slow, deterministic generation (height grid, trail route, scatter) run at build time and loaded as one gzipped file |
| `src/bake.js` | Lighting baked at load: per-vertex AO on models, canopy shade map, terrain horizon AO |
| `src/perf.js` | `?perf` overlay |
| `src/bench.js` | `?bench` device benchmark |
| `src/autores.js` | Lowers render resolution if frames keep missing 60 fps |
| `src/impostors.js` | Far trees as baked billboards (8 views per tree type, lit with baked normals) |
| `tools/make_foliage.py` | Paints the needle-spray texture for the branch cards |
| `src/ocean.js` | The sea: swell refracting toward the shore, waves shoaling and breaking into bores, swash running up the sand, foam, sky reflections |
| `src/grass.js` | Grass blades around the camera (instanced tufts, GPU-placed, wind) |
| `src/weather.js` | GPU rain streaks and snowflakes in a box around the camera, fog and light that shift with altitude, procedural rain/wind audio |
| `src/player.js` | First-person walker that follows the terrain (keyboard/mouse, plus an analog `stick` and `look()` for touch) |
| `src/touch.js` | One-thumb phone controls (no on-screen UI) |
| `src/config.js` | World size, snowline, treeline, view distances, player tuning |

### Assets (Blender)

Trees, ferns, logs and trail furniture are generated by `blender/build_assets.py`. Boulders are real
photogrammetry scans, prepared by `blender/build_rocks.py` (below).

- Trees: `fir`, `hemlock`, `cedar`, `sapling`, `snag`, plus snow-laden `fir_snow`, `hemlock_snow`, `sapling_snow`
- Ground: `fern_a/b` (sword fern), `log`, `stump`
- Trail: `signpost`, `cairn`, `bench`

To regenerate after editing the script:

```bash
npm run assets                       # needs `blender` on PATH (Blender 4.2+)
# or, without a Blender install:
pip install bpy && python blender/build_assets.py
```

Object and material names in the GLB are what the JS looks up. If you rename them, update
`src/vegetation.js` too. You can also drop in other models (e.g. CC0 packs from Poly Haven or
Quaternius): add them to the GLB and give them entries in the scatter tables.

### Scanned boulders

`boulder_a`–`boulder_f` are CC0 photogrammetry scans from Poly Haven
([rock_moss_set_02](https://polyhaven.com/a/rock_moss_set_02) and
[rock_moss_set_01](https://polyhaven.com/a/rock_moss_set_01), the latter regraded from sandstone to grey).
`blender/build_rocks.py` downloads them and reduces each one to a ~1600-triangle near model and a ~220-triangle far model
(`public/models/rocks.glb`). It bakes the full scan's detail into a normal map and writes the textures to
`public/textures/rocks/` (2048 px desktop, 1024 px phones):

```bash
python blender/build_rocks.py        # with the bpy module; scans are cached in .cache/scans
```

### Close-up textures

Near the camera, the ground and objects get CC0 photo textures from [Poly Haven](https://polyhaven.com):

- Ground: [forest_leaves_04](https://polyhaven.com/a/forest_leaves_04) (forest floor),
  [aerial_rocks_02](https://polyhaven.com/a/aerial_rocks_02) (rock),
  [snow_02](https://polyhaven.com/a/snow_02) (snow) and
  [brown_mud_02](https://polyhaven.com/a/brown_mud_02) (trail dirt).
- Objects: [bark_brown_02](https://polyhaven.com/a/bark_brown_02) (fir/hemlock bark, logs, stumps),
  [japanese_cedar_bark](https://polyhaven.com/a/japanese_cedar_bark) (cedar),
  [bark_willow_02](https://polyhaven.com/a/bark_willow_02) (snags) and
  [lichen_rock](https://polyhaven.com/a/lichen_rock) (boulders, cairns).

They're committed in `public/textures/ground/` and `public/textures/surface/` at 1024 px (desktop)
and 512 px (phones). To re-fetch them, or to swap in others, edit `SETS` in `tools/fetch_textures.py`
and run it (`--search words` lists candidates).
