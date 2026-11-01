/**
 * 原稿エディターの Ctrl+Alt+P（推敲）の確認の流れと走り出し（画面の自動テスト、設計書6.25.10・6.8.7・6.113）。
 *
 * 実機確認リスト 0.96.x「作品一覧で別の作品を選んだまま原稿に戻って Ctrl+Alt+P」（275 行）を機械へ移したもの。
 * 見張るのは、**作品一覧で別の作品（作品B）を選んだままでも、開いている原稿の作品（作品A）で進む**こと、
 * **どこでも Esc で止まる**こと、**量の確認で Enter を押すと推敲が走る**こと。縦書き・横書きの両方で押す。
 *
 * 保存の問いは、0.122.0 で実行の確認の窓の1行にまとめた（作者の判断 2026-11-02。`features/presave.ts`）。
 * それまでの「保存の窓→範囲の窓→量の確認」は、いまは「範囲の窓→量の確認（未保存があれば保存の1行つき）」。
 * **保存の窓が先に出ないこと**と、**確認で取りやめたら保存しないこと**もここで見張る。
 *
 * 0. 保存済みなら、範囲の窓「どこまで見ますか」の先頭が「この話だけ」。Enter で進むと料金・量の確認
 *    （「作品A の推敲を行います。」「1チャンク中 1件を処理します」、先頭が［実行］）が出て、保存の1行は無い。
 *    Esc で止めると、推敲は始まらない（操作ログに「推敲を開始」が無く、AI へも何も送らない）
 * 1. 打ちかけの字があっても、最初に出るのは範囲の窓（先頭は「この話だけ（ファイル名）」。
 *    「未保存の変更が N 件あります」の窓は出ない）。Esc で止めると、ファイルは書き換わらず、次の窓も出ない
 * 2. もう一度範囲の窓を Enter で進むと、確認に「未保存の 1 件を保存してから実行します。」の1行が出る。
 *    Esc で止めると、ファイルは書き換わらず（取りやめたら保存しない）、推敲も始まらない
 * 3. もう一度確認まで進め、Enter を押すと、保存してから推敲が走る。本文のファイルに打った字が入り、
 *    作品A の操作ログに「推敲を開始: 作品A …」と「推敲を終了: 1/1 …」が書かれ、偽の AI に頼みが届く。
 *    保存したあとに2回目の確認は出ない（保存した本文で読み直して、そのまま走る）
 *
 * ## AI は偽の Ollama（2026-10-13 に替えた）
 *
 * 初めは ChatGPT の口を選んだことにして行き先を捨て、「AIに接続できない」の窓までしか見られなかった
 * （料金・量の確認は、AI が通じていないと出ない）。偽の Ollama（`support/fakeOllama.ts`）なら
 * 接続の確かめが通り、確認から走り出しまで届く。偽の AI は指摘0件（`{"issues":[]}`）を返す。
 * 見られるのは**確認の窓と走り出しの配線**だけで、推敲の出来は見えない（AI の測定の側）。
 * 偽の Ollama は手元の AI 扱いなので料金の行は出ない（量と所要時間の行だけ）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { composeText, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { turnVertical, VERTICAL_LAUNCH } from "./support/verticalFace";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  pressWorkbenchKey,
  quickPickRows,
  quickPickTitle,
} from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";
const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";

/** 横書き・縦書きの2件で共有する偽の Ollama。件ごとの頼みは、件の頭で控えた数からの差で数える */
let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => JSON.stringify({ issues: [] }));
});
afterAll(async () => {
  await fake.close();
});

/**
 * 作品Bの登録のキー。置き場の道は一時フォルダーができてから決まるので、
 * 起こす前の準備（下）で args を埋める（keybindings.json はその準備のあとに書かれる）
 */
