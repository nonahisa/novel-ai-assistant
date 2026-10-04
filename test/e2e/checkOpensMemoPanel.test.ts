/**
 * 検知が終わったら、校正・メモパネルが開く（画面の自動テスト、設計書6.96.5・6.113）。
 *
 * 作者の報告（2026-10-04）：Ctrl+Alt+T（誤字脱字）が終わると、提案パネルが開く。
 * 裁定：終わったら**校正・メモパネル**を開く（すでに開いていれば前に出して読み直す）。
 * 指摘は校正・メモパネルに並ぶ。提案パネルは［提案へ］や「提案パネルを開く」から今までどおり開ける。
 *
 * 見張ること：
 * 1. 開いていないとき：終わると校正・メモパネルが原稿の右の列に開き、今回の指摘が並ぶ。
 *    提案パネルは開かない（3秒見続ける）。焦点は原稿の列に残る。原稿のタブは左の列に1枚のまま
 * 2. 開いているが提案パネルの後ろに隠れているとき：前に出して読み直し（今回の指摘が並ぶ）、
 *    2枚目の校正・メモパネルを作らない
 * 3. どちらのあとも、提案パネルは「提案パネルを開く」で開け、今回の指摘が［適用］で並ぶ
 *
 * **AI は呼ばない。** 検知は表記ゆれ（`novelai.checkNotation`。規則だけで判定する）を
 * 原稿エディターのキー Ctrl+Alt+H で走らせる——誤字脱字（Ctrl+Alt+T）・推敲・矛盾・逸脱と
 * 同じ関数（`ProposalPanel.replaceContents`）で終わる。誤字脱字そのものは AI が要るので、
 * 開く先が替わったことは単体テスト `proposalPanelOpensMemoPanel.test.ts` が分類ごとに見る。
 * 校正・メモパネルに並ばない種類（名前の付け替え）が今までどおり提案パネルを開くことは
 * `nameRenameFlow.test.ts` が見る。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { manuscriptFrames, memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame } from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  acceptQuickPick,
  activeGroupIndex,
  activeTabNames,
  clearNotifications,
  editorGroupTabs,
  pickQuickPickRow,
  pressWorkbenchKey,
  quickPickRows,
  quickPickTitle,
  toggleQuickPickRow,
  waitForQuickPick,
} from "./support/workbenchDom";

const EPISODE = "001_星.txt";
/** 「沢山」1回・「たくさん」2回。表記ゆれの組はこの1組だけ */
const TEXT = ["　空には沢山の星があった。", "　たくさんの星が見えた。", "　たくさん、と彼女は言った。", ""].join("\n");

const MEMO_TAB = "校正・メモパネル";

/** 面の中の押し口の数（隠れている面でも数えられる——`retainContextWhenHidden`） */
async function countIn(frame: Frame, selector: string): Promise<number> {
  return frame.evaluate((query) => document.querySelectorAll(query).length, selector);
}

/** 校正・メモパネルの面の数（2枚目を作っていないか） */
async function memoPanelCount(page: Page): Promise<number> {
  let count = 0;
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => (document.body?.innerText ?? "").trimStart().startsWith("校正・メモパネル"))
      .catch(() => false);
    if (has) count++;
  }
  return count;
}

async function memoTabCount(page: Page): Promise<number> {
  return (await editorGroupTabs(page)).flat().filter((name) => name.startsWith(MEMO_TAB)).length;
}

/**
 * 原稿の中から Ctrl+Alt+H（表記ゆれ）を押し、ただ1つの組を選んで「たくさん」に揃える。
 * 本文はまだ書き換わらない（指摘を作るだけ）
 *
 * @returns 押す前に焦点のあった列（終わったあと同じ列のままか＝フォーカスを奪わないかを見る）。
 *   画面の外で起こした VS Code では、WebView の中を押しても焦点の列が原稿の列へ
 *   移らないことがある（窓が OS の前面に無いため）ので、0 と決め打ちしない
 */
async function runNotationCheck(page: Page, frame: Frame): Promise<number> {
  await placeCaretAfter(frame, "空には");
  const focusedGroup = await activeGroupIndex(page);
  await page.keyboard.press("Control+Alt+KeyH");
  await waitUntil(
    async () => (await quickPickTitle(page))?.startsWith("表記ゆれが 1 組見つかりました") === true,
    "表記ゆれの組を選ぶ画面が出る",
    20_000
  );
  // 行が出揃うまで待つ（題は分かっているので、行の数で待つ）
  await waitUntil(async () => (await quickPickRows(page)).length === 1, "組の行が1つ出る", 10_000);
  const [row] = await quickPickRows(page);
  expect(row.label).toContain("沢山");
  expect(row.label).toContain("たくさん");
  await toggleQuickPickRow(page, row.label);
  await acceptQuickPick(page);
  // 1組だけなので「1組ずつ選ぶ」の画面になる
  await waitForQuickPick(page, `${row.label} — どちらに揃えますか`);
  await pickQuickPickRow(page, "「たくさん」に揃える");
  return focusedGroup;
}

/** 校正・メモパネルに、今回の指摘（「沢山」→「たくさん」の［直す］）が並ぶまで待つ */
async function waitMemoPanelLists(page: Page): Promise<Frame> {
  let memo: Frame | undefined;
  await waitUntil(
    async () => {
      memo = await memoPanelFrame(page);
      if (!memo) return false;
      return (
        (await countIn(memo, 'button[data-act="fix"]')) === 1 &&
        (await memo.evaluate(() => document.body.innerText.includes("沢山")))
      );
    },
    "校正・メモパネルに今回の指摘（沢山→たくさん）が［直す］で並ぶ",
    30_000
  );
  if (!memo) throw new Error("校正・メモパネルが見つかりません");
  return memo;
}

