import type { Map as MLMap } from "maplibre-gl";
import type { Flat, GridIndex } from "@/lib/cache";
import { cellIndex, toUV } from "@/lib/grid";
import { swellQualityColor } from "@/lib/overlays";

interface Field { index: GridIndex; hs: Flat; dp: Flat; quality: Flat }
interface Particle { lon: number; lat: number; age: number; life: number }
export interface Ring { lon: number; lat: number; color: string; strength: number }

/**
 * Animated swell-direction streamlines (and pulsing hotspot rings) on a canvas overlaid on the MapLibre container.
 * Particles move in SCREEN pixels per second (delta-time based, so speed is the same at any frame rate or zoom),
 * along the swell direction (WW3 DIRPW is "from", so travel is dp+180). Drawing here instead of through MapLibre
 * paint properties keeps the style untouched, so the map still reaches `idle`.
 */
export class SwellParticles {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private field: Field | null = null;
  private particles: Particle[] = [];
  private raf = 0;
  private count = 900;
  private rings: Ring[] = [];
  private t0 = performance.now();
  private last = performance.now();

  constructor(private map: MLMap) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    map.getContainer().appendChild(this.canvas);
    this.resize();
    map.on("resize", this.resize);
    map.on("move", this.clear);      // trails would smear while panning/zooming
    this.loop();
  }

  private resize = () => {
    const c = this.map.getCanvas();
    this.canvas.width = c.width; this.canvas.height = c.height;
    this.canvas.style.width = c.style.width; this.canvas.style.height = c.style.height;
  };
  private clear = () => { this.ctx?.setTransform(1, 0, 0, 1, 0, 0); this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height); };

  setRings(r: Ring[]) { this.rings = r; }

  setField(f: Field | null) {
    this.field = f;
    this.particles = [];
    if (f) for (let i = 0; i < this.count; i++) this.particles.push(this.spawn(f, true));
  }

  private spawn(f: Field, randomAge = false): Particle {
    const { lat, lon } = f.index;
    for (let tries = 0; tries < 20; tries++) {
      const la = lat[0] + Math.random() * (lat[lat.length - 1] - lat[0]);
      const lo = lon[0] + Math.random() * (lon[lon.length - 1] - lon[0]);
      const k = cellIndex(f.index, la, lo);
      if (k !== null && f.hs[k] != null) {
        const life = 5 + Math.random() * 6;       // seconds
        return { lon: lo, lat: la, age: randomAge ? Math.random() * life : 0, life };
      }
    }
    return { lon: lon[0], lat: lat[0], age: 999, life: 1 };
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;   // cap: tab switches must not teleport particles
    const ctx = this.ctx ?? (this.ctx = this.canvas.getContext("2d")!);
    const dpr = this.canvas.width / (parseFloat(this.canvas.style.width) || this.canvas.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    // fade previous frame (time-based so trail length is frame-rate independent)
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = `rgba(0,0,0,${Math.pow(0.08, dt)})`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    this.drawRings(ctx);
    const f = this.field; if (!f) return;

    // screen-space speed: 22–46 px/s depending on height; convert to degrees at this zoom/latitude
    const pxPerDegLat = (256 * Math.pow(2, this.map.getZoom())) / 360;
    ctx.lineWidth = 1.8; ctx.lineCap = "round";
    for (let i = 0; i < this.particles.length; i++) {
      let p = this.particles[i];
      const k = cellIndex(f.index, p.lat, p.lon);
      const hs = k === null ? null : f.hs[k], dp = k === null ? null : f.dp[k];
      if (hs == null || dp == null || p.age > p.life) { this.particles[i] = p = this.spawn(f); continue; }
      const pxPerSec = 22 + 24 * Math.min(1, hs / 3);
      const { u, v } = toUV(pxPerSec * dt, dp);                         // toward, in px
      const prev = this.map.project([p.lon, p.lat]);
      p.lat += v / pxPerDegLat;
      p.lon += u / (pxPerDegLat * Math.cos((p.lat * Math.PI) / 180));
      p.age += dt;
      const cur = this.map.project([p.lon, p.lat]);
      if (cur.x < -20 || cur.y < -20 || cur.x > w + 20 || cur.y > h + 20) { this.particles[i] = this.spawn(f); continue; }
      const alpha = Math.min(1, Math.min(p.age, p.life - p.age) / 1.2) * 0.9;
      const c = swellQualityColor(f.quality[k!] ?? 0.5);
      ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
    }
  };

  /** Three staggered expanding rings per hotspot, 2.4 s cycle, amplitude by `strength` (0..1). */
  private drawRings(ctx: CanvasRenderingContext2D) {
    const t = (performance.now() - this.t0) / 2400;
    ctx.lineWidth = 2;
    for (const r of this.rings) {
      const p = this.map.project([r.lon, r.lat]);
      for (let k = 0; k < 3; k++) {
        const phase = (t + k / 3) % 1;
        const radius = 10 + phase * (18 + 30 * r.strength);
        ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = r.color; ctx.globalAlpha = 0.85 * (1 - phase) * (0.35 + 0.65 * r.strength); ctx.stroke();
        ctx.fillStyle = r.color; ctx.globalAlpha = 0.10 * (1 - phase) * r.strength; ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  destroy() { cancelAnimationFrame(this.raf); this.map.off("resize", this.resize); this.map.off("move", this.clear); this.canvas.remove(); }
}
