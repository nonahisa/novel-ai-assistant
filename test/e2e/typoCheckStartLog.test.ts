/**
 * 原稿エディターの Ctrl+Alt+T（この話の誤字脱字を検知）で、作品の操作ログに残る「誤字脱字検知を開始」の
 * 行の版と、2回目の「処理済み」の飛ばし（画面の自動テスト、設計書6.8.20・6.113、プロンプト設計書 P-09）。
 *
 * 実機確認リスト 0.89.10「大きいモデルを誤字脱字に割り当てて検知し、作品のログの『誤字脱字検知を開始』の
 * 行が v1.2 で終わるか。既定の gemma4:e4b では v1.1 で終わり、前に処理したチャンクが『処理済み』として
 * 飛ばされるか」（397 行）を機械へ移したもの。版の決め方そのもの（20B 以上で 1.2）は単体テスト
 * （`ai/capability.test.ts`・`prompts/typoCheckPrompt.test.ts`）が見ている。ここで見るのは、
 * **拡張機能を動かしたとき、作品のログに実際にその行が書かれるか**（MCP の `novel.run` はログを書かない）。
 *
 * - 大きいモデル：偽の Ollama が大きさ "25.2B"（gemma4:26b の申告）を名乗る → 開始の行が「/ v1.2」で終わる
 * - 小さいモデル：既定の "1B" → 開始の行が「/ v1.1」で終わる。同じ作品で2回目を押すと、確認の窓は出ず
 *   「すべてのチャンクが処理済み」の知らせが出て、終了の行に「処理済み 1件はスキップ」、AI へは送らない
 *
 * **AI は偽の Ollama（`support/fakeOllama.ts`）。** 指摘0件（`{"issues":[]}`）を返す。大きさが件ごとに
 * 違うので、件の中で起こして閉じる（ファイルで共有しない）。誤字脱字の出来は見えない（AI の測定の側）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { activateTab, clearNotifications, quickPickRows, quickPickTitle, statusBarTexts } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";
const START = "誤字脱字検知を開始:";
const END = "誤字脱字検知を終了:";

/** 作品の操作ログ（`.aiwriter/logs/actions.log`）の行 */
async function actionLogLines(session: E2ESession): Promise<string[]> {
  const text = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "");
  return text.replace(/\r\n/g, "\n").split("\n");
}

function linesWith(lines: readonly string[], needle: string): string[] {
  return lines.filter((line) => line.includes(needle));
}

/** 開始の行の末尾の版（「… / v1.2」の 1.2）。末尾に版が無ければ undefined */
function versionAtEnd(line: string): string | undefined {
  return /\/ v(\d+\.\d+)\s*$/.exec(line)?.[1];
}

/** 落ちたときに添える様子：窓・知らせ・ステータスバー・偽の AI への頼み・操作ログの終わり */
async function describeState(session: E2ESession, fake: FakeOllama, from: number): Promise<string> {
  const { page } = session;
  const toasts = await page.locator(".notification-toast").allInnerTexts().catch(() => [] as string[]);
  const rows = await quickPickRows(page).catch(() => []);
  const log = (await actionLogLines(session)).slice(-15).join("\n");
  return (
    `いまの窓：「${(await quickPickTitle(page)) ?? "なし"}」 行：${JSON.stringify(rows.map((row) => row.label).slice(0, 8))}` +
    `\n出ている知らせ：${JSON.stringify(toasts)}` +
    `\nステータスバー：${JSON.stringify(await statusBarTexts(page))}` +
    `\n${describeFakeRequests(fake.requests, from)}` +
    `\n操作ログの終わり：\n${log}`
  );
}

/** 原稿の面に焦点を置いて Ctrl+Alt+T を押す */
async function pressTypoKey(session: E2ESession, frame: Frame): Promise<void> {
  await placeCaretAfter(frame, "静かだった。");
  await session.page.keyboard.press("Control+Alt+KeyT");
}

/**
 * 量の確認（`confirmRunOrChoose`。上部の選ぶ窓「作品：…」、行に「1 チャンク中 1 件を処理します」）を待ち、
 * 先頭の［実行］を Enter で選ぶ
 */
async function confirmRun(session: E2ESession, fake: FakeOllama, from: number): Promise<void> {
  const { page } = session;
  let first = "";
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const title = (await quickPickTitle(page)) ?? "";
      const rows = await quickPickRows(page);
      const text = [title, ...rows.map((row) => row.label)].join("\n");
      if (!text.includes("チャンク中") || !text.includes("件を処理します")) return false;
      expect(text, "確認が開いている原稿の作品で出ていない").toContain(E2E_WORK_TITLE);
      expect(text, "確認に送る量（1 チャンク中 1 件）が出ていない").toContain("1 チャンク中 1 件を処理します");
      first = rows[0]?.label ?? "";
      return true;
    },
    "誤字脱字の量の確認（チャンク中・件を処理します）が出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await describeState(session, fake, from)}`);
  });
  expect(first, "確認の先頭は［実行］（Enter でそのまま走る）").toContain("実行");
  await page.keyboard.press("Enter");
}

