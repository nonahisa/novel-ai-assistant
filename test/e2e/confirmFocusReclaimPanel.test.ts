/**
 * 確認の窓が出た直後に、提案パネル（WebView）が焦点を取り返しても、焦点が窓へ戻る
 * （画面の自動テスト、設計書6.81・6.113。2026-11-14。0.152.1 の原稿エディターの件
 * `confirmFocusReclaim.test.ts` を写し、ほかのパネルへ広げた直しを見る）。
 *
 * ## 何が起きうるか
 *
 * 範囲の窓（どこまで見ますか）が閉じると、VS Code 本体は焦点を前に出ているエディター——
 * ここでは提案パネル——へ戻す。WebView への戻し方は **50ms 遅らせてから「focus」の便を中へ
 * 送る**（本体の `_focusDelayer`）。便の処理が遅れると、続けて出た実行の確認（外をクリック
 * しても閉じない窓）から焦点を取り、Enter が窓へ届かない。パネルの画面は押さずに受けた焦点を
 * 知らせ（`views/focusReportScript.ts`）、拡張機能が窓へ戻す（`views/pickerFocus.ts`）。
 *
 * ## 題材：推敲を、提案パネルを前に出してコマンドパレットから
 *
 * 話を11話置く。範囲の窓は、選べるものが「全体」だけなら出ない（`core/typoCheckScope.ts` の
 * `scopeKinds`。11話あれば「はじめの10話だけ」が並ぶ）。推敲の実行の確認は、送るチャンクがあれば
 * 必ず出る（`features/checkProofread.ts`。初回なので全部が未処理）。
 * はじめは矛盾検知で書いたが、話2つ・1チャンクの題材では送るものが無く、確認の窓が出ないまま
 * 走った（2026-11-14 の全件で落ちた）ので、確認が必ず出る推敲に替えた。
 *
 * ## 仕込み（原稿エディターの件と同じ）
 *
 * - 接続の確かめ（偽の Ollama の `/api/tags`）を 150ms 遅らせる——確認の窓が、本体の 50ms の
 *   遅らせより後に出るようにする
 * - 範囲の窓で行を押す直前に、提案パネルの中（外枠と中身）を空回しさせる——
 *   「focus」の便の処理を、確認の窓が出たあとへずらす
 *
 * 取り返しが起きて拡張機能が窓へ戻したこと（操作ログの「提案パネルが焦点を取ったので、窓へ
 * 戻しました」）を確かめてから、**焦点が確認の窓にあり、Enter で推敲が走る**ことを見る。
 * 取り返しが起きなければ、仕込みが効いていないので落とす（何も確かめずに通さない）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, test } from "vitest";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { runCommand } from "./support/quickInput";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame } from "./support/sampleFinding";
import { withVsCode, type E2ESession, type FixtureEpisode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  activeElementSummary,
  focusInside,
  pickQuickPickRow,
  pressWorkbenchKey,
  quickPickRows,
  quickPickTitle,
} from "./support/workbenchDom";

/** 11話。10話を超えるので、範囲の窓に「はじめの10話だけ」と「作品全体」が並ぶ */
const EPISODES: FixtureEpisode[] = Array.from({ length: 11 }, (_, index) => {
  const number = String(index + 1).padStart(3, "0");
  return { name: `${number}_第${index + 1}話.txt`, text: `　第${index + 1}話の朝は静かだった。\n　改札を抜けて、白い息を吐いた。\n` };
});

/** 接続の確かめを遅らせる長さ。本体が WebView へ焦点を戻すまでの遅らせ（50ms）より長くする */
const TAGS_DELAY_MS = 150;
/** パネルの中を空回しさせる長さ。確認の窓が出るまで（上の遅らせ＋区切りの計算）より長くする */
const BUSY_MS = 1_500;
/** 拡張機能が窓へ戻したときに操作ログへ書く行（`views/pickerFocus.ts` の `reclaimPickerFocus`） */
const RECLAIM_LOG = "確認の窓が出ている間に提案パネルが焦点を取ったので、窓へ戻しました";

let fake: FakeOllama;
let tagsDelay = 0;
beforeAll(async () => {
  fake = await startFakeOllama(() => JSON.stringify({ issues: [] }), {
    beforeTags: () => new Promise((resolve) => setTimeout(resolve, tagsDelay)),
  });
});
afterAll(async () => {
  await fake.close();
});

