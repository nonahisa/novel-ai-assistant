/**
 * 校正・メモパネルの［直す］1手で本文が直る（画面の自動テスト、設計書6.96.5・6.113）。
 *
 * 作者の裁定（2026-10-03）「［直す］1手で本文が直る」。作者が確かめた条件を見張る：
 *
 * 1. 直したあと、**提案パネルを開いていれば、その指摘がすぐ消える**
 *    （未処理から消える＝［適用］が無くなり「適用済み・［戻す］」になる。残り0件）
 * 2. 提案パネルを開いていなくても、**あとで開いたときに［適用］で出てこない**
 * 3. **［戻す］で元に戻したら、両方の画面に戻る**——校正・メモパネルの［戻す］でも、
 *    提案パネルの［戻す］でも
 * 4. 直したあと、校正・メモパネルの一覧からも消える
 *
 * 当てる道は提案パネルの［適用］と同じ関数なので、採否の記録（置き場の判断の行と
 * `history/ai-verdicts.jsonl`）も同じに残る。原稿の列に素のタブが増えないことも見る
 * （0.97.7 と同じ見張り）。
 *
 * **AI は呼ばない。** 指摘は `.aiwriter/findings.jsonl` へ見本を置く。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, manuscriptFrames, memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  readJsonLines,
  sampleFindingId,
  writeSampleFinding,
  type SampleFinding,
} from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, dialogText, editorGroupTabs } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　近づいてみると、男は以外にも若かった。", "　ホームの時計が、零時を指していた。", ""].join("\n");
const FIXED_TEXT = TEXT.replace("男は以外にも若かった。", "男は意外にも若かった。");

const SAMPLE: SampleFinding = {
  episode: EPISODE,
  text: TEXT,
  original: "男は以外にも若かった。",
  target: "以外",
  suggestion: "意外",
  message: "「思いのほか」の意味なら「意外」です",
  // 採った数を、出したモデルへ数える（6.49.7）
  producer: { providerId: "ollama", model: "gemma4:e4b" },
};

const LAUNCH = OPEN_PROPOSALS_LAUNCH;

/** 本文のファイル（書き込みは「退避 → 新規作成」なので、その合間は無い。無ければ空） */
async function fileText(session: E2ESession): Promise<string> {
  const raw = await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "");
  return raw.replace(/\r\n/g, "\n");
}

/** 原稿エディターの面に、その文が出るまで待つ */
async function waitManuscriptShows(page: Page, needle: string, what: string): Promise<void> {
  await waitUntil(
    async () => {
      for (const frame of await manuscriptFrames(page)) {
        if ((await composeText(frame)).includes(needle)) return true;
      }
      return false;
    },
    what,
    15_000
  );
}

/** 面の中の押し口の数（隠れている面でも数えられる——`retainContextWhenHidden`） */
async function countIn(frame: Frame, selector: string): Promise<number> {
  return frame.evaluate((query) => document.querySelectorAll(query).length, selector);
}

/** 校正・メモパネルの［戻す］の帯が出ているか */
async function undoBarShown(memo: Frame): Promise<boolean> {
  return memo.evaluate(() => {
    const bar = document.getElementById("fixed");
    return bar !== null && !bar.hidden;
  });
}

/** 提案パネルの見出しの残り件数（「0件」など） */
async function proposalCount(proposals: Frame): Promise<string> {
  return proposals.evaluate(() => document.getElementById("count")?.textContent ?? "");
}

async function openMemoPanel(page: Page): Promise<Frame> {
  await page.keyboard.press("Control+Alt+KeyM");
  let memo: Frame | undefined;
  await waitUntil(
    async () => {
      memo = await memoPanelFrame(page);
      return memo !== undefined && (await countIn(memo, 'button[data-act="fix"]')) > 0;
    },
    "校正・メモパネルに指摘の［直す］が並ぶ",
    30_000
  );
  if (!memo) throw new Error("校正・メモパネルが見つかりません");
  return memo;
}

async function openProposals(page: Page): Promise<Frame> {
  await page.keyboard.press(OPEN_PROPOSALS_PRESS);
  let proposals: Frame | undefined;
  await waitUntil(
    async () => {
      proposals = await proposalPanelFrame(page);
      // 一覧が描かれた目印：その話の行（［適用］か［戻す］）が並ぶ
      return (
        proposals !== undefined &&
        (await countIn(proposals, 'button[data-action="apply"], button[data-action="undo"]')) > 0
      );
    },
    "提案パネルに指摘の行が並ぶ",
    15_000
  );
  if (!proposals) throw new Error("提案パネルが見つかりません");
  return proposals;
}

/** 右の列で、校正・メモパネルのタブを前へ出す（提案パネルが同じ列へ重なるため） */
async function bringMemoToFront(page: Page): Promise<void> {
  await page.locator(".tabs-container .tab", { hasText: "校正・メモパネル" }).first().click();
}

/** 置き場（findings.jsonl）の判断の行の状態を、古い順に */
async function decisions(session: E2ESession): Promise<string[]> {
  const lines = await readJsonLines(path.join(session.workFolder, ".aiwriter", "findings.jsonl"));
  const id = sampleFindingId(SAMPLE);
  return lines
    .filter((line) => line.kind === "decision" && line.findingId === id)
    .map((line) => String(line.status));
}

/** 採った数の記録（history/ai-verdicts.jsonl）の状態を、古い順に */
async function verdicts(session: E2ESession): Promise<string[]> {
  const lines = await readJsonLines(path.join(session.workFolder, ".aiwriter", "history", "ai-verdicts.jsonl"));
  return lines.map((line) => String(line.status));
}

