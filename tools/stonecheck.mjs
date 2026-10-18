// Floating-stone check: for every boulder and pebble cluster within 900 m of spawn (inside the rim),
// how far its base (lowest quarter of the model) rises above the rendered ground, and how much of
// it shows above ground. Needs `npx vite preview --port 4173` running. Usage: node tools/stonecheck.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()); });
await page.goto('http://localhost:4173/?autostart&still=1&weather=still');
for (let i = 0; i < 120; i++) { await page.waitForTimeout(2000); if (await page.evaluate(() => !!window.__still)) break; }
console.log(await page.evaluate(() => {
  const { scene, veg } = window.__pacnw;
  // ground height as rendered: raycast-free, use the exported groundAt via the pool's terrain? use heightAt-like groundAt from trail module
  const ground = window.__pacnw.groundAt;
  const res = {};
  const v = { x: 0, y: 0, z: 0 };
  for (const pool of veg.nearPools) {
    const name = pool.name || '';
    const geoms = pool.meshes.map((m) => m.geometry);
    // the lowest vertices of the model (bottom 25% of its height): the outline that meets the ground
    let minY = Infinity, maxY = -Infinity;
    for (const g of geoms) { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { minY = Math.min(minY, p.getY(i)); maxY = Math.max(maxY, p.getY(i)); } }
    const low = [];
    for (const g of geoms) { const p = g.attributes.position; for (let i = 0; i < p.count; i += 3) if (p.getY(i) < minY + 0.25 * (maxY - minY)) low.push([p.getX(i), p.getY(i), p.getZ(i)]); }
    if (!/boulder|pebbles/.test(name)) continue;
    const all = [];
    for (const g of geoms) { const p = g.attributes.position; for (let i = 0; i < p.count; i += 2) all.push([p.getX(i), p.getY(i), p.getZ(i)]); }
    let worst = 0, over20 = 0, over50 = 0, buried = 0, cnt = 0; const exp = [];
    for (let k = 0; k < pool.count; k++) {
      const m = pool.matrices; const o = k * 16;
      const px = pool.xz[k * 2], pz = pool.xz[k * 2 + 1];
      if (Math.hypot(px - 20, pz - 640) > 900 || Math.max(Math.abs(px), Math.abs(pz)) > 1050) continue;
      // the instance floats if its low outline's lowest point at each spot is above the ground there:
      // take, per low vertex, (vertex y - ground); the stone floats by the minimum over its own footprint region... use max over vertices of min(0..)
      let gap = 0;
      for (const [x, y, z] of low) {
        const wx = m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12];
        const wy = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13];
        const wz = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14];
        gap = Math.max(gap, wy - ground(wx, wz));
      }
      let top = -1e9;
      for (const [x, y, z] of all) {
        const wx = m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12];
        const wy = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13];
        const wz = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14];
        top = Math.max(top, wy - ground(wx, wz));
      }
      const sc = Math.hypot(m[o], m[o + 1], m[o + 2]);
      const e = top / ((maxY - minY) * sc); exp.push(e); cnt++; if (e < 0.35) buried++;
      worst = Math.max(worst, gap); if (gap > 0.2) over20++; if (gap > 0.5) over50++;
    }
    exp.sort((a, b) => a - b);
    res[name] = `float worst ${worst.toFixed(2)} >0.2m ${over20} | shown above ground p10 ${(exp[Math.floor(exp.length * 0.1)] * 100).toFixed(0)}% p50 ${(exp[exp.length >> 1] * 100).toFixed(0)}%, <35% shown: ${buried}/${cnt}`;
  }
  return JSON.stringify(res, null, 1);
}));
await browser.close();
