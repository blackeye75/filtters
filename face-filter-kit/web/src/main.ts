import { FaceFilterEngine } from "./engine/FaceFilterEngine";
import { createFilteredTrack } from "./engine/outputStream";
import { PRESETS, presetParams, toHex, hex, type FilterParams, type RGB } from "./engine/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $("out") as HTMLCanvasElement;
const video = $("cam") as HTMLVideoElement;
const hud = $("hud");
const status = $("status");

const LOCAL_MODEL = "/models/face_landmarker.task";
const HOSTED_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

async function start() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  await video.play();

  status.textContent = "Loading face model…";
  const haveLocal = await fetch(LOCAL_MODEL, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  const engine = await FaceFilterEngine.create(canvas, {
    wasmBase: "/mediapipe/wasm",
    modelUrl: haveLocal ? LOCAL_MODEL : HOSTED_MODEL,
    atlasUrl: "/makeup_atlas.png",
    delegate: "GPU",
  });
  status.remove();
  bindUi(engine);

  // The filtered stream, ready for RTCPeerConnection.addTrack() in a web call.
  const out = createFilteredTrack(canvas);
  (window as unknown as { filteredStream: MediaStream }).filteredStream = out.stream;

  const supportsVideoFrame = typeof VideoFrame !== "undefined";
  const onFrame = (_now: number, meta?: VideoFrameCallbackMetadata) => {
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h) {
      const ts = meta ? meta.mediaTime * 1000 : performance.now();
      if (supportsVideoFrame) {
        // Snapshot ONE frame; the model and the renderer both read this exact frame.
        const frame = new VideoFrame(video, { timestamp: Math.round(ts * 1000) });
        engine.process(frame, frame.displayWidth, frame.displayHeight, ts);
        frame.close();
      } else {
        engine.process(video, w, h, ts);
      }
      out.pushFrame();
      const s = engine.getStats();
      hud.textContent =
        `${s.fps.toFixed(0)} fps   ${w}x${h}\n` +
        `model  ${s.inferenceMs.toFixed(1)} ms\n` +
        `render ${s.renderMs.toFixed(1)} ms\n` +
        `face   ${s.faceFound ? "tracked" : "-"}`;
    }
    schedule();
  };
  // requestVideoFrameCallback fires once per new camera frame (no duplicates, no polling).
  const schedule = () =>
    "requestVideoFrameCallback" in video
      ? video.requestVideoFrameCallback(onFrame)
      : requestAnimationFrame((t) => onFrame(t));
  schedule();
}

function bindUi(engine: FaceFilterEngine) {
  const presetBox = $("presets");
  const sync = () => {
    const p = engine.getParams();
    for (const group of ["lips", "blush", "skin", "shape", "tone"] as const) {
      for (const [key, value] of Object.entries(p[group])) {
        const el = document.getElementById(`${group}.${key}`) as HTMLInputElement | null;
        if (!el) continue;
        if (el.type === "checkbox") el.checked = value as boolean;
        else if (el.type === "color") el.value = toHex(value as RGB);
        else {
          el.value = String(value);
          const o = el.parentElement?.querySelector("output");
          if (o) o.textContent = Number(value).toFixed(2);
        }
      }
    }
  };

  for (const [name, preset] of Object.entries(PRESETS)) {
    const b = document.createElement("button");
    b.innerHTML = `<span class="sw" style="background:${toHex(presetParams(preset).lips.color)}"></span>${name}`;
    b.onclick = () => {
      engine.setParams(presetParams(preset));
      presetBox.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      sync();
    };
    presetBox.appendChild(b);
  }

  document.querySelectorAll<HTMLInputElement>("aside input[id*='.']").forEach((el) => {
    el.addEventListener("input", () => {
      const [group, key] = el.id.split(".") as [keyof FilterParams, string];
      const value = el.type === "checkbox" ? el.checked : el.type === "color" ? hex(el.value) : Number(el.value);
      engine.setParams({ [group]: { ...engine.getParams()[group], [key]: value } } as Partial<FilterParams>);
      sync();
    });
  });
  ($("split") as HTMLInputElement).onchange = (e) => engine.setView({ split: (e.target as HTMLInputElement).checked ? 0.5 : 0 });
  ($("masks") as HTMLInputElement).onchange = (e) => engine.setView({ debugMasks: (e.target as HTMLInputElement).checked });
  sync();
}

start().catch((e) => {
  console.error(e);
  status.textContent = `Could not start: ${e instanceof Error ? e.message : e}`;
});
