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
