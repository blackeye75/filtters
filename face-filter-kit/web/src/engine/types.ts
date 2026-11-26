import type { ShapeParams } from "./warp";
export type { ShapeParams } from "./warp";

export type RGB = [number, number, number]; // sRGB, 0..1

export interface LipParams {
  enabled: boolean;
  color: RGB;
  opacity: number;   // 0..1 overall strength
  coverage: number;  // 0 sheer tint .. 1 full coverage
  texture: number;   // 0..1 natural lip texture kept
  gloss: number;     // 0..1
  refine: number;    // 0..1 snap to real lip edge by colour
}

export interface BlushParams {
  enabled: boolean;
  color: RGB;
  intensity: number; // 0..1
}

export interface SkinParams {
  enabled: boolean;
  smooth: number;    // 0..1
  poreKeep: number;  // 0..1
  brighten: number;  // 0..1
  tan: number;       // 0..1 warm bronze on skin tones
}

/** Whole-picture colour grade. 0 everywhere = untouched. */
export interface ToneParams {
  enabled: boolean;
  warmth: number;     // -1 cool .. 1 warm
  saturation: number; // -1..1
  contrast: number;   // -1 matte/faded .. 1 punchy
  brightness: number; // -1..1
  glow: number;       // 0..1 soft dreamy bloom
  vignette: number;   // 0..1
  sharpen: number;    // 0..1 crisper eyes, brows, hair
}

export interface FilterParams {
  lips: LipParams;
  blush: BlushParams;
  skin: SkinParams;
  shape: ShapeParams;
  tone: ToneParams;
}

export interface FrameStats {
  inferenceMs: number;
  renderMs: number;
  totalMs: number;
  faceFound: boolean;
  fps: number;
}

