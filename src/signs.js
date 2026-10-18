import * as THREE from 'three';
import { TRAIL_STOPS } from './trail.js';

/**
 * Lettering on the trail signposts (the signpost model's two arrow boards):
 * the upper board points ahead along the trail and names the next stop and
 * its distance along the trail, the lower one points back to the previous
 * stop. Cream routed-style letters, on both faces of each board.
 *
 * All the lettering is one mesh in world space over one canvas atlas (a row per
 * board), so the signs cost a single draw. Board geometry comes from the
 * Blender signpost (blender/build_assets.py signpost(): boards along local ±X
 * at heights 1.85 / 1.55 m, faces at local z = -0.115 / -0.075 after the
 * Y-up export).
 */

const BOARDS = [
  // upper board, pointing along +X (ahead); lower board, pointing along -X (back)
  { y: 1.85, x0: 0.1, x1: 0.88, ahead: true },
  { y: 1.55, x0: -0.72, x1: -0.1, ahead: false },
];
const FACES = [
  { z: -0.1175, normal: -1 }, // the front face (local -Z)
  { z: -0.0725, normal: 1 }, // the back face (local +Z), just clear of the post
];
const ROW = 128; // atlas pixels per board
const W = 1024;
const HALF_H = 0.075; // m, half the lettering's height on the 0.22 m board

/** Metres along the trail between two point indices. */
function along(points, i0, i1) {
  let m = 0;
  for (let k = Math.min(i0, i1); k < Math.max(i0, i1); k++) m += points[k].distanceTo(points[k + 1]);
  return m;
}

const dist = (m) => (m < 950 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(1)} km`);

/** The two lines of text for each stop's sign: [ahead, back]. */
export function signTexts(trail) {
  const { points, stops } = trail;
  return stops.map((stop, k) => {
    const next = stops[k + 1];
    const prev = stops[k - 1];
    const label = (s) => TRAIL_STOPS.find((t) => t.name === s.name)?.label ?? s.name;
    return [
      next ? `${label(next)}  ${dist(along(points, stop.index, next.index))}` : 'End of trail',
      prev ? `${label(prev)}  ${dist(along(points, stop.index, prev.index))}` : 'Cascadia Woods Trail',
    ];
  });
}

/**
 * @param trail      buildTrail()'s result
 * @param signposts  the signpost placements ({x, y, z, rotY}), one per stop, in stop order
 */
export function buildSigns(trail, signposts) {
  const texts = signTexts(trail);
  const n = Math.min(texts.length, signposts.length);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = ROW * n * 2;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const rows = [];
  for (let s = 0; s < n; s++) {
    for (let b = 0; b < 2; b++) {
      const row = rows.length;
      rows.push(row);
      const text = texts[s][b];
      // fit the text to the board's length (the lower board is shorter)
      const maxW = W * ((BOARDS[b].x1 - BOARDS[b].x0) / (BOARDS[0].x1 - BOARDS[0].x0)) * 0.94;
      let size = 76;
      ctx.font = `600 ${size}px Georgia, 'Times New Roman', serif`;
      while (ctx.measureText(text).width > maxW && size > 30) {
        size -= 2;
        ctx.font = `600 ${size}px Georgia, 'Times New Roman', serif`;
      }
      const cy = row * ROW + ROW / 2;
      // routed letters: a dark groove edge under cream paint
      ctx.fillStyle = 'rgba(40, 26, 14, 0.9)';
      ctx.fillText(text, W / 2 + 2, cy + 3);
      ctx.fillStyle = 'rgb(236, 224, 186)';
      ctx.fillText(text, W / 2, cy);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  // one quad per board face, in world space
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
  const usable = (b) => ((BOARDS[b].x1 - BOARDS[b].x0) / (BOARDS[0].x1 - BOARDS[0].x0)) * 0.97;
  for (let s = 0; s < n; s++) {
    const p = signposts[s];
    m.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromAxisAngle(up, p.rotY), new THREE.Vector3(1, 1, 1));
    for (let b = 0; b < 2; b++) {
      const row = s * 2 + b;
      const { y, x0, x1 } = BOARDS[b];
      // the text's u range in its row (centred, as drawn)
      const uw = usable(b);
      const u0 = 0.5 - uw / 2;
      const u1 = 0.5 + uw / 2;
      const vTop = 1 - (row * ROW) / canvas.height;
      const vBot = 1 - ((row + 1) * ROW) / canvas.height;
      for (const f of FACES) {
        // the reader's right: -X on the front face (local -Z), +X on the back
        const right = f.normal; // (looking at a face along -normal, with Y up)
        const xl = right > 0 ? x0 : x1; // the reader's left end
        const xr = right > 0 ? x1 : x0;
        const base = pos.length / 3;
        for (const [x, yy, uu, vv] of [[xl, y - HALF_H, u0, vBot], [xr, y - HALF_H, u1, vBot], [xr, y + HALF_H, u1, vTop], [xl, y + HALF_H, u0, vTop]]) {
          v.set(x, yy, f.z).applyMatrix4(m);
          pos.push(v.x, v.y, v.z);
          nv.set(0, 0, f.normal).applyQuaternion(q);
          nrm.push(nv.x, nv.y, nv.z);
          uv.push(uu, vv);
        }
        // listed from the reader's lower left, so counter-clockwise as they see it
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    alphaTest: 0.4,
    roughness: 0.8,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sign lettering';
  return mesh;
}
