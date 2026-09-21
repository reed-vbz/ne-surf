import type { Map as MLMap } from "maplibre-gl";
import type { Flat, GridIndex } from "@/lib/cache";
import { cellIndex, toUV } from "@/lib/grid";

interface Field { index: GridIndex; hs: Flat; dp: Flat }
interface Particle { lon: number; lat: number; age: number; life: number; trail: Array<[number, number]> }

/**
 * Animated swell-direction particles on a canvas overlaid on the MapLibre container.
 * Particles are advected in lon/lat by the swell direction (WW3 DIRPW is "from", so travel is dp+180),
 * with speed ∝ Hs, and drawn with short fading trails. Cheap: ~1,200 particles, one rAF loop.
 */
export class SwellParticles {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private field: Field | null = null;
  private particles: Particle[] = [];
  private raf = 0;
  private count = 1200;

  constructor(private map: MLMap) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    map.getContainer().appendChild(this.canvas);
    this.resize();
    map.on("resize", this.resize);
    this.loop();
  }

  private resize = () => {
    const c = this.map.getCanvas();
    this.canvas.width = c.width; this.canvas.height = c.height;
    this.canvas.style.width = c.style.width; this.canvas.style.height = c.style.height;
  };

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
        const life = 60 + Math.random() * 90;
        return { lon: lo, lat: la, age: randomAge ? Math.random() * life : 0, life, trail: [] };
      }
    }
    return { lon: lon[0], lat: lat[0], age: 999, life: 1, trail: [] };
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const ctx = this.ctx ?? (this.ctx = this.canvas.getContext("2d")!);
    const dpr = this.canvas.width / (parseFloat(this.canvas.style.width) || this.canvas.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // fade previous frame
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0,0,0,0.9)";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalCompositeOperation = "source-over";
    const f = this.field; if (!f) { ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); return; }

    const zoomScale = 0.02 / Math.pow(2, this.map.getZoom() - 7); // deg per frame at hs = 1 m, zoom 7
    ctx.lineWidth = 1.4; ctx.lineCap = "round";
    for (let i = 0; i < this.particles.length; i++) {
      let p = this.particles[i];
      const k = cellIndex(f.index, p.lat, p.lon);
      const hs = k === null ? null : f.hs[k], dp = k === null ? null : f.dp[k];
      if (hs == null || dp == null || p.age > p.life) { this.particles[i] = p = this.spawn(f); continue; }
      const { u, v } = toUV(Math.min(3, 0.4 + hs), dp); // toward
      const prev = this.map.project([p.lon, p.lat]);
      p.lon += u * zoomScale; p.lat += v * zoomScale; p.age += 1;
      const cur = this.map.project([p.lon, p.lat]);
      const alpha = Math.min(1, Math.min(p.age, p.life - p.age) / 15) * 0.85;
      // colour by height: small = white-blue, big = deep blue
      const t = Math.min(1, hs / 3);
      ctx.strokeStyle = `rgba(${Math.round(90 - 60 * t)},${Math.round(150 - 90 * t)},${Math.round(255 - 60 * t)},${alpha})`;
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
    }
  };

  destroy() { cancelAnimationFrame(this.raf); this.map.off("resize", this.resize); this.canvas.remove(); }
}
