/**
 * 校正の指摘の場所から本文へ飛ぶ——**開いていない話**へも、**縦書きで書いている最中**にも
 * （画面の自動テスト、設計書6.113・6.25.11。実機確認リスト F-32・F-40 を 2026-10-04 に移した）。
 *
 * 押すのは提案パネルの「話のファイル名 N行目」（誤字脱字のように修正案のある指摘には
 * ［本文を見る］のボタンが無く、［適用］が並ぶ。場所の字を押すと本文へ飛ぶ）。
 *
 * 何を見張るか：
 * 1. 開いていない話の指摘を押すと、その話が**1枚だけ**開き、指摘の行まで転がって、
 *    カーソルがその行に来る。裏に回った話の指摘を押すと、**そのタブが前に出る**
 * 2. 縦書きで書いている話の指摘を押すと、縦書きのまま指摘の行まで転がる。続けて
 *    開いていない話の指摘を押すと、**書いている向き（縦書き）で**開く
 *    ——2026-10-04 に移したとき、ここが**落ちた**（横書きで開く。同日に直した。設計書6.25.11）
 *
 * どちらも、飛んだ先は行を**選ばず**カーソルを置くだけ（作者の裁定 2026-10-03。0.97.2）。
 * 実機確認リストの項目文は「該当行が選ばれる」のままだが、それは 0.97.2 より前の約束。
 * 横書きで開いている話の場所は `proposalApply.test.ts` が、校正・メモパネルの行は
 * `sceneMemoPanel.test.ts` が見ている。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { caretPosition, composeText, manuscriptFrames, openEpisode, selectionCollapsed } from "./support/manuscriptFrame";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame, writeSampleFinding } from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { activeTabNames, clearNotifications, editorGroupTabs, pressWorkbenchKey } from "./support/workbenchDom";

const OPENED = "001_朝.txt";
const UNOPENED = "002_夜.txt";

/** 縦書きにするキー（使い捨ての keybindings.json。F1〜F12 は埋まったので文字キーとの組） */
const OPEN_VERTICAL_KEY = "ctrl+alt+shift+v";
const OPEN_VERTICAL_PRESS = "Control+Alt+Shift+KeyV";

const LAUNCH = {
  keybindings: [...OPEN_PROPOSALS_LAUNCH.keybindings, { key: OPEN_VERTICAL_KEY, command: "novelai.openVertical" }],
};

/** 指摘の行が画面の外にあるよう、前に長く行を積む（「転がる」かを見るため） */
function longText(prefix: string, target: string, last: string): string {
  return [...Array.from({ length: 60 }, (_, index) => `${prefix}の${index + 1}行目、まだ何も起きない。`), target, last, ""].join(
    "\n"
  );
}
const OPENED_TARGET = "朝に以外な客が来た。";
const UNOPENED_TARGET = "夜に以外な知らせが届いた。";
const OPENED_TEXT = longText("朝", OPENED_TARGET, "朝の終わり。");
const UNOPENED_TEXT = longText("夜", UNOPENED_TARGET, "夜の終わり。");

const EPISODES = [
  { name: OPENED, text: OPENED_TEXT },
  { name: UNOPENED, text: UNOPENED_TEXT },
];

/** 本文に `marker` を含む原稿エディターの面 */
async function frameShowing(page: Page, marker: string): Promise<Frame | undefined> {
  for (const frame of await manuscriptFrames(page)) {
    if ((await composeText(frame)).includes(marker)) return frame;
  }
  return undefined;
}

async function isVertical(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    const compose = document.getElementById("compose");
    return compose ? getComputedStyle(compose).writingMode.startsWith("vertical") : false;
  });
}

/** カーソルが本文の見えている枠の中にあるか（指摘の行まで転がったか。縦横どちらの向きでも） */
async function caretInView(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    const selection = window.getSelection();
    const compose = document.getElementById("compose");
    if (!selection || selection.rangeCount === 0 || !compose) return false;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    // 本文の枠のうち、窓の中に見えている部分
    let node: HTMLElement | null = compose;
    let box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    while (node) {
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden)/.test(style.overflow + style.overflowX + style.overflowY)) {
        box = {
          left: Math.max(box.left, r.left),
          top: Math.max(box.top, r.top),
          right: Math.min(box.right, r.right),
          bottom: Math.min(box.bottom, r.bottom),
        };
      }
      node = node.parentElement;
    }
    return rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
  });
}

async function tabCount(page: Page, name: string): Promise<number> {
  return (await editorGroupTabs(page)).flat().filter((tab) => tab === name).length;
}

/** 指摘を2件（第1話・第2話）置く。見本の口は1件ずつ書き直すので、行を足し合わせる */
async function placeTwoFindings(session: E2ESession): Promise<void> {
  const findingsFile = path.join(session.workFolder, ".aiwriter", "findings.jsonl");
  const common = { target: "以外", suggestion: "意外", message: "「思いのほか」の意味なら「意外」です" };
  await writeSampleFinding(session.workFolder, { episode: OPENED, text: OPENED_TEXT, original: OPENED_TARGET, ...common });
  const first = await readFile(findingsFile, "utf8");
  await writeSampleFinding(session.workFolder, { episode: UNOPENED, text: UNOPENED_TEXT, original: UNOPENED_TARGET, ...common });
  await writeFile(findingsFile, first + (await readFile(findingsFile, "utf8")), "utf8");
}