/** パネルの中で、窓（window）が焦点を受けた回数を数え始める */
async function countFaceFocus(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const holder = window as unknown as { __e2eFaceFocus?: number };
    if (holder.__e2eFaceFocus !== undefined) return;
    holder.__e2eFaceFocus = 0;
    window.addEventListener("focus", (event) => {
      if (event.target === window) holder.__e2eFaceFocus = (holder.__e2eFaceFocus ?? 0) + 1;
    });
  });
}

async function faceFocusCount(frame: Frame): Promise<number> {
  return frame.evaluate(() => (window as unknown as { __e2eFaceFocus?: number }).__e2eFaceFocus ?? 0).catch(() => -1);
}

/** パネルの外枠と中身を、`at` ms 後から `ms` ms 空回しさせる（どちらも待たずに戻る） */
async function busyFace(frame: Frame, at: number, ms: number): Promise<void> {
  for (const target of [frame, frame.parentFrame()]) {
    if (!target) continue;
    await target.evaluate(
      ({ delay, length }) => {
        setTimeout(() => {
          const start = performance.now();
          while (performance.now() - start < length) {
            /* 遅い機械で画面が塞がっている代わり。何もしないで時間だけ使う */
          }
        }, delay);
      },
      { delay: at, length: ms }
    );
  }
}

async function actionLog(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

async function stateText(page: Page, session: E2ESession, frame: Frame): Promise<string> {
  const rows = await quickPickRows(page).catch(() => []);
  return (
    `焦点：${await activeElementSummary(page)}` +
    `\n窓：「${(await quickPickTitle(page)) ?? "なし"}」 行：${JSON.stringify(rows.map((row) => row.label).slice(0, 4))}` +
    `\nパネルが焦点を受けた回数：${await faceFocusCount(frame)}` +
    `\n${describeFakeRequests(fake.requests)}` +
    `\n操作ログの終わり：\n${(await actionLog(session)).split("\n").slice(-12).join("\n")}`
  );
}

test("確認の窓が出た直後に提案パネルが焦点を取り返しても、焦点は確認の窓へ戻り、Enter で推敲が走る", async () => {
  await withVsCode(
    "確認の窓の焦点の取り返し（提案パネル）",
    EPISODES,
    async (session) => {
      const { page } = session;

      /* ── 提案パネルを開き、押して前に出す（窓が閉じたあと、本体はここへ焦点を戻す） ── */
      let found: Frame | undefined;
      await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
      await waitUntil(async () => (found = await proposalPanelFrame(page)) !== undefined, "提案パネルが開く", 30_000);
      if (!found) throw new Error("提案パネルが見つかりません");
      const frame = found;
      await frame.locator("body").click({ position: { x: 4, y: 4 } });
      await countFaceFocus(frame);
      const fail = async (error: unknown): Promise<never> => {
        throw new Error(`${String(error)}\n${await stateText(page, session, frame)}`);
      };

      /* ── 推敲 → 範囲の窓 ── */
      await runCommand(page, "推敲");
      await waitUntil(async () => (await quickPickTitle(page)) === "どこまで見ますか", "範囲の窓が出る", 20_000).catch(fail);

      tagsDelay = TAGS_DELAY_MS;
      const before = await faceFocusCount(frame);
      await busyFace(frame, 30, BUSY_MS);
      await pickQuickPickRow(page, "はじめの10話だけ");

      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return ((await quickPickTitle(page)) ?? "").includes("推敲を行います");
        },
        "実行の確認の窓が出る",
        30_000
      ).catch(fail);

      // 仕込みが効いて、確認の窓が出たあとにパネルが焦点を受け、拡張機能が窓へ戻したこと
      // （受けなければ、このテストは何も見ていない）
      await waitUntil(
        async () => (await faceFocusCount(frame)) > before && (await actionLog(session)).includes(RECLAIM_LOG),
        "確認の窓が出たあとにパネルが焦点を受け、拡張機能が窓へ戻す（仕込みが効いたしるし）",
        15_000
      ).catch(fail);

      await waitUntil(
        async () => await focusInside(page, ".quick-input-widget"),
        "パネルに取られた焦点が、確認の窓へ戻る",
        10_000
      ).catch(fail);

      tagsDelay = 0;
      await page.keyboard.press("Enter");
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const log = await actionLog(session);
          return log.includes("推敲を開始:") && log.includes("推敲を終了:");
        },
        "確認の窓で Enter を押すと推敲が走る",
        60_000
      ).catch(fail);
    },
    fakeOllamaLaunch(fake, OPEN_PROPOSALS_LAUNCH)
  );
}, 300_000);
