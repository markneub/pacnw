import '@fontsource/im-fell-english-sc';
import { WORLD_SIZE, WATER_LEVEL, SNOWLINE } from './config.js';
import { terrainGrid, waterLevelAt, snowAmount, SEA_LEVEL, marshAt } from './terrain.js';
import { shared } from './materials.js';

/**
 * The paper map. At load the land is drawn once into a canvas, like an old printed topographic
 * sheet: the sea water-lined along the coast, the lake, sand, forest and meadow, bare rock and
 * snow, hill shading and contours, the creeks, the trail (red dashes) and little pictures of the
 * cave, the cabin, the lighthouse and the wreck; a title cartouche, a compass rose and a scale
 * bar; aged paper with fold creases. A translucent icon in the corner (or M) unfolds it in the
 * middle of the screen: it flies out of the icon as a folded packet, opens like an accordion,
 * then its bottom half swings down. A live arrow shows where you are and which way you face.
 */

const SIZE = 1024; // canvas px
const MARGIN = 44; // px of plain paper round the neat line
const COLS = 4; // fold panels
const ROWS = 2;
// the world shown: a square a little inside the terrain (the rim's outer slopes are cut off)
const X0 = -1300;
const Z0 = -1250;
const SPAN = 2600;
const INNER = SIZE - 2 * MARGIN;
const MPP = SPAN / INNER; // metres per pixel
const toPx = (x, z) => [MARGIN + (x - X0) / MPP, MARGIN + (z - Z0) / MPP];

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------
// Drawing the sheet
// ---------------------------------------------------------------------------

function mix3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
const PAPER = [0.94, 0.895, 0.79];
const C = {
  meadow: [0.88, 0.86, 0.68],
  forest: [0.66, 0.74, 0.54],
  oldForest: [0.58, 0.68, 0.49],
  sand: [0.95, 0.87, 0.67],
  marsh: [0.76, 0.79, 0.62],
  rock: [0.8, 0.76, 0.7],
  snow: [0.97, 0.975, 0.98],
  shallow: [0.72, 0.83, 0.84],
  deep: [0.55, 0.69, 0.75],
  lake: [0.68, 0.8, 0.83],
};

