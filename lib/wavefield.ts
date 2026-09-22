/**
 * Wave-field textures for the Rolling Wavefronts shader: index + one RGBA PNG per WW3 step, published by
 * workers/nesurf/wavefield.py (or served live by workers/pinn/api.py). The PNG is decoded with premultiplication and
 * colour conversion OFF so the data channels reach the GPU byte-exact.
 */
import { CACHE_BASE, loadJson } from "./cache";

export interface WavefieldStep { hour: number; valid_time: string; file: string; hs0_m: number; tp_s: number; dir_from_deg: number; omega: number; t_max_s: number }
export interface WavefieldIndex { cycle: string; bounds: [number, number, number, number]; shape: [number, number]; res_deg: number; encoding: { t_scale_s: number; h_max_m: number }; steps: WavefieldStep[] }
export interface Wavefield { image: ImageBitmap; bounds: [number, number, number, number]; omega: number; tScale: number; hMax: number; step: WavefieldStep }

/** Live PINN API when configured (NEXT_PUBLIC_PINN_API), else the published cache. */
const BASE = process.env.NEXT_PUBLIC_PINN_API ? process.env.NEXT_PUBLIC_PINN_API.replace(/\/$/, "") : `${CACHE_BASE}/wavefield`;
export const loadWavefieldIndex = () => loadJson<WavefieldIndex>(`${BASE}/index.json`);

const images = new Map<string, Promise<ImageBitmap | null>>();
export function loadWavefieldImage(file: string): Promise<ImageBitmap | null> {
  const url = `${BASE}/${file}`;
  if (!images.has(url)) images.set(url, fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? createImageBitmap(b, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" }) : null)).catch(() => null));
  return images.get(url)!;
}
