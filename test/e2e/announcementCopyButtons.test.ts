/**
 * 更新告知文の通知「X用をコピー」「活動報告用をコピー」「後書き用をコピー」
 * （画面の自動テスト、設計書6.41・6.79.8・6.113。実機確認リスト F-48 の
 * 「通知の『X用をコピー』を押すとクリップボードに入り、残りのボタンで通知がもう一度出るか。
 * 3つ押すと終わるか」を 2026-10-09 に移した）。
 *
 * 何を見張るか：
 * - 告知の設定（ハッシュタグ・URL）→ 話の選択 → 処理量の確認 →（偽の AI が答える）→ 結果の文書が開き、
 *   通知に3つのコピーのボタンと「Xへ貼り付ける」が並ぶ
 * - 「X用をコピー」を押すと、**クリップボードに X 用の文**（AI の文＋ハッシュタグ＋URL）が入り、
 *   通知がもう一度出て、押した「X用」は並ばず、残り2つが並ぶ（文言は「X用 をコピーしました」）
 * - 続けて2つ押すと、それぞれの文がクリップボードに入り、**3つ押したあとはコピーのボタンが無くなる**。
 *   残るのは「Xへ貼り付ける」だけ（押すと作者のブラウザが開くので押さない）。通知を閉じて終える
 *
 * **本物の AI は呼ばない**（偽の Ollama）。クリップボードは本物の OS のものを読む
 * （Electron 本体の `clipboard`）ので、**走らせたあと、前の中身へ戻す**。
 * 「X の投稿欄に貼って字数が収まるか」は別アプリなので見ない（作者の手）。
 */
import type { Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { answerInput, runCommand, waitForQuickInput } from "./support/quickInput";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, pickQuickPickRow, quickPickRows } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const X_POST = "第1話を更新しました。朝の駅の静かな場面から始まります。";
const ACTIVITY = "活動報告：第1話を公開しました。ゆっくり読んでいただければ幸いです。";
const AFTERWORD = "後書き：書きながら、朝の駅の冷たさを思い出していました。";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() =>
    JSON.stringify({
      xPost: X_POST,
      activityReport: ACTIVITY,
      afterword: AFTERWORD,
      spoilerCheck: "結末には触れていません",
      confidence: "high",
    })
  );
});
afterAll(async () => {
  await fake.close();
});

/** 右下の知らせの本文（上から） */
async function noticeTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".notification-toast")).map((toast) => (toast as HTMLElement).innerText)
  );
}

/** 知らせの中のボタンの名前（左から） */
async function noticeButtons(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".notification-toast .monaco-button")).map((button) => (button.textContent ?? "").trim())
  );
}

/** OS のクリップボード（Electron 本体）の字を読む／書く */
async function readClipboard(session: E2ESession): Promise<string> {
  return session.app.evaluate(({ clipboard }) => clipboard.readText());
}
async function writeClipboard(session: E2ESession, text: string): Promise<void> {
  await session.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
}

