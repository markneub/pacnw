// World-wide tunables. Distances are in metres.

export const WORLD_SIZE = 2000; // terrain spans [-WORLD_SIZE/2, WORLD_SIZE/2] on x and z
export const TERRAIN_SEGMENTS = 400;
export const WATER_LEVEL = 4;
export const SNOWLINE = 115; // average altitude where ground snow starts
export const TREELINE = 230; // trees thin out and stop above this
export const SEED = 1873;

// Southern valley, looking north toward the mountains.
export const SPAWN = { x: 20, z: 640, yaw: 0.15, pitch: 0.03 };

export const CHUNK_SIZE = 125;
export const VIEW_DIST = {
  trees: 520,
  rocks: 320,
  ferns: 110,
  treeDetail: 85, // full-detail + mid trees inside this radius, impostors beyond
  treeNear: 40, // full-detail trees inside this radius, the mid model beyond (out to treeDetail)
};

export const PLAYER = {
  eyeHeight: 1.7,
  radius: 0.4,
  walkSpeed: 5,
  runSpeed: 13,
  gravity: 20,
};