function launchOptionsFor(): LaunchOptions {
  const registerOther: Record<string, unknown> = {
    key: REGISTER_OTHER_KEY,
    command: "novelai.addWork",
    args: { folderPath: "", title: OTHER_TITLE },
  };
  return fakeOllamaLaunch(fake, {
    ...SIDEBAR_LAUNCH,
    keybindings: [...SIDEBAR_LAUNCH.keybindings, ...VERTICAL_LAUNCH.keybindings, registerOther],
    prepareWork: async ({ workFolder }) => {
      // 作品Aと同じ書庫の中に、もう1つ作品を置く
      const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
      await mkdir(path.join(otherFolder, "本文"), { recursive: true });
      await writeFile(path.join(otherFolder, "本文", "001_別の作品.txt"), "　別の作品の本文。\n", "utf8");
      registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
    },
  });
}

async function readEpisode(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

/** 作品A の操作ログ（`.aiwriter/logs/actions.log`）の行 */
async function actionLogLines(session: E2ESession): Promise<string[]> {
  const text = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "");
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** 落ちたときに添える様子：窓・知らせ・偽の AI への頼み・操作ログの終わり */
async function describeState(session: E2ESession, from: number): Promise<string> {
  const { page } = session;
  const toasts = await page.locator(".notification-toast").allInnerTexts().catch(() => [] as string[]);
  const rows = await quickPickRows(page).catch(() => []);
  const log = (await actionLogLines(session)).slice(-15).join("\n");
  return (
    `いまの窓：「${(await quickPickTitle(page)) ?? "なし"}」 行：${JSON.stringify(rows.map((row) => row.label).slice(0, 8))}` +
    `\n出ている知らせ：${JSON.stringify(toasts)}` +
    `\n${describeFakeRequests(fake.requests, from)}` +
    `\n操作ログの終わり：\n${log}`
  );
}

/** 上部の選ぶ窓（題と先頭の行）を、出るまで待って返す */
async function waitTopPicker(page: Page, titlePart: string, rowPart?: string): Promise<{ title: string; first: string }> {
  let found: { title: string; first: string } | undefined;
  await waitUntil(
    async () => {
      const title = (await quickPickTitle(page)) ?? "";
      if (!title.includes(titlePart)) return false;
      const rows = await quickPickRows(page);
      if (rows.length === 0) return false;
      if (rowPart !== undefined && !rows.some((row) => row.label.includes(rowPart))) return false;
      found = { title, first: rows[0].label };
      return true;
    },
    `上部の窓「${titlePart}」が出る`,
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの窓：「${(await quickPickTitle(page)) ?? "なし"}」）`);
  });
  return found as { title: string; first: string };
}

/**
 * 料金・量の確認（`views/notify.ts` の `confirmRunOrChoose`。上部の選ぶ窓）を待つ。
 *
 * 題は「作品A の推敲を行います。」が既定だが、作品を推し量った回は「作品：作品A」が題になり
 * 文は行へ回る（`withWorkTitle`）。どちらでも当たるよう、題と行を合わせた字で探す。
 * 待つあいだ、手元の AI の関所（GPU が忙しいと出る）が出ていれば通す
 */
async function waitRunConfirm(session: E2ESession, label: string, from: number): Promise<{ text: string; first: string }> {
  const { page } = session;
  let found: { text: string; first: string } | undefined;
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const title = (await quickPickTitle(page)) ?? "";
      const rows = await quickPickRows(page);
      const text = [title, ...rows.map((row) => row.label)].join("\n");
      if (!text.includes("推敲を行います") || !text.includes("件を処理します")) return false;
      found = { text, first: rows[0]?.label ?? "" };
      return true;
    },
    `${label}：料金・量の確認（推敲を行います・件を処理します）が出る`,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await describeState(session, from)}`);
  });
  return found as { text: string; first: string };
}

async function pickerGone(page: Page): Promise<boolean> {
  return (await quickPickTitle(page)) === undefined;
}

/** 面（横書き or 縦書き）で、打ちかけの字を1つ足す */
async function typeOne(frame: Frame, page: Page, mark: string): Promise<void> {
  await placeCaretAfter(frame, "静かだった。");
  await page.keyboard.insertText(mark);
  await waitUntil(async () => (await composeText(frame)).includes(mark), `打った字「${mark}」が面に出る`);
}

