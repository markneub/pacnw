import * as THREE from 'three';
import { buildTerrain, buildWater, heightAt } from './terrain.js';
import { loadPrototypes, buildVegetation } from './vegetation.js';
import { buildTrail } from './trail.js';
import { Weather } from './weather.js';
import { Player } from './player.js';
import { shared } from './materials.js';
import { SNOWLINE, SPAWN } from './config.js';
import './style.css';

const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.45;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 900);

const overlay = document.getElementById('overlay');
const status = document.getElementById('status');
const hud = document.getElementById('hud');

async function init() {
  status.textContent = 'Shaping the valley…';
  await nextFrame();
  scene.add(buildTerrain());
  scene.add(buildWater());

  status.textContent = 'Cutting the trail…';
  await nextFrame();
  const trail = buildTrail();
  scene.add(trail.mesh);

  status.textContent = 'Growing the forest…';
  const protos = await loadPrototypes(`${import.meta.env.BASE_URL}models/forest.glb`);
  await nextFrame();
  const veg = buildVegetation(protos, trail);
  scene.add(veg.group);

  const weather = new Weather(scene, renderer);
  const player = new Player(camera, renderer.domElement, veg.collide);

  // Spawn in the southern valley looking north toward the mountains.
  // ?x=&z=&yaw=&pitch= override this (handy for screenshots / bookmarking).
  const num = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);
  player.place(num('x', SPAWN.x), num('z', SPAWN.z), num('yaw', SPAWN.yaw), num('pitch', SPAWN.pitch));
  if (['rain', 'snow', 'clear'].includes(params.get('weather'))) weather.override = params.get('weather');

  status.textContent = 'Click to walk';
  overlay.classList.add('ready');
  overlay.addEventListener('click', () => {
    player.lock();
    weather.enableAudio();
  });
  document.addEventListener('pointerlockchange', () => {
    overlay.classList.toggle('hidden', document.pointerLockElement === renderer.domElement);
  });
  if (params.has('autostart')) overlay.classList.add('hidden');

  let showHud = true;
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyH') {
      showHud = !showHud;
      hud.style.display = showHud ? '' : 'none';
    }
    if (e.code === 'KeyR') flash(`Weather: ${weather.cycleOverride()}`);
  });

  const clock = new THREE.Clock();
  const lookDir = new THREE.Vector3();
  let visTimer = 0;
  veg.updateVisibility(camera.position);

  let frames = 0;
  renderer.setAnimationLoop(() => {
    // ?still=N renders N frames then stops (for headless screenshots)
    const still = params.has('still') && ++frames >= (parseInt(params.get('still'), 10) || 3);
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    shared.uTime.value = t;

    player.update(dt);
    weather.update(dt, t, camera);

    visTimer -= dt;
    if (visTimer <= 0) {
      veg.updateVisibility(camera.position);
      visTimer = 0.25;
    }

    if (showHud) {
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
    if (still) {
      renderer.setAnimationLoop(null);
      window.__still = renderer.domElement.toDataURL('image/png');
    }
  });

  window.__pacnw = { scene, camera, player, weather, heightAt, renderer, trail };
}

let flashTimer;
function flash(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 1500);
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
