import type { Map as MLMap } from "maplibre-gl";
import type { Flat, GridIndex, HrrrStep, Ww3Step } from "@/lib/cache";
import { ribbonColor, swellColor } from "@/lib/colors";
import { bilinearField, depthAt, type VectorField } from "@/lib/overlays";
import { ramp } from "@/lib/colors";

type Ring = number[][];
export interface RibbonSeg { id: number; a: [number, number]; b: [number, number]; m: [number, number]; n: number }

/**
 * Screen-space "field" canvas under the FlowCanvas: the swell-energy colormap (Step 2) evaluated per pixel at the
 * current zoom and clipped to water by the land polygons (Step 1), plus the coastal ribbon (Step 1) coloured by
 * wind-to-beach alignment. Redrawn when the view settles or the data changes; translated during drags.
 */
export class FieldCanvas {
  private canvas: HTMLCanvasElement;
  private landRings: Ring[] = [];
  private ribbon: RibbonSeg[] = [];
  private swell: { index: GridIndex; hs: Flat; tp: Flat } | null = null;
  private wind: VectorField | null = null;
  private anchor: { lng: number; lat: number; x: number; y: number } | null = null;
  private dirty = false;
  private raf = 0;
  ribbonColors = new Map<number, string>();   // seg id → hex, for hover tooltips
  mode: "energy" | "bathy" | "none" = "energy";

  constructor(private map: MLMap) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", pointerEvents: "none", opacity: "0.85" });
    map.getContainer().insertBefore(this.canvas, map.getContainer().firstChild!.nextSibling);
    this.resize(); map.on("resize", this.resize); map.on("move", this.onMove); map.on("moveend", this.redraw);
  }
  private resize = () => { const c = this.map.getCanvas(); this.canvas.width = Math.round(c.width / 2); this.canvas.height = Math.round(c.height / 2); this.canvas.style.width = c.style.width; this.canvas.style.height = c.style.height; this.redraw(); };
  /** keep the last frame glued to the map while panning; zooming just lets it scale until moveend */
  private onMove = () => {
    if (!this.anchor) return;
    const p = this.map.project([this.anchor.lng, this.anchor.lat]);
    this.canvas.style.transform = `translate(${p.x - this.anchor.x}px, ${p.y - this.anchor.y}px)`;
  };

  setLand(rings: Ring[]) { this.landRings = rings; this.redraw(); }
  setRibbon(segs: RibbonSeg[]) { this.ribbon = segs; this.redraw(); }
  setSwell(src: { index: GridIndex; step: Ww3Step } | null) { this.swell = src ? { index: src.index, hs: src.step.fields.hs, tp: src.step.fields.tp } : null; this.redraw(); }
  setWind(f: VectorField | null) { this.wind = f; this.redraw(); }

  redraw = () => { if (this.dirty) return; this.dirty = true; cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.paint); };

  private paint = () => {
    this.dirty = false;
    const ctx = this.canvas.getContext("2d")!; const W = this.canvas.width, H = this.canvas.height;
    const cssW = parseFloat(this.canvas.style.width) || W; const sx = W / cssW;   // canvas px per css px (0.5 dpr)
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    this.canvas.style.transform = ""; const c0 = this.map.getCenter(); const p0 = this.map.project(c0); this.anchor = { lng: c0.lng, lat: c0.lat, x: p0.x, y: p0.y };

    // 1. per-pixel ocean field (swell energy, or depth in refraction mode), clipped to water
    if ((this.mode === "energy" && this.swell) || this.mode === "bathy") {
      const hsF = this.swell ? bilinearField(this.swell.index, this.swell.hs) : null, tpF = this.swell ? bilinearField(this.swell.index, this.swell.tp) : null;
      const BATHY_STOPS: Array<[number, string]> = [[0, "#9ff0e8"], [0.25, "#64D5CC"], [0.5, "#4798B7"], [0.75, "#2B5BC7"], [1, "#163797"]];
      const img = ctx.createImageData(W, H); const d = img.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const ll = this.map.unproject([x / sx, y / sx]); let c: [number, number, number] | null = null;
        if (this.mode === "bathy") { const z = depthAt(ll.lat, ll.lng); if (z === null) continue; c = ramp(BATHY_STOPS, Math.log1p(z) / Math.log1p(300)); }
        else { const h = hsF!(ll.lat, ll.lng); if (h === null) continue; c = swellColor(h * 3.28084, tpF!(ll.lat, ll.lng) ?? 8); }
        const p = (y * W + x) * 4; d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
      }
      // put the field on a scratch canvas, then draw it through the water clip
      const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H; tmp.getContext("2d")!.putImageData(img, 0, 0);
      ctx.save(); ctx.setTransform(sx, 0, 0, sx, 0, 0);
      if (this.landRings.length) ctx.clip(this.waterPath(), "evenodd");
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(tmp, 0, 0); ctx.restore();
    }
    // 2. coastal ribbon, coloured by wind alignment (drawn unclipped, straddling the waterline)
    if (this.ribbon.length && this.wind) {
      ctx.setTransform(sx, 0, 0, sx, 0, 0); ctx.lineCap = "butt"; ctx.lineWidth = Math.max(2, Math.min(6, this.map.getZoom() - 6));
      const b = this.map.getBounds(); const Wb = b.getWest(), Eb = b.getEast(), Sb = b.getSouth(), Nb = b.getNorth();
      this.ribbonColors.clear();
      for (const s of this.ribbon) {
        if (s.m[0] < Wb || s.m[0] > Eb || s.m[1] < Sb || s.m[1] > Nb) continue;
        const w = this.wind.at(s.m[1], s.m[0]) ?? this.wind.at(s.m[1] + (Math.cos((s.n * Math.PI) / 180) * 1500) / 110540, s.m[0] + (Math.sin((s.n * Math.PI) / 180) * 1500) / (111320 * Math.cos((s.m[1] * Math.PI) / 180)));
        if (!w) continue;
        const toward = (Math.atan2(w.u, w.v) * 180) / Math.PI;
        const c = ribbonColor(toward, w.speed * 1.944, s.n); const hex = `rgb(${c[0]},${c[1]},${c[2]})`; this.ribbonColors.set(s.id, hex);
        const pa = this.map.project(s.a), pb = this.map.project(s.b);
        ctx.strokeStyle = hex; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }
    }
  };

  private waterPath(): Path2D {
    const w = parseFloat(this.canvas.style.width) || this.canvas.width, h = parseFloat(this.canvas.style.height) || this.canvas.height;
    const b = this.map.getBounds(); const W = b.getWest() - 0.05, E = b.getEast() + 0.05, S = b.getSouth() - 0.05, N = b.getNorth() + 0.05;
    const path = new Path2D(); path.rect(-2, -2, w + 4, h + 4);
    for (const ring of this.landRings) {
      let inside = false; for (const [x, y] of ring as Array<[number, number]>) if (x >= W && x <= E && y >= S && y <= N) { inside = true; break; }
      if (!inside) continue;
      const p0 = this.map.project(ring[0] as [number, number]); path.moveTo(p0.x, p0.y);
      for (let i = 1; i < ring.length; i++) { const p = this.map.project(ring[i] as [number, number]); path.lineTo(p.x, p.y); }
      path.closePath();
    }
    return path;
  }

  destroy() { cancelAnimationFrame(this.raf); this.map.off("resize", this.resize); this.map.off("move", this.onMove); this.map.off("moveend", this.redraw); this.canvas.remove(); }
}
