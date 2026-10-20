import * as THREE from 'three';
import '@fontsource/dancing-script/600.css';

/**
 * A handwritten note on the cabin's table (cabin.js). Tap it (or click / E) and it lifts off the
 * table in an arc and turns to face you, held up close enough to read; tap again and it turns to
 * the next page (a quick flip), and on the last page it's laid back down where it was. No hands:
 * it just floats.
 *
 * The words are in POEM, one array of lines per page ('' = a gap), in a legible script (Dancing
 * Script), dark ink on folded, slightly worn paper. The writing is sized so the widest line on any
 * page fits the sheet (all pages the same size): split into more pages rather than let it shrink.
 */
export const POEM = [
  [
    'Where the cedars hold the rain',
    'and the creek runs cold and clear,',
    'I have walked the trail again',
    'to the cabin waiting here.',
    '',
    'Light the stove and bank the fire,',
    'let the snow come down tonight;',
    'every road I took went higher,',
    'every one came back to light.',
  ],
];

const W = 0.19; // m: a small sheet, folded in thirds
const H = 0.26;
const PX = 720; // canvas width (height follows the sheet)

function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const FONT = (size) => `600 ${size}px "Dancing Script", cursive`;

/** The writing's size: the widest line on any page fits between the margins, at most 44 px. */
function fitSize(ctx) {
  ctx.font = FONT(100);
  let widest = 0;
  for (const line of POEM.flat()) widest = Math.max(widest, ctx.measureText(line).width);
  return Math.min(44, Math.floor((100 * (PX - 70 - 46)) / Math.max(1, widest)));
}

