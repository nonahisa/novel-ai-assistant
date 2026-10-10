/**
 * 控えの置き場は2つ（作者の裁定、2026-10-04。設計書6.25.9）。
 *
 * 帯の控え（重なって入らなかった字・開いたときの「前回の控え」）が開いている間に、
 * 原稿へ届かなかった別の字も、画面の状態へ控え、ウィンドウを再読み込みしたあとに
 * 戻せることを見張る。0.98.6 までは控えの欄が1つで、帯の控えを守るために帯が開いている
 * 間は控えを書かなかったので、その間に届かなかった字は再読み込みで取り戻せなかった。
 *
 * 「届かない」は、画面から拡張機能へ向かう打った字の便を、WebView の外側の枠で落として作る
 * （`dropEditsToHost`。製品には何も足さない）。重なりの競走に頼らないので毎回同じ場面になる。
 * ほかの作り方は使えなかった——拡張機能ホストの起動し直しは、1.138 が「拡張機能の出した
 * エディターが閉じる」と確かめを出し、押せばタブが閉じて画面の状態ごと消える。この窓の
 * あいだだけの読み取り専用は、拡張機能の WorkspaceEdit には効かず、字が入った。
 * （1.141 で再起動をまたいで控えを戻す件は `hostRestartDisconnect.test.ts`。2026-10-10、未実行）
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import {
  classOpen,
  composeText,
  dropEditsToHost,
  openEpisode,
  placeCaretAfter,
  rescueBarText,
  waitForManuscriptFrame,
} from "./support/manuscriptFrame";
import { pressWorkbenchKey } from "./support/workbenchDom";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.txt";

/** 使い捨ての keybindings.json に足すキー（製品のキーと重ならないもの） */
const RELOAD_WINDOW_KEY = "ctrl+alt+shift+y";
const RELOAD_WINDOW_PRESS = "Control+Alt+Shift+KeyY";

async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

/** 打った字が拡張機能へ届かないようにしてから打ち、届かない知らせ（4秒）が出るのを待つ */
async function typeWhileHostIsDeaf(session: E2ESession, frame: Frame, after: string, typed: string): Promise<void> {
  await dropEditsToHost(frame);
  await placeCaretAfter(frame, after);
  await session.page.keyboard.insertText(typed);
  await waitUntil(() => classOpen(frame, "unsent"), `「${typed}」が届かない知らせが出る`, 20_000);
}

/** ウィンドウを再読み込みして、原稿エディターの面を探し直す */
async function reloadWindow(session: E2ESession, oldFrame: Frame): Promise<Frame> {
  await pressWorkbenchKey(session.page, RELOAD_WINDOW_PRESS);
  // 再読み込みが始まる前の古い面を拾わないよう、古い面が外れるのを待つ
  await waitUntil(() => oldFrame.isDetached(), "再読み込みで古い面が外れる", 30_000);
  return waitForManuscriptFrame(session.page, "一行目の文", "再読み込みのあと、原稿エディターの面が本文を描く");
}

test("帯の控えが開いている間に原稿へ届かなかった字も、ウィンドウを再読み込みしたあと、帯に続けて順に出て戻せる", async () => {
  await withVsCode(
    "控えの置き場は2つ",
    [{ name: EPISODE, text: "一行目の文。\n" }],
    async (session) => {
      let frame = await openEpisode(session.page, EPISODE, "一行目の文");

      // 1回目：届かない字を作って再読み込み →「前回の控え」の帯が開く
      await typeWhileHostIsDeaf(session, frame, "一行目の文。", "甲");
      frame = await reloadWindow(session, frame);
      await waitUntil(() => classOpen(frame, "rescue"), "再読み込みのあと「前回の控え」の帯が出る", 30_000);
      expect(await rescueBarText(frame)).toContain("前回、原稿に入らなかった字があります");

      // 2回目：帯を開いたまま、もう一度届かない字を作って再読み込み
      await typeWhileHostIsDeaf(session, frame, "一行目の文。", "乙");
      frame = await reloadWindow(session, frame);
      await waitUntil(() => classOpen(frame, "rescue"), "2回目の再読み込みのあと、控えの帯が出る", 30_000);

      // 1枚目は前からの帯の控え（甲）。後ろに1件待っている
      const first = await rescueBarText(frame);
      expect(first, "後ろに待っている控えがあると出ていません").toContain("あと1件");
      await frame.locator("#rescueDiscard").click();

      // 2枚目は、帯が開いている間に届かなかった字（乙）。戻せばファイルへ入る
      await waitUntil(() => classOpen(frame, "rescue"), "帯が開いている間に届かなかった字の帯が続けて出る");
      expect(await rescueBarText(frame)).toContain("前回、原稿に入らなかった字があります");
      await frame.locator("#rescueRestore").click();
      await waitUntil(async () => (await composeText(frame)).includes("乙"), "戻した字が画面に出る");
      await session.page.keyboard.press("Control+KeyS");
      await waitUntil(async () => (await fileText(session)).includes("乙"), "戻した字がファイルに入る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（ファイル：${JSON.stringify(await fileText(session))}）`);
        }
      );
      expect(await fileText(session)).toBe("一行目の文。乙\n");
    },
    {
      keybindings: [
        { key: RELOAD_WINDOW_KEY, command: "workbench.action.reloadWindow" },
      ],
    }
  );
});
