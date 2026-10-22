import * as THREE from 'three';
import { TRAIL_STOPS } from './trail.js';
import { ROAD_NUMBER } from './road.js';
import { patchSunlight, sunKey } from './materials.js';

/**
 * The face of each trail sign, in the style of a maintained US trail's junction sign: a
 * weathered board of three planks painted brown, the paint peeling to grey wood, two carriage
 * bolts, and white routed capitals: the stop's name across the top, then every other stop
 * with its distance along the trail in miles, names on the left and distances on the right, and an
 * arrow for the way to go: the boards stand beside the trail facing it, so stops further along
 * point to one side and those behind to the other.
 *
 * All the faces are one canvas atlas (a block per sign) on one world-space mesh, a quad just in
 * front of each board, so the signs cost a single draw. The board itself is the Blender
 * signpost (blender/build_assets.py signpost(): BOARD_* must match it), facing local -Z.
 */

const BOARD_W = 1.4; // m
const BOARD_TOP = 1.62;
const BOARD_H = 0.66;
const BOARD_FRONT = -0.118; // local z of the face: 3 mm in front of the board (front at -0.115)
const TW = 1024; // texture px across the board
const TH = Math.round((TW * BOARD_H) / BOARD_W);

/** Metres along the trail between two point indices. */
function along(points, i0, i1) {
  let m = 0;
  for (let k = Math.min(i0, i1); k < Math.max(i0, i1); k++) m += points[k].distanceTo(points[k + 1]);
  return m;
}

const MAX_ROWS = 5;
const miles = (m) => `${Math.max(0.1, m / 1609.34).toFixed(1)} MI.`;
const label = (s) => s.label ?? TRAIL_STOPS.find((t) => t.name === s.name)?.label ?? s.name;

/**
 * Each stop's sign: a title and [name, distance, dir] rows for the other stops, in trail order.
 * The board's local +X runs along the trail (vegetation.js placeTrailFurniture), which is the
 * reader's left: dir -1 (left) for stops further along, +1 (right) for those behind.
 */
export function signTexts(trail) {
  const { points, stops } = trail;
  return stops.map((stop, k) => ({
    title: k === 0 ? 'Cascadia Woods Trail' : label(stop),
    // the nearest MAX_ROWS stops by trail distance, listed in trail order (a real junction sign
    // names what's near, and the board only fits so many lines)
    rows: stops.filter((s, j) => j !== k && !s.junction) // (a road junction is signed, not a destination)
      .map((s) => ({ s, m: along(points, stop.index, s.index) }))
      .sort((p, q) => p.m - q.m).slice(0, MAX_ROWS).sort((p, q) => p.s.index - q.s.index)
      .map(({ s, m }) => [label(s), miles(m), (s.index > stop.index ? -1 : 1) * (stop.side ?? (stop.name === 'falls' ? -1 : 1))]), // (some stand on the far side: vegetation.js)
  }));
}

