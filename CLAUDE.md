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

- Trees/ferns/logs/furniture are procedural in `blender/build_assets.py` → `public/models/forest.glb` (committed).
  **Tree overhaul (step 2, in progress):** `fir` is now `branchy_fir`. The trunk is 30 m and bare (dead SnagBark stubs) up to
  10.5 m, then whorls every 0.38–0.6 m of 4–6 branches (12% skipped for gaps). Each branch is a bark `_stick` plus needle
  **cards** along it (2 tris each, ~70% get a crossed second card), in a narrow ragged crown (max radius 3.6 m). Cards use
  the `FirCards` material: RGBA `public/textures/foliage/fir_spray.png` from `tools/make_foliage.py` (PIL, colour bled into
  transparent texels), embedded in the GLB. They have UVs and custom normals (outward from the trunk + up). `MeshBuilder` gained
  `uvs=` per face and `custom_normals`, and the export has texcoords on. Materials whose name ends in "Cards" are smooth-shaded.
  In JS (`convertMaterial` → `patchCards`): map + alphaTest 0.5, DoubleSide, colour (0.55, 0.6, 0.52), the back-face normal
  flip undone, and alpha × (1 + 0.3·mip level) so sprays don't vanish with distance. The impostor bake samples the map and
  uses vertex normals for cards. `fir_lod` is a matching narrow cone (only for `?farTrees=lod`).
  **Hemlock done too:** both trees come from `branchy_conifer(...)` (elev, sag, card_droop, whorl, spacing, fill = crown
  profile, nod = sideways bend of the trunk top for hemlock's nodding leader; branch origins follow the bent axis).
  `branchy_hemlock`: 26 m, crown from 4.5 m, max radius 4.2, branches angled down with pendulous tips, `HemlockCards` with
  `hemlock_spray.png` (lacy: side shoots fork again, `spray(sub_shoots=3)`), tint (0.68, 0.72, 0.66). Per-material tints
  are in `CARD_TINT` (vegetation.js). Hemlock ~3.7k tris. **Cedar done:** `branchy_cedar`: 27 m, crown from 5 m,
  J-shaped branches (elev down, *negative* sag curves the tips up), `hang=0.55` hangs sprays vertically like curtains,
  `card_every=0.6, cross=0.35` (was 0.45/0.7: the phone bench showed trees 3.4 ms / frame 7.3 ms at cedar-rich spawn), `flutes=7` buttress ridges on the lower 12% of the trunk (`trunk(flutes=, flute_h=)`), and
  CedarBark (0.33, 0.235, 0.18: was a saturated rust 0.42/0.24/0.16). `cedar_spray()` paints flat scale-leaf fans (overlapping lobes, not needles). Tint (0.5, 0.56, 0.46). ~3.9k tris.
  `?bench=trees,near40` measured: 40 m vs 60 m saves 1.0 ms at spawn (full 7.5 ms, trees 2.9), 0.0 in the forest, so phones went to 40 m. New `branchy_conifer` options consume no extra rng unless used, so fir/hemlock stay identical. All cards
  are now darkened up to 40% where the visible side faces away from the card normal (crown undersides seen from below
  were sky-lit and pale). **Snowy fir/hemlock done:** `branchy_fir/hemlock(snow=True)` = the same tree
  (identical shape: the snow uses its own rng `seed + 991`) with `FirFrostCards`/`HemlockFrostCards` (same spray textures,
  bluer `CARD_TINT`) and `SnowCards` (`snow_clumps.png`: white clumps kept clear of the card edges) laid flat 6–10 cm above
  85% of the sprays that aren't hung/rolled, with up-facing normals (`_card(up_normal=True)`) plus a cap on the leader.
  In `patchCards`, snow gets a mip alpha boost of 0.12 (0.3 turned distant snow cards into white slabs) and underside
  darkening to 0.22 (white from below looked wrong). +~1.25k tris per snowy tree. Only saplings (both) are still cones. Fir near model: ~3.4k tris (2.3k card tris). Phone spawn 0.33M → 0.50M (fir) → 0.60M (hemlock) → 0.75M (cedar) → 0.70M (lighter cedar) tris,
  draws unchanged. CROWN fir 3.3. Phone bench with branchy fir + hemlock (full clock): trees "saves" spawn 0.7 → 2.0 ms,
  forest 0.3 → 1.1 ms; full frame 4.3 / 4.8 ms (still ≲6). Levers if needed: a shorter near radius for card trees on
  phones, fewer crossed cards, a coarser card-tree LOD between near and impostor. Reference photos: `inspo/README.md`. Gotcha: when adding a material patch in
  `convertMaterial`, don't splice an `if` into the wind-sway/ground-cover if/else chain. It turned every tree into
  moss-speckled rock.
  **Sword ferns** (`fern_a` 30 fronds / `fern_b` 24): arching frond *cards* (6 segments, 2 tris each, ~360 tris per clump)
  with `FernCards` = `fern_frond.png` (1024×256, `fern_frond()` in make_foliage.py: stipe + toothed pinnae with auricles).
  u runs base→tip, card width = length/4 (the texture aspect). Normals point out of the clump and up. Scatter: 2.3 m cell,
  p = forest noise × clump × 1.45, scale 0.9–1.8. Fern radius 110 m desktop / 60 m phone. Phone spawn tris 0.54 → 0.65M (ferns 0.21M).
  **Salal** (`salal`, kind 'ferns' via `KIND`: near pool, fade, wind sway, bench row `ferns`): 16 arching shoot cards
  (3 segments) with `SalalCards` = `salal_spray.png` (512×256, alternate toothed ovate leaves on a zig-zag stem), ~100 tris.
  Scattered after the ferns (same rng, so nothing else moves): 2 m cell, p = forest × patch noise (0.028 freq) × 1.1, below
  SNOWLINE − 40. ~63k clumps. Phone spawn 0.66 → 0.71M tris, +1 draw.
  **Hanging moss** (`moss=` in `branchy_conifer`, own rng `seed + 517`, so shapes are unchanged): 2 crossed vertical
  `MossCards` (`moss_strands.png`, 512×256, u = down: 6–8 ropy locks pinched at the top) 0.8–1.8 m long, from 85% of
  dead stubs and some lower-crown branches (t < 0.5) of fir, hemlock and cedar (not snowy trees or saplings). Tint
  (0.55, 0.58, 0.5) and mip alpha boost 0.05: brighter/boosted, they read as pale paper tags at 15 m. +3 draws, ~+1% tris.
  **Trunk moss** (`addTrunkMoss` in materials.js, near-tier `Bark`/`CedarBark` trees only, `?off=moss`): a patchy sleeve
  ~1–4 m up the trunk (higher on the SSW "rain side"), a little on branch tops, faded toward the snowline; defines
  `GROUND_COVER`/`gcMoss` so the bark photo fades under it. A first try at 2–6 m and brighter green painted whole trunks.
  **Roots + trunk bases (AAA-style, scaled for phones):** `roots()` runs first (own rng `seed + 313`; fir 6, hemlock 5,
  cedar 7 along its flutes; none on snowy trees or saplings) and returns its angles; `trunk(..., base_rings=True, lobes=)`
  then packs rings at 0/0.12/0.3/0.6/1.0/1.6/2.4 m, flares smoothly (exponential, e-fold 0.8 r_base) instead of flaring
  only the bottom ring, and bulges each lobe toward a root (cos⁶, ×0.35, fading with height), so roots grow out of
  buttresses. Near trunks have 18 sides (20 fluted). Each root is a **fin**: 9 sides × 7 segments, cross-section
  1.35 r tall × 0.75 r wide at the trunk, flattening to wide and low, its top falling concavely from 0.8–1.2 r_base up the
  trunk, tapering to 0.35 r0, reach 1.5–2.4 r_base, the tip diving underground. Faces wind (lo[i], hi[i], hi[j], lo[j])
  (the ring turns clockwise about the root's direction). First tries read as blades, then inside-out black fins, then
  splayed tubes ("spider legs"). `addTrunkMoss` also does **ground blending**: the bottom ~0.5 m above the ground
  (`vTmAbove`) fades to damp duff/moss with a ragged edge and the bark photo fades with it. Phone spawn 0.76 → 0.82M tris.
  Phone bench: trees 1.8 → 2.0 ms at spawn (±0.1), 1.3 in the forest; full frame 6.7 / 5.2 ms.
  **Veterans:** in the low, dense forest (`oldGrowth` = forest noise × below ~50–95 m), up to 13% of fir/hemlock/cedar are
  scaled ×1.45–1.85 (~585 trees, up to ~60 m tall, trunks ~2 m). Chosen by `hash2(x, z)`, not the scatter rng, so nothing moves.
  Boulders are Poly Haven scans via `blender/build_rocks.py` → `public/models/rocks.glb` + `public/textures/rocks/` (see below).
- No Blender binary in the container. Use the PyPI module:
  `python3 -m venv <scratch>/bvenv && <scratch>/bvenv/bin/pip install bpy` (bpy 5.x works with Python 3.13),
  then `<scratch>/bvenv/bin/python blender/build_assets.py`.
- Preview renders: Workbench/EEVEE fail (no libEGL). Use Cycles on the CPU with low samples.
- Object names (`fir`, `fir_snow`, `hemlock`, `cedar`, `sapling`, `snag`, `boulder_a..f`, `fern_a/b`,
  `log`, `stump`, `signpost`, `cairn`, `bench`) and material names are looked up in `src/vegetation.js` (and `src/surfacedetail.js`). Keep them in sync.
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
  >0.92; down = slow reverse). It sets `player.levelPitch`, which eases pitch toward the ground ahead (0.8 × the angle of the mean gradient to points 2, 4, … 10 m ahead along the heading, clamped ±0.55 rad, smoothed), so climbing or descending you look along the slope, not into it. **Hold-to-look:** a first finger that stays within 10 px for
  260 ms enters look mode instead (drag = free look up/down/around, no walking; `#look-cue` vignette while on). Moving
  >10 px before that commits to walking, and the slide so far counts as turning. Releasing a look drag mid-swipe sets
  `player.spin` (horizontal glide only, decays at e^-6t). On release `levelPitch` turns on, so the pitch eases back to the slope ahead
  (the user asked for this); the new heading is kept. An optional second
  finger (only while walking) is free look. No on-screen touch UI apart from that faint look-mode vignette, and no jumping (both at the user's request). Touch mode is on when `(pointer: coarse)` matches. It skips pointer lock (tap to start) and
  turns on the low-power profile in `main.js` (`VIEW_DIST` is mutated, camera far 420, half the
  particles). Override with `?quality=low|high`.
- `src/weather.js`: GPU rain lines and snow points wrapped in a box around the camera (plus sun-break **motes**: ~900 soft
  additive points within 7 m, lit by forward scattering × canopy sun visibility; `?off=motes`, bench row `motes`), with fog/light
  lerped by altitude relative to the local snowline, and WebAudio noise ambience.
- **Be opinionated (the user's call):** no user-facing options or toggles for how the game feels (head bob, sway, etc.).
  Pick the behaviour and ship it. (`?off=`/`?bench` switches are dev tools, not options.)
- **Realism direction (agreed): stylized low-poly now ("A"). The long-term goal is near-photoreal *up
  close*, with cheap representations further out, working incrementally with careful, measured
  engineering decisions.** Keep new work asset-agnostic: lighting is baked from geometry (`bake.js`),
  materials are made in one place (`vegetation.js` `convertMaterial`), and shader tweaks are chunk patches
  that also work on textured materials.
- **Distance tiers (the architecture for that goal):**
  - Trees: a full-detail **near pool** (`detail.js` `NearPool`, radius `VIEW_DIST.treeDetail`: 85 m
    desktop, 40 m phone (was 60; `?near=60` to compare)) plus **far LOD chunks** (`*_lod` models, ~1/3 the tris, one vertex-coloured
    material). `patchLod` in `materials.js` decides tiers per instance from `shared.uLodRadius`. Within
    ±`uLodBand` (12 m) both tiers draw and a complementary screen-space dither (interleaved gradient noise,
    `discard`) gives each pixel to exactly one, so trees dissolve between levels instead of snapping.
    Outside the band the other tier is culled in the vertex shader. The pool holds radius + band + 10 m and
    refills lazily (every 4 m). **Near pools are view-culled:** a refill only gathers candidates. `cull()` uploads only those whose
    per-instance bounding sphere (precomputed) is in a frustum widened 12° on every side, or that are within 10 m. `updateNear(camera)`
    re-culls when the view turns >8° or moves >1.5 m (widening > trigger, so nothing is ever missing on screen). All parts of a pool
    share one instanceMatrix buffer, so a re-cull uploads it once. Verified with a culled-vs-all render: 0 px differ for turns
    ≤10°, and the test catches 34°/90° turns. Draws ~37% of candidates. Phone tris at spawn 0.79 → 0.60M (forest 0.69 → 0.47M). The dither uses `discard`, which can cost fill rate on Apple GPUs
    (hidden-surface removal), so re-check phone `?perf` after changing tree materials.
  - **A mid tree tier was tried and reverted** (commit 2d55824): `_mid` models (same tree via `mid=True`, every other spray
    at 1.35×, no crossed cards/sticks/stubs/moss/roots) between 20 and 40 m on phones cut spawn tris 0.82 → 0.66M, but the
    phone bench showed no gain ("- mid trees" 0.3 ±0.5 / 0.2 ±0.2 ms, i.e. noise, +8 draws). **Tree cost on the phone is not
    triangles**: it's fill (alpha-tested card overdraw, which bigger mid cards keep) and draws. Levers that could work: less
    card overdraw (fewer overlapping/crossed cards near the camera, smaller cards), alpha-to-coverage vs discard, DPR.
  - **Far trees are impostors** (`src/impostors.js`, since the tree-overhaul step 1): at load, every tree type's *near*
    model is rendered from 8 azimuths (ortho, side-on) into a colour atlas (unlit: material colour × baked AO, gamma-2 in
    RGBA8) and a normal atlas (the flat normal in the bake camera's space). Frames are 128×256 on phones and 192×384 on desktop,
    with one row per type. Readback, edge dilation (frontier BFS, 6 rings), then mipmapped DataTextures. Far chunks get **one**
    InstancedMesh per chunk for all tree types: a unit quad, with per-instance `aFrame` = [yMin, height, halfWidth, row]. The
    vertex shader faces the camera (cylindrical) and picks the nearest baked view from (camera angle − instance yaw). It writes
    `transformed` in instance space (transpose(M)·w/s²), since three applies instanceMatrix after. The fragment shader uses
    `discard` below alpha 0.4 and rebuilds the world normal from the snapped view's axes, so it's lit like the 3D trees.
    `patchLod('far')` (now exported) keeps the crossfade. Quad geometry needs a hand-set boundingSphere (largest tree), or
    chunks get frustum-culled wrongly. `?farTrees=lod` uses the old `*_lod` chunks (kept for A/B). Phone far trees: 279k → 4.6k
    tris, 68 → 15 draws. Spawn totals: phone 0.60M/182 → 0.33M/129, desktop 1.54M/341 → 0.92M/222. Bake: ~1.8 s in
    SwiftShader (the GPU is fast). Load step 'tree impostors'. Watch: `discard` on Apple GPUs, and alpha thinning in mips.
    Phone A/B (`?bench=trees&views=spawn,forest`, full clock): trees "saves" impostors 0.7 / 0.3 ms vs `farTrees=lod` 1.3 / 1.0 ms
    (spawn / forest). Full frame 4.8 / 3.7 vs 4.8 / 4.5. `discard` is not a problem; the tree cost roughly halved.
  - Ferns: near pool only, and they shrink into the ground at `uFernRadius` ('fade' mode).
  - Boulders: near pool + far chunks like trees (`boulder_x` + `boulder_x_lod`). Logs, stumps and furniture: 125 m chunks only.
    Any node with a `<name>_lod` partner gets two tiers (`loadPrototypes` loads forest.glb and rocks.glb).
  - Close-up / photoreal assets belong in near pools. Their cost is bounded by the radius, not the
    forest size. Pool capacity is computed at load (`maxNearby`). If a pool fills, trees go missing, so
    `budget.mjs`-style checks report full pools.
  - Terrain is 8×8 tiles built from the height grid (same triangulation, so `groundAt` stays exact).
    The trail corridor is ~150 m segments. Both are frustum-culled.
- **No stutter rule:** build everything at load, never mid-play. No per-frame allocations (reuse vectors;
  spatial hashes use numeric `cellKey`). `warmUp()` in `main.js` renders the whole scene once off-screen
  and reads a pixel back so shader linking and buffer uploads finish during loading. Phones get the same
  features scaled by density and distance. Check with `?perf` (frame avg/worst, hitches >50 ms, load-step
  timings in the console). Under vsync the frame interval is pinned at 16.7 ms, so line 2 shows CPU ms, plus GPU ms from
  `EXT_disjoint_timer_query_webgl2` where available. Safari/iOS has none. **On iOS a per-frame `readPixels` wait reads 2–4×
  the true cost**, so `?perf=sync` is opt-in and the real numbers come from `?bench`.
  `?bench` (after tapping start) pauses play, warms the GPU up, and at spawn/forest/snowy slope times batches of
  back-to-back frames with one GPU wait. Each row is paired with alternating full-scene batches, because phones change clock
  speed mid-run. It reports each part off, an empty scene and other DPRs, in a copyable table. The user runs it on their phone
  and pastes the result. **Parameterized (v3):** `?bench=trees,grass` runs only those rows (keys: trees, ferns, rocks,
  ground, detail, tex, grass, grass50, near40, water, sky, weather, empty, dpr) plus the full baseline. `&views=spawn,forest,snow`,
  and `&heat=30` renders flat out first (in 200 ms slices), so the run measures the throttled state directly. The full
  run takes ~2 min. Ask for just the rows a change touches. **The user prefers not to heat up:** links go without `&heat` and measure
  the full-clock state. Judge by relative cost (paired "saves"); autores covers throttling. Rule of thumb: keep the
  full-clock phone frame at spawn ≲6 ms (throttled has been ~2.5× full clock). Tree culling at full clock: trees spawn
  1.5 → 1.2 ms, forest 1.1 → 0.7 ms; full frame 5.3 / 4.7 ms. `quick` (combinable: `?bench=quick,trees`) is the SwiftShader
  smoke test. SwiftShader's *relative* costs don't carry
  over to phones (it showed ferns/ground at ~18% each; the phone showed ~0), so use it for counts and regressions only.
  To find what costs the most on a device, use `?off=trees,ferns,rocks,terrain,trail,
  water,sky,weather,env,fog,aa` (any subset) and `?dpr=1`.
- **Measure before and after any perf change.** Count draw calls and triangles at fixed views (spawn, lake,
  forest `x=-30&z=420`, ridge `x=-60&z=-250`) with `?quality=high` and `?quality=low` via
  `renderer.info.render` after a `still` render. Note: `info.triangles` counts LOD-hidden instances too.
- **Sun breaks + dapple** (overnight, see NIGHT_LOG.md): `weather.js` cycles overcast ↔ sun (`shared.uSun`, ~6 min,
  starts sunny; `?weather=sun` pins it, `rain|snow|still` pin overcast, `?off=sun` stops the cycle). `SUN_DIR`/`SUN_COLOR`
  live in `atmosphere.js`. The fog carrier packs the sun into `fog.near` (`round(sun*255) + density`). Overcast light comes from high
  (`OVERCAST_DIR`) and lerps to the low sun. `patchSunlight` (materials.js) scales direct light by the canopy map
  along the sun ray (dapples in sun); `?off=dapple`. It defines `SUN_VIS`, which non-snow cards use for **backlight**
  (`patchCards`: + diffuse × light × (−V·L)⁴ × 0.75 × uSun × sunVis), so ferns and sprays glow looking toward the sun. Cards and grass keep only 15% direct specular (grazing Fresnel
  bleached them under a low sun).
- **Post** (`src/post.js`, `?off=post`): the scene renders into an MSAA target (the canvas then has no antialias) with a
  depth texture, then **light in the mist** (quarter res, sun breaks only: 16 steps over ≤55 m along each view ray; density
  = the fog's own formula (`FOG_POOL_*` exported from atmosphere.js, same bank noise) × extra near the ground (height
  above ground from a half-float terrain-grid texture, `post.setGround`); sunlit = the canopy map + dapple noise sampled where
  the sun ray crosses 7.8/18 m, shifted by the point's height, i.e. exactly the samples of the sunfleck it lands on;
  phase 0.25 + 1.1μ⁵ + 0.9μ²⁴; half-float; **temporally accumulated** (`resolve`: reproject the history by this pixel's depth with
  last frame's view-proj, clamp to the new frame's 4-neighbour range, blend 15% new; reset on resize, a >4 m jump or post off),
  because per-frame jitter + camera-relative steps shimmered while walking (measured 3.8% → 1.2% change per frame); blurred,
  added as (1 − exp(−light × `volStrength` 2.0)) × SUN_COLOR × 0.55: it saturates, because linear accumulation blew an open
  sunlit clearing facing the sun out to white on the user's phone), god rays (quarter-res bright pass, 4-tap box so leaf edges don't flicker,
  + 2× radial blur toward the sun, only when `uSun × facing` > 0.01, now ×0.8 since the mist carries the shafts), glow, and a
  composite (screen blend, grade, vignette, grain). **The scene target is flagged `isXRRenderTarget` with an sRGB colour
  space and `internalFormat 'RGBA8'`** so three tone-maps/encodes into it like the canvas. three applies fog *after*
  tone mapping, so a linear HDR target changed the fog. The RGBA8 internal format is needed or the MSAA resolve blit
  (RGBA8 → SRGB8_ALPHA8) fails and the image is black. `Post.render` restores `renderer.info.render` to the scene's
  numbers (the passes add ≤7 draws). Bench row `post` = "- rays/glow" (`post.effects`).
  **Phone bench after the overnight work** (sun, full clock, DPR 2): spawn full 6.5 ms (trees 2.1, ferns 0.5 ±0.4,
  rays/glow −0.5 ±0.3 i.e. ~free, motes 0.0); forest 5.3 ms (trees 1.4, ferns 0.3). Spawn was 6.5–7.5 ms before that night.
  After hanging moss, salal, trunk moss and roots (overcast): spawn full 6.2 ms (trees 2.2 ±0.3, ferns+salal 0.6 ±0.1),
  forest 4.8 ms (trees 1.3, ferns 0.3): all within noise of before.
- `src/atmosphere.js`: `installHeightFog()` replaces three's fog chunks globally, so it must run before
  any material compiles. **`scene.fog` is a `THREE.Fog` used as a carrier: `near` = density, `far` = time**
  (three refreshes those uniforms on every material). Fog thickens below ~18 m + 45 m falloff, and
  world-anchored noise makes drifting mist banks. Sky dome + PMREM environment
  (`scene.environmentIntensity` 0.55; foliage `envMapIntensity` 0.35 or it looks grey).
  Don't bring back camera-facing mist sprites: on phones their hard edges looked like confetti.
  **Sky** (`skyFragment`): overcast = horizon→zenith blend × a deck of fbm masses in stretched rolls (0.82–1.1) × a faster,
  darker scud layer, faded toward the horizon. Sun break = deep blue (zenith (0.035, 0.1, 0.27), pale toward the horizon:
  values are pre-ACES, and lighter blues washed out), a few cumulus (own fbm on a softer `d.xz / (d.y + 0.18)` projection
  so they foreshorten instead of smearing near the horizon; coverage smoothstep(0.63, 0.7); sun-side shading by probing the
  noise toward the sun; lit side 0.62 so it isn't blown), and a distinct ~1° sun disk (`smoothstep(0.99995, 0.99998, cosθ)`
  × 14, dimmed 60% behind cloud) with a tight halo (pow 6000/300/8). Sunny fog `SUN_FOG` is blue-grey 0xa7b8c6 to match;
  the fog chunk's forward sun glow was halved (it clipped the brighter haze to cream-white). The god-ray bright pass is
  limited to right around the sun (exp(−5d²), lum 0.75–0.98) so bright clouds don't smear into glare.
  The sky is drawn **last among the opaques** (`renderOrder` 100, `depthTest` on, vertex z forced to the far plane), so its
  cloud noise only runs where sky is visible, and the overcast/sunny halves are skipped by uniform branches when
  `uSun` is ~0/~1. Phone bench: `- sky` saved 1.3 ms at spawn and in the forest before this (full 7.6 / 6.1 ms), 0.1 ms after (full 6.3 / 5.0;
  rays/glow + mist light 0.2).
  After vine maple + nurse logs: spawn full 6.5 ms (trees 1.8 ±0.2, rocks/logs 0.2), forest 5.1 ms (trees 1.3, rocks/logs 0.2).
- **Close-up ground detail** (`src/grounddetail.js`): photographic albedo + normal maps for 4 layers (forest
  floor, rock, snow, mud/dirt), weighted by per-vertex `aLayers` (terrain `groundLayers()`, trail tread/banks →
  dirt), within `uGDRange` (20–45 m desktop, 15–32 m phone). The photo *modulates* the existing colour
  (albedo ÷ its average), so the palette and baked shading stay and the fade-out has no colour shift. Rock is
  triplanar; the rest are top-down. `textureGrad` with derivatives taken outside branches. Textures + `manifest.json`
  live in `public/textures/ground/`, made by `tools/fetch_textures.py ground` (CC0 Poly Haven: needs
  api.polyhaven.com + dl.polyhaven.org allowed in the environment's network settings). Without a manifest the
  feature stays off. It compiles in via `patchGroundDetail` + `customProgramCacheKey = groundDetailCacheKey`,
  and textures must load before `warmUp()`. `?off=detail` disables it.
  Assets: forest_leaves_04 (2.2 m tile), aerial_rocks_02 (6 m), snow_02 (3 m), brown_mud_02 (2 m). The per-layer
  `strength` in the manifest scales the photo's contrast (snow 0.45, or its specks read as dirt). `snowCover()` in
  terrain.js is the single sharpened, patchy snow edge used by both `groundColor` and `groundLayers`. If they
  disagree, needle texture shows up on white snow. Cost: +0 draws, about 10 ms of load (the download overlaps the build).
- **Close-up surface detail** (`src/surfacedetail.js`): the same idea for objects. Materials `Bark`, `CedarBark`,
  `SnagBark` and `Rock` (near-tier trees, logs, stumps, rocks, cairns, bench; never far LOD trees) get one photo
  albedo+normal layer (bark_brown_02, japanese_cedar_bark, bark_willow_02, lichen_rock in `public/textures/surface/`,
  `tools/fetch_textures.py surface`). Models have no UVs, so it's triplanar in *instance space*, scaled to metres: the
  texture sticks to swaying trees and keeps a constant texel size. Logs lie along X and swap X/Y so the furrows run along
  them. It's chained onto the existing onBeforeCompile (`addSurfaceDetail` in `convertMaterial`) and runs after
  `normal_fragment_maps`, so it comes after moss/snow cover. The ground-cover patch defines `GROUND_COVER` and exposes
  `gcMoss`/`gcSnow`, which fade the photo's colour (the lichen photo looked like camouflage on moss and dirty on snow).
  Same 20–45 m / 15–32 m fade. `textures.js` `loadTextureSet` is the shared loader.
  For this, bark faces are **smooth-shaded** in Blender (`use_smooth` when the material name ends in "Bark",
  except `prism`/`box` faces). Near trunks went 7 → 10 sides, logs 8 → 10, and `Bark` was lightened to
  (0.36, 0.28, 0.21). Near-black trunks hid the texture. Three's `flatShading` is off for *Bark materials.
  Budget: draws unchanged, tris +1%. Good close-up spots: fir `x=531.9&z=44.3&yaw=2.36`, snag `x=242.3&z=-78.3&yaw=0.79`,
  rock `x=288.8&z=-100.8&yaw=-3.14&pitch=-0.3`, cairn `x=21.9&z=-179.9&yaw=-3.14&pitch=-0.4`.
- **Scanned boulders** (`blender/build_rocks.py`): 9 rocks (g: a broad flat slab, h: a long block, i: squat basalt were added later) from Poly Haven `rock_moss_set_02` (grey, "scanA") and `_01`
  ("scanB", warm sandstone regraded 70% toward scanA's grey). Each is welded (glTF import splits verts at UV seams, and
  decimating unwelded meshes opens cracks), then decimated to near ~1600 / far ~220 tris with the scan UVs kept. The scan's
  shading normals (mesh + its own normal map) are baked (Cycles, selected-to-active, tangent space) into a 2048 atlas in
  the scan's UV layout. It's exported with tangents and no images. The game loads `textures/rocks` (`sizes` [2048, 1024],
  `flipY: false` for glTF UVs) and `applyRockTextures` sets map (both tiers) + normalMap (near only) before warm-up.
  Materials `ScanRockA/B`: smooth-shaded, ground cover with `moss: 0.35`, triplanar lichen grain at `amount: 0.3`. The
  surface-detail normal now *adds* to the existing normal, so normal maps survive. Origin: footprint centre, 18% of the
  height below ground. Scatter keeps the same rng calls (the variant comes from the same draw, so no tree moved), scale
  0.6–2.5, seated at the lowest ground in a 0.8×scale ring minus 0.12×scale. Colliders come from the footprint
  (`footprint()`). The script runs in ~25 s. Scans are cached in `.cache/scans` (gitignored). Budget: phone draws
  140 → 152 at spawn (110 → 127 at the ridge), tris +2–5%. Good boulder spots: `x=371.9&z=104.5&yaw=0.79&pitch=-0.15`,
  `x=-128.8&z=8.2&yaw=-0.79&pitch=-0.2`.
  Boulders on steep ground scale up to ×2.2 (outcrops) and cobble clusters (`pebbles_d`) up to ×3.5 on stony slopes (talus),
  both without extra rng. 9 variants: phone draws +3–9 (spawn 150 → 153, ridge 126 → 135).
- **Grass** (`src/grass.js`): one tuft geometry (8 curved, tapered blades of real triangles, no alpha test), drawn by
  instancing in two **rings**, each a square tile that wraps around the camera like the rain (one draw call each):
  dense inner (desktop 22 m tile / 10000 tufts, fading out 6–11 m; phone 16 m / 2800, 4–8 m) and sparse outer (56 m /
  22000, fading in 6–11 m and out 16–28 m; phone 36 m / 4500, in 4–8, out 10–18 m). **No popping:** a tuft's existence depends
  only on density (smoothstep(density − hash)); distance only *scales* it via the wide fade bands. (Thresholding the hash
  against a distance fade made tufts sprout in front of the player.) **Culling:** each ring is 6×6 chunk meshes. `update(camera)`
  wraps each chunk's tile span into the window (`wrapSpan`, 1–2 pieces per axis), drops pieces beyond the ring or inside
  its fade-in, and frustum-tests a box using the chunk's real ground height range (9 `rawGroundAt` samples; a ±40 m box
  behind a downward-looking camera never culled). It draws ~48% of tufts, and a culled-vs-all render differs by 0 pixels. The vertex shader picks each tuft's world spot
  (stable while in range), reads the baked **grass map** (terrain-grid resolution: alpha = density from the forest-floor
  layer × no-snow × (open sky² × meadow noise + lakeshore), open = 1 − min(1, canopy × 2.2) so closed canopy has ~no grass; rgb = grass palette × the terrain's baked shade, taken as
  shaded/unshaded tile vertex colour), sits on `gGround()` (texelFetch of the height grid with the terrain's exact
  triangulation, so it matches groundAt), and skips the trail via the terrain's `cutUniforms` mask and water. Tufts
  shrink into the ground (smoothstep on density − hash) instead of popping. They widen with distance (up to 2.6× by
  26 m), because 1–2 cm blades go sub-pixel at ~10 m and vanish. Wind: travelling gusts plus flutter (`shared.uWind`). Normals
  are up-biased, and the back-face flip is undone after `normal_fragment_begin`. `?off=grass`, `?grass=50` (% of tufts,
  built), `?bench` rows "- grass" and "grass 50%" (`setShare`). Cost (container): +2 draws, desktop +0.65M / phone +0.2M
  submitted tris before culling (most collapse to points where it's sparse), +0.2 s load. With culling: phone spawn
  185 draws / 0.79M tris (was 154 / 0.91M without culling). Phone bench (first version, 3000+5600 tufts): 0.5 ms at full
  clock, 1.7–1.8 ms throttled, even on the near-grassless snowy slope. It's **vertex-bound**: every tuft runs the vertex
  shader, absent or not, and the cost scales with count (50% saved half). Hence: phone counts −35%, absent tufts skip the
  height/cut lookups, and `grassNear` hides a ring when no 16 m cell in its reach has density >2% (`cellMax`, a few
  lookups per frame). Good grass views: spawn `pitch=-0.12`,
  lake `x=110&z=470&yaw=-0.67&pitch=-0.12`.
- Shader noise: use the sine-free hash (`fract(p.xyx * .1031)`, Hoskins). `fract(sin(x)*43758)` is
  unreliable on mobile GPUs.
- `src/bake.js`: prototype vertex AO (vertex colours × instance colours), `bakeCanopy` (2 m grid) feeds
  instance tints and `shadeGround` (terrain + corridor), and `horizonAO` from the terrain grid.
  `shared.uWet` (from `weather.js`) drives wet darkening/gloss (`wetChunks`), trail puddles and lake rain
  rings.
- Loading screen: one fixed-size box (title + a single slot holding the bar, then "Tap/Click to start"). Keep
  it that simple, with no instructions or flavour text and nothing that changes the box mid-load. A one-line
  controls hint toasts once on start. `progress(to, expectedMs)` in `main.js` animates the bar with a
  compositor transform (Web Animations, linear), so it keeps moving while a blocking step runs. Each segment starts from our own
  computed position, never lower: CSS transitions restarted from the main thread's stale value and jumped backwards. Re-tune the expected times if
  loading steps change.
- Everything is deterministic from `SEED`. Changing noise or scatter order moves every tree.
- Budget history (spawn view, submitted tris / draws). Before tiers: desktop 3.24M/466, phone 1.75M/216
  (the user's phone ran ~18 ms/frame avg, worst mid-20s, no hitches). After tiers: desktop 1.57M/286,
  phone 0.65M/140. Phone `?bench` v1 (iOS 18, 502×812 @1.25): full frame 2.5–3.0 ms, empty scene 0.3–0.5 ms,
  trees ~1 ms, ground ~0.3 ms, everything else (ground detail included) within noise.
  Bench v2: the *same* full scene went from ~3 ms to ~9 ms partway through the run (the phone's GPU clock dropped:
  power saving or heat), so absolute ms vary ~3× with phone state. Paired "saves" stayed steady (± ≤0.5). At the slow clock:
  trees 4.1, ground 1.5, others ~0, empty scene ~1 ms. DPR from 1.25: 1.5 = +0.4–1.4 ms, 2 = +0.9–4.1, 3 = +2.8–11.2.
  Plan for the slow state (~9 ms at the current settings), since that's what sustained play can drop to. Phone DPR
  went 1.25 → 1.5, then → 2 after the user played `?dpr=2` and it looked and ran fine (desktop stays 1.5). 
  Bench at DPR 2 (804×1300, with bark/rock textures): full 4.7–5.2 ms at full clock, 12–13 ms after the mid-run clock drop
  (it hit ~20–25 s into a flat-out run both times, so it looks like a sustained-load/heat limit). Bark/rock textures 0.0 ±0.3,
  ground detail ~0, trees 1.1–1.6 (4.8 slow), ground 0.6 (2.4 slow), sky 0.3–1.3. In the slow state DPR 2 vs 1.5 costs ~3 ms. 
  Safety net: `src/autores.js` steps DPR down 0.25 (floor 1.25 phone / 1 desktop) when >10% of frames over a full 120-frame window
  take >22 ms. It holds 2 s after start and after each step, treats >250 ms gaps as pauses, and never steps back up (no
  oscillation). Each step is one framebuffer realloc (a single hitch). Off with `?dpr=`, `?autores=0` or `?still`. The `?perf`
  line 3 shows the current dpr. The logic was tested in node with a fake clock: steady/hitchy/5% slow keep DPR, and sustained
  40 fps steps down. Load in the container (SwiftShader) is ~11 s, ~8 s of it the software-rendered
  warm-up; much faster on a real GPU.

## Backlog (agreed with the user)

- Wet look in rain (glossier trunks/rocks, drips, puddles reflecting the sky). Sharper god-ray shafts (1 m canopy map).
- Tree cost is fill-bound (see the reverted mid tier): try cutting card overdraw if the frame budget gets tight.
- Sound: footsteps by surface, birdsong in sun breaks, drips after rain. Subtle head bob (no option: opinionated).
- Tree mid-LOD between full detail and impostors if the frame budget gets tight.

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
