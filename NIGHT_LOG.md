# Overnight log

Autonomous realism pass while the user slept. Goals: performant, AAA-style realism, dreamy atmosphere.
Each change is its own commit, has an `?off=` switch where it adds rendering cost, and a `?bench` row to measure it.

## Morning checklist

Benchmarks (phone, full clock, no `&heat`; tap to start, wait ~1 min, paste the table):
1. **Overall, sunny:** https://markneub.github.io/pacnw/?bench=trees,ferns,post,motes&weather=sun
   - rows: trees (incl. veterans and backlight), ferns (rebuilt, ~2.5× as many), "- rays/glow" (post passes),
     "- motes".
2. **Overall, overcast:** https://markneub.github.io/pacnw/?bench=trees,ferns,post&weather=rain
3. **Whole post pipeline A/B** (MSAA moved to an offscreen target plus the composite pass): run
   https://markneub.github.io/pacnw/?bench=empty&views=spawn and the same with `&off=post`, then compare the two
   "full" lines.
4. **Dappled sun A/B** (canopy sunlight + backlight): `?bench=trees&views=spawn&weather=sun` vs `&off=dapple`.

Last known phone numbers (before tonight): spawn full ≈ 6.5–7.5 ms. Budget guide: ≲6 ms at full clock.
If something is too expensive, its `?off=` switch confirms it (post, motes, dapple, sun, ferns), and each change is
its own commit.

Things to look at: spawn facing the sun `?weather=sun&yaw=1.0&pitch=0.12`; forest in sun
`?weather=sun&x=-30&z=420&yaw=1.2&pitch=-0.1`; lake `?x=110&z=470&yaw=-0.67` (± `&weather=sun`); the misty old growth
`?x=0&z=600&yaw=0.5`. The weather cycles on its own: ~6 min, starting in a sun break.

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

### 6. Backlit foliage
In a sun break, needle sprays and fern fronds now glow when you look toward the sun through them (light
transmitted through thin leaves, as in the god-ray photo). It's gated by the same canopy sun visibility as the dapples,
so shaded ferns stay dark. A few ALU ops per foliage pixel; `?off=dapple` turns it off together with the dapples.

### 7. Motes in the light
In a sun break, soft specks of dust and seed fluff drift slowly near you (within ~7 m). They're only visible where the
canopy lets the sun through, and brightest looking toward the sun (forward scattering), so they gather in the shafts.
900 points (450 on phones), additive, no texture. `?off=motes`, bench row `motes`.

### 8. Lake reflections
The lake reflected only the load-time overcast environment map, so it was flat grey, especially in a sun break.
It now reflects an analytic scene: a dark, fogged far-shore treeline with jagged spire tops, faint ridges above it,
then sky that follows the current haze colour (warm in a sun break). It uses Schlick Fresnel on the wave-perturbed
normal, so the reflection ripples. A few ALU ops on the lake's pixels only. Best view: `?x=110&z=470&yaw=-0.67`
(add `&weather=sun`).

### 9. Mistier overcast forest
Overcast valley fog density 0.0085 → 0.0106 (+25%), so trunks layer into the mist with depth, as in the misty
old-growth reference. Sun breaks still thin it to 62%. A one-line change in `weather.js` (`LOW.density`) if it's too much.

## Result (phone bench, sun, full clock)
Spawn full 6.5 ms (was 6.5–7.5 before the night): trees 2.1, ferns 0.5 ±0.4, rays/glow ~0, motes 0.
Forest full 5.3 ms: trees 1.4, ferns 0.3. Everything added fits within the previous frame time.

---

# Second night (landscape done in the evening; then the list)

### 10. Streams
Snowmelt creeks now run from the high basin and the foothills down to the lake. Their paths come from a drainage
calculation over the terrain (water routed downhill to the lake), so they follow natural valleys; tributaries merge and
grow wider downstream (≈2 m at the spring, ≈5 m at the lake). The channels are carved into the ground with stony,
snow-free beds and banks easing back to the forest floor; trees stand back from the water and stones line the beds.
The water ripples and flows downstream at a speed set by the slope, breaks into soft white water on steep runs, and
reflects the canopy (dark under trees, sky in the open). Where the trail crosses a creek there's a small plank
footbridge, tilted to the grade where needed, and you walk across on the deck.
Look: a creek near the lake `?x=163&z=66.6&yaw=-1.81&pitch=-0.3`, a snowmelt creek on the snowfield
`?weather=sun&x=-30&z=-432&yaw=-2.25&pitch=-0.3`, a footbridge `?weather=sun&x=246.6&z=-187.1&yaw=-0.64&pitch=-0.2`.
Cost: 4 stream meshes + bridges (phone spawn draws 155 → 173, tris unchanged). `?off=water` hides them.

### 11. Sun glitter on the lake and streams
In a sun break, water facing the sun now sparkles: tiny points of sunlight that flash and vanish, gathering into a
glittering path toward the sun, like a breezy lake on a sunny day. It's physically based in spirit (each spot of water
is a tiny wave facet, and it flashes only when its tilt happens to mirror the sun into your eye), so the path's width and
place follow the view by themselves. Creeks glitter more widely (rougher, faster water), only where sunlight actually
reaches them through the canopy, and not on white water. Fixed along the way: the lake showed rain rings in sunshine.
Look (sun): from the east shore `?weather=sun&x=279.7&z=416.4&yaw=0.98&pitch=-0.12`.
Cost: a few dozen shader ops on water pixels only; no draws or triangles.

### 12. Puddles
When it rains, water now pools in flat hollows of the forest floor and in low spots on the trail. Puddles fill up over
about 40 seconds of rain, spreading out from the deepest spot, and dry slowly (a few minutes) once the sun comes out, so
right after a shower you still see them in the sun. They mirror the canopy and sky (dark under trees, grey sky in gaps)
and show rain rings while it's raining. The lake also no longer shows rain rings in sunshine.
Look: `?weather=rain&x=-5&z=665&yaw=0&pitch=-0.45` (near spawn). Cost: shader work on ground pixels only.

### 13. Wet rocks
In rain, boulders, stones and cairns now get a patchy film of water on their bare stone (not on the moss): darker and
glossy, catching the sky, and they dry off when the rain stops. Compare `?weather=rain` with `?weather=clear` at any
boulder. Cost: a few shader ops on rocks.
