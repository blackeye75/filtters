---
description: Inspect the app repo and prepare the face-filter integration plan (Phase 0)
---
You are starting Phase 0 of the face filter project. The kit lives in `face-filter-kit/` (find it if it
is elsewhere).

1. Read `face-filter-kit/CLAUDE.md`, `face-filter-kit/BLUEPRINT.md` and `face-filter-kit/docs/DESIGN.md`.
2. Inspect this app (read only, change nothing yet):
   - WebRTC library and exact version from package.json (upstream `react-native-webrtc`, a fork, or a
     vendor SDK). Confirm the installed package contains the videoEffects hook:
     `android/src/main/java/com/oney/WebRTCModule/videoEffects/ProcessorProvider.java` and
     `ios/RCTWebRTC/videoEffects/ProcessorProvider.h` under node_modules.
   - Expo SDK version, new/old architecture, whether `modules/` already exists, `app.json` plugins.
   - Where the local camera track is created (getUserMedia call) and where RTCView renders it.
   - Where the current lip/blush filter lives and how it is drawn.
3. Fill BLUEPRINT decisions D2 and D3 (status + notes) and add decision-log rows.
4. Report: what you found, any mismatch with the kit's assumptions, and the exact file-by-file plan for
   Phase 2. Wait for my go-ahead before changing app code.
