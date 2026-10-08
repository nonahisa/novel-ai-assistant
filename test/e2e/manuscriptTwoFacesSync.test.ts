/**
 * 同じ話を横書き・縦書きの2つのタブで並べて開き、片方で直すともう片方の画面にも出る
 * （画面の自動テスト、設計書6.25.11・6.113）。
 *
 * 実機確認リスト A-20 の「同じ話を横書き・縦書きの2つのタブで開き、片方で直したとき
 * もう片方がどうなるか」を機械へ移したもの。2枚目は、作者が「エディターを右へ分割」で
 * 作る道（縦と横を並べて見比べたい作者もいる、と6.25.11にある）で作る。
 *
 * - 2枚の面が同じ話を出す（1枚は縦書き、1枚は横書き）
 * - 横書きで打った字が、保存の前に縦書きの面にも出る（同じ文書を見ているので）
 * - 縦書きで打った字が、横書きの面にも出る
 * - 保存すると、両方の字が1つのファイルに入る（片方が古い中身のまま書いて巻き戻さない）
 *
 * **作者の原稿は使わない。AI は呼ばない。**
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, manuscriptFrames, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { isVerticalFace } from "./support/verticalFace";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = "001_並べて開く.md";
const TEXT = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";

const SPLIT_KEY = "ctrl+alt+shift+o";
const SPLIT_PRESS = "Control+Alt+Shift+KeyO";

async function readEpisode(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

test("同じ話を縦書きと横書きの2枚で開いて、片方で打った字がもう片方にも出て、保存すると両方の字がファイルに入る", async () => {
  await withVsCode(
    "縦横2枚の同期",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const first = await openEpisode(page, EPISODE, "改札を抜けて");

      // 右へ分割して、同じ話の2枚目を作る
      await pressWorkbenchKey(page, SPLIT_PRESS);
      let second: Frame | undefined;
      await waitUntil(
        async () => {
          const frames = await manuscriptFrames(page);
          if (frames.length < 2) return false;
          second = frames.find((frame) => frame !== first);
          return second !== undefined && (await composeText(second).catch(() => "")).includes("改札を抜けて");
        },
        "同じ話の2枚目が開いて本文が出る",
        20_000
      );
      const right = second as Frame;

      // 2枚目を縦書きにする（1枚目は横書きのまま）
      await right.locator("#dir").click();
      await waitUntil(async () => await isVerticalFace(right), "2枚目が縦書きになる");
      expect(await isVerticalFace(first), "1枚目は横書きのまま").toBe(false);

      // 横書き（1枚目）で打つ → 保存の前に、縦書き（2枚目）にも出る
      await placeCaretAfter(first, "朝の駅は静かだった。");
      await page.keyboard.insertText("【横で足した】");
      await waitUntil(async () => (await composeText(first)).includes("【横で足した】"), "横書きの面に打った字が出る");
      await waitUntil(
        async () => (await composeText(right)).includes("【横で足した】"),
        "縦書きの面にも、横書きで打った字が出る"
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（縦書きの面の本文：${JSON.stringify(await composeText(right))}）`);
      });

      // 縦書き（2枚目）で打つ → 横書き（1枚目）にも出る
      await placeCaretAfter(right, "白い息を吐いた。");
      await page.keyboard.insertText("【縦で足した】");
      await waitUntil(async () => (await composeText(right)).includes("【縦で足した】"), "縦書きの面に打った字が出る");
      await waitUntil(
        async () => (await composeText(first)).includes("【縦で足した】"),
        "横書きの面にも、縦書きで打った字が出る"
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（横書きの面の本文：${JSON.stringify(await composeText(first))}）`);
      });
      // 先に打った字が、あとの字で巻き戻っていない
      expect(await composeText(first)).toContain("【横で足した】");
      expect(await composeText(right)).toContain("【横で足した】");

      // 保存すると、両方の字が1つのファイルに入る（ファイルで見る）
      await page.keyboard.press("Control+KeyS");
      await waitUntil(
        async () => {
          const text = await readEpisode(session);
          return text.includes("【横で足した】") && text.includes("【縦で足した】");
        },
        "両方で打った字がファイルに入る"
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（ファイル：${JSON.stringify(await readEpisode(session))}）`);
      });
    },
    { keybindings: [{ key: SPLIT_KEY, command: "workbench.action.splitEditorRight" }] }
  );
}, 180_000);
