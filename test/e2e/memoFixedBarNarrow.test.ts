/**
 * 校正・メモパネルの「直しました［戻す］」の帯で、長い修正案でも［戻す］が縦に折れない
 * （画面の自動テスト、設計書6.113。実機確認リスト 95 行の写真、2026-10-09）。
 *
 * 写真：長い推敲（約70字の置き換え）を［直す］で当てると、帯の文は4行に折り返して読めたが、
 * 右端の［戻す］が「戻／す」と2行に割れていた。帯は横並び（flex）で、文の側だけでなく
 * ボタンの側も縮められていたため。
 *
 * 確かめること：長い修正案を当てたあと、［戻す］の字は1行に収まり、帯の文のほうが折り返す。
 *
 * **AI は呼ばない。** 指摘は `.aiwriter/findings.jsonl` へ製品と同じ形で置く。
 */
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { writeSampleFinding } from "./support/sampleFinding";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　ホームの時計が、零時を指していた。",
  "",
].join("\n");

const LONG_SUGGESTION =
  "ホームの大きな時計の針は、まるで時間そのものがそこで止まってしまったかのように、ちょうど零時の真上を静かに、しかしはっきりと指していた。";

async function openMemoPanel(page: Page): Promise<Frame> {
  await page.keyboard.press("Control+Alt+KeyM");
  let memo: Frame | undefined;
  await waitUntil(
    async () => {
      memo = await memoPanelFrame(page);
      return memo !== undefined && (await memo.locator('button[data-act="fix"]').count()) >= 1;
    },
    "校正・メモパネルに［直す］のある行が並ぶ",
    30_000
  );
  if (!memo) throw new Error("校正・メモパネルが見つかりません");
  return memo;
}

/** 要素の中の字が、何行に並んでいるか（字の箱の上端の種類を数える） */
async function textLines(frame: Frame, id: string): Promise<number> {
  return frame.evaluate((id) => {
    const element = document.getElementById(id);
    if (!element) return -1;
    const range = document.createRange();
    range.selectNodeContents(element);
    const tops = new Set(
      Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0)
        .map((rect) => Math.round(rect.top))
    );
    return tops.size;
  }, id);
}

test("長い修正案を当てても、帯の［戻す］は1行のまま（文のほうが折り返す）", async () => {
  await withVsCode(
    "校正・メモパネル・帯の戻す",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, {
        episode: EPISODE,
        text: TEXT,
        original: "ホームの時計が、零時を指していた。",
        target: "ホームの時計が、零時を指していた。",
        suggestion: LONG_SUGGESTION,
        message: "情景を足して、時間が止まった感じを出せます",
        category: "proofread",
        label: "推敲",
      });
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");
      const memo = await openMemoPanel(page);
      await clearNotifications(page);

      await memo.locator('button[data-act="fix"]').first().click();
      await waitUntil(
        async () =>
          (await memo.locator("#fixed").isVisible()) &&
          (await memo.locator("#fixedText").innerText()).includes("止まって"),
        "長い修正案の帯が出る"
      );

      const undoLines = await textLines(memo, "undoFix");
      const textLineCount = await textLines(memo, "fixedText");
      // 写真と同じ形（帯の文が折り返すほど長い）になっていることを先に確かめる
      expect(textLineCount, "帯の文が折り返していません（見本が短すぎます）").toBeGreaterThanOrEqual(2);
      expect(undoLines, "［戻す］の字が縦に折れています").toBe(1);
    },
    { windowSize: { width: 1280, height: 800 } }
  );
});
