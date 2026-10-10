/**
 * ほかの道から話を開いても、同じ話の2枚目を作らない（画面の自動テスト、設計書6.25.11・6.113）。
 *
 * 実機確認リスト 0.96.10 の「ほかの道」を機械へ移したもの（2026-10-03）。移る先の話が
 * **別の列で、別の向き（「縦書き表示」で縦書きの入口に替えたタブ）で開いているとき**に、
 * 次の3つの道から開いても、その列のタブが前に出るだけで2枚目ができないことを見る：
 *
 * - 原稿エディターの［次の話 →］
 * - 原稿エディターの［最新話を書く］（最新話が白紙なら、それを開く。作らない）
 * - 執筆統計の「話ごとの文字数」の行
 * - 最後に逆向き：右の縦書きの最新話の［← 前の話］で、左の列（前は執筆統計）の第1話が前に出る
 */
import { readdir } from "node:fs/promises";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, manuscriptFrames, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { activeGroupIndex, activeTabNames, countTabsNamed, editorGroupTabs, quickOpen, tabNameMatches, tabNamesInclude } from "./support/workbenchDom";

const FIRST = "001_はじまり.txt";
const LATEST = "002_つづき.txt";

/** 使い捨ての keybindings.json に足すキー（ほかと重ねない。F8〜F12 は土台と広報が使用中） */
const MOVE_TO_RIGHT_KEY = "ctrl+alt+shift+f6";
const MOVE_TO_RIGHT_PRESS = "Control+Alt+Shift+F6";
const WRITING_STATS_KEY = "ctrl+alt+shift+f7";
const WRITING_STATS_PRESS = "Control+Alt+Shift+F7";
const OPEN_VERTICAL_KEY = "ctrl+alt+shift+f5";
const OPEN_VERTICAL_PRESS = "Control+Alt+Shift+F5";

async function tabCount(page: Page, name: string): Promise<number> {
  return countTabsNamed((await editorGroupTabs(page)).flat(), name);
}

