import fs from "node:fs"; import { PNG } from "pngjs";
const load = (p) => PNG.sync.read(fs.readFileSync(p));
const ref = load("design/ne-surf-handoff/ui-reference.png"), bld = load("/tmp/build.png"), dif = load("/tmp/diff.png");
const regions = [["toolbar", 0, 168, 780, 256], ["timeline", 12, 272, 768, 408], ["layer card + callout 1", 16, 424, 780, 512], ["callout 2", 184, 1132, 580, 1180], ["legends", 24, 1388, 336, 1676], ["hotspot", 460, 1388, 764, 1676]];
const S = 2, gap = 8; let H = 0, W = 0;
for (const [, x0, y0, x1, y1] of regions) { H += (y1 - y0) * S + gap; W = Math.max(W, (x1 - x0) * S * 3 + gap * 2); }
const out = new PNG({ width: W, height: H }); out.data.fill(40);
let oy = 0;
for (const [, x0, y0, x1, y1] of regions) {
  [ref, bld, dif].forEach((img, k) => { const ox = k * ((x1 - x0) * S + gap);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.width + x) * 4;
      for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) { const o = ((oy + (y - y0) * S + dy) * W + ox + (x - x0) * S + dx) * 4; out.data[o] = img.data[i]; out.data[o+1] = img.data[i+1]; out.data[o+2] = img.data[i+2]; out.data[o+3] = 255; } } });
  oy += (y1 - y0) * S + gap;
}
fs.writeFileSync("/tmp/crops.png", PNG.sync.write(out)); console.log("wrote /tmp/crops.png", W, "x", H, "(reference | build | diff, 2x zoom)");
