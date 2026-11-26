import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWarps, MAX_WARPS, type ShapeParams } from "../src/engine/warp.ts";
import { FACE_UV } from "../src/engine/faceMeshData.ts";

// The canonical mesh UVs are a frontal face layout: use them as landmarks of a 600 px face.
const S = 600;
const pts = new Float32Array(468 * 3);
for (let i = 0; i < 468; i++) { pts[i * 3] = FACE_UV[i * 2] * S; pts[i * 3 + 1] = FACE_UV[i * 2 + 1] * S; }
const iod = Math.hypot(pts[33 * 3] - pts[263 * 3], pts[33 * 3 + 1] - pts[263 * 3 + 1]);
const off: ShapeParams = { enabled: true, faceSlim: 0, vLine: 0, chin: 0, noseSlim: 0, eyes: 0, lipPlump: 0 };
const max: ShapeParams = { enabled: true, faceSlim: 1, vLine: 1, chin: 1, noseSlim: 1, eyes: 1, lipPlump: 1 };
const A = new Float32Array(MAX_WARPS * 4), B = new Float32Array(MAX_WARPS * 2);

// Same maths as warpUv() in composite.frag, in pixels.
function sample(n: number, x: number, y: number): [number, number] {
  let dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const qx = x - A[i * 4], qy = y - A[i * 4 + 1], r = A[i * 4 + 2], s = A[i * 4 + 3];
    const t = (qx * qx + qy * qy) / (r * r);
    if (t < 1) { const w = (1 - t) ** 2; dx += w * (B[i * 2] + s * qx); dy += w * (B[i * 2 + 1] + s * qy); }
  }
  return [x - dx, y - dy];
}

test("all-zero shape, disabled or no face = no ops", () => {
  assert.equal(buildWarps(pts, iod, off, 1, A, B), 0);
  assert.equal(buildWarps(pts, iod, { ...max, enabled: false }, 1, A, B), 0);
  assert.equal(buildWarps(pts, iod, max, 0, A, B), 0);
});

test("cheek slim moves both cheeks towards the midline", () => {
  const n = buildWarps(pts, iod, { ...off, faceSlim: 1 }, 1, A, B);
  assert.equal(n, 6);
  const midX = pts[168 * 3];
  for (let i = 0; i < n; i++) assert.ok(Math.sign(B[i * 2]) === Math.sign(midX - A[i * 4]), `op ${i} must move inward`);
});

test("max settings never fold the image (mapping stays one-to-one)", () => {
  const n = buildWarps(pts, iod, max, 1, A, B);
  assert.ok(n > 0 && n <= MAX_WARPS);
  const h = 0.5;
  let minDet = Infinity;
  for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) {
    const [ax, ay] = sample(n, x + h, y), [bx, by] = sample(n, x - h, y);
    const [cx, cy] = sample(n, x, y + h), [ex, ey] = sample(n, x, y - h);
    const det = ((ax - bx) * (cy - ey) - (ay - by) * (cx - ex)) / (4 * h * h);
    minDet = Math.min(minDet, det);
  }
  assert.ok(minDet > 0.2, `jacobian determinant ${minDet.toFixed(3)} must stay positive`);
});
