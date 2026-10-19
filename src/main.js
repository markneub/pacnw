import * as THREE from 'three';
import { buildTerrain, buildWater, heightAt, groundAt, terrainGrid, prepareTerrain, sandMap, sandAt } from './terrain.js';
import { onLoadProgress, loadTick, loadTickNow, loadYielded, longestStall } from './loadprogress.js';
import { loadPrototypes, buildVegetation, applyRockTextures, bakeTreeImpostors, bakeShrubImpostors } from './vegetation.js';
import { buildTrail } from './trail.js';
import { Weather } from './weather.js';
import { Player } from './player.js';
import { shared } from './materials.js';
import { SNOWLINE, SPAWN, VIEW_DIST, WORLD_SIZE } from './config.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { installHeightFog, createEnvironment } from './atmosphere.js';
import { shadeGround, setBakedHorizonAO } from './bake.js';
import { NearPool } from './detail.js';
import { buildSigns } from './signs.js';
import { PerfOverlay } from './perf.js';
import { FramePacer } from './framepacer.js';
import { loadGroundDetail, updateGroundDetail } from './grounddetail.js';
import { patchSunlight, addTrunkMoss } from './materials.js';
import { loadSurfaceDetail } from './surfacedetail.js';
import { loadTextureSet } from './textures.js';
import { runBench } from './bench.js';
import { AutoResolution } from './autores.js';
import { buildGrass } from './grass.js';
import { buildStreamWater } from './streamwater.js';
import { buildOcean } from './ocean.js';
import { Post } from './post.js';
import { planCabin, buildCabin, loadCabinAssets } from './cabin.js';
import { loadWorld } from './world.js';

installHeightFog(); // must run before any material compiles
import './style.css';

const params = new URLSearchParams(location.search);
const touch = isTouchDevice();
if (touch) document.body.classList.add('touch');

// Phones get a lighter profile: lower resolution, shorter draw distances
// (mostly hidden by fog anyway) and fewer rain/snow particles.
// Override with ?quality=low|high.
const lowPower = params.get('quality') === 'low' || (params.get('quality') !== 'high' && touch);
if (lowPower) {
  VIEW_DIST.trees = 270;
  VIEW_DIST.rocks = 170;
  VIEW_DIST.ferns = 60; // they shrink into the ground before this
  VIEW_DIST.treeDetail = 40; // ?bench near40: saves ~1 ms at cedar-rich spawn on the user's phone vs 60
}
if (params.has('near')) VIEW_DIST.treeDetail = parseFloat(params.get('near')); // A/B the full-detail tree radius
shared.uLodRadius.value = VIEW_DIST.treeDetail;
shared.uFernRadius.value = VIEW_DIST.ferns;
// the shrubs' billboards carry on to here, where a fern is a few pixels across (impostors.js)
shared.uShrubFar.value = VIEW_DIST.ferns * (lowPower ? 2.4 : 2.2);

// ?off=a,b,... switches parts off to find what costs the most on a device:
// trees, ferns, rocks, terrain, trail, water, sky, weather, env, fog, aa, detail, grass, sun, dapple, post, motes, moss.
// ?dpr=1 forces the render resolution scale.
const off = new Set((params.get('off') ?? '').split(',').filter(Boolean));
patchSunlight.enabled = !off.has('dapple'); // sunlight through the canopy
addTrunkMoss.enabled = !off.has('moss'); // moss sleeves on trunks
NearPool.sort = !off.has('sort'); // near trees/ferns drawn front to back

