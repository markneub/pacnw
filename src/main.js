import * as THREE from 'three';
import { buildTerrain, buildWater, heightAt } from './terrain.js';
import { loadPrototypes, buildVegetation } from './vegetation.js';
import { buildTrail } from './trail.js';
import { Weather } from './weather.js';
import { Player } from './player.js';
import { shared } from './materials.js';
import { SNOWLINE, SPAWN, VIEW_DIST } from './config.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { installHeightFog, createEnvironment } from './atmosphere.js';
import { shadeGround } from './bake.js';
import { PerfOverlay } from './perf.js';
import { loadGroundDetail } from './grounddetail.js';

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
  VIEW_DIST.ferns = 80;
  VIEW_DIST.treeDetail = 60;
}
shared.uLodRadius.value = VIEW_DIST.treeDetail;
shared.uFernRadius.value = VIEW_DIST.ferns;

// ?off=a,b,... switches parts off to find what costs the most on a device:
// trees, ferns, rocks, terrain, trail, water, sky, weather, env, fog, aa, detail.
// ?dpr=1 forces the render resolution scale.
const off = new Set((params.get('off') ?? '').split(',').filter(Boolean));

const renderer = new THREE.WebGLRenderer({ antialias: !off.has('aa'), powerPreference: 'high-performance' });
renderer.setPixelRatio(params.has('dpr') ? parseFloat(params.get('dpr'))
  : Math.min(window.devicePixelRatio, lowPower ? 1.25 : 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.45;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.environment = createEnvironment(renderer);
scene.environmentIntensity = 0.55;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, lowPower ? 420 : 900);

const overlay = document.getElementById('overlay');
const status = document.getElementById('status');
const hud = document.getElementById('hud');

// ?perf also logs how long each loading step takes
const timings = [];
let stepStart = performance.now();
function step(label) {
  const now = performance.now();
  timings.push(`${label} ${(now - stepStart).toFixed(0)} ms`);
  stepStart = now;
}

/**
 * Loading bar. Steps block the main thread, so each step animates the bar
 * (a compositor transform, which keeps running while JS is busy) toward
 * where that step should end, over roughly how long it usually takes.
 */
const fill = document.getElementById('progress-fill');
function progress(to, expectedMs) {
  fill.style.transitionDuration = `${expectedMs}ms`;
  fill.style.transform = `scaleX(${to})`;
}

async function init() {
  // close-up ground textures download while the world is being built
  const groundDetailReady = off.has('detail') ? Promise.resolve(false) : loadGroundDetail(renderer, { lowPower });
  progress(0.1, 500);
  await nextFrame();
  const terrain = buildTerrain();
  scene.add(terrain);
  scene.add(buildWater());
  step('terrain');

  progress(0.22, 700);
  await nextFrame();
  const trail = buildTrail();
  scene.add(trail.mesh);
  step('trail');

  progress(0.5, 1600);
  const protos = await loadPrototypes(`${import.meta.env.BASE_URL}models/forest.glb`);
  await nextFrame();
  const veg = buildVegetation(protos, trail);
  scene.add(veg.group);
  step('vegetation');

  progress(0.6, 500);
  await nextFrame();
  shadeGround(terrain, veg.canopyAt);
  shadeGround(trail.mesh, veg.canopyAt);
  step('ground shading');

  const weather = new Weather(scene, renderer, { particles: lowPower ? 0.5 : 1 });
  const player = new Player(camera, renderer.domElement, veg.collide);

  // Spawn in the southern valley looking north toward the mountains.
  // ?x=&z=&yaw=&pitch= override this (handy for screenshots / bookmarking).
  const num = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);
  player.place(num('x', SPAWN.x), num('z', SPAWN.z), num('yaw', SPAWN.yaw), num('pitch', SPAWN.pitch));
  if (['rain', 'snow', 'clear'].includes(params.get('weather'))) weather.override = params.get('weather');
  veg.updateNear(camera.position, true); // fill the near ring before warm-up uploads it

  for (const kind of ['trees', 'ferns', 'rocks']) if (off.has(kind)) veg.disable(kind);
  for (const name of ['terrain', 'trail', 'lake', 'sky']) {
    if (off.has(name === 'lake' ? 'water' : name)) scene.getObjectByName(name).visible = false;
  }
  if (off.has('weather')) weather.particlesOff = true;
  if (off.has('env')) scene.environment = null;
  if (off.has('fog')) {
    weather.fogOff = scene.fog;
    scene.fog = null;
  }

  const cycleWeather = () => flash(`Weather: ${weather.cycleOverride()}`);
  if (touch) new TouchControls(renderer.domElement, player); // eslint-disable-line no-new

  const detail = await groundDetailReady; // before warm-up so its shaders compile now
  step(detail ? 'ground detail' : 'ground detail (none)');

  progress(0.98, 2500);
  await nextFrame();
  warmUp();
  step('warm-up');
  if (params.has('perf')) console.info('load:', timings.join(' · '));

  progress(1, 200);
  status.textContent = touch ? 'Tap to start' : 'Click to start';
  overlay.classList.add('ready');
  let started = false;
  overlay.addEventListener('click', () => {
    weather.enableAudio();
    if (touch) overlay.classList.add('hidden');
    else player.lock();
    if (!started) {
      started = true;
      // the start box has no instructions, so give a brief hint once
      flash(touch ? 'Slide up to walk · slide sideways to turn' : 'WASD to walk · Shift to run · mouse to look', 4000);
    }
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === renderer.domElement;
    overlay.classList.toggle('hidden', locked);
    if (!locked) status.textContent = 'Click to resume';
  });
  if (params.has('autostart')) overlay.classList.add('hidden');

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

  const perf = params.has('perf') ? new PerfOverlay(renderer) : null;
  let hudTimer = 0;

  let frames = 0;
  renderer.setAnimationLoop(() => {
    // ?still=N renders N frames then stops (for headless screenshots)
    const still = params.has('still') && ++frames >= (parseInt(params.get('still'), 10) || 3);
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    shared.uTime.value = t;

    player.update(dt);
    weather.update(dt, t, camera);

    veg.updateNear(camera.position);
    visTimer -= dt;
    if (visTimer <= 0) {
      veg.updateVisibility(camera.position);
      visTimer = 0.25;
    }

    hudTimer -= dt;
    if (showHud && hudTimer <= 0) {
      hudTimer = 0.25; // DOM text updates are cheap at 4 Hz, wasteful at 60
      const alt = Math.round(player.pos.y);
      const zone = alt > SNOWLINE + 10 ? 'Subalpine snowfield'
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

    renderer.render(scene, camera);
    perf?.tick();
    if (still) {
      renderer.setAnimationLoop(null);
      window.__still = renderer.domElement.toDataURL('image/png');
    }
  });

  window.__pacnw = { scene, camera, player, weather, heightAt, renderer, trail, veg };
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
function warmUp() {
  const restore = [];
  scene.traverse((o) => {
    restore.push([o, o.visible, o.frustumCulled]);
    o.visible = true;
    o.frustumCulled = false;
  });
  renderer.compile(scene, camera);
  const target = new THREE.WebGLRenderTarget(16, 16);
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  // reading a pixel back blocks until the GPU has really finished (shader
  // linking and buffer uploads included), so that cost lands in loading, not play
  renderer.readRenderTargetPixels(target, 0, 0, 1, 1, new Uint8Array(4));
  renderer.setRenderTarget(null);
  target.dispose();
  for (const [o, visible, culled] of restore) {
    o.visible = visible;
    o.frustumCulled = culled;
  }
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
