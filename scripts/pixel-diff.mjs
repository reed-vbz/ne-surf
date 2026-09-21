// Renders the app at 390×844 @2x and pixel-diffs it against design/ne-surf-handoff/ui-reference.png.
//   node scripts/pixel-diff.mjs [url]      (default http://localhost:3000/)
// Writes /tmp/build.png and /tmp/diff.png, prints the mismatch count. pixelmatch threshold 0.1.
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:3000/";
const ref = path.resolve("design/ne-surf-handoff/ui-reference.png");
const exe = process.env.CHROME_PATH ?? "/Users/vbz/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/build.png" });
await browser.close();

const a = PNG.sync.read(fs.readFileSync("/tmp/build.png"));
const b = PNG.sync.read(fs.readFileSync(ref));
if (a.width !== b.width || a.height !== b.height) { console.error(`size mismatch: build ${a.width}x${a.height} vs ref ${b.width}x${b.height}`); process.exit(2); }
const diff = new PNG({ width: a.width, height: a.height });
const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1, includeAA: false, diffColor: [255, 0, 255], alpha: 0.35 });
fs.writeFileSync("/tmp/diff.png", PNG.sync.write(diff));
// where are the differences? coarse 39×42 grid (10px cells at 1x) so the biggest region is easy to find
const cell = 20, cols = Math.ceil(a.width / cell), rows = Math.ceil(a.height / cell), grid = new Uint32Array(cols * rows);
for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) { const i = (y * a.width + x) * 4; if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 255) grid[Math.floor(y / cell) * cols + Math.floor(x / cell)]++; }
const top = [...grid].map((v, i) => [v, i]).filter(([v]) => v > 0).sort((p, q) => q[0] - p[0]).slice(0, 8)
  .map(([v, i]) => `  (${(i % cols) * cell / 2},${Math.floor(i / cols) * cell / 2}) 1x-px cell: ${v}`);
console.log(`mismatch: ${n} of ${a.width * a.height} px (${(100 * n / (a.width * a.height)).toFixed(2)}%)`);
console.log("worst 10×10 (1x) cells [x,y]:\n" + top.join("\n"));
