// Serve the MediaPipe WASM from our own origin (no CDN dependency at runtime).
import { cpSync, existsSync } from "node:fs";
const src = "node_modules/@mediapipe/tasks-vision/wasm";
const dst = "public/mediapipe/wasm";
if (!existsSync(src)) { console.error("Run npm install first"); process.exit(1); }
cpSync(src, dst, { recursive: true });
cpSync("../shared/makeup_atlas.png", "public/makeup_atlas.png");
console.log("copied MediaPipe wasm + makeup atlas into public/");
