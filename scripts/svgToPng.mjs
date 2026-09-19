/* SVG を PNG にする（note へ貼るときは PNG のほうが確実）。倍率2で書き出す */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("使い方: node topng.mjs <svgのパス> ...");
  process.exit(1);
}

const browser = await chromium.launch();
for (const svgPath of targets) {
  const svg = fs.readFileSync(svgPath, "utf8");
  const m = /width="(\d+)"\s+height="(\d+)"/.exec(svg);
  if (!m) {
    console.error("× 大きさが読めません:", svgPath);
    continue;
  }
  const width = Number(m[1]);
  const height = Number(m[2]);

  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  await page.setContent(
    `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;background:#fff}</style>` +
      svg,
    { waitUntil: "load" }
  );
  const out = svgPath.replace(/\.svg$/, ".png");
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width, height } });
  await page.close();
  console.log("○", path.basename(out), fs.statSync(out).size, "バイト");
}
await browser.close();
