/**
 * EPUBエディターで、焼いた表紙があるあいだも［表紙を焼く］が押せて、焼き直せる
 * （画面の自動テスト、設計書6.65.8・6.65.13・6.113）。
 *
 * 実機確認リストの【不具合】（2026-09-21、本体が画面で見つけた）を機械へ移したもの。
 * 当時は、焼いたあとプレビューが焼いた画像に替わり、合成の canvas が画面から消えるので、
 * 焼く相手が無く［表紙を焼く］が黙って何もしなかった（注記は「焼き直してください」と言うのに）。
 * 画面に出さない canvas（`offscreen`）へ同じ関数で描いて焼く形に直っている。見張るのは次のとおり。
 *
 * - ［表紙を焼く］を押すと `設定/書籍/表紙_合成済み.png` ができ、「焼いた画像を消す」が出る
 * - **焼いたあとも［表紙を焼く］が押せる**（押せない状態になっていない）
 * - 枠の余白の色を変えてもう一度押すと、**先に［焼いた画像を消す］を押さなくても**画像が焼き直される
 *   （ファイルの中身が変わる）
 * - ［焼いた画像を消す］でファイルが消え、［表紙を焼く］が押せるまま残る
 *
 * 本の設計図（`設定/書籍/book.json`）と元イラスト（小さなPNG）は起こす前に置く。**AI は呼ばない。**
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { defaultBookConfig } from "../../src/models/book";
import { runCommand } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pickQuickPickRow, quickPickTitle } from "./support/workbenchDom";

const EPISODES = [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }];

/** 1×1 の赤い PNG（元イラストの代わり。枠いっぱいに伸ばされず、余白が出る形になる） */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function epubFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("railBook") !== null && document.getElementById("blockList") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

async function railLabels(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll("#blockList .rail-row")).map((row) => (row.querySelector(".rail-label")?.textContent ?? "").trim())
  );
}

async function openEpubEditor(page: Page): Promise<Frame> {
  await runCommand(page, "EPUBエディター（試作）");
  await page.waitForTimeout(500);
  if ((await quickPickTitle(page)) !== undefined) await pickQuickPickRow(page, E2E_WORK_TITLE);
  let found: Frame | undefined;
  await waitUntil(async () => {
    found = await epubFrame(page);
    return found !== undefined && (await railLabels(found)).length > 0;
  }, "EPUBエディターが開いて本の並びが出る", 30_000);
  return found as Frame;
}

function bakedFile(session: E2ESession): string {
  return path.join(session.workFolder, "設定", "書籍", "表紙_合成済み.png");
}

test("焼いた表紙があっても［表紙を焼く］が押せて、先に消さなくても焼き直され、［焼いた画像を消す］でファイルが消える", async () => {
  await withVsCode(
    "表紙の焼き直し",
    EPISODES,
    async (session) => {
      const { page } = session;
      const epub = await openEpubEditor(page);

      // 表紙の面を選ぶ
      await epub.locator("#blockList .rail-row", { has: epub.locator(".rail-label", { hasText: "表紙" }) }).first().click();
      const bake = epub.locator("#bakeFront");
      await waitUntil(async () => await bake.isVisible(), "［表紙を焼く］が出る（元イラストを指定した作品）", 20_000);
      expect(await epub.locator("#front-baked-actions").isHidden(), "焼く前は［焼いた画像を消す］が出ていない").toBe(true);

      // 焼く
      await bake.click();
      await waitUntil(async () => (await stat(bakedFile(session)).catch(() => undefined)) !== undefined, "表紙_合成済み.png ができる", 20_000);
      await waitUntil(async () => await epub.locator("#front-baked-actions").isVisible(), "焼いたあと［焼いた画像を消す］が出る");
      const first = await readFile(bakedFile(session));

      // 焼いたあとも押せる（押せない状態ではない）
      expect(await bake.isEnabled(), "焼いたあとの［表紙を焼く］が押せない状態になっています").toBe(true);
      expect(await bake.isVisible(), "焼いたあとの［表紙を焼く］が画面から消えています").toBe(true);

      // 余白の色を白へ替えて、消さずにもう一度焼く
      await epub.locator("#front-frameBackground-color").selectOption("#ffffff");
      await bake.click();
      await waitUntil(
        async () => {
          const now = await readFile(bakedFile(session)).catch(() => undefined);
          return now !== undefined && !now.equals(first);
        },
        "先に［焼いた画像を消す］を押さなくても、焼き直されてファイルの中身が変わる",
        20_000
      );

      // 消す：ファイルが消え、［表紙を焼く］は押せるまま
      await epub.locator("#unbakeFront").click();
      await waitUntil(async () => (await stat(bakedFile(session)).catch(() => undefined)) === undefined, "焼いた画像のファイルが消える", 20_000);
      await waitUntil(async () => await epub.locator("#front-baked-actions").isHidden(), "［焼いた画像を消す］が引っ込む");
      expect(await bake.isEnabled()).toBe(true);
    },
    {
      prepareWork: async ({ workFolder }) => {
        await mkdir(path.join(workFolder, "素材"), { recursive: true });
        await writeFile(path.join(workFolder, "素材", "表紙.png"), TINY_PNG);
        await mkdir(path.join(workFolder, "設定", "書籍"), { recursive: true });
        const config = { ...defaultBookConfig("画面テストの本"), coverImagePath: "素材/表紙.png" };
        await writeFile(path.join(workFolder, "設定", "書籍", "book.json"), JSON.stringify(config, null, 2), "utf8");
      },
    }
  );
}, 180_000);
