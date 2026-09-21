import type { Map as MLMap } from "maplibre-gl";
import type { VectorField } from "@/lib/overlays";

interface Particle { lon: number; lat: number; age: number; life: number }
export interface Ring { id: string; lon: number; lat: number; color: string; radius: number; dim: boolean }

/**
 * Canvas over the MapLibre container: wind streamlines (spec layer 2: 1 px cyan #64D5CC, 70 %, fading tails,
 * ocean only) and swell rings (spec layer 3: 6 concentric rings 12 px apart, 3 px stroke, opacity 18 % → 75 %
 * inward, expanding 12 px over 2 s, looping). Motion is delta-time based in screen pixels.
 */
export class FlowCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private field: VectorField | null = null;
  private particles: Particle[] = [];
  private raf = 0;
  private count = 1300;
  private rings: Ring[] = [];
  private t0 = performance.now();
  private last = performance.now();

  constructor(private map: MLMap) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    map.getContainer().appendChild(this.canvas);
    this.resize(); map.on("resize", this.resize); map.on("move", this.clear); this.loop();
  }
  private resize = () => { const c = this.map.getCanvas(); this.canvas.width = c.width; this.canvas.height = c.height; this.canvas.style.width = c.style.width; this.canvas.style.height = c.style.height; };
  private clear = () => { this.ctx?.setTransform(1, 0, 0, 1, 0, 0); this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height); };

  setRings(r: Ring[]) { this.rings = r; }
  setField(f: VectorField | null) { this.field = f; this.particles = []; if (f) for (let i = 0; i < this.count; i++) this.particles.push(this.spawn(true)); }

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
    this.drawRings(ctx);
    const f = this.field; if (!f) return;
    const pxPerDegLat = (256 * Math.pow(2, this.map.getZoom())) / 360;
    ctx.lineWidth = 1; ctx.lineCap = "round";
    for (let i = 0; i < this.particles.length; i++) {
      let p = this.particles[i]; const s = f.at(p.lat, p.lon);
      if (!s || p.age > p.life) { this.particles[i] = p = this.spawn(); continue; }
      const px = Math.min(44, 8 + 3 * s.speed) * dt;                       // wind speed → px/s
      const prev = this.map.project([p.lon, p.lat]);
      p.lat += (s.v * px) / pxPerDegLat; p.lon += (s.u * px) / (pxPerDegLat * Math.cos((p.lat * Math.PI) / 180)); p.age += dt;
      const cur = this.map.project([p.lon, p.lat]);
      if (cur.x < -20 || cur.y < -20 || cur.x > w + 20 || cur.y > h + 20) { this.particles[i] = this.spawn(); continue; }
      const fade = Math.min(1, Math.min(p.age, p.life - p.age) / 1.5);
      ctx.strokeStyle = `rgba(100,213,204,${0.7 * fade})`;
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
    }
  };

  private drawRings(ctx: CanvasRenderingContext2D) {
    const phase = ((performance.now() - this.t0) % 2000) / 2000;          // 2 s loop
    for (const r of this.rings) {
      const p = this.map.project([r.lon, r.lat]); const base = r.radius;
      ctx.lineWidth = 3;
      for (let k = 0; k < 6; k++) {
        const radius = base + k * 12 + phase * 12;
        const inward = 1 - k / 5;                                            // 75 % inner → 18 % outer
        const alpha = (0.18 + 0.57 * inward) * (1 - 0.5 * phase) * (r.dim ? 0.4 : 1);
        ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.strokeStyle = r.color; ctx.globalAlpha = alpha; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, base, 0, Math.PI * 2); ctx.fillStyle = r.color; ctx.globalAlpha = (r.dim ? 0.08 : 0.2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  destroy() { cancelAnimationFrame(this.raf); this.map.off("resize", this.resize); this.map.off("move", this.clear); this.canvas.remove(); }
}
