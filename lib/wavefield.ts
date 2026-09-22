/**
 * Wave-field textures for the Rolling Wavefronts shader: index + one RGBA PNG per WW3 step, published by
 * workers/nesurf/wavefield.py (or served live by workers/pinn/api.py). The PNG is decoded with premultiplication and
 * colour conversion OFF so the data channels reach the GPU byte-exact.
 */
import { CACHE_BASE, loadJson } from "./cache";

export interface WavefieldStep { hour: number; valid_time: string; file: string; hs0_m: number; tp_s: number; dir_from_deg: number; omega: number; t_max_s: number }
export interface WavefieldIndex { cycle: string; solver_version?: number; bounds: [number, number, number, number]; shape: [number, number]; res_deg: number; encoding: { t_scale_s: number; h_max_m: number; geometry?: { file: string; sdf_offset_m: number; depth_scale_m: number } }; steps: WavefieldStep[] }
export interface Wavefield { image: ImageBitmap; geometry: ImageBitmap | null; bounds: [number, number, number, number]; omega: number; tScale: number; hMax: number; step: WavefieldStep }

/** Live PINN API when configured (NEXT_PUBLIC_PINN_API), else the published cache. */
const liveBase = process.env.NEXT_PUBLIC_PINN_API?.replace(/\/$/, "");
const fieldBase = (base: string) => liveBase ?? `${base}/wavefield`;
export const loadWavefieldIndex = (base = CACHE_BASE) => loadJson<WavefieldIndex>(`${fieldBase(base)}/index.json`);
const images = new Map<string, Promise<ImageBitmap | null>>();
export function loadWavefieldImage(file: string, base = CACHE_BASE, cycle?: string): Promise<ImageBitmap | null> {
  if (!/^(?:f\d+|geometry)\.png$/.test(file)) return Promise.resolve(null);
  const url = `${fieldBase(base)}/${file}${liveBase && cycle ? `?cycle=${encodeURIComponent(cycle)}` : ""}`;
  if (!images.has(url)) {
    const promise = fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(20000) }).then((r) => r.ok ? r.blob() : null)
      .then((b) => b ? createImageBitmap(b, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" }) : null)
      .catch(() => null).then((image) => { if (!image) images.delete(url); return image; });
    images.set(url, promise);
    if (images.size > 16) images.delete(images.keys().next().value!);
  }
  return images.get(url)!;
}
