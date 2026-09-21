import type { Map as MLMap } from "maplibre-gl";
import type { GridIndex, Ww3Step } from "@/lib/cache";
import { swellVectorField } from "@/lib/overlays";

interface Particle { lon: number; lat: number; age: number; life: number }
export interface Ring { lon: number; lat: number; color: string; strength: number }

/**
 * Thin, smooth swell streamlines and glowing hotspot rings on a canvas over the MapLibre container.
 * Direction comes from a bilinear vector field (no per-cell kinks), motion is in screen pixels per second
 * (frame-rate and zoom independent), and lines end at the 1 km shoreline mask.
 */
export class SwellParticles {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private field: ReturnType<typeof swellVectorField> | null = null;
  private particles: Particle[] = [];
  private raf = 0;
  private count = 1400;
  private rings: Ring[] = [];
  private t0 = performance.now();
  private last = performance.now();

  constructor(private map: MLMap) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    map.getContainer().appendChild(this.canvas);
    this.resize();
    map.on("resize", this.resize);
    map.on("move", this.clear);
    this.loop();
  }

  private resize = () => {
    const c = this.map.getCanvas();
    this.canvas.width = c.width; this.canvas.height = c.height;
    this.canvas.style.width = c.style.width; this.canvas.style.height = c.style.height;
  };
  private clear = () => { this.ctx?.setTransform(1, 0, 0, 1, 0, 0); this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height); };

  setRings(r: Ring[]) { this.rings = r; }

  setField(src: { index: GridIndex; step: Ww3Step } | null) {
    this.field = src ? swellVectorField(src.index, src.step) : null;
    this.particles = [];
    if (this.field) for (let i = 0; i < this.count; i++) this.particles.push(this.spawn(true));
  }

  private spawn(randomAge = false): Particle {
    const f = this.field!; const b = f.bounds;
    // spawn inside the current view when possible so density follows the viewport
    const vb = this.map.getBounds();
    const s = vb.getSouth() > b.lat0 ? vb.getSouth() : b.lat0, n = vb.getNorth() < b.lat1 ? vb.getNorth() : b.lat1;
    const w = vb.getWest() > b.lon0 ? vb.getWest() : b.lon0, e = vb.getEast() < b.lon1 ? vb.getEast() : b.lon1;
    for (let tries = 0; tries < 25; tries++) {
      const la = s + Math.random() * Math.max(0.01, n - s), lo = w + Math.random() * Math.max(0.01, e - w);
      if (f.at(la, lo)) { const life = 6 + Math.random() * 8; return { lon: lo, lat: la, age: randomAge ? Math.random() * life : 0, life }; }
    }
    return { lon: b.lon0, lat: b.lat0, age: 999, life: 1 };
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    const ctx = this.ctx ?? (this.ctx = this.canvas.getContext("2d")!);
    const dpr = this.canvas.width / (parseFloat(this.canvas.style.width) || this.canvas.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = `rgba(0,0,0,${Math.pow(0.12, dt)})`;      // long, soft trails
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    this.drawRings(ctx);
    const f = this.field; if (!f) return;

    const pxPerDegLat = (256 * Math.pow(2, this.map.getZoom())) / 360;
    ctx.lineWidth = 1.1; ctx.lineCap = "round";
    for (let i = 0; i < this.particles.length; i++) {
      let p = this.particles[i];
      const s = f.at(p.lat, p.lon);
      if (!s || p.age > p.life) { this.particles[i] = p = this.spawn(); continue; }
      const pxPerSec = 14 + 10 * Math.min(1, s.hs / 3);          // slow, steady
      const prev = this.map.project([p.lon, p.lat]);
      p.lat += (s.v * pxPerSec * dt) / pxPerDegLat;
      p.lon += (s.u * pxPerSec * dt) / (pxPerDegLat * Math.cos((p.lat * Math.PI) / 180));
      p.age += dt;
      const cur = this.map.project([p.lon, p.lat]);
      if (cur.x < -20 || cur.y < -20 || cur.x > w + 20 || cur.y > h + 20) { this.particles[i] = this.spawn(); continue; }
      const fade = Math.min(1, Math.min(p.age, p.life - p.age) / 1.5);
      const alpha = fade * (0.35 + 0.45 * Math.min(1, s.hs / 2.5));  // bigger swell = brighter line
      ctx.strokeStyle = `rgba(214,244,255,${alpha})`;
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
    }
  };

  /** Glowing concentric rings (three, staggered, 3 s cycle); only spots with strength > 0 get them. */
  private drawRings(ctx: CanvasRenderingContext2D) {
    const t = (performance.now() - this.t0) / 3000;
    for (const r of this.rings) {
      if (r.strength <= 0) continue;
      const p = this.map.project([r.lon, r.lat]);
      ctx.shadowColor = r.color; ctx.shadowBlur = 10;
      for (let k = 0; k < 3; k++) {
        const phase = (t + k / 3) % 1;
        const radius = 12 + phase * (22 + 26 * r.strength);
        ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.lineWidth = 2.2 - 1.2 * phase;
        ctx.strokeStyle = r.color; ctx.globalAlpha = 0.9 * (1 - phase) * (0.4 + 0.6 * r.strength); ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(p.x, p.y, 34 * r.strength, 0, Math.PI * 2);
      ctx.fillStyle = r.color; ctx.globalAlpha = 0.14 * r.strength; ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }

  destroy() { cancelAnimationFrame(this.raf); this.map.off("resize", this.resize); this.map.off("move", this.clear); this.canvas.remove(); }
}
