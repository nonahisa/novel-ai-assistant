/**
 * 拡張機能ホストを再起動したあと、つながりの切れた原稿エディターを見つけて、
 * ウィンドウの再読み込みで打てる状態へ戻す（設計書6.25.9。0.101.11）。
 *
 * 作者の実機（2026-10-10、VS Code 1.141.0）で合格した流れを、そのまま押す：
 * 原稿エディターを後ろのタブにして「開発者: 拡張機能ホストを再起動」→ 原稿のタブを前に出す →
 * 10秒ほどでモーダル「拡張機能が更新・再起動されたため、開いていた原稿エディターとの
 * つながりが切れました。」［ウィンドウを再読み込み］→ 押す → 打った字が原稿に入る。
 * 0.101.8 では拡張機能が起動し直さず（`activationEvents` に `onStartupFinished` が無かった）、
 * モーダルが出なかった。
 *
 * **1.138.0 では、この流れを機械で押せなかった**（`manuscriptRescueSlots.test.ts` の冒頭）。
 * 再起動すると「拡張機能の出したエディターが閉じる」確かめが出て、押すとタブが閉じ、
 * 画面の状態ごと消えた。作者の 1.141.0 ではタブが残ったので、E2E の VS Code を
 * 1.141.0 へ上げて（`support/vscodeApp.ts` の `E2E_VSCODE_VERSION`）この件を書いた。
 * **再起動の直後に確かめの窓が出たら、その文を添えて落とす**（1.141 でも 1.138 と同じなら、
 * この件は「見張れない」に戻す判断が要るため。skip にはしない）。
 *
 * **2026-10-10 に書いた時点では一度も走らせていない**（作者がこの機械で作業中のため。
 * 1.141.0 も `.vscode-test/` に無く、初回に取り寄せる）。
 *
 * 再起動のキーは使い捨ての keybindings.json に足す（製品にテスト専用の口を足さない）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
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
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  activateTab,
  activeTabNames,
  dialogText,
  editorGroupTabs,
  OPEN_KEYBINDINGS_BINDING,
  OPEN_KEYBINDINGS_PRESS,
  pressWorkbenchKey,
  tabNamesInclude,
} from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const FIRST_LINE = "一行目の文。";

/** 拡張機能ホストを再起動するキー（製品の package.json にも test/e2e のほかの件にも無い組） */
const RESTART_HOST_KEY = "ctrl+alt+shift+r";
const RESTART_HOST_PRESS = "Control+Alt+Shift+KeyR";

/** 製品のモーダル（`features/manuscriptEditor.ts` の `warnDisconnected`）の見出しとボタン */
const DISCONNECTED_MESSAGE = "開いていた原稿エディターとのつながりが切れました";
const RELOAD_BUTTON = "ウィンドウを再読み込み";

const LAUNCH = {
  keybindings: [
    { key: RESTART_HOST_KEY, command: "workbench.action.restartExtensionHost" },
    // 「別のタブ」は原稿エディター以外にする。原稿をもう1枚開くと、前に出ている方が
    // 先に「切れた」と判定され、見たい原稿の前に別のモーダルが出る
    OPEN_KEYBINDINGS_BINDING,
  ],
};

async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

/** 原稿エディターを後ろのタブにする（キーボード ショートカットの画面を同じ列で前に出す） */
async function putManuscriptBehind(page: Page): Promise<void> {
  await pressWorkbenchKey(page, OPEN_KEYBINDINGS_PRESS);
  await page.locator(".keybindings-editor").first().waitFor({ state: "visible", timeout: 15_000 });
  await waitUntil(
    async () => !tabNamesInclude(await activeTabNames(page), EPISODE),
    "原稿のタブが後ろに回る",
    10_000
  );
}

/**
 * 拡張機能ホストを再起動する。**再起動の確かめの窓が出たら、その文を添えて落とす**
 * （1.138.0 では「拡張機能の出したエディターが閉じる」と出て、押すとタブが閉じた）。
 * 製品のモーダルは原稿のタブを前に出すまで出ないので、ここで出る窓は VS Code 本体のもの
 */
async function restartExtensionHost(page: Page): Promise<void> {
  await pressWorkbenchKey(page, RESTART_HOST_PRESS);
  let seen: string | undefined;
  await holdsFor(
    async () => (seen = await dialogText(page)) === undefined,
    "拡張機能ホストの再起動で確かめの窓が出ない",
    8_000
  ).catch(() => {
    throw new Error(
      `拡張機能ホストの再起動で、VS Code の確かめの窓が出ました（1.138.0 と同じ形。` +
        `押すと原稿のタブが閉じるので、この件は先へ進めません）：${JSON.stringify(seen)}`
    );
  });
  // タブが閉じていないこと（1.138.0 では閉じた）
  const tabs = (await editorGroupTabs(page)).flat();
  expect(tabNamesInclude(tabs, EPISODE), `拡張機能ホストの再起動で、原稿のタブが閉じました（タブ：${JSON.stringify(tabs)}）`).toBe(true);
}

