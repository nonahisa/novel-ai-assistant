/**
 * 提案パネルの「当てたもの」から［戻す］（画面の自動テスト、設計書6.96.5・6.115・6.113）。
 *
 * 作者の裁定（2026-10-04）「提案パネルに『当てたもの』を並べる」。提案パネルは開くときに
 * 置き場の未処理しか並べないので、原稿箱の取り込みで当てた［直す］や、起こし直す前に
 * 当てた分を、あとからパネルの［戻す］で戻す口が無かった。見張ること：
 *
 * 1. 原稿箱の取り込みと同じ記録（本文は直した字・置き場に「採った」と覚え書き
 *    「出先で直した」）があれば、パネルを開き直すと未処理の一覧の下の折り畳んだ欄に並び、
 *    ［戻す］でファイルが元へ戻る。未処理の一覧の件数は変わらない
 * 2. 校正・メモパネルの［直す］のあと、提案パネルを閉じて開き直しても戻せる
 *    （この起動中に当てた行は一覧の「適用済み・［戻す］」に出ており、欄に二重には出ない）
 *
 * **AI は呼ばない。** 指摘も判断も `.aiwriter/findings.jsonl` へ見本を置く。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { OUTBOX_DECISION_NOTES } from "../../src/models/finding";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  appendSampleDecision,
  proposalPanelFrame,
  readJsonLines,
  sampleFindingId,
  writeSampleFinding,
  type SampleFinding,
} from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　近づいてみると、男は以外にも若かった。", "　ホームの時計が、零時を指していた。", ""].join("\n");
const FIXED_TEXT = TEXT.replace("男は以外にも若かった。", "男は意外にも若かった。");

const SAMPLE: SampleFinding = {
  episode: EPISODE,
  // 見本の位置（hintLine と前後）は、当てる前の本文から決める
  text: TEXT,
  original: "男は以外にも若かった。",
  target: "以外",
  suggestion: "意外",
  message: "「思いのほか」の意味なら「意外」です",
  producer: { providerId: "ollama", model: "gemma4:e4b" },
};

async function fileText(session: E2ESession): Promise<string> {
  const raw = await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "");
  return raw.replace(/\r\n/g, "\n");
}

async function countIn(frame: Frame, selector: string): Promise<number> {
  return frame.evaluate((query) => document.querySelectorAll(query).length, selector);
}

/** 「当てたもの」の欄が出ているか（無ければ欄ごと隠れる） */
async function appliedBoxShown(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    const box = document.getElementById("appliedBox");
    return box !== null && box.style.display !== "none";
  });
}

/** 置き場の判断の行の状態を、古い順に */
async function decisions(session: E2ESession): Promise<string[]> {
  const lines = await readJsonLines(path.join(session.workFolder, ".aiwriter", "findings.jsonl"));
  const id = sampleFindingId(SAMPLE);
  return lines
    .filter((line) => line.kind === "decision" && line.findingId === id)
    .map((line) => String(line.status));
}

/**
 * 提案パネルを開き、`ready` が満たされるまで待つ。
 *
 * **押し直さない。** 閉じたあとの1回で開かなければ、それは「開き直す口」の不具合である
 */
async function openProposals(page: Page, ready: (frame: Frame) => Promise<boolean>, what: string): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
  let proposals: Frame | undefined;
  await waitUntil(
    async () => {
      proposals = await proposalPanelFrame(page);
      return proposals !== undefined && (await ready(proposals));
    },
    what,
    15_000
  );
  if (!proposals) throw new Error("提案パネルが見つかりません");
  return proposals;
}

/**
 * 提案パネルのタブを前へ出して、エディターを閉じるキー（Ctrl+F4）で閉じる。閉じきるまで待つ。
 *
 * **真ん中のボタンで閉じない。** Windows の Chromium では真ん中のボタンが自動スクロールの
 * 構えに入り、次のキー（提案パネルを開くキー）がその解除に食われて本体へ届かなかった
 * （このテストを書いたとき、3回押しても開かなかった）。タブの［×］は画面の外の窓では
 * 押せる形で出てこなかった
 */
async function closeProposals(page: Page): Promise<void> {
  await page.locator(".tabs-container .tab", { hasText: "提案" }).first().click();
  await pressWorkbenchKey(page, "Control+F4");
  await waitUntil(async () => (await proposalPanelFrame(page)) === undefined, "提案パネルが閉じる", 10_000);
}

