#!/usr/bin/env bash
# Fast type-check of the Android Kotlin sources WITHOUT an Android SDK, against hand-written API
# stubs (java/ and ExpoStubs.kt). Catches syntax and type errors in our code only; it proves nothing
# about runtime behaviour or the real library signatures. The real check is a Gradle build in the app.
#
#   tools/android-stubcheck/check.sh [path/to/facefilter/kotlin/sources]
# Needs: JDK 17+ (javac). Uses kotlinc from PATH, $KOTLINC, or downloads Kotlin 2.1.0 into .cache/.
# If you add a new Android/WebRTC/MediaPipe API call, add its signature to the stubs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HERE/../../expo-module/face-filter/android/src/main/java/expo/modules/facefilter}"
KOTLINC="${KOTLINC:-$(command -v kotlinc || true)}"
if [ -z "$KOTLINC" ]; then
  if [ ! -x "$HERE/.cache/kotlinc/bin/kotlinc" ]; then
    mkdir -p "$HERE/.cache"
    curl -sL -o "$HERE/.cache/kotlin.zip" https://github.com/JetBrains/kotlin/releases/download/v2.1.0/kotlin-compiler-2.1.0.zip
    (cd "$HERE/.cache" && unzip -q kotlin.zip)
  fi
  KOTLINC="$HERE/.cache/kotlinc/bin/kotlinc"
fi
rm -rf "$HERE/.build"; mkdir -p "$HERE/.build/classes"
javac -nowarn -d "$HERE/.build/classes" $(find "$HERE/java" -name '*.java')
"$KOTLINC" -nowarn -cp "$HERE/.build/classes" -d "$HERE/.build/out.jar" "$HERE/ExpoStubs.kt" "$SRC"/*.kt
echo "OK: Android Kotlin sources type-check against the stubs"
