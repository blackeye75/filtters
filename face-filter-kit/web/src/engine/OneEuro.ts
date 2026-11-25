/**
 * One Euro landmark smoother (Casiez, Roussel, Vogel, CHI 2012), tuned for face meshes.
 *
 * - Cutoff rises with speed: heavy smoothing when still (no jitter), almost none when moving (no lag).
 * - Speed is measured in FACE UNITS (pixels / inter-ocular distance) so one set of parameters works
 *   at any resolution and any distance from the camera.
 * - Each point uses max(own speed, whole-face speed): a head turn unlocks every point together, so the
 *   mesh never shears, while a mouth opening still unlocks the lip points on their own.
 * - Whole-face speed comes from the centroid of all points, where landmark noise averages out. A single
 *   point's own speed is noisy, so it only counts above a small dead zone; otherwise noise would raise
 *   the cutoff and let jitter through on a still face.
 */
export interface OneEuroOptions {
  minCutoff: number;     // Hz, smoothing at rest (lower = smoother, more lag at rest)
  beta: number;          // speed coefficient in face units (higher = less lag when moving)
  dCutoff: number;       // Hz, smoothing of the speed estimate
  lipMinCutoff: number;  // Hz, lips move with speech: less smoothing
  localDeadzone: number; // face units / s; per-point speed below this is treated as noise
}

export const DEFAULT_ONE_EURO: OneEuroOptions = { minCutoff: 1.2, beta: 8.0, dCutoff: 1.0, lipMinCutoff: 3.0, localDeadzone: 0.35 };

const alpha = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class LandmarkSmoother {
  private readonly n: number;
  private readonly x: Float32Array;      // filtered positions, xyz per point (pixels)
  private readonly dx: Float32Array;     // filtered speed per point (face units / s)
  private readonly minCut: Float32Array; // per-point min cutoff
  private globalSpeed = 0;
  private prevCentroid = [0, 0];
  private lastT = -1;
  private initialized = false;
  private readonly opts: OneEuroOptions;

  constructor(numPoints: number, opts: OneEuroOptions = DEFAULT_ONE_EURO, lipIndices: readonly number[] = []) {
    this.opts = opts;
    this.n = numPoints;
    this.x = new Float32Array(numPoints * 3);
    this.dx = new Float32Array(numPoints);
    this.minCut = new Float32Array(numPoints).fill(opts.minCutoff);
    for (const i of lipIndices) if (i < numPoints) this.minCut[i] = opts.lipMinCutoff;
  }

  reset(): void {
    this.initialized = false;
    this.lastT = -1;
  }

  /**
   * @param raw   xyz per point, pixels (z in the same scale as x)
   * @param tSec  frame timestamp in seconds (camera clock, monotonic)
   * @param scale face size in pixels (inter-ocular distance)
   * @param out   receives filtered xyz (may be the same array as raw)
   */
  filter(raw: Float32Array, tSec: number, scale: number, out: Float32Array): Float32Array {
    const n = this.n;
    const { beta, dCutoff, localDeadzone } = this.opts;
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += raw[i * 3]; cy += raw[i * 3 + 1]; }
    cx /= n; cy /= n;

    if (!this.initialized || tSec <= this.lastT) {
      this.x.set(raw.subarray(0, n * 3));
      this.dx.fill(0);
      this.globalSpeed = 0;
      this.prevCentroid = [cx, cy];
      this.lastT = tSec;
      this.initialized = true;
      out.set(this.x);
      return out;
    }

    const dt = Math.min(Math.max(tSec - this.lastT, 1 / 240), 0.2);
    this.lastT = tSec;
    const invScale = 1 / Math.max(scale, 1);
    const aD = alpha(dCutoff, dt);

    // whole-face speed from the centroid (robust, moves with the head)
    const gs = Math.hypot(cx - this.prevCentroid[0], cy - this.prevCentroid[1]) * invScale / dt;
    this.prevCentroid = [cx, cy];
    this.globalSpeed += aD * (gs - this.globalSpeed);

    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const ex = raw[o] - this.x[o], ey = raw[o + 1] - this.x[o + 1];
      const speed = Math.hypot(ex, ey) * invScale / dt;
      this.dx[i] += aD * (speed - this.dx[i]);
      const local = Math.max(0, this.dx[i] - localDeadzone);
      const cutoff = this.minCut[i] + beta * Math.max(local, this.globalSpeed);
      const a = alpha(cutoff, dt);
      this.x[o] += a * ex;
      this.x[o + 1] += a * ey;
      this.x[o + 2] += a * (raw[o + 2] - this.x[o + 2]);
    }
    out.set(this.x);
    return out;
  }
}
