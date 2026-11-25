import { requireNativeModule } from "expo-modules-core";
import type { MediaStreamTrack } from "react-native-webrtc";

/** sRGB colour, each channel 0..1 */
export type RGB = [number, number, number];

export interface FilterParams {
  lips: { enabled: boolean; color: RGB; opacity: number; coverage: number; texture: number; gloss: number; refine: number };
  blush: { enabled: boolean; color: RGB; intensity: number };
  skin: { enabled: boolean; smooth: number; poreKeep: number; brighten: number };
}

export type PartialParams = { [K in keyof FilterParams]?: Partial<FilterParams[K]> };

export interface FilterStats { inferenceMs?: number; totalMs?: number; faceFound?: boolean; delegate?: string }

interface NativeFaceFilter {
  processorName: string;
  setParams(p: PartialParams): void;
  applyPreset(name: string): void;
  presetNames(): string[];
  setEnabled(on: boolean): void;
  getStats(): FilterStats;
}

const Native = requireNativeModule<NativeFaceFilter>("FaceFilter");

/** Turn the filter on for a LOCAL camera track. Preview and the remote peer get the same pixels. */
export function attachFaceFilter(track: MediaStreamTrack): void {
  (track as unknown as { _setVideoEffects(names: string[]): void })._setVideoEffects([Native.processorName]);
  Native.setEnabled(true);
}

/** Remove all effects from the track (zero cost afterwards). */
export function detachFaceFilter(track: MediaStreamTrack): void {
  (track as unknown as { _setVideoEffects(names: string[] | null): void })._setVideoEffects([]);
}

export const setFilterParams = (p: PartialParams) => Native.setParams(p);
export const applyPreset = (name: string) => Native.applyPreset(name);
export const presetNames = () => Native.presetNames();
/** Instant on/off without rebuilding the processor (e.g. a "beauty" toggle in the call UI). */
export const setFilterEnabled = (on: boolean) => Native.setEnabled(on);
export const getFilterStats = () => Native.getStats();

export const hex = (h: string): RGB => {
  const n = parseInt(h.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
