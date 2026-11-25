---
description: Re-run every automated check in the face-filter kit
---
Run all checks from `face-filter-kit/docs/VERIFICATION.md` and report pass/fail with numbers:
1. `cd face-filter-kit/web && npm install && npm run build`
2. `npm test` (One Euro unit tests)
3. `python3 test/make_synthetic_face.py && node test/render-test.mjs` (needs Chrome; set CHROME if needed)
4. `face-filter-kit/tools/android-stubcheck/check.sh` (and against `modules/face-filter/...` if the module was copied into the app)
5. If shared/ or Shaders.metal changed since the last sync, run `tools/sync_assets.sh` for every module copy.
Compare results with VERIFICATION.md and update it if anything changed.
