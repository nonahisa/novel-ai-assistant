/**
 * 提案パネルの［適用］を、原稿エディターで話を開いたまま押す（画面の自動テスト、設計書6.113）。
 *
 * 2026-10-03、広報の動画を撮っていて見つかった不具合の見張り：［適用］のたびに、
 * **原稿の列に同じ話の素のテキストエディター（行番号つき）のタブがもう1枚開き**、
 * 原稿エディターがその下に隠れていた。適用のあとの読み直し（提案パネルの
 * `revertIfOpen`）が、原稿エディターの抱える文書まで `showTextDocument`
 * （常に素のエディターで開く）へ渡していたため。
 *
 * 確かめること：
 * - 原稿の列のタブは1枚のまま（どの列にも、同じ話のタブが2枚目として増えない）
 * - 原稿エディターの本文が、直した字になる（読み直しが原稿エディターへ届く）
 * - 確認の窓は出ない
 *
 * **AI は呼ばない。** 校正の指摘は `.aiwriter/findings.jsonl` へ見本を置く
 * （広報の台本 `promo/fixScene.promo.ts` と同じ手。あちらは撮影用で、検査には入らない）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, manuscriptFrames, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  writeSampleFinding as placeFinding,
} from "./support/sampleFinding";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, dialogText, editorGroupTabs } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　近づいてみると、男は以外にも若かった。", "　ホームの時計が、零時を指していた。", ""].join("\n");

const ORIGINAL = "男は以外にも若かった。";
const FIXED = "男は意外にも若かった。";

/** 見本の指摘を、製品が読む形（`.aiwriter/findings.jsonl`。models/finding.ts）で置く */
async function writeSampleFinding(workFolder: string): Promise<void> {
  await placeFinding(workFolder, {
    episode: EPISODE,
    text: TEXT,
    original: ORIGINAL,
    target: "以外",
    suggestion: "意外",
    message: "「思いのほか」の意味なら「意外」です",
  });
}

/** その話のタブが、どの列にいくつあるか */
async function episodeTabCount(page: Page): Promise<{ count: number; groups: string[][] }> {
  const groups = await editorGroupTabs(page);
  const count = groups.flat().filter((name) => name === EPISODE).length;
  return { count, groups };
}

test("原稿エディターで開いたまま提案パネルの［適用］を押すと、本文が直り、同じ話のタブは増えない", async () => {
  await withVsCode("提案の適用", [{ name: EPISODE, text: TEXT }], async (session) => {
    const { page } = session;
    await writeSampleFinding(session.workFolder);
    const frame = await openEpisode(page, EPISODE, "零時を指していた");
    await placeCaretAfter(frame, "終電を逃した");

    /*
      提案パネル（右の列）を開く。開いたときに置き場の指摘が並ぶ（`primeSavedFindings`）。
      0.97.7 までは校正・メモパネルの［直す］で渡していたが、0.97.8 から［直す］は
      1手で本文へ当てる（作者の裁定 2026-10-03。そちらは `memoFixOneStep.test.ts`）
    */
    await clearNotifications(page);
    await page.keyboard.press(OPEN_PROPOSALS_PRESS);

    let proposals: Frame | undefined;
    await waitUntil(
      async () => {
        proposals = await proposalPanelFrame(page);
        return proposals !== undefined && (await proposals.locator('button[data-action="apply"]').count()) > 0;
      },
      "提案パネルに［適用］が並ぶ",
      15_000
    );
    if (!proposals) throw new Error("提案パネルが見つかりません");

    const before = await episodeTabCount(page);
    expect(before.count, `［適用］の前から同じ話のタブが重なっています: ${JSON.stringify(before.groups)}`).toBe(1);

    await proposals.locator('button[data-action="apply"]').first().click();

    const file = path.join(session.manuscriptFolder, EPISODE);
    await waitUntil(
      // 書き込みは「退避 → 新規作成」なので、その合間はファイルが無い。無いあいだは待つ
      async () => (await readFile(file, "utf8").catch(() => "")).includes(FIXED),
      "直した字がファイルに入る"
    );
    // 原稿エディターの面にも、直した字が出る（読み直しが原稿エディターへ届く）
    await waitUntil(
      async () => {
        for (const candidate of await manuscriptFrames(page)) {
          if ((await composeText(candidate)).includes(FIXED)) return true;
        }
        return false;
      },
      "原稿エディターの本文が直した字になる",
      15_000
    );
    expect(await dialogText(page), "思いがけず確認の窓が出ています").toBeUndefined();

    // 読み直しの道が素のタブを開くなら、ここまでに開いている。少し待ってから数える
    // （開く途中で数えて見逃さないよう、数が落ち着くまで数回見る）
    let after = await episodeTabCount(page);
    for (let i = 0; i < 5; i += 1) {
      await page.waitForTimeout(300);
      after = await episodeTabCount(page);
      if (after.count > 1) break;
    }
    expect(after.count, `［適用］のあと、同じ話のタブが重なって開きました: ${JSON.stringify(after.groups)}`).toBe(1);
    // 原稿エディターの面も1枚のまま
    expect((await manuscriptFrames(page)).length).toBe(1);
    // ファイルの残りの行は変わっていない
    expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe(TEXT.replace(ORIGINAL, FIXED));
  }, OPEN_PROPOSALS_LAUNCH);
});
