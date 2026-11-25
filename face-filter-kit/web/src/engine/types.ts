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
}

export interface FilterParams {
  lips: LipParams;
  blush: BlushParams;
  skin: SkinParams;
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
  skin: { enabled: true, smooth: 0.5, poreKeep: 0.35, brighten: 0.25 },
};

/** Ready-made looks. Same JSON is used by the native modules. */
export const PRESETS: Record<string, { lips: Partial<LipParams>; blush: Partial<BlushParams> }> = {
  Natural: { lips: { color: hex("#c26a6e"), opacity: 0.45, coverage: 0.3, gloss: 0.25 }, blush: { color: hex("#f19a94"), intensity: 0.22 } },
  Rose:    { lips: { color: hex("#b8435a"), opacity: 0.75, coverage: 0.55, gloss: 0.35 }, blush: { color: hex("#f07a86"), intensity: 0.35 } },
  Berry:   { lips: { color: hex("#7d1f45"), opacity: 0.8, coverage: 0.7, gloss: 0.3 }, blush: { color: hex("#d9607e"), intensity: 0.3 } },
  Coral:   { lips: { color: hex("#e2574c"), opacity: 0.75, coverage: 0.55, gloss: 0.5 }, blush: { color: hex("#f6866a"), intensity: 0.35 } },
  Nude:    { lips: { color: hex("#b5776b"), opacity: 0.65, coverage: 0.6, gloss: 0.2 }, blush: { color: hex("#e89a86"), intensity: 0.25 } },
  Red:     { lips: { color: hex("#b0101e"), opacity: 0.85, coverage: 0.8, gloss: 0.4 }, blush: { color: hex("#ea6a74"), intensity: 0.25 } },
};
