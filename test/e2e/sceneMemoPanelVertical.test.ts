/**
 * 縦書きで開いている話でも、校正・メモパネルの行を押すと左の原稿へ戻ってその行を示し、
 * 右の列に同じ話の2枚目を作らず、左も空白にならない（画面の自動テスト、設計書6.113・6.25.11）。
 *
 * 実機確認リスト 0.96.7「パネルの行から同じ話が2枚開く」の残り（**縦書きで開いている話は
 * 見ていない**）を 2026-10-11 に移した（作者の指示「機械でできる実機確認」）。
 * 横書きは `sceneMemoPanel.test.ts`、提案パネルの行は横書きが `proposalApply.test.ts`、
 * 縦書きが `findingJumpVertical.test.ts` が見ている。
 *
 * **AI は呼ばない。** メモ（`//` の行）は話の本文に初めから書いておく。
 */
import { expect, test } from "vitest";
import {
  caretPosition,
  composeText,
  manuscriptFrames,
  memoPanelFrame,
  openEpisode,
  placeCaretAfter,
  selectionCollapsed,
} from "./support/manuscriptFrame";
import { isVerticalFace, turnVertical, VERTICAL_LAUNCH } from "./support/verticalFace";
import { withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { countTabsNamed, editorGroupTabs, tabNamesInclude } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "一行目の文。\n二行目の文。\n// 見張りのメモ\n四行目の文。\n五行目の文。\n";

test("縦書きの原稿でも、校正・メモパネルの行を押すと左の原稿へ戻ってその行を示し、縦書きのまま、右に2枚目を作らず、左も空白にならない", async () => {
  await withVsCode(
    "メモパネルの行（縦書き）",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await openEpisode(page, EPISODE, "五行目の文");
      const vertical = await turnVertical(session, "五行目の文");

      // 原稿の中から Ctrl+Alt+M で、校正・メモパネルを原稿の横（右の列）に開く
      await placeCaretAfter(vertical, "一行目");
      await page.keyboard.press("Control+Alt+KeyM");
      let panel = await memoPanelFrame(page);
      await waitUntil(async () => {
        panel = await memoPanelFrame(page);
        return panel !== undefined && (await panel.locator("button.go").count()) > 0;
      }, "校正・メモパネルにメモの行が出る", 30_000);
      if (!panel) throw new Error("校正・メモパネルが見つかりません");

      const groupsBefore = await editorGroupTabs(page);
      expect(groupsBefore.length, `列が2つになっていません：${JSON.stringify(groupsBefore)}`).toBe(2);
      expect(tabNamesInclude(groupsBefore[0], EPISODE)).toBe(true);
      expect(tabNamesInclude(groupsBefore[1], EPISODE)).toBe(false);

      // パネルの行（メモ）を押す
      await panel.locator("button.go").first().click();

      // 左の原稿へカーソルが戻り、メモの行が示される
      await waitUntil(
        async () => {
          for (const candidate of await manuscriptFrames(page)) {
            if (((await caretPosition(candidate))?.lineText ?? "").includes("見張りのメモ")) return true;
          }
          return false;
        },
        "原稿エディターのカーソルがメモの行へ動く",
        15_000
      );

      // **右の列に同じ話が増えない・左が空白にならない**。遅れて開く2枚目も見逃さないよう見続ける
      const describe = async () =>
        `列とタブ：${JSON.stringify(await editorGroupTabs(page))}／原稿の面：${(await manuscriptFrames(page)).length}枚`;
      await holdsFor(async () => {
        const groups = await editorGroupTabs(page);
        return countTabsNamed(groups.flat(), EPISODE) === 1 && groups.length >= 1 && tabNamesInclude(groups[0], EPISODE);
      }, "原稿のタブが左の列に1枚だけ").catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describe()}）`);
      });

      const frames = await manuscriptFrames(page);
      expect(frames.length, await describe()).toBe(1);
      const shown = await composeText(frames[0]);
      expect(shown, "左の原稿が空白になりました").toContain("一行目の文。");
      expect(shown).toContain("五行目の文。");
      // 縦書きのまま（横書きの面に替わっていない）
      expect(await isVerticalFace(frames[0]), "パネルから飛んだら横書きになりました").toBe(true);
      // 示された行は選ばれず、カーソルだけ（作者の裁定、2026-10-03）
      expect(await selectionCollapsed(frames[0]), "パネルから飛んだ先で行が選ばれています").toBe(true);
    },
    VERTICAL_LAUNCH
  );
});
