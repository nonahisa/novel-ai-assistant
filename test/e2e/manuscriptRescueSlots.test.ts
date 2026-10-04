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
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, manuscriptFrames, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
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

async function classOpen(frame: Frame, id: string): Promise<boolean> {
  return frame
    .evaluate((elementId) => document.getElementById(elementId)?.classList.contains("open") === true, id)
    .catch(() => false);
}

async function rescueBarText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("rescueText")?.textContent ?? "").catch(() => "");
}

/** 原稿エディターの面（再読み込みのあとは新しい面になるので、探し直す） */
async function manuscriptFrame(page: Page, expected: string): Promise<Frame> {
  let found: Frame | undefined;
  await waitUntil(
    async () => {
      for (const frame of await manuscriptFrames(page)) {
        if ((await composeText(frame).catch(() => "")).includes(expected)) {
          found = frame;
          return true;
        }
      }
      return false;
    },
    "再読み込みのあと、原稿エディターの面が本文を描く",
    60_000
  );
  if (!found) throw new Error("原稿エディターの面が見つかりません");
  return found;
}

/**
 * 画面から拡張機能へ向かう「打った字の便」（edit）だけを、WebView の外側の枠で落とす。
 *
 * 拡張機能ホストが起動し直して受け手を失った画面（6.25.9）と同じく、便は送られるのに
 * 返事が来ない形を作る。**製品には何も足さない**——VS Code の WebView の外側の枠
 * （`pre/index.html`）は、内側の枠の `postMessage` を MessagePort で本体へ渡すので、
 * テストの側からその枠の MessagePort をくるむ。画面の状態の書き込み（do-update-state）は
 * 通すので、控えは本物どおり状態に残る。枠は再読み込みで作り直されるので、くるみも消える
 */
async function dropEditsToHost(frame: Frame): Promise<void> {
  const outer = frame.parentFrame();
  if (!outer) throw new Error("WebView の外側の枠が見つかりません");
  await outer.evaluate(() => {
    const proto = MessagePort.prototype as MessagePort & { __e2eDrop?: boolean };
    if (proto.__e2eDrop) return;
    proto.__e2eDrop = true;
    const original = proto.postMessage;
    proto.postMessage = function (this: MessagePort, ...args: unknown[]) {
      const message = args[0] as { channel?: string; data?: { message?: { type?: string } } } | undefined;
      if (message?.channel === "onmessage" && message.data?.message?.type === "edit") return;
      return (original as (...rest: unknown[]) => void).apply(this, args);
    } as typeof proto.postMessage;
  });
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
  return manuscriptFrame(session.page, "一行目の文");
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
