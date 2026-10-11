/**
 * 原稿エディターの Alt+↓／Alt+↑（前後の話へ移るキー）（画面の自動テスト、設計書6.25.5・6.113）。
 *
 * 実機確認リスト 0.95.7〜0.95.8「最終話で Alt+↓ を押すと『最後の話です。』が出てファイルが
 * 増えないか。途中の話では隣が開き、打った字が失われていないか」を 2026-10-11 に移した
 * （作者の指示「機械でできる実機確認」）。画面の側の組み立ては単体テスト
 * （`manuscriptNeighborEpisode.test.ts`・`manuscriptEditorKeys.test.ts`）が見ている。
 * ここでは本物の VS Code で、キーを押して起きることを見る。
 *
 * - 途中の話（第1話）で字を打ち、保存せずに Alt+↓：第2話が開く
 * - Alt+↑ で第1話へ戻ると、打った字が残っている（移る前に送られている）
 * - 最終話（第2話）で Alt+↓：「最後の話です。」が出て、話のファイルが増えない
 *   （キーからは新しい話を作らない。作者の裁定 2026-10-02）
 *
 * **AI は呼ばない。**
 */
import { readdir } from "node:fs/promises";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, manuscriptFrames, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, notificationTexts } from "./support/workbenchDom";

const FIRST = "001_はじまり.txt";
const LAST = "002_つづき.txt";
const FIRST_TEXT = "第1話の本文。朝が来た。\n";
const LAST_TEXT = "第2話の本文。夜が来た。\n";

/** 本文に `marker` を含む原稿エディターの面。移るたびに探し直す（面は作り直されることがある） */
async function frameShowing(page: Page, marker: string, label: string): Promise<Frame> {
  let found: Frame | undefined;
  await waitUntil(
    async () => {
      for (const frame of await manuscriptFrames(page)) {
        if ((await composeText(frame).catch(() => "")).includes(marker)) {
          found = frame;
          return true;
        }
      }
      return false;
    },
    label,
    20_000
  );
  if (!found) throw new Error(`${label}：面が見つかりません`);
  return found;
}

test("途中の話の Alt+↓ は隣を開いて打った字を残し、最終話の Alt+↓ は「最後の話です。」でファイルを増やさない", async () => {
  await withVsCode(
    "前後の話へ移るキー",
    [
      { name: FIRST, text: FIRST_TEXT },
      { name: LAST, text: LAST_TEXT },
    ],
    async (session) => {
      const { page } = session;
      const countEpisodes = async () => (await readdir(session.manuscriptFolder)).filter((name) => name.endsWith(".txt")).length;
      expect(await countEpisodes()).toBe(2);

      // ── 途中の話（第1話）で打って、保存せずに Alt+↓ ──
      const first = await openEpisode(page, FIRST, "第1話の本文");
      await placeCaretAfter(first, "朝が来た。");
      await page.keyboard.insertText("甲");
      await waitUntil(async () => (await composeText(first)).includes("朝が来た。甲"), "打った字が画面に出る");
      await page.keyboard.press("Alt+ArrowDown");
      const last = await frameShowing(page, "第2話の本文", "Alt+↓ で第2話が開く");

      // ── Alt+↑ で第1話へ戻ると、打った字が残っている ──
      await placeCaretAfter(last, "夜が来た。");
      await page.keyboard.press("Alt+ArrowUp");
      await waitUntil(
        async () => {
          for (const frame of await manuscriptFrames(page)) {
            if ((await composeText(frame).catch(() => "")).includes("朝が来た。甲")) return true;
          }
          return false;
        },
        "Alt+↑ で戻った第1話に、移る前に打った字が残っている",
        20_000
      );

      // ── 最終話（第2話）で Alt+↓ ──
      await clearNotifications(page);
      await page.keyboard.press("Alt+ArrowDown");
      const lastAgain = await frameShowing(page, "第2話の本文", "もう一度 Alt+↓ で第2話が開く");
      await placeCaretAfter(lastAgain, "夜が来た。");
      await page.keyboard.press("Alt+ArrowDown");
      await waitUntil(
        async () => (await notificationTexts(page)).some((text) => text.includes("最後の話です。")),
        "最終話の Alt+↓ で「最後の話です。」が出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
      // キーからは新しい話を作らない（遅れて作られるのも見逃さない）
      await holdsFor(async () => (await countEpisodes()) === 2, "最終話の Alt+↓ のあとも話のファイルが2つのまま", 3_000);
    }
  );
});