export const hex = (h: string): RGB => {
  const n = parseInt(h.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const toHex = (c: RGB): string =>
  "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

export const DEFAULT_PARAMS: FilterParams = {
  lips: { enabled: true, color: hex("#b8435a"), opacity: 0.75, coverage: 0.55, texture: 0.85, gloss: 0.35, refine: 0.7 },
  blush: { enabled: true, color: hex("#f07a86"), intensity: 0.35 },
  skin: { enabled: true, smooth: 0.5, poreKeep: 0.35, brighten: 0.25, tan: 0 },
  shape: { enabled: true, faceSlim: 0, vLine: 0, chin: 0, noseSlim: 0, eyes: 0, lipPlump: 0 },
  tone: { enabled: true, warmth: 0, saturation: 0, contrast: 0, brightness: 0, glow: 0, vignette: 0, sharpen: 0 },
};

export type Preset = { [K in keyof FilterParams]?: Partial<FilterParams[K]> };

/** A preset is a full look: anything it leaves out falls back to DEFAULT_PARAMS. */
export function presetParams(p: Preset): FilterParams {
  const d = structuredClone(DEFAULT_PARAMS);
  return {
    lips: { ...d.lips, ...p.lips }, blush: { ...d.blush, ...p.blush }, skin: { ...d.skin, ...p.skin },
    shape: { ...d.shape, ...p.shape }, tone: { ...d.tone, ...p.tone },
  };
}

/** Ready-made looks. shared/presets.json mirrors this (native modules read lips/blush/skin from it). */
export const PRESETS: Record<string, Preset> = {
  Natural: { lips: { color: hex("#c26a6e"), opacity: 0.45, coverage: 0.3, gloss: 0.25 }, blush: { color: hex("#f19a94"), intensity: 0.22 } },
  Rose:    { lips: { color: hex("#b8435a"), opacity: 0.75, coverage: 0.55, gloss: 0.35 }, blush: { color: hex("#f07a86"), intensity: 0.35 } },
  Berry:   { lips: { color: hex("#7d1f45"), opacity: 0.8, coverage: 0.7, gloss: 0.3 }, blush: { color: hex("#d9607e"), intensity: 0.3 } },
  Coral:   { lips: { color: hex("#e2574c"), opacity: 0.75, coverage: 0.55, gloss: 0.5 }, blush: { color: hex("#f6866a"), intensity: 0.35 } },
  Nude:    { lips: { color: hex("#b5776b"), opacity: 0.65, coverage: 0.6, gloss: 0.2 }, blush: { color: hex("#e89a86"), intensity: 0.25 } },
  Red:     { lips: { color: hex("#b0101e"), opacity: 0.85, coverage: 0.8, gloss: 0.4 }, blush: { color: hex("#ea6a74"), intensity: 0.25 } },

  // Full looks: makeup + face shape + colour grade.
  Sunkissed: { // warm summer glow: bronzed skin, peachy flush, glossy lips, soft slim
    lips: { color: hex("#d4625f"), opacity: 0.6, coverage: 0.4, gloss: 0.8 },
    blush: { color: hex("#f2805f"), intensity: 0.45 },
    skin: { smooth: 0.55, poreKeep: 0.4, brighten: 0.2, tan: 0.35 },
    shape: { faceSlim: 0.35, vLine: 0.25, noseSlim: 0.3, eyes: 0.2, lipPlump: 0.15 },
    tone: { warmth: 0.45, saturation: 0.15, contrast: 0.1, brightness: 0.05, glow: 0.35, vignette: 0.2 },
  },
  "Golden Hour": { // late-sun light: very warm, hazy, low contrast
    lips: { color: hex("#c8665a"), opacity: 0.5, coverage: 0.35, gloss: 0.6 },
    blush: { color: hex("#f39a6e"), intensity: 0.35 },
    skin: { smooth: 0.5, brighten: 0.3, tan: 0.2 },
    shape: { faceSlim: 0.2, eyes: 0.15 },
    tone: { warmth: 0.7, saturation: 0.1, contrast: -0.15, brightness: 0.1, glow: 0.55, vignette: 0.3 },
  },
  "Soft Glam": { // pink, polished, slimmer face and brighter eyes
    lips: { color: hex("#c0566e"), opacity: 0.7, coverage: 0.55, gloss: 0.55 },
    blush: { color: hex("#f08a9a"), intensity: 0.4 },
    skin: { smooth: 0.65, poreKeep: 0.3, brighten: 0.35 },
    shape: { faceSlim: 0.4, vLine: 0.35, chin: 0.15, noseSlim: 0.35, eyes: 0.3, lipPlump: 0.2 },
    tone: { warmth: 0.1, saturation: 0.05, glow: 0.25, sharpen: 0.2 },
  },
  Doll: { // big eyes, small nose, rosy cheeks, high gloss
    lips: { color: hex("#e0607a"), opacity: 0.75, coverage: 0.6, gloss: 0.9 },
    blush: { color: hex("#ff8fa3"), intensity: 0.6 },
    skin: { smooth: 0.75, poreKeep: 0.2, brighten: 0.45 },
    shape: { faceSlim: 0.5, vLine: 0.4, chin: -0.2, noseSlim: 0.55, eyes: 0.6, lipPlump: 0.25 },
    tone: { warmth: -0.05, saturation: 0.1, brightness: 0.1, glow: 0.3 },
  },
  "Clean Girl": { // barely-there: glossy nude lips, light flush, crisp detail
    lips: { color: hex("#b97a70"), opacity: 0.5, coverage: 0.3, gloss: 0.75 },
    blush: { color: hex("#eea08e"), intensity: 0.2 },
    skin: { smooth: 0.4, poreKeep: 0.5, brighten: 0.2 },
    shape: { faceSlim: 0.15, noseSlim: 0.15 },
    tone: { warmth: 0.1, contrast: 0.1, sharpen: 0.35 },
  },
  Sculpt: { // contoured: V-line jaw, slim nose, bronze, punchy contrast
    lips: { color: hex("#a85a55"), opacity: 0.65, coverage: 0.6, gloss: 0.3 },
    blush: { color: hex("#d77d6a"), intensity: 0.3 },
    skin: { smooth: 0.5, brighten: 0.15, tan: 0.25 },
    shape: { faceSlim: 0.5, vLine: 0.6, chin: 0.2, noseSlim: 0.45, eyes: 0.15 },
    tone: { warmth: 0.15, saturation: 0.05, contrast: 0.2, sharpen: 0.3, vignette: 0.25 },
  },
};
