// Run: npm test   (Node 22+, uses --experimental-strip-types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { LandmarkSmoother } from "../src/engine/OneEuro.ts";

const N = 468;            // full face mesh: centroid speed averages landmark noise
const IOD = 120;          // px, a face at typical call distance in 720p
const FPS = 30;

// deterministic noise
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

function run(signal: (t: number) => number, noisePx: number, frames: number) {
  const s = new LandmarkSmoother(N);
  const raw = new Float32Array(N * 3), out = new Float32Array(N * 3);
  const errs: number[] = [];
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    const truth = signal(t);
    for (let i = 0; i < N; i++) { raw[i * 3] = truth + i * 10 + rand() * noisePx; raw[i * 3 + 1] = 300; raw[i * 3 + 2] = 0; }
    s.filter(raw, t, IOD, out);
    if (f > 15) errs.push(out[0] - truth);
  }
  const rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
  const meanLag = errs.reduce((a, e) => a + e, 0) / errs.length;
  return { rms, meanLag };
}

test("removes jitter when the face is still", () => {
  const noise = 1.5;                                    // ±1.5 px landmark noise
  const inputRms = noise / Math.sqrt(3);
  const { rms } = run(() => 400, noise, 300);
  assert.ok(rms < inputRms / 2.5, `still jitter ${rms.toFixed(3)} px vs input ${inputRms.toFixed(3)} px`);
});

test("follows a fast head move with little lag", () => {
  const v = 3 * IOD;                                    // 3 face-widths per second: a quick head turn
  const { meanLag } = run((t) => 200 + v * t, 1.0, 40);
  const frameStep = v / FPS;                            // how far the face moves in one frame
  assert.ok(Math.abs(meanLag) < frameStep * 0.35, `lag ${meanLag.toFixed(2)} px vs one-frame move ${frameStep.toFixed(1)} px`);
});

test("a fixed EMA with the same stillness would lag far more (why lerp feels laggy)", () => {
  // EMA tuned to give the same still-face jitter as One Euro at rest (cutoff 1.2 Hz @ 30 fps)
  const a = 1 / (1 + (1 / (2 * Math.PI * 1.2)) * FPS);
  const v = 3 * IOD;
  let y = 200, lagSum = 0, n = 0;
  for (let f = 0; f < 40; f++) {
    const truth = 200 + v * (f / FPS);
    y += a * (truth - y);
    if (f > 15) { lagSum += y - truth; n++; }
  }
  const emaLag = Math.abs(lagSum / n);
  const { meanLag } = run((t) => 200 + v * t, 1.0, 40);
  assert.ok(emaLag > 8 * Math.abs(meanLag), `EMA lag ${emaLag.toFixed(1)} px vs One Euro ${Math.abs(meanLag).toFixed(2)} px`);
});

test("reset snaps to the new position (no slide-in after re-detection)", () => {
  const s = new LandmarkSmoother(N);
  const raw = new Float32Array(N * 3).fill(100), out = new Float32Array(N * 3);
  s.filter(raw, 0, IOD, out);
  s.filter(raw, 1 / 30, IOD, out);
  s.reset();
  raw.fill(900);
  s.filter(raw, 2 / 30, IOD, out);
  assert.equal(out[0], 900);
});
