// Finds holes in the ground: places the terrain cuts away (or never covers) where nothing else is drawn.
// The sky and background are painted magenta and the fog is turned off, then the camera flies along the
// trail (where the terrain is cut away under the corridor) and over a grid of the whole map, looking
// down; any magenta below the horizon is a hole.
//
//   npm run build && npx vite preview --port 4173 &   then   node tools/holecheck.mjs [grid_step_m | trail]
//   (the whole check renders ~1,700 views in SwiftShader: ~15 min; `trail` skips the map grid: ~5 min)
//
// Exits 1 (and prints where) if it finds any. Needs Playwright (see CLAUDE.md, headless screenshots).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? '/opt/node-tools/node_modules/playwright');

const TRAIL_ONLY = process.argv[2] === 'trail';
const STEP = TRAIL_ONLY ? 0 : parseFloat(process.argv[2] ?? '60');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://localhost:4173/?autostart&still=1&off=fog,post,weather,grass');
for (let i = 0; i < 120; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => !!window.__still)) break; }

const found = await page.evaluate(async (step) => {
  const { scene, camera, renderer, veg, heightAt, trail } = window.__pacnw;
  scene.getObjectByName('sky').visible = false;
  const magenta = scene.background.clone().setRGB(1, 0, 1);
  scene.background = magenta;
  renderer.setPixelRatio(1);
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  const holes = [];
  const look = (x, z, yaw, pitch, height, tag) => {
    camera.position.set(x, heightAt(x, z) + height, z);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    veg.updateNear(camera, true);
    veg.updateVisibility(camera.position);
    renderer.render(scene, camera);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 230 && px[i + 1] < 40 && px[i + 2] > 230) n++;
    // looking down steeply, the horizon is off screen: any magenta is a hole
    if (n > 3) holes.push({ tag, x: +x.toFixed(1), z: +z.toFixed(1), yaw: +yaw.toFixed(2), px: n });
  };
  // the trail (every 6 m), looking down at it from 6 m up, in two directions
  const pts = trail.points;
  for (let i = 0; i < pts.length; i += 4) {
    const p = pts[i];
    for (const yaw of [0, Math.PI / 2]) look(p.x, p.y, yaw, -1.2, 6, 'trail');
  }
  // the whole map on a grid, looking straight down from 25 m
  // (inside the rim mountains: looking down their steep sides sees past the end of the map, which is not a hole)
  const half = window.__pacnw.worldSize * 0.39;
  if (step) for (let z = -half; z <= half; z += step) for (let x = -half; x <= half; x += step) look(x, z, 0, -Math.PI / 2 + 0.01, 25, 'grid');
  return holes;
}, STEP);

if (found.length) {
  const byTag = {};
  for (const f of found) byTag[f.tag] = (byTag[f.tag] ?? 0) + 1;
  console.log(`${found.length} views show holes (${Object.entries(byTag).map(([k, v]) => `${k} ${v}`).join(', ')}):`);
  for (const f of found) console.log(`  ${f.tag} ?x=${f.x}&z=${f.z}&yaw=${f.yaw}&pitch=-0.6  (${f.px} px)`);
} else console.log('no holes');
await browser.close();
process.exit(found.length ? 1 : 0);