/** 「提案パネルを開く」で開き、今回の指摘が［適用］で並ぶ（今までどおり開ける） */
async function proposalsStillOpen(page: Page): Promise<void> {
  await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
  await waitUntil(
    async () => {
      const proposals = await proposalPanelFrame(page);
      return (
        proposals !== undefined &&
        (await countIn(proposals, 'button[data-action="apply"]')) === 1 &&
        (await proposals.evaluate(() => document.body.innerText.includes("表記ゆれ")))
      );
    },
    "「提案パネルを開く」で提案パネルが開き、表記ゆれの指摘が［適用］で並ぶ",
    15_000
  );
}

/** 本文のファイル（指摘を作るだけで、書き換わらない） */
async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

test("検知が終わると校正・メモパネルが原稿の右に開いて指摘が並び、提案パネルは開かず、焦点は原稿に残る", async () => {
  await withVsCode(
    "検知のあとに校正・メモパネル",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "彼女は言った");
      await clearNotifications(page);
      expect(await memoPanelFrame(page), "始める前は校正・メモパネルが無い").toBeUndefined();

      const focusedGroup = await runNotationCheck(page, frame);
      expect(focusedGroup, "押す前は原稿の列（1列だけ）に焦点がある").toBe(0);

      // ── 校正・メモパネルが開き、今回の指摘が並ぶ ──
      await waitMemoPanelLists(page);

      // ── 提案パネルは開かない（遅れて開くものも拾う）──
      await holdsFor(async () => (await proposalPanelFrame(page)) === undefined, "提案パネルが開かないこと", 3_000);

      // ── 原稿は左の列に1枚のまま、校正・メモパネルは右の列。焦点は原稿の列に残る ──
      const groups = await editorGroupTabs(page);
      expect(groups.length, `列：${JSON.stringify(groups)}`).toBe(2);
      expect(groups[0]).toContain(EPISODE);
      expect(groups[1].some((name) => name.startsWith(MEMO_TAB)), `列：${JSON.stringify(groups)}`).toBe(true);
      expect(groups.flat().filter((name) => name === EPISODE)).toHaveLength(1);
      expect((await manuscriptFrames(page)).length).toBe(1);
      expect(await activeGroupIndex(page), "焦点が原稿の列から移った").toBe(focusedGroup);

      // 指摘を作るだけで、本文は書き換わらない
      expect(await fileText(session)).toBe(TEXT);

      // ── 提案パネルは今までどおり開ける ──
      await proposalsStillOpen(page);
    },
    OPEN_PROPOSALS_LAUNCH
  );
});

test("校正・メモパネルが提案パネルの後ろに隠れていても、検知が終わると前に出て読み直し、2枚目は作らない", async () => {
  await withVsCode(
    "検知のあとに校正・メモパネル（隠れているとき）",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "彼女は言った");
      await clearNotifications(page);

      // 先に校正・メモパネルを開く（まだ指摘は無い）
      await placeCaretAfter(frame, "空には");
      await page.keyboard.press("Control+Alt+KeyM");
      await waitUntil(async () => (await memoPanelFrame(page)) !== undefined, "校正・メモパネルが開く", 30_000);
      const memoBefore = await memoPanelFrame(page);
      if (!memoBefore) throw new Error("校正・メモパネルが見つかりません");
      expect(await countIn(memoBefore, 'button[data-act="fix"]')).toBe(0);

      // 提案パネルを同じ右の列に重ねて、校正・メモパネルを後ろへ隠す
      await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
      await waitUntil(
        async () => (await activeTabNames(page))[1]?.startsWith("提案") === true,
        "右の列の前面が提案パネルになる",
        15_000
      );
      const hidden = await editorGroupTabs(page);
      expect(hidden.length, `列：${JSON.stringify(hidden)}`).toBe(2);
      expect(hidden[1].some((name) => name.startsWith(MEMO_TAB)), `列：${JSON.stringify(hidden)}`).toBe(true);

      // 原稿へ戻って検知を走らせる
      const focusedGroup = await runNotationCheck(page, frame);

      // ── 前に出して読み直す：今回の指摘が並び、右の列の前面が校正・メモパネルになる ──
      await waitMemoPanelLists(page);
      await waitUntil(
        async () => (await activeTabNames(page))[1]?.startsWith(MEMO_TAB) === true,
        "右の列の前面が校正・メモパネルになる",
        15_000
      );

      // ── 2枚目を作らない（遅れて開くものも拾う）。原稿のタブも増えない ──
      await holdsFor(
        async () => (await memoTabCount(page)) === 1 && (await memoPanelCount(page)) === 1,
        "校正・メモパネルが1枚のままであること",
        3_000
      );
      const groups = await editorGroupTabs(page);
      expect(groups.length, `列：${JSON.stringify(groups)}`).toBe(2);
      expect(groups.flat().filter((name) => name === EPISODE)).toHaveLength(1);
      expect(await activeGroupIndex(page), "焦点の列が変わった").toBe(focusedGroup);

      // ── 提案パネルは今までどおり開ける（今回の指摘も並んでいる）──
      await proposalsStillOpen(page);
    },
    OPEN_PROPOSALS_LAUNCH
  );
});