/** 操作ログに、開始と終了の行がそれぞれ `count` 本そろうまで待つ */
async function waitRunLogged(session: E2ESession, fake: FakeOllama, from: number, count: number, what: string): Promise<void> {
  await waitUntil(
    async () => {
      await passLocalAiGate(session.page);
      const lines = await actionLogLines(session);
      return linesWith(lines, START).length >= count && linesWith(lines, END).length >= count;
    },
    what,
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await describeState(session, fake, from)}`);
  });
}

test("大きいモデル（25.2B と申告）で Ctrl+Alt+T の誤字脱字検知を走らせると、作品のログの「誤字脱字検知を開始」の行が v1.2 で終わる", async () => {
  const fake = await startFakeOllama(() => JSON.stringify({ issues: [] }), { parameterSize: "25.2B" });
  try {
    await withVsCode(
      "誤字脱字の開始の記録（大きいモデル）",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const from = fake.requests.length;
        const frame = await openEpisode(session.page, EPISODE, "改札を抜けて");
        await pressTypoKey(session, frame);
        await confirmRun(session, fake, from);
        await waitRunLogged(session, fake, from, 1, "操作ログに「誤字脱字検知を開始」と「誤字脱字検知を終了」が書かれる");

        const started = linesWith(await actionLogLines(session), START);
        expect(started, "開始の行は1本").toHaveLength(1);
        expect(started[0], "開始の行は開いている原稿の作品").toContain(`${START} ${E2E_WORK_TITLE} /`);
        expect(versionAtEnd(started[0]), `大きいモデルの開始の行は v1.2 で終わる：${started[0]}`).toBe("1.2");
        expect(fake.requests.length - from, `偽の AI に頼みが届いていない\n${describeFakeRequests(fake.requests, from)}`).toBeGreaterThan(0);
      },
      fakeOllamaLaunch(fake)
    );
  } finally {
    await fake.close();
  }
}, 240_000);

test("既定の小さいモデル（1B と申告）では開始の行が v1.1 で終わり、同じ作品で2回目を押すと確認なしで「処理済み」として飛ばし、AI へ送らない", async () => {
  const fake = await startFakeOllama(() => JSON.stringify({ issues: [] }));
  try {
    await withVsCode(
      "誤字脱字の開始の記録（小さいモデル・2回目）",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        const from = fake.requests.length;

        /* ── 1回目：確認 → Enter で走る。開始の行は v1.1 ── */
        const frame = await openEpisode(page, EPISODE, "改札を抜けて");
        await pressTypoKey(session, frame);
        await confirmRun(session, fake, from);
        await waitRunLogged(session, fake, from, 1, "1回目：操作ログに「誤字脱字検知を開始」と「誤字脱字検知を終了」が書かれる");
        const firstStart = linesWith(await actionLogLines(session), START);
        expect(firstStart, "1回目の開始の行は1本").toHaveLength(1);
        expect(firstStart[0], "開始の行は開いている原稿の作品").toContain(`${START} ${E2E_WORK_TITLE} /`);
        expect(versionAtEnd(firstStart[0]), `小さいモデルの開始の行は v1.1 で終わる：${firstStart[0]}`).toBe("1.1");
        const afterFirst = fake.requests.length;
        expect(afterFirst - from, `1回目で偽の AI に頼みが届いていない\n${describeFakeRequests(fake.requests, from)}`).toBeGreaterThan(0);

        /*
          ── 2回目：同じ話でもう一度。1回目の結果で提案パネルが前に出るので、原稿のタブを前に戻し、
          面を取り直してから押す（古い面を使い回さない） ──
        */
        await clearNotifications(page);
        await activateTab(page, EPISODE);
        const again = await openEpisode(page, EPISODE, "改札を抜けて");
        await pressTypoKey(session, again);
        await waitRunLogged(session, fake, afterFirst, 2, "2回目：操作ログに2本目の「誤字脱字検知を開始」と「誤字脱字検知を終了」が書かれる");

        const lines = await actionLogLines(session);
        const starts = linesWith(lines, START);
        const ends = linesWith(lines, END);
        expect(versionAtEnd(starts[1]), `2回目の開始の行も v1.1 で終わる：${starts[1]}`).toBe("1.1");
        expect(ends[1], "2回目は前に処理したチャンクを「処理済み」として飛ばす").toContain("処理済み 1件はスキップ");

        /*
          処理済みの知らせが出て、確認の窓は出ず、AI へは送らない。
          知らせは時間がたつと引っ込むので、見続ける（holdsFor）より先に読む
        */
        await waitUntil(
          async () =>
            (await page.locator(".notification-toast", { hasText: "すべてのチャンクが処理済みです" }).count()) > 0 ||
            (await statusBarTexts(page)).some((text) => text.includes("すべてのチャンクが処理済みです")),
          "2回目：「AIでの検知はすべてのチャンクが処理済みです」の知らせが出る",
          15_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${await describeState(session, fake, afterFirst)}`);
        });
        await holdsFor(
          async () => fake.requests.length === afterFirst && (await quickPickTitle(page)) === undefined,
          "2回目なのに確認の窓が出たか、偽の AI へ頼みが届いた",
          3_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${await describeState(session, fake, afterFirst)}`);
        });
      },
      fakeOllamaLaunch(fake)
    );
  } finally {
    await fake.close();
  }
}, 300_000);
