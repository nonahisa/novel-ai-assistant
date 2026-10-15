/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、EPUBエディターの表紙の焼き直し前後の写真
 * （2026-10-09 の二段目。作者が見た目の良し悪しを判断するための写真。判断そのものはしない）。
 *
 * `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ（元イラストも台本が作る色の絵）。AI は呼ばない。
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { describe, test } from "vitest";
import { defaultBookConfig } from "../../../src/models/book";
import { withVsCode, type E2ESession } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { openEpubEditor, samplePicture } from "./epubLookSupport";
import { lookEnabled, lookNote, shootPage } from "./lookSupport";

const baked = (session: E2ESession, side: "表紙" | "裏表紙") => path.join(session.workFolder, "設定", "書籍", side === "表紙" ? "表紙_合成済み.png" : "裏表紙_合成済み.png");

/** 見出し（面の名前＋印）と注記を読む */
async function readFace(epub: Frame): Promise<{ captions: string[]; notes: string[] }> {
  return epub.evaluate(() => ({
    captions: Array.from(document.querySelectorAll(".page-label")).map((node) => (node.textContent ?? "").trim()),
    notes: Array.from(document.querySelectorAll(".page-note, .page-frame .note")).map((node) => (node.textContent ?? "").trim()),
  }));
}

/** 面の見出しと絵が写真に収まるよう、プレビューを窓の上へ転がす */
async function showFace(epub: Frame): Promise<void> {
  await epub.evaluate(() => {
    const frame = document.querySelector(".page-frame");
    if (frame) frame.scrollIntoView({ block: "start" });
  });
  await epub.page().waitForTimeout(400);
}

describe.skipIf(!lookEnabled)("見た目の写真：EPUBエディター", () => {
  test("表紙を焼いたあと、題名の縦を外す・戻す（表紙と裏表紙）", async () => {
    await withVsCode(
      "見た目の写真：表紙の焼き直し前後",
      [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
      async (session) => {
        const { page } = session;
        const epub = await openEpubEditor(page);
        for (const side of ["表紙", "裏表紙"] as const) {
          const ids = side === "表紙" ? { bake: "bakeFront", prefix: "front" } : { bake: "bakeBack", prefix: "back" };
          await epub.locator("#blockList .rail-row", { has: epub.locator(".rail-label", { hasText: new RegExp(`^${side}$`) }) }).first().click();
          const bake = epub.locator(`#${ids.bake}`);
          await waitUntil(async () => await bake.isVisible(), `［${side}を焼く］が出る`, 20_000);
          // 裏表紙は題名が既定で出ない。縦を外す前後で絵が変わるよう、題名を出しておく
          const visible = epub.locator(`#${ids.prefix}-title-visible`);
          if (!(await visible.isChecked())) await visible.check();
          await page.waitForTimeout(1200);
          await showFace(epub);
          await shootPage(page, `316-${side}-焼く前`);
          await bake.click();
          await waitUntil(async () => (await stat(baked(session, side)).catch(() => undefined)) !== undefined, `${side}の焼いた画像ができる`, 20_000);
          await page.waitForTimeout(1500);
          const before = (await stat(baked(session, side))).mtimeMs;
          await lookNote(`[316-318] ${side}：焼いたあとの面 ${JSON.stringify(await readFace(epub))}`);
          await showFace(epub);
          await shootPage(page, `316-${side}-焼いたあと`);

          // 題名の「縦」を外す（焼かずに見本へ変わる）
          const vertical = epub.locator(`#${ids.prefix}-title-vertical`);
          const wasChecked = await vertical.isChecked();
          await lookNote(`[316-318] ${side}：題名の縦は最初 ${wasChecked ? "入っている" : "入っていない"}`);
          await vertical.setChecked(!wasChecked);
          await page.waitForTimeout(1500);
          const after = (await stat(baked(session, side))).mtimeMs;
          await lookNote(`[316] ${side}：縦を替えたあとの面 ${JSON.stringify(await readFace(epub))}／焼いた画像の更新時刻が変わったか：${before !== after}`);
          await showFace(epub);
          await shootPage(page, `316-${side}-縦を替えたあと-見本`);

          // 縦を元へ戻す（焼かなくても焼いた画像の面へ戻るか）
          await vertical.setChecked(wasChecked);
          await page.waitForTimeout(1500);
          await lookNote(`[318] ${side}：縦を戻したあとの面 ${JSON.stringify(await readFace(epub))}`);
          await showFace(epub);
          await shootPage(page, `318-${side}-縦を戻したあと`);

          // もう一度外して見本を出し、その絵（canvas）を取っておく。焼き直すと焼き上がりと同じか
          await vertical.setChecked(!wasChecked);
          await page.waitForTimeout(1500);
          const sampleUrl = await epub.evaluate(() => (document.querySelector(".page-frame canvas") as HTMLCanvasElement | null)?.toDataURL("image/png") ?? "");
          await showFace(epub);
          await shootPage(page, `317-${side}-焼く前の見本`);
          await bake.click();
          await waitUntil(async () => (await stat(baked(session, side)).catch(() => undefined))?.mtimeMs !== before, `${side}の焼き直し`, 20_000);
          await page.waitForTimeout(2000);
          const bakedBytes = await readFile(baked(session, side));
          const sampleBytes = Buffer.from(sampleUrl.replace(/^data:image\/png;base64,/, ""), "base64");
          await lookNote(`[317] ${side}：焼き直したあとの面 ${JSON.stringify(await readFace(epub))}／見本の絵と焼いた画像のバイトが同じか：${bakedBytes.equals(sampleBytes)}（見本 ${sampleBytes.length}B・焼いた ${bakedBytes.length}B）`);
          await showFace(epub);
          await shootPage(page, `317-${side}-焼き直したあと`);
        }
      },
      {
        windowSize: { width: 1400, height: 1000 },
        prepareWork: async ({ workFolder }) => {
          await mkdir(path.join(workFolder, "素材"), { recursive: true });
          await writeFile(path.join(workFolder, "素材", "表紙.png"), samplePicture());
          await writeFile(path.join(workFolder, "素材", "裏表紙.png"), samplePicture());
          await mkdir(path.join(workFolder, "設定", "書籍"), { recursive: true });
          const config = { ...defaultBookConfig("見た目の見本の本"), coverImagePath: "素材/表紙.png", backCoverImagePath: "素材/裏表紙.png" };
          await writeFile(path.join(workFolder, "設定", "書籍", "book.json"), JSON.stringify(config, null, 2), "utf8");
        },
      }
    );
  });
});
