---
description: Integrate the face-filter Expo module on Android and get it running on a device (Phase 2)
---
Phase 2 of `face-filter-kit/BLUEPRINT.md`. Follow the rules in `face-filter-kit/CLAUDE.md` strictly
(frame-synchronous, paint inside the capture pipeline, no per-frame JS, no laggy smoothing).

1. Copy `face-filter-kit/expo-module/face-filter` to `modules/face-filter` (Expo autolinks local modules).
2. Get the model and assets in: `(cd face-filter-kit/web && npm install && npm run setup)`, then
   `face-filter-kit/tools/sync_assets.sh modules/face-filter`. Confirm
   `modules/face-filter/android/src/main/assets/facefilter/face_landmarker.task` exists.
3. Pin the current MediaPipe `com.google.mediapipe:tasks-vision` release in
   `modules/face-filter/android/build.gradle`. Match the build.gradle template to this app's Expo SDK.
4. In the call code, after creating the local stream: `attachFaceFilter(videoTrack)` and
   `applyPreset("Rose")` (see `modules/face-filter/example/CallScreenUsage.tsx`). Do not remove the old
   filter yet; disable it behind a flag.
5. Quick pre-check: `face-filter-kit/tools/android-stubcheck/check.sh modules/face-filter/android/src/main/java/expo/modules/facefilter`.
6. `npx expo prebuild --clean && npx expo run:android` on a connected phone. Fix build errors at the
   root cause; keep changes minimal and explain each.
7. Run a call and check `adb logcat -s FaceFilter`: ES3 context, delegate in use, no exceptions. Check
   the preview is upright and filtered, and the remote side sees the same.
8. Go through "Unverified assumptions — Android" in CLAUDE.md and report each as confirmed / fixed /
   still open. Update BLUEPRINT checkboxes and the decision log.
$ARGUMENTS
