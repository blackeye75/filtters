// Headless render test: node test/render-test.mjs  (needs Chrome; set CHROME=/path/to/chrome)
import { createServer } from "vite";
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const server = await createServer({ server: { port: 5199 }, logLevel: "error" });
await server.listen();
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage();
  page.on("console", (m) => console.log("[page]", m.text()));
  await page.goto("http://localhost:5199/test/render.html");
  await page.waitForFunction("window.__results || window.__error", { timeout: 120000 });
  const err = await page.evaluate("window.__error");
  if (err) throw new Error(err);
  const res = await page.evaluate("window.__results");
  mkdirSync("test/out", { recursive: true });
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (const [name, r] of Object.entries(res)) {
    writeFileSync(`test/out/${name}_filtered.png`, Buffer.from(r.filtered.split(",")[1], "base64"));
    writeFileSync(`test/out/${name}_masks.png`, Buffer.from(r.masks.split(",")[1], "base64"));
    for (const [look, url] of Object.entries(r.looks)) writeFileSync(`test/out/${name}_${look.replace(" ", "_")}.png`, Buffer.from(url.split(",")[1], "base64"));
    const lipShift = dist(r.before.lip, r.after.lip), teethShift = dist(r.before.teeth, r.after.teeth), bgShift = dist(r.before.bg, r.after.bg);
    console.log(`${name.padEnd(11)} lip ${JSON.stringify(r.before.lip)} -> ${JSON.stringify(r.after.lip)} (Δ${lipShift.toFixed(0)})  teeth Δ${teethShift.toFixed(1)}  background Δ${bgShift.toFixed(1)}  glError ${r.glError}`);
    assert.equal(r.glError, 0, `${name}: GL error`);
    assert.ok(lipShift > 20, `${name}: lips should be recoloured`);
    assert.ok(bgShift < 1.5, `${name}: background must be untouched`);
    if (name === "mouth_open") assert.ok(teethShift < 6, `${name}: teeth must not be painted`);
  }
  console.log("render test passed; images in test/out/");
} finally {
  await browser.close();
  await server.close();
}