/** 製品のモーダルが出るのを待ち、文とボタンを確かめる（猶予10秒＋新しい拡張機能の起動） */
async function waitForDisconnectedModal(page: Page): Promise<void> {
  let text: string | undefined;
  await waitUntil(
    async () => ((text = await dialogText(page)) ?? "").includes(DISCONNECTED_MESSAGE),
    "原稿のタブを前に出したあと「つながりが切れました」のモーダルが出る",
    60_000
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(text)}）`);
  });
  expect(text).toContain("拡張機能が更新・再起動されたため、開いていた原稿エディターとのつながりが切れました。");
  expect(text).toContain(`対象：${EPISODE}`);
  const buttons = await page.locator(".monaco-dialog-box .monaco-button").allInnerTexts();
  expect(buttons.map((label) => label.trim())).toContain(RELOAD_BUTTON);
}

/**
 * モーダルの［ウィンドウを再読み込み］を押し、再読み込みのあとの原稿エディターの面を返す。
 *
 * `pressDialogButton` は使わない——押した瞬間に再読み込みが始まり、窓が消えるのを待つ間に
 * 画面ごと作り直されて例外になりうる。古い面が外れるのを待ってから探し直す
 */
async function pressReloadAndFindFrame(page: Page, oldFrame: Frame): Promise<Frame> {
  await page.locator(".monaco-dialog-box .monaco-button", { hasText: RELOAD_BUTTON }).first().click();
  await waitUntil(() => oldFrame.isDetached(), "再読み込みで古い面が外れる", 30_000);
  return waitForManuscriptFrame(page, "一行目の文", "再読み込みのあと、原稿エディターの面が本文を描く");
}

test("拡張機能ホストを再起動したあと、原稿のタブを前に出すと「つながりが切れました」が出て、再読み込みのあと打った字が原稿に入る", async () => {
  await withVsCode(
    "再起動をまたぐ：つながりの切れた原稿",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "一行目の文");
      await putManuscriptBehind(page);
      await restartExtensionHost(page);
      await activateTab(page, EPISODE);
      await waitForDisconnectedModal(page);

      const fresh = await pressReloadAndFindFrame(page, frame);

      // 再読み込みのあとは、つながり直している。打った字が保存でファイルへ入る
      await placeCaretAfter(fresh, FIRST_LINE);
      await page.keyboard.insertText("再読み込みのあとに打った字");
      await waitUntil(
        async () => (await composeText(fresh)).includes("再読み込みのあとに打った字"),
        "打った字が画面に出る"
      );
      await page.keyboard.press("Control+KeyS");
      await waitUntil(
        async () => (await fileText(session)).includes("再読み込みのあとに打った字"),
        "再読み込みのあとに打った字がファイルに入る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（ファイル：${JSON.stringify(await fileText(session))}）`);
      });
      expect(await fileText(session)).toBe(`${FIRST_LINE}再読み込みのあとに打った字\n`);

      // ふつうの再読み込みのあとは、つながっているので「切れた」と言わない（猶予10秒を越えて見る）
      await holdsFor(
        async () => !((await dialogText(page)) ?? "").includes(DISCONNECTED_MESSAGE),
        "再読み込みのあとに「つながりが切れました」が出ない",
        12_000
      );
    },
    LAUNCH
  );
});

test("拡張機能ホストの再起動の前に原稿へ届かなかった字は、再読み込みのあと［戻す］で戻り、保存でファイルに入る", async () => {
  await withVsCode(
    "再起動をまたぐ：届かなかった字を戻す",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "一行目の文");

      // 再起動の前に、届かなかった字を作る（便を外側の枠で落とす。製品には何も足さない）。
      // くるみは再起動では消えず、再読み込みで枠ごと消える
      await dropEditsToHost(frame);
      await placeCaretAfter(frame, FIRST_LINE);
      await page.keyboard.insertText("甲");
      await waitUntil(() => classOpen(frame, "unsent"), "「甲」が届かない知らせが出る", 20_000);
      expect(await fileText(session), "届かないはずの字がファイルに入りました").toBe(`${FIRST_LINE}\n`);

      await putManuscriptBehind(page);
      await restartExtensionHost(page);
      await activateTab(page, EPISODE);
      await waitForDisconnectedModal(page);

      const fresh = await pressReloadAndFindFrame(page, frame);
      await waitUntil(() => classOpen(fresh, "rescue"), "再読み込みのあと「前回の控え」の帯が出る", 30_000);
      expect(await rescueBarText(fresh)).toContain("前回、原稿に入らなかった字があります");

      await fresh.locator("#rescueRestore").click();
      await waitUntil(async () => (await composeText(fresh)).includes("甲"), "戻した字が画面に出る");
      await page.keyboard.press("Control+KeyS");
      await waitUntil(async () => (await fileText(session)).includes("甲"), "戻した字がファイルに入る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（ファイル：${JSON.stringify(await fileText(session))}）`);
        }
      );
      expect(await fileText(session)).toBe(`${FIRST_LINE}甲\n`);
    },
    LAUNCH
  );
});
