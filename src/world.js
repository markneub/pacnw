/**
 * The world bake: the slow, deterministic part of loading, computed at build time and loaded
 * ready-made (tools/bake_world.mjs writes it; the vite plugin in vite.config.js runs that).
 *
 * It holds the terrain's height grid and horizon AO, the trail's A* route and every placement of the scatter
 * (355k: trees, ferns, salal, stones...), i.e. what used to take ~25 s of the load in the
 * container. Everything after those (meshes, instancing, the canopy bake...) is still built here
 * from them, so the file stays small and what's drawn is exactly what the colliders see.
 *
 * Format: one gzip stream (the browser's own DecompressionStream inflates it) of
 *   u32 header length · header JSON · column bytes
 * where each column is a typed array with its bytes shuffled (all the first bytes, then all the
 * second bytes...: gzip compresses that far better). Heights are kept to the mm (as the miss
 * from a plane through their neighbours). Big placement lists are quantized: x/z to 1/256 m and y to the mm (as steps from the
 * previous item), angles, scales and normals to 16 bits, tints to 8; short lists (trail
 * furniture) and other fields are kept exactly, as float64.
 */

const VERSION = 1;
const TYPES = { i32: Int32Array, u16: Uint16Array, u8: Uint8Array, i16: Int16Array, f32: Float32Array, f64: Float64Array };
const TAU = Math.PI * 2;
const EXACT_BELOW = 1000; // lists shorter than this keep every field as float64

// quantized codecs for the big lists: [type, encode, decode]
const CODECS = {
  pos: ['i32', (v) => Math.round(v * 256), (q) => q / 256], // ≤ 2 mm off
  mm: ['i32', (v) => Math.round(v * 1000), (q) => q / 1000],
  angle: ['u16', (v) => Math.round(((((v % TAU) + TAU) % TAU) / TAU) * 65535) % 65535, (q) => (q / 65535) * TAU],
  scale: ['u16', (v) => Math.round(v * 4000), (q) => q / 4000], // ≤ 16.4
  unit: ['u8', (v) => Math.round(v * 255), (q) => q / 255],
  dir: ['i16', (v) => Math.round(v * 32767), (q) => q / 32767],
  // an up-facing unit normal as its x and z (y = the rest)
  normal: ['i16', (v) => Math.round(v * 32767), (q) => q / 32767],
  f64: ['f64', (v) => v, (q) => q],
};
const FIELD_CODEC = { x: 'pos', y: 'mm', z: 'pos', rotY: 'angle', scale: 'scale', scaleX: 'scale', tint: 'unit', normal: 'normal' };
const DELTA = new Set(['x', 'y', 'z']); // stored as differences from the previous item (they move by a cell at a time)

/** A grid value from its left, upper and upper-left neighbours (a plane through them). */
function predict(g, i, side) {
  const x = i % side;
  if (i < side) return x ? g[i - 1] : 0;
  if (!x) return g[i - side];
  return g[i - 1] + g[i - side] - g[i - side - 1];
}

function shuffle(arr) {
  const w = arr.BYTES_PER_ELEMENT;
  const n = arr.length;
  const src = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  if (w === 1) return src.slice();
  const out = new Uint8Array(src.length);
  for (let b = 0; b < w; b++) {
    const o = b * n;
    for (let i = 0; i < n; i++) out[o + i] = src[i * w + b];
  }
  return out;
}

function unshuffle(bytes, type, n) {
  const Arr = TYPES[type];
  const w = Arr.BYTES_PER_ELEMENT;
  const out = new Arr(n);
  if (w === 1) {
    out.set(bytes);
    return out;
  }
  const dst = new Uint8Array(out.buffer);
  for (let b = 0; b < w; b++) {
    const o = b * n;
    for (let i = 0; i < n; i++) dst[i * w + b] = bytes[o + i];
  }
  return out;
}

/**
 * Pack the bake into bytes (not yet compressed): { heights: Float32Array, ao: Uint8Array (the
 * terrain's horizon AO per grid vertex, bake.js), route: [x0, z0, ...], placements: { name: [{ x, y, z, ... }] } }.
 */