/** The land as a raster (colours, shading), into ctx's inner rectangle. */
async function drawLand(ctx, { canopyAt, tick }) {
  const { heights, n, step } = terrainGrid();
  const half = WORLD_SIZE / 2;
  const sandData = shared.uSandMap.value?.image?.data ?? null;
  const gridAt = (arr, x, z) => {
    const gx = Math.min(n - 1.001, Math.max(0, (x + half) / step));
    const gz = Math.min(n - 1.001, Math.max(0, (z + half) / step));
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const k = iz * n + ix;
    return lerp(lerp(arr[k], arr[k + 1], fx), lerp(arr[k + n], arr[k + n + 1], fx), fz);
  };
  const img = ctx.createImageData(INNER, INNER);
  const d = img.data;
  // heights at every pixel first (the shading takes its gradient from the neighbours)
  const H = new Float32Array(INNER * INNER);
  for (let py = 0; py < INNER; py++) {
    const z = Z0 + (py + 0.5) * MPP;
    for (let px = 0; px < INNER; px++) H[py * INNER + px] = gridAt(heights, X0 + (px + 0.5) * MPP, z);
  }
  await tick?.(0.15);
  // light from the north-west, high: classic hill shading
  const L = [-0.5, 0.75, -0.5];
  const ll = Math.hypot(...L);
  const flat = L[1] / ll;
  for (let py = 0; py < INNER; py++) {
    const z = Z0 + (py + 0.5) * MPP;
    const up = Math.max(0, py - 1) * INNER;
    const dn = Math.min(INNER - 1, py + 1) * INNER;
    for (let px = 0; px < INNER; px++) {
      const x = X0 + (px + 0.5) * MPP;
      const k = py * INNER + px;
      const h = H[k];
      const hx = H[py * INNER + Math.min(INNER - 1, px + 1)] - H[py * INNER + Math.max(0, px - 1)];
      const hz = H[dn + px] - H[up + px];
      const nx = -hx;
      const ny = 2 * MPP; // (the differences span 2 px)
      const nz = -hz;
      const nl = Math.hypot(nx, ny, nz);
      const slope = 1 - ny / nl;
      let col;
      let shadeK = 1;
      // water: the sea in the south, the lake and ponds
      const level = z > 600 ? SEA_LEVEL : h < WATER_LEVEL + 2 ? waterLevelAt(x, z) : -Infinity;
      if (h < level - 0.05) {
        const depth = level - h;
        col = level === SEA_LEVEL && z > 600 ? mix3(C.shallow, C.deep, smooth(0, 22, depth)) : mix3(C.lake, C.deep, smooth(0, 9, depth) * 0.6);
        shadeK = 0;
      } else {
        const canopy = canopyAt ? canopyAt(x, z) : 0;
        col = mix3(C.meadow, C.forest, smooth(0.02, 0.22, canopy));
        col = mix3(col, C.oldForest, smooth(0.25, 0.45, canopy));
        if (marshAt(x, z) > 0.3) col = mix3(col, C.marsh, 0.7);
        const sand = sandData ? gridAt(sandData, x, z) / 255 : 0;
        col = mix3(col, C.sand, smooth(0.3, 0.7, sand));
        col = mix3(col, C.rock, smooth(0.4, 0.7, slope) * 0.8);
        if (h > SNOWLINE - 30) col = mix3(col, C.snow, smooth(0.2, 0.7, snowAmount(x, z, h, slope)));
      }
      // hill shading (gentle: an old sheet's, not a satellite's), a faint grain in the ink
      const lam = (nx * L[0] + ny * L[1] + nz * L[2]) / (nl * ll);
      const sh = 1 + Math.max(-0.42, Math.min(0.2, (lam - flat) * 0.6)) * shadeK;
      const grain = 0.97 + 0.03 * hash(px * 0.71, py * 1.3);
      const o = k * 4;
      d[o] = Math.min(255, 255 * col[0] * sh * grain);
      d[o + 1] = Math.min(255, 255 * col[1] * sh * grain);
      d[o + 2] = Math.min(255, 255 * col[2] * sh * grain);
      d[o + 3] = 255;
    }
    if (py % 48 === 0) await tick?.(0.15 + 0.85 * (py / INNER));
  }
  ctx.putImageData(img, MARGIN, MARGIN);
}