test("原稿箱の取り込みで当てた直しが、開き直した提案パネルの「当てたもの」に並び、［戻す］でファイルが元へ戻る", async () => {
  await withVsCode(
    "当てたものから戻す（原稿箱）",
    // 取り込みのあとの本文（直した字）
    [{ name: EPISODE, text: FIXED_TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");
      await clearNotifications(page);

      // まず開く（置き場は空。何も並ばない）
      const first = await openProposals(page, async (f) => (await countIn(f, "#appliedBox")) === 1, "提案パネルが開く");
      expect(await appliedBoxShown(first)).toBe(false);
      await closeProposals(page);

      // 原稿箱の取り込みと同じ記録を置く（指摘の行と、覚え書き「出先で直した」の「採った」）
      await writeSampleFinding(session.workFolder, SAMPLE);
      await appendSampleDecision(session.workFolder, SAMPLE, { status: "accepted", note: OUTBOX_DECISION_NOTES.fix });

      // ── 開き直すと「当てたもの」に並ぶ ──
      const proposals = await openProposals(
        page,
        async (f) => (await countIn(f, "[data-applied-undo]")) === 1,
        "「当てたもの」に［戻す］が並ぶ"
      );
      expect(await appliedBoxShown(proposals)).toBe(true);
      const title = await proposals.evaluate(() => document.getElementById("appliedTitle")?.textContent ?? "");
      expect(title).toContain("当てたもの（直近3日）");
      const row = await proposals.evaluate(() => document.querySelector(".applied-row")?.textContent ?? "");
      expect(row).toContain("001_駅.txt 2行目");
      expect(row).toContain("以外 → 意外");
      expect(row).toContain("出先で当てた");
      // 未処理の一覧は変わらない（0件・［適用］も［戻す］も無い）
      expect(await proposals.evaluate(() => document.getElementById("count")?.textContent ?? "")).toBe("0件");
      expect(await countIn(proposals, 'button[data-action="apply"], button[data-action="undo"]')).toBe(0);

      // ── 畳んだ欄を開いて［戻す］──
      await proposals.locator("#appliedTitle").click();
      await proposals.locator("[data-applied-undo]").first().click();
      await waitUntil(async () => (await fileText(session)) === TEXT, "［戻す］でファイルが元へ戻る");
      expect(await decisions(session)).toEqual(["accepted", "pending"]);

      // 欄から外れ、既存の［戻す］と同じく未処理の一覧に［適用］で並ぶ
      await waitUntil(
        async () =>
          !(await appliedBoxShown(proposals)) && (await countIn(proposals, 'button[data-action="apply"]')) === 1,
        "欄から外れ、一覧に［適用］で並ぶ",
        10_000
      );
    },
    OPEN_PROPOSALS_LAUNCH
  );
});

test("校正・メモパネルの［直す］のあと、提案パネルを閉じて開き直しても［戻す］で戻せる（［戻す］は1つだけ）", async () => {
  await withVsCode(
    "当てたものから戻す（校正・メモの直す）",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, SAMPLE);
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");

      // 校正・メモパネルの［直す］（提案パネルは開かない）
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
      await clearNotifications(page);
      await memo.locator('button[data-act="fix"]').first().click();
      await waitUntil(async () => (await fileText(session)) === FIXED_TEXT, "直した字がファイルに入る");

      // 開いて、閉じて、開き直す
      const undoCount = async (f: Frame) =>
        (await countIn(f, 'button[data-action="undo"]')) + (await countIn(f, "[data-applied-undo]"));
      await openProposals(page, async (f) => (await undoCount(f)) > 0, "提案パネルに［戻す］が出る");
      await closeProposals(page);
      const proposals = await openProposals(page, async (f) => (await undoCount(f)) > 0, "開き直した提案パネルに［戻す］が出る");

      // 同じ直しに［戻す］が2つ並ばない（一覧の「適用済み」と「当てたもの」の二重）
      await holdsFor(async () => (await undoCount(proposals)) === 1, "［戻す］が1つだけ").catch(async (error: unknown) => {
        throw new Error(`${String(error)}（一覧 ${await countIn(proposals, 'button[data-action="undo"]')}・当てたもの ${await countIn(proposals, "[data-applied-undo]")}）`);
      });

      await proposals.locator('button[data-action="undo"]').first().click();
      await waitUntil(async () => (await fileText(session)) === TEXT, "［戻す］でファイルが元へ戻る");
      expect(await decisions(session)).toEqual(["accepted", "pending"]);
    },
    OPEN_PROPOSALS_LAUNCH
  );
});
