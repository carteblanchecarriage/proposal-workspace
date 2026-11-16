// Makes the site's link-preview image (public/og-image.png, 1200×630) and home-screen icon
// (public/apple-touch-icon.png, 180×180) by rendering small HTML pages in a headless browser.
// Re-run after changing the wording or look:  node scripts/make-site-images.mjs
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const inter = readFileSync(new URL("../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", import.meta.url)).toString("base64");
const font = `@font-face { font-family: Inter; src: url(data:font/woff2;base64,${inter}) format("woff2"); font-weight: 100 900; }`;

const og = `<!doctype html><html><head><style>${font}
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; background: #fff; color: #111; font-family: Inter, sans-serif; padding: 64px 72px; display: flex; flex-direction: column; }
  .eyebrow { font-size: 24px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #2f5bd3; }
  h1 { font-size: 132px; font-weight: 800; letter-spacing: -0.035em; line-height: .95; margin-top: 28px; }
  .bottom { margin-top: auto; display: flex; justify-content: space-between; align-items: flex-end; border-top: 3px solid #111; padding-top: 22px; }
  .line { font-size: 30px; line-height: 1.3; max-width: 760px; }
  .mark { font-size: 26px; font-weight: 700; white-space: nowrap; }
</style></head><body>
  <div class="eyebrow">For architecture firms</div>
  <h1>Really Fast<br>Proposals.</h1>
  <div class="bottom"><div class="line">Level consultant fees, read the RFP, build your fee and schedule.</div><div class="mark">Proposal Workspace</div></div>
</body></html>`;

const icon = `<!doctype html><html><head><style>${font}
  * { margin: 0; }
  body { width: 180px; height: 180px; background: #111; position: relative; font-family: Inter, sans-serif; }
  b { position: absolute; left: 40px; top: 12px; font-size: 140px; font-weight: 800; color: #fff; line-height: 1; }
  i { position: absolute; left: 130px; top: 116px; width: 28px; height: 28px; border-radius: 50%; background: #2f5bd3; }
</style></head><body><b>P</b><i></i></body></html>`;

const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
const page = await browser.newPage();
for (const [html, w, h, file] of [[og, 1200, 630, "public/og-image.png"], [icon, 180, 180, "public/apple-touch-icon.png"]]) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } });
  console.log("wrote", file);
}
await browser.close();