const postOn = !off.has('post');
// with post-processing the scene renders into an MSAA target, so the canvas itself needs no antialiasing
const renderer = new THREE.WebGLRenderer({ antialias: !off.has('aa') && !postOn, powerPreference: 'high-performance' });
renderer.setPixelRatio(params.has('dpr') ? parseFloat(params.get('dpr'))
  // phones at 1.75x: the scene is mostly fill-bound (bench at spawn: full frame 6.9 ms at 2x vs 4.0 at 1.25x,
  // i.e. ~2.2 ms fixed + ~4.7 ms that scales with pixels), and 1.75x has 77% of 2x's pixels (~5.8 ms)
  : Math.min(window.devicePixelRatio, lowPower ? 1.75 : 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.45;
document.getElementById('app').appendChild(renderer.domElement);
// god rays, soft glow and the grade (post.js); it does the ACES tone mapping itself
const post = new Post(renderer, { samples: off.has('aa') ? 0 : 4 });
post.enabled = postOn;

const scene = new THREE.Scene();
scene.environment = createEnvironment(renderer);
scene.environmentIntensity = 0.55;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, lowPower ? 420 : 900);

const overlay = document.getElementById('overlay');
const status = document.getElementById('status');
const hud = document.getElementById('hud');

// ?perf also logs how long each loading step takes, under the build's commit (shown from the
// start of loading, so you can tell whether a new version has arrived)
const timings = [];
const loadTimes = params.has('perf') ? document.createElement('div') : null;
if (loadTimes) {
  loadTimes.id = 'load-times';
  loadTimes.textContent = `build ${__BUILD_SHA__}`;
  overlay.appendChild(loadTimes);
}
let stepStart = performance.now();
function step(label) {
  const now = performance.now();
  timings.push(`${label} ${(now - stepStart).toFixed(0)} ms`);
  stepStart = now;
}

/**
 * Loading bar. Each loading step has a fixed share of the bar, and the long loops inside the
 * steps report how far along they are (loadprogress.js loadTick), yielding every ~40 ms so the
 * bar can paint. Each report glides the bar to the new spot over 0.2 s and then lets it creep a
 * little further toward the step's end, so even a block that can't report keeps it moving.
 *
 * The bar is a compositor animation (it keeps running while JS is busy). Each move starts from
 * where the bar is now by our own timeline (a CSS transition would start from the main thread's
 * stale value and jump backwards), and it never goes back.
 */
const LOAD_SHARE = { terrain: 0.08, trail: 0.1, impostors: 0.15, vegetation: 0.35, shading: 0.06, textures: 0.01, warmup: 0.22 };
const loadSpan = {}; // [start, end] of each step's share (the last 3% is the finish)
{
  let acc = 0;
  for (const [k, w] of Object.entries(LOAD_SHARE)) loadSpan[k] = [acc, (acc += w)];
}
const fill = document.getElementById('progress-fill');
const bar = { t0: 0, ms: 1, pts: [[0, 0]] }; // the running animation: [offset, scaleX] points
let span = [0, 0];
// where the bar is now, from our own copy of the running animation
function barNow() {
  const u = Math.min(1, (performance.now() - bar.t0) / bar.ms);
  const { pts } = bar;
  for (let i = 1; i < pts.length; i++) {
    if (u <= pts[i][0]) return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * ((u - pts[i - 1][0]) / Math.max(1e-6, pts[i][0] - pts[i - 1][0]));
  }
  return pts[pts.length - 1][1];
}
function animateBar(ms, pts) {
  Object.assign(bar, { t0: performance.now(), ms, pts });
  fill.getAnimations().forEach((a) => a.cancel());
  return fill.animate(pts.map(([offset, x]) => ({ offset, transform: `scaleX(${x})` })), { duration: ms, easing: 'linear', fill: 'forwards' });
}
/** Move the bar to f (0..1) of the current step: glide there, then creep on a little. */
function barTo(f) {
  const from = barNow();
  const to = Math.max(from, span[0] + (span[1] - span[0]) * f);
  const creep = to + 0.25 * (span[1] - to);
  animateBar(4200, [[0, from], [200 / 4200, to], [1, creep]]);
}
onLoadProgress(barTo);
/** Start the named loading step, or with null fill the rest of the bar (resolves when shown). */
function progress(name) {
  loadYielded();
  if (!name) {
    const a = animateBar(350, [[0, barNow()], [1, 1]]);
    // (don't wait on a busy compositor: the start prompt comes after at most 0.5 s)
    return Promise.race([a.finished.catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
  }
  span = loadSpan[name].map((v) => v * 0.97);
  barTo(0);
  return null;
}

async function init() {
  // the world bake (world.js: height grid, trail route, every placement), made at build time.
  // ?world=live computes it all here instead (as the dev server does until it has baked).
  const worldReady = params.get('world') === 'live' ? Promise.resolve(null) : loadWorld(`${import.meta.env.BASE_URL}world.bin`);
  // the models download meanwhile too (they're needed from the impostor bake on)
  const protosReady = loadPrototypes(['forest', 'rocks'].map((m) => `${import.meta.env.BASE_URL}models/${m}.glb`));
  const cabinReady = loadCabinAssets(renderer, { lowPower });
  // close-up ground and bark/rock textures download while the world is being built
  const detailReady = off.has('detail') ? Promise.resolve([false, false])
    : Promise.all([loadGroundDetail(renderer, { lowPower }), loadSurfaceDetail(renderer, { lowPower })]);
  // scanned boulders' photos and baked normals (glTF UVs: no flip)
  const rockTexReady = loadTextureSet(renderer, 'rocks', { lowPower, flipY: false });
  progress('terrain');
  await nextFrame();
  const world = await worldReady;
  step(world ? 'world bake' : 'world bake (none: computing it)');
  await prepareTerrain(world?.heights);
  if (world) setBakedHorizonAO(world.ao); // (the terrain's share of the ground shading)
  const terrain = buildTerrain();
  {
    const { heights, n, step } = terrainGrid(); // the mist pass needs the ground's height
    post.setGround(heights, n, step, -WORLD_SIZE / 2);
    // and objects blend into it (materials.js addGroundCover); read with texelFetch only
    const ht = new THREE.DataTexture(heights, n, n, THREE.RedFormat, THREE.FloatType);
    ht.needsUpdate = true;
    shared.uGroundH.value = ht;
    shared.uGroundGrid.value.set(-WORLD_SIZE / 2, -WORLD_SIZE / 2, step, n);
    shared.uSandMap.value = sandMap();
  }
  scene.add(terrain);
  scene.add(buildWater());
  step('terrain');
  await loadTickNow(1);

  progress('trail');
  await nextFrame();
  const trail = await buildTrail({ route: world?.route });
  await loadTickNow(0.75);
  scene.add(trail.mesh);
  if (!off.has('water')) scene.add(buildStreamWater(trail)); // (the rocks in it skip the footbridges)
  step('trail');

  progress('impostors'); // models + impostor bake
  const protos = await protosReady;
  await loadTickNow(0.1);
  // far trees as billboards (?farTrees=lod: the old 3D far models, for comparison)
  const impostors = params.get('farTrees') === 'lod' ? null : await bakeTreeImpostors(renderer, protos, { lowPower });
  // and the ferns and salal, as a far tier past where the full-detail ones dissolve
  const shrubImpostors = await bakeShrubImpostors(renderer, protos, { lowPower });
  await loadTickNow(1);
  step('tree impostors');
  progress('vegetation'); // the scatter and the instanced chunks
  const cabinPlan = planCabin(trail); // (the scatter keeps clear of it)
  const veg = await buildVegetation(protos, trail, { impostors, shrubImpostors, exclude: cabinPlan.blocked, placements: world?.placements });
  scene.add(veg.group);
  if (veg.placements.signpost) scene.add(buildSigns(trail, veg.placements.signpost));
  step('vegetation');

  progress('shading'); // and grass
  await nextFrame();
  shadeGround(terrain, veg.canopyAt);
  await loadTickNow(0.4);
  shadeGround(trail.mesh, veg.canopyAt);
  step('ground shading');
  await loadTickNow(0.55);

  // grass reads the ground's baked shade, so it comes after shading. ?grass=50 = half the tufts.
  const grass = off.has('grass') ? null
    : buildGrass(terrain, veg.canopyAt, { lowPower, density: params.has('grass') ? parseFloat(params.get('grass')) / 100 : 1 });
  if (grass) scene.add(grass.mesh);
  step('grass');
  await loadTickNow(0.85);

  const weather = new Weather(scene, renderer, { particles: lowPower ? 0.5 : 1 });
  // the sea and its surf (reflecting the weather's sky)
  const ocean = off.has('water') ? null : await buildOcean(weather.sky.uniforms, { lowPower, progress: [0.86, 0.98] });
  if (ocean) scene.add(ocean.mesh);
  // the mountain cabin at the end of the trail (its own model, textures and shaders)
  const cabin = await buildCabin(cabinPlan, cabinReady);
  scene.add(cabin.group);
  if (params.get('door') === 'open') cabin.setOpen(true);
  const player = new Player(camera, renderer.domElement, (pos, r) => {
    veg.collide(pos, r);
    cabin.collide(pos, r);
  });

  // Spawn in the southern valley looking north toward the mountains.
  // ?x=&z=&yaw=&pitch= override this (handy for screenshots / bookmarking).
  const num = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);
  player.place(num('x', SPAWN.x), num('z', SPAWN.z), num('yaw', SPAWN.yaw), num('pitch', SPAWN.pitch));
  if (['rain', 'snow', 'clear'].includes(params.get('weather'))) weather.override = params.get('weather');
  if (params.get('weather') === 'sun') weather.override = 'clear';
  // no sun breaks (always overcast) for ?off=sun and for screenshots, so views stay comparable
  if (off.has('sun') || params.has('still')) weather.sunCycle = false;
  veg.updateNear(camera, true); // fill the near ring before warm-up uploads it
  ocean?.update(camera);
  updateGroundDetail(camera, camera.position.z > 650);

  for (const kind of ['trees', 'ferns', 'rocks']) if (off.has(kind)) veg.disable(kind);
  for (const name of ['terrain', 'trail', 'lake', 'sky']) {
    if (off.has(name === 'lake' ? 'water' : name)) scene.getObjectByName(name).visible = false;
  }
  if (off.has('weather')) weather.particlesOff = true;
  if (off.has('motes')) weather.motesOff = true;
  if (off.has('env')) scene.environment = null;
  if (off.has('fog')) {
    weather.fogOff = scene.fog;
    scene.fog = null;
  }

  const cycleWeather = () => flash(`Weather: ${weather.cycleOverride()}`);
  if (touch) new TouchControls(renderer.domElement, player).onTap = () => cabin.interact(player);
  // desktop: E, or a click while playing, opens the cabin door when the hint shows
  document.addEventListener('keydown', (e) => { if (e.code === 'KeyE') cabin.interact(player); });
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button === 0 && document.pointerLockElement === renderer.domElement) cabin.interact(player);
  });

  progress('textures');
  const [ground, surface] = await detailReady; // before warm-up so their shaders compile now
  const rockTex = await rockTexReady;
  applyRockTextures(rockTex);
  step(`detail textures (ground ${ground ? 'on' : 'off'}, surface ${surface ? 'on' : 'off'}, rocks ${rockTex ? 'on' : 'off'})`);

  progress('warmup');
  await nextFrame();
  await warmUp();
  step('warm-up');
  if (params.has('perf')) {
    const line = `${timings.join(' · ')} · longest stall ${longestStall().toFixed(0)} ms · ready ${(performance.now() / 1000).toFixed(1)} s after navigation`;
    console.info('load:', line);
    // and on the start screen, for phones (no console there): one step per line
    loadTimes.textContent = `build ${__BUILD_SHA__}\n${line.split(' · ').join('\n')}`;
  }

  await progress(null); // fill the rest where it can be seen, then offer the start
  status.textContent = touch ? 'Tap to start' : 'Click to start';
  overlay.classList.add('ready');
  let started = false;
  // ?bench: once started, pause play and run the benchmark (see bench.js)
  const startBench = () => setTimeout(async () => {
    renderer.setAnimationLoop(null);
    // ?bench (everything) · ?bench=trees,grass (just those rows) · &views=spawn · &heat=30 · quick (SwiftShader smoke test)
    const list = (k) => (params.get(k) ?? '').split(',').filter((v) => v && v !== 'all' && v !== 'quick');
    await runBench({
      renderer, scene, camera, player, veg, weather, grass, post, spawn: SPAWN,
      quick: (params.get('bench') ?? '').split(',').includes('quick'), rows: list('bench'), views: list('views'),
      heat: parseFloat(params.get('heat') ?? '0') || 0,
    });
  }, 1000);
  overlay.addEventListener('click', () => {
    weather.enableAudio();
    if (touch) overlay.classList.add('hidden');
    else player.lock();
    if (!started) {
      started = true;
      if (params.has('bench')) startBench();
      // the start box has no instructions, so give a brief hint once
      flash(touch ? 'Slide up to walk · sideways to turn · hold, then drag to look' : 'WASD to walk · Shift to run · mouse to look', 4000);
    }
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === renderer.domElement;
    overlay.classList.toggle('hidden', locked);
    if (!locked) status.textContent = 'Click to resume';
  });
  if (params.has('autostart')) {
    overlay.classList.add('hidden');
    if (params.has('bench')) startBench();
  }

  let showHud = true;
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyH') {
      showHud = !showHud;
      hud.style.display = showHud ? '' : 'none';
    }
    if (e.code === 'KeyR') cycleWeather();
  });

  const clock = new THREE.Clock();
  const lookDir = new THREE.Vector3();
  let visTimer = 0;
  veg.updateVisibility(camera.position);

  const perf = params.has('perf') ? new PerfOverlay(renderer, params.get('perf')) : null;
  // steps resolution down if frames keep missing 60 fps (phones that heat up)
  const autoRes = params.has('dpr') || params.get('autores') === '0' || params.has('still') ? null
    : new AutoResolution(renderer, {
      // phones: 1.25. Desktops: 1, or lower on a big canvas (a 4K window at DPR 1 is 8 Mpx), down
      // to ~2 Mpx or 0.5
      floor: lowPower ? Math.min(renderer.getPixelRatio(), 1.25)
        : () => Math.min(renderer.getPixelRatio(), Math.max(0.5, Math.min(1, Math.sqrt(2.1e6 / (window.innerWidth * window.innerHeight))))),
    });
  const pacer = new FramePacer(renderer);
  if (perf) perf.pacer = pacer;
  let hudTimer = 0;

  let frames = 0;
  renderer.setAnimationLoop(() => {
    if (!pacer.ready()) return; // the GPU is still busy with earlier frames: skip this one
    perf?.begin();
    autoRes?.tick();
    // ?still=N renders N frames then stops (for headless screenshots)
    const still = params.has('still') && ++frames >= (parseInt(params.get('still'), 10) || 3);
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    shared.uTime.value = t;

    player.update(dt);
    cabin.update(dt, t, camera, player, scene);
    weather.update(dt, t, camera);
    updateGroundDetail(camera, camera.position.z > 650); // (snow's detail slot shows sand at the coast)

    veg.updateNear(camera);
    grass?.update(camera);
    ocean?.update(camera);
    visTimer -= dt;
    if (visTimer <= 0) {
      veg.updateVisibility(camera.position);
      visTimer = 0.25;
    }

    hudTimer -= dt;
    if (showHud && hudTimer <= 0) {
      hudTimer = 0.25; // DOM text updates are cheap at 4 Hz, wasteful at 60
      const alt = Math.round(player.pos.y);
      const sand = sandAt(player.pos.x, player.pos.z) > 0.5;
      const zone = cabin.contains(player.pos.x, player.pos.z) ? 'Mountain cabin'
        : sand ? (alt < 4 ? 'Ocean beach' : 'Dunes') : alt > SNOWLINE + 10 ? 'Subalpine snowfield'
        : alt > SNOWLINE - 30 ? 'Upper slopes'
          : alt < 8 ? 'Lakeshore' : 'Temperate rainforest';
      let text = `${zone} · ${alt} m`;
      camera.getWorldDirection(lookDir);
      const g = trail.guide(player.pos.x, player.pos.z, lookDir.x, lookDir.z);
      if (g) {
        text += g.next
          ? ` · Trail: ${g.next.label} ${g.metres >= 950 ? `${(g.metres / 1000).toFixed(1)} km` : `${Math.round(g.metres / 10) * 10} m`}`
          : ' · On the trail';
      }
      hud.textContent = text;
    }

    post.render(scene, camera);
    pacer.submit();
    perf?.end();
    if (still) {
      renderer.setAnimationLoop(null);
      window.__still = renderer.domElement.toDataURL('image/png');
    }
  });

  window.__pacnw = { scene, camera, player, weather, heightAt, groundAt, renderer, trail, veg, grass, post, cabin, worldSize: WORLD_SIZE };
}

