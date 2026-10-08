/**
 * 原稿エディターの Ctrl+Alt+P（推敲）の確認の流れ（画面の自動テスト、設計書6.25.10・6.8.7・6.113）。
 *
 * 実機確認リスト 0.96.x「作品一覧で別の作品を選んだまま原稿に戻って Ctrl+Alt+P」を機械へ移したもの。
 * 見張るのは、**作品一覧で別の作品（作品B）を選んだままでも、開いている原稿の作品（作品A）で進む**こと、
 * と、**どこでも Esc で止まる**こと。縦書き・横書きの両方で押す。
 *
 * 1. 打ちかけの字があれば、上部に「未保存の変更が 1 件あります」の窓が出て、先頭が［保存して実行］
 *    （作品を選ぶ窓は出ない）。Esc で止めると、ファイルは書き換わらず、次の窓も出ない
 * 2. Enter で保存すると、本文のファイルに打った字が入り、範囲の窓「どこまで見ますか」の先頭が
 *    「この話だけ（ファイル名）」。Esc で止めると、次の窓が出ない
 * 3. 保存済みなら、1 を飛ばして範囲の窓から出る。Enter で進むと、AI へ繋ぐ段になる
 *
 * ## AI は呼ばない（ここまでで止める）
 *
 * AI は ChatGPT の口を選んだことにし（`globalState`）、行き先を捨て settings で `127.0.0.1:9`
 * （すぐ断られる場所）へ向ける。3 で「AIに接続できないため、推敲を開始できません」の窓が出る
 * ——**AI に繋ぎに行く段まで進んだ**ことの印で、実際には何も送らない（`separationRetraction.test.ts`
 * と同じ形）。この先の「料金・量の確認 → Enter で走る」は、AI が通じていないと出ないので、
 * 画面の自動テストでは見ない（AI の測定の側）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
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
  return {
    ...SIDEBAR_LAUNCH,
    globalState: { "novelai.ai.provider": "openai", "novelai.ai.model": "e2e-fixture-model" },
    settings: { ...SIDEBAR_LAUNCH.settings, "novelai.openai.endpoint": "http://127.0.0.1:9/v1" },
    keybindings: [...SIDEBAR_LAUNCH.keybindings, ...VERTICAL_LAUNCH.keybindings, registerOther],
    prepareWork: async ({ workFolder }) => {
      // 作品Aと同じ書庫の中に、もう1つ作品を置く
      const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
      await mkdir(path.join(otherFolder, "本文"), { recursive: true });
      await writeFile(path.join(otherFolder, "本文", "001_別の作品.txt"), "　別の作品の本文。\n", "utf8");
      registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
    },
  };
}

async function readEpisode(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
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

async function pickerGone(page: Page): Promise<boolean> {
  return (await quickPickTitle(page)) === undefined;
}

/** 面（横書き or 縦書き）で、打ちかけの字を1つ足す */
async function typeOne(frame: Frame, page: Page, mark: string): Promise<void> {
  await placeCaretAfter(frame, "静かだった。");
  await page.keyboard.insertText(mark);
  await waitUntil(async () => (await composeText(frame)).includes(mark), `打った字「${mark}」が面に出る`);
}

async function runFlow(session: E2ESession, frame: Frame, label: string): Promise<void> {
  const { page } = session;

  /* 作品Bを登録して、作品一覧でそちらを選んだままにする */
  await page.keyboard.press(REGISTER_OTHER_PRESS);
  await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
  await clearNotifications(page);
  await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
  const rowB = page.locator(`.monaco-list-row[aria-label*="${OTHER_TITLE}"]`).first();
  await waitUntil(async () => (await rowB.count()) > 0, "作品一覧に作品Bの行が出る", 20_000);
  await rowB.click();

  /* ── 1：打ちかけ → 保存の窓。Esc で止めると何も変わらない ── */
  await typeOne(frame, page, `【${label}1】`);
  await page.keyboard.press("Control+Alt+KeyP");
  const save = await waitTopPicker(page, "作品：" + E2E_WORK_TITLE, "未保存の変更が 1 件あります");
  expect(save.first, `${label}：保存の窓の先頭`).toContain("保存して実行");
  await page.keyboard.press("Escape");
  await holdsFor(async () => (await pickerGone(page)) && !(await readEpisode(session)).includes(`【${label}1】`), `${label}：Esc で止めたのに窓が続くか本文が書き換わった`, 2_500);

  /* ── 2：もう一度 → Enter で保存 → 範囲の窓の先頭は「この話だけ」。Esc で止める ── */
  await placeCaretAfter(frame, "静かだった。");
  await page.keyboard.press("Control+Alt+KeyP");
  await waitTopPicker(page, "作品：" + E2E_WORK_TITLE, "未保存の変更が 1 件あります");
  await page.keyboard.press("Enter");
  const scope = await waitTopPicker(page, "どこまで見ますか");
  expect(scope.first, `${label}：範囲の窓の先頭`).toContain("この話だけ");
  expect(scope.first, `${label}：範囲の窓の先頭に話のファイル名`).toContain(EPISODE);
  await waitUntil(async () => (await readEpisode(session)).includes(`【${label}1】`), `${label}：保存して実行で本文のファイルに打った字が入る`);
  await page.keyboard.press("Escape");
  await holdsFor(async () => await pickerGone(page), `${label}：Esc で止めたのに次の窓が出た`, 2_500);

  /* ── 3：保存済みなら範囲の窓から。Enter で AI へ繋ぐ段まで進む ── */
  await placeCaretAfter(frame, "静かだった。");
  await page.keyboard.press("Control+Alt+KeyP");
  const direct = await waitTopPicker(page, "どこまで見ますか");
  expect(direct.first, `${label}：保存済みなら、保存の窓を飛ばして範囲の窓から出る`).toContain("この話だけ");
  await page.keyboard.press("Enter");
  await waitUntil(
    async () => (await page.locator(".notification-toast", { hasText: "AIに接続できないため、推敲を開始できません" }).count()) > 0,
    `${label}：AI へ繋ぐ段まで進む（接続できない旨の窓）`,
    30_000
  ).catch(async (error: unknown) => {
    const toasts = await page.locator(".notification-toast").allInnerTexts();
    throw new Error(`${String(error)}（知らせ：${JSON.stringify(toasts)}／窓：${(await quickPickTitle(page)) ?? "なし"}）`);
  });
  await clearNotifications(page);
}

test("作品一覧で別の作品を選んだままでも、横書きの原稿の Ctrl+Alt+P は保存の窓→範囲の窓の順で、どこでも Esc で止まる", async () => {
  await withVsCode(
    "推敲のキー（横書き）",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const frame = await openEpisode(session.page, EPISODE, "改札を抜けて");
      await runFlow(session, frame, "横");
    },
    launchOptionsFor()
  );
}, 240_000);

test("作品一覧で別の作品を選んだままでも、縦書きの原稿の Ctrl+Alt+P は保存の窓→範囲の窓の順で、どこでも Esc で止まる", async () => {
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
}, 240_000);
