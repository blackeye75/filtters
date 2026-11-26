import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { GLRenderer, type FaceGeometry } from "./GLRenderer";
import { LandmarkSmoother, DEFAULT_ONE_EURO, type OneEuroOptions } from "./OneEuro";
import { GROUPS, LIP_LANDMARKS } from "./faceMeshData";
import { DEFAULT_PARAMS, type FilterParams, type FrameStats } from "./types";
import { buildWarps, MAX_WARPS } from "./warp";

export interface EngineOptions {
  wasmBase: string;            // folder with MediaPipe wasm files
  modelUrl: string;            // face_landmarker.task
  atlasUrl: string;            // makeup_atlas.png
  delegate?: "GPU" | "CPU";
  smoothing?: OneEuroOptions;
}

export interface ViewOptions { split: number; debugMasks: boolean }

const N = 468;
const FADE_SECONDS = 0.1;      // fade in/out instead of popping
const HOLD_FRAMES = 2;         // reuse last landmarks across short dropouts

/**
 * Frame-synchronous face filter.
 * process() runs the landmark model on the SAME frame it then paints, so the makeup can never trail
 * the face. Landmarks are never taken from a previous frame or an async callback.
 */
export class FaceFilterEngine {
  private params: FilterParams = structuredClone(DEFAULT_PARAMS);
  private view: ViewOptions = { split: 0, debugMasks: false };
  private smoother: LandmarkSmoother;
  private raw = new Float32Array(N * 3);
  private smoothed = new Float32Array(N * 3);
  private norm = new Float32Array(N * 3);
  private warpA = new Float32Array(MAX_WARPS * 4);
  private warpB = new Float32Array(MAX_WARPS * 2);
  private haveFace = false;
  private missing = 0;
  private fade = 0;
  private lastTs = -1;
  private lastFrameT = 0;
  private fpsEma = 0;
  private stats: FrameStats = { inferenceMs: 0, renderMs: 0, totalMs: 0, faceFound: false, fps: 0 };

  private constructor(private landmarker: FaceLandmarker, readonly renderer: GLRenderer, opts: EngineOptions) {
    this.smoother = new LandmarkSmoother(N, opts.smoothing ?? DEFAULT_ONE_EURO, LIP_LANDMARKS);
  }

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas, opts: EngineOptions): Promise<FaceFilterEngine> {
    const renderer = new GLRenderer(canvas);
    const vision = await FilesetResolver.forVisionTasks(opts.wasmBase);
    const make = (delegate: "GPU" | "CPU") =>
      FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: opts.modelUrl, delegate },
        runningMode: "VIDEO",                     // synchronous + tracking between frames
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    let landmarker: FaceLandmarker;
    try {
      landmarker = await make(opts.delegate ?? "GPU");
    } catch (e) {
      console.warn("GPU delegate failed, falling back to CPU", e);
      landmarker = await make("CPU");
    }
    await renderer.loadAtlas(opts.atlasUrl);
    return new FaceFilterEngine(landmarker, renderer, opts);
  }

  setParams(p: Partial<FilterParams>): void {
    this.params = {
      lips: { ...this.params.lips, ...p.lips },
      blush: { ...this.params.blush, ...p.blush },
      skin: { ...this.params.skin, ...p.skin },
      shape: { ...this.params.shape, ...p.shape },
      tone: { ...this.params.tone, ...p.tone },
    };
  }
  getParams(): FilterParams { return structuredClone(this.params); }
  setView(v: Partial<ViewOptions>): void { this.view = { ...this.view, ...v }; }
  getStats(): FrameStats { return this.stats; }

  /**
   * Process one camera frame. `source` must be a snapshot of a single frame (a VideoFrame is ideal)
   * so the model and the renderer see identical pixels.
   */
  process(source: TexImageSource, width: number, height: number, timestampMs: number): FrameStats {
    const t0 = performance.now();
    // MediaPipe requires strictly increasing timestamps in VIDEO mode
    const ts = timestampMs > this.lastTs ? timestampMs : this.lastTs + 1;
    this.lastTs = ts;

    // 1. landmarks for THIS frame (synchronous)
    const result = this.landmarker.detectForVideo(source, ts);
    const t1 = performance.now();

    // 2. upload the same frame
    this.renderer.uploadFrame(source, width, height);

    // 3. smooth + build geometry
    const lm = result.faceLandmarks[0];
    const tSec = ts / 1000;
    let geometry: FaceGeometry | null = null;
    if (lm && lm.length >= N) {
      for (let i = 0; i < N; i++) {
        this.raw[i * 3] = lm[i].x * width;
        this.raw[i * 3 + 1] = lm[i].y * height;
        this.raw[i * 3 + 2] = lm[i].z * width;
      }
      const iod = this.iod(this.raw);
      if (!this.haveFace || this.missing > HOLD_FRAMES) this.smoother.reset(); // no slide-in from an old position
      this.smoother.filter(this.raw, tSec, iod, this.smoothed);
      this.haveFace = true;
      this.missing = 0;
    } else if (this.haveFace) {
      this.missing++;
    }

    const present = this.haveFace && this.missing <= HOLD_FRAMES;
    const dt = this.lastFrameT ? Math.min((t0 - this.lastFrameT) / 1000, 0.2) : 1 / 30;
    this.fade = Math.min(1, Math.max(0, this.fade + (present ? 1 : -1) * dt / FADE_SECONDS));
    if (!present && this.fade === 0) this.haveFace = false;

    if (this.haveFace) geometry = this.geometry(width, height);

    // 4. paint
    this.renderer.render(this.params, geometry, { fade: this.fade, split: this.view.split, debugMasks: this.view.debugMasks, flipY: true });
    const t2 = performance.now();

    if (this.lastFrameT) {
      const inst = 1000 / Math.max(t0 - this.lastFrameT, 1);
      this.fpsEma = this.fpsEma ? this.fpsEma * 0.9 + inst * 0.1 : inst;
    }
    this.lastFrameT = t0;
    this.stats = { inferenceMs: t1 - t0, renderMs: t2 - t1, totalMs: t2 - t0, faceFound: present, fps: this.fpsEma };
    return this.stats;
  }

  destroy(): void {
    this.landmarker.close();
    this.renderer.destroy();
  }

  private iod(p: Float32Array): number {
    const [a, b] = GROUPS.eyeCorners;
    return Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1]);
  }

  private geometry(w: number, h: number): FaceGeometry {
    const s = this.smoothed, o = this.norm;
    for (let i = 0; i < N; i++) {
      o[i * 3] = s[i * 3] / w;
      o[i * 3 + 1] = s[i * 3 + 1] / h;
      o[i * 3 + 2] = s[i * 3 + 2] / w;
    }
    // skin reference: the cheek that faces the camera more (further from the nose tip in x)
    const nose = 4;
    const [cR, cL] = GROUPS.cheekSample;
    const dR = Math.abs(o[cR * 3] - o[nose * 3]), dL = Math.abs(o[cL * 3] - o[nose * 3]);
    const c = dR > dL ? cR : cL;
    const [l1, l2] = GROUPS.lowerLipBody;
    const iodPx = this.iod(s);
    return {
      warpA: this.warpA,
      warpB: this.warpB,
      warpCount: buildWarps(s, iodPx, this.params.shape, this.fade, this.warpA, this.warpB),
      points: o,
      skinRef: [o[c * 3], o[c * 3 + 1]],
      lipRef: [(o[l1 * 3] + o[l2 * 3]) / 2, (o[l1 * 3 + 1] + o[l2 * 3 + 1]) / 2],
      iodPx,
    };
  }
}