/** 提案パネルを開き、話のファイル名で指摘の場所を押す口を返す */
async function openProposals(page: Page): Promise<(fileName: string) => Promise<void>> {
  await clearNotifications(page);
  await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
  let found: Frame | undefined;
  await waitUntil(async () => {
    found = await proposalPanelFrame(page);
    return found !== undefined && (await found.locator('.location[data-action="jump"]').count()) >= 2;
  }, "提案パネルに2件の指摘の場所が並ぶ", 15_000);
  if (!found) throw new Error("提案パネルが見つかりません");
  const proposals = found;
  return async (fileName: string) => {
    await proposals.locator('.location[data-action="jump"]', { hasText: fileName }).first().click();
  };
}

/** `marker` の話の面で、カーソルが `target` の行に来るまで待って面を返す */
async function waitCaretOn(page: Page, marker: string, target: string, label: string): Promise<Frame> {
  let frame: Frame | undefined;
  await waitUntil(async () => {
    frame = await frameShowing(page, marker);
    return frame !== undefined && ((await caretPosition(frame))?.lineText ?? "").includes(target);
  }, label, 30_000);
  if (!frame) throw new Error(`${label}：面が見つかりません`);
  return frame;
}

async function staysSingle(page: Page, label: string): Promise<void> {
  await holdsFor(
    async () => (await tabCount(page, OPENED)) <= 1 && (await tabCount(page, UNOPENED)) <= 1,
    label
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（列とタブ：${JSON.stringify(await editorGroupTabs(page))}）`);
  });
}

test("開いていない話の指摘の場所を押すとその話が1枚だけ開いて行まで転がり、裏に回った話の指摘ではそのタブが前に出て、どちらも行を選ばずカーソルを置く", async () => {
  await withVsCode(
    "開いていない話の指摘へ飛ぶ",
    EPISODES,
    async (session) => {
      const { page } = session;
      await placeTwoFindings(session);
      await openEpisode(page, OPENED, "朝の終わり");
      const jumpTo = await openProposals(page);

      // 開いていない第2話
      await jumpTo(UNOPENED);
      const night = await waitCaretOn(page, "夜の終わり", UNOPENED_TARGET, "第2話が開き、カーソルが指摘の行に来る");
      expect(await selectionCollapsed(night), "飛んだ先で行が選ばれています").toBe(true);
      await waitUntil(async () => await caretInView(night), "第2話が指摘の行まで転がる", 5_000);
      await staysSingle(page, "第2話を開いたあと、同じ話のタブが1枚ずつ");
      expect(await tabCount(page, UNOPENED)).toBe(1);

      // 裏に回った第1話
      await jumpTo(OPENED);
      await waitUntil(async () => (await activeTabNames(page)).includes(OPENED), "裏の第1話のタブが前に出る");
      const morning = await waitCaretOn(page, "朝の終わり", OPENED_TARGET, "第1話のカーソルが指摘の行に来る");
      expect(await selectionCollapsed(morning), "第1話で行が選ばれています").toBe(true);
      await waitUntil(async () => await caretInView(morning), "第1話が指摘の行まで転がる", 5_000);
      await staysSingle(page, "第1話へ戻ったあと、同じ話のタブが1枚ずつ");
      expect(await tabCount(page, OPENED)).toBe(1);
    },
    LAUNCH
  );
});

test("縦書きで書いている話の指摘では縦書きのまま行まで転がり、続けて開いていない話の指摘を押すと、その話も縦書きで開く", async () => {
  await withVsCode(
    "縦書きから指摘へ飛ぶ",
    EPISODES,
    async (session) => {
      const { page } = session;
      await placeTwoFindings(session);
      await openEpisode(page, OPENED, "朝の終わり");
      await pressWorkbenchKey(page, OPEN_VERTICAL_PRESS);
      await waitUntil(async () => {
        const frame = await frameShowing(page, "朝の終わり");
        return frame !== undefined && (await isVertical(frame));
      }, "第1話が縦書きになる", 15_000);
      const jumpTo = await openProposals(page);

      // 縦書きで書いている第1話の指摘：縦書きのまま、指摘の行まで転がる
      await jumpTo(OPENED);
      const morning = await waitCaretOn(page, "朝の終わり", OPENED_TARGET, "第1話のカーソルが指摘の行に来る");
      expect(await isVertical(morning), "第1話が縦書きでなくなりました").toBe(true);
      expect(await selectionCollapsed(morning), "第1話で行が選ばれています").toBe(true);
      await waitUntil(async () => await caretInView(morning), "縦書きで指摘の行まで転がる", 5_000);

      /*
        続けて、開いていない第2話の指摘：書いている向き（縦書き）で開くはず。
        2026-10-04 に直すまでは横書きで開いた——押したのが右の列の提案パネルなので、
        「いま前に出ているタブ」が原稿でなく、向きを引き継げなかった
        （いまは最後に前へ出ていた原稿の見た目の向きを使う。`writingManuscriptViewType`）
      */
      await jumpTo(UNOPENED);
      const night = await waitCaretOn(page, "夜の終わり", UNOPENED_TARGET, "第2話が開き、カーソルが指摘の行に来る");
      await staysSingle(page, "第2話を開いたあと、同じ話のタブが1枚ずつ");
      expect(await isVertical(night), "書いている最中の向き（縦書き）で開いていません").toBe(true);
    },
    LAUNCH
  );
});
