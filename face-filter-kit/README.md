# Face Filter Engine — starter kit

## Start here (handing this to Claude Code)

1. Put this whole folder inside your React Native app repo as `face-filter-kit/`.
2. Copy `face-filter-kit/.claude/commands/` into your app's `.claude/commands/` (create it if missing).
3. Add this line to your app's root `CLAUDE.md` (create the file if missing):
   `@face-filter-kit/CLAUDE.md`
4. Open Claude Code at the app root and run `/intake`. It reads the docs, inspects your app and
   proposes the integration plan. Then run `/integrate-android`, and later `/integrate-ios`.
   `/verify-kit` re-runs all automated checks.

| File | What it is |
| --- | --- |
| `CLAUDE.md` | Rules, layout, commands, status and unverified assumptions for Claude Code |
| `BLUEPRINT.md` | Decisions to make, phase plan with checklists and gates, risks, decision log |
| `docs/DESIGN.md` | Full architecture and reasoning (export of the design doc) |
| `docs/VERIFICATION.md` | What was tested so far, results, how to re-run |
| `docs/images/` | Architecture diagram, render test results, makeup atlas preview |

Frame-synchronous lip colour, blush and skin smoothing for a React Native (Expo) + react-native-webrtc
video-call app, with a web preview that runs the same shaders. The full design and the reasons behind
every choice are in the design doc.

The rule the whole kit follows: **every frame is painted using the landmarks of that same frame,
inside the camera pipeline, on the GPU.** Nothing is drawn as an overlay, nothing waits for an async
callback, and the smoothing filter does not lag on motion.

```
tools/                 gen_face_assets.py (mesh + makeup atlas from MediaPipe's canonical face), sync_assets.sh,
                       android-stubcheck/ (Kotlin type-check without the Android SDK)
shared/                ONE source of truth used by every platform
  shaders/*.vert|frag    GLSL ES 3.0 (web + Android run these exact files)
  face_mesh.json         468 UVs, 852 render triangles (mouth/eye interiors removed), landmark groups
  makeup_atlas.png       UV-space masks: R lips, G blush, B skin   (designers can repaint it)
  uv_template.png        wireframe for designers painting new looks
  presets.json           Natural, Rose, Berry, Coral, Nude, Red
web/                   preview app + reference engine (TypeScript, WebGL2, MediaPipe Tasks)
  src/engine/            FaceFilterEngine, GLRenderer, OneEuro, outputStream (MediaStream for web calls)
  test/                  One Euro unit tests, headless GPU render test with synthetic faces
expo-module/face-filter/   local Expo module
  android/               Kotlin: VideoFrameProcessor for react-native-webrtc, GLES 3 renderer, MediaPipe
  ios/                   Swift: processor, Metal renderer (Shaders.metal = port of the GLSL), MediaPipe
  src/index.ts           JS API: attachFaceFilter(track), applyPreset, setFilterParams, setFilterEnabled
  example/               how it plugs into a call screen
```

## Web preview

```bash
cd web
npm install
npm run setup        # copies MediaPipe wasm, downloads face_landmarker.task into public/models
npm run dev          # open the printed URL, allow the camera
npm test             # smoother unit tests
python3 test/make_synthetic_face.py && node test/render-test.mjs   # headless GPU render test (needs Chrome; CHROME=/path/to/chrome)
```

`window.filteredStream` is the filtered MediaStream, ready for `RTCPeerConnection.addTrack`.

## React Native (Expo dev build; Expo Go cannot load native modules)

1. `npm i react-native-webrtc @config-plugins/react-native-webrtc` and add the config plugin (camera/mic permissions).
2. Copy `expo-module/face-filter` into your app's `modules/` folder (Expo autolinks local modules).
3. `(cd web && npm install && npm run setup) && tools/sync_assets.sh ../modules/face-filter` so the model, shaders, mesh and atlas are in the module.
4. `npx expo prebuild && npx expo run:android` / `run:ios`.
5. In the call: `attachFaceFilter(localVideoTrack); applyPreset("Rose");` (see `example/CallScreenUsage.tsx`).

## Status

| Part | State |
| --- | --- |
| Web engine | Builds; smoother unit-tested; render graph tested headlessly on synthetic faces (lips recoloured, teeth and background untouched, depth-correct on a 30° turn) |
| Android | Compiles against API stubs (`tools/android-stubcheck/check.sh`); Kotlin smoother output identical to the tested TS version. Needs a Gradle build and on-device testing |
| iOS | Written against the WebRTC / MediaPipe / Metal APIs; not compiled here (no Xcode). Needs on-device testing |

Mesh data is derived from MediaPipe's `canonical_face_model.obj` (Apache-2.0).
