# BLUEPRINT — decisions, phases, risks

Companion to `docs/DESIGN.md`. The design says *how* the engine works; this file says *what to decide*,
*in what order to build*, and *how we know a phase is done*. Update the status columns and the decision
log as you go.

## 1. Decisions to make

Two are blocking (D2, D3): Claude Code can answer them by reading the app repo (`/intake`). The rest
have a recommended default you can accept as-is.

| ID | Decision | Options | Recommended | Why it matters | Status |
| --- | --- | --- | --- | --- | --- |
| D1 | Platform order | Android first / iOS first / both together | Android first | Most hosts/callers in the target market are on Android; one platform at a time halves debugging | Open |
| D2 | Which WebRTC library the app uses | Upstream `react-native-webrtc` / a fork (`@stream-io/react-native-webrtc`, `@livekit/react-native-webrtc`) / a vendor SDK (Agora, Twilio, 100ms, Zego…) | Upstream `react-native-webrtc` ≥ 118 (has the `videoEffects` hook the kit uses) | **Blocking.** The processor plugs into `ProcessorProvider` / `_setVideoEffects`. Forks rename packages; vendor SDKs have their own processor APIs, so the hook layer changes (the engine itself does not) | Open — check `package.json` |
| D3 | Expo SDK and architecture | SDK version; old or new architecture | Whatever the app uses; the module needs SDK 52+ for `expo-module-gradle-plugin` | **Blocking** for the Android build file; older SDKs need the older module template | Open — check `package.json` / `app.json` |
| D4 | Lowest supported devices | Android minSdk, iOS version, the cheapest phones you must support | minSdk 24 (Android 7), iOS 15.1; test on one low, one mid, one high Android phone | Sets the low tier and the perf gate | Open |
| D5 | Call capture resolution | 720p / 540p / adaptive | 720p capture on mid/high tier, 540p on low tier | Bandwidth on mobile data vs sharpness; the filter cost scales with pixels | Open |
| D6 | Which effects ship in v1, defaults | Lips, blush, skin; on or off by default | All three, filter off by default, host turns it on | Users trust a filter they chose; avoids surprising callers | Open |
| D7 | Who can use the filter | Hosts only / callers too | Both, each for their own camera | It only touches your own outgoing video | Open |
| D8 | Where looks come from | Bundled presets / server-delivered looks (atlas + params JSON) | Bundled for v1, server-delivered in phase 5 | New looks without an app release | Open |
| D9 | Web scope | Preview only / also web calls | Preview first; the engine already outputs a MediaStream if web calls come later | Web calls need the Worker pipeline for production quality | Open |
| D10 | MediaPipe delegate on Android | GPU with CPU fallback / CPU only | GPU with CPU fallback, plus a per-device denylist if a GPU misbehaves | GPU is faster and cooler; some drivers are flaky | Open |
| D11 | Model delivery | Bundle `face_landmarker.task` (a few MB) / download on first use | Bundle | Works offline and on first call | Open |
| D12 | Old overlay filter code | Delete / keep as fallback | Delete once Android v1 passes its gate | Two filter paths double the bugs | Open |
| D13 | Performance telemetry | None / log `getFilterStats()` per call to your backend | Log p50/p95 total ms, fps, thermal state, device model | Real data for device tiers | Open |
| D14 | "Beauty on" indicator for the other person | None / small badge | Product choice; recommend deciding before launch | Transparency expectations in paid stranger calls | Open |

## 2. Phases

Each phase ends at a gate. Don't start the next phase until the gate passes.

### Phase 0 — Intake (Claude Code, ~1 session)
- [ ] Read `CLAUDE.md`, `docs/DESIGN.md`, this file
- [ ] Inspect the app: WebRTC library + version (D2), Expo SDK + architecture (D3), where the local
      video track is created, where the old filter lives
- [ ] Record answers in the decision log; if D2 is not upstream `react-native-webrtc`, write the
      adapter plan before Phase 2
- **Gate:** D2 and D3 answered; integration plan agreed

### Phase 1 — Web preview check (optional, fast)
- [ ] `cd web && npm install && npm run setup && npm run dev`, real camera
- [ ] Fast head shakes: lips stay on; open mouth: teeth stay clean; "Show masks" lines up
- [ ] Tune preset colours if needed (`web/src/engine/types.ts` and `shared/presets.json` together)
- **Gate:** the look is approved by the product owner

### Phase 2 — Android integration
- [ ] Copy `expo-module/face-filter` to `<app>/modules/face-filter`
- [ ] `tools/sync_assets.sh <app>/modules/face-filter` (model included)
- [ ] Pin the current MediaPipe `tasks-vision` version in `android/build.gradle`
- [ ] `attachFaceFilter(localVideoTrack)` where the call creates its camera track (see `example/`)
- [ ] `npx expo prebuild --clean && npx expo run:android` on a real phone; fix build errors
- [ ] Check logcat (`FaceFilter`): ES3 context, delegate in use, no exceptions
- [ ] Preview upright and filtered; remote side sees the same filtered video
- [ ] Remove the old overlay filter (D12)
- **Gate:** filter visible on preview and remote, no crash in a 10-minute call