let flashTimer;
function flash(msg, ms = 1500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/**
 * Draw everything once, off-screen, before play starts: compiles every shader
 * and uploads every buffer (including far-away instance chunks) so nothing
 * hitches the first time it comes into view.
 */
async function warmUp() {
  const restore = [];
  scene.traverse((o) => {
    restore.push([o, o.visible, o.frustumCulled]);
    o.visible = true;
    o.frustumCulled = false;
  });
  // Queue the shader builds in batches of objects (without KHR_parallel_shader_compile each
  // build blocks right here)
  const drawn = [];
  scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) drawn.push(o); });
  // (each compile() walks the visible scene for its lights: with thousands of meshes that walk was
  // ~1.3 s of the load in the container, so the subtrees without lights are hidden meanwhile;
  // compile() itself doesn't care whether an object is visible)
  const lightless = scene.children.filter((c) => {
    let lit = false;
    c.traverse((o) => { lit ||= o.isLight; });
    return !lit;
  });
  for (const c of lightless) c.visible = false;
  const COMPILE_BATCH = 8;
  for (let i = 0; i < drawn.length; i += COMPILE_BATCH) {
    for (const o of drawn.slice(i, i + COMPILE_BATCH)) renderer.compile(o, camera, scene);
    await loadTick((0.3 * (i + COMPILE_BATCH)) / drawn.length);
  }
  for (const c of lightless) c.visible = true;
  renderer.compile(scene, camera); // (anything left: the scene's own state)
  // Link the shaders one at a time (the slow part), so the loading bar can follow along. With
  // KHR_parallel_shader_compile they build in the background and we wait on each in turn;
  // without it, getUniforms() is where the driver blocks to finish linking.
  const programs = renderer.info.programs ?? [];
  for (const [i, prog] of programs.entries()) {
    while (!prog.isReady()) await new Promise((r) => setTimeout(r, 4));
    prog.getUniforms();
    await loadTick(0.3 + (0.3 * (i + 1)) / programs.length);
  }
  // Then draw everything once in batches: reading a pixel back blocks until the GPU has really
  // finished (buffer and texture uploads included), so that cost lands in loading, not play.
  const target = new THREE.WebGLRenderTarget(16, 16);
  const px = new Uint8Array(4);
  // batches of roughly equal work: vertices x instances (a far-chunk mesh is tiny, a near pool
  // or the grass is not)
  const cost = drawn.map((o) => {
    const g = o.geometry;
    const verts = g?.index ? g.index.count : g?.attributes.position?.count ?? 0;
    return 1000 + verts * (o.isInstancedMesh ? o.count : g?.isInstancedBufferGeometry ? g.instanceCount : 1);
  });
  const total = cost.reduce((a, b) => a + b, 0);
  const BATCHES = 24;
  let done = 0;
  for (let i = 0; i < drawn.length;) {
    let j = i;
    let c = 0;
    while (j < drawn.length && (j === i || c + cost[j] <= total / BATCHES)) c += cost[j++];
    drawn.forEach((o, k) => { o.visible = k >= i && k < j; });
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 1, 1, px);
    renderer.setRenderTarget(null);
    done += c;
    i = j;
    await loadTick(0.6 + (0.35 * done) / total);
  }
  target.dispose();
  for (const [o, visible, culled] of restore) {
    o.visible = visible;
    o.frustumCulled = culled;
  }
  // and the post passes once, with the normal (culled) view: the scene's shaders are ready
  post.warmUp(scene, camera);
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

init().catch((err) => {
  console.error(err);
  status.textContent = `Something went wrong: ${err.message}`;
});
