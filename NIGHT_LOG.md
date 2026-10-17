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