/**
 * Ctrl+Alt+P → 範囲の窓の先頭（この話だけ）で Enter まで進める。
 * 打ちかけがあっても、**最初に出るのは範囲の窓**（保存は確認の窓で訊く。作者の判断 2026-11-02）
 */
async function pressAndPassScope(frame: Frame, page: Page, label: string, dirty = false): Promise<void> {
  await placeCaretAfter(frame, "静かだった。");
  await page.keyboard.press("Control+Alt+KeyP");
  const direct = await waitTopPicker(page, "どこまで見ますか");
  expect(direct.first, `${label}：${dirty ? "打ちかけがあっても" : "保存済みなら"}、範囲の窓から出て先頭は「この話だけ」`).toContain("この話だけ");
  await page.keyboard.press("Enter");
}

/** 確認の窓に出る、保存の1行（`views/notify.ts` の `presaveLine`） */
const PRESAVE_LINE = "未保存の 1 件を保存してから実行します。";

/** 窓が閉じ、推敲が始まっておらず、AI へも何も送っていない（`mark` を渡せば、本文にその字が無いことも） */
async function stoppedQuietly(session: E2ESession, from: number, mark?: string): Promise<boolean> {
  return (
    (await pickerGone(session.page)) &&
    (mark === undefined || !(await readEpisode(session)).includes(mark)) &&
    !(await actionLogLines(session)).some((line) => line.includes("推敲を開始:")) &&
    fake.requests.length === from
  );
}

