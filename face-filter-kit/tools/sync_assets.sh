#!/usr/bin/env bash
# Copies the shared assets (shaders, mesh, atlas, presets, Metal source, model) into a face-filter
# module and the web app. Run after editing anything in shared/ or ios/Shaders.metal, or after
# re-running gen_face_assets.py.
#
#   tools/sync_assets.sh                              -> kit's own expo-module/face-filter
#   tools/sync_assets.sh ../modules/face-filter       -> the copy inside your app
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
MOD="$(cd "${1:-$KIT/expo-module/face-filter}" && pwd)"
A="$MOD/android/src/main/assets/facefilter"
I="$MOD/ios/Assets"
mkdir -p "$A" "$I"
cp "$KIT"/shared/shaders/*.vert "$KIT"/shared/shaders/*.frag "$A/"
for f in face_mesh.json makeup_atlas.png presets.json; do cp "$KIT/shared/$f" "$A/"; cp "$KIT/shared/$f" "$I/"; done
cp "$MOD/ios/Shaders.metal" "$I/FaceFilterShaders.metalsrc"
mkdir -p "$KIT/web/public"; cp "$KIT/shared/makeup_atlas.png" "$KIT/web/public/makeup_atlas.png"
MODEL="$KIT/web/public/models/face_landmarker.task"
if [ -f "$MODEL" ]; then
  cp "$MODEL" "$A/"; cp "$MODEL" "$I/"; echo "model copied"
else
  echo "NOTE: model missing. Run: (cd $KIT/web && npm install && npm run setup), then re-run this script."
fi
echo "synced shared assets -> $MOD (android + ios) and web/public"
