// Downloads the face landmarker model once. Pin the version you ship (float16/1 here).
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
const url = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const out = "public/models/face_landmarker.task";
if (existsSync(out)) { console.log("model already present"); process.exit(0); }
mkdirSync("public/models", { recursive: true });
const res = await fetch(url);
if (!res.ok) { console.error(`download failed: ${res.status}`); process.exit(1); }
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(`saved ${out}`);
