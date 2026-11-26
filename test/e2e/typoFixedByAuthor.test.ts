/**
 * 誤字脱字の指摘が出たあとに、作者が本文のその所を自分で直して保存すると、提案パネルと
 * 校正・メモパネルの両方からその指摘が消える（画面の自動テスト、設計書6.96.5・6.113）。
 *
 * 作者の知らせ（2026-11-27）：「誤字脱字を直接書き換えるとパネルから消えない」。
 * 直し：作品フォルダーの見張り（`WorkFolderWatchers`）の知らせで、提案パネルがまだ手を付けて
 * いない指摘の原文を本文で照らし直し（`ProposalPanel.noteManuscriptEdited`）、校正・メモパネルが
 * 読み直す（`features/manuscriptEditFollow.ts`）。
 *
 * 見張ること（2件。直す道だけが違う）：
 * 1. 原稿エディターで字を消して Ctrl+S
 * 2. 同じ話を VS Code の素のエディターで開き直し（Reopen Editor With Text Editor）、行を打ち直して Ctrl+S
 *
 * どちらも、ファイルが直ったことを先に確かめてから、提案パネルの［適用］の行と、校正・メモパネルの
 * ［直す］の行が 0 になるのを待つ。**本文は直した字のまま**（拡張機能が書き戻さない）ことも見る。
 *
 * **AI は偽の Ollama（`support/fakeOllama.ts`）。** 誤字脱字の指摘を1件だけ返す。件ごとに起こして閉じる。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { OPEN_PROPOSALS_KEY, OPEN_PROPOSALS_PRESS, proposalPanelFrame } from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  activateTab,
  clearNotifications,
  editorGroupTabs,
  focusTextEditor,
  notificationTexts,
  pressWorkbenchKey,
  quickPickRows,
  quickPickTitle,
  textEditorVisibleText,
} from "./support/workbenchDom";
import { CHECK_TYPOS_PRESS, EDITOR_TOP_PRESS } from "./support/keys";

const EPISODE = "001_灯台.txt";
const WRONG_LINE = "　灯台を見上げけて、息を吐いた。";
const FIXED_LINE = "　灯台を見上げて、息を吐いた。";
const TEXT = `${WRONG_LINE}\n　夜の港は静かだった。\n`;
const FIXED_TEXT = `${FIXED_LINE}\n　夜の港は静かだった。\n`;

/** 偽の AI の答え：1行目の「見上げけて」 */
const ANSWER = JSON.stringify({
  issues: [{ line: 1, original: WRONG_LINE, target: "見上げけて", suggestion: "見上げて", reason: "「け」が重なっている", confidence: "high" }],
});

/** 開いている原稿を素のエディターで開き直すキー（使い捨ての keybindings.json。製品のキーと重ならない） */
const REOPEN_TEXT_KEY = "ctrl+alt+shift+9";
const REOPEN_TEXT_PRESS = "Control+Alt+Shift+Digit9";

const LAUNCH_KEYS = [
  { key: OPEN_PROPOSALS_KEY, command: "novelai.openProposals" },
  { key: REOPEN_TEXT_KEY, command: "workbench.action.reopenTextEditor" },
];

/** 提案パネルの、まだ手を付けていない［適用］の数（一覧から外れた行は数えない） */
async function openApplyCount(frame: Frame): Promise<number> {
  return frame.evaluate(
    () =>
      Array.from(document.querySelectorAll('.issue button[data-action="apply"]')).filter((button) => {
        const row = button.closest(".issue");
        return row !== null && !row.classList.contains("resolved") && !row.classList.contains("dismissed") && !row.classList.contains("applied");
      }).length
  );
}

/** 校正・メモパネルの［直す］の数 */
async function memoFixCount(frame: Frame): Promise<number> {
  return frame.evaluate(() => document.querySelectorAll('button[data-act="fix"]').length);
}

async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

async function describeState(page: Page, fake: FakeOllama, from: number): Promise<string> {
  const proposals = await proposalPanelFrame(page);
  const memo = await memoPanelFrame(page);
  return (
    `いまの窓：「${(await quickPickTitle(page)) ?? "なし"}」` +
    `\n出ている知らせ：${JSON.stringify(await notificationTexts(page))}` +
    `\nタブ：${JSON.stringify(await editorGroupTabs(page))}` +
    `\n提案パネルの［適用］：${proposals ? await openApplyCount(proposals) : "パネルなし"}` +
    `\n校正・メモパネルの［直す］：${memo ? await memoFixCount(memo) : "パネルなし"}` +
    `\n${describeFakeRequests(fake.requests, from)}`
  );
}

/**
 * 原稿エディターで Ctrl+Alt+T を押して検知し、校正・メモパネルと提案パネルの両方に指摘が1件並ぶまで進める
 */
