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
 *
 * **1.141.0 でも確かめの窓は出る**（2026-10-10、この機械で初めて走らせて確かめた。文は
 * 「Please confirm restart of extensions. An extension provided text editor for '001_はじまり.txt'
 * is still open that would close otherwise.」）。ただし 1.141.0 では［Restart Anyway］を押しても
 * **原稿のタブは閉じずに残り**、そのあとの流れ（モーダル→再読み込み→打った字が入る）が通る。
 * そこで作者と同じく［Restart Anyway］を押して進み、**押したあとタブが残っていること**を確かめる
 * （1.138.0 ではここで閉じるので、この件はその文で落ちる）。
 *
 * 原稿を後ろへ回すのは無題のファイル（1.141.0 ではキーボード ショートカットの画面がタブでなく
 * 重なる窓として開き、原稿が前に出たままだった）。
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
  pressDialogButton,
  pressWorkbenchKey,
  tabNamesInclude,
} from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const FIRST_LINE = "一行目の文。";

/** 拡張機能ホストを再起動するキー（製品の package.json にも test/e2e のほかの件にも無い組） */
const RESTART_HOST_KEY = "ctrl+alt+shift+r";
const RESTART_HOST_PRESS = "Control+Alt+Shift+KeyR";

/**
 * 原稿を後ろへ回すために、新しい無題のファイルを同じ列へ開くキー（製品にもほかの件にも無い組）。
 *
 * **キーボード ショートカットの画面は使わない。** 1.141.0 ではタブではなく、編集の列の上に
 * 重なる窓（モーダルのエディター）として開き、原稿のタブは前に出たままになる
 * （2026-10-10、この機械の 1.141.0 で写真を撮って確かめた。1.138.0 までは同じ列のタブだった）。
 * 無題のファイルは空のままなら未保存の扱いにならず、再読み込みで保存を訊かれない
 */
const NEW_UNTITLED_KEY = "ctrl+alt+shift+n";
const NEW_UNTITLED_PRESS = "Control+Alt+Shift+KeyN";
const UNTITLED_PREFIX = "Untitled";

/** 製品のモーダル（`features/manuscriptEditor.ts` の `warnDisconnected`）の見出しとボタン */
const DISCONNECTED_MESSAGE = "開いていた原稿エディターとのつながりが切れました";
const RELOAD_BUTTON = "ウィンドウを再読み込み";

const LAUNCH = {
  keybindings: [
    { key: RESTART_HOST_KEY, command: "workbench.action.restartExtensionHost" },
    // 「別のタブ」は原稿エディター以外にする。原稿をもう1枚開くと、前に出ている方が
    // 先に「切れた」と判定され、見たい原稿の前に別のモーダルが出る
    { key: NEW_UNTITLED_KEY, command: "workbench.action.files.newUntitledFile" },
  ],
};

async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

/** 原稿エディターを後ろのタブにする（無題のファイルを同じ列で前に出す） */
async function putManuscriptBehind(page: Page): Promise<void> {
  await pressWorkbenchKey(page, NEW_UNTITLED_PRESS);
  await waitUntil(
    async () => (await activeTabNames(page)).some((name) => name.startsWith(UNTITLED_PREFIX)),
    "無題のファイルのタブが前に出る",
    15_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（前に出ているタブ：${JSON.stringify(await activeTabNames(page))}）`);
  });
  await waitUntil(
    async () => !tabNamesInclude(await activeTabNames(page), EPISODE),
    "原稿のタブが後ろに回る",
    10_000
  );
}

/** 再起動の確かめの窓（VS Code 本体）の、それでも再起動するボタン */
const RESTART_ANYWAY_BUTTON = "Restart Anyway";

/**
 * 拡張機能ホストを再起動する。**再起動の確かめの窓が出たら［Restart Anyway］を押して進む**
 * （冒頭の説明。1.141.0 では押してもタブが残る。1.138.0 では閉じた）。
 * 製品のモーダルは原稿のタブを前に出すまで出ないので、ここで出る窓は VS Code 本体のもの。
 * 確かめの窓でない窓が出たら、その文を添えて落とす
 */
async function restartExtensionHost(page: Page): Promise<void> {
  await pressWorkbenchKey(page, RESTART_HOST_PRESS);
  let seen: string | undefined;
  await waitUntil(async () => (seen = await dialogText(page)) !== undefined, "再起動の確かめの窓が出る", 8_000).catch(() => undefined);
  if (seen !== undefined) {
    if (!seen.includes(RESTART_ANYWAY_BUTTON)) {
      throw new Error(`拡張機能ホストの再起動で、思っていない窓が出ました：${JSON.stringify(seen)}`);
    }
    await pressDialogButton(page, RESTART_ANYWAY_BUTTON);
  }
  // 再起動が始まって、古い拡張機能ホストが止まるのを少し待つ（タブが閉じるならこの間に閉じる）
  await page.waitForTimeout(3_000);
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
