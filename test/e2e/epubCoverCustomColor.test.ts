/**
 * EPUBエディターの表紙の合成で、題名の色を「任意」にして色見本（`input type=color`）で色を選ぶと、
 * プレビュー（canvas）の題名がその色になる（画面の自動テスト、設計書6.65.8・6.113。2026-10-18）。
 *
 * 実機確認リスト「置き場所（9か所）・大きさ・色・縦横を変えるとプレビューが追従するか。『任意』の色見本が
 * 効くか」の残り（「任意」の色見本だけ。置き場所・大きさ・色（白・黒）・縦横は 2026-09-21 に画面で確かめ済み）を機械へ移したもの。
 * OS の色選択の窓は開かない：`input type=color` の値を直接入れる（`fill`。値の変更の通知は出る）。
 * 作者の手で見るのは、OS の色選択の窓が実際に開いて選べるかと、色の見た目（ここでは見ない）。
 *
 * 見張るのは次のとおり：
 * - 初期（題名：白）の表紙の canvas に、赤い画素は無い
 * - 題名の色の選択を「任意」にして、色見本へ `#ff0000` を入れると、canvas に**赤い画素**が現れ、
 *   題名の白い画素は減る（題名が赤になった）
 * - 色見本の値を `#00ff00` へ替えると、赤い画素が消えて**緑の画素**になる（追従する）
 *
 * AI は呼ばない。本の設計図と元イラスト（小さな PNG）は起こす前に置く（`epubCoverRebake.test.ts` と同じ）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { defaultBookConfig } from "../../src/models/book";
import { runCommand } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pickQuickPickRow, quickPickTitle } from "./support/workbenchDom";

const EPISODES = [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }];

/** 1×1 の赤い PNG（元イラストの代わり。枠いっぱいには伸びず、余白が出る形になる）。題名の色の測りの邪魔にならないよう、黒の余白で包む */
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

/** 表紙の canvas の中の、ほぼその色（各色 ±40）の画素の数。題名のふち（半透明）は数えない近さにする */
async function pixelsNear(frame: Frame, rgb: [number, number, number]): Promise<number> {
  return frame.evaluate((target) => {
    const canvas = document.getElementById("canvas-front") as HTMLCanvasElement | null;
    if (!canvas) return -1;
    const context = canvas.getContext("2d");
    if (!context) return -1;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let at = 0; at < data.length; at += 4) {
      if (
        Math.abs(data[at] - target[0]) <= 40 &&
        Math.abs(data[at + 1] - target[1]) <= 40 &&
        Math.abs(data[at + 2] - target[2]) <= 40 &&
        data[at + 3] > 200
      ) {
        count++;
      }
    }
    return count;
  }, rgb);
}

test("題名の色を「任意」にして色見本で赤を選ぶと、表紙のプレビューの題名が赤になり、緑へ替えると追従する", async () => {
  await withVsCode(
    "表紙の任意の色",
    EPISODES,
    async (session) => {
      const { page } = session;
      const epub = await openEpubEditor(page);

      // 表紙の面を選ぶ
      await epub.locator("#blockList .rail-row", { has: epub.locator(".rail-label", { hasText: "表紙" }) }).first().click();
      await waitUntil(async () => (await epub.locator("#canvas-front").count()) > 0, "表紙の合成の canvas が出る", 20_000);
      // 描き終わるまで待つ（題名の白い画素が出る）
      let white = 0;
      await waitUntil(
        async () => {
          white = await pixelsNear(epub, [255, 255, 255]);
          return white > 50;
        },
        "初期の題名（白）が canvas に描かれる",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（白い画素：${white}）`);
      });
      expect(await pixelsNear(epub, [255, 0, 0]), "初期（題名：白）の canvas に、赤い画素がある").toBe(0);

      // 題名の色を「任意」にして、色見本へ赤を入れる
      await epub.locator("#front-title-color").selectOption("custom");
      await epub.locator("#front-title-colorPick").fill("#ff0000");
      let red = 0;
      await waitUntil(
        async () => {
          red = await pixelsNear(epub, [255, 0, 0]);
          return red > 50;
        },
        "色見本で選んだ赤が、題名として canvas に描かれる",
        15_000
      ).catch(async (error: unknown) => {
        const state = await epub.evaluate(() => ({
          color: (document.getElementById("front-title-color") as HTMLSelectElement | null)?.value,
          pick: (document.getElementById("front-title-colorPick") as HTMLInputElement | null)?.value,
        }));
        throw new Error(`${String(error)}（赤い画素：${red}／欄：${JSON.stringify(state)}）`);
      });
      const whiteAfterRed = await pixelsNear(epub, [255, 255, 255]);
      expect(whiteAfterRed, `題名が赤になったのに、白い画素が減っていません（赤：${red}／白：${white}→${whiteAfterRed}）`).toBeLessThan(white);

      // 色見本を緑へ替えると、赤が消えて緑になる
      await epub.locator("#front-title-colorPick").fill("#00ff00");
      let green = 0;
      await waitUntil(
        async () => {
          green = await pixelsNear(epub, [0, 255, 0]);
          return green > 50;
        },
        "色見本を緑へ替えると、題名が緑で描かれる",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（緑の画素：${green}／赤の画素：${await pixelsNear(epub, [255, 0, 0])}）`);
      });
      expect(await pixelsNear(epub, [255, 0, 0]), "緑へ替えたあとも、赤い画素が残っています").toBe(0);
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
