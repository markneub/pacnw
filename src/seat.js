import * as THREE from 'three';

// The bench model (blender/build_assets.py bench): the seat's top is 0.56 m up, ±0.22 m deep, and the
// sitter faces local +Z. Its collider is 0.9 m round (vegetation.js COLLIDE).
const SEAT_EYE = 1.28; // eye height seated (the seat's top + ~0.72 m)
const SIT_FWD = 0.08; // head a little forward of the seat's middle
const STAND_FWD = 1.4; // where you get up to: in front, clear of the collider (0.9 + the player's 0.4)
const SEAT_HALF = 0.95; // the seat's half-length (along local X)
// "Sit" shows within this of the nearest point of the seat: the bench stands ~2.45 m off the trail's middle, so
// a reach from its centre of 2.2 m never showed walking past (the gaze pull, 3.6 m, did)
const SIT_REACH = 3;

/**
 * Benches you can sit on (the user: "tap to sit on the bench"). Close to one and looking at it, the prompt
 * says "Sit"; tap (or E / click) and you ease down onto it, turned to face its view, and the view widens
 * (player.js SEAT_FOV). Seated you only look round (a drag on a phone looks); another tap gets you up, in
 * front of it.
 */
export function buildSeats(benches = []) {
  const seats = benches.map((b) => {
    const fx = Math.sin(b.rotY);
    const fz = Math.cos(b.rotY);
    return {
      x: b.x, z: b.z,
      ax: Math.cos(b.rotY), az: -Math.sin(b.rotY), // (the seat's length: local +X)
      seatX: b.x + fx * SIT_FWD, seatZ: b.z + fz * SIT_FWD, seatY: b.y,
      standX: b.x + fx * STAND_FWD, standZ: b.z + fz * STAND_FWD,
      yaw: Math.atan2(-fx, -fz), // (yaw 0 looks along −z)
    };
  });
  // each bench draws the eye down to its seat as you come up to it (player.addGaze; main.js: phones only)
  const gaze = seats.map((s) => ({ pos: new THREE.Vector3(s.x, s.seatY + 0.5, s.z), reach: 3.6 }));
  const fwd = new THREE.Vector3();
  let near = null; // the bench you could sit on now
  let prompt = null;

  function update(camera, player) {
    near = null;
    if (!player.seat && player.sitK === 0) {
      camera.getWorldDirection(fwd);
      const fl = Math.hypot(fwd.x, fwd.z);
      for (const s of seats) {
        // to the nearest point along the seat
        const ox = camera.position.x - s.x;
        const oz = camera.position.z - s.z;
        const t = THREE.MathUtils.clamp(ox * s.ax + oz * s.az, -SEAT_HALF, SEAT_HALF);
        const dx = s.x + s.ax * t - camera.position.x;
        const dz = s.z + s.az * t - camera.position.z;
        const d = Math.hypot(dx, dz);
        if (d > SIT_REACH) continue;
        if (d < 0.6 || (fwd.x * dx + fwd.z * dz) / (d * Math.max(fl, 1e-4)) > 0.6) near = s;
      }
    }
    // (none while seated: you know how you sat down)
    prompt = near ? 'Sit' : null;
  }

  function interact(player) {
    if (player.seat) {
      player.standUp();
      return true;
    }
    if (!near) return false;
    player.sitDown(near, SEAT_EYE);
    return true;
  }

  return { update, interact, gaze, get prompt() { return prompt; } };
}
