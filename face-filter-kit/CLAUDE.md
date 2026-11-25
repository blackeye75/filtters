# CLAUDE.md — Face Filter Engine

Real-time lip colour, blush and skin smoothing for a React Native (Expo) + react-native-webrtc video
call app (strangers connect and pay hosts for calls), plus a web preview. Quality is the top priority:
the result must match paid SDKs (Banuba, DeepAR, BytePlus Effects class) and must never lag behind
the face.

Read these before changing anything:
- `docs/DESIGN.md` — the architecture and the reasons behind every choice (the source of truth).
- `BLUEPRINT.md` — decisions still open, phase plan with checklists, risks, decision log.
- `docs/VERIFICATION.md` — what has been tested so far and how to re-run it.

## The problem this solves

The previous in-app filter drew lips/blush as an overlay and lagged a few milliseconds behind a
moving face, then snapped back. Causes: landmarks from an older frame painted over a newer frame,
async inference, and fixed-weight smoothing (lerp/EMA). This engine removes all three.

## Non-negotiable rules

1. **Frame-synchronous.** Frame N is painted with frame N's landmarks. Use MediaPipe `VIDEO` mode
   (`detectForVideo` / `detect(videoFrame:)`), called synchronously in the frame processor. Never
   `LIVE_STREAM`, `detectAsync`, result callbacks, or "latest result" caches.
2. **Paint inside the capture pipeline.** Filtering happens in react-native-webrtc's video frame
   processor (Android `VideoFrameProcessor`, iOS `capturer:didCaptureVideoFrame:`), so the preview
   (RTCView) and the remote peer get identical pixels. Never draw makeup as a React Native view, Skia
   canvas or SVG on top of RTCView.
3. **No per-frame JS.** JS only swaps parameter snapshots (`setFilterParams`, `applyPreset`,
   `setFilterEnabled`). No frames, landmarks or callbacks cross the bridge.
4. **GPU-only pixel path.** Full-resolution pixels never go to the CPU. Only the small upright model
   input (≤640 px long side) is read back.
5. **No laggy smoothing.** Jitter is fixed by tuning the One Euro filter (`web/src/engine/OneEuro.ts`),
   never by adding EMA/lerp/moving averages or extra frames of delay.
6. **Image-space convention everywhere:** texture memory row 0 = image top; UV/landmark (0,0) =
   top-left. Consequences: GL fullscreen passes use `uFlipY = 1` only when drawing to an on-screen
   framebuffer; Android output frames carry a vertical-flip transform matrix; Metal maps image y to
   NDC with `1 - 2y`. If something renders upside down, check this first.
7. **`shared/` is the single source of truth.** Web and Android load the same GLSL files unchanged.
   `ios/Shaders.metal` is a hand port; any change to the composite maths goes into both. After any
   change in `shared/` or `Shaders.metal`, run `tools/sync_assets.sh <module path>`.
8. **Generated files are not edited by hand:** `shared/face_mesh.json`, `shared/makeup_atlas.png`,
   `shared/uv_template.png`, `web/src/engine/faceMeshData.ts` come from `tools/gen_face_assets.py`.
9. **Keep the three smoother ports identical** (TS reference with tests, Kotlin, Swift). After
   changing one, change the others and re-run the parity check in `docs/VERIFICATION.md`.
10. **Keep the mouth/eye triangle removal** in the mesh generator. Without it, lipstick is painted on
    teeth when the mouth opens.
11. **Android passthrough must `frame.retain()`** before returning the input frame (the caller
    releases both input and output).
12. **No per-frame allocations** in Kotlin/Swift hot paths; reuse arrays and buffers. Log tag:
    `FaceFilter`.

## Layout

```
CLAUDE.md, BLUEPRINT.md, README.md
docs/            DESIGN.md (architecture), VERIFICATION.md (test evidence), images/
shared/          shaders/*.vert|frag (GLSL ES 3.0), face_mesh.json, makeup_atlas.png (R lips, G blush,
                 B skin), uv_template.png, presets.json
tools/           gen_face_assets.py, canonical_face_model.obj, sync_assets.sh, android-stubcheck/
web/             preview app + reference engine (Vite + TS + WebGL2 + @mediapipe/tasks-vision)
  src/engine/    FaceFilterEngine.ts, GLRenderer.ts, OneEuro.ts, outputStream.ts, types.ts, faceMeshData.ts
  test/          oneEuro.test.ts, make_synthetic_face.py, render.html/.ts, render-test.mjs
expo-module/face-filter/   local Expo module -> copy to <app>/modules/face-filter
  src/index.ts   JS API: attachFaceFilter, detachFaceFilter, applyPreset, setFilterParams,
                 setFilterEnabled, getFilterStats, presetNames, hex
  android/       FaceFilterModule.kt, FaceFilterProcessor.kt, FaceRenderer.kt, FaceTracker.kt,
                 LandmarkSmoother.kt, FilterParams.kt, build.gradle, assets/facefilter/
  ios/           FaceFilterModule.swift, FaceFilterProcessor.swift, MetalRenderer.swift,
                 FaceFilterCore.swift, Shaders.metal, FaceFilter.podspec, Assets/
  example/       CallScreenUsage.tsx
.claude/commands/  intake, integrate-android, integrate-ios, verify-kit
```

