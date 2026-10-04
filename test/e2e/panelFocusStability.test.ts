/**
 * 校正・メモパネル・提案パネルを開いていても、画面が勝手に動かない（画面の自動テスト、設計書6.113）。
 *
 * 作者の実機確認（2026-10-04、開発ホスト）：
 *
 * 1. コマンドパレット（Ctrl+Shift+P）と右クリックの品書きが、約2秒で勝手に消える。
 *    校正・メモパネルと提案パネルのタブを閉じると消えなくなった
 * 2. 校正・メモパネルで行を押すと、一覧が冒頭へ飛ぶ（何を選んだか分からなくなる）
 * 3. 左の「簡単ステップメニュー」の段を開いても、中身の行が1つも出ない
 *    （見出しの矢印は開いた形。パネルを閉じても直らない）
 *
 * ここではそれぞれを「起きないこと」として見張る（`holdsFor` で数秒見続ける）。
 * **AI は呼ばない。** 指摘は `.aiwriter/findings.jsonl` へ見本を置く。
 */
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  writeSampleFinding,
  type SampleFinding,
} from "./support/sampleFinding";
import { SIDEBAR_LAUNCH, showSidebar, treeRow } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";

/** 一覧が画面に収まらないだけのメモ（転がした位置が保たれるかを見るため） */
const MEMO_COUNT = 40;
const LINES: string[] = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　近づいてみると、男は以外にも若かった。"];
for (let index = 1; index <= MEMO_COUNT; index++) {
  LINES.push(`// メモ${index}番`);
  LINES.push(`　${index}行目の本文。`);
}
LINES.push("　ホームの時計が、零時を指していた。", "");
const TEXT = LINES.join("\n");

const SAMPLE: SampleFinding = {
  episode: EPISODE,
  text: TEXT,
  original: "男は以外にも若かった。",
  target: "以外",
  suggestion: "意外",
  message: "「思いのほか」の意味なら「意外」です",
};

const LAUNCH = {
  settings: { ...SIDEBAR_LAUNCH.settings },
  keybindings: [...SIDEBAR_LAUNCH.keybindings, ...OPEN_PROPOSALS_LAUNCH.keybindings],
};

async function openMemoPanel(page: Page): Promise<Frame> {
  await page.keyboard.press("Control+Alt+KeyM");
  let memo: Frame | undefined;
  await waitUntil(
    async () => {
      memo = await memoPanelFrame(page);
      return (
        memo !== undefined &&
        (await memo.evaluate(() => document.querySelectorAll("#list .memo").length)) > MEMO_COUNT
      );
    },
    "校正・メモパネルにメモと指摘が並ぶ",
    30_000
  );
  if (!memo) throw new Error("校正・メモパネルが見つかりません");
  return memo;
}

async function openProposals(page: Page): Promise<void> {
  await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
  await waitUntil(async () => (await proposalPanelFrame(page)) !== undefined, "提案パネルが開く");
}

async function paletteShown(page: Page): Promise<boolean> {
  return page.locator(".quick-input-widget input").isVisible();
}

/** 校正・メモパネルと提案パネルを開いた状態を作る（作者の画面と同じ並び） */
async function openBothPanels(page: Page): Promise<Frame> {
  const frame = await openEpisode(page, EPISODE, "零時を指していた");
  await placeCaretAfter(frame, "終電を逃した");
  const memo = await openMemoPanel(page);
  await openProposals(page);
  await clearNotifications(page);
  return memo;
}

test("校正・メモパネルと提案パネルを開いていても、コマンドパレットは5秒たっても開いたまま", async () => {
  await withVsCode(
    "パネルとパレット",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, SAMPLE);
      await openBothPanels(page);

      await pressWorkbenchKey(page, "Control+Shift+KeyP");
      await waitUntil(() => paletteShown(page), "コマンドパレットが開く");
      await holdsFor(() => paletteShown(page), "開いたコマンドパレット", 5_000);
      await page.keyboard.press("Escape");
    },
    LAUNCH
  );
});

test("校正・メモパネルで［直す］を押して帯が出たあとも、コマンドパレットは5秒たっても開いたまま", async () => {
  await withVsCode(
    "直したあとのパレット",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, SAMPLE);
      const memo = await openBothPanels(page);
      await page.locator(".tabs-container .tab", { hasText: "校正・メモパネル" }).first().click();
      await memo.locator('button[data-act="fix"]').first().click();
      await waitUntil(
        () => memo.evaluate(() => document.getElementById("fixed")?.hidden === false),
        "校正・メモパネルに「直しました」の帯が出る"
      );
      await clearNotifications(page);

      await pressWorkbenchKey(page, "Control+Shift+KeyP");
      await waitUntil(() => paletteShown(page), "コマンドパレットが開く");
      await holdsFor(() => paletteShown(page), "開いたコマンドパレット", 5_000);
      await page.keyboard.press("Escape");
    },
    LAUNCH
  );
});

test("校正・メモパネルの一覧を転がして行を押しても、転がした位置が保たれる", async () => {
  await withVsCode(
    "メモの一覧の位置",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, SAMPLE);
      const memo = await openBothPanels(page);
      // 提案パネルが同じ列へ重なるので、校正・メモパネルを前へ出す
      await page.locator(".tabs-container .tab", { hasText: "校正・メモパネル" }).first().click();

      // 転がるのは一覧の枠（`#body`）。頁そのものは高さ100vhで転がらない
      const scrollY = () => memo.evaluate(() => document.getElementById("body")?.scrollTop ?? 0);
      await memo.evaluate(() => {
        const element = document.getElementById("body");
        if (element) element.scrollTop = element.scrollHeight;
      });
      await waitUntil(async () => (await scrollY()) > 200, "校正・メモパネルの一覧が下まで転がる");

      // 画面に見えている、下のほうのメモの行を押す
      const target = memo.locator("#list button.go", { hasText: `メモ${MEMO_COUNT - 2}番` }).first();
      await target.click();
      const pressedAt = await scrollY();
      expect(pressedAt, "押した直後に一覧が冒頭へ飛びました").toBeGreaterThan(200);
      await holdsFor(async () => (await scrollY()) > 200, "転がした一覧の位置", 4_000);
    },
    LAUNCH
  );
});

test("簡単ステップメニューの段を開くと、中身の行が並ぶ", async () => {
  await withVsCode(
    "簡単ステップメニューの展開",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      const heading = treeRow(page, "1. 作品登録");
      await waitUntil(async () => (await heading.count()) > 0, "簡単ステップメニューに「1. 作品登録」が出る");
      if ((await heading.getAttribute("aria-expanded")) !== "true") await heading.click();
      await waitUntil(async () => (await heading.getAttribute("aria-expanded")) === "true", "「1. 作品登録」が開く");

      // 開いた段のすぐ下に、1段深い行（中身）が出る
      const childCount = () =>
        page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll(".monaco-list-row"));
          const at = rows.findIndex((row) => (row.getAttribute("aria-label") ?? "").startsWith("1. 作品登録"));
          if (at < 0) return 0;
          const level = Number(rows[at].getAttribute("aria-level") ?? "0");
          let count = 0;
          for (const row of rows.slice(at + 1)) {
            if (Number(row.getAttribute("aria-level") ?? "0") <= level) break;
            count++;
          }
          return count;
        });
      await waitUntil(async () => (await childCount()) > 0, "「1. 作品登録」の中身の行が並ぶ", 10_000);
    },
    LAUNCH
  );
});
