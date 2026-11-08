/**
 * 原稿エディターの上の列（多段）と下の欄の写真（作者の決定 2026-11-08。設計書6.25）。
 *
 * 1段目の［入力］［出力］［補助］［表示］をそれぞれ開いた写真と、下の欄（前の話・次の話・最新話・保存）の
 * 写真を撮る。作者が並びと見た目を写真で確かめるためのもので、良し悪しの判断はしない。
 *
 * `NOVELAI_LOOK=1` のときだけ動く（通常の E2E には入らない）。写真は `lookSupport.ts` の置き場
 * （`NOVELAI_LOOK_DIR`。既定は Windows の道なので、Mac では必ず渡す）。作品は使い捨ての見本だけ。
 * AI は呼ばない（段を開くのも、［投稿］の品書きを開くのも、画面の中だけで終わる）。
 */
import type { Frame, Page } from "playwright-core";
import { describe, expect, test } from "vitest";
import { openEpisode, openToolTray, type ToolTray } from "../support/manuscriptFrame";
import { withVsCode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dismissWorkbenchHover } from "../support/workbenchDom";
import { lookEnabled, lookNote, shootPage, shootWithZoom } from "./lookSupport";

const EPISODE = "001_駅.txt";
const TEXT = [
  "　朝の駅は静かだった。",
  "　改札を抜けて、白い息を吐いた。",
  "　ホームの端で、彼女は手を振っていた。",
  "　電車が来るまで、あと三分。",
].join("\r\n") + "\r\n";

/** 原稿エディターの面が、窓のどこにあるか（写真の切り抜きに使う） */
async function faceBox(frame: Frame): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await (await frame.frameElement()).boundingBox();
  if (!box) throw new Error("原稿エディターの面の位置が取れません");
  return box;
}

/** 面の中の要素の箱を、窓の座標へ直す（上下に少し余白を付ける） */
async function clipOf(page: Page, frame: Frame, selectors: string[]): Promise<{ x: number; y: number; width: number; height: number }> {
  const face = await faceBox(frame);
  const inner = await frame.evaluate((list) => {
    let top = Infinity;
    let bottom = 0;
    for (const selector of list) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.height === 0) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
    return { top, bottom };
  }, selectors);
  if (!Number.isFinite(inner.top)) throw new Error(`写す所が見えていません（${selectors.join("・")}）`);
  const viewport = page.viewportSize();
  const y = Math.max(0, face.y + inner.top - 6);
  const bottom = Math.min(viewport ? viewport.height : face.y + face.height, face.y + inner.bottom + 6);
  return { x: face.x, y, width: face.width, height: Math.max(1, bottom - y) };
}

/** 段に並んでいるボタンの字（一覧用のメモに残す） */
async function rowLabels(frame: Frame, tray: ToolTray): Promise<string[]> {
  return frame.evaluate(
    (name) =>
      Array.from(document.querySelectorAll(`.tray[data-tray="${name}"] button`))
        .filter((button) => (button as HTMLElement).offsetParent !== null)
        .map((button) => (button.textContent ?? "").trim()),
    tray
  );
}

const TRAYS: Array<{ tray: ToolTray; name: string }> = [
  { tray: "input", name: "上の列-1-入力" },
  { tray: "output", name: "上の列-2-出力" },
  { tray: "assist", name: "上の列-3-補助" },
  { tray: "view", name: "上の列-4-表示" },
];

describe.skipIf(!lookEnabled)("見た目の写真：原稿エディターの上の列と下の欄", () => {
  test("4つの段をそれぞれ開いた写真と、下の欄の写真", async () => {
    await withVsCode(
      "見た目の写真：上の列",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        await clearNotifications(page);
        const frame = await openEpisode(page, EPISODE, "白い息を吐いた");
        await page.waitForTimeout(800);

        // 段を開く前（1段目だけ）
        await shootWithZoom(page, "上の列-0-閉じたまま", await clipOf(page, frame, ["#bar"]));

        for (const { tray, name } of TRAYS) {
          await dismissWorkbenchHover(page);
          await openToolTray(frame, tray);
          await page.waitForTimeout(400);
          await shootWithZoom(page, name, await clipOf(page, frame, ["#bar", `.tray[data-tray="${tray}"]`]));
          await lookNote(`${name}：${(await rowLabels(frame, tray)).join("｜")}`);
        }

        // 出力の段の［投稿］の品書き（画面の中で開くだけ。項目は押さない）
        await openToolTray(frame, "output");
        await frame.locator("#posting").click();
        await waitUntil(
          async () => frame.evaluate(() => document.getElementById("menu")?.classList.contains("open") === true),
          "［投稿］の品書きが開く",
          5_000
        );
        await shootPage(page, "上の列-2a-出力-投稿の品書き");
        await page.keyboard.press("Escape");
        await waitUntil(
          async () => frame.evaluate(() => document.getElementById("menu")?.classList.contains("open") !== true),
          "Esc で品書きが閉じる",
          5_000
        );

        // 出力の段の［読み上げ］で、読み上げの段も開く（声は出さない）
        await frame.locator("#aloudToggle").click();
        await waitUntil(
          async () => frame.evaluate(() => document.body.classList.contains("aloud")),
          "読み上げの段が開く",
          5_000
        );
        await page.waitForTimeout(400);
        await shootWithZoom(page, "上の列-2b-出力-読み上げの段", await clipOf(page, frame, ["#bar", "#rowOutput", "#aloud"]));
        await frame.locator("#aloudToggle").click();

        // 下の欄（前の話・次の話・最新話・保存）と、その下の字数の欄
        await dismissWorkbenchHover(page);
        await shootWithZoom(page, "下の欄", await clipOf(page, frame, ["#bottom", "#foot"]));
        const bottom = await frame.evaluate(() =>
          Array.from(document.querySelectorAll("#bottom button")).map((button) => (button.textContent ?? "").trim())
        );
        await lookNote(`下の欄：${bottom.join("｜")}`);
        expect(bottom).toEqual(["← 前の話", "次の話 →", "最新話", "保存"]);
      },
      { windowSize: { width: 1280, height: 800 } }
    );
  }, 180_000);
});
