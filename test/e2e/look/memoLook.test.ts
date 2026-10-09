/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、校正・メモパネルと、F8 で飛んだ先の光りの写真
 * （2026-10-09 の二段目。作者が見た目の良し悪しを判断するための写真。判断そのものはしない）。
 *
 * `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。AI は呼ばない（指摘は置き場へ見本を置く）。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { describe, test } from "vitest";
import { manuscriptFrames, memoPanelFrame, openEpisode, placeCaretAfter, revealFlashLit } from "../support/manuscriptFrame";
import { writeSampleFinding, type SampleFinding } from "../support/sampleFinding";
import { turnVertical, VERTICAL_LAUNCH } from "../support/verticalFace";
import { resizeWindows, withVsCode } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, quickOpen } from "../support/workbenchDom";
import { lookEnabled, lookNote, shootNow, shootPage } from "./lookSupport";

const EPISODE = "001_駅.txt";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "// ここで男の正体を匂わせる一文を足す",
  "　近づいてみると、男は以外にも若かった。",
  "// 雨の描写をもう一度入れて、場面を締める",
  "　ホームの時計が、零時を指していた。",
  "",
].join("\n");

/** 指摘の見本を何件か、製品が読む形で置く（`writeSampleFinding` は1件で上書きするので、写して足す） */
async function writeSampleFindings(workFolder: string, samples: readonly SampleFinding[]): Promise<void> {
  const file = path.join(workFolder, ".aiwriter", "findings.jsonl");
  for (const [index, sample] of samples.entries()) {
    if (index === 0) {
      await writeSampleFinding(workFolder, sample);
      continue;
    }
    const scratch = path.join(workFolder, ".aiwriter", `scratch-${index}`);
    await mkdir(scratch, { recursive: true });
    await writeSampleFinding(scratch, sample);
    await appendFile(file, await readFile(path.join(scratch, ".aiwriter", "findings.jsonl"), "utf8"), "utf8");
  }
}

const TYPO: SampleFinding = {
  episode: EPISODE,
  text: TEXT,
  original: "男は以外にも若かった。",
  target: "以外",
  suggestion: "意外",
  message: "「思いのほか」の意味なら「意外」です",
};
const LONG_SUGGESTION =
  "ホームの大きな時計の針は、まるで時間そのものがそこで止まってしまったかのように、ちょうど零時の真上を静かに、しかしはっきりと指していた。";
const LONG: SampleFinding = {
  episode: EPISODE,
  text: TEXT,
  original: "ホームの時計が、零時を指していた。",
  target: "ホームの時計が、零時を指していた。",
  suggestion: LONG_SUGGESTION,
  message: "情景を足して、時間が止まった感じを出せます",
  category: "proofread",
  label: "推敲",
};

async function openMemoPanel(page: Page, minRows: number): Promise<Frame> {
  await page.keyboard.press("Control+Alt+KeyM");
  let memo: Frame | undefined;
  await waitUntil(
    async () => {
      memo = await memoPanelFrame(page);
      return memo !== undefined && (await memo.locator("#list button.go").count()) >= minRows;
    },
    "校正・メモパネルに行が並ぶ",
    30_000
  );
  if (!memo) throw new Error("校正・メモパネルが見つかりません");
  return memo;
}

describe.skipIf(!lookEnabled)("見た目の写真：校正・メモパネル", () => {
  test("［直す］のあとの「直しました［戻す］」の帯（短い誤字・長い推敲）", async () => {
    await withVsCode(
      "見た目の写真：直しましたの帯",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        await writeSampleFindings(session.workFolder, [TYPO, LONG]);
        const frame = await openEpisode(page, EPISODE, "零時を指していた");
        await placeCaretAfter(frame, "終電を逃した");
        const memo = await openMemoPanel(page, 4);
        await clearNotifications(page);
        await shootPage(page, "95-メモパネル-直す前");

        // 短い誤字（以外→意外）
        await memo.locator("div.memo", { has: memo.locator("button.go", { hasText: "以外" }) }).locator('button[data-act="fix"]').first().click();
        await waitUntil(async () => (await memo.locator("#fixed").isVisible()) && (await memo.locator("#fixedText").innerText()).includes("意外"), "短い帯が出る");
        await lookNote(`[95] 短い誤字の帯の文：${await memo.locator("#fixedText").innerText()}`);
        await page.mouse.move(320, 700);
        await shootPage(page, "95-メモパネル-帯-短い誤字");

        // 長い推敲の修正案
        await memo.locator("div.memo", { has: memo.locator("button.go", { hasText: "零時" }) }).locator('button[data-act="fix"]').first().click();
        await waitUntil(async () => (await memo.locator("#fixed").isVisible()) && (await memo.locator("#fixedText").innerText()).includes("止まって"), "長い帯が出る");
        await lookNote(`[95] 長い推敲の帯の文：${await memo.locator("#fixedText").innerText()}`);
        await page.mouse.move(320, 700);
        await shootPage(page, "95-メモパネル-帯-長い推敲");
        // 帯の高さ・はみ出しを数字でも残す（切れているか、折り返しているか）
        const box = await memo.evaluate(() => {
          const bar = document.getElementById("fixed") as HTMLElement;
          const text = document.getElementById("fixedText") as HTMLElement;
          return { barWidth: bar.clientWidth, barScroll: bar.scrollWidth, barHeight: bar.clientHeight, textWidth: text.clientWidth, textScroll: text.scrollWidth, textHeight: text.clientHeight, white: getComputedStyle(text).whiteSpace, overflow: getComputedStyle(text).overflow };
        });
        await lookNote(`[95] 帯の寸法：${JSON.stringify(box)}`);
      },
      { windowSize: { width: 1280, height: 800 } }
    );
  });

  test("F8 で飛んだ先の行の青い枠（暗い・明るい・縦書き・打つ面）と、パネルの行を押したときの光り", async () => {
    // ── 暗いテーマ・横書き ──
    await withVsCode(
      "見た目の写真：F8の光り（暗い）",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        const frame = await openEpisode(page, EPISODE, "零時を指していた");
        await placeCaretAfter(frame, "終電を逃した");
        await clearNotifications(page);
        await page.keyboard.press("F8");
        await waitUntil(async () => revealFlashLit(frame), "F8 の先が光る", 5_000);
        await shootNow(page, "122-F8の光り-暗い-横書き");
      },
      { windowSize: { width: 1280, height: 800 } }
    );
    // ── 明るいテーマ・横書き ──
    await withVsCode(
      "見た目の写真：F8の光り（明るい）",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        const frame = await openEpisode(page, EPISODE, "零時を指していた");
        await placeCaretAfter(frame, "終電を逃した");
        await clearNotifications(page);
        await page.keyboard.press("F8");
        await waitUntil(async () => revealFlashLit(frame), "F8 の先が光る", 5_000);
        await shootNow(page, "122-F8の光り-明るい-横書き");
      },
      { windowSize: { width: 1280, height: 800 }, settings: { "workbench.colorTheme": "Default Light Modern" } }
    );
    // ── 暗いテーマ・縦書き ──
    await withVsCode(
      "見た目の写真：F8の光り（縦書き）",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        await openEpisode(page, EPISODE, "零時を指していた");
        const vertical = await turnVertical(session, "零時を指していた");
        await placeCaretAfter(vertical, "終電を逃した");
        await clearNotifications(page);
        await page.keyboard.press("F8");
        await waitUntil(async () => revealFlashLit(vertical), "F8 の先が光る（縦書き）", 5_000);
        await shootNow(page, "122-F8の光り-暗い-縦書き");
      },
      { ...VERTICAL_LAUNCH, windowSize: { width: 1280, height: 800 } }
    );
    // ── 打つ面（本文に U+00A0 があって組めず、打つ面のまま開く道） ──
    const NBSP = " ";
    await withVsCode(
      "見た目の写真：F8の光り（打つ面）",
      [{ name: EPISODE, text: TEXT.replace("残っていた。\n", `残っていた。${NBSP}\n`) }],
      async (session) => {
        const { page } = session;
        await quickOpen(page, EPISODE);
        let surface: Frame | undefined;
        await waitUntil(
          async () => {
            for (const candidate of await manuscriptFrames(page)) {
              const value = await candidate.evaluate(() => (document.getElementById("write") as HTMLTextAreaElement | null)?.value ?? "").catch(() => "");
              if (value.includes("零時を指していた")) {
                surface = candidate;
                return true;
              }
            }
            return false;
          },
          "打つ面に本文が入る",
          30_000
        );
        if (!surface) throw new Error("打つ面が見つかりません");
        await surface.locator("#write").click({ position: { x: 20, y: 10 } });
        await clearNotifications(page);
        await page.keyboard.press("F8");
        await page.waitForTimeout(250);
        await shootNow(page, "122-F8の光り-暗い-打つ面");
        await lookNote(`[122] 打つ面のカーソルの行：${await surface.evaluate(() => { const w = document.getElementById("write") as HTMLTextAreaElement; return w.value.slice(0, w.selectionStart).split("\n").length; })}`);
      },
      { windowSize: { width: 1280, height: 800 } }
    );
  });

  test("校正・メモパネルの行を押したときの、パネルと本文の光り", async () => {
    await withVsCode(
      "見た目の写真：パネルの行を押す",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        await writeSampleFindings(session.workFolder, [TYPO]);
        const frame = await openEpisode(page, EPISODE, "零時を指していた");
        await placeCaretAfter(frame, "終電を逃した");
        const memo = await openMemoPanel(page, 3);
        await clearNotifications(page);
        // メモの行（2つ目のメモ）を押す
        await memo.locator("#list button.go", { hasText: "雨の描写" }).first().click();
        await page.waitForTimeout(250);
        await shootNow(page, "123-パネルの行を押した直後");
        await page.waitForTimeout(700);
        await shootNow(page, "123-パネルの行を押して1秒後");
        // 指摘の行も押す
        await memo.locator("#list button.go", { hasText: "以外" }).first().click();
        await page.waitForTimeout(250);
        await shootNow(page, "123-パネルの指摘の行を押した直後");
      },
      { windowSize: { width: 1280, height: 800 } }
    );
  });

  test("広報動画と同じ見た目（明るい・窓 1280×720）で、［直す］のあとの一覧", async () => {
    const EPISODE_1 = "001_雨の駅.txt";
    const EPISODE_2 = "002_翌朝.txt";
    const TEXT_1 = [
      "　終電を逃した駅のホームに、雨の音だけが残っていた。",
      "　ミナは傘を持っていない。改札の向こうで、見知らぬ男が手を振っている。",
      "// ここで男の正体を匂わせる一文を足す",
      "　近づいてみると、男は以外にも若かった。",
      "　「待ってたよ」と彼は言った。声に聞き覚えがある。",
      "　ミナは一歩、後ずさった。",
      "// 雨の描写をもう一度入れて、場面を締める",
      "　ホームの時計が、零時を指していた。",
      "",
    ].join("\n");
    const TEXT_2 = [
      "　翌朝、ミナは同じ駅に立っていた。",
      "　昨夜の男の姿は無い。",
      "// 傘の色を第1話と揃える（青）",
      "　ベンチに、見覚えのある傘が立てかけてあった。",
      "",
    ].join("\n");
    await withVsCode(
      "見た目の写真：広報動画の見た目",
      [
        { name: EPISODE_1, text: TEXT_1 },
        { name: EPISODE_2, text: TEXT_2 },
      ],
      async (session) => {
        const { page } = session;
        await writeSampleFindings(session.workFolder, [
          { episode: EPISODE_1, text: TEXT_1, original: "男は以外にも若かった。", target: "以外", suggestion: "意外", message: "「思いのほか」の意味なら「意外」です" },
          { episode: EPISODE_2, text: TEXT_2, original: "昨夜の男の姿は無い。", target: "無い", suggestion: "ない", message: "ほかの箇所は「ない」と書いています", category: "notation", label: "表記ゆれ" },
        ]);
        // 動画の台本と同じく、起動の直後に VS Code が組み直して大きさがずれることがあるので、合わせ直す
        await resizeWindows(session.app, { width: 1280, height: 720 });
        await page.keyboard.press("Control+Alt+Shift+F9");
        const frame = await openEpisode(page, EPISODE_1, "零時を指していた");
        await placeCaretAfter(frame, "終電を逃した");
        const memo = await openMemoPanel(page, 5);
        await clearNotifications(page);
        await placeCaretAfter(frame, "終電を逃した");
        await page.mouse.move(320, 600);
        await page.waitForTimeout(800);
        await shootNow(page, "80-広報動画の見た目-直す前");
        await memo.locator("div.memo", { has: memo.locator("button.go", { hasText: "以外" }) }).locator('button[data-act="fix"]').first().click();
        await page.mouse.move(320, 600);
        await waitUntil(async () => (await memo.locator("#fixed").isVisible()) && (await memo.locator("#fixedText").innerText()).includes("意外"), "帯が出る");
        await page.waitForTimeout(2400);
        await shootNow(page, "80-広報動画の見た目-直したあと");
        await lookNote(`[80] 直したあとの焦点の要素：${await memo.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? a.tagName + "." + a.className + "[" + (a.textContent ?? "").slice(0, 10) + "]" : "なし"; })}`);
      },
      {
        windowSize: { width: 1280, height: 720 },
        workTitle: "雨の駅",
        settings: {
          "workbench.colorTheme": "Default Light Modern",
          "workbench.activityBar.location": "hidden",
          "workbench.statusBar.visible": false,
          "workbench.layoutControl.enabled": false,
          "workbench.editor.editorActionsLocation": "hidden",
          "window.titleBarStyle": "native",
          "window.commandCenter": false,
          "window.menuBarVisibility": "hidden",
          "editor.minimap.enabled": false,
          "breadcrumbs.enabled": false,
          "window.zoomLevel": 1,
        },
        keybindings: [{ key: "ctrl+alt+shift+f9", command: "workbench.action.closeSidebar" }],
      }
    );
  });
});
