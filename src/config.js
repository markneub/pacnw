// World-wide tunables. Distances are in metres.

export const WORLD_SIZE = 2800; // terrain spans [-WORLD_SIZE/2, WORLD_SIZE/2] on x and z
export const TERRAIN_SEGMENTS = 560; // 5 m cells
export const WATER_LEVEL = 4;
export const SNOWLINE = 115; // average altitude where ground snow starts
export const TREELINE = 230; // trees thin out and stop above this
export const SEED = 1873;

// Southern valley, looking north toward the mountains.
export const SPAWN = { x: 20, z: 640, yaw: 0.15, pitch: 0.03 };

// The cave (cave.js): its mouth at the foot of a hillock's south face, 50 m north of the
// trailhead (straight ahead from the spawn point), the tunnel running north (`dir`: x, z),
// `length` m to the light at its end (about 10 s of running). The mouth sits exactly on a row of
// the 5 m terrain grid, so the ground is level right up to it while the hill rises from the
// next row (terrain.js hillock; the crag round the mouth covers that step).
export const CAVE = {
  x: 15, z: 590,
  dir: [0, -1],
  length: 130,
};

export const CHUNK_SIZE = 125;
export const VIEW_DIST = {
  trees: 520,
  rocks: 320,
  ferns: 110,
  treeDetail: 85, // full-detail trees inside this radius, cheap LOD beyond
};

export const PLAYER = {
  eyeHeight: 1.7,
  radius: 0.4,
  walkSpeed: 5,
  runSpeed: 13,
  gravity: 20,
};
