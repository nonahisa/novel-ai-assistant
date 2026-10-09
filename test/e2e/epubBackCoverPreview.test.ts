/**
 * EPUBエディターの裏表紙の面で、元イラストに文字を重ねた見本が描かれる
 * （画面の自動テスト、設計書6.65.8・6.113。実機確認リスト 316 の写真、2026-10-09）。
 *
 * 写真：表紙は見本（元イラスト＋題名）が描かれるのに、裏表紙は焼く前も、焼いたあとに
 * 題名の「縦」を外したあとも、見本の絵が空白の箱になっていた（焼くと画像はできる）。
 *
 * 確かめること：
 * - 裏表紙の面を開くと、見本の canvas が描かれている（枠の大きさになり、空白でない）
 * - 焼いたあとに題名の「縦」を外すと、焼かずに見本へ替わり、その見本も描かれている
 *
 * 本の設計図（`設定/書籍/book.json`）と元イラスト（小さなPNG）は起こす前に置く。**AI は呼ばない。**
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { defaultBookConfig } from "../../src/models/book";
import { runCommand } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pickQuickPickRow, quickPickTitle } from "./support/workbenchDom";

const EPISODES = [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }];

/** 1×1 の赤い PNG（元イラストの代わり） */
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

async function openEpubEditor(page: Page): Promise<Frame> {
  await runCommand(page, "EPUBエディター（試作）");
  await page.waitForTimeout(500);
  if ((await quickPickTitle(page)) !== undefined) await pickQuickPickRow(page, E2E_WORK_TITLE);
  let found: Frame | undefined;
  await waitUntil(async () => {
    found = await epubFrame(page);
    return found !== undefined && (await found.locator("#blockList .rail-row").count()) > 0;
  }, "EPUBエディターが開いて本の並びが出る", 30_000);
  return found as Frame;
}

interface CanvasLook {
  /** canvas の内側の大きさ（描くと枠の大きさ 1714×2400 系になる。描かれないと既定の 300×150） */
  width: number;
  height: number;
  /** 真ん中の1点が透明でないか（描かれていれば元イラストの色か枠の余白の色） */
  painted: boolean;
}

async function backCanvas(epub: Frame): Promise<CanvasLook | null> {
  return epub.evaluate(() => {
    const canvas = document.getElementById("canvas-back") as HTMLCanvasElement | null;
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    const pixel = ctx ? ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data : [0, 0, 0, 0];
    return { width: canvas.width, height: canvas.height, painted: pixel[3] > 0 };
  });
}

const bakedBack = (session: E2ESession) => path.join(session.workFolder, "設定", "書籍", "裏表紙_合成済み.png");

test("裏表紙の面でも、元イラストに文字を重ねた見本が描かれる（焼く前・縦を外したあと）", async () => {
  await withVsCode(
    "EPUB・裏表紙の見本",
    EPISODES,
    async (session) => {
      const { page } = session;
      const epub = await openEpubEditor(page);
      await epub
        .locator("#blockList .rail-row", { has: epub.locator(".rail-label", { hasText: /^裏表紙$/ }) })
        .first()
        .click();
      const bake = epub.locator("#bakeBack");
      await waitUntil(async () => await bake.isVisible(), "［裏表紙を焼く］が出る", 20_000);
      const visible = epub.locator("#back-title-visible");
      if (!(await visible.isChecked())) await visible.check();

      // ── 焼く前：見本が描かれる ──
      let look: CanvasLook | null = null;
      await waitUntil(
        async () => {
          look = await backCanvas(epub);
          return look !== null && look.width !== 300 && look.painted;
        },
        "裏表紙の見本が描かれる（焼く前）",
        10_000
      ).catch(() => undefined);
      expect(look, `焼く前の裏表紙の見本が描かれていません：${JSON.stringify(look)}`).toMatchObject({ painted: true });
      expect((look as CanvasLook | null)?.width).not.toBe(300);

      // ── 焼いてから、題名の「縦」を外す（焼かずに見本へ替わる） ──
      await bake.click();
      await waitUntil(async () => (await stat(bakedBack(session)).catch(() => undefined)) !== undefined, "裏表紙の焼いた画像ができる", 20_000);
      await page.waitForTimeout(1000);
      const vertical = epub.locator("#back-title-vertical");
      await vertical.setChecked(!(await vertical.isChecked()));
      look = null;
      await waitUntil(
        async () => {
          look = await backCanvas(epub);
          return look !== null && look.width !== 300 && look.painted;
        },
        "裏表紙の見本が描かれる（縦を外したあと）",
        10_000
      ).catch(() => undefined);
      expect(look, `縦を外したあとの裏表紙の見本が描かれていません：${JSON.stringify(look)}`).toMatchObject({ painted: true });
    },
    {
      windowSize: { width: 1400, height: 1000 },
      prepareWork: async ({ workFolder }) => {
        await mkdir(path.join(workFolder, "素材"), { recursive: true });
        await writeFile(path.join(workFolder, "素材", "表紙.png"), TINY_PNG);
        await writeFile(path.join(workFolder, "素材", "裏表紙.png"), TINY_PNG);
        await mkdir(path.join(workFolder, "設定", "書籍"), { recursive: true });
        const config = { ...defaultBookConfig("見本の本"), coverImagePath: "素材/表紙.png", backCoverImagePath: "素材/裏表紙.png" };
        await writeFile(path.join(workFolder, "設定", "書籍", "book.json"), JSON.stringify(config, null, 2), "utf8");
      },
    }
  );
});