function pageTexture(lines, page, size) {
  const w = PX;
  const h = Math.round((PX * H) / W);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  // the paper: warm off-white, a little darker at the edges, a faint water stain, fold creases
  ctx.fillStyle = '#f1e8d2';
  ctx.fillRect(0, 0, w, h);
  const v = ctx.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, h * 0.75);
  v.addColorStop(0, 'rgba(255,255,255,0)');
  v.addColorStop(1, 'rgba(150,115,60,0.28)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
  const st = ctx.createRadialGradient(w * 0.78, h * 0.84, 10, w * 0.78, h * 0.84, 90);
  st.addColorStop(0, 'rgba(160,120,60,0)');
  st.addColorStop(0.8, 'rgba(160,120,60,0.07)');
  st.addColorStop(1, 'rgba(160,120,60,0)');
  ctx.fillStyle = st;
  ctx.fillRect(0, 0, w, h);
  for (const f of [1 / 3, 2 / 3]) {
    const y = h * f;
    const g = ctx.createLinearGradient(0, y - 8, 0, y + 8);
    g.addColorStop(0, 'rgba(120,90,50,0)');
    g.addColorStop(0.45, 'rgba(120,90,50,0.12)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(120,90,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 8, w, 16);
  }
  // fibres
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const p = i / 4;
    const f = 0.965 + 0.035 * hash(p % w, Math.floor(p / w));
    d[i] *= f;
    d[i + 1] *= f;
    d[i + 2] *= f;
  }
  ctx.putImageData(img, 0, 0);
  // the poem: each line a touch uneven, as written by hand
  const lineH = Math.round(size * 1.55);
  const top = (h - lineH * (lines.length - 1)) / 2;
  ctx.font = FONT(size);
  ctx.fillStyle = 'rgba(28, 30, 56, 0.93)';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    if (!line) return;
    ctx.save();
    const x = 70 + (hash(i + 31 * page, 3) - 0.5) * 14;
    const y = top + i * lineH + (hash(i + 31 * page, 7) - 0.5) * 5;
    ctx.translate(x, y);
    ctx.rotate((hash(i + 31 * page, 11) - 0.5) * 0.02 - 0.006);
    ctx.fillText(line, 0, 0);
    ctx.restore();
  });
  // a page number, if there's more than one
  if (POEM.length > 1) {
    ctx.font = FONT(Math.round(size * 0.7));
    ctx.textAlign = 'center';
    ctx.fillText(`${page + 1} / ${POEM.length}`, w / 2, h - 50);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export async function buildNote(tableMatrix) {
  await document.fonts.load('600 48px "Dancing Script"').catch(() => {});
  const size = fitSize(document.createElement('canvas').getContext('2d'));
  const pages = POEM.map((lines, i) => pageTexture(lines, i, size));
  const mat = new THREE.MeshBasicMaterial({ map: pages[0], side: THREE.DoubleSide, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
  mesh.name = 'note';
  mesh.frustumCulled = false;
  // lying on the table (the matrix is the table spot, the note flat on it)
  const restPos = new THREE.Vector3();
  const restQuat = new THREE.Quaternion();
  tableMatrix.decompose(restPos, restQuat, new THREE.Vector3());
  mesh.position.copy(restPos);
  mesh.quaternion.copy(restQuat);
  const heldPos = new THREE.Vector3();
  const heldQuat = new THREE.Quaternion();
  const fwd = new THREE.Vector3();
  const upv = new THREE.Vector3();
  const p0 = new THREE.Vector3();
  let held = false;
  let t = 0; // 0 on the table .. 1 held
  let page = 0;
  let flip = 1; // 0..1 through a page turn (1 = still)

  /** Where it's held: facing the camera, filling most of the view (in its smaller direction). */
  function holdPose(camera) {
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dV = H / 0.95 / (2 * tanV);
    const dH = W / 0.9 / (2 * tanV * camera.aspect);
    const d = Math.max(dV, dH, camera.near * 2.5);
    camera.getWorldDirection(fwd);
    upv.set(0, 1, 0).applyQuaternion(camera.quaternion);
    heldPos.copy(camera.position).addScaledVector(fwd, d).addScaledVector(upv, -0.004);
    heldQuat.copy(camera.quaternion);
  }

  function update(dt, camera, lit) {
    const target = held ? 1 : 0;
    t += Math.sign(target - t) * Math.min(Math.abs(target - t), dt / 0.7);
    const k = ease(t);
    if (t > 0) {
      holdPose(camera);
      // an arc: up off the table, then in to the eyes (and back the same way)
      p0.lerpVectors(restPos, heldPos, k);
      p0.y += Math.sin(k * Math.PI) * 0.12;
      mesh.position.copy(p0);
      mesh.quaternion.slerpQuaternions(restQuat, heldQuat, k);
      // (a gentle sway while held)
      if (k > 0.99) mesh.rotateZ(Math.sin(performance.now() * 0.0011) * 0.006);
      // a page turn: edge-on halfway, where the next page takes over
      if (flip < 1) {
        const f = Math.min(1, flip + dt / 0.36);
        if (flip < 0.5 && f >= 0.5) mat.map = pages[page];
        flip = f;
        mesh.rotateY((f < 0.5 ? ease(2 * f) : ease(2 * f - 1) - 1) * Math.PI * 0.5);
      }
    } else {
      mesh.position.copy(restPos);
      mesh.quaternion.copy(restQuat);
      // back on the table: the first page on top again
      if (page !== 0) {
        page = 0;
        flip = 1;
        mat.map = pages[0];
      }
    }
    // in front of everything while it's off the table (walls can't cut through it)
    mat.depthFunc = t === 0 ? THREE.LessEqualDepth : THREE.AlwaysDepth; // (and still writes depth: the window glass stays behind it)
    mesh.renderOrder = t > 0 ? 20 : 0;
    // as lit on the table (the lantern beside it), clearer up close
    mat.color.setRGB(THREE.MathUtils.lerp(lit, 0.8, k), THREE.MathUtils.lerp(lit, 0.76, k), THREE.MathUtils.lerp(lit, 0.68, k));
  }

  return {
    mesh,
    update,
    get held() {
      return held;
    },
    set held(v) {
      held = v;
    },
    get moving() {
      return t > 0 && t < 1;
    },
    /** Turn to the next page; false on the last one (then it's put down). */
    turn() {
      if (page >= pages.length - 1) return false;
      if (flip < 1) mat.map = pages[page]; // (a turn still going: finish it at once)
      page++;
      flip = 0;
      return true;
    },
    restPos,
  };
}
