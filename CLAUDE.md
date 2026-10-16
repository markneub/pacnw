# Cascadia Woods: notes for Claude

Walkable low-poly Pacific Northwest forest in three.js + Vite. Valley with rain in the south (+z),
snowy ridged range in the north (−z). See README.md for the file map and controls.

## Commands

- `npm run dev` / `npm run build` (output `dist/`, `base: './'` so it works under `/pacnw/`)
- No tests or linter. Verify changes with `npm run build` plus headless screenshots (below).

## Deploy

- `.github/workflows/pages.yml` builds on every push and deploys **only from the default branch**
  (currently `claude/peaceful-johnson-ehsy3g`; it's the only branch). Live at https://markneub.github.io/pacnw/
- Pages source is set to "GitHub Actions". The proxy blocks enabling or configuring Pages via `gh api`,
  and github.io isn't reachable from the container, so check deploys with `gh run watch <id> --repo markneub/pacnw`.

## Assets (Blender)

- Every model is procedural in `blender/build_assets.py` → `public/models/forest.glb` (committed).
- No Blender binary in the container. Use the PyPI module:
  `python3 -m venv <scratch>/bvenv && <scratch>/bvenv/bin/pip install bpy` (bpy 5.x works with Python 3.13),
  then `<scratch>/bvenv/bin/python blender/build_assets.py`.
- Preview renders: Workbench/EEVEE fail (no libEGL). Use Cycles on the CPU with low samples.
- Object names (`fir`, `fir_snow`, `hemlock`, `cedar`, `sapling`, `snag`, `rock_a/b/c`, `fern_a/b`,
  `log`, `stump`, `signpost`, `cairn`, `bench`) and material names are looked up in `src/vegetation.js`. Keep them in sync.
- Blender is Z-up; the exporter converts to Y-up. Each asset is one object at the origin, with one glTF primitive per material.

## Code map / conventions

- `src/config.js`: world size, `SNOWLINE` (115), `TREELINE`, `SPAWN`, view distances, player tuning.
- `src/terrain.js`: `heightAt(x,z)` is the smooth noise height that drives terrain generation and scatter
  decisions. `groundAt(x,z)` is the height of the *rendered* triangulated mesh. Use it for anything that
  must sit on the ground (instances, player feet, trail ribbon). `snowlineAt`/`snowAmount` keep ground snow, snowy-tree choice and rain→snow consistent.
- `src/vegetation.js`: jittered-grid scatter (seeded `mulberry32`), per-125 m-chunk `InstancedMesh`
  with distance culling, collision spatial hash. Materials are patched by asset kind
  (trees/ferns → wind sway, rocks/logs/stumps → moss/snow cover) from `src/materials.js`.
- `src/trail.js`: A* over a 6 m grid between `TRAIL_STOPS` (trailhead → lake → ridge at (120,−510),
  the only gentle snowy spot). The grade penalty makes it switchback. Chaikin smoothing, then resampled
  every 1.5 m. `distanceTo` keeps scatter off the tread; `guide()` feeds the HUD. Furniture is placed in
  `vegetation.js` `placeTrailFurniture`. Mesh winding must face up (+Y) or it gets back-face culled.
- The trail is a **bench cut**: `benchHeight` (registered via `setGroundModifier`) levels the ground across
  the tread and blends cut/fill banks back to natural ground by `BANK_OUTER`, with the nearest leg winning
  (Gaussian weights) so close switchbacks keep level treads. The 5 m terrain grid can't hold that, so a
  0.5 m-resolution corridor mesh (`buildCorridorMesh`) replaces it. The terrain fragment shader discards
  inside `CUTOUT_HALF` using a 1 m mask texture (`setTerrainCutout`), and the corridor's outer edge
  alpha-fades over the terrain. `rawGroundAt` = terrain mesh height, `groundAt` = with the cut.
- Trail QA numbers (cross-slope on tread p50 ≈0, p95 ≈13%; grade p95 ≈26%) come from measuring
  `groundAt` across/along `trail.points` in node. Re-check them after changing the route or widths.
- `src/touch.js`: one-thumb scheme. The first finger is the steer: its horizontal movement turns (swipe-style, ~130° per
  screen width), and its vertical offset from the touch point is the throttle (up 80 px = full, run when
  >0.92; down = slow reverse). It sets `player.levelPitch`, which eases pitch to level. An optional second
  finger is free look. Touch mode is on when `(pointer: coarse)` matches. It skips pointer lock (tap to start) and
  turns on the low-power profile in `main.js` (`VIEW_DIST` is mutated, camera far 420, DPR ≤1.25, half the
  particles). Override with `?quality=low|high`.
- `src/weather.js`: GPU rain lines and snow points wrapped in a box around the camera, with fog/light
  lerped by altitude relative to the local snowline, and WebAudio noise ambience.
- **Realism direction (agreed): "A" = richer stylized low-poly, keeping the door open to "B" (photo-textured
  PBR assets, needle-card trees with far trees as impostors).** Keep new work asset-agnostic: lighting is
  baked from geometry (`bake.js`), materials are made in one place (`vegetation.js` `convertMaterial`), and
  shader tweaks are chunk patches that also work on textured materials.
- **No stutter rule:** build everything at load, never mid-play. No per-frame allocations (reuse vectors;
  spatial hashes use numeric `cellKey`). `warmUp()` in `main.js` renders the whole scene once off-screen
  and reads a pixel back so shader linking and buffer uploads finish during loading. Phones get the same
  features scaled by density and distance. Check with `?perf` (frame avg/worst, hitches >50 ms, load-step
  timings in the console).
- `src/atmosphere.js`: `installHeightFog()` replaces three's fog chunks globally, so it must run before
  any material compiles. **`scene.fog` is a `THREE.Fog` used as a carrier: `near` = density, `far` = time**
  (three refreshes those uniforms on every material). Fog thickens below ~18 m + 45 m falloff, and
  world-anchored noise makes drifting mist banks. Sky dome + PMREM environment
  (`scene.environmentIntensity` 0.55; foliage `envMapIntensity` 0.35 or it looks grey).
  Don't bring back camera-facing mist sprites: on phones their hard edges looked like confetti.
- Shader noise: use the sine-free hash (`fract(p.xyx * .1031)`, Hoskins). `fract(sin(x)*43758)` is
  unreliable on mobile GPUs.
- `src/bake.js`: prototype vertex AO (vertex colours × instance colours), `bakeCanopy` (2 m grid) feeds
  instance tints and `shadeGround` (terrain + corridor), and `horizonAO` from the terrain grid.
  `shared.uWet` (from `weather.js`) drives wet darkening/gloss (`wetChunks`), trail puddles and lake rain
  rings.
- Loading screen: `progress(to, expectedMs)` in `main.js` animates the bar with a compositor transform,
  so it keeps moving while a blocking step runs. Re-tune the expected times if loading steps change.
- Everything is deterministic from `SEED`. Changing noise or scatter order moves every tree.
- Perf at spawn: ~3.1M tris, ~450 draw calls. Watch this when adding instanced content. Load in the container
  (SwiftShader): ~11 s, ~8 s of it the software-rendered warm-up. It's much faster on a real GPU.

## Headless screenshots (how to see the scene)

- Chromium is at `/opt/pw-browsers`, and Playwright is installed globally at `/opt/node-tools/node_modules/playwright`.
- Launch args: `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`.
- `page.screenshot()` and `waitForFunction` hang with SwiftShader. Instead load
  `http://localhost:4173/?autostart&still=4&x=..&z=..&yaw=..&pitch=..[&weather=rain|snow|clear]`
  (after `npx vite preview --port 4173`). Poll `window.__still` with `page.waitForTimeout` + `evaluate`,
  then decode that PNG data URL. `still=N` renders N frames, captures the canvas, then stops the loop.
- Yaw 0 faces −z (north); positive yaw turns left.
- Phone testing: a Playwright context with `devices['iPhone 13']` (hasTouch + coarse pointer). Drive it with CDP
  `Input.dispatchTouchEvent` (multi-touch works). Without `still`, grab frames via
  `renderer.render(); renderer.domElement.toDataURL()` inside one `evaluate`. `page.screenshot()` does work
  for DOM-only views like the start overlay.
- Good spots: spawn (default), lake `x=110&z=470&yaw=-0.67`, snowy slope `x=-60&z=-250&yaw=0.4`,
  high snow `x=-200&z=-450&yaw=2.8`.