/** Marching squares over the height grid: segments where it crosses `levels`, by style. */
function contours(ctx, levels, { min = -Infinity, max = Infinity, style }) {
  const { heights, n, step } = terrainGrid();
  const half = WORLD_SIZE / 2;
  const i0 = Math.max(0, Math.floor((X0 + half) / step));
  const i1 = Math.min(n - 2, Math.ceil((X0 + SPAN + half) / step));
  const j0 = Math.max(0, Math.floor((Z0 + half) / step));
  const j1 = Math.min(n - 2, Math.ceil((Z0 + SPAN + half) / step));
  const paths = new Map();
  const P = (ix, iz) => toPx(ix * step - half, iz * step - half);
  for (let iz = j0; iz <= j1; iz++) {
    for (let ix = i0; ix <= i1; ix++) {
      const a = heights[iz * n + ix];
      const b = heights[iz * n + ix + 1];
      const c = heights[(iz + 1) * n + ix + 1];
      const dd = heights[(iz + 1) * n + ix];
      const lo = Math.min(a, b, c, dd);
      const hi = Math.max(a, b, c, dd);
      for (const lv of levels) {
        if (lv <= lo || lv > hi || lv < min || lv > max) continue;
        // the crossings on the cell's edges
        const pts = [];
        const edge = (h0, h1, x0, z0, x1, z1) => {
          if ((h0 < lv) !== (h1 < lv)) {
            const t = (lv - h0) / (h1 - h0);
            pts.push(P(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t));
          }
        };
        edge(a, b, ix, iz, ix + 1, iz);
        edge(b, c, ix + 1, iz, ix + 1, iz + 1);
        edge(c, dd, ix + 1, iz + 1, ix, iz + 1);
        edge(dd, a, ix, iz + 1, ix, iz);
        const s = style(lv);
        if (!s) continue;
        let path = paths.get(s.key);
        if (!path) {
          path = { s, p: new Path2D() };
          paths.set(s.key, path);
        }
        for (let k = 0; k + 1 < pts.length; k += 2) {
          path.p.moveTo(pts[k][0], pts[k][1]);
          path.p.lineTo(pts[k + 1][0], pts[k + 1][1]);
        }
      }
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(MARGIN, MARGIN, INNER, INNER);
  ctx.clip();
  ctx.lineCap = 'round';
  for (const { s, p } of paths.values()) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.stroke(p);
  }
  ctx.restore();
}

function polyline(ctx, pts, { color, width, dash = null }) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(MARGIN, MARGIN, INNER, INNER);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = toPx(p.x, p.z);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

const INK = 'rgba(52, 40, 30, 0.9)';

/** The woods as an old map draws them: little tree symbols, thicker where the canopy closes. */
function treeSymbols(ctx, canopyAt) {
  if (!canopyAt) return;
  const { heights, n, step } = terrainGrid();
  const half = WORLD_SIZE / 2;
  ctx.save();
  ctx.lineWidth = 0.7;
  const G = 7.5; // px between candidate symbols
  for (let py = MARGIN + G / 2; py < MARGIN + INNER; py += G) {
    for (let px = MARGIN + G / 2; px < MARGIN + INNER; px += G) {
      const jx = px + (hash(px, py) - 0.5) * G * 0.8;
      const jy = py + (hash(py, px) - 0.5) * G * 0.8;
      const x = X0 + (jx - MARGIN) * MPP;
      const z = Z0 + (jy - MARGIN) * MPP;
      const c = canopyAt(x, z);
      if (hash(jx * 1.3, jy * 0.7) > smooth(0.04, 0.3, c) * 0.85) continue;
      const ix = Math.round((x + half) / step);
      const iz = Math.round((z + half) / step);
      const h = heights[Math.min(n - 1, Math.max(0, iz)) * n + Math.min(n - 1, Math.max(0, ix))];
      const snowy = h > SNOWLINE;
      const r = 1.5 + hash(jx, jy) * 0.8;
      // a conifer: a little pointed crown on a stalk
      ctx.fillStyle = snowy ? 'rgba(120, 140, 120, 0.55)' : 'rgba(70, 110, 60, 0.55)';
      ctx.strokeStyle = snowy ? 'rgba(70, 90, 80, 0.6)' : 'rgba(40, 70, 35, 0.65)';
      ctx.beginPath();
      ctx.moveTo(jx, jy - r * 1.9);
      ctx.lineTo(jx + r, jy + r * 0.6);
      ctx.lineTo(jx - r, jy + r * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Little pictures for the places worth finding. */
function glyphs(ctx, marks) {
  ctx.save();
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  if (marks.cave) {
    // a dark arch in a hump of rock
    const [x, y] = toPx(marks.cave.x, marks.cave.z);
    ctx.beginPath();
    ctx.moveTo(x - 9, y + 4);
    ctx.quadraticCurveTo(x, y - 12, x + 9, y + 4);
    ctx.closePath();
    ctx.fillStyle = 'rgba(120, 104, 86, 0.9)';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 3.5, y + 4);
    ctx.quadraticCurveTo(x, y - 4.5, x + 3.5, y + 4);
    ctx.closePath();
    ctx.fillStyle = INK;
    ctx.fill();
  }
  if (marks.cabin) {
    const [x, y] = toPx(marks.cabin.x, marks.cabin.z);
    ctx.beginPath();
    ctx.moveTo(x - 6, y + 4);
    ctx.lineTo(x - 6, y - 2);
    ctx.lineTo(x, y - 7);
    ctx.lineTo(x + 6, y - 2);
    ctx.lineTo(x + 6, y + 4);
    ctx.closePath();
    ctx.fillStyle = 'rgba(150, 70, 48, 0.95)';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.fillRect(x + 2.5, y - 8, 1.8, 4); // the stovepipe
    ctx.fillRect(x - 1.2, y, 2.4, 4); // the door
  }
  if (marks.lighthouse) {
    const [x, y] = toPx(marks.lighthouse.x, marks.lighthouse.z);
    ctx.save();
    ctx.strokeStyle = 'rgba(176, 52, 36, 0.8)';
    ctx.lineWidth = 1;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * 8, y - 9 + Math.sin(a) * 8);
      ctx.lineTo(x + Math.cos(a) * 13, y - 9 + Math.sin(a) * 13);
      ctx.stroke();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(x - 3.5, y + 4);
    ctx.lineTo(x - 2, y - 7);
    ctx.lineTo(x + 2, y - 7);
    ctx.lineTo(x + 3.5, y + 4);
    ctx.closePath();
    ctx.fillStyle = '#f6f1e4';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(176, 52, 36, 0.95)';
    ctx.fillRect(x - 2.6, y - 11, 5.2, 4);
    ctx.strokeRect(x - 2.6, y - 11, 5.2, 4);
  }
  if (marks.wreck) {
    const [x, y] = toPx(marks.wreck.x, marks.wreck.z);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.35);
    ctx.beginPath();
    ctx.moveTo(-10, -1);
    ctx.lineTo(10, -1);
    ctx.lineTo(7, 4);
    ctx.lineTo(-7, 4);
    ctx.closePath();
    ctx.fillStyle = 'rgba(110, 84, 60, 0.95)';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-3, -1);
    ctx.lineTo(-4, -10);
    ctx.moveTo(4, -1);
    ctx.lineTo(5.5, -7);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function compassRose(ctx, cx, cy, r) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(246, 240, 226, 0.75)';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
  ctx.fill();
  for (const rr of [r * 0.62, r * 0.55]) {
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  // ticks round the ring
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const l = k % 4 === 0 ? 0.1 : 0.05;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55);
    ctx.lineTo(Math.cos(a) * r * (0.55 - l), Math.sin(a) * r * (0.55 - l));
    ctx.stroke();
  }
  // the star: 4 long points and 4 short, each half dark, half light
  const point = (a, len, w) => {
    const tip = [Math.sin(a) * len, -Math.cos(a) * len];
    const l = [Math.sin(a - Math.PI / 2) * w, -Math.cos(a - Math.PI / 2) * w];
    const rr = [Math.sin(a + Math.PI / 2) * w, -Math.cos(a + Math.PI / 2) * w];
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(...tip);
    ctx.lineTo(...l);
    ctx.closePath();
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(...tip);
    ctx.lineTo(...rr);
    ctx.closePath();
    ctx.fillStyle = '#f3ecdc';
    ctx.fill();
    ctx.stroke();
  };
  for (let k = 0; k < 4; k++) point(Math.PI / 4 + (k * Math.PI) / 2, r * 0.5, r * 0.07);
  for (let k = 0; k < 4; k++) point((k * Math.PI) / 2, r * (k === 0 ? 1.0 : 0.82), r * 0.11);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.05, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.font = `${Math.round(r * 0.36)}px "IM Fell English SC", Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(150, 40, 30, 0.95)';
  ctx.fillText('N', 0, -r * 1.02);
  ctx.restore();
}

function scaleBar(ctx, x, y) {
  const seg = 250 / MPP; // px per 250 m
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  for (let k = 0; k < 4; k++) {
    ctx.fillStyle = k % 2 ? '#f5efe0' : INK;
    ctx.fillRect(x + (k * seg) / 2, y, seg / 2, 5);
  }
  ctx.strokeRect(x, y, seg * 2, 5);
  ctx.font = '12px "IM Fell English SC", Georgia, serif';
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('0', x, y + 8);
  ctx.fillText('250', x + seg, y + 8);
  ctx.fillText('500 m', x + seg * 2 + 8, y + 8);
  ctx.restore();
}

function titleCartouche(ctx, text) {
  ctx.save();
  ctx.font = '46px "IM Fell English SC", Georgia, serif';
  const w = ctx.measureText(text).width + 70;
  const h = 64;
  const x = SIZE / 2 - w / 2;
  const y = MARGIN + 18;
  // a paper banner with rolled ends
  ctx.fillStyle = 'rgba(244, 237, 220, 0.93)';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.quadraticCurveTo(x + w - 12, y + h / 2, x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.quadraticCurveTo(x + 12, y + h / 2, x, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 0.7;
  ctx.strokeRect(x + 14, y + 6, w - 28, h - 12);
  ctx.fillStyle = 'rgba(48, 34, 24, 0.95)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, SIZE / 2, y + h / 2 + 3);
  ctx.restore();
}

/** Age the paper: fibres, foxing, darker edges, and the creases of its folds. */
function agePaper(ctx) {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  // foxing: faint brown spots, a few rings
  for (let k = 0; k < 70; k++) {
    const x = hash(k, 1) * SIZE;
    const y = hash(k, 2) * SIZE;
    const r = 2 + hash(k, 3) * 22;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.04 + 0.08 * hash(k, 4);
    g.addColorStop(0, `rgba(170, 120, 70, ${a})`);
    g.addColorStop(1, 'rgba(170, 120, 70, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // darker toward the edges
  const v = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.35, SIZE / 2, SIZE / 2, SIZE * 0.75);
  v.addColorStop(0, 'rgba(255, 255, 255, 0)');
  v.addColorStop(1, 'rgba(150, 110, 60, 0.35)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // the folds: a shadow beside each crease
  for (let k = 1; k < COLS; k++) {
    const x = (k * SIZE) / COLS;
    const g = ctx.createLinearGradient(x - 10, 0, x + 10, 0);
    g.addColorStop(0, 'rgba(120, 90, 60, 0)');
    g.addColorStop(0.5, 'rgba(120, 90, 60, 0.22)');
    g.addColorStop(1, 'rgba(120, 90, 60, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 10, 0, 20, SIZE);
  }
  for (let k = 1; k < ROWS; k++) {
    const y = (k * SIZE) / ROWS;
    const g = ctx.createLinearGradient(0, y - 10, 0, y + 10);
    g.addColorStop(0, 'rgba(120, 90, 60, 0)');
    g.addColorStop(0.5, 'rgba(120, 90, 60, 0.22)');
    g.addColorStop(1, 'rgba(120, 90, 60, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 10, SIZE, 20);
  }
  ctx.globalCompositeOperation = 'screen';
  // and a worn, lighter line along each crease
  ctx.strokeStyle = 'rgba(255, 250, 235, 0.35)';
  ctx.lineWidth = 1.2;
  for (let k = 1; k < COLS; k++) {
    ctx.beginPath();
    ctx.moveTo((k * SIZE) / COLS + 0.5, 0);
    ctx.lineTo((k * SIZE) / COLS + 0.5, SIZE);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, SIZE / 2 + 0.5);
  ctx.lineTo(SIZE, SIZE / 2 + 0.5);
  ctx.stroke();
  ctx.restore();
  // paper fibre noise over everything (a tile, multiplied in)
  const T = 256;
  const tile = document.createElement('canvas');
  tile.width = tile.height = T;
  const tctx = tile.getContext('2d');
  const img = tctx.createImageData(T, T);
  const d = img.data;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      // (periodic: noise on a torus of 32 × 8 / 64 cells)
      const f = 0.94 + 0.035 * vnoiseP(x * 0.125, y * 0.03125, 32, 8) + 0.03 * vnoiseP(x * 0.25, y * 0.25, 64, 64) + 0.02 * hash(x, y);
      const o = (y * T + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = Math.min(255, 255 * f);
      d[o + 3] = 255;
    }
  }
  tctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.restore();
}
function vnoiseP(x, y, px, py) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const h = (a, b) => hash(((a % px) + px) % px, ((b % py) + py) % py);
  return lerp(lerp(h(ix, iy), h(ix + 1, iy), u), lerp(h(ix, iy + 1), h(ix + 1, iy + 1), u), v);
}

/** Draw the whole sheet. marks: { cave, cabin, lighthouse, wreck } positions. */
export async function drawMap({ canopyAt, streams, trail, marks, tick }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await document.fonts.load('46px "IM Fell English SC"').catch(() => {});
  ctx.fillStyle = `rgb(${PAPER.map((c) => Math.round(c * 255)).join(',')})`;
  ctx.fillRect(0, 0, SIZE, SIZE);
  await drawLand(ctx, { canopyAt, tick: (f) => tick?.(f * 0.7) });
  // the sea: water lines following the shore, the coastline itself; the lake's shore
  contours(ctx, [-1, -2.5, -4.5, -7, -10.5, -15], {
    style: (lv) => ({ key: `w${lv}`, color: `rgba(70, 110, 130, ${0.42 - 0.018 * -lv})`, width: 0.8 }),
  });
  contours(ctx, [SEA_LEVEL], { style: () => ({ key: 'coast', color: 'rgba(48, 72, 86, 0.85)', width: 1.4 }) });
  // contours on the land: every 20 m, every 100 m heavier
  const lv = [];
  for (let h = 20; h < 520; h += 20) lv.push(h);
  contours(ctx, lv, {
    style: (h) => (h % 100 === 0
      ? { key: 'c100', color: 'rgba(120, 80, 45, 0.55)', width: 1.15 }
      : { key: 'c20', color: 'rgba(130, 92, 58, 0.32)', width: 0.6 }),
  });
  await tick?.(0.8);
  treeSymbols(ctx, canopyAt);
  // the creeks: thicker downstream
  for (const st of streams?.streams ?? []) {
    const pts = st.points;
    const chunk = 24;
    for (let i = 0; i < pts.length - 1; i += chunk) {
      const seg = pts.slice(i, Math.min(pts.length, i + chunk + 1));
      polyline(ctx, seg, { color: 'rgba(60, 100, 140, 0.85)', width: 0.9 + 1.4 * (i / pts.length) });
    }
  }
  // the trail
  if (trail) polyline(ctx, trail.points.map((p) => ({ x: p.x, z: p.y })), { color: 'rgba(170, 38, 28, 0.9)', width: 2, dash: [5, 4] });
  glyphs(ctx, marks ?? {});
  // the neat line: a double rule round the map
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(MARGIN, MARGIN, INNER, INNER);
  ctx.lineWidth = 0.8;
  ctx.strokeRect(MARGIN - 6, MARGIN - 6, INNER + 12, INNER + 12);
  // tick marks every 250 m along the frame
  ctx.lineWidth = 0.8;
  for (let m = 0; m <= SPAN; m += 250) {
    const p = MARGIN + m / MPP;
    for (const [x0, y0, x1, y1] of [[p, MARGIN - 6, p, MARGIN], [p, MARGIN + INNER, p, MARGIN + INNER + 6], [MARGIN - 6, p, MARGIN, p], [MARGIN + INNER, p, MARGIN + INNER + 6, p]]) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
  titleCartouche(ctx, 'Cascadia Woods');
  compassRose(ctx, SIZE - MARGIN - 82, SIZE - MARGIN - 92, 62);
  scaleBar(ctx, MARGIN + 26, SIZE - MARGIN - 34);
  agePaper(ctx);
  await tick?.(1);
  return canvas;
}

// ---------------------------------------------------------------------------
// The icon, the unfolding sheet, the arrow
// ---------------------------------------------------------------------------

const ICON_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true">
  <path d="M5 9 L14 6 L26 10 L35 7 L35 31 L26 34 L14 30 L5 33 Z" fill="rgba(245,238,220,0.9)" stroke="rgba(40,32,24,0.9)" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M14 6 L14 30 M26 10 L26 34" stroke="rgba(40,32,24,0.7)" stroke-width="1.2"/>
  <path d="M8 22 C 12 17, 17 25, 22 18 S 30 14, 32 17" fill="none" stroke="rgba(160,40,30,0.9)" stroke-width="1.4" stroke-dasharray="2.4 1.8"/>
</svg>`;

const ARROW_SVG = `<svg viewBox="-20 -20 40 40" aria-hidden="true">
  <circle r="15" fill="rgba(200,40,28,0.18)" class="pulse"/>
  <path d="M0 -13 L8 9 L0 4 L-8 9 Z" fill="rgb(196,36,24)" stroke="#fff6e8" stroke-width="2" stroke-linejoin="round"/>
</svg>`;

const DUR = 1050; // ms to unfold
const EASE = 'cubic-bezier(0.25, 0.8, 0.25, 1)';

export class PaperMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.isOpen = false;
    this.busy = false;
    // the icon (top right; translucent until touched)
    this.icon = document.createElement('button');
    this.icon.id = 'map-icon';
    this.icon.setAttribute('aria-label', 'Map');
    this.icon.innerHTML = ICON_SVG;
    document.body.appendChild(this.icon);
    const toggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    };
    this.icon.addEventListener('pointerdown', toggle);
    this.icon.addEventListener('click', (e) => e.stopPropagation());

    // the sheet: a backdrop (tapping it folds the map away), the sheet in 2 rows × 4 panels
    this.backdrop = document.createElement('div');
    this.backdrop.id = 'map-view';
    this.backdrop.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    this.sheet = document.createElement('div');
    this.sheet.className = 'map-sheet';
    this.backdrop.appendChild(this.sheet);
    this.cols = []; // [row][col] panel elements
    this.rows = [];
    this.shades = [];
    for (let r = 0; r < ROWS; r++) {
      const row = document.createElement('div');
      row.className = `map-row map-row-${r}`;
      this.sheet.appendChild(row);
      let parent = row;
      const cols = [];
      for (let c = 0; c < COLS; c++) {
        const panel = document.createElement('div');
        panel.className = `map-panel${c ? ' map-panel-hinged' : ''}`;
        const front = document.createElement('div');
        front.className = 'map-face map-front';
        const slice = document.createElement('canvas');
        slice.width = SIZE / COLS;
        slice.height = SIZE / ROWS;
        slice.getContext('2d').drawImage(canvas, (c * SIZE) / COLS, (r * SIZE) / ROWS, SIZE / COLS, SIZE / ROWS, 0, 0, SIZE / COLS, SIZE / ROWS);
        front.appendChild(slice);
        const back = document.createElement('div');
        back.className = 'map-face map-back';
        for (const f of [front, back]) {
          const shade = document.createElement('div');
          shade.className = 'map-shade';
          f.appendChild(shade);
          this.shades.push({ el: shade, r, c, back: f === back });
        }
        panel.append(front, back);
        parent.appendChild(panel);
        parent = panel;
        cols.push(panel);
      }
      this.cols.push(cols);
      this.rows.push(row);
    }
    this.marker = document.createElement('div');
    this.marker.className = 'map-marker';
    this.marker.innerHTML = ARROW_SVG;
    this.sheet.appendChild(this.marker);
    document.body.appendChild(this.backdrop);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Where you are (world x, z) and which way you face (yaw: 0 = north, + = turned left). */
  update(x, z, yaw) {
    if (!this.isOpen) return;
    const [px, py] = toPx(x, z);
    this.marker.style.left = `${(px / SIZE) * 100}%`;
    this.marker.style.top = `${(py / SIZE) * 100}%`;
    this.marker.style.transform = `translate(-50%, -50%) rotate(${-yaw}rad)`;
  }

  /** The animations, playing forward (unfold) or backward (fold away into the icon). */
  animate(forward) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const S = Math.min(vw * 0.94, vh * 0.9, 900);
    this.sheet.style.width = `${S}px`;
    this.sheet.style.height = `${S}px`;
    this.sheet.style.marginLeft = `${-S / 2}px`;
    this.sheet.style.marginTop = `${-S / 2}px`;
    // the folded packet (the top-left panel) sits centred on screen until it opens
    const ox = (3 * S) / 8;
    const oy = S / 4;
    // (the sheet turns and scales about the packet's middle: transform-origin 12.5% 25%)
    const ir = this.icon.getBoundingClientRect();
    const ix = ir.left + ir.width / 2 - vw / 2;
    const iy = ir.top + ir.height / 2 - vh / 2;
    const all = [];
    const opts = { duration: forward ? DUR : DUR * 0.62, fill: 'both', direction: forward ? 'normal' : 'reverse' };
    // the packet flies out of the icon, spinning a little, then settles as it opens
    all.push(this.sheet.animate(([
      { offset: 0, transform: `translate(${ox + ix}px, ${oy + iy}px) scale(0.08) rotate(-28deg)`, opacity: 0, easing: EASE },
      { offset: 0.06, opacity: 1 },
      { offset: 0.3, transform: `translate(${ox}px, ${oy}px) scale(1) rotate(-4deg)`, easing: EASE },
      { offset: 0.62, transform: `translate(0px, ${oy}px) scale(1) rotate(-1.5deg)`, easing: EASE },
      { offset: 1, transform: 'translate(0px, 0px) scale(1) rotate(0deg)', opacity: 1 },
    ]), opts));
    // the accordion: each panel turns about its left edge, alternately
    for (let r = 0; r < ROWS; r++) {
      for (let c = 1; c < COLS; c++) {
        const a = c % 2 ? -178 : 178;
        all.push(this.cols[r][c].animate([
          { offset: 0, transform: `rotateY(${a}deg)` },
          { offset: 0.3, transform: `rotateY(${a}deg)`, easing: 'cubic-bezier(0.45, 0.05, 0.3, 1)' },
          { offset: 0.64, transform: 'rotateY(0deg)' },
          { offset: 1, transform: 'rotateY(0deg)' },
        ], opts));
      }
    }
    // then the bottom half swings down
    all.push(this.rows[1].animate([
      { offset: 0, transform: 'rotateX(178deg)' },
      { offset: 0.6, transform: 'rotateX(178deg)', easing: 'cubic-bezier(0.4, 0.0, 0.25, 1.15)' },
      { offset: 0.97, transform: 'rotateX(0deg)' },
      { offset: 1, transform: 'rotateX(0deg)' },
    ], opts));
    // light on the turning panels: darker while they're folded
    for (const s of this.shades) {
      const end = s.r === 1 ? 0.97 : 0.64;
      all.push(s.el.animate([
        { offset: 0, opacity: s.back ? 0.05 : 0.35 },
        { offset: s.r === 1 ? 0.6 : 0.3, opacity: s.back ? 0.05 : 0.35 },
        { offset: (end + (s.r === 1 ? 0.6 : 0.3)) / 2, opacity: 0.45 },
        { offset: end, opacity: 0 },
        { offset: 1, opacity: 0 },
      ], opts));
    }
    all.push(this.backdrop.animate([{ opacity: 0 }, { offset: 0.25, opacity: 1 }, { opacity: 1 }], opts));
    return Promise.all(all.map((a) => a.finished)).then(() => all);
  }

  async open() {
    if (this.isOpen || this.busy) return;
    this.busy = true;
    this.isOpen = true;
    this.backdrop.classList.add('open');
    this.icon.classList.add('active');
    this.marker.classList.remove('show');
    const anims = await this.animate(true);
    this.marker.classList.add('show');
    this.busy = false;
    this.last = anims;
  }

  async close() {
    if (!this.isOpen || this.busy) return;
    this.busy = true;
    this.marker.classList.remove('show');
    for (const a of this.last ?? []) a.cancel();
    await this.animate(false);
    this.backdrop.classList.remove('open');
    this.icon.classList.remove('active');
    for (const a of this.backdrop.getAnimations({ subtree: true })) a.cancel();
    this.isOpen = false;
    this.busy = false;
  }
}