export function encodeWorld({ heights, ao, route, placements }) {
  const columns = [];
  const blobs = [];
  const column = (arr) => {
    columns.push([Object.keys(TYPES).find((k) => arr instanceof TYPES[k]), arr.length]);
    blobs.push(shuffle(arr));
    return columns.length - 1;
  };
  // heights in mm, as the miss from a plane through the three neighbours already written
  // (the ground is smooth, so the misses are tiny)
  const side = Math.round(Math.sqrt(heights.length));
  const hmm = Int32Array.from(heights, (h) => Math.round(h * 1000));
  const hq = new Int32Array(heights.length);
  for (let i = 0; i < hmm.length; i++) hq[i] = hmm[i] - predict(hmm, i, side);
  const header = { version: VERSION, columns, heights: column(hq), ao: column(ao), route: column(new Float64Array(route)), placements: [] };
  for (const [name, list] of Object.entries(placements)) {
    const n = list.length;
    const keys = [];
    for (const it of list) for (const k of Object.keys(it)) if (!keys.includes(k)) keys.push(k);
    const fields = [];
    for (const key of keys) {
      const first = list.find((it) => key in it)[key];
      const everywhere = list.every((it) => key in it);
      const codec = n >= EXACT_BELOW && everywhere && FIELD_CODEC[key] ? FIELD_CODEC[key] : 'f64';
      const comps = codec === 'normal' ? 2 : Array.isArray(first) ? first.length : 1;
      const [type, enc] = CODECS[codec];
      const arr = new TYPES[type](n * comps);
      const delta = DELTA.has(key) && codec !== 'f64';
      let prev = 0;
      list.forEach((it, i) => {
        const v = codec === 'normal' ? [it[key][0], it[key][2]] : it[key];
        for (let c = 0; c < comps; c++) {
          // (NaN marks an item without the field: only in f64 columns)
          const q = v === undefined ? NaN : enc(comps > 1 ? v[c] : v);
          arr[i * comps + c] = delta ? q - prev : q;
          if (delta) prev = q;
        }
      });
      fields.push({ key, codec, comps, delta, col: column(arr) });
    }
    header.placements.push({ name, n, fields });
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const total = 4 + json.length + blobs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  let o = 4 + json.length;
  for (const b of blobs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/** Unpack bytes from encodeWorld: { heights, ao, route, placements }. */
export function decodeWorld(bytes) {
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)));
  if (header.version !== VERSION) throw new Error(`world bake version ${header.version}, expected ${VERSION}`);
  const cols = [];
  let o = 4 + len;
  for (const [type, n] of header.columns) {
    const size = n * TYPES[type].BYTES_PER_ELEMENT;
    cols.push(unshuffle(bytes.subarray(o, o + size), type, n));
    o += size;
  }
  const placements = {};
  for (const { name, n, fields } of header.placements) {
    const list = Array.from({ length: n }, () => ({}));
    for (const { key, codec, comps, delta, col } of fields) {
      const arr = cols[col];
      const dec = CODECS[codec][2];
      let acc = 0;
      for (let i = 0; i < n; i++) {
        if (comps === 1) {
          let q = arr[i];
          if (delta) q = acc += q;
          if (!Number.isNaN(q)) list[i][key] = dec(q);
        } else if (codec === 'normal') {
          const nx = dec(arr[i * 2]);
          const nz = dec(arr[i * 2 + 1]);
          list[i][key] = [nx, Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)), nz];
        } else if (!Number.isNaN(arr[i * comps])) {
          const v = new Array(comps);
          for (let c = 0; c < comps; c++) v[c] = dec(arr[i * comps + c]);
          list[i][key] = v;
        }
      }
    }
    placements[name] = list;
  }
  const hq = cols[header.heights];
  const side = Math.round(Math.sqrt(hq.length));
  const hmm = new Int32Array(hq.length);
  const heights = new Float32Array(hq.length);
  for (let i = 0; i < hq.length; i++) heights[i] = (hmm[i] = hq[i] + predict(hmm, i, side)) / 1000;
  return { heights, ao: cols[header.ao], route: cols[header.route], placements };
}

/**
 * Fetch and inflate the bake, or null if there's none (the dev server has none until it has
 * baked the current sources: then everything is computed here as before).
 */
export async function loadWorld(url) {
  try {
    const res = await fetch(url);
    if (!res.ok || typeof DecompressionStream === 'undefined') return null;
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    return decodeWorld(new Uint8Array(await new Response(stream).arrayBuffer()));
  } catch (err) {
    console.warn('world bake not used:', err);
    return null;
  }
}
