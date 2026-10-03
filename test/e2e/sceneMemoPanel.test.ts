/**
 * 校正・メモパネルの行を押しても、原稿の2枚目ができず、左の原稿が空白にならない
 * （画面の自動テスト、設計書6.113・6.25.11）。
 *
 * 2026-10-03 に作者の画面で3回起きた不具合の見張り：左に原稿・右に校正・メモパネルを
 * 置いてパネルの行を押すと、**右の列に同じ話の原稿がもう1枚開き、左の原稿が真っ白に**
 * なった。何が起きるべきか——左の原稿エディターへ戻ってその行を示し、右には増やさない。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  caretPosition,
  composeText,
  manuscriptFrames,
  memoPanelFrame,
  openEpisode,
  placeCaretAfter,
} from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { editorGroupTabs } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "一行目の文。\n二行目の文。\n// 見張りのメモ\n四行目の文。\n五行目の文。\n";

test("校正・メモパネルの行を押すと、左の原稿へ戻ってその行を示し、右に2枚目を作らず、左も空白にならない", async () => {
  await withVsCode("メモパネルの行", [{ name: EPISODE, text: TEXT }], async (session) => {
    const { page } = session;
    const frame = await openEpisode(page, EPISODE, "五行目の文");

    // 原稿の中から Ctrl+Alt+M で、校正・メモパネルを原稿の横（右の列）に開く
    await placeCaretAfter(frame, "一行目");
    await page.keyboard.press("Control+Alt+KeyM");
    let panel = await memoPanelFrame(page);
    await waitUntil(async () => {
      panel = await memoPanelFrame(page);
      return panel !== undefined && (await panel.locator("button.go").count()) > 0;
    }, "校正・メモパネルにメモの行が出る", 30_000);
    if (!panel) throw new Error("校正・メモパネルが見つかりません");

    const groupsBefore = await editorGroupTabs(page);
    expect(groupsBefore.length, `列が2つになっていません：${JSON.stringify(groupsBefore)}`).toBe(2);
    expect(groupsBefore[0]).toContain(EPISODE);
    expect(groupsBefore[1]).not.toContain(EPISODE);

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

    // **右の列に同じ話が増えない・左が空白にならない**。少し遅れて開く2枚目も見逃さないよう、
    // しばらく見続ける
    const describe = async () =>
      `列とタブ：${JSON.stringify(await editorGroupTabs(page))}／原稿の面：${
        (await manuscriptFrames(page)).length
      }枚`;
    await holdsFor(async () => {
      const groups = await editorGroupTabs(page);
      const tabsOfEpisode = groups.flat().filter((name) => name === EPISODE).length;
      return tabsOfEpisode === 1 && groups.length >= 1 && groups[0].includes(EPISODE);
    }, "原稿のタブが左の列に1枚だけ").catch(async (error: unknown) => {
      throw new Error(`${String(error)}（${await describe()}）`);
    });

    const frames = await manuscriptFrames(page);
    expect(frames.length, await describe()).toBe(1);
    const shown = await composeText(frames[0]);
    expect(shown, "左の原稿が空白になりました").toContain("一行目の文。");
    expect(shown).toContain("五行目の文。");

    // 念押し：示された行で字を打つと、その行に入る（焦点が左の原稿へ戻っていて、
    // 2枚目へ打っていない）。示された行は行ごと選ばれているので、End で畳んでから打つ
    await page.keyboard.press("End");
    await page.keyboard.insertText("印");
    await page.keyboard.press("Control+KeyS");
    const file = path.join(session.manuscriptFolder, EPISODE);
    await waitUntil(async () => (await readFile(file, "utf8")).includes("印"), "示された行で打った字がファイルに入る");
    const lines = (await readFile(file, "utf8")).replace(/\r\n/g, "\n").split("\n");
    expect(lines[2]).toMatch(/見張りのメモ/);
    expect(lines[2]).toContain("印");
  });
});
