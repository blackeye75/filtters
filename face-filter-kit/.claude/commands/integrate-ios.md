---
description: Integrate the face-filter module on iOS (Phase 4, after the Android gate passes)
---
Phase 4 of `face-filter-kit/BLUEPRINT.md`. The iOS code has never been compiled; expect first-compile
fixes (see "Unverified assumptions — iOS" in `face-filter-kit/CLAUDE.md`).

1. Make sure `modules/face-filter/ios/Assets/` has face_mesh.json, makeup_atlas.png, presets.json,
   FaceFilterShaders.metalsrc and face_landmarker.task (`face-filter-kit/tools/sync_assets.sh modules/face-filter`).
2. `npx expo prebuild --clean` then build in Xcode or `npx expo run:ios` on a real iPhone.
3. Fix compile errors against the real WebRTC and MediaPipeTasksVision APIs. Keep `Shaders.metal`
   maths identical to `shared/shaders/composite.frag`; if you change one, change both.
4. Verify: processor registered (no "[FaceFilter] ... not found" log), preview upright and filtered,
   remote sees the same, `getFilterStats()` returns timings.
5. Report each iOS assumption as confirmed / fixed / open; update BLUEPRINT.
$ARGUMENTS
