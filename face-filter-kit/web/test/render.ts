// Headless GPU test of the shared render graph with synthetic faces (no camera, no model).
import { GLRenderer, type FaceGeometry } from "../src/engine/GLRenderer";
import { DEFAULT_PARAMS, PRESETS, type FilterParams } from "../src/engine/types";
import { GROUPS } from "../src/engine/faceMeshData";

type Fixture = { width: number; height: number; landmarks: number[][] };
const canvas = document.getElementById("c") as HTMLCanvasElement;
const r = new GLRenderer(canvas);
const results: Record<string, unknown> = {};

function geometry(f: Fixture): FaceGeometry {
  const pts = new Float32Array(468 * 3);
  f.landmarks.forEach((p, i) => pts.set(p, i * 3));
  const g = (i: number): [number, number] => [pts[i * 3], pts[i * 3 + 1]];
  const [a, b] = GROUPS.eyeCorners;
  const iod = Math.hypot((pts[a * 3] - pts[b * 3]) * f.width, (pts[a * 3 + 1] - pts[b * 3 + 1]) * f.height);
  const nose = g(4), cR = g(205), cL = g(425);
  const skinRef = Math.abs(cR[0] - nose[0]) > Math.abs(cL[0] - nose[0]) ? cR : cL;
  const l1 = g(17), l2 = g(14);
  return { points: pts, skinRef, lipRef: [(l1[0] + l2[0]) / 2, (l1[1] + l2[1]) / 2], iodPx: iod };
}

function px(gl: WebGL2RenderingContext, x: number, y: number, H: number) {
  const o = new Uint8Array(4);
  gl.readPixels(Math.round(x), H - 1 - Math.round(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, o);
  return [o[0], o[1], o[2]];
}

async function run() {
  await r.loadAtlas("/makeup_atlas.png");
  const params: FilterParams = structuredClone(DEFAULT_PARAMS);
  Object.assign(params.lips, PRESETS.Berry.lips);
  Object.assign(params.blush, PRESETS.Berry.blush, { intensity: 0.5 });
  params.skin.smooth = 0.7;
  const gl = r.gl;
  for (const name of ["frontal", "yaw30", "mouth_open"]) {
    const fx: Fixture = await (await fetch(`/test/fixtures/${name}.json`)).json();
    const img = await createImageBitmap(await (await fetch(`/test/fixtures/${name}.png`)).blob());
    const W = fx.width, H = fx.height;
    const geo = geometry(fx);
    r.uploadFrame(img, W, H);

    // source pixels: render with filter off
    const off = structuredClone(params); off.lips.enabled = false; off.blush.enabled = false; off.skin.enabled = false;
    r.render(off, geo, { fade: 1, split: 0, debugMasks: false, flipY: true });
    const P = (i: number): [number, number] => [geo.points[i * 3] * W, geo.points[i * 3 + 1] * H];
    const lip = P(17).map((v, k) => (v + P(14)[k]) / 2) as [number, number];
    const up = P(13), lo = P(14);
    const teeth: [number, number] = [up[0], up[1] + (lo[1] - up[1]) * 0.25];
    const bg: [number, number] = [40, 40];
    const before = { lip: px(gl, ...lip, H), teeth: px(gl, ...teeth, H), bg: px(gl, ...bg, H) };

    r.render(params, geo, { fade: 1, split: 0, debugMasks: false, flipY: true });
    const after = { lip: px(gl, ...lip, H), teeth: px(gl, ...teeth, H), bg: px(gl, ...bg, H) };
    const filtered = canvas.toDataURL("image/png");
    r.render(params, geo, { fade: 1, split: 0, debugMasks: true, flipY: true });
    const masks = canvas.toDataURL("image/png");
    results[name] = { before, after, filtered, masks, glError: gl.getError() };
  }
  (window as unknown as { __results: unknown }).__results = results;
}
run().catch((e) => ((window as unknown as { __error: string }).__error = String(e?.stack ?? e)));
