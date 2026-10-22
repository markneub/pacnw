import * as THREE from 'three';
import { groundAt, groundColor, groundLayers, snowAmount, streamBed } from './terrain.js';
import { road, roadAt, landingAt, ROAD_SURFACE, ROAD_FLAT } from './road.js';
import { corridorMaterials, treadHalf } from './trail.js';

/**
 * The road's surface (road.js): a fine strip laid over the terrain's shelf (3 cm up, with a stronger
 * polygon offset than the trail's strip), drawn with the trail's corridor material in its road mode
 * (trail.js ROAD_TREAD: wheel ruts, a grassy crown, gravelly dirt to a ragged edge). The terrain under
 * it isn't cut away: its 5 m grid already carries the shelf, so nothing here can open a hole.
 * Opaque out over the shoulders and the foot of the banks, faded beyond; round at the landings.
 */
export function buildRoadMesh(trail) {
  const R = road();
  const STEP_U = 0.5;
  const EXTRA = 3.4; // m past the level shelf (over the foot of the banks)
  const across = Math.round((2 * (ROAD_FLAT + EXTRA)) / STEP_U); // columns at the normal width
  const surface = new THREE.Color(0x7d6b55); // gravelly dirt
  const packed = new THREE.Color(0x8d99a8);
  const soil = new THREE.Color(0x5a4430);
  const col = new THREE.Color();
  const tmp = new THREE.Color();
  const lw = [0, 0, 0, 0];

  // the centreline every metre, run on straight past each end over the landings
  const line = [];
  for (let i = 0; i < R.n - 1; i++) {
    const [ax, az] = R.pts[i];
    const [bx, bz] = R.pts[i + 1];
    line.push([ax, az], [(ax + bx) / 2, (az + bz) / 2]);
  }
  line.push(R.pts[R.n - 1]);
  const ext = (a, b, k) => [b[0] + ((b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1])) * k, b[1] + ((b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1])) * k];
  const reach = Math.ceil(landingAt(0) + ROAD_FLAT + EXTRA);
  const head = [];
  const tail = [];
  for (let k = 1; k <= reach; k++) {
    head.unshift(ext(line[1], line[0], k));
    tail.push(ext(line[line.length - 2], line[line.length - 1], k));
  }
  const rows = [...head, ...line, ...tail];

  const positions = [];
  const colors = [];
  const tread = [];
  const treadCol = [];
  const edge = [];
  const print = [];
  const layers = [];
  const normals = [];
  const e = 0.5;
  for (let i = 0; i < rows.length; i++) {
    const [px, pz] = rows[i];
    const [ax, az] = rows[Math.max(0, i - 1)];
    const [bx, bz] = rows[Math.min(rows.length - 1, i + 1)];
    const l = Math.hypot(bx - ax, bz - az);
    const nx = -(bz - az) / l;
    const nz = (bx - ax) / l;
    // (wider over the landings)
    const half = (ROAD_FLAT + EXTRA) * (1 + landingAt(Math.max(0, Math.min(R.len, roadAt(px, pz).s))) / (ROAD_FLAT + EXTRA));
    for (let j = 0; j <= across; j++) {
      const v = (j / across) * 2 - 1;
      const x = px + nx * v * half;
      const z = pz + nz * v * half;
      const y = groundAt(x, z);
      positions.push(x, y + 0.03, z);
      const gx = groundAt(x - e, z) - groundAt(x + e, z);
      const gz = groundAt(x, z - e) - groundAt(x, z + e);
      const nl = Math.hypot(gx, 2 * e, gz);
      normals.push(gx / nl, (2 * e) / nl, gz / nl);
      const slope = 1 - (2 * e) / nl;

      const r = roadAt(x, z);
      const d = r.d;
      const u = r.u;
      const s = r.s;
      const land = landingAt(s);
      const surfHalf = ROAD_SURFACE + land;
      const flat = ROAD_FLAT + land;
      groundColor(x, y, z, slope, col);
      groundLayers(x, y, z, slope, lw);
      const snow = snowAmount(x, z, y, 0);
      const bed = streamBed(x, z);
      // exposed soil on the cut banks and fill slopes
      const bank = THREE.MathUtils.smoothstep(slope, 0.15, 0.45) * (1 - THREE.MathUtils.smoothstep(d, flat + 2, flat + 7)) * (1 - bed) * (1 - snow * 0.85);
      col.lerp(soil, bank * 0.7);
      const alpha = 1 - THREE.MathUtils.smoothstep(d, flat + EXTRA - 2.2, flat + EXTRA - 0.2);
      colors.push(col.r, col.g, col.b, alpha);
      tmp.copy(surface).lerp(col, 0.15).lerp(packed, snow * 0.8);
      treadCol.push(tmp.r, tmp.g, tmp.b);
      const dry = 1 - bed; // (the ford: the creek's stony bed, no ruts under the water)
      edge.push(u, s, dry);
      // where the trail's own tread leaves the road (it shows through: trail.js ROAD_TREAD)
      print.push(Math.max(-3, Math.min(3, treadHalf(x, z) - trail.distanceTo(x, z))), surfHalf, 0);
      tread.push(1 - 0.7 * snow);
      const dirtW = Math.min(1, (1 - THREE.MathUtils.smoothstep(d, surfHalf, surfHalf + 0.6)) * (1 - snow * 0.85) * dry + bank * 0.6);
      layers.push(lw[0] * (1 - dirtW), lw[1] * (1 - dirtW), lw[2] * (1 - dirtW), lw[3] * (1 - dirtW) + dirtW);
    }
  }

  const [mat, fringeMat] = corridorMaterials(true);
  const rowLen = across + 1;
  const SEG = 120; // rows per mesh (1 m each), so off-screen stretches are culled
  const group = new THREE.Group();
  group.name = 'road';
  const attrs = { position: [positions, 3], normal: [normals, 3], color: [colors, 4], aTread: [tread, 1], aTreadCol: [treadCol, 3], aEdge: [edge, 3], aPrint: [print, 3], aLayers: [layers, 4] };
  for (let r0 = 0; r0 < rows.length - 1; r0 += SEG) {
    const r1 = Math.min(rows.length - 1, r0 + SEG);
    const v0 = r0 * rowLen;
    const v1 = (r1 + 1) * rowLen;
    const part = new THREE.BufferGeometry();
    for (const [name, [arr, size]] of Object.entries(attrs)) part.setAttribute(name, new THREE.Float32BufferAttribute(arr.slice(v0 * size, v1 * size), size));
    part.setAttribute('aShade', new THREE.Float32BufferAttribute(new Float32Array(v1 - v0).fill(1), 1));
    const P = part.attributes.position.array;
    const A = part.attributes.color.array;
    const up = (a, b, c) => (P[b * 3 + 2] - P[a * 3 + 2]) * (P[c * 3] - P[a * 3]) - (P[b * 3] - P[a * 3]) * (P[c * 3 + 2] - P[a * 3 + 2]) > 1e-4;
    const solid = [];
    const fringe = [];
    for (let i = 1; i <= r1 - r0; i++) {
      const a = (i - 1) * rowLen;
      const b = i * rowLen;
      for (let j = 0; j < across; j++) {
        for (const [p, q, r] of [[a + j, a + j + 1, b + j], [a + j + 1, b + j + 1, b + j]]) {
          if (!up(p, q, r)) continue;
          if (A[p * 4 + 3] < 0.001 && A[q * 4 + 3] < 0.001 && A[r * 4 + 3] < 0.001) continue;
          (A[p * 4 + 3] > 0.999 && A[q * 4 + 3] > 0.999 && A[r * 4 + 3] > 0.999 ? solid : fringe).push(p, q, r);
        }
      }
    }
    part.setIndex([...solid, ...fringe]);
    part.addGroup(0, solid.length, 0);
    part.addGroup(solid.length, fringe.length, 1);
    part.computeBoundingSphere();
    const mesh = new THREE.Mesh(part, [mat, fringeMat]);
    mesh.name = `road ${r0}`;
    group.add(mesh);
  }
  return group;
}
