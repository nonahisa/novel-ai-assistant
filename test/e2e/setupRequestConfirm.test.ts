/**
 * Claude Code からのセットアップの依頼（`/setup?step=…`）を、作者の VS Code の側で受けて確かめる・断る
 * （画面の自動テスト、設計書6.87.18・6.113。実機確認リスト「セットアップの手順が拡張機能の操作
 * （作品作成・AI設定など）を呼ぶたびに、作者のVS Code画面に「Claude Codeからの依頼です」の確認が出て、
 * 断れば何も起きないか」を、仕分け 2026-10-16 の束 E29 として移した）。
 *
 * 何を見張るか：
 * - 1件目：「新規作品を作成」（作品名・種類つき）と「AI設定」の依頼が届くたびに、製品の確認
 *   「Claude Code からの依頼です。この操作を始めますか？」が出て、受けた答え（操作・作品名・種類）が
 *   並ぶ。**押さずに閉じると何も起きない**——作品のフォルダーはできず、AI設定の選ぶ画面も、
 *   ほかの確認の窓も出ない
 * - 2件目：［始める］を押すと、その段の操作へ進む（登録済みの作品のフォルダーを「フォルダー登録」で
 *   頼むと、製品の「すでに登録されています。登録はしないで次へ進めます」の知らせ）。
 *   おかしな依頼（知らない段）は確認を出さずに、断った理由を知らせる
 *
 * 届け方：URI はテスト用の VS Code の中の「Developer: Open URL」で開く（`runRequestTypo.test.ts` と同じ）。
 * **OS には開かせない**（作者の VS Code へ届いてしまう）。セットアップの依頼は run.request と違って
 * 札も許可の印も要らない（`core/setupRequest.ts` は URI のクエリだけを読む）。VS Code 自身の
 * 「この URI を開かせますか」の問いは E27 で控えたので、ここでは設定で止めておく。
 * Claude Code の側から手順が流れること自体は外の道具なので見張れない（作者の手に残る）。
 *
 * **AI は呼ばない。** AI設定は確認で閉じるので、選ぶ画面にも進まない。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { alreadyRegisteredNotice, buildSetupUri, EXTENSION_URI_AUTHORITY, SETUP_URI_PATH, type SetupRequest } from "../../src/core/setupRequest";
import { describeNotices, waitForNotice } from "./support/noticeRecord";
import { fillInput } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  closeDialog,
  dialogText,
  pressDialogButton,
  pressWorkbenchKey,
  quickInputWaitContext,
  quickPickTitle,
} from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n";
/** 製品の確認の一文（`features/setupRequestHandler.ts`） */
const CONFIRM_HEAD = "Claude Code からの依頼です。この操作を始めますか？";
/** 新規作品の依頼に載せる作品名（断ったあと、この名前のフォルダーができていないかを見る） */
const NEW_TITLE = "依頼で作る作品";

/** 「Developer: Open URL」のキー（runRequestTypo と同じ組。製品のキーとも重ならない） */
const OPEN_URL_KEY = "ctrl+alt+shift+q";
const OPEN_URL_PRESS = "Control+Alt+Shift+KeyQ";

const LAUNCH: LaunchOptions = {
  settings: { "extensions.confirmedUriHandlerExtensionIds": ["nonahisa.novel-ai-assistant"] },
  keybindings: [{ key: OPEN_URL_KEY, command: "workbench.action.url.openUrl" }],
};

/** URI をテスト用の VS Code の中で開く */
async function openUri(page: Page, uri: string): Promise<void> {
  await pressWorkbenchKey(page, OPEN_URL_PRESS);
  await fillInput(page, uri).catch(async (error: unknown) => {
    throw new Error(`「Open URL」の入力欄が出ません（${String(error)}）${await quickInputWaitContext(page)}`);
  });
  await page.keyboard.press("Enter");
}

