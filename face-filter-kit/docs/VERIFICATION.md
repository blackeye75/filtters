# Verification log

What was actually run while building the kit (Nov 26, 2026), the results, and how to re-run each check.
Nothing here ran on a phone or with a real camera; those checks are Phase 1–4 in `BLUEPRINT.md`.

## 1. Web build

```bash
cd web && npm install && npm run build
```
Result: `tsc --noEmit` clean, Vite production build succeeds (~186 KB JS, ~61 KB gzipped).

## 2. One Euro smoother unit tests

```bash
cd web && npm test
```
Result: 4/4 pass. Measured with 468 synthetic points, 30 fps, face width (inter-ocular) 120 px:

| Case | Result |
| --- | --- |
| Face still, ±1.5 px uniform noise | 0.87 px RMS in → 0.29 px out |
| Slow drift 30 px/s | 1.4 px behind |
| Medium 120 px/s | 1.8 px behind |
| Fast 360 px/s (12 px/frame) | 2.2 px behind |
| Very fast 720 px/s (24 px/frame) | 2.3 px behind |
| Fixed EMA, same smoothness at rest, at 360 px/s | 48 px behind |
| One-frame-late overlay at 360 px/s | 12 px behind |

## 3. Headless GPU render test (WebGL2 in Chrome, SwiftShader)

```bash
cd web && python3 test/make_synthetic_face.py && node test/render-test.mjs
```
Synthetic faces rendered from MediaPipe's canonical mesh with exact landmarks (no model needed).
Result: pass, no GL errors.

| Fixture | Lip pixel before → after | Teeth change | Background change |
| --- | --- | --- | --- |
| frontal | (133,75,77) → (137,45,76) | n/a | 0 |
| yaw 30° | (171,98,100) → (180,91,117) | n/a | 0 |
| mouth open | (128,70,72) → (131,43,72) | 0 | 0 |

Images: `docs/images/render_test_before_after.png`, `docs/images/render_test_masks.png`
(input / filtered / mask view; masks show the mouth hole and eye holes excluded, far cheek hidden on
the turn).

## 4. Android Kotlin type-check (stubs)

```bash
tools/android-stubcheck/check.sh
```
Result: compiles with no errors against hand-written stubs of the Android, WebRTC, MediaPipe and Expo
APIs used. This catches syntax/type errors in our code only; real signatures are verified by the
Gradle build in the app.

## 5. Kotlin ↔ TypeScript smoother parity

Same synthetic input (468 points, 60 frames, sinusoidal noise, 360 px/s motion) through
`LandmarkSmoother.kt` and `OneEuro.ts`: maximum difference 0.0 px across all sampled outputs.
To re-run: compile `LandmarkSmoother.kt` with kotlinc plus a small `main` that feeds the input used in
`web/test/oneEuro.test.ts`, and compare printed values with the TS run.

## 6. Mesh and atlas

`python3 tools/gen_face_assets.py` → 898 canonical triangles, 46 removed (mouth opening + eye
interiors), 852 rendered. `docs/images/atlas_preview.png` shows lips (red), blush (pink) and skin
(green) masks over the UV wireframe.

## Not verified yet

- Web preview with a real camera and the real `face_landmarker.task` model
- Any Android Gradle build or device run
- Any iOS compile or device run
- Performance numbers on real hardware (DESIGN §10 is a budget, not a measurement)
