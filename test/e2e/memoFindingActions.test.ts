/**
 * 校正・メモパネルの指摘の行の、［直す］以外の道（画面の自動テスト、設計書6.96.5・5.6・6.113）。
 *
 * 実機確認リスト 0.97.8 の2項目を機械へ移したもの（2026-10-03）：
 *
 * 1. **修正案の無い指摘**（矛盾・プロット逸脱）は［直す］でなく［提案へ］が出て、
 *    押すと提案パネルが前に出て、その指摘が並ぶ。本文は変わらない
 * 2. **校閲ロックの掛かった話**で［直す］を押すと、提案パネルの［適用］と同じ
 *    「校閲中です」の確認が出る。止めれば本文は変わらず、指摘も残る。
 *    「それでも直す」を選べば当たる（確認の画面が道を塞いでいるだけで、壊れていない念押し）
 *
 * **AI は呼ばない。** 指摘は `.aiwriter/findings.jsonl` へ、ロックは
 * `.aiwriter/locks/locks.jsonl` へ、製品が読む形で見本を置く。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  proposalPanelFrame,
  readJsonLines,
  sampleFindingId,
  writeSampleFinding,
  type SampleFinding,
} from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  activeTabNames,
  clearNotifications,
  closeDialog,
  dialogText,
  editorGroupTabs,
  pressDialogButton,
} from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　近づいてみると、男は以外にも若かった。", "　ホームの時計が、零時を指していた。", ""].join("\n");
const FIXED_TEXT = TEXT.replace("男は以外にも若かった。", "男は意外にも若かった。");

/** 本文のファイル（書き込みは「退避 → 新規作成」なので、その合間は無い。無ければ空） */
async function fileText(session: E2ESession): Promise<string> {
  const raw = await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "");
  return raw.replace(/\r\n/g, "\n");
}

/** 面の中の押し口の数 */
async function countIn(frame: Frame, selector: string): Promise<number> {
  return frame.evaluate((query) => document.querySelectorAll(query).length, selector);
}

/** 原稿の中から Ctrl+Alt+M で校正・メモパネルを開き、`selector` の押し口が並ぶまで待つ */
async function openMemoPanel(page: Page, selector: string): Promise<Frame> {
  await page.keyboard.press("Control+Alt+KeyM");
  let memo: Frame | undefined;
  await waitUntil(
    async () => {
      memo = await memoPanelFrame(page);
      return memo !== undefined && (await countIn(memo, selector)) > 0;
    },
    `校正・メモパネルに指摘の押し口（${selector}）が並ぶ`,
    30_000
  );
  if (!memo) throw new Error("校正・メモパネルが見つかりません");
  return memo;
}

/** 置き場（findings.jsonl）の、その指摘の判断の行の状態を、古い順に */
async function decisions(session: E2ESession, sample: SampleFinding): Promise<string[]> {
  const lines = await readJsonLines(path.join(session.workFolder, ".aiwriter", "findings.jsonl"));
  const id = sampleFindingId(sample);
  return lines.filter((line) => line.kind === "decision" && line.findingId === id).map((line) => String(line.status));
}

