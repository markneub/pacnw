/**
 * Fine-grained loading progress. The long loading loops (terrain grid, trail legs, the forest
 * scatter, the impostor bake, shader linking in the warm-up) call `await loadTick(f)` with how
 * far through the current loading step they are (0..1). About every SLICE ms of work it reports
 * f and yields until the page has painted a frame (the loading screen is the map being drawn on
 * animation frames: a plain task yield often let the work carry on without a paint, so it moved in
 * fits); between those it returns null, which costs next to nothing to await.
 *
 * `longestStall()` (logged with ?perf) is the longest the main thread went without yielding,
 * i.e. the longest the bar can have sat still waiting on real progress.
 */
const SLICE = 16; // ms (about a frame's work, then a frame: smooth rather than fast)

let report = () => {};
let last = 0;
let stall = 0;

/** Route progress to the bar (main.js) and start the clock. */
export function onLoadProgress(fn) {
  report = fn;
  last = performance.now();
}

/** Note a yield that happened elsewhere (an awaited download, a frame), so it isn't counted as a stall. */
export function loadYielded() {
  last = performance.now();
}

export function loadTick(f) {
  const now = performance.now();
  if (now - last < SLICE) return null;
  stall = Math.max(stall, now - last);
  report(Math.min(1, Math.max(0, f)));
  return afterPaint().then(() => {
    last = performance.now();
  });
}

/** Resolves once the next frame has been painted (or after 100 ms: hidden tabs get no frames). */
export function afterPaint() {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resolve();
    };
    // (a rAF callback runs just before the paint; a task queued from it runs after. In node, for
    // the world bake, a plain task.)
    if (typeof requestAnimationFrame === 'undefined') return setTimeout(go, 0);
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 100);
  });
}

/** Make sure the next loadTick yields (after a step that can't tick, so the bar catches up). */
export function loadTickNow(f) {
  stall = Math.max(stall, performance.now() - last);
  last = -Infinity;
  const s = stall;
  const p = loadTick(f);
  stall = s;
  return p;
}

export function longestStall() {
  return stall;
}