async function episodeTabCount(page: Page): Promise<number> {
  return (await editorGroupTabs(page)).flat().filter((name) => name === EPISODE).length;
}

test("提案パネルを開いたまま［直す］を押すと、1手で本文が直り、提案パネルからも消え、［戻す］で両方に戻る", async () => {
  await withVsCode(
    "校正・メモの直す（提案パネルあり）",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, SAMPLE);
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");

      const memo = await openMemoPanel(page);
      await clearNotifications(page);
      const proposals = await openProposals(page);
      // 開いた時点では、まだ［適用］で並んでいる
      expect(await countIn(proposals, 'button[data-action="apply"]')).toBe(1);

      // 提案パネルは校正・メモパネルと同じ列に重なる。校正・メモパネルを前へ出して押す
      await bringMemoToFront(page);
      await memo.locator('button[data-act="fix"]').first().click();

      // ── 1手で本文が直る ──
      await waitUntil(async () => (await fileText(session)) === FIXED_TEXT, "直した字がファイルに入る");
      await waitManuscriptShows(page, "男は意外にも若かった。", "原稿エディターの本文が直した字になる");
      expect(await dialogText(page), "思いがけず確認の窓が出ています").toBeUndefined();

      // ── 条件1：提案パネルから、すぐ消える（未処理から外れ「適用済み・［戻す］」）──
      await waitUntil(
        async () =>
          (await countIn(proposals, 'button[data-action="apply"]')) === 0 &&
          (await countIn(proposals, 'button[data-action="undo"]')) === 1,
        "提案パネルの行が適用済みになる",
        10_000
      );
      expect(await proposalCount(proposals)).toBe("0件");

      // ── 条件4：校正・メモパネルの一覧からも消え、［戻す］の帯が出る ──
      await waitUntil(
        async () => (await countIn(memo, 'button[data-act="fix"]')) === 0 && (await undoBarShown(memo)),
        "校正・メモパネルから指摘が消え、［戻す］が出る",
        10_000
      );

      // 記録は［適用］と同じ（置き場の「採った」と、採った数）
      expect(await decisions(session)).toEqual(["accepted"]);
      expect(await verdicts(session)).toEqual(["accepted"]);
      // 原稿の列に素のタブは増えない
      expect(await episodeTabCount(page)).toBe(1);
      expect((await manuscriptFrames(page)).length).toBe(1);

      // ── 条件3：校正・メモパネルの［戻す］で、両方の画面に戻る ──
      await memo.locator("#undoFix").click();
      await waitUntil(async () => (await fileText(session)) === TEXT, "本文が元へ戻る");
      await waitManuscriptShows(page, "男は以外にも若かった。", "原稿エディターの本文が元へ戻る");
      await waitUntil(
        async () => (await countIn(memo, 'button[data-act="fix"]')) === 1 && !(await undoBarShown(memo)),
        "校正・メモパネルに指摘がまた並び、帯が消える",
        10_000
      );
      await waitUntil(
        async () =>
          (await countIn(proposals, 'button[data-action="apply"]')) === 1 &&
          (await countIn(proposals, 'button[data-action="undo"]')) === 0,
        "提案パネルに［適用］でまた並ぶ",
        10_000
      );
      expect(await decisions(session)).toEqual(["accepted", "pending"]);
      expect(await verdicts(session)).toEqual(["accepted", "retracted"]);
      expect(await episodeTabCount(page)).toBe(1);
    },
    LAUNCH
  );
});

test("提案パネルを開かずに［直す］を押すと、あとで開いても［適用］で出てこず、提案パネルの［戻す］で両方に戻る", async () => {
  await withVsCode(
    "校正・メモの直す（提案パネルなし）",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, SAMPLE);
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");

      const memo = await openMemoPanel(page);
      await clearNotifications(page);
      expect(await proposalPanelFrame(page), "提案パネルが先に開いています").toBeUndefined();

      await memo.locator('button[data-act="fix"]').first().click();
      await waitUntil(async () => (await fileText(session)) === FIXED_TEXT, "直した字がファイルに入る");
      await waitUntil(
        async () => (await countIn(memo, 'button[data-act="fix"]')) === 0,
        "校正・メモパネルから指摘が消える",
        10_000
      );
      // ［直す］は提案パネルを前へ出さない（1手で済ませる裁定）
      expect(await proposalPanelFrame(page), "［直す］で提案パネルが開きました").toBeUndefined();

      // ── 条件2：あとで開いても、［適用］では出てこない（適用済み・［戻す］）──
      const proposals = await openProposals(page);
      expect(await countIn(proposals, 'button[data-action="apply"]')).toBe(0);
      expect(await countIn(proposals, 'button[data-action="undo"]')).toBe(1);
      expect(await proposalCount(proposals)).toBe("0件");

      // ── 条件3：提案パネルの［戻す］でも、両方の画面に戻る ──
      await proposals.locator('button[data-action="undo"]').first().click();
      await waitUntil(async () => (await fileText(session)) === TEXT, "本文が元へ戻る");
      await waitUntil(
        async () => (await countIn(proposals, 'button[data-action="apply"]')) === 1,
        "提案パネルに［適用］でまた並ぶ",
        10_000
      );
      await waitUntil(
        async () => (await countIn(memo, 'button[data-act="fix"]')) === 1 && !(await undoBarShown(memo)),
        "校正・メモパネルに指摘がまた並び、［戻す］の帯が消える",
        10_000
      );
      expect(await decisions(session)).toEqual(["accepted", "pending"]);
      expect(await episodeTabCount(page)).toBe(1);
    },
    LAUNCH
  );
});