test("修正案の無い指摘（矛盾）の［提案へ］で、提案パネルが前に出てその指摘が並び、本文は変わらない", async () => {
  const sample: SampleFinding = {
    episode: EPISODE,
    text: TEXT,
    original: "ホームの時計が、零時を指していた。",
    target: "零時",
    suggestion: "",
    message: "第1話では終電の時刻を二十三時としています",
    category: "contradiction",
    label: "矛盾",
  };
  await withVsCode(
    "校正・メモの提案へ",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, sample);
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");

      const memo = await openMemoPanel(page, 'button[data-act="handOver"]');
      await clearNotifications(page);
      // 修正案が無いので［直す］は出ない
      expect(await countIn(memo, 'button[data-act="fix"]')).toBe(0);
      expect(await proposalPanelFrame(page), "提案パネルが先に開いています").toBeUndefined();

      await memo.locator('button[data-act="handOver"]').first().click();

      // ── 提案パネルが開き、その指摘が並ぶ ──
      let proposals: Frame | undefined;
      await waitUntil(
        async () => {
          proposals = await proposalPanelFrame(page);
          if (!proposals) return false;
          const shown = await proposals.evaluate(() => document.body.innerText);
          return shown.includes("終電の時刻を二十三時");
        },
        "提案パネルに矛盾の指摘が並ぶ",
        15_000
      );
      // ── 前に出ている（どこかの列で、前のタブが提案パネル）──
      await waitUntil(
        // タブの題は件数つき（「提案（1）」）なので頭で見る
        async () => (await activeTabNames(page)).some((name) => name.startsWith("提案")),
        "提案パネルのタブが前に出る",
        10_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（前のタブ：${JSON.stringify(await activeTabNames(page))}）`);
      });

      // 本文は変わらず、置き場に「採った」も残らない（直し方は作者が決める）
      await holdsFor(async () => (await fileText(session)) === TEXT, "［提案へ］のあとも本文が変わらない", 2_000);
      expect(await decisions(session, sample)).toEqual([]);
      expect(await dialogText(page), "思いがけず確認の窓が出ています").toBeUndefined();
      // 原稿のタブは1枚のまま
      expect((await editorGroupTabs(page)).flat().filter((name) => name === EPISODE).length).toBe(1);
    },
    OPEN_PROPOSALS_LAUNCH
  );
});

test("校閲ロックの掛かった話で［直す］を押すと「校閲中です」の確認が出て、止めれば本文は変わらず、それでも直すなら当たる", async () => {
  const sample: SampleFinding = {
    episode: EPISODE,
    text: TEXT,
    original: "男は以外にも若かった。",
    target: "以外",
    suggestion: "意外",
    message: "「思いのほか」の意味なら「意外」です",
  };
  await withVsCode(
    "校閲ロックの話で直す",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, sample);
      // 編集部（editor）がこの話を押さえている。製品が読む形（models/fileLock.ts の LockEvent）
      const locks = path.join(session.workFolder, ".aiwriter", "locks");
      await mkdir(locks, { recursive: true });
      await writeFile(
        path.join(locks, "locks.jsonl"),
        JSON.stringify({
          kind: "acquire",
          file: `本文/${EPISODE}`,
          holder: "担当編集",
          holderKind: "editor",
          time: new Date().toISOString(),
          note: "第1話を校閲しています",
        }) + "\n",
        "utf8"
      );

      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");
      const memo = await openMemoPanel(page, 'button[data-act="fix"]');
      await clearNotifications(page);

      // ── ［直す］→「校閲中です」の確認が出る ──
      await memo.locator('button[data-act="fix"]').first().click();
      let shown: string | undefined;
      await waitUntil(async () => (shown = await dialogText(page)) !== undefined, "校閲中の確認が出る", 10_000);
      expect(shown).toContain(`${EPISODE} は校閲中です`);

      // ── 止める（Esc）→ 本文は変わらず、指摘も［直す］のまま残る ──
      await closeDialog(page);
      await holdsFor(async () => (await fileText(session)) === TEXT, "止めたあとも本文が変わらない", 2_000);
      expect(await countIn(memo, 'button[data-act="fix"]')).toBe(1);
      expect(await decisions(session, sample)).toEqual([]);

      // ── 念押し：もう一度押して「それでも直す」なら当たる ──
      await memo.locator('button[data-act="fix"]').first().click();
      await waitUntil(async () => (await dialogText(page)) !== undefined, "もう一度、校閲中の確認が出る", 10_000);
      await pressDialogButton(page, "それでも直す");
      await waitUntil(async () => (await fileText(session)) === FIXED_TEXT, "それでも直すと、直した字がファイルに入る");
      // 判断の行は本文を書いたあとに足される。少し遅れるので待つ（4回に1回、読むのが早すぎて空だった）
      await waitUntil(
        async () => JSON.stringify(await decisions(session, sample)) === JSON.stringify(["accepted"]),
        "置き場に「採った」の判断の行が1つ入る",
        5_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（判断の行：${JSON.stringify(await decisions(session, sample))}）`);
      });
    },
    OPEN_PROPOSALS_LAUNCH
  );
});
