# Overnight log

Autonomous realism pass while the user slept. Goals: performant, AAA-style realism, dreamy atmosphere.
Each change is its own commit, has an `?off=` switch where it adds rendering cost, and a `?bench` row to measure it.

## Morning checklist

1. Run the full benchmark once: https://markneub.github.io/pacnw/?bench
2. Compare rows against the last known numbers (full frame ≈ 6.5–7.5 ms at spawn on the phone).
3. If something is too expensive, its `?off=` switch confirms it, and its commit can be tuned or reverted alone.

## Changes

### 1. Branchy saplings
Young firs (6.5 m) with foliage to the ground, plain and snowy, from the shared branchy builder.
That retires the last of the old cone trees. ~1.1k tris each (+0.3k snow).

### 2. Sun breaks, dappled light, matte foliage
- **Weather cycle** (`weather.js`): a ~6 min loop between showers and spells of low, warm sun from the
  west-northwest (`SUN_DIR` in `atmosphere.js`). It starts in a sun break. Rain stops, the fog thins to a warm haze
  that glows toward the sun (forward scattering in the fog chunk), the sky tears into broken cloud with a sun glow,
  the direct light strengthens and warms, and exposure drops slightly. Overcast light stays high and soft as before.
  `?weather=sun` pins a break. `?weather=rain|snow` and `?still` (screenshots) pin overcast. `?off=sun` disables the cycle.
- **Sunlight through the canopy** (`patchSunlight` in `materials.js`, on every outdoor material): the sun's direct
  light is scaled by the canopy density along the ray toward the sun (two samples of a GPU copy of the baked canopy
  map), dappled by drifting world-space noise in a break. Clearings are sunlit, the forest floor gets light
  patches, and interiors are shaded. One texture fetch ×2 plus noise per pixel. **Measure:** compare
  `?bench&weather=sun` with `?bench&weather=sun&off=dapple`.
- **Matte foliage:** needle cards and grass now keep only 15% of their direct specular. Grazing-angle Fresnel was
  turning sprays grey-white under a low sun. This improves the overcast look too: deeper, richer greens.

### 3. God rays, soft glow, grade (`src/post.js`)
The scene now renders into an offscreen target (MSAA moved there from the canvas), followed by:
- **Light shafts** in a sun break: bright sky near the sun goes through a two-pass radial blur toward the sun's screen
  position at quarter resolution. The canopy and trunks cut it into rays. They fade as you look away from the sun and
  are skipped entirely in overcast (3 quarter-res passes when on).
- **Soft glow** around bright sky (quarter res, 3 passes).
- **Grade:** warmer highlights in a sun break, slightly cool shadows, a soft vignette, and fine grain that hides fog
  banding.
- **Same image otherwise:** three applies fog *after* tone mapping, so a plain linear HDR target made the fog lighter
  and bluer. The target is flagged so three tone-maps and encodes into it exactly as it does for the canvas. With
  rays/glow off, the composite reproduces the old image (apart from vignette and grain).
- **Measure:** `?bench=post&weather=sun` (row "- rays/glow": the cost of the shafts and glow passes). The whole
  pipeline, including the MSAA move and the full-screen composite, is A/B'd with `?off=post`:
  compare `?bench=trees&views=spawn` with and without `&off=post` (the "full" lines).
- Best view: `?weather=sun&yaw=1.0&pitch=0.12` (spawn, facing the sun) or `?weather=sun&x=110&z=470&yaw=0.9`.

### 4. Sword ferns, rebuilt and doubled
The misty old-growth reference has a sea of knee-to-waist sword ferns. Ours were a few small clumps of solid
polygon fronds.
- **New fern model:** 24–30 arching frond *cards* per clump with a painted frond texture (scaly stipe, toothed pinnae
  with ears, lighter midribs, younger and lighter toward the tip). Young fronds stand up in the middle, older ones
  arch out and droop, and a few lie flat. It uses the tree-card shading (alpha test, darker undersides, matte).
  ~360 tris per clump (was ~310).
- **More and bigger:** about 2.5× as many clumps (denser grid, higher probability in the forest), 0.9–1.8× scale.
- **Budget:** the fern radius drops to 60 m on phones (from 80; they shrink into the ground before the edge) and 110 m
  on desktop (from 150). Phone spawn: 0.54 → 0.65M tris (ferns 0.10 → 0.21M), draws unchanged.
  **Measure:** `?bench=ferns` (row "- ferns"). Ferns were ~0 ms on the phone before; the risk is alpha-test fill near
  the camera.

### 5. Old-growth veterans
About 1 in 8 big conifers in the low, dense forest is now a giant (×1.45–1.85: up to ~60 m tall, trunks ~2 m
across), as in the misty old-growth photo where huge trunks dominate eye level. ~585 trees. They're chosen by a hash
of position, so no other tree moved. Budget unchanged (same draws and pools; slightly bigger crowns).