async function runFlow(session: E2ESession, frame: Frame, label: string): Promise<void> {
  const { page } = session;
  const from = fake.requests.length;

  /* 作品Bを登録して、作品一覧でそちらを選んだままにする */
  await page.keyboard.press(REGISTER_OTHER_PRESS);
  await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
  await clearNotifications(page);
  await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
  const rowB = page.locator(`.monaco-list-row[aria-label*="${OTHER_TITLE}"]`).first();
  await waitUntil(async () => (await rowB.count()) > 0, "作品一覧に作品Bの行が出る", 20_000);
  await rowB.click();

  /* ── 0：保存済み → 範囲の窓 → 確認（保存の1行なし）。Esc で止めると推敲は始まらない ── */
  await pressAndPassScope(frame, page, label);
  const saved = await waitRunConfirm(session, label, from);
  expect(saved.first, `${label}：確認の先頭は［実行］（Enter でそのまま走る）`).toContain("実行");
  expect(saved.text, `${label}：確認は開いている原稿の作品（作品A）で出る`).toContain(E2E_WORK_TITLE);
  expect(saved.text, `${label}：確認に作品一覧で選んだ作品Bが出ている`).not.toContain(OTHER_TITLE);
  expect(saved.text, `${label}：確認に送る量（1チャンク中 1件）が出ていない`).toContain("1チャンク中 1件を処理します");
  expect(saved.text, `${label}：保存済みなのに、確認に保存の1行が出ている`).not.toContain("未保存の");
  await page.keyboard.press("Escape");
  await holdsFor(async () => await stoppedQuietly(session, from), `${label}：確認を Esc で止めたのに、窓が続くか推敲が始まった`, 3_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}\n${await describeState(session, from)}`);
    }
  );

  /* ── 1：打ちかけ → 最初に出るのは範囲の窓（保存の窓は出ない）。Esc で止めると何も変わらない ── */
  const mark = `【${label}1】`;
  await typeOne(frame, page, mark);
  await page.keyboard.press("Control+Alt+KeyP");
  const scope = await waitTopPicker(page, "どこまで見ますか");
  expect(scope.first, `${label}：範囲の窓の先頭`).toContain("この話だけ");
  expect(scope.first, `${label}：範囲の窓の先頭に話のファイル名`).toContain(EPISODE);
  await page.keyboard.press("Escape");
  await holdsFor(async () => await stoppedQuietly(session, from, mark), `${label}：範囲の窓を Esc で止めたのに、窓が続くか本文が書き換わった`, 2_500).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}\n${await describeState(session, from)}`);
    }
  );

  /* ── 2：範囲の窓を Enter → 確認に保存の1行。Esc で止めると保存も推敲もしない ── */
  await pressAndPassScope(frame, page, label, true);
  const unsaved = await waitRunConfirm(session, label, from);
  expect(unsaved.first, `${label}：保存つきの確認の先頭は［実行］`).toContain("実行");
  expect(unsaved.text, `${label}：確認に保存の1行が出ていない`).toContain(PRESAVE_LINE);
  expect(unsaved.text, `${label}：保存つきの確認が作品Aで出ていない`).toContain(E2E_WORK_TITLE);
  expect(unsaved.text, `${label}：保存つきの確認に作品Bが出ている`).not.toContain(OTHER_TITLE);
  await page.keyboard.press("Escape");
  await holdsFor(
    async () => await stoppedQuietly(session, from, mark),
    `${label}：保存つきの確認を Esc で止めたのに、窓が続くか、保存されたか、推敲が始まった`,
    3_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await describeState(session, from)}`);
  });

  /* ── 3：もう一度確認まで進め、Enter で保存してから推敲が走る（作品Aの操作ログに開始と終了） ── */
  await pressAndPassScope(frame, page, label, true);
  const again = await waitRunConfirm(session, label, from);
  expect(again.text, `${label}：2回目の保存つきの確認に保存の1行が出ていない`).toContain(PRESAVE_LINE);
  await page.keyboard.press("Enter");
  await waitUntil(async () => (await readEpisode(session)).includes(mark), `${label}：確認の［実行］で本文のファイルに打った字が入る`).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}\n${await describeState(session, from)}`);
    }
  );
  // 保存したあとは、保存した本文で読み直してそのまま走る。2回目の確認が出たら覚えておく
  let secondConfirm = false;
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      if (((await quickPickTitle(page)) ?? "").includes("推敲を行います")) secondConfirm = true;
      const lines = await actionLogLines(session);
      return lines.some((line) => line.includes("推敲を開始:")) && lines.some((line) => line.includes("推敲を終了:"));
    },
    `${label}：確認で Enter を押すと推敲が走り、操作ログに「推敲を開始」と「推敲を終了」が書かれる`,
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await describeState(session, from)}`);
  });
  expect(secondConfirm, `${label}：保存したあとに、もう一度確認の窓が出た`).toBe(false);
  const lines = await actionLogLines(session);
  const started = lines.filter((line) => line.includes("推敲を開始:"));
  const ended = lines.filter((line) => line.includes("推敲を終了:"));
  expect(started, `${label}：推敲を開始は1回だけ（Esc で止めた回は始まっていない）`).toHaveLength(1);
  expect(started[0], `${label}：推敲は作品Aで走る`).toContain(`推敲を開始: ${E2E_WORK_TITLE} /`);
  expect(ended[0], `${label}：1チャンクを送り終えた`).toContain("推敲を終了: 1/1（失敗 0件");
  expect(fake.requests.length - from, `${label}：偽の AI に頼みが届いていない\n${describeFakeRequests(fake.requests, from)}`).toBeGreaterThan(0);
  await clearNotifications(page);
}

test("作品一覧で別の作品を選んだままでも、横書きの原稿の Ctrl+Alt+P は範囲の窓→量の確認（未保存は保存の1行つき）の順で、どこでも Esc で止まり、確認で Enter を押すと推敲が走る", async () => {
  await withVsCode(
    "推敲のキー（横書き）",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const frame = await openEpisode(session.page, EPISODE, "改札を抜けて");
      await runFlow(session, frame, "横");
    },
    launchOptionsFor()
  );
}, 300_000);

test("作品一覧で別の作品を選んだままでも、縦書きの原稿の Ctrl+Alt+P は範囲の窓→量の確認（未保存は保存の1行つき）の順で、どこでも Esc で止まり、確認で Enter を押すと推敲が走る", async () => {
  await withVsCode(
    "推敲のキー（縦書き）",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      await openEpisode(session.page, EPISODE, "改札を抜けて");
      const vertical = await turnVertical(session, "改札を抜けて");
      await runFlow(session, vertical, "縦");
    },
    launchOptionsFor()
  );
}, 300_000);
