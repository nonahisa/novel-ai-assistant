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
 * あわせて（実機確認リストを機械へ移した分、2026-10-03）：
 * - 提案パネルの行（場所）を押すと、左の原稿エディターのその行へ戻り、2枚目を作らない（0.96.7）
 * - 同じ並びで［戻す］を押すと、素のタブが開かず、原稿エディターの本文が元の字に戻る（0.97.7）
 *
 * **AI は呼ばない。** 校正の指摘は `.aiwriter/findings.jsonl` へ見本を置く
 * （広報の台本 `promo/fixScene.promo.ts` と同じ手。あちらは撮影用で、検査には入らない）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { caretPosition, composeText, manuscriptFrames, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  writeSampleFinding as placeFinding,
} from "./support/sampleFinding";
import { withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  dialogText,
  editorGroupTabs,
  focusTextEditor,
  quickOpen,
  textEditorCursor,
  textEditorVisibleText,
  textEditorVisibleTextIn,
} from "./support/workbenchDom";

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

test("原稿エディターで開いたまま提案パネルの行・［適用］・［戻す］を押すと、本文と画面が追い、同じ話のタブは増えない", async () => {
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

    /*
      ── 提案パネルの行（場所）を押す（実機確認リスト 0.96.7）──
      左の原稿エディターへ戻ってその行を示し、右に同じ話を増やさず、左も空白にしない
    */
    await proposals.locator('.location[data-action="jump"]').first().click();
    await waitUntil(
      async () => ((await caretPosition(frame))?.lineText ?? "").includes("以外にも"),
      "提案パネルの行を押すと、原稿エディターのカーソルが指摘の行へ動く",
      15_000
    );
    await holdsFor(async () => (await episodeTabCount(page)).count === 1, "提案パネルの行を押したあとも同じ話のタブが1枚").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（${JSON.stringify((await episodeTabCount(page)).groups)}）`);
      }
    );
    expect((await manuscriptFrames(page)).length).toBe(1);
    expect(await composeText(frame), "提案パネルの行を押したら左の原稿が空白になりました").toContain("零時を指していた");

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

    /*
      ── 同じ並びで［戻す］（実機確認リスト 0.97.7）──
      ［戻す］のあとの読み直しも［適用］と同じ道を通る。素のタブが開かず、
      原稿エディターの面に元の字が戻ることを見る（ファイルだけ戻って
      画面が直した字のまま、という形を見逃さないため）
    */
    const undo = proposals.locator('button[data-action="undo"]');
    await waitUntil(async () => (await undo.count()) === 1, "提案パネルに［戻す］が出る", 10_000);
    await undo.first().click();
    await waitUntil(
      async () => (await readFile(file, "utf8").catch(() => "")).replace(/\r\n/g, "\n") === TEXT,
      "［戻す］で本文のファイルが元に戻る"
    );
    await waitUntil(
      async () => {
        for (const candidate of await manuscriptFrames(page)) {
          if ((await composeText(candidate)).includes(ORIGINAL)) return true;
        }
        return false;
      },
      "原稿エディターの本文が元の字に戻る",
      15_000
    );
    expect(await dialogText(page), "［戻す］で思いがけず確認の窓が出ています").toBeUndefined();
    await holdsFor(async () => (await episodeTabCount(page)).count === 1, "［戻す］のあとも同じ話のタブが1枚").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（${JSON.stringify((await episodeTabCount(page)).groups)}）`);
      }
    );
    expect((await manuscriptFrames(page)).length).toBe(1);
  }, OPEN_PROPOSALS_LAUNCH);
});

test("素のテキストエディターで開いているときの［適用］は今までどおり：本文が直り、タブは増えず、カーソルは元の行に残る", async () => {
  await withVsCode(
    "素のエディターで提案の適用",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder);
      await quickOpen(page, EPISODE);
      await waitUntil(async () => (await textEditorVisibleText(page)).includes("零時を指していた"), "素のエディターで話が開く", 20_000);
      // カーソルを3行目の頭に置く（適用する2行目の隣）
      await focusTextEditor(page);
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await waitUntil(async () => (await textEditorCursor(page))?.line === 3, "カーソルが3行目に来る", 5_000);

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
      await proposals.locator('button[data-action="apply"]').first().click();

      const file = path.join(session.manuscriptFolder, EPISODE);
      await waitUntil(
        async () => (await readFile(file, "utf8").catch(() => "")).replace(/\r\n/g, "\n") === TEXT.replace(ORIGINAL, FIXED),
        "直した字がファイルに入る"
      );
      expect(await dialogText(page), "思いがけず確認の窓が出ています").toBeUndefined();
      // 素のエディターの表示も直した字になり、同じ話のタブは1枚のまま（提案パネルの列へ増えない）
      await waitUntil(async () => (await textEditorVisibleTextIn(page, 0)).includes(FIXED), "素のエディターの本文が直した字になる", 10_000);
      await holdsFor(async () => (await episodeTabCount(page)).count === 1, "［適用］のあとも同じ話のタブが1枚").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（${JSON.stringify((await episodeTabCount(page)).groups)}）`);
        }
      );
      // 原稿エディターは開かない（素のエディターのまま）
      expect((await manuscriptFrames(page)).length).toBe(0);

      // カーソルは読み直しの前の位置（3行目）に残る。左の列へ焦点を戻して読む
      // （押すとカーソルが動くので、キーで列へ戻る）
      await page.keyboard.press("Control+1");
      await waitUntil(async () => (await textEditorCursor(page))?.line === 3, "［適用］のあともカーソルが3行目に残る", 5_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（カーソル：${JSON.stringify(await textEditorCursor(page))}）`);
        }
      );
    },
    {
      ...OPEN_PROPOSALS_LAUNCH,
      // 原稿を素のエディターで開く（既定の起こし方の関連付けを消す）
      settings: { "workbench.editorAssociations": {} },
    }
  );
});
