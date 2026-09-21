import type { Map as MLMap } from "maplibre-gl";
import type { VectorField } from "@/lib/overlays";
import { crestsAt, type RayField } from "@/lib/refraction";

interface Particle { lon: number; lat: number; age: number; life: number }
export interface CrestSet { id: string; field: RayField; color: string; dim: boolean }
type Ring = number[][];   // polygon rings: [[lon,lat], …]

/**
 * Screen-space canvas over the MapLibre container, clipped to WATER by the high-resolution land polygons
 * (Step 1): the clip path is rebuilt from the projected polygons whenever the view settles, so streamlines and
 * crest lines stop exactly at the shoreline. Draws
 *   • wind streamlines (Step 2): 1 px cyan #64D5CC at 80 % over a 3 px 18 % glow, delta-time motion in px/s
 *   • refraction crest lines (Step 3): wavefronts from the bathymetry ray field, advancing shoreward
 */
export class FlowCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private field: VectorField | null = null;
  private particles: Particle[] = [];
  private raf = 0;
  private count = 1300;
  private crests: CrestSet[] = [];
  private highlight: { a: [number, number]; b: [number, number]; color: string } | null = null;
  private landRings: Ring[] = [];
  private clip: Path2D | null = null;
  private t0 = performance.now();
  private last = performance.now();

  constructor(private map: MLMap) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    map.getContainer().appendChild(this.canvas);
    this.resize(); map.on("resize", this.resize); map.on("move", this.onMove); map.on("moveend", this.rebuildClip); this.loop();
  }
  private resize = () => { const c = this.map.getCanvas(); this.canvas.width = c.width; this.canvas.height = c.height; this.canvas.style.width = c.style.width; this.canvas.style.height = c.style.height; this.rebuildClip(); };
  private onMove = () => { this.clear(); this.clip = null; };
  private clear = () => { this.ctx?.setTransform(1, 0, 0, 1, 0, 0); this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height); };

  /** Land polygons (GeoJSON rings) → everything drawn here is clipped to their complement. */
  setLand(rings: Ring[]) { this.landRings = rings; this.rebuildClip(); }
  setCrests(c: CrestSet[]) { this.crests = c; }
  setHighlight(h: { a: [number, number]; b: [number, number]; color: string } | null) { this.highlight = h; }
  setField(f: VectorField | null) { this.field = f; this.particles = []; if (f) for (let i = 0; i < this.count; i++) this.particles.push(this.spawn(true)); }

  /** Water = canvas rectangle minus every land ring (even-odd). Rings entirely outside the view are skipped. */
  private rebuildClip = () => {
    if (!this.landRings.length) { this.clip = null; return; }
    const w = parseFloat(this.canvas.style.width) || this.canvas.width, h = parseFloat(this.canvas.style.height) || this.canvas.height;
    const b = this.map.getBounds(); const W = b.getWest() - 0.05, E = b.getEast() + 0.05, S = b.getSouth() - 0.05, N = b.getNorth() + 0.05;
    const path = new Path2D(); path.rect(-2, -2, w + 4, h + 4);
    for (const ring of this.landRings) {
      let inside = false;
      for (const [x, y] of ring as Array<[number, number]>) if (x >= W && x <= E && y >= S && y <= N) { inside = true; break; }
      if (!inside) continue;
      const p0 = this.map.project(ring[0] as [number, number]); path.moveTo(p0.x, p0.y);
      for (let i = 1; i < ring.length; i++) { const p = this.map.project(ring[i] as [number, number]); path.lineTo(p.x, p.y); }
      path.closePath();
    }
    this.clip = path;
  };

  private spawn(randomAge = false): Particle {
    const f = this.field!; const b = f.bounds; const vb = this.map.getBounds();
    const s = Math.max(vb.getSouth(), b.lat0), n = Math.min(vb.getNorth(), b.lat1), w = Math.max(vb.getWest(), b.lon0), e = Math.min(vb.getEast(), b.lon1);
    for (let t = 0; t < 25; t++) {
      const la = s + Math.random() * Math.max(0.01, n - s), lo = w + Math.random() * Math.max(0.01, e - w);
      if (f.at(la, lo)) { const life = 5 + Math.random() * 7; return { lon: lo, lat: la, age: randomAge ? Math.random() * life : 0, life }; }
    }
    return { lon: b.lon0, lat: b.lat0, age: 999, life: 1 };
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now(); const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    const ctx = this.ctx ?? (this.ctx = this.canvas.getContext("2d")!);
    const dpr = this.canvas.width / (parseFloat(this.canvas.style.width) || this.canvas.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    ctx.globalCompositeOperation = "destination-in"; ctx.fillStyle = `rgba(0,0,0,${Math.pow(0.1, dt)})`; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    ctx.save();
    if (this.clip) ctx.clip(this.clip, "evenodd");
    this.drawCrests(ctx, now);
    const f = this.field;
    if (f) {
      const pxPerDegLat = (256 * Math.pow(2, this.map.getZoom())) / 360;
      ctx.lineCap = "round";
      for (let i = 0; i < this.particles.length; i++) {
        let p = this.particles[i]; const s = f.at(p.lat, p.lon);
        if (!s || p.age > p.life) { this.particles[i] = p = this.spawn(); continue; }
        const px = Math.min(44, 8 + 3 * s.speed) * dt;
        const prev = this.map.project([p.lon, p.lat]);
        p.lat += (s.v * px) / pxPerDegLat; p.lon += (s.u * px) / (pxPerDegLat * Math.cos((p.lat * Math.PI) / 180)); p.age += dt;
        const cur = this.map.project([p.lon, p.lat]);
        if (cur.x < -20 || cur.y < -20 || cur.x > w + 20 || cur.y > h + 20) { this.particles[i] = this.spawn(); continue; }
        const fade = Math.min(1, Math.min(p.age, p.life - p.age) / 1.5);
        // glow pass + core pass: crisp cyan trails against the dark ocean
        ctx.lineWidth = 3; ctx.strokeStyle = `rgba(100,213,204,${0.18 * fade})`; ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
        ctx.lineWidth = 1; ctx.strokeStyle = `rgba(100,213,204,${0.8 * fade})`; ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
      }
    }
    ctx.restore();
    // hovered spot's ribbon segment (Step 4), drawn unclipped so it straddles the waterline
    if (this.highlight) {
      const pa = this.map.project(this.highlight.a), pb = this.map.project(this.highlight.b);
      ctx.lineCap = "round"; ctx.lineWidth = 10; ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.lineWidth = 5; ctx.strokeStyle = this.highlight.color; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
  };

  /** Wavefronts advance shoreward: one crest spacing (25 s of travel) per 2.5 s of wall time. */
  private drawCrests(ctx: CanvasRenderingContext2D, now: number) {
    const phase = (((now - this.t0) / 2500) % 1) * 25;
    for (const c of this.crests) {
      const crests = crestsAt(c.field, phase, 25);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const cr of crests) {
        const nearShore = cr.t / Math.max(1, c.field.tMax);            // 0 offshore → 1 at the beach
        const alpha = (0.25 + 0.6 * nearShore) * (c.dim ? 0.4 : 1);
        ctx.beginPath();
        cr.points.forEach(([lon, lat], i) => { const p = this.map.project([lon, lat]); if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.lineWidth = 4; ctx.strokeStyle = c.color; ctx.globalAlpha = alpha * 0.25; ctx.stroke();   // glow
        ctx.lineWidth = 1.5; ctx.globalAlpha = alpha; ctx.stroke();                                   // crest
      }
    }
    ctx.globalAlpha = 1;
  }

  destroy() { cancelAnimationFrame(this.raf); this.map.off("resize", this.resize); this.map.off("move", this.onMove); this.map.off("moveend", this.rebuildClip); this.canvas.remove(); }
}
