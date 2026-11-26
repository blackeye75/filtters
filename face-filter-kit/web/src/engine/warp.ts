// Face reshape: turns this frame's landmarks into a few local "liquify" ops that composite.frag
// applies as one smooth displacement field. Each op i (pixels):
//   A[i] = (centerX, centerY, radius, scale)   B[i] = (moveX, moveY)
//   shader: disp(p) = sum w_i(p) * (move_i + scale_i * (p - center_i)),  w = (1 - |p-c|²/r²)²
//   output pixel p samples the source at p - disp(p). scale > 0 enlarges, < 0 shrinks.
// Moves are kept well under 0.65 * radius, the limit where this field would fold over itself.

export interface ShapeParams {
  enabled: boolean;
  faceSlim: number;  // 0..1 cheeks in
  vLine: number;     // 0..1 jaw angles in (V-shaped jaw)
  chin: number;      // -1..1 shorter .. longer chin
  noseSlim: number;  // 0..1 narrower, slightly smaller nose
  eyes: number;      // 0..1 bigger eyes
  lipPlump: number;  // 0..1 fuller lips
}

export const MAX_WARPS = 20;

// MediaPipe face mesh landmark indices (the same on both sides of the face, mirrored).
const BROW_MID = 168, CHIN = 152, NOSE_TIP = 4, NOSE_MID = 5;
const CHEEKS = [[234, 454], [93, 323], [132, 361]];
const JAW = [[172, 397], [150, 379]];
const NOSE_WINGS = [64, 294];
const EYES = [[33, 133, 159, 145], [263, 362, 386, 374]];
const MOUTH = [61, 291, 13, 14];

/**
 * Fills A (MAX_WARPS * 4) and B (MAX_WARPS * 2) and returns the op count.
 * p: landmarks in pixels (x, y, z per point). iod: eye-corner distance in pixels. fade: 0..1.
 */
export function buildWarps(p: Float32Array, iod: number, s: ShapeParams, fade: number, A: Float32Array, B: Float32Array): number {
  if (!s.enabled || fade <= 0 || iod <= 0) return 0;
  let n = 0;
  const x = (i: number) => p[i * 3], y = (i: number) => p[i * 3 + 1];
  const op = (cx: number, cy: number, r: number, scale: number, mx: number, my: number) => {
    if (n >= MAX_WARPS) return;
    A[n * 4] = cx; A[n * 4 + 1] = cy; A[n * 4 + 2] = r; A[n * 4 + 3] = scale * fade;
    B[n * 2] = mx * fade; B[n * 2 + 1] = my * fade;
    n++;
  };
  // Face midline (brow centre -> chin) follows head roll and turn.
  let ux = x(CHIN) - x(BROW_MID), uy = y(CHIN) - y(BROW_MID);
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul; uy /= ul;
  // Move landmark i towards the midline by `amount` px.
  const inward = (i: number, r: number, amount: number, up = 0) => {
    const dx = x(i) - x(BROW_MID), dy = y(i) - y(BROW_MID);
    const t = dx * ux + dy * uy;
    let vx = x(BROW_MID) + ux * t - x(i), vy = y(BROW_MID) + uy * t - y(i);
    const vl = Math.hypot(vx, vy) || 1;
    vx /= vl; vy /= vl;
    op(x(i), y(i), r, 0, vx * amount - ux * up, vy * amount - uy * up);
  };
  const centre = (ids: number[]): [number, number] =>
    [ids.reduce((a, i) => a + x(i), 0) / ids.length, ids.reduce((a, i) => a + y(i), 0) / ids.length];

  if (s.faceSlim > 0) for (const pair of CHEEKS) for (const i of pair) inward(i, 0.55 * iod, 0.09 * iod * s.faceSlim);
  if (s.vLine > 0) for (const pair of JAW) for (const i of pair) inward(i, 0.42 * iod, 0.10 * iod * s.vLine, 0.03 * iod * s.vLine);
  if (s.chin !== 0) op(x(CHIN), y(CHIN), 0.5 * iod, 0, ux * 0.10 * iod * s.chin, uy * 0.10 * iod * s.chin);
  if (s.noseSlim > 0) {
    for (const i of NOSE_WINGS) {
      // wings move towards the nose tip's line, not the face midline, so a turned head stays right
      const vx = x(NOSE_TIP) - x(i), vy = y(NOSE_TIP) - y(i), vl = Math.hypot(vx, vy) || 1;
      op(x(i), y(i), 0.22 * iod, 0, (vx / vl) * 0.05 * iod * s.noseSlim, (vy / vl) * 0.05 * iod * s.noseSlim);
    }
    op(x(NOSE_MID), y(NOSE_MID), 0.32 * iod, -0.10 * s.noseSlim, 0, 0);
  }
  if (s.eyes > 0) for (const ids of EYES) { const [cx, cy] = centre(ids); op(cx, cy, 0.38 * iod, 0.18 * s.eyes, 0, 0); }
  if (s.lipPlump > 0) { const [cx, cy] = centre(MOUTH); op(cx, cy, 0.42 * iod, 0.12 * s.lipPlump, 0, 0); }
  return n;
}
