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

### 14. Fix: a creek's 20 m trench near spawn; a forest pond
While checking god rays I found the west creek had cut a sheer-walled trench up to 20 m deep just north of spawn (around
`x=-30&z=560`). It drains into a big closed basin west of the lake, and to reach the lake it had to climb a saddle south
of it; since a stream bed may only fall, it carved straight through. Now water behaves the way it would: small pits along
a creek are filled in (flat floors), and a big closed basin ends the creek in a **pond** at its low spot, west of the lake.
All channels are now at most ~3.5 m deep, and banks lie back further where they're deep. The pond glitters in sun like the
lake. Look: `?weather=sun&x=-345&z=215&yaw=0.98&pitch=-0.15`. Trail checks unchanged (no holes; grades as before).
Note: this moved trees in the west valley a little (ground heights changed there).

### 15. Sharper sunbeams
Sunlight through the trees (sunflecks, the light in the mist, the floating motes) now comes from a sharper, 1 m map of
the crowns instead of a soft, blurred 2 m one, so the gaps between crowns stay open: shafts read as distinct beams with
edges rather than broad glows. Look (sun): spawn `?weather=sun&yaw=0.98&pitch=0.1`. Cost: ~0.4 s more load in the
container, ~8 MB of GPU memory; per-frame cost unchanged (same samples).

### 16. Head bob
Walking now moves your head the way a walk does: a small dip with each footstep (about 2 steps a second), a slight sway
from side to side with each stride and a tiny roll, a bit stronger when running, settling smoothly when you stop. The old
bob was a slow, larger up-and-down wave. No option for it, as agreed. (Not visible in still renders: walk around to judge.)

---

# Third session

### 17. Rocks in the creeks
About 420 rocks now sit in the creek beds, more on the steep runs. The water reacts to each: the current parts around it
and closes behind, heaps up against the upstream face, dips just behind it, and trails a narrow wake of white bubble
streaks with a faint V spreading downstream (longer on fast water), with a thin, broken line of white water where the
current hits the stone. Along the way the creek's ripples became finer (they were metre-sized), steep-run white water
became thin streaks instead of flat patches, and overcast light no longer puts hard glints on the water.
Look: `?x=459.5&z=-4.3&yaw=-0.77&pitch=-0.35`, `?x=463&z=-12.7&yaw=3.13&pitch=-0.4`, in sun `?weather=sun&x=233.4&z=-277.5&yaw=2.88&pitch=-0.4`.
Cost: rocks are instanced boulders (no new draws); the water shader does more work, on creek pixels only.

### 18. Mountains: rock where snow can't hold, clearer air
Snow no longer covers the steepest faces: past about 50° the peaks show dark rock ribs with snow left in the gullies, as
real alpine faces do. In sun the high-altitude haze is also much thinner, so the peaks around the high basin stand out
crisp against the blue instead of fading to white ghosts. Look: `?weather=sun&x=70&z=-900&yaw=0.1`. No cost.

### 19. Snow banked against trunks
In the snow, tree trunks used to end in a hard line where they met the ground. They now rise out of a ragged drift of
snow banked against them, deeper on some sides than others and lit like the snow around it. Look:
`?weather=sun&x=90&z=-500&yaw=0.9&pitch=-0.1`. No cost.

### 20. The trail through snow
The trail across the snowfields was a flat grey-blue stripe that looked painted on. It's now trodden snow: a soft-edged,
slightly greyer groove, most worn down the middle, still easy to follow. Look: `?weather=sun&x=70&z=-900&yaw=0.1`.

### 21. Vine maple leaves
The vine maples' leaf sprays were flat, single-colour cut-outs lying horizontally, so at eye level they showed as thin
bright streaks. The leaves are now shaded (lighter centres, darker edges, mottled, shadowing each other) with deeper lobes,
and each spray is folded into a shallow V along its twig, as real maple sprays hold their leaves, so you see leaves from
any angle. Look: `?x=-30&z=420`. Cost: +229 triangles per maple.

### 22. Performance: nearby trees drawn front to back
The trees are mostly paid for in overlapping needle cards (fill), so nearby trees and ferns are now drawn nearest first:
the GPU then skips most needle pixels hidden behind closer ones before shading them. The picture is identical. I can't
measure the gain here (the container renders in software), so it has a bench row: `?bench=sort,trees` compares it
with the old order ("unsorted near" should come out as a cost).

### 23. Fix: floating rocks on steep slopes (found by the user)
Pebble clusters were laid level, so on steep ground their downhill stones hung in the air (by up to 4 m on talus), and
the wider scanned boulders (slabs, long blocks) floated by up to 9 m because they were seated by a few ground samples
near their middle. Now clusters lie along the slope, boulders lean into it as rocks settle on a hillside, and every
stone is sunk just until no part of its base is above the ground. A new checker (`tools/stonecheck.mjs`) measures it:
inside the map's rim nothing floats by more than 3 cm. Nothing else moved. Cost: ~0.4 s of load.

### 24. Performance: trimmed needle cards, fewer crossed cards
Each needle spray was a rectangle that was ~70% transparent, and the phone still shaded every pixel of it. Cards are now
cut to the spray's outline (a 4–6 sided polygon around the needles), about 45% fewer pixels each, with the needles
exactly where they were. Firs and hemlocks also have half as many crossed cards (as cedars already did). Before/after
renders look the same; branches didn't move. Costs ~15% more triangles, which the phone has shown it doesn't mind.

### 25. Footbridges: level, clear of the water, on dirt berms (found by the user)
The footbridges were as long as the creek is wide, but the trail crosses at an angle, so their ends sat in the water, and
they tilted with the trail. Now each bridge is level, long enough for the angled crossing, 1.25–1.5 m above the water, and
rests on a dirt berm at each end with sloped sides; the trail ramps gently up the berm to the deck (following the path's
curve). Loose stones are kept off the berms. Trail checks unchanged (no holes, same grades and cross-slopes).

---

# Third night

### 26. Writing on the signs
Each signpost's arrows now name where they lead and how far along the trail: e.g. at the trailhead "Lake viewpoint 350 m"
ahead and "Cascadia Woods Trail" behind; at the lake "Snowfield 1.5 km" and "Trailhead 350 m"; then "High basin 600 m",
and "End of trail" at the basin. Cream letters routed into the wood, readable from both sides. Easy to change later
(`src/signs.js`, labels in `TRAIL_STOPS`).

### 27. Ferns and shrubs no longer grow out of the ground
At the edge of their draw distance, ferns, salal and loose stones used to shrink down into the ground, so walking toward
them they seemed to sprout up in front of you. Now they keep their full size and fade in as a fine dissolve, each at a
slightly different distance, the same way trees switch detail levels. Cost: none measurable (same pixels).

### 28. Switchbacks into the snow; the dark spots (found by the user)
The trail used to climb the steep snow in a ladder of ~10 m zig-zags with sharp hairpins. The route search now charges
for every turn, so it makes long, sweeping legs and few hairpins like a built trail (it's longer, 2.9 km, and gentler:
the steepest 5% went from 26% to 21% grade). It also avoids walking along creeks, so it crosses each one once, squarely
(4 footbridges now). The dark spots were the hidden curtain under the trail's edge: its lighting was broken (black)
wherever it peeked above the ground. Fixed, along with thin black lines along the trail edge in the snow. No holes.
Note: the new route moved trees near the trail, and the sign distances updated with it.