/** 製品の確認の窓が出るまで待ち、その文を返す */
async function waitSetupConfirm(session: E2ESession, label: string): Promise<string> {
  let text: string | undefined;
  await waitUntil(
    async () => {
      text = await dialogText(session.page);
      return text?.includes(CONFIRM_HEAD) === true;
    },
    `${label}の依頼で「${CONFIRM_HEAD}」が出る`,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(text)}／${await describeNotices(session)}${await quickInputWaitContext(session.page)}）`);
  });
  return text ?? "";
}

/** 一時フォルダーの下（VS Code の user-data・本体を除く）で、その名前のフォルダーを探す */
async function findFolderNamed(root: string, name: string, depth = 0): Promise<string | undefined> {
  if (depth > 4) return undefined;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "user-data" || entry.name === "extensions") continue;
    const full = path.join(root, entry.name);
    if (entry.name === name) return full;
    const found = await findFolderNamed(full, name, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** 断ったあと「何も起きない」——確認の窓も選ぶ画面も出ず、作品のフォルダーもできない */
async function holdsNothingHappens(session: E2ESession, label: string): Promise<void> {
  let seen = "";
  await holdsFor(
    async () => {
      const dialog = await dialogText(session.page);
      const pick = await quickPickTitle(session.page).catch(() => undefined);
      const folder = await findFolderNamed(session.root, NEW_TITLE);
      seen = `窓：${JSON.stringify(dialog)}／選ぶ画面：${JSON.stringify(pick)}／作品のフォルダー：${JSON.stringify(folder)}`;
      return dialog === undefined && pick === undefined && folder === undefined;
    },
    `${label}を断ったあと、何も起きない`,
    3_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${seen}／${await describeNotices(session)}）`);
  });
}

test("セットアップの依頼（新規作品の作成・AI設定）が届くたびに「Claude Code からの依頼です」の確認に受けた答えが並び、押さずに閉じれば作品もできず、次の画面も出ない", async () => {
  await withVsCode(
    "セットアップの依頼を断る",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await clearNotifications(page);

      // ── 新規作品の作成：作品名・種類が確認に並ぶ。閉じれば作品はできない ──
      const create: SetupRequest = { step: "create", title: NEW_TITLE, kind: "novel" };
      await openUri(page, buildSetupUri(create));
      const createConfirm = await waitSetupConfirm(session, "新規作品の作成");
      expect(createConfirm, "確認に操作の名前が無い").toContain("操作：新規作品を作成");
      expect(createConfirm, "確認に作品名が無い").toContain(`作品名：${NEW_TITLE}`);
      expect(createConfirm, "確認に種類が無い").toContain("種類：");
      expect(createConfirm, "覚えのない依頼の断り方が無い").toContain("覚えのない依頼なら「始める」を押さずに閉じてください。");
      await closeDialog(page);
      await holdsNothingHappens(session, "新規作品の作成");

      // ── AI設定：もう一度届けば、もう一度確かめる。閉じれば AI を選ぶ画面は出ない ──
      await openUri(page, buildSetupUri({ step: "ai" }));
      const aiConfirm = await waitSetupConfirm(session, "AI設定");
      expect(aiConfirm, "確認に操作の名前が無い").toContain("操作：AI設定");
      await closeDialog(page);
      await holdsNothingHappens(session, "AI設定");
    },
    LAUNCH
  );
}, 180_000);

test("セットアップの依頼は［始める］でその段へ進み（登録済みの作品のフォルダー登録は「すでに登録されています」）、知らない段の依頼は確認を出さずに断った理由を知らせる", async () => {
  await withVsCode(
    "セットアップの依頼を受ける",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await clearNotifications(page);

      // ── 登録済みの作品のフォルダー登録：確認に場所が並び、［始める］で「すでに登録」の知らせ ──
      const since = Date.now();
      await openUri(page, buildSetupUri({ step: "register", path: session.workFolder }));
      const confirm = await waitSetupConfirm(session, "フォルダー登録");
      expect(confirm, "確認に操作の名前が無い").toContain("操作：フォルダー登録");
      expect(confirm, "確認に場所が無い").toContain(`場所：${session.workFolder}`);
      await pressDialogButton(page, "始める");
      await waitForNotice(
        session,
        (message) => message.includes(alreadyRegisteredNotice(E2E_WORK_TITLE)),
        "［始める］のあと「すでに登録されています」の知らせ",
        { since }
      );

      // ── 知らない段：確認は出さず、断った理由を知らせる ──
      const refusedSince = Date.now();
      await openUri(page, `vscode://${EXTENSION_URI_AUTHORITY}${SETUP_URI_PATH}?step=nope`);
      await waitForNotice(
        session,
        (message) => message.includes("Claude Code からの依頼を受けられませんでした。") && message.includes("知らない段（nope）です。"),
        "知らない段の依頼を断った知らせ",
        { since: refusedSince }
      );
      await holdsFor(async () => (await dialogText(page)) === undefined, "知らない段の依頼で確認の窓が出ないこと", 2_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（窓：${JSON.stringify(await dialogText(page))}）`);
        }
      );
    },
    LAUNCH
  );
}, 180_000);