test("告知の通知で「X用をコピー」を押すとクリップボードに入り、残りのボタンで通知がもう一度出て、3つ押すとコピーのボタンが無くなる", async () => {
  await withVsCode(
    "告知のコピーボタン",
    [{ name: EPISODE, text: "　朝の駅は静かだった。改札を抜けて、白い息を吐いた。\n" }],
    async (session) => {
      const { page } = session;
      // 走らせる前のクリップボード。最後に戻す（作者の手元の中身を残さず消さない）
      const before = await readClipboard(session);
      try {
        await runCommand(page, "更新SNS告知文作成");

        /* ── 告知の設定（初回だけ訊く）：ハッシュタグ → 作品ページのURL ── */
        await waitForQuickInput(page, "の告知に付けるハッシュタグ", 30_000);
        await answerInput(page, "創作 小説");
        await waitForQuickInput(page, "の作品ページのURL", 15_000);
        await answerInput(page, "https://example.com/e2e-work");

        /* ── 話を選ぶ → 処理量の確認 → 実行 ── */
        await waitForQuickInput(page, "の更新告知", 15_000);
        await pickQuickPickRow(page, EPISODE);
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            const rows = await quickPickRows(page);
            if (!rows.some((row) => row.label.includes("更新告知文を作ります"))) return false;
            await pickQuickPickRow(page, "実行");
            return true;
          },
          "処理量の確認が出て［実行］で進む",
          30_000
        );

        /* ── 結果の通知：3つのコピーと、Xへ貼り付ける ── */
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            return (await noticeTexts(page)).some((text) => text.includes("更新告知文ができました"));
          },
          "「更新告知文ができました」の通知が出る",
          60_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（知らせ：${JSON.stringify(await noticeTexts(page))}／偽のAIへの呼び出し：${fake.requests.length}回）`);
        });
        expect(await noticeButtons(page)).toEqual(["X用をコピー", "活動報告用をコピー", "後書き用をコピー", "Xへ貼り付ける（投稿画面を開く）"]);
        expect(fake.requests.length, "偽のAIが1回だけ呼ばれたはずです").toBe(1);

        /* ── 「X用をコピー」：クリップボードに X 用の文が入り、通知がもう一度出て、残りが並ぶ ── */
        await page.locator(".notification-toast .monaco-button", { hasText: "X用をコピー" }).first().click();
        await waitUntil(
          async () => (await noticeTexts(page)).some((text) => text.includes("X用 をコピーしました")),
          "押したあと、「X用 をコピーしました。続けてコピーできます」の通知が出る",
          15_000
        );
        const copiedX = await readClipboard(session);
        // 製品は文ごとに改行を入れて整える（頭に話の見出し、末尾にタグと URL）。字の並びで見る
        expect(copiedX.replace(/\s+/g, ""), "クリップボードに X 用の文（AI の文）が入っていません").toContain(X_POST);
        expect(copiedX, "ハッシュタグが付いていません").toContain("#創作");
        expect(copiedX, "作品ページの URL が付いていません").toContain("https://example.com/e2e-work");
        await waitUntil(
          async () => (await noticeButtons(page)).join("|") === "活動報告用をコピー|後書き用をコピー|Xへ貼り付ける（投稿画面を開く）",
          "押した「X用」は並ばず、残りのボタンが並ぶ"
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（いまのボタン：${JSON.stringify(await noticeButtons(page))}）`);
        });

        /* ── 活動報告用 → 後書き用 ── */
        await page.locator(".notification-toast .monaco-button", { hasText: "活動報告用をコピー" }).first().click();
        await waitUntil(
          async () => (await noticeTexts(page)).some((text) => text.includes("X用・活動報告用 をコピーしました")),
          "「X用・活動報告用 をコピーしました」の通知が出る",
          15_000
        );
        expect(await readClipboard(session)).toBe(ACTIVITY);
        await waitUntil(async () => (await noticeButtons(page)).join("|") === "後書き用をコピー|Xへ貼り付ける（投稿画面を開く）", "残りは後書き用と貼り付けだけ");

        await page.locator(".notification-toast .monaco-button", { hasText: "後書き用をコピー" }).first().click();
        await waitUntil(
          async () => (await noticeTexts(page)).some((text) => text.includes("X用・活動報告用・後書き用 をコピーしました")),
          "「X用・活動報告用・後書き用 をコピーしました」の通知が出る",
          15_000
        );
        expect(await readClipboard(session)).toBe(AFTERWORD);

        /* ── 3つ押したあと：コピーのボタンは無く、残るのは「Xへ貼り付ける」だけ ── */
        await waitUntil(
          async () => (await noticeButtons(page)).join("|") === "Xへ貼り付ける（投稿画面を開く）",
          "3つ押すと、コピーのボタンが無くなる（残るのは貼り付けだけ）"
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（いまのボタン：${JSON.stringify(await noticeButtons(page))}）`);
        });
        // 貼り付けは作者のブラウザが開くので押さない。通知を閉じて、押し続けさせずに終える
        await clearNotifications(page);
        expect((await noticeTexts(page)).length, "通知を閉じたのに残っています").toBe(0);
      } finally {
        await writeClipboard(session, before).catch(() => undefined);
      }
    },
    fakeOllamaLaunch(fake)
  );
});
