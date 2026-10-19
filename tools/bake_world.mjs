// The world bake (src/world.js): runs the deterministic world generation in node (terrain height
// grid and its horizon AO, the trail's A* route, the vegetation scatter) and writes the gzipped result.
// Usage: node tools/bake_world.mjs <out.bin>   (vite.config.js runs it for builds and the dev server)
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { prepareTerrain, terrainGrid } from '../src/terrain.js';
import { buildTrail } from '../src/trail.js';
import { prototypesFrom, placeVegetation } from '../src/vegetation.js';
import { encodeWorld, decodeWorld } from '../src/world.js';
import { horizonAOGrid } from '../src/bake.js';

const out = process.argv[2];
if (!out) throw new Error('usage: node tools/bake_world.mjs <out.bin>');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** A GLB without its images (node can't decode them, and the bake only needs the geometry). */
function geometryOnly(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
  }
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const binStart = 20 + jsonLen;
  const bin = buf.subarray(binStart, binStart + 8 + buf.readUInt32LE(binStart)); // (chunk header + data)
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); // glTF
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + j.length + bin.length, 8);
  head.writeUInt32LE(j.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16); // JSON
  const glb = Buffer.concat([head, j, bin]);
  return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length);
}

const t0 = performance.now();
const loader = new GLTFLoader();
const protos = prototypesFrom(await Promise.all(['forest', 'rocks'].map((m) => loader.parseAsync(geometryOnly(`${root}/public/models/${m}.glb`), ''))));
await prepareTerrain();
const trail = await buildTrail();
const placements = await placeVegetation(protos, trail);
const bytes = encodeWorld({
  heights: terrainGrid().heights,
  ao: horizonAOGrid(),
  route: trail.route.flatMap((v) => [v.x, v.y]),
  placements,
});
const gz = zlib.gzipSync(bytes, { level: 9 });

// check it reads back: same counts, and nothing moved by more than the quantization
const back = decodeWorld(new Uint8Array(zlib.gunzipSync(gz)));
let worst = 0;
for (const [name, list] of Object.entries(placements)) {
  const b = back.placements[name];
  if (b.length !== list.length) throw new Error(`${name}: ${b.length} read back, ${list.length} baked`);
  list.forEach((it, i) => {
    for (const k of ['x', 'y', 'z']) worst = Math.max(worst, Math.abs(it[k] - b[i][k]));
  });
}
if (worst > 0.0025) throw new Error(`positions off by ${worst} m after reading back`);
const { heights } = terrainGrid();
for (let i = 0; i < heights.length; i++) {
  if (Math.abs(heights[i] - back.heights[i]) > 0.00051) throw new Error(`height ${i} off by ${heights[i] - back.heights[i]} m after reading back`);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(`${out}.tmp`, gz);
fs.renameSync(`${out}.tmp`, out); // (the dev server may be about to read it)
const count = Object.values(placements).reduce((a, l) => a + l.length, 0);
console.log(`world bake: ${count} placements, ${(bytes.length / 1e6).toFixed(1)} MB → ${(gz.length / 1e6).toFixed(2)} MB gzipped, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
