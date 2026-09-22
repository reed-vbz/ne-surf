// Renders design/ne-surf-handoff/ui-reference.html at 390×844 @2x into ui-reference.png — the pixel-diff target.
//   node scripts/render-reference.mjs
// Run it whenever ui-reference.html changes (the HTML is the source of truth; the PNG is derived from it).
import path from "node:path";
import { chromium } from "playwright-core";
const exe = process.env.CHROME_PATH ?? "/Users/vbz/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const html = path.resolve("design/ne-surf-handoff/ui-reference.html");
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(`file://${html}`, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.resolve("design/ne-surf-handoff/ui-reference.png") });
await browser.close();
console.log("wrote design/ne-surf-handoff/ui-reference.png");
