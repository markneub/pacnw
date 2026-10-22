import * as THREE from 'three';
import { buildTerrain, buildWater, heightAt, groundAt, terrainGrid, prepareTerrain, sandMap, streams } from './terrain.js';
import { MapSheet, PaperMap } from './map.js';
import { onLoadProgress, loadTick, loadTickNow, loadYielded, longestStall } from './loadprogress.js';
import { loadPrototypes, prepareVegetation, buildVegetation, applyRockTextures, bakeTreeImpostors, bakeShrubImpostors } from './vegetation.js';
import { buildTrail } from './trail.js';
import { Weather } from './weather.js';
import { Player } from './player.js';
import { shared } from './materials.js';
import { SPAWN, VIEW_DIST, WORLD_SIZE, CAVE } from './config.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { installHeightFog, createEnvironment } from './atmosphere.js';
import { shadeGround, setBakedHorizonAO } from './bake.js';
import { NearPool } from './detail.js';
import { buildSigns, buildRoadPlates } from './signs.js';
import { buildRoadMesh } from './roadmesh.js';
import { roadAt, landingAt, ROAD_SURFACE } from './road.js';
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
import { planCave, buildCave, loadCaveAssets } from './cave.js';
import { buildFalls, fallsBlocked, cliffLedges } from './falls.js';
import { LIP } from './fallsshape.js';
import { planCoast, buildCoast, loadCoastAssets } from './coast.js';
import { buildSeats } from './seat.js';
import { createHint } from './hint.js';
import { buildBirds } from './birds.js';

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
// ?perf: how smoothly the loading screen ran, per loading step: frames drawn, the longest gap
// between two frames (a freeze) and how many gaps were over 100 ms
const smooth = loadTimes ? { step: 'start', rows: new Map(), last: 0, done: false } : null;
if (smooth) {
  const frame = () => {
    const now = performance.now();
    let r = smooth.rows.get(smooth.step);
    if (!r) smooth.rows.set(smooth.step, (r = { frames: 0, worst: 0, long: 0 }));
    r.frames++;
    if (smooth.last) {
      // (a gap counts against the step that was running when it began)
      const g = now - smooth.last;
      const w = smooth.rows.get(smooth.lastStep) ?? r;
      w.worst = Math.max(w.worst, g);
      if (g > 100) w.long++;
    }
    smooth.last = now;
    smooth.lastStep = smooth.step;
    if (!smooth.done) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
function step(label) {
  const now = performance.now();
  timings.push(`${label} ${(now - stepStart).toFixed(0)} ms`);
  stepStart = now;
}

/**
 * Loading steps. The long loops inside them call loadprogress.js loadTick, which yields for a
 * painted frame about every 16 ms of work. The loading screen is the paper map (map.js MapSheet),
 * revealed by animations the browser runs off the main thread.
 */
onLoadProgress(() => {});
/** Start the named loading step (for ?perf's smoothness readout). */
function progress(name) {
  loadYielded();
  if (smooth) smooth.step = name;
}

async function init() {
  // the world bake (world.js: height grid, trail route, every placement), made at build time.
  // ?world=live computes it all here instead (as the dev server does until it has baked).
  const worldReady = params.get('world') === 'live' ? Promise.resolve(null) : loadWorld(`${import.meta.env.BASE_URL}world.bin`);
  // the models download meanwhile too (they're needed from the impostor bake on)
  const protosReady = loadPrototypes(['forest', 'rocks'].map((m) => `${import.meta.env.BASE_URL}models/${m}.glb`));
  const cabinReady = loadCabinAssets(renderer, { lowPower });
  const caveReady = loadCaveAssets(renderer, { lowPower });
  const coastReady = loadCoastAssets();
  // close-up ground and bark/rock textures download while the world is being built
  const detailReady = off.has('detail') ? Promise.resolve([false, false])
    : Promise.all([loadGroundDetail(renderer, { lowPower }), loadSurfaceDetail(renderer, { lowPower })]);
  // scanned boulders' photos and baked normals (glTF UVs: no flip)
  const rockTexReady = loadTextureSet(renderer, 'rocks', { lowPower, flipY: false });
  // the loading screen: the paper map unfolds, and is drawn as the world is built
  const sheet = await MapSheet.create(SPAWN);
  const paperMap = new PaperMap(sheet.canvas);
  paperMap.loading(sheet.view);
  paperMap.onFirstFold = () => sheet.compose(true); // (no creases until then)
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
  await sheet.setTerrain(streams(), (f) => loadTick(0.7 + 0.3 * f));
  step('terrain');
  await loadTickNow(1);

  progress('trail');
  await nextFrame();
  const trail = await buildTrail({ route: world?.route });
  await loadTickNow(0.75);
  scene.add(trail.mesh);
  const roadMesh = buildRoadMesh(trail); // Forest Road 2840 (road.js)
  scene.add(roadMesh);
  if (!off.has('water')) scene.add(buildStreamWater(trail)); // (the rocks in it skip the footbridges)
  const cabinPlan = planCabin(trail); // (the scatter keeps clear of it, and of the cave's mouth)
  const cavePlan = planCave();
  const coastPlan = planCoast(); // (the lighthouse, its house and the wreck)
  sheet.setTrail(trail, { cave: { x: CAVE.x, z: CAVE.z }, falls: { x: LIP.x, z: LIP.z + 6 }, cabin: cabinPlan, lighthouse: coastPlan.lighthouse, wreck: coastPlan.wreck });
  step('trail');

  // the placements (less the clear zones) and their canopy, which the map's land needs
  progress('map');
  const protos = await protosReady;
  // (the road: nothing on its surface and shoulders, trees back past its banks)
  const roadBlocked = (x, z, margin, tree) => {
    const r = roadAt(x, z);
    return r.d < ROAD_SURFACE + landingAt(r.s) + (tree ? margin + 0.5 : margin);
  };
  const exclude = (x, z, margin, tree) => cabinPlan.blocked(x, z, margin) || cavePlan.blocked(x, z, margin) || coastPlan.blocked(x, z, margin, tree)
    || fallsBlocked(x, z, margin, tree) || roadBlocked(x, z, margin, tree);
  const prepared = await prepareVegetation(protos, trail, { exclude, placements: world?.placements, extra: cliffLedges() });
  await sheet.setLand(prepared.canopyAt, (f) => loadTick(f));
  step('map');

  progress('impostors'); // the impostor bake
  // far trees as billboards (?farTrees=lod: the old 3D far models, for comparison)
  const impostors = params.get('farTrees') === 'lod' ? null : await bakeTreeImpostors(renderer, protos, { lowPower });
  // and the ferns and salal, as a far tier past where the full-detail ones dissolve
  const shrubImpostors = await bakeShrubImpostors(renderer, protos, { lowPower });
  await loadTickNow(1);
  step('tree impostors');
  progress('vegetation'); // the instanced chunks
  const veg = await buildVegetation(protos, trail, { impostors, shrubImpostors, prepared });
  scene.add(veg.group);
  if (veg.placements.signpost) scene.add(buildSigns(trail, veg.placements.signpost));
  if (veg.placements.road_gate || veg.placements.road_post) scene.add(buildRoadPlates(veg.placements.road_gate, veg.placements.road_post));
  step('vegetation');

  progress('shading'); // and grass
  await nextFrame();
  shadeGround(terrain, veg.canopyAt);
  await loadTickNow(0.4);
  shadeGround(trail.mesh, veg.canopyAt);
  shadeGround(roadMesh, veg.canopyAt);
  step('ground shading');
  await loadTickNow(0.55);

  // grass reads the ground's baked shade, so it comes after shading. ?grass=50 = half the tufts.
  const grass = off.has('grass') ? null
    : buildGrass(terrain, veg.canopyAt, { lowPower, density: params.has('grass') ? parseFloat(params.get('grass')) / 100 : 1 });
  if (grass) scene.add(grass.mesh);
  step('grass');
  await loadTickNow(0.85);

  const weather = new Weather(scene, renderer, { particles: lowPower ? 0.5 : 1 });
  // a moonlit sky to reflect at night (same PMREM size, so swapping it recompiles nothing)
  weather.envs = { day: scene.environment, night: createEnvironment(renderer, { night: true }) };
  if (params.has('night')) weather.setNight(true); // (also: through the cave)
  // the sea and its surf (reflecting the weather's sky)
  const ocean = off.has('water') ? null : await buildOcean(weather.sky.uniforms, { lowPower, progress: [0.86, 0.98] });
  if (ocean) scene.add(ocean.mesh);
  // the mountain cabin at the end of the trail (its own model, textures and shaders)
  const cabin = await buildCabin(cabinPlan, cabinReady);
  // the cave north of the trailhead (its tunnel, ground bank and torches)
  const cave = await buildCave(cavePlan, caveReady, { lowPower });
  scene.add(cave.group);
  terrain.add(cave.patch); // (its finer ground, with the terrain)
  shadeGround(cave.patch, veg.canopyAt);
  scene.add(cabin.group);
  if (params.get('door') === 'open') cabin.setOpen(true);
  // the waterfall off the snow bench: its cliff and alcove, the falling water and spray
  const falls = buildFalls();
  scene.add(falls.group);
  // the lighthouse on the headland, the wreck in the shallows
  const coast = await buildCoast(coastPlan, coastReady);
  scene.add(coast.group);
  shadeGround(coast.headland, veg.canopyAt); // (its copy of the ground for past the far plane, shaded like the tiles)
  // hawks, an eagle, ravens and gulls overhead (birds.js)
  const birds = off.has('birds') ? null : buildBirds({ canopyAt: veg.canopyAt });
  if (birds) scene.add(birds.group);
  const player = new Player(camera, renderer.domElement, (pos, r) => {
    if (cave.state.inside) {
      cave.collide(pos, r); // (in the tunnel the trees overhead don't count)
      return;
    }
    veg.collide(pos, r);
    cabin.collide(pos, r);
    cave.collide(pos, r);
    coast.collide(pos, r);
    falls.collide(pos, r);
  });

  if (touch) player.addGaze(cabin.gaze); // (phones only: with a mouse, looking down is easy, and the view moving by itself fights the hand)

  // Spawn in the southern valley looking north toward the mountains.
  // ?x=&z=&yaw=&pitch= override this (handy for screenshots / bookmarking).
  const num = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);
  player.place(num('x', SPAWN.x), num('z', SPAWN.z), num('yaw', SPAWN.yaw), num('pitch', SPAWN.pitch));
  // ?cave=30: start 30 m into the cave, facing in (yaw/pitch relative to that)
  if (params.has('cave')) {
    const e = cave.exitPoint();
    cave.state.inside = true;
    const p = cave.pointAt(num('cave', 10));
    player.place(p.x, p.z, e.yaw + Math.PI + num('yaw', 0), num('pitch', 0));
  }
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

  // the bench(es) you can sit on, and the one prompt for everything you can tap
  const seats = buildSeats(veg.placements.bench);
  if (touch) for (const g of seats.gaze) player.addGaze({ ...g, active: () => !player.seat && player.sitK === 0 }); // (as the cabin note)
  const hint = createHint();
  const interact = () => seats.interact(player) || cabin.interact(player);
  if (touch) new TouchControls(renderer.domElement, player).onTap = interact;
  // desktop: E, or a click while playing, does what the hint says
  document.addEventListener('keydown', (e) => { if (e.code === 'KeyE') interact(); });
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button === 0 && document.pointerLockElement === renderer.domElement) interact();
  });

  progress('textures');
  const [ground, surface] = await detailReady; // before warm-up so their shaders compile now
  const rockTex = await rockTexReady;
  applyRockTextures(rockTex);
  step(`detail textures (ground ${ground ? 'on' : 'off'}, surface ${surface ? 'on' : 'off'}, rocks ${rockTex ? 'on' : 'off'})`);

  progress('warmup');
  await nextFrame();
  cave.warmUp(renderer); // (its shadow cubes)
  await warmUp();
  step('warm-up');
  const line = `${timings.join(' · ')} · longest stall ${longestStall().toFixed(0)} ms · ready ${(performance.now() / 1000).toFixed(1)} s after navigation`;
  if (loadTimes) console.info('load:', line);

  // the map's last reveals, then the arrow where you stand and the start prompt
  if (smooth) smooth.step = 'reveals';
  await sheet.finish();
  if (loadTimes) {
    // and on the start screen, for phones (no console there): one step per line
    smooth.done = true;
    const rows = [...smooth.rows].map(([k, r]) => `${k.padEnd(10)} ${String(r.frames).padStart(4)} fr · worst ${r.worst.toFixed(0).padStart(4)} ms · ${r.long} over 100`);
    loadTimes.textContent = `build ${__BUILD_SHA__}\n${line.split(' · ').join('\n')}\nsmoothness (frames, longest freeze):\n${rows.join('\n')}`;
  }
  paperMap.loaded(player.pos.x, player.pos.z, player.yaw);
  status.textContent = touch ? 'Tap to start' : 'Click to start';
  overlay.classList.add('ready');
  // starting folds the map away into its corner icon (?map: it stays open); from then on the icon
  // or M unfolds it
  const begin = () => {
    overlay.classList.remove('loading');
    if (!params.has('map')) paperMap.close();
    document.addEventListener('keydown', (e) => { if (e.code === 'KeyM') paperMap.toggle(); });
    document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) paperMap.close(); });
  };
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
      begin();
      if (params.has('bench')) startBench();
    }
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === renderer.domElement;
    overlay.classList.toggle('hidden', locked);
    if (!locked) status.textContent = 'Click to resume';
  });
  if (params.has('autostart')) {
    started = true;
    begin();
    overlay.classList.add('hidden');
    if (params.has('bench')) startBench();
  }

  // The cave's far end is its mouth turned round (cave.js): its opening shows the view out of the
  // mouth at the other time of day, and walking out of it you're moved to the matching spot by the
  // mouth (where nothing on screen differs) and the time of day swaps. No transition.
  const toMouth = cave.portal.toMouth;
  const crossCave = () => {
    const st = cave.state;
    if (st.inside && st.s > cave.turnAt) {
      player.pos.applyMatrix4(toMouth);
      player.yaw += Math.PI;
      player.vel.x = -player.vel.x;
      player.vel.z = -player.vel.z;
      player.syncCamera();
      weather.setNight(!weather.night);
      cave.track(player);
    }
    weather.cave.depth = st.inside ? THREE.MathUtils.smoothstep(Math.min(st.s, cave.length - st.s), 0, 14) : 0;
    weather.cave.torch = cave.nearestTorch();
    // the day/night grade and the light shafts (post.js) only outside: in the cave, and on the view
    // out of its far end, there are none, so nothing changes when you're moved; they come in as you
    // step out of the mouth
    post.outdoors = st.inside ? 1 - THREE.MathUtils.smoothstep(st.s, -2, 6) : 1; // (gently: done by 8 m in, where the far end's turn lands)
    weather.outdoors = post.outdoors;
  };

  // Deep in the tunnel nothing outside can be seen unless you look back at the mouth: then the
  // rest of the world isn't drawn at all (its vertices alone cost more than the cave)
  const mouth = new THREE.Sphere(new THREE.Vector3(cave.mouth.x, cave.mouth.y, cave.mouth.z), 4);
  const frustum = new THREE.Frustum();
  const viewProj = new THREE.Matrix4();
  let hiddenOutdoors = null;
  const outdoorsHidden = () => {
    if (!(cave.state.inside && cave.state.s > 6)) return false;
    camera.updateMatrixWorld();
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProj);
    return !frustum.intersectsSphere(mouth);
  };
  const cullOutdoors = (hide) => {
    if (hide) {
      hiddenOutdoors ??= scene.children.filter((o) => o !== cave.group && !o.isLight && o.visible);
      for (const o of hiddenOutdoors) o.visible = false; // (every frame: the weather re-shows its particles)
    } else if (hiddenOutdoors) {
      for (const o of hiddenOutdoors) o.visible = true;
      hiddenOutdoors = null;
    }
  };

  // The view out of the far end: the scene from the spot by the mouth that matches the camera's
  // (the turn applied to it), at the other time of day, just the part of the screen the opening
  // covers (setViewOffset), at reduced resolution. Drawn on the opening (cave.js portal).
  const portalCam = new THREE.PerspectiveCamera();
  const portalRT = new THREE.WebGLRenderTarget(4, 4);
  portalRT.isXRRenderTarget = true; // (tone mapped and sRGB-encoded like the scene target: post.js)
  portalRT.texture.colorSpace = THREE.SRGBColorSpace;
  portalRT.texture.internalFormat = 'RGBA8';
  portalRT.scissorTest = true;
  cave.portal.uniforms.tPortal.value = portalRT.texture;
  const PORTAL_RES = lowPower ? 0.75 : 1;
  const bufSize = new THREE.Vector2();
  const pv = new THREE.Vector3();
  const portalRect = { x: 0, y: 0, w: 0, h: 0 };
  /** Where the far opening is on screen (drawing-buffer pixels, origin bottom left); false if not in view. */
  const preparePortal = () => {
    if (!cave.group.visible || !cave.canSeeFarEnd(camera)) return false;
    renderer.getDrawingBufferSize(bufSize);
    camera.updateMatrixWorld();
    let x0 = 1;
    let y0 = 1;
    let x1 = -1;
    let y1 = -1;
    let behind = 0;
    for (const p of cave.portal.ring) {
      pv.copy(p).applyMatrix4(camera.matrixWorldInverse);
      if (pv.z > -camera.near) {
        behind++;
        continue;
      }
      pv.applyMatrix4(camera.projectionMatrix);
      x0 = Math.min(x0, pv.x);
      x1 = Math.max(x1, pv.x);
      y0 = Math.min(y0, pv.y);
      y1 = Math.max(y1, pv.y);
    }
    if (behind === cave.portal.ring.length) return false;
    if (behind) [x0, y0, x1, y1] = [-1, -1, 1, 1];
    x0 = Math.max(-1, x0);
    y0 = Math.max(-1, y0);
    x1 = Math.min(1, x1);
    y1 = Math.min(1, y1);
    if (x1 <= x0 || y1 <= y0) return false;
    const W = bufSize.x;
    const H = bufSize.y;
    portalRect.x = Math.max(0, Math.floor((x0 * 0.5 + 0.5) * W) - 2);
    portalRect.y = Math.max(0, Math.floor((y0 * 0.5 + 0.5) * H) - 2);
    portalRect.w = Math.min(W, Math.ceil((x1 * 0.5 + 0.5) * W) + 2) - portalRect.x;
    portalRect.h = Math.min(H, Math.ceil((y1 * 0.5 + 0.5) * H) + 2) - portalRect.y;
    portalCam.fov = camera.fov;
    portalCam.aspect = camera.aspect;
    portalCam.near = camera.near;
    portalCam.far = camera.far;
    portalCam.setViewOffset(W, H, portalRect.x, H - portalRect.y - portalRect.h, portalRect.w, portalRect.h);
    portalCam.matrixWorld.multiplyMatrices(toMouth, camera.matrixWorld);
    portalCam.matrixWorld.decompose(portalCam.position, portalCam.quaternion, portalCam.scale);
    portalCam.updateMatrixWorld(true);
    return true;
  };
  // the light coming in at either end, for the cave's walls (cave.js uOutA/B)
  const sunPart = new THREE.Color();
  const daylight = (out) => out.copy(weather.hemi.color).multiplyScalar(weather.hemi.intensity * 0.45)
    .add(sunPart.copy(weather.sun.color).multiplyScalar(weather.sun.intensity * 0.12));
  const lightHere = new THREE.Color();
  const lightThere = new THREE.Color();
  let portalAge = 1e9;
  let portalShown = false;
  // The far view's near plane is the mouth itself (an oblique near plane, as three's Reflector does): from
  // deep in the tunnel its camera also drew the tunnel between it and the mouth, which then slid across the
  // opening as you walked (the user: "ground or rock passing across the exit").
  const mouthPlane = new THREE.Plane();
  const clip4 = new THREE.Vector4();
  const q4 = new THREE.Vector4();
  const obliqueNear = (cam) => {
    const o = shared.uCaveO.value;
    const d = shared.uCaveDir.value;
    // keep what's out past the mouth (s < 0.2): the normal points out of the cave
    mouthPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(-d.x, 0, -d.y), new THREE.Vector3(o.x + d.x * 0.2, o.y, o.z + d.y * 0.2));
    mouthPlane.applyMatrix4(cam.matrixWorldInverse);
    if (mouthPlane.constant >= 0) return; // (the camera is already outside it: nothing to cut)
    clip4.set(mouthPlane.normal.x, mouthPlane.normal.y, mouthPlane.normal.z, mouthPlane.constant);
    const e = cam.projectionMatrix.elements;
    q4.set((Math.sign(clip4.x) + e[8]) / e[0], (Math.sign(clip4.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    clip4.multiplyScalar(2 / clip4.dot(q4));
    e[2] = clip4.x;
    e[6] = clip4.y;
    e[10] = clip4.z + 1;
    e[14] = clip4.w;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  };
  const renderPortal = (on, t) => {
    const pu = cave.portal.uniforms;
    cave.setDaylight(daylight(lightHere), portalShown ? null : lightHere);
    portalAge++;
    if (!on) {
      pu.uOn.value = 0;
      portalShown = false;
      return;
    }
    // a small opening (far off) is re-rendered only every few frames; it stays on the opening (uVP)
    const small = portalRect.w * portalRect.h < 3000;
    if (portalShown && small && portalAge < 6) return;
    portalAge = 0;
    portalShown = true;
    const W = bufSize.x;
    const H = bufSize.y;
    const rw = Math.max(16, Math.round(W * PORTAL_RES));
    const rh = Math.max(16, Math.round(H * PORTAL_RES));
    if (portalRT.width !== rw || portalRT.height !== rh) portalRT.setSize(rw, rh);
    const vw = Math.max(1, Math.round(portalRect.w * PORTAL_RES));
    const vh = Math.max(1, Math.round(portalRect.h * PORTAL_RES));
    portalRT.viewport.set(0, 0, vw, vh);
    portalRT.scissor.set(0, 0, vw, vh);
    portalCam.updateProjectionMatrix();
    obliqueNear(portalCam);
    if (hiddenOutdoors) for (const o of hiddenOutdoors) o.visible = true;
    cave.portal.cap.visible = false;
    weather.atOtherTime(t, portalCam, () => {
      daylight(lightThere);
      renderer.setRenderTarget(portalRT);
      renderer.render(scene, portalCam);
      renderer.setRenderTarget(null);
    });
    cave.portal.cap.visible = true;
    if (hiddenOutdoors) for (const o of hiddenOutdoors) o.visible = false;
    pu.uRect.value.set(portalRect.x, portalRect.y, portalRect.w, portalRect.h);
    pu.uUvMax.value.set(vw / rw, vh / rh);
    pu.uVP.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    pu.uBuf.value.copy(bufSize);
    pu.uOn.value = 1;
    cave.setDaylight(lightHere, lightThere);
  };

  const clock = new THREE.Clock();
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
  if (perf) {
    perf.pacer = pacer;
    perf.player = player;
  }

  let frames = 0;
  const tick = () => {
    perf?.begin();
    autoRes?.tick();
    // ?still=N renders N frames then stops (for headless screenshots)
    const still = params.has('still') && ++frames >= (parseInt(params.get('still'), 10) || 3);
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    shared.uTime.value = t;

    // crouch a little in the cave, from a few metres in (either end: its far end is its mouth again)
    const caveDepth = Math.min(cave.state.s, CAVE.length - cave.state.s);
    player.crouchTarget = cave.state.inside ? THREE.MathUtils.smoothstep(caveDepth, 0.5, 3) : 0;
    player.update(dt);
    cabin.update(dt, t, camera, player, scene);
    seats.update(camera, player);
    hint(cabin.prompt ?? seats.prompt);
    paperMap.update(player.pos.x, player.pos.z, player.yaw);
    coast.update(dt, t, camera);
    cave.track(player);
    falls.track(player);
    crossCave();
    cave.update(dt, t, camera, renderer);
    falls.update(dt, t, weather, camera);
    weather.update(dt, t, camera);
    birds?.update(dt, t, camera, weather.night);
    updateGroundDetail(camera, camera.position.z > 650); // (snow's detail slot shows sand at the coast)

    // deep in the cave with only the far end in view, the world's detail follows the view out of it
    const hideOutdoors = outdoorsHidden();
    const portalOn = preparePortal();
    const detailCam = hideOutdoors && portalOn ? portalCam : camera;
    veg.updateNear(detailCam);
    grass?.update(detailCam);
    ocean?.update(camera);
    visTimer -= dt;
    if (visTimer <= 0) {
      veg.updateVisibility(detailCam.position);
      visTimer = 0.25;
    }

    cullOutdoors(hideOutdoors);
    renderPortal(portalOn, t);
    post.render(scene, camera);
    pacer.submit();
    perf?.end();
    if (still) {
      renderer.setAnimationLoop(null);
      window.__still = renderer.domElement.toDataURL('image/png');
    }
  };
  renderer.setAnimationLoop(() => {
    if (pacer.ready()) tick(); // (else the GPU is still busy with earlier frames: skip this one)
  });

  // (scripted screenshots: one frame of the loop, also after ?still has stopped it)
  window.__pacnw = { tick: () => tick(), cave, scene, camera, player, weather, heightAt, groundAt, renderer, trail, veg, grass, post, cabin, coast, birds, paperMap, worldSize: WORLD_SIZE };
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
  const COMPILE_BATCH = 2; // (small: the loading screen gets a frame between them)
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
  const BATCHES = 60;
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
