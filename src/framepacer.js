/**
 * GPU frame pacing. A browser can keep calling requestAnimationFrame at 60 Hz while the GPU
 * falls behind (seen on an M1 Mac mini: ?perf said 50-60 fps while the screen showed ~5-10):
 * the frames queue up and most never reach the screen. Each frame ends with a fence, and a new
 * frame only starts when at most MAX earlier ones are still on the GPU; otherwise that
 * animation frame is skipped. The game then runs at the rate the GPU really delivers, the input
 * lag stays short, and ?perf and autores.js (which only see frames that are drawn) measure the
 * real frame rate, so autores can lower the resolution.
 *
 * The fences are polled without blocking (their status updates between tasks). A fence that
 * hasn't signalled after STALE ms is dropped, so a driver that never signals can't stop the game.
 */
const MAX = 2;
const STALE = 250; // ms

export class FramePacer {
  constructor(renderer) {
    const gl = renderer.getContext();
    this.gl = typeof gl.fenceSync === 'function' ? gl : null; // WebGL2 only
    this.fences = []; // [sync, time issued]
    this.skipped = 0; // animation frames skipped since the last count (read by perf.js)
  }

  /** Call at the start of an animation frame: false = the GPU is behind, skip this one. */
  ready() {
    const { gl, fences } = this;
    if (!gl) return true;
    const now = performance.now();
    while (fences.length) {
      const [sync, t] = fences[0];
      if (gl.getSyncParameter(sync, gl.SYNC_STATUS) !== gl.SIGNALED && now - t < STALE) break;
      gl.deleteSync(sync);
      fences.shift();
    }
    if (fences.length < MAX) return true;
    this.skipped++;
    return false;
  }

  /** Call after the frame's last draw. */
  submit() {
    const { gl } = this;
    if (!gl) return;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (sync) {
      this.fences.push([sync, performance.now()]);
      gl.flush();
    }
  }
}