### Phase 3 — Android quality and performance
- [ ] Measure with `getFilterStats()`: total ms p50/p95 on low/mid/high phones
- [ ] Alignment, jitter and latency tests from DESIGN §11
- [ ] 45-minute soak on the low-tier phone
- [ ] Optimizations if needed: blur passes before the inference wait, HardwareBuffer readback
- **Gate:** DESIGN §2 targets met on all three Android phones

### Phase 4 — iOS
- [ ] Copy module, `pod install` via prebuild, fix first-compile issues (see CLAUDE.md list)
- [ ] Same checks as Phases 2–3 on an iPhone 11-class device
- **Gate:** DESIGN §2 targets met on iOS

### Phase 5 — Productization
- [ ] Device tier benchmark at first launch; tier table from DESIGN §10
- [ ] Thermal step-down (iOS `thermalState`, Android `getCurrentThermalStatus`)
- [ ] Host "look" picker before going live (same engine on a local track)
- [ ] In-call "Beauty" toggle (`setFilterEnabled`)
- [ ] Server-delivered looks (D8), telemetry (D13)
- **Gate:** soak passes with thermal management; looks can be added without an app release

### Phase 6 — v2 quality (closing the gap to paid SDKs)
- [ ] Lip-parsing model on a mouth crop (commercially licensed training data)
- [ ] Occlusion: hand/mic over mouth cuts the masks
- [ ] Optional: face reshape / eye enlarge via mesh warp; temporal denoise for low light
- **Gate:** blind A/B against a paid SDK demo app at parity or better

## 3. Acceptance targets (from DESIGN §2)

| Metric | Target (720p, 30 fps) |
| --- | --- |
| Frame offset landmarks ↔ pixels | 0 frames |
| Processing per frame | ≤ 12 ms mid-range, ≤ 20 ms low-end |
| Sustained frame rate | ≥ 27 fps through a 45-minute call |
| Jitter, face still | < 0.5 px RMS |
| Lip edge error incl. fast turns | p50 ≤ 2 px, p95 ≤ 4 px |
| Face lost/found | fades within 150 ms, no pop |
| Extra power | ≤ 15% of the call's draw |

## 4. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| App uses a WebRTC fork or vendor SDK, not upstream `react-native-webrtc` | Medium | High | Phase 0 check; write an adapter for that SDK's processor hook; the engine code stays the same |
| WebRTC's EGL context is ES 2 on some devices | Low–medium | High (filter off) | Own ES3 context shared with WebRTC's |
| MediaPipe GPU delegate unstable on some GPUs | Medium | Medium | CPU fallback, per-device denylist via telemetry |
| Low-end phones exceed 20 ms | Medium | Medium | Tiers: 540p, 480 px input, smoothing off, extrapolation mode |
| Heat drops fps in long host sessions | Medium | High | Thermal step-down order in DESIGN §10 |
| iOS first compile needs many fixes | High | Low | Expected; list in CLAUDE.md |
| Lip edge looks wrong on some lip colours / lighting | Medium | Medium | Tune edge-snap thresholds with the coverage test set; v2 lip model |
| MediaPipe built-in smoothing adds lag on top of ours | Low–medium | Medium | Measure with the motion test; relax our filter if needed |

## 5. Decision log

| Date | ID | Decision | By | Notes |
| --- | --- | --- | --- | --- |
| 2026-11-26 | — | Architecture: frame-synchronous native processor inside react-native-webrtc capture path; MediaPipe VIDEO mode; One Euro smoothing; UV-mesh makeup; shared GLSL (web/Android) + Metal port | Design | See docs/DESIGN.md |
| 2026-11-26 | — | Added face reshape (landmark-driven warp in composite.frag, `web/src/engine/warp.ts`), colour grade + bronze, and full-look presets (Sunkissed, Golden Hour, Soft Glam, Doll, Clean Girl, Sculpt). New uniforms are no-ops at 0 | Product request | **Web only so far.** Android must build warp ops with a Kotlin port of warp.ts and set the new uniforms; iOS `Shaders.metal` needs the same composite changes. Until then native applies only the lips/blush/skin part of the new presets |

## 6. Open questions for the product owner

1. Which WebRTC library and Expo SDK does the app use today? (D2, D3)
2. What are the cheapest phones hosts and callers actually use? (D4)
3. Filter on or off by default, and for whom? (D6, D7)
4. Should the other person see a "beauty on" badge? (D14)
5. Is a web calling client planned, or is web only for previewing looks? (D9)