## Commands

```bash
# web preview + reference engine
cd web && npm install && npm run setup      # copies MediaPipe wasm, downloads face_landmarker.task
npm run dev                                 # camera preview with live controls
npm run build                               # tsc + vite build
npm test                                    # One Euro unit tests
python3 test/make_synthetic_face.py && node test/render-test.mjs   # headless GPU render test (Chrome)

# assets
python3 tools/gen_face_assets.py            # regenerate mesh/atlas/template (needs numpy, pillow)
tools/sync_assets.sh ../modules/face-filter # copy shared assets + model into the app's module

# Android Kotlin type-check without the Android SDK (fast pre-check, not a real build)
tools/android-stubcheck/check.sh

# inside the app
npx expo prebuild --clean && npx expo run:android      # dev build; Expo Go cannot work
adb logcat -s FaceFilter                               # processor logs
npx expo run:ios                                        # Mac + Xcode; logs prefixed [FaceFilter]
```

## Status (Nov 26, 2026)

| Part | State |
| --- | --- |
| Web engine | Builds; smoother tests pass; render graph verified headlessly on synthetic faces. Never run with a real camera + model yet (model download was blocked in the build environment) |
| Android | Compiles against API stubs; Kotlin smoother output identical to TS. **Never built with Gradle or run on a device** |
| iOS | **Never compiled** (no Xcode in the build environment) |
| JS API | Written, not run |

## Unverified assumptions — check these first, in this order

Android:
1. react-native-webrtc's capture EGL context is OpenGL ES 3. If logcat shows "Needs an OpenGL ES 3
   context", create our own ES3 context shared with WebRTC's on a dedicated GL thread.
2. `TextureBufferImpl(type = RGB)` frames render correctly in RTCView and encode on the remote side.
   Upside-down output means the flip matrix in `FaceFilterProcessor.kt` step 4 is wrong.
3. The rotation mapping in `prepMatrix()`; the r / r+180 probe should rescue a wrong direction.
4. MediaPipe `tasks-vision` version in `android/build.gradle` (pinned at 0.10.26 as a placeholder:
   check Maven Central for the current release and pin that).
5. `build.gradle` uses `expo-module-gradle-plugin` (Expo SDK 52+). Older SDKs need the older template.
6. The app's WebRTC package is upstream `react-native-webrtc` (package `com.oney.WebRTCModule`,
   `ProcessorProvider`). A fork or a vendor SDK changes the integration (see BLUEPRINT D2).

iOS (expect first-compile fixes):
1. Swift names: `RTCVideoRotation` cases (`._90` etc.), `RTCCVPixelBuffer`, `RTCVideoFrame` init.
2. MediaPipe Swift API: `FaceLandmarkerOptions` property names, `Delegate.GPU/.CPU`,
   `detect(videoFrame:timestampInMilliseconds:)`, `MPImage(pixelBuffer:)`.
3. The ObjC selector `capturer:didCaptureVideoFrame:` must match exactly (`@objc(...)` on `process`).
4. Resource bundle `FaceFilterAssets` lookup and runtime Metal compile of `FaceFilterShaders.metalsrc`.
5. Pod settings with the app's `use_frameworks!` mode (podspec sets `static_framework = true`).

## How to work here

- Start with `/intake` (repo inspection, fills BLUEPRINT decisions D2/D3), then `/integrate-android`.
  Android first, iOS after Android meets the gate in BLUEPRINT.
- Build and run on a real phone after each meaningful change; emulators don't show real GPU/camera
  behaviour.
- For visual problems, compare with the web preview (same shaders) and use its "Show masks" view. Add
  a native debug flag that outputs the mask texture if needed.
- Record every decision in the BLUEPRINT decision log. Update `docs/DESIGN.md` when the design changes.
- Don't claim something works until it ran on a device; say what was and wasn't verified.
