# Cascadia Woods: notes for Claude

Walkable low-poly Pacific Northwest forest in three.js + Vite. Valley with rain in the south (+z), climbing north (−z)
through a staircase of snowy benches between ridged peaks to a high basin under a pass. See README.md for the file map and controls.

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
  then packs rings at −1 (below ground, so slopes never expose the bottom edge)/0/0.12/0.3/0.6/1.0/1.6/2.4 m, flares only
  30% of `flare` all round (exponential, e-fold 0.8 r_base: a full even flare stretched a "webbing" skirt between the roots,
  seen by the user), and bulges narrow lobes toward each root (cos¹⁰, strength 0.25 + 0.7 (flare − 1)), so roots grow out of
  buttresses with the trunk staying near its radius between them. Root tips dive 3 × r_end below ground. Near trunks have 18 sides (20 fluted). Each root is a **fin**: 9 sides × 7 segments, cross-section
  1.35 r tall × 0.75 r wide at the trunk, flattening to wide and low, its top falling concavely from 0.8–1.2 r_base up the
  trunk, tapering to 0.35 r0, reach 1.5–2.4 r_base, the tip diving underground. Faces wind (lo[i], hi[i], hi[j], lo[j])
  (the ring turns clockwise about the root's direction). First tries read as blades, then inside-out black fins, then
  splayed tubes ("spider legs"). `addTrunkMoss` also does **ground blending**: the bottom ~0.5 m above the ground
  (`vTmAbove`) fades to damp duff/moss with a ragged edge and the bark photo fades with it. Above the snowline the duff
  gives way to a **snow drift** banked against the trunk (`tmDrift`: 0.08–0.56 m, varying around it, sets `gcSnow`, and its
  normal is tilted 75% to up at `emissivemap_fragment` so it lights like the ground snow: a level white band read as a sock). In rain, **rivulets**: vertical noise
  bands (most on the rain side) × `uWet` darken bark 35% and drop roughness toward 0.22. Wet cards keep 0.35 + 0.45·uWet
  of their indirect specular (a soft sky sheen). Phone spawn 0.76 → 0.82M tris.
  Phone bench: trees 1.8 → 2.0 ms at spawn (±0.1), 1.3 in the forest; full frame 6.7 / 5.2 ms.
  **Fallen logs** (`log`): lie across the slope (heading from the gradient ± 0.25 rad, flipped by the same draw that was
  their random rotation), seated on the mean ground along them minus 0.12 × scale. Random headings poked one end up into
  the air on hillsides (seen by the user). Branch stubs and the nurse logs' torn roots use `_stub` (blunt truncated cones);
  pointed `_stick`s read as thorns. Log ends use `LogEnd` (0.42, 0.37, 0.31): the fresh `Wood` colour read as an orange blob.
  **Nurse log root wad** (`nurse_log`, own rng `seed + 77`): a thick, lumpy domed plate of soil (R 2.4 r0, half-thickness
  0.55 m, ragged lobed outline, torn flatter at the bottom; 18 × 7 rings per face + rim) instead of a flat disc; 11 thick
  roots flare out of the trunk end across the front face, out past the rim, bend back and snap off; 24 torn root ends out
  of the back; ~35 thin rootlets hanging from the rim. Roots use `RootSoil` too (bark-coloured ones took moss green and
  read as sticks); `RootSoil` → the surface photo `soil` (brown_mud_02, copied from the ground set; the bark photo made the
  plate read as a slice of trunk) and moss 0.25. ~3.2k tris (was ~1k).
  **Nurse log seating + broken end** (the user: "you can see through the top", "the cut end isn't realistic"): placement
  took the lowest of 5 ground samples, so a hump under the middle buried the log to its top (1.5 m at the one by the
  first bridge). Now 17 × 3 samples along/across it: y is set so the ground comes up at most 0.9 r into the trunk
  anywhere, and the log is left out (rng still drawn, so nothing else moves) where its underside would then be > 0.4 m off
  the ground: 563 → 373 logs. The broken end (own rng `seed + 151`) was a splinter cone wound inside out (culled: you saw
  into the hollow tube); now a ragged bark-backed rim (mostly 0.1–0.45 m splinters, a quarter 0.5–0.9 m), a torn face of
  `BrokenWood` (0.6, 0.52, 0.42; snag photo) and a pit of punky `RotWood` (0.5, 0.29, 0.17; soil photo) hollowed back into
  the heart. End faces get little light under the canopy: darker colours read as black.
  **Still see-through (the user, on a phone, from the end):** the broken end's twisted splinter/torn-wood faces partly
  faced into the trunk and were culled, so you looked into the hollow tube and saw the ground and grass inside it (found
  by tinting Bark/BrokenWood/RotWood flat colours: the trunk was intact, the end had windows). Log materials (`swapXY`,
  every asset starting with 'log') are now **DoubleSide**, and BrokenWood/RotWood take moss 0.1 (the pit's up-facing
  faces read as a green wedge).
  Now `broken_end(b, M, loop, x, r, centre, d, er)` (lengths in units of r, faces oriented by `_face_toward`, which
  reverses a face whose winding points away from a hint direction) also gives both ends of the ordinary `log` (own rng
  `seed + 151`): its flat `LogEnd` discs read as dark faceted blobs. `LogEnd` is now only the root wad's trunk cap.
  **Leaning snags** (`log_leaning`, `leaning_snag()`: a grey SnagBark trunk 20 m along +X from its base at the origin,
  r 0.42 → 62% taper, a slight bow and sag, both ends `broken_end`, 14 blunt stubs; the user asked for "fallen trees
  leaning on other trees"): `addLeaners` (vegetation.js, after the marsh snags; hash, no rng) picks ~0.6% of fir/hemlock/
  cedar 25 m+ below the snowline, stands the base 0.9–1.6 × the contact height away and rests the snag against the side
  of the host trunk 5–11 m up (axes pass host r at that height (HOST radii/heights from the Blender trees) + its own r
  apart), scaled 0.75–1.35 so ~4 m runs on past into the crown. `tilt` (17–60°, else skipped: a base far uphill once gave
  ~0° and the collider loop never ended) pitches it about local Z through the base. Skipped if its part under 3 m crosses
  the trail (+1.5 m) or a creek, the ground rises > 0.6 m into it, or another trunk is within 1.4 × scale + 0.4 m of the
  axis. Colliders along the part under ~2 m. 121 placed. 'log' prefix: rocks kind (125 m chunks, ground cover/moss on top).
  **Vine maple** leaves: `maple_spray()` shades each leaf (lighter centre, darker rim, mottle) with a soft shadow on the
  leaves beneath, lobes cut ~1/3 in; the cards are **folded** (`_card(fold=0.45)`: a shallow V along the twig, 4 tris; each
  half rises 0.45 × its width), with more roll, since flat horizontal cards seen at eye level were thin streaks. `fold=0`
  keeps the old code path exactly, so every other asset is byte-identical (checked by hashing the GLB's mesh buffers).
  **Card outlines + fewer crossed cards (fill cuts):** cards with a spray texture (fir, hemlock, cedar, their frost
  versions, snow) are built as a tight convex polygon instead of a quad: `tools/card_hulls.py` (run after
  make_foliage.py) takes every texel with alpha > 0.02, pads it 10 texels for the mip alpha boost, reduces the hull to 4
  corners by growing it (never cutting in), clips it to the card, and writes `blender/card_hulls.json` (4–6 corners; area
  0.50–0.61 of the quad, within a few % of the exact hull; 0 visible texels outside). `_card` maps the outline exactly like
  the quad's corners (flip_u, droop, normals), so the needles land where they did. Fir and hemlock `cross` 0.7 → 0.35 (as
  cedar); the crossed-card draw is taken either way, so no branch moved (bark buffers byte-identical). Card tris: fir
  2386 → 3808, hemlock 2560 → 4004, cedar 2670 → 5340. Phone-setting submitted tris spawn 0.94 → 1.09M, forest 0.62 → 0.69M,
  draws unchanged; shaded card pixels ~−45%. Before/after renders look the same.
  **Phone bench after:** no measurable gain: spawn full 6.5 ms (was 6.6), trees 2.3 ±0.6 (was 2.3 ±0.3); forest trees 1.2
  (was 1.3); snowfield full 6.0, trees 2.6. The extra tris cost nothing either, so it stays; the card fill isn't dominated by
  the empty corners (it's the needles themselves, overlapping).
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
- **Map (landscape rework):** 2.8 km square (`WORLD_SIZE` 2800, `TERRAIN_SEGMENTS` 560 = 5 m cells; was 2 km). The valley
  (spawn, lake, old growth) kept its coordinates; the north is `highCountry()` in terrain.js: a `STAIR` of rises along z
  (foothills ~50 m → lower snow bench ~150 m, z −420…−680 → upper basin ~225 m, z −820…−1000, walled like a cirque → the pass
  ~280 m) up a corridor around x ≈ 60 that wanders ±120 m; ridged peaks flank it (`flank`) and close in around the basin;
  hills fade to 40% under the benches; the rim starts at 0.39 × WORLD_SIZE. Sun breaks thin the high fog more (density
  × 0.62 − 0.22·snowT) so the peaks show. The south edge is now the coast (see The coast). Trail stops (before the beach): trailhead → lake → snowfield (110, −540) → high basin (70, −920);
  2.5 km, 1.2 km in snow, grade p50 10% / p95 24%, cross-slope p95 7%. Load (container): vegetation 4.3 → ~9.9 s (twice the
  area). Changing `heightAt`/scatter moved every tree. Views: snowfield `x=90&z=-500&yaw=0.2`, basin `x=70&z=-900&yaw=0.1`,
  looking back down `x=110&z=-640&yaw=3.0` (bench `views=snow` is now the snowfield). Old coordinates north of z ≈ 0 are stale.
- **Streams** (`src/streams.js` paths + carve, `src/streamwater.js` water): a priority flood from the lake over an 8 m grid
  of the *uncarved* terrain (`baseHeight`) gives each cell a downhill route (pits flooded over); 5 `SOURCES` (basin, basin
  walls, foothills) trace down until they meet a traced stream (4 survive: main 1.9 km basin → lake, 2 tributaries + a west
  creek that passes between spawn and the lake). Chaikin ×3, resampled every 4 m; width 1.8 → ~5 m with drained length; bed
  level forced to fall downstream. `heightAt` = `streams().carve(baseHeight)`: a flat bed, banks easing back over 7 m
  (`BANK`, wider where still deep: + 2.5 × (depth − 2.5)). **Pits:** the flood level runs flat over a depression, so the
  falling bed once cut a 20 m sheer trench through the saddle south of the lake. Now each flooded component (level − h >
  0.05) a trace crosses is either **filled** (sediment: `fillAt` adds level − h, bilinear on the 8 m grid, inside `carve`)
  or, if bigger than `SINK_AREA` (8 ha), it's a **sink**: the trace stops, runs steepest-descent to the nearest low spot
  and ends in a **pond** (`ponds`: level = low spot + 1.5 m, cells below it connected to the spot; drawn in `buildWater`
  with the lake material as cell quads + a ring, the terrain hiding the overlap). The west creek ends in a pond at
  (−381, 194), r ≈ 40 m. Channel depth now ≤ 3.5 m everywhere. `waterLevelAt(x, z)` (lake or pond) replaces
  `WATER_LEVEL` in scatter, grass, mud and puddle checks. View: `x=-345&z=215&yaw=0.98&pitch=-0.15` (sun). `streamBed()` gives stony, snow-free beds (groundColor/groundLayers → rock layer, grass
  gone); scatter keeps trees 2.5 m, ferns/salal 0.6–1 m, logs 5 m off the water; pebbles cluster in beds. Water: a ribbon
  per stream, 6 verts across, level = rendered ground + ~0.15 m, falling downstream; half-width = bed + 0.7 m (searching for
  the banks spread it over flat valley floors: the 5 m grid only roughly holds the channel). Shader: 3-octave ripples
  stretched along and scrolling with the flow (speed from the fall), soft white-water streaks on steep runs, faint bank
  foam, alpha clearer at the edges; reflection like the lake but the **canopy map darkens the reflected sky** (forest
  creeks mirror the dark canopy) and Fresnel max 0.6. (`uSwTime`, since patchSunlight declares `uTime`.) `?off=water` drops it.
  **Footbridges** at trail crossings (`trail.crossings`, computed before `benchHeight` from the smoothed `tread`): the bench
  cut lets the channel through the tread (`cut` near the stream) instead of damming it like a culvert. A Blender
  `footbridge` (log stringers, uneven `Plank` deck ±0.75 m, a pole rail; 6.4 m, moss 0.2) is **level** and stretched along
  its length only (`scaleX` placement field): half-length `reach` = (half + 1) / cos(crossing angle, ≥ 0.5) + 1.2 (an angled
  crossing is longer than the channel is wide: the old span = channel width put the ends in the water, seen by the user),
  deck = max(tread at both ends, bed + 1.4, rendered ground + 1.0). **Dirt berms** (`bermHeight`, applied as max() in
  `benchHeight`, in *trail* coordinates: arc length from the crossing and distance from the centreline, since a berm along
  the bridge's straight axis ended up beside a curving trail): flat top ±1.6 m at deck − 0.04 from 1 m under each deck end
  outward, a 15% ramp down to the tread (22% read as a steep mound), sides dropping 0.6/m (meets natural ground within
  BANK_OUTER, inside the corridor mesh), a steep face toward the water under the bridge, and kept out of the channel except
  under the tread. Pebbles are filtered off them. Clearance 1.25–1.5 m; ends meet the berm within 4 cm. `walkAt()`
  (terrain.js, `setWalkModifier`) puts the player on the deck (±0.85 m); player.js uses it. (3 crossings now.) Phone spawn draws
  155 → 173.
- **Rocks in the creeks** (`streams.js` `rocks`, `streamwater.js` `streamRocks(trail)`, `vegetation.js` `addStreamRocks`):
  ~420 along the beds, chosen by `hashU(stream, point)` (no scatter rng): chance 0.14 + 5 × bed fall (≤ 0.59), radius
  0.3–1.15 m (≤ 0.55 × half-width, bigger on steep runs), anywhere across the bed, none within 3.5 m + r of the trail
  (footbridges). Placed as scanned boulders (not the flat slab g) scaled so their mean half-width = r, seated on the lowest
  bed under them. The water reads the same list from an RGBA32F texture (a column per 4 m of stream, 2 rows per stream:
  across, along, r) via `aInfo` (half width, stream index); each fragment loads the ≤6 rocks of its own and the
  neighbouring 4 m (`swLoadRocks`). Per rock: the flow parts around it (potential-flow sideways shift of the ripple
  coordinates), a pillow heaped on the upstream face, a trough in the lee and standing waves downstream (`swRockH`, normals
  by finite differences), a thin broken collar of white water (at ~0.8 R: stones are narrower at the waterline; strongest
  upstream), and a narrow wake of bubble streaks with a V of thin arms, longer on fast water (`swRockFlow`). Ripples are now
  in metres (wavelets ~0.1–0.5 m) and steep-run foam is thin streaks. Gotcha: a wake as wide as the stream and ~6 m long
  turned whole reaches into flat white blotches (found by zeroing the light terms: it was diffuse, i.e. foam). The
  overcast key light no longer gives water direct specular (× 0.5 uSun). Phone spawn draws 173 → 153 (the pit fill/pond moved
  things), tris 0.90 → 0.94M. Views: `x=459.5&z=-4.3&yaw=-0.77&pitch=-0.35`, `x=463&z=-12.7&yaw=3.13&pitch=-0.4`.
- **Water shading v2** (streamwater.js; the user: "too blocky", "the water moves altogether"): detail is two load-time
  tileable textures instead of value noise: `waveNormals()` (48 integer-wavenumber sine waves, amplitude k^−1.6, slopes in
  RG, height in B; separable sin tables, ~40 ms) and `foamTexture()` (cellular noise, bright on the cell walls, 8 + 16
  cells; ~20 ms). Both are **flow-map advected** (`swFlowTex`: two phases half a ~0.9 s cycle apart, crossfaded, the cycle
  offset per spot by noise so it never pulses as one) along a **per-pixel current** `swVel`: speed profile across the
  channel (0.3 at the banks → 1 mid-stream) × slow drifting turbulence noise, plus the push around rocks; displacement is
  capped at ~1.7 m/s (more smeared into streaks and swirls). Foam = advected foam texture over a threshold set by coverage
  (fast runs in drifting patches, rapids crests, rock collars/wakes, a thin bank line), stretched 3× along the flow. Ribbon
  9 verts across (was 6: long flat facets). Gotcha: the trail's transparent **fringe** sorted after the water and painted a
  straight line across the creek at crossings: stream meshes have `renderOrder` 1.
- **Rapids** (`streams.js` `RAPIDS` at (112, −8) on the main creek, `p.rapid` 0..1 over ~150 m up / 130 m down): channel
  ~70% wider (8.5 m), bed 0.6 m deeper, ~2× the rocks and bigger ones (+0.45 r), and the trail is routed to cross there
  (`WET_COST` × 0.1 in the rapids): a 12.2 m two-piece footbridge (spans > 9 m use two models end to end, 0.5 m overlap).
  In the shader (`aInfo.z`): base speed + 2.6, standing-wave ridges (|2n − 1| ridge noise: white crests, slopes in the
  normal), milky aerated colour, alpha → 0.97 (white water hides the bed).
  **Phone bench** (DPR 1.5 after autores, full clock): spawn full 5.0 ms (trees 2.3, water 0.0, rain/snow ~0); snowfield 4.5
  (trees 1.7, snow 0.2); **creek view** (opt-in `views=creek`) 5.0 ms with **water 1.1 ms** when it fills the screen. The
  rapids' ridge noise (8 lookups) now only runs where `rapid` > 0. At DPR 1.75 the creek view was full 6.0 ms, water 1.3 ms;
  `swLoadRocks` now keeps only rocks within 10 radii of the pixel (their effects end there), so most creek pixels skip
  the rock maths (3 loops incl. the finite-difference normals). Phone bench after: creek full 5.5 ms, water 1.2 ±0.2 (within noise of
  1.3). Next lever if needed: fewer flow-advected texture taps (4 wave + 4 foam). Views: on the bridge
  `x=84&z=0`, looking up/downstream.
- **Marsh + boardwalk** (`MARSH`/`marshAt` in terrain.js: an oval (165, 478) 62 × 30 m with noisy edge on the lake's
  south-east shore): `baseHeight` eases the ground to WATER_LEVEL − 0.08 + hummock noise (±0.5 m), so the lake surface
  (which covers it) leaves tussocks and hummocks; the lake shader stains it dark tannin brown (ellipse, no noise). New trail
  stop **Marsh boardwalk** (160, 480) between the trailhead and the lake (trail 3.0 km); A* may enter marsh cells despite the
  water rule. `trail.boardwalk`: 3 m sections along the trail where marsh > 0.12 and raw ground < WATER_LEVEL + 1 (wet
  ground only: the noisy edge reached up a hillside), deck ≥ water + 0.4 / ground + 0.25, at most 0.1 m between sections
  (lower ones raised), 25 sections = 75 m. Blender `boardwalk` (3 m: two stringers, ~15 boards 1.2 m, four 1.4 m round posts),
  scaleX 1.06 to overlap on bends; walkable via `setWalkModifier`. No tread colour under it. Marsh **sedge** = the grass
  rings: density in the marsh down to WATER_LEVEL − 0.35 (out of the water) in noise clumps, ×3.2 tall (`gMarsh` ellipse in
  the vertex shader), olive `SEDGE` going to straw. ~10 dead **snags** on hummocks (`addMarshSnags`, hash on a 9 m grid).
  Views (from the boardwalk): `x=187&z=465`. Gotcha for scripted renders: call `grass.update(camera)` after moving the camera.
- **The coast** (the user: "add a beach ... opposite the mountains", with Oregon dune photos): `coastZ(x)` (terrain.js,
  ~1000 ± 60 m, gentle bays) is the shoreline across the whole south; `SEA_LEVEL` 0 (the lake stays at WATER_LEVEL 4).
  `coastProfile` by s = coastZ − z (inland): sea floor (2.6% for 60 m, then steeper, to −28 m), foreshore 4.2%, a flatter
  berm to ~2 m (the beach widens/narrows ±22% along x), a foredune face rising ~12 m over ~60 m, hummocky back dunes,
  blended into the inland hills over s 170–340. The rim is now only east/west/north (`edge = max(|x|, −z)`); at the coast it
  runs out into the sea as headlands (rimH × smoothstep(−260, 60, s)). `sandAt` (open sand to ~190 m inland, ragged) drives
  the ground colour (pale `sand`, `sandDamp` below ~1.3 m), the detail layer (slot 2, see Ground detail), no
  trees/ferns/salal/maples/logs/pebbles on sand (a rare boulder), the trail tread (churned sand, no grit), dune grass and
  `shared.uSandMap` (R8 on the terrain grid; `unpackAlignment` 1 for its 561-byte rows): `addGroundCover` swaps moss and
  duff for sand there, and `bleach` (wood materials) greys driftwood silver. `waterLevelAt` is SEA_LEVEL within 220 m of
  the shore; `openWaterLevel` is the water you'd stand in where water is drawn (lake ellipse, ponds, the sea to the dune
  toe). **Deep water stops you** (player.js): you can't move to where it's > 1.1 m deep (slides along the edge; the camera
  stays above the surf). **Dune grass**: the grass map's density on sand (dunes above 3–7 m, patches, not steep faces),
  `MARRAM` grey-green to straw, ×2.5 tall (`uGrassSand` in the vertex shader), in **separate tussocks** with bare sand
  between (the 5 m map can't hold them: a 1.5 m value noise thins tufts by the sand amount; density × 0.75 so the distant
  grass tint doesn't paint the dunes green). **Shore pines** (the user's second dune photo: grass tussocks, bushy pines,
  hummocks): Blender `shore_pine` (`branchy_conifer` with the new `roll` option: sprays twisted up to ±1.3 rad read
  bushy instead of flat tiers; 7.5 m, foliage from 0.3 m, broad rounded crown pushed over by `nod`, `PineCards` = the fir
  spray tinted dark yellow-green (0.4, 0.47, 0.32)) + `shore_pine_lod`; a trees kind, so it gets impostors. Scattered on
  the dunes (sand > 0.3, ground > 5 m: p = 0.16 × sand, scale 0.45–1.15) and the main tree type within 380 m of the
  shore (with fir, hemlock, saplings: the wind-pruned coastal forest). Sand reaches ~190 m inland (±35); back-dune
  hummocks are stronger. Sand `0xcfc0a0`, detail strength 1.0 (it read flat white in sun).
  **Beach walk** (the user's third photo): footprints along the trail on sand (trail.js corridor: `aPrint` = arc length,
  offset across, sandiness; three walkers' alternating oval hollows with a lit lip, some scuffed out, wandering lanes);
  the lower beach (below ~2.6 m) is firm tan `sandFirm` with only 25% of the trampled photo (grounddetail.js now treats
  layer weights summing below 1 as plain ground); sea haze: fog density × up to 1.35 low over the coast in a sun break
  (atmosphere.js fog chunk, z 760–1000). View: `x=40&z=946&yaw=-1.75&pitch=-0.12&weather=sun`. **Driftwood** (`addDriftwood`, hash, no rng):
  `log_leaning` lying along the drift line (s 40–76), mostly along the shore, some piles, scale 0.4–0.9 (8–18 m), a third sunk,
  skipped where the sand rises into it or falls away, on rock or near the trail (~130). Trail stops now trailhead → **Ocean
  beach** (−60, 942) → along the berm → **Dune trail** (300, 948) → marsh → lake → snowfield → basin (3.95 km); on sand the
  A* grade cost is 60% lower so the path goes up the dunes like the photo, not in switchbacks; trail grid MAX_Z 1000. Signs
  list the 5 nearest stops (`MAX_ROWS`). The HUD says "Ocean beach"/"Dunes". Views (`weather=sun`): berm
  `x=50&z=962&yaw=3.14&pitch=-0.08`, in the swash `x=50&z=985&yaw=2.9&pitch=-0.12`, dunes `x=80&z=880&yaw=3.0&pitch=-0.15`.
- **Ocean** (`src/ocean.js`, `?off=water`, bench row `ocean` + opt-in view `beach`): one swell train (10 s, from 0.22 rad
  west of shore-normal). `bakeCoast` (load, ~0.1 s) marches each 4 m column in from the south edge in 2 m steps
  accumulating travel time with linear dispersion (Eckart), k_z = √(k² − k_x²) (Snell), into an RGBA32F texture: R travel
  time, G its value at the column's shoreline (swash timing), B may-draw mask (to 75 m inland); beyond the south edge the
  time continues analytically (`uODeep`). Per crest n a height `oWaveM(n)` (hash + slow sets). `oSea(d, cycle)`: Green's-law
  shoaling, a peaked crest leaning forward, breaking where H > 0.78 d (`db`), then a sawtooth bore held to 0.78·0.85 d with
  foam on its face, the roller and lace behind; whitening crest at the break. `oSwash`: each bore runs up the beach as a
  parabola in time (quick uprush, slower backwash) to 0.2–0.95 × swell/0.55 m; the sheet is 0.3 × the depth under the
  run-up edge; after it drains the sand stays glossy (a dark, reflective film, alpha 0.22) for ~3 s. Mesh: a polar grid around
  the camera (0.35 m rings near, 4% of r beyond, to the far plane; 160/128 segments), centred in `onBeforeRender` (so the
  bench's camera works), vertices at the surface or under the ground; frustumCulled off, hidden when the camera is > far
  from the coast. Per pixel: the ground (texelFetch, groundAt's triangulation), the surface height again (so edges and foam
  are sharp), the normal from dFdx/dFdy of that point (flattened far off) + the streams' `waveNormals` chop; foam = the
  streams' `foamTexture` thresholded by amount (soft white far off). Water: turbid green-grey in the surf, darker offshore,
  light through a steepening face; alpha 1 − exp(−depth·k). Reflection: the sky dome's colours (`oSky`: overcast/sunny
  gradient from the sky's own uniforms, passed in from weather.js) + glitter; composed as R·F + (1−F)(W·a + dst(1−a)) by
  replacing `opaque_fragment`. Swell amplitude `uOSwell` 0.7 m. Debug trick: output (oFoam, cycle, oFilm) as the colour.
  Budget (container, `still`): beach view phone 22 draws / 0.13M tris (0.10M with `off=water`), desktop 41 / 0.40M;
  phone spawn 186 / 1.19M (the grid is drawn whenever the coast is within the far plane; out of sight it's depth-rejected).
  **Phone bench** (`?bench=ocean&views=beach`, DPR 1.75, full clock): beach full frame 3.4 ms, ocean 0.5 ±0.3 ms (14 draws, 0.10M tris).
- **Lake shore** (lake/pond shader in terrain.js `buildWater`; the user: edges "too straight and geometric"): the flat water
  cut the 5 m terrain triangles along straight lines. Now each water pixel reads the rendered ground under it
  (`shoreGround`, `uGroundH` with groundAt's triangulation) and the water ends where it is 3–30 cm deep by 3-octave value
  noise (2–0.17 m features), lapping ±2.5 cm slowly, so the mesh intersection is never seen (`discard` past the edge).
  Shallows (to ~0.9 m beyond the edge) go clearer (alpha × 0.45–1) toward a muddy bed colour, with a faint broken wet glint
  at the edge. In the marsh (~8 cm deep between tussocks) the edge is 0.5–3.5 cm, or its water vanished. Cost: 4 texelFetch
  + 4 noise lookups on water pixels. Views: `x=279.7&z=416.4&yaw=0.98&pitch=-0.3`, pond `x=-345&z=215&yaw=0.98&pitch=-0.25`.
- **Sun glitter** (`GLITTER_GLSL` + `patchGlitter` in materials.js, used by the lake and stream shaders): world-anchored
  cells (6 cm, doubling with distance in blended power-of-two LODs, `0.004·dist`), each holding one round facet point at a
  random spot that re-rolls 3–7×/s (staggered, fading in/out). A facet flashes with probability exp(−tan²θh/σ²) × 0.3,
  θh = the half vector's tilt from vertical, so sparkles gather into the glitter path by themselves; gain 16 (HDR) plus a
  faint sheen lobe, × `uSun`. σ: lake 0.16 + 0.06·uWet, streams 0.2–0.32 with speed; streams also × canopy toward the sun
  and × (1 − foam). (Whole lit cells read as squares, hence the round points.) Lake rain rings now follow `shared.uRain`
  (the rain amount), not `uWet`, which stays 0.2 in sun and drew rings on a sunny lake. **Smaller sparkles** (the user: "dots are too
  big"): cells 0.04 m, growing at 0.0025·dist (was 0.06 / 0.004), point radius 0.2 of the cell, gain 22. Views (sun):
  shore `x=279.7&z=416.4&yaw=0.98&pitch=-0.12`. Cost: ALU on water pixels only.
- **Puddles** (`patchPuddles` in materials.js; terrain + trail tread): `shared.uPuddle` fills toward 1 over ~40 s whenever
  it rains in the valley (1 − sun, or the `?weather` pin) and dries over ~200 s; `uRain` = the rain amount at the player
  (lake + puddle rain rings). Terrain tiles carry `aHollow` per vertex (5 m Laplacian concavity > 0.02–0.3 m × flat
  (`1 − nv.y` < 0.004–0.012) × forest-floor/mud layers × above the lake): ~1.8% of the land. The cover fills
  from the deepest spot (`pd = hollow × noise`, threshold 1 − 0.55·uPuddle); the tread keeps its noise puddles, growing
  with uPuddle, none within ~15 m of the snowline. In a puddle: albedo × 0.45, roughness 0.05, a flat normal + rain rings
  (injected at `emissivemap_fragment`, after the ground-detail normal), and the specular swapped for the creeks' mirror
  (sky × canopy above the reflected ray, dark banks for low rays, Fresnel max 0.82). The material must declare
  `float puddle` and `vGroundPos`. View: `weather=rain&x=-5&z=665&yaw=0&pitch=-0.45`. Cost: a branch on terrain/trail pixels.
- **Wet rock** (`addGroundCover(..., { film })`, on for scans, pebbles and `Rock`): in rain (`smoothstep(0.6, 0.95, uWet)`:
  overcast-dry is 0.55, rain 1, sun 0.2) bare stone (not moss/snow) gets a patchy water film (trig noise + up-facing bias):
  albedo × 0.82, roughness → 0.14, so it mirrors the sky.
- **Sun map** (`bakeSunMap` in bake.js → `shared.uSunMap`): the crowns again at 1 m, one [1 2 1] blur pass each way
  (R8 over the world, 7.8 MB, same rect as `uCanopyMap`), used only for sunlight: `sunVisibility` (dapple + its overcast
  term), the mist light in post.js and the motes. The soft 2 m map (two 5-tap passes) closed the gaps between crowns, so
  shafts were broad glows. Load +0.4 s in the container. Everything else (rain shelter, puddle/stream reflections, glitter
  shade, instance tints, grass) keeps the soft map.
- **Player head bob** (`player.js` `syncCamera`, no option): gait-based. Phase advances 2π per step, step length
  1 + 0.27 × speed m (the game walks at 5 m/s, so real step lengths would be a 6 Hz jitter): ~2.2 steps/s walking, ~2.9
  running. Head dips (cos − 1)/2 × 3.5 cm per step, sways ±1.2 cm sideways and rolls ±0.004 rad once per stride, all
  × `bobAmp` (eases with speed at 6/s, ×1.5 running, 0 in the air). Replaced a plain 1.3 Hz sine of up to ±7 cm.
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
  alpha-fades over the terrain. **No holes, by construction** (the user found sky showing through at the trailhead and
  around the switchbacks): (1) the cutout mask is rasterised from the corridor's own *opaque, up-facing* triangles and
  eroded a texel (`buildCutoutMask(cover)`), so terrain is only removed under solid strip; (2) the strip is split into an
  opaque interior (`mat`, depth-writing) and the faded fringe (`fringeMat`: transparent, `depthWrite: false`), because a
  fringe drawn first hid the overlapping switchback leg beneath it; (3) a 3 m **skirt** hangs from the opaque boundary
  (|u| = 4.8 m) and across both ends, since around switchbacks the faded edge sits up to ~2 m off the terrain.
  **`tools/holecheck.mjs`** (magenta sky, fog off, looks down along the whole trail and over a 60 m map grid; `trail` for the
  trail only, ~5 min in SwiftShader; exits 1 and lists views) must report no holes after any change to the trail, terrain
  cutout or ground meshes. `rawGroundAt` = terrain mesh height, `groundAt` = with the cut.
- **Trail signs** (`src/signs.js`, one draw; styled on a US trail junction sign, the user's reference photo): Blender
  `signpost` = a post plus one wide board of three planks (1.4 × 0.66 m, top 1.62 m, front at local z −0.115). Its face is
  a canvas atlas (1024 px across, one block per sign) on a quad 3 mm in front (local −Z; the reader's right is −X, swapped
  the quads get back-face culled): brown paint peeling to grey wood, grain, plank seams, two bolts, and white routed
  capitals: the stop's name on top ("Cascadia Woods Trail" at the trailhead), then every other stop in trail order, name
  left, distance along the trail right in miles ("0.3 MI.", 0.1 minimum), and a routed arrow: the board stands beside the
  trail facing it and its local +X runs along the trail (the reader's left), so stops further along get ← before the name,
  those behind → after the distance. The post runs up past the board's top (1.72 m; it stopped under the top plank, which
  hung in the air from behind: the user). Measure text after setting `letterSpacing` or long rows overrun the distances. Texts from `signTexts(trail)`, labels from
  `TRAIL_STOPS`. View: trailhead sign, near spawn.
- **Cairns** (`placeTrailFurniture`, every 30 trail points in snow; the user: some looked about to tumble down the
  mountain): they alternated sides 1 m past the tread edge, often the lip of a fill bank. Now each tries both sides, 6
  offsets from 0.3 m inside the tread edge to 2.1 m out, and ±6 points along, and takes the spot with the least ground
  relief under its base (r 0.75 m) + half that within 1.6 m; seated at lo + 0.35 × range; none if the score is ≥ 0.5 m
  (steep traverses). 35 → 25 cairns, base relief ≤ 0.22 m (was up to 1.3 m). No rng.
- Trail in snow: no flat fill colour (a grey-blue `packed` stripe read as paint). The tread there is the snow's own colour
  lerped 0.4 + 0.45 × groove (1 − (d/width)², deepest mid-tread) toward `packed`, with an edge 0.3 + 0.5·snow m soft, and
  `aTread` × (1 − 0.7·snow) so the tread's dark grit stays off trodden snow.
- **Route search with turning cost** (`route()` in trail.js): the A* state is (cell, heading over the 16 MOVES), and each
  change of direction costs `TURN_COST` (40) × (1 − cos θ)/2 m; cells within half + 4 m of a creek cost `WET_COST` (60 m)
  each, so the trail crosses a creek once, squarely. Before, the cheapest way up steep snow was a ladder of ~10 m legs with
  hairpins every few metres (the user: "very sharp") and once a hairpin crossed the same creek twice. Now: 2.88 km (was
  2.45), 1.5 km in snow, grade p95 21% (was 26%), cross-slope p95 1% (was 12%), 4 footbridges, sharp turns near/above the
  snowline 28 → 7. Trail build 1.2 → 2.2 s (container; 16× the A* states). The new route moved trees near the trail.
  The **skirt** is emitted with both windings, so `computeVertexNormals` averaged them to zero and it rendered **black**
  wherever it showed above ground (the "weird dark spots" at hairpins, and thin black lines along the corridor edge in snow).
  It now has up-facing normals and the strip edge's colour.
- **Hairpins on steep ground** (the user's "dark shape in the snow"): (1) `benchHeight` weights legs by inverse cube of the
  distance from each tread's edge, not a σ = 0.7 m Gaussian (which put the hand-over between two legs into ~0.5 m: walls
  up to 2.6 m); (2) **landings**: tread heights of legs within 2 × BANK_OUTER of each other (not neighbours along the trail)
  are pulled together until the bank between their tread edges is ≤ 1.2 : 1, with light smoothing (40 iterations) —
  steepest 0.5 m steps across the corridor >3 : 1 went 94 → 24 (the rest are footbridge berms), grade p95 21 → 18%;
  (3) the corridor strip **drops flipped triangles** (`facesUp`): on turns tighter than its 5.8 m half-width the strip
  folds over itself and those poked through as shards; (4) strip **normals come from groundAt** slopes, not
  `computeVertexNormals` (folds averaged them downward: black pockets). A per-leg ownership filter was tried and removed:
  it opened a hole. `tools/holecheck.mjs trail`: no holes. Trail build 1.2 → 1.75 s (container).
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
- `src/weather.js`: GPU rain lines (**sheltered**: below ~18 m above the ground, a streak is dropped with probability up to 88% ×
  canopy (the canopy map, ×2.2), so under closed crowns only drips fall and clearings get the full shower; the canopy uniforms are
  attached after `UniformsUtils.merge`, which clones) and snow points wrapped in a box around the camera (plus sun-break **motes**: ~900 soft
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
    ≤10°, and the test catches 34°/90° turns. Draws ~37% of candidates. **Front to back:** `cull()` packs (dm², index) keys of
    the visible instances and heap-sorts them in place (no allocation) before uploading, so each near pool draws nearest first
    and the depth test rejects hidden alpha-tested card pixels before shading (tree cost is fill). Same pixels (A/B diff within
    run-to-run noise). `?off=sort`; bench row `sort` ("unsorted near": its "saves" is negative by what sorting saves). **Phone
    bench** (DPR 1.75, overcast, full clock, after creeks/rocks/glitter/puddles): unsorted costs +0.4 ±0.2 ms at spawn, +0.3 ±0.7
    in the forest, so sorting saves ~0.3–0.4 ms. Spawn full 6.6 ms (trees 2.3, water 0.0 ±0.6), forest 4.0 ms (trees 1.3, water 0.0). Phone tris at spawn 0.79 → 0.60M (forest 0.69 → 0.47M). The dither uses `discard`, which can cost fill rate on Apple GPUs
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
  - Ferns (and salal, maples... everything in 'fade' mode): near pool only; they **dissolve at full size** (screen-space
    dither, like the tree tiers) over the outer ~16% of `uFernRadius`, each instance at its own jittered distance (0.86–1.0 R).
    They used to shrink into the ground, which the user saw as shrubs growing up out of the ground in front of them.
    **Shrub billboards** (the user: "grass and shrubs popping into place"): ferns and salal (`SHRUB`; not pebbles; vine
    maple is a 'trees' kind with its own impostors) get a far tier like the trees: `bakeShrubImpostors` (same bake, square
    frames `aspect: 1`, 64/96 px) and one InstancedMesh per chunk (`chunk.shrubs`), `impostorMaterial(baked, { shrubs })`
    with `patchLod('shrubFar')`: across the near plants' dissolve band it draws exactly the pixels they give up (same
    per-instance jitter and screen dither as 'fade'), then dissolves itself by `shared.uShrubFar` (VIEW_DIST.ferns × 2.4
    phone = 144 m, × 2.2 desktop = 242 m; jittered 0.8–1.0, 12% band), where a fern is a few pixels. Alpha cut 0.22 (thin
    fronds thin out in the mips). Chunks shown between ~0.86 × uFernRadius and uShrubFar. Off with the ferns (`?off=ferns`).
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
  `creek` (opt-in only: a creek with rocks filling the lower screen, `x=463&z=-12.7&yaw=3.13&pitch=-0.4`; the user saw 33 fps
  with autores down at 1.25 looking down a creek), and `&heat=30` renders flat out first (in 200 ms slices), so the run measures the throttled state directly. The full
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
  phase 0.25 + 1.1μ⁵ + 0.9μ²⁴; its density is `fog.mist` (weather.js: the overcast density × `MIST_GAIN` 1.7, *not* cleared in
  sun breaks like the view haze: after the haze went 0.62 → 0.45 the user saw no god rays any more); half-float; **temporally accumulated** (`resolve`: reproject the history by this pixel's depth with
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
  Assets: forest_leaves_04 (2.2 m tile), aerial_rocks_02 (6 m), snow_02 (3 m), brown_mud_02 (2 m), and **aerial_sand** (5 m:
  trampled, footprint-pocked sand). Sand shares snow's slot 2 (no extra samplers: the terrain shader is near iOS's 16):
  `updateGroundDetail(camera, z > 650)` swaps the slot's textures/avg/tile/strength, since snow and sand are never within
  the 45 m detail range of each other; `groundLayers` puts sand weight in slot 2. The per-layer
  `strength` in the manifest scales the photo's contrast (snow 0.45, or its specks read as dirt). `snowCover()` in
  terrain.js is the single sharpened, patchy snow edge used by both `groundColor` and `groundLayers`. If they
  disagree, needle texture shows up on white snow.
  `snowCover` also sheds snow off steep faces (× 1 − smoothstep(0.4, 0.56, slope + rib noise at 0.09)), so peaks show dark
  rock ribs with snow in the gullies; `snowAmount` (snowy trees, weather) is untouched, so no tree moved. Sunny haze at
  altitude: density × (0.45 − 0.3·snowT) in a full sun break (was 0.62: across the lake, looking into the sun, the far
  shore's trees were white "as if snowy"; the user). The fog shader also thins the low valley pool by 70% × sun and the
  forward sun glow in the haze is smaller (0.2μ⁸ + 0.06μ², was 0.28μ⁶ + 0.12μ²). Overcast is unchanged. Cost: +0 draws, about 10 ms of load (the download overlaps the build).
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
  **Matte + ground blend (the user: "still don't look very realistic"):** an A/B found the plastic sheen came from the
  baked normal map's fine crinkles, not reflections: scans now use normalScale 0.45, roughness 1, envMapIntensity 0.6, and
  general wetness only 0.35 on stone (rain gloss comes from the film, roughness → 0.3). `addGroundCover` blends every
  rock/log/stump/furniture surface into the **terrain** (AAA-style terrain-aware blending): `shared.uGroundH` (R32F terrain
  grid, set in main.js) + `gcGroundAt` (same triangulation as groundAt); within ~0.4 m above the ground (ragged edge)
  the surface takes damp duff/moss (snow above the snowline), and the photo fades under it.
  **Seating (`seatStones`, after the scatter and creek rocks; no rng):** pebble clusters lie on the slope fitted over their
  own spread (`normal` placement field → the instance's up; level clusters floated their downhill stones up to 4 m: the
  user found them), boulders lean 80% into the slope over their footprint (≤ 35°: on the rim's near-cliffs a full lean
  buried them), then each sinks until no vertex of its base (lowest quarter of the model) is above `groundAt`, by at most
  30% of its height. The old 0.8 × scale ring left the wide scans (e–h) floating up to 9 m. **`tools/stonecheck.mjs`**
  (preview server running) reports float and how much shows above ground per model; inside the rim: float ≤ 0.03 m,
  shown p50 50–67%. Load +0.4 s (container).
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
  **Distant grass tint:** past the outer ring's fade-out (`shared.uGrassTint` = its fade z..w: 16–28 m desktop, 10–18 m
  phone) the terrain shader mixes toward the grass map's colour × 0.68–0.88 by density × 0.85 (`shared.uGrassMap`, set
  in `buildGrass`), so tufts shrink into ground that already looks grassy instead of bare earth. One texture fetch on
  terrain pixels beyond 16/10 m.
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
  computed position, never lower: CSS transitions restarted from the main thread's stale value and jumped backwards.
  **Real progress, no stalls** (the user: it stalled halfway, then the end flashed by; saved per-device timings were tried
  and dropped at the user's request): each step has a fixed share (`LOAD_SHARE` in main.js) and the long loops report
  how far along they are with `await loadTick(f)` (`src/loadprogress.js`), which every ~40 ms reports to the bar and
  yields a `setTimeout(0)` task so the page paints: `prepareTerrain()` (the height grid, a row at a time, before
  `buildTerrain`), `buildTrail` (async: grid rows, each A* leg), `bakeImpostors` (async: per tree type × albedo/normal, with
  a 1-pixel readback so the GPU work is really done), `scatter`/`buildVegetation` (async: every row of each scatter pass,
  weighted by `SHARE`, then each placement type), and `warmUp` (async: `renderer.compile(object, camera, scene)` in
  batches of 8, then each program in `renderer.info.programs` linked in turn (waits on `isReady()` with
  KHR_parallel_shader_compile, then `getUniforms()`), then 24 draws of cost-balanced batches (vertices × instances) to a
  16×16 target with a pixel readback each; `post.warmUp` runs after visibility is restored, with the normal culled view:
  with everything visible and unculled it drew the whole world at full resolution). `loadTickNow(f)` forces a yield
  between sync steps. Each report glides the bar there in 0.2 s and then creeps 25% further toward the step's end over
  4 s. Awaits keep the scatter's rng order: instance counts are identical. `?perf` logs `longest stall` (SwiftShader:
  2.4 s, was 7+ s and ~30 s of silent warm-up; a real GPU is far faster). `await progress(null)` fills the last 3% over
  350 ms (≤ 0.5 s wait) before "Tap to start".

- Everything is deterministic from `SEED`. Changing noise or scatter order moves every tree.
- Budget history (spawn view, submitted tris / draws). Before tiers: desktop 3.24M/466, phone 1.75M/216
  (the user's phone ran ~18 ms/frame avg, worst mid-20s, no hitches). After tiers: desktop 1.57M/286,
  phone 0.65M/140. Phone `?bench` v1 (iOS 18, 502×812 @1.25): full frame 2.5–3.0 ms, empty scene 0.3–0.5 ms,
  trees ~1 ms, ground ~0.3 ms, everything else (ground detail included) within noise.
  Bench v2: the *same* full scene went from ~3 ms to ~9 ms partway through the run (the phone's GPU clock dropped:
  power saving or heat), so absolute ms vary ~3× with phone state. Paired "saves" stayed steady (± ≤0.5). At the slow clock:
  trees 4.1, ground 1.5, others ~0, empty scene ~1 ms. DPR from 1.25: 1.5 = +0.4–1.4 ms, 2 = +0.9–4.1, 3 = +2.8–11.2.
  Plan for the slow state (~9 ms at the current settings), since that's what sustained play can drop to. Phone DPR
  went 1.25 → 1.5, then → 2 after the user played `?dpr=2` and it looked and ran fine (desktop stays 1.5), then → **1.75**
  once the scene grew: spawn bench full 6.9 ms at 2× vs 4.0 at 1.25× (trees 2.2 vs 1.3), i.e. frame ≈ 2.2 ms fixed + 4.7 ms ×
  pixel share (mostly fill-bound); 1.75× (77% of the pixels) predicted ~5.8 ms and measured **5.8 ms** at spawn (trees 1.8),
  4.3 ms in the forest (trees 1.2). 
  Bench at DPR 2 (804×1300, with bark/rock textures): full 4.7–5.2 ms at full clock, 12–13 ms after the mid-run clock drop
  (it hit ~20–25 s into a flat-out run both times, so it looks like a sustained-load/heat limit). Bark/rock textures 0.0 ±0.3,
  ground detail ~0, trees 1.1–1.6 (4.8 slow), ground 0.6 (2.4 slow), sky 0.3–1.3. In the slow state DPR 2 vs 1.5 costs ~3 ms. 
  **GPU frame pacing** (`src/framepacer.js`; the user's M1 Mac mini: `?perf` said 50–60 fps while the screen showed
  ~5–10, and 4K fullscreen "30 fps" looked far worse): the browser kept calling rAF at 60 Hz while the GPU fell behind,
  so frames queued and most were never shown, and `?perf`/autores (which time rAF) saw nothing wrong. Each frame now ends
  with a `fenceSync`; a frame starts only when ≤ 2 earlier ones are still on the GPU (polled with `getSyncParameter`,
  no blocking; a fence older than 250 ms is dropped), else that rAF is skipped. So the loop runs at the rate the GPU
  delivers, perf and autores see the real frame rate, and `?perf` line 3 shows `gpu-bound N%` (skipped rAFs).
  Desktop autores floor is now a function: 1, or lower for a big canvas (down to ~2 Mpx, min 0.5: a 4K window at DPR 1
  is 8 Mpx), re-read at each step so going fullscreen later counts. Can't be exercised in SwiftShader (it blocks inside
  each frame); verify on the Mac.
  Safety net: `src/autores.js` steps DPR down 0.25 (floor 1.25 phone / 1 desktop) when >10% of frames over a full 120-frame window
  take >22 ms. It holds 2 s after start and after each step, treats >250 ms gaps as pauses, and never steps back up (no
  oscillation). Each step is one framebuffer realloc (a single hitch). Off with `?dpr=`, `?autores=0` or `?still`. The `?perf`
  line 3 shows the current dpr. The logic was tested in node with a fake clock: steady/hitchy/5% slow keep DPR, and sustained
  40 fps steps down. Load in the container (SwiftShader) is ~11 s, ~8 s of it the software-rendered
  warm-up; much faster on a real GPU.

## Backlog (agreed with the user)

- Wet look: done (rain sheltered by the canopy, trunk rivulets, leaf sheen, puddles, wet-rock film). (Done: sharper god-ray shafts, see Sun map.)
- Tree cost is fill-bound (see the reverted mid tier): try cutting card overdraw if the frame budget gets tight.
- (Done: head bob, see Player.)
- **Next (the user's plan, in order):**
  1. (Done: landscape rework, see Map.)
  2. (Done: streams, see Streams.)
  3. (Done: sun glitter, see Sun glitter.)
- Deferred by the user (they test with the sound off): sound — footsteps by surface, birdsong in sun breaks, drips after rain.

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
- Good spots: spawn (default), lake `x=110&z=470&yaw=-0.67`, snowfield `x=90&z=-500&yaw=0.2`,
  high basin `x=70&z=-900&yaw=0.1` (add `&weather=sun`).
