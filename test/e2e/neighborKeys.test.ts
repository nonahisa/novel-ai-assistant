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
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, frontFrameShowing, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { activeTabNames, clearNotifications, editorGroupTabs, notificationTexts, tabNamesInclude } from "./support/workbenchDom";

const FIRST = "001_はじまり.txt";
const LAST = "002_つづき.txt";
const FIRST_TEXT = "第1話の本文。朝が来た。\n";
const LAST_TEXT = "第2話の本文。夜が来た。\n";

/** いま前に出ている列のタブが `name` になるまで待つ（キーで話が移ったことを、面でなくタブで確かめる） */
async function waitFrontTab(page: Page, name: string, label: string): Promise<void> {
  await waitUntil(async () => tabNamesInclude(await activeTabNames(page), name), label, 20_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（列とタブ：${JSON.stringify(await editorGroupTabs(page))}／知らせ：${JSON.stringify(await notificationTexts(page))}）`);
  });
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
      /*
        **話が移ったことは、前に出たタブと「前に出ている面」で確かめる。** 原稿エディターは裏に
        回っても面が残る（retainContextWhenHidden）ので、「本文を描いた面がある」だけを待つと、
        移る前からあった裏の面を即座に返す。その面の #compose を押すと、前にある面の iframe が
        押下を受け止めて30秒押し直した（ノートPC・1.141.0、2026-10-11。見込みは、最終話へ戻る
        Alt+↓ の前に第1話の面へ焦点を入れておらず、第2話が前に出ないまま裏の面を押しに行ったこと。
        写真が無いので、次に落ちたら下の待ちの文〔列とタブ・WebView の重なり〕で確かめる）
      */
      await page.keyboard.press("Alt+ArrowDown");
      await waitFrontTab(page, LAST, "Alt+↓ で第2話のタブが前に出る");
      const last = await frontFrameShowing(page, "第2話の本文", "Alt+↓ で第2話の面が前に出る");

      // ── Alt+↑ で第1話へ戻ると、打った字が残っている ──
      await placeCaretAfter(last, "夜が来た。");
      await page.keyboard.press("Alt+ArrowUp");
      await waitFrontTab(page, FIRST, "Alt+↑ で第1話のタブが前に出る");
      const firstAgain = await frontFrameShowing(page, "朝が来た。甲", "Alt+↑ で戻った第1話に、移る前に打った字が残っている");

      // ── 最終話（第2話）で Alt+↓ ──
      // キーは焦点のある面が受ける。作者と同じく、いま前にある第1話の本文に焦点を入れてから押す
      await placeCaretAfter(firstAgain, "朝が来た。甲");
      await clearNotifications(page);
      await page.keyboard.press("Alt+ArrowDown");
      await waitFrontTab(page, LAST, "もう一度 Alt+↓ で第2話のタブが前に出る");
      const lastAgain = await frontFrameShowing(page, "第2話の本文", "もう一度 Alt+↓ で第2話の面が前に出る");
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