/** その話のタブが1枚のまま、原稿の面が2枚のまま、をしばらく見続ける */
async function staysSingle(page: Page, label: string): Promise<void> {
  await holdsFor(
    async () => (await tabCount(page, LATEST)) === 1 && (await tabCount(page, FIRST)) === 1,
    label
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（列とタブ：${JSON.stringify(await editorGroupTabs(page))}）`);
  });
  expect((await manuscriptFrames(page)).length, `原稿の面の数（${label}）`).toBe(2);
}

/**
 * 第1話の原稿エディターの面。**押すたびに探し直す**——同じ列で裏へ回った WebView は
 * 作り直されることがあり、前に掴んだ面は外れている（実際に踏んだ）
 */
async function firstFrame(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await waitUntil(
    async () => {
      for (const frame of await manuscriptFrames(page)) {
        if ((await composeText(frame)).includes("第1話の本文")) {
          found = frame;
          return true;
        }
      }
      return false;
    },
    "第1話の原稿エディターの面が見つかる",
    10_000
  );
  if (!found) throw new Error("第1話の原稿エディターの面が見つかりません");
  return found;
}

/** 執筆統計の面（話ごとの行 `tr[data-path]` を持つ） */
async function writingStatsFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.querySelector("tr.clickable[data-path]") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

test("移る先の話が別の列・別の向きで開いているとき、［次の話］［最新話を書く］執筆統計の行［前の話］から開いても2枚目ができず、その列が前に出る", async () => {
  await withVsCode(
    "ほかの道から開く",
    [
      { name: FIRST, text: "第1話の本文。\n二行目。\n" },
      // 最新話は白紙（［最新話を書く］が新しい話を作らず、これを開く）
      { name: LATEST, text: "" },
    ],
    async (session) => {
      const { page } = session;
      await openEpisode(page, FIRST, "第1話の本文");

      let first: Frame;
      // 最新話（白紙）を開き、右の列へ移す
      await quickOpen(page, LATEST);
      await waitUntil(async () => (await manuscriptFrames(page)).length === 2, "最新話の原稿エディターが開く", 30_000);
      await page.keyboard.press(MOVE_TO_RIGHT_PRESS);
      await waitUntil(
        async () => {
          const groups = await editorGroupTabs(page);
          return (
            groups.length === 2 &&
            tabNamesInclude(groups[0], FIRST) &&
            tabNamesInclude(groups[1], LATEST) &&
            !tabNamesInclude(groups[0], LATEST)
          );
        },
        "最新話が右の列へ移る",
        10_000
      );
      // 右の列の最新話を「縦書き表示」で縦書きの入口に替える（同じタブが切り替わる。0.96.10）。
      // これで移る先は「別の列」かつ「別の向き」になる
      await page.keyboard.press(OPEN_VERTICAL_PRESS);
      await waitUntil(
        async () => {
          for (const frame of await manuscriptFrames(page)) {
            const mode = await frame.evaluate(() => {
              const compose = document.getElementById("compose");
              return compose ? getComputedStyle(compose).writingMode : "";
            });
            if (mode.startsWith("vertical")) return true;
          }
          return false;
        },
        "右の列の最新話が縦書きになる",
        15_000
      );
      await staysSingle(page, "縦書き表示のあとも最新話のタブが1枚");

      // ── ［次の話 →］──
      first = await firstFrame(page);
      await placeCaretAfter(first, "二行");
      await waitUntil(async () => (await activeGroupIndex(page)) === 0, "左の列に焦点が戻る", 5_000);
      await first.locator("#next").click();
      await waitUntil(async () => (await activeGroupIndex(page)) === 1, "［次の話 →］で右の列が前に出る", 10_000);
      await staysSingle(page, "［次の話 →］のあとも最新話のタブが1枚");

      // ── ［最新話を書く］──
      first = await firstFrame(page);
      await placeCaretAfter(first, "二行");
      await waitUntil(async () => (await activeGroupIndex(page)) === 0, "左の列に焦点が戻る", 5_000);
      await first.locator("#latest").click();
      await waitUntil(async () => (await activeGroupIndex(page)) === 1, "［最新話を書く］で右の列が前に出る", 10_000);
      await staysSingle(page, "［最新話を書く］のあとも最新話のタブが1枚");
      // 白紙の最新話を開いただけで、新しい話は作っていない
      expect((await readdir(session.manuscriptFolder)).filter((name) => name.endsWith(".txt")).sort()).toEqual([
        FIRST,
        LATEST,
      ]);

      // ── 執筆統計の「話ごとの文字数」の行 ──
      first = await firstFrame(page);
      await placeCaretAfter(first, "二行");
      await page.keyboard.press(WRITING_STATS_PRESS);
      let stats: Frame | undefined;
      await waitUntil(
        async () => (stats = await writingStatsFrame(page)) !== undefined,
        "執筆統計に話ごとの行が並ぶ",
        30_000
      );
      if (!stats) throw new Error("執筆統計の面が見つかりません");
      // 開いたときは「執筆量」の面なので、「話ごとの文字数」へ切り替える
      await stats.locator('.tab[data-page="episodes"]').click();
      const groupsWithStats = await editorGroupTabs(page);
      await stats.locator("tr.clickable[data-path]", { hasText: "つづき" }).first().click();
      await waitUntil(
        async () => tabNameMatches((await activeTabNames(page))[await activeGroupIndex(page)] ?? "", LATEST),
        "執筆統計の行を押すと、最新話のタブが前に出る",
        10_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（押す前：${JSON.stringify(groupsWithStats)}／押した後：${JSON.stringify(await editorGroupTabs(page))}）`
        );
      });
      await staysSingle(page, "執筆統計の行を押したあとも、どの話のタブも1枚");

      // ── ［← 前の話］（右の縦書きの最新話から、左の列の第1話へ。左の列の前は執筆統計）──
      let latestFrame: Frame | undefined;
      for (const frame of await manuscriptFrames(page)) {
        if (!(await composeText(frame)).includes("第1話の本文")) latestFrame = frame;
      }
      if (!latestFrame) throw new Error("最新話の原稿エディターの面が見つかりません");
      await latestFrame.locator("#prev").click();
      await waitUntil(
        async () => (await activeGroupIndex(page)) === 0 && tabNameMatches((await activeTabNames(page))[0] ?? "", FIRST),
        "［← 前の話］で左の列の第1話が前に出る",
        10_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（前のタブ：${JSON.stringify(await activeTabNames(page))}）`);
      });
      await staysSingle(page, "［← 前の話］のあとも、どの話のタブも1枚");
    },
    {
      keybindings: [
        { key: MOVE_TO_RIGHT_KEY, command: "workbench.action.moveEditorToNextGroup" },
        { key: WRITING_STATS_KEY, command: "novelai.showWritingStats" },
        { key: OPEN_VERTICAL_KEY, command: "novelai.openVertical" },
      ],
    }
  );
});
