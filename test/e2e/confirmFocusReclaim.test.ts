/**
 * 確認の窓が出た直後に、原稿エディター（WebView）が焦点を取り返しても、焦点が窓へ戻る
 * （画面の自動テスト、設計書6.113。2026-11-13 ノートPCの proofreadKeyFlow 縦書きの件で見つけた）。
 *
 * ## 何が起きていたか
 *
 * Ctrl+Alt+P →「どこまで見ますか」で Enter → 実行の確認（上部の選ぶ窓）の順に窓が2つ続く。
 * 1つ目の窓が閉じると、VS Code 本体は焦点を原稿エディターへ戻す。WebView への戻し方は
 * **50ms 遅らせてから「focus」の便を WebView の中へ送る**（本体の `_focusDelayer`）。
 * 遅らせた時点で2つ目の窓がまだ出ていなければ便が出て、WebView がそれを処理するまでの間に
 * 2つ目の窓が出ると、**窓が出たあとに WebView が焦点を取る。** 確認の窓は外をクリックしても
 * 閉じない作り（`ignoreFocusOut`）なので、窓は出たまま、Enter も矢印も WebView の中へ行く
 * （作者が Enter を押しても走らない）。
 *
 * 遅い機械では、範囲の窓を閉じてから確認が出るまで（接続の確かめ）と、WebView が便を
 * 処理するまで（縦書きの組み直し）の両方が延び、この重なりが起きる。人の手の速さとは
 * 関係なく、窓が出た瞬間に機械の中で起きるので、作者の手でも同じことが起きる。
 *
 * ## このテストでの作り方
 *
 * - 接続の確かめ（偽の Ollama の `/api/tags`）を 150ms 遅らせる——確認の窓が、本体の 50ms の
 *   遅らせより後に出るようにする
 * - 範囲の窓で Enter を押す直前に、WebView の中（外枠と原稿の面）を 400ms 空回しさせる——
 *   「focus」の便の処理を、確認の窓が出たあとへずらす（遅い機械の縦書きの組み直しの代わり）
 *
 * 取り返しが起きたこと（原稿の面に焦点が入ったこと）を確かめてから、**焦点が確認の窓へ戻り、
 * Enter で推敲が走る**ことを見る。取り返しが起きなければ、仕込みが効いていないので落とす
 * （何も確かめずに通さない）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, test } from "vitest";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { CHECK_PROOFREAD_PRESS } from "./support/keys";
import { openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { activeElementSummary, focusInside, quickPickRows, quickPickTitle } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";

/** 接続の確かめを遅らせる長さ。本体が WebView へ焦点を戻すまでの遅らせ（50ms）より長くする */
const TAGS_DELAY_MS = 150;
/** WebView の中を空回しさせる長さ。確認の窓が出るまで（上の遅らせ＋数十ms）より長くする */
const BUSY_MS = 400;

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

/** 原稿の面（WebView の中）で、窓（window）が焦点を受けた回数を数え始める */
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

/** WebView の外枠と原稿の面を、`at` ms 後から `ms` ms 空回しさせる（どちらも待たずに戻る） */
async function busyFace(frame: Frame, at: number, ms: number): Promise<void> {
  for (const target of [frame, frame.parentFrame()]) {
    if (!target) continue;
    await target.evaluate(
      ({ delay, length }) => {
        setTimeout(() => {
          const start = performance.now();
          while (performance.now() - start < length) {
            /* 遅い機械の組み直しの代わり。何もしないで時間だけ使う */
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
    `\n面が焦点を受けた回数：${await faceFocusCount(frame)}` +
    `\n${describeFakeRequests(fake.requests)}` +
    `\n操作ログの終わり：\n${(await actionLog(session)).split("\n").slice(-10).join("\n")}`
  );
}

test("確認の窓が出た直後に原稿エディターが焦点を取り返しても、焦点は確認の窓へ戻り、Enter で推敲が走る", async () => {
  await withVsCode(
    "確認の窓の焦点の取り返し",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "改札を抜けて");
      await countFaceFocus(frame);
      const fail = async (error: unknown): Promise<never> => {
        throw new Error(`${String(error)}\n${await stateText(page, session, frame)}`);
      };

      await placeCaretAfter(frame, "静かだった。");
      await page.keyboard.press(CHECK_PROOFREAD_PRESS);
      await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("どこまで見ますか"), "範囲の窓が出る", 20_000).catch(fail);

      tagsDelay = TAGS_DELAY_MS;
      const before = await faceFocusCount(frame);
      await busyFace(frame, 30, BUSY_MS);
      await page.keyboard.press("Enter");

      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return ((await quickPickTitle(page)) ?? "").includes("推敲を行います");
        },
        "実行の確認の窓が出る",
        30_000
      ).catch(fail);

      // 仕込みが効いて、窓が出たあとに原稿の面が焦点を受けたこと（受けなければ、このテストは何も見ていない）
      await waitUntil(
        async () => (await faceFocusCount(frame)) > before,
        "確認の窓が出たあとに、原稿の面が焦点を受ける（仕込みが効いたしるし）",
        10_000
      ).catch(fail);

      await waitUntil(
        async () => await focusInside(page, ".quick-input-widget"),
        "原稿の面に取られた焦点が、確認の窓へ戻る",
        10_000
      ).catch(fail);

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
    fakeOllamaLaunch(fake)
  );
}, 300_000);