/** A small seeded random generator (each sign weathers differently, the same every load). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paint one sign's face into ctx at (0, oy). */
function paintFace(ctx, oy, { title, rows }, seed) {
  const r = rng(seed);
  ctx.save();
  ctx.translate(0, oy);
  ctx.beginPath();
  ctx.rect(0, 0, TW, TH);
  ctx.clip();
  // bare weathered wood underneath
  ctx.fillStyle = '#8a8274';
  ctx.fillRect(0, 0, TW, TH);
  // the brown paint, with grain streaks along the planks
  ctx.fillStyle = '#4b3324';
  ctx.fillRect(0, 0, TW, TH);
  for (let k = 0; k < 260; k++) {
    const y = r() * TH;
    ctx.strokeStyle = `rgba(${r() < 0.5 ? '20,12,6' : '110,80,55'},${0.08 + r() * 0.12})`;
    ctx.lineWidth = 0.6 + r() * 2;
    ctx.beginPath();
    ctx.moveTo(-10, y);
    ctx.bezierCurveTo(TW * 0.3, y + (r() - 0.5) * 6, TW * 0.7, y + (r() - 0.5) * 6, TW + 10, y + (r() - 0.5) * 4);
    ctx.stroke();
  }
  // peeling: ragged patches where the paint has flaked off to grey wood, most along the grain
  // and toward the lower edges where the rain runs off
  for (let k = 0; k < 70; k++) {
    const cx = r() * TW;
    const cy = Math.pow(r(), 0.7) * TH;
    const w = 6 + r() * r() * 70;
    const h = 2 + r() * 9;
    ctx.fillStyle = `rgba(${150 + r() * 25},${142 + r() * 25},${128 + r() * 20},${0.55 + r() * 0.4})`;
    ctx.beginPath();
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const rr = 0.6 + r() * 0.6;
      const px = cx + Math.cos(a) * w * rr;
      const py = cy + Math.sin(a) * h * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
  // plank seams
  for (const f of [1 / 3, 2 / 3]) {
    ctx.fillStyle = 'rgba(15,9,5,0.9)';
    ctx.fillRect(0, f * TH - 2, TW, 4);
    ctx.fillStyle = 'rgba(140,110,80,0.35)';
    ctx.fillRect(0, f * TH + 2, TW, 1.5);
  }
  // darker, weathered edges
  const edge = ctx.createLinearGradient(0, 0, 0, TH);
  edge.addColorStop(0, 'rgba(0,0,0,0.25)');
  edge.addColorStop(0.08, 'rgba(0,0,0,0)');
  edge.addColorStop(0.9, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, TW, TH);

  // routed white capitals: a dark groove shadow, then the paint, then wear
  const lines = [{ text: title.toUpperCase(), center: true }, ...rows.map(([n, d, dir]) => ({ text: n.toUpperCase(), right: d, dir }))];
  const lh = TH / (lines.length + 0.6);
  const font = (px) => `bold ${px}px "Arial Rounded MT Bold", "Helvetica Neue", Arial, sans-serif`;
  let px = Math.floor(lh * 0.62);
  ctx.font = font(px);
  ctx.letterSpacing = `${Math.round(px * 0.06)}px`;
  // shrink to fit the longest row (name + gap + distance)
  const widest = Math.max(...lines.map((l) => ctx.measureText(l.text).width + (l.right ? ctx.measureText(l.right).width + px * 1.5 : 0)));
  if (widest > TW * 0.7) px = Math.floor((px * TW * 0.7) / widest);
  ctx.font = font(px);
  ctx.letterSpacing = `${Math.round(px * 0.06)}px`;
  ctx.textBaseline = 'middle';
  // a routed arrow: a shaft and a broad head, as tall as the capitals, pointing dir (-1 left)
  const arrow = (cx, cy, dir) => {
    const len = px * 1.5;
    const head = px * 0.62;
    const half = px * 0.42;
    const shaft = px * 0.13;
    const tip = cx + (dir * len) / 2;
    const neck = tip - dir * head;
    const tail = cx - (dir * len) / 2;
    ctx.beginPath();
    ctx.moveTo(tip, cy);
    ctx.lineTo(neck, cy - half);
    ctx.lineTo(neck, cy - shaft);
    ctx.lineTo(tail, cy - shaft);
    ctx.lineTo(tail, cy + shaft);
    ctx.lineTo(neck, cy + shaft);
    ctx.lineTo(neck, cy + half);
    ctx.closePath();
    ctx.fill();
  };
  const draw = (fill, dx, dy) => {
    ctx.fillStyle = fill;
    lines.forEach((l, i) => {
      const y = lh * (i + 0.8) + dy;
      if (l.center) {
        ctx.textAlign = 'center';
        ctx.fillText(l.text, TW / 2 + dx, y);
      } else {
        // arrows pointing left stand before the name, those pointing right after the distance
        if (l.dir < 0) arrow(TW * 0.085 + dx, y, -1);
        else arrow(TW * 0.915 + dx, y, 1);
        ctx.textAlign = 'left';
        ctx.fillText(l.text, TW * 0.145 + dx, y);
        ctx.textAlign = 'right';
        ctx.fillText(l.right, TW * 0.855 + dx, y);
      }
    });
  };
  draw('rgba(10,6,3,0.85)', 1.5, 2.5);
  draw('#e8e3d6', 0, 0);
  // worn paint in the letters: tiny chips knocked out of the white
  ctx.globalCompositeOperation = 'source-atop';
  for (let k = 0; k < 900; k++) {
    ctx.fillStyle = `rgba(${90 + r() * 40},${80 + r() * 30},${65 + r() * 30},${0.35 + r() * 0.5})`;
    ctx.fillRect(r() * TW, r() * TH, 1 + r() * 3, 1 + r() * 2);
  }
  ctx.globalCompositeOperation = 'source-over';
  // two carriage bolts into the post, between the rows
  for (const by of [TH * 0.345, TH * 0.665]) {
    const g = ctx.createRadialGradient(TW / 2 - 2, by - 2, 1, TW / 2, by, 9);
    g.addColorStop(0, '#6a6660');
    g.addColorStop(0.6, '#2c2a27');
    g.addColorStop(1, 'rgba(20,15,10,0.9)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(TW / 2, by, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * @param trail      buildTrail()'s result
 * @param signposts  the signpost placements ({x, y, z, rotY}), one per stop, in stop order
 */
export function buildSigns(trail, signposts) {
  const texts = signTexts(trail);
  const n = Math.min(texts.length, signposts.length);
  const canvas = document.createElement('canvas');
  canvas.width = TW;
  canvas.height = TH * n;
  const ctx = canvas.getContext('2d');
  for (let s = 0; s < n; s++) paintFace(ctx, s * TH, texts[s], 1873 + s * 101);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
  for (let s = 0; s < n; s++) {
    const p = signposts[s];
    m.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromAxisAngle(up, p.rotY), new THREE.Vector3(1, 1, 1));
    nv.set(0, 0, -1).applyQuaternion(q);
    const vTop = 1 - s / n;
    const vBot = 1 - (s + 1) / n;
    const base = pos.length / 3;
    // facing local -Z the reader's right is -X; listed from the reader's lower left, counter-clockwise
    for (const [x, y, uu, vv] of [
      [BOARD_W / 2, BOARD_TOP - BOARD_H, 0, vBot],
      [-BOARD_W / 2, BOARD_TOP - BOARD_H, 1, vBot],
      [-BOARD_W / 2, BOARD_TOP, 1, vTop],
      [BOARD_W / 2, BOARD_TOP, 0, vTop],
    ]) {
      v.set(x, y, BOARD_FRONT).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      nrm.push(nv.x, nv.y, nv.z);
      uv.push(uu, vv);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
  mat.onBeforeCompile = (shader) => patchSunlight(shader); // dappled like everything around it
  mat.customProgramCacheKey = () => `signs|${sunKey()}`;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sign faces';
  return mesh;
}

/**
 * Forest Road 2840's lettering (road.js, vegetation.js placeTrailFurniture): the white plate on the
 * gate's arm and the brown route-number board, painted into one small atlas and laid as quads just in
 * front of their faces (local +Z; the boxes in blender/build_assets.py road_gate / road_post).
 */
export function buildRoadPlates(gates = [], posts = []) {
  const W = 1024;
  const H = 640;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const r = rng(2840);
  // the gate's plate (640 × 320): white, a black border, black capitals, a little rust and grime
  ctx.fillStyle = '#ecebe4';
  ctx.fillRect(0, 0, 640, 320);
  ctx.strokeStyle = '#1d1c1a';
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, 612, 292);
  ctx.fillStyle = '#1d1c1a';
  ctx.textAlign = 'center';
  ctx.font = 'bold 92px "Arial Narrow", Arial, sans-serif';
  ctx.fillText('ROAD CLOSED', 320, 128);
  ctx.font = 'bold 50px "Arial Narrow", Arial, sans-serif';
  ctx.fillText('TO MOTOR VEHICLES', 320, 206);
  ctx.font = 'bold 30px Arial, sans-serif';
  ctx.fillText('U.S. FOREST SERVICE', 320, 270);
  for (let k = 0; k < 160; k++) {
    ctx.fillStyle = `rgba(${110 + r() * 50},${60 + r() * 30},${30 + r() * 20},${0.1 + r() * 0.35})`;
    const x = r() * 640;
    const y = r() < 0.5 ? r() * 40 : 320 - r() * 40;
    ctx.fillRect(x, y, 2 + r() * 8, 2 + r() * 10);
  }
  // the route number (160 × 620 at x 700): brown, the digits stacked in white
  ctx.fillStyle = '#4a3020';
  ctx.fillRect(700, 0, 160, 620);
  for (let k = 0; k < 90; k++) {
    ctx.fillStyle = `rgba(${130 + r() * 40},${120 + r() * 30},${100 + r() * 30},${0.08 + r() * 0.12})`;
    ctx.fillRect(700 + r() * 160, r() * 620, 1 + r() * 3, 20 + r() * 80);
  }
  ctx.fillStyle = '#e9e5da';
  ctx.font = 'bold 118px Arial, sans-serif';
  [...ROAD_NUMBER].forEach((d, k) => ctx.fillText(d, 780, 140 + k * 140));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
  const quad = (p, [x0, x1, y0, y1, z], [u0, u1, v0, v1]) => {
    m.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromAxisAngle(up, p.rotY), new THREE.Vector3(1, 1, 1));
    nv.set(0, 0, 1).applyQuaternion(q);
    const base = pos.length / 3;
    for (const [x, y, uu, vv] of [[x0, y0, u0, v0], [x1, y0, u1, v0], [x1, y1, u1, v1], [x0, y1, u0, v1]]) {
      v.set(x, y, z).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      nrm.push(nv.x, nv.y, nv.z);
      uv.push(uu, vv);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // (texture v runs up from the canvas's bottom)
  for (const g of gates) quad(g, [-0.3, 0.3, 0.8, 1.1, 0.057], [0, 640 / W, 1 - 320 / H, 1]);
  for (const p of posts) quad(p, [-0.08, 0.08, 0.85, 1.47, 0.073], [700 / W, 860 / W, 1 - 620 / H, 1]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
  mat.onBeforeCompile = (shader) => patchSunlight(shader);
  mat.customProgramCacheKey = () => `roadplates|${sunKey()}`;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'road plates';
  return mesh;
}