async function detectOneTypo(page: Page, frame: Frame, fake: FakeOllama, from: number): Promise<void> {
  await placeCaretAfter(frame, "夜の港");
  await page.keyboard.press(CHECK_TYPOS_PRESS);
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const title = (await quickPickTitle(page)) ?? "";
      const rows = await quickPickRows(page);
      return [title, ...rows.map((row) => row.label)].join("\n").includes("件を処理します");
    },
    "誤字脱字の量の確認が出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await describeState(page, fake, from)}`);
  });
  await page.keyboard.press("Enter");

  // 検知が終わると校正・メモパネルが開いて、指摘が［直す］で並ぶ（作者の裁定 2026-10-04）
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const memo = await memoPanelFrame(page);
      return memo !== undefined && (await memoFixCount(memo)) === 1;
    },
    "校正・メモパネルに指摘が1件［直す］で並ぶ",
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await describeState(page, fake, from)}`);
  });

  // 提案パネルにも同じ指摘が［適用］で並ぶ
  await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
  await waitUntil(
    async () => {
      const proposals = await proposalPanelFrame(page);
      return proposals !== undefined && (await openApplyCount(proposals)) === 1;
    },
    "提案パネルに指摘が1件［適用］で並ぶ",
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await describeState(page, fake, from)}`);
  });
}

/** ファイルが作者の直したとおりになり、2つのパネルから指摘が消えるまで待つ */
async function expectGoneFromPanels(session: E2ESession, fake: FakeOllama, from: number): Promise<void> {
  const { page } = session;
  await waitUntil(async () => (await fileText(session)) === FIXED_TEXT, "本文のファイルが作者の直したとおりになる", 20_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（いまの本文：${JSON.stringify(await fileText(session))}）`);
    }
  );

  await waitUntil(
    async () => {
      const proposals = await proposalPanelFrame(page);
      const memo = await memoPanelFrame(page);
      return (
        proposals !== undefined &&
        (await openApplyCount(proposals)) === 0 &&
        memo !== undefined &&
        (await memoFixCount(memo)) === 0
      );
    },
    "提案パネルの［適用］と校正・メモパネルの［直す］が 0 になる",
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await describeState(page, fake, from)}`);
  });

  // 拡張機能は本文を書き戻さない（直した字のまま）
  expect(await fileText(session)).toBe(FIXED_TEXT);
}

test("原稿エディターで誤字を直して保存すると、提案パネルと校正・メモパネルから指摘が消える", async () => {
  const fake = await startFakeOllama(() => ANSWER);
  try {
    await withVsCode(
      "作者が原稿エディターで直した誤字",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        const from = fake.requests.length;
        await clearNotifications(page);
        const frame = await openEpisode(page, EPISODE, "見上げけて");
        await detectOneTypo(page, frame, fake, from);

        // 原稿エディターへ戻り、「見上げけ」の「け」を消して保存する
        await activateTab(page, EPISODE);
        await placeCaretAfter(frame, "見上げけ");
        await page.keyboard.press("Backspace");
        await page.keyboard.press("ControlOrMeta+KeyS");

        await expectGoneFromPanels(session, fake, from);
      },
      fakeOllamaLaunch(fake, { keybindings: LAUNCH_KEYS })
    );
  } finally {
    await fake.close();
  }
}, 300_000);

test("VS Code の素のエディターで誤字を直して保存すると、提案パネルと校正・メモパネルから指摘が消える", async () => {
  const fake = await startFakeOllama(() => ANSWER);
  try {
    await withVsCode(
      "作者が素のエディターで直した誤字",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        const from = fake.requests.length;
        await clearNotifications(page);
        const frame = await openEpisode(page, EPISODE, "見上げけて");
        await detectOneTypo(page, frame, fake, from);

        // 同じ話を素のエディターで開き直す
        await activateTab(page, EPISODE);
        await pressWorkbenchKey(page, REOPEN_TEXT_PRESS);
        await waitUntil(
          async () => (await textEditorVisibleText(page)).includes("見上げけて"),
          "同じ話が素のエディターで開き直される",
          20_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${await describeState(page, fake, from)}`);
        });

        // 1行目を選んで打ち直し、保存する（全角の字下げを含めて行ごと入れ替える）
        await focusTextEditor(page);
        await page.keyboard.press(EDITOR_TOP_PRESS);
        await page.keyboard.press("Shift+End");
        await page.keyboard.insertText(FIXED_LINE);
        await page.keyboard.press("ControlOrMeta+KeyS");

        await expectGoneFromPanels(session, fake, from);
      },
      fakeOllamaLaunch(fake, { keybindings: LAUNCH_KEYS })
    );
  } finally {
    await fake.close();
  }
}, 300_000);
