/**
 * 「編集部へ渡す」は、終わりの知らせのボタンが押されるのを待たずに終わる（0.115.1、commit 604914f1。
 * 画面の自動テスト、設計書6.113。リーダーの依頼 2026-10-31、作者の許可「今席にいるので、必要なら回してください」）。
 *
 * 何を見張るか：
 * - 前は右下の知らせのボタン（［ログを表示］［閉じる］など）が押されるのを `await` していたので、知らせが
 *   通知の一覧へ畳まれる（押されずに右下から消える）と、同じ命令をもう一度押したときに
 *   「『編集部へ渡す』はいま動いています」と断られ続けた（作者の実機、2026-10-30）
 * - 知らせを出させてから**押さずに右下から畳み**（`notifications.hideToasts`。一覧には残るので、ボタンの
 *   答えは来ないまま——作者の実機と同じ形。`notifications.clearAll` で消すと答えが来てしまい、直す前の
 *   版でも通ってしまう）、同じ命令をもう一度押す。「いま動いています」が出ないことを数秒見続け、
 *   2回目も同じ知らせまで進むことを確かめる
 *
 * **GitHub には触れない道を選んだ。** 「編集部へ渡す」は既定では GitHub に非公開のリポジトリを作るが、
 * 編集用フォルダーがすでにあり、送り先（origin）を持っているとき（送り直し）は、作らずに送り先の確認へ進む。
 * ここでは送り先を**手元の裸の置き場**にしておく。製品は「覚えている送り先と違う origin は、非公開と
 * 確かめるまで送らない」（`verifyKnownDestination`）ので、GitHub のリポジトリとして読めない送り先を見た
 * 時点で、**サインインも通信もせずに**断り、「編集部へ渡せませんでした: …」の知らせ（直しの対象の
 * `whenNoticePicked` の1つ）を出す。道の確かめ：
 * - pointer（`.aiwriter/cache/editing.json`）の先が在る → `planShareSource` は `reuse`（置き場を訊かない）
 * - origin がある → `repositoryExists`。`hasGithubSession()` は呼ばれず、確認の窓は「送り直しますか」になる
 * - pointer に `editorLogin` がある → 編集部の GitHub 名を訊かない（招待もしない）
 * - 送り先は作品の外（書庫の隣）→ `editingPlaceProblem` は通る
 * - origin は Windows のフォルダーの道 → `parseGithubRepoRef` が読めず、トークンを取る前に断る
 *
 * 念のため、確認の窓が「送り直しますか」でなければ（GitHub に作る側の窓なら）押さずに閉じて落とす。
 * 最後に、手元の送り先へ何も送られていないことも確かめる。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { addLocalRemote, git, initRepoWithFirstCommit } from "./support/gitFixture";
import { describeNotices, recordedNotices } from "./support/noticeRecord";
import type { NoticeEntry } from "../../src/core/noticeLog";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { closeDialog, dialogText, notificationTexts, pressDialogButton, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";

/** 「編集部へ渡す」を押すキー（使い捨ての keybindings.json。製品の package.json に ctrl+alt+shift の割り当ては無い） */
const SHARE_KEY = "ctrl+alt+shift+f";
const SHARE_PRESS = "Control+Alt+Shift+KeyF";
/** 右下の知らせを畳むキー（一覧には残す。`notifications.hideToasts`） */
const HIDE_TOASTS_KEY = "ctrl+alt+shift+t";
const HIDE_TOASTS_PRESS = "Control+Alt+Shift+KeyT";

const EDITING_FOLDER = "画面テストの作品-編集用";
const EDITING_REMOTE = "編集用の送り先.git";

const BUSY = "いま動いています";
const FAILED = "編集部へ渡せませんでした";

/** 一時フォルダーの根（書庫の1つ上）。作品は `<根>/書庫/<作品>` */
function rootOf(workFolder: string): string {
  return path.dirname(path.dirname(workFolder));
}

const LAUNCH: LaunchOptions = {
  // 自動の送り返し・取りに行きは切る（編集用フォルダーへ勝手に触らせない）
  settings: { "novelai.git.autoResend": false, "novelai.git.autoFetch": false },
  keybindings: [
    { key: SHARE_KEY, command: "novelai.shareWithEditor" },
    { key: HIDE_TOASTS_KEY, command: "notifications.hideToasts" },
  ],
  prepareWork: async ({ workFolder }) => {
    const root = rootOf(workFolder);
    const editing = path.join(root, EDITING_FOLDER);
    await mkdir(editing, { recursive: true });
    await writeFile(path.join(editing, "はじめに.txt"), "編集用フォルダーの見本。\n", "utf8");
    await initRepoWithFirstCommit(editing);
    await addLocalRemote(editing, path.join(root, EDITING_REMOTE));
    // 前に渡したことがある形（端末ごとの控え）。編集部の名前も覚えている（訊かれない・招待しない）
    const cache = path.join(workFolder, ".aiwriter", "cache");
    await mkdir(cache, { recursive: true });
    await writeFile(
      path.join(cache, "editing.json"),
      `${JSON.stringify({ folderPath: editing, editorLogin: "e2e-editor" }, null, 2)}\n`,
      "utf8"
    );
  },
};

/** 「いま動いています」が出たか（右下と、知らせの記録の両方を見る） */
async function busyShown(session: E2ESession, since: number): Promise<boolean> {
  if ((await notificationTexts(session.page)).some((text) => text.includes(BUSY))) return true;
  return (await recordedNotices(session)).some((entry) => Date.parse(entry.at) >= since - 1_000 && entry.message.includes(BUSY));
}

/**
 * 記録にある「失敗の知らせ」（窓の中の通し番号つき）。
 *
 * **時刻で「この回の分」を分けない。** 記録の時刻は1秒の余裕を見て比べるので、直前の回の知らせを
 * この回の分と取り違える（1回目の走りで、2回目が1回目の知らせを拾って先へ進み、まだ確かめの途中の
 * 2回目に3回目を重ねて「いま動いています」を出させた）。押す前の通し番号を控え、新しい番号を待つ
 */
async function failedEntries(session: E2ESession): Promise<NoticeEntry[]> {
  return (await recordedNotices(session)).filter((entry) => entry.message.includes(FAILED));
}

/**
 * 「編集部へ渡す」を押し、送り直しの確認の窓で［送り直す］を押して、**この回の**失敗の知らせが出るまで進む。
 * **GitHub に作る側の窓が出たら押さずに閉じて落とす**（この台本の前提が崩れている）。
 * 返すのはこの回の知らせの通し番号
 */
async function shareOnce(session: E2ESession, round: string): Promise<number> {
  const { page } = session;
  const known = new Set((await failedEntries(session)).map((entry) => entry.seq));
  const since = Date.now();
  await pressWorkbenchKey(page, SHARE_PRESS);
  let shown: string | undefined;
  await waitUntil(
    async () => ((shown = await dialogText(page)) ?? "") !== "" || (await busyShown(session, since)),
    `${round}：「編集部へ渡す」の確認の窓が出る`,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await describeNotices(session, since - 1_000)}）`);
  });
  if (shown === undefined || shown === "") {
    throw new Error(`${round}：確認の窓が出ず、「${BUSY}」と断られました（${await describeNotices(session, since - 1_000)}）`);
  }
  if (!shown.includes("送り直しますか")) {
    await closeDialog(page);
    throw new Error(`${round}：送り直しの確認の窓ではありません（GitHub に作る側へ進んだおそれ。押さずに閉じた）：${shown}`);
  }
  // 窓が出ているあいだも、断りの知らせが遅れて出ないことを見続ける
  await holdsFor(async () => !(await busyShown(session, since)), `${round}：「${BUSY}」が出ない`, 3_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await describeNotices(session, since - 1_000)}）`);
  });
  await pressDialogButton(page, "送り直す");
  let fresh: NoticeEntry | undefined;
  await waitUntil(
    async () => (fresh = (await failedEntries(session)).find((entry) => !known.has(entry.seq))) !== undefined,
    `${round}：この回の「${FAILED}」の知らせ`,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await describeNotices(session, since - 1_000)}）`);
  });
  const entry = fresh as NoticeEntry;
  // 手元の送り先は GitHub のリポジトリとして読めないので、トークンを取る前に断った（この道であることの確かめ）
  expect(entry.message, `${round}：GitHub に触れる前に断った知らせ`).toContain("GitHub のリポジトリとして読めません");
  expect(entry.items, `${round}：ボタンつきの知らせ（直しの対象の形）`).toEqual(["ログを表示", "閉じる"]);
  return entry.seq;
}

/**
 * 知らせを押さずに右下から畳み、**答えが来ていない**（一覧に残ったまま）ことを確かめる。
 * 直す前の版は、この答えを待って「動いている」札を持ち続けた
 */
async function hideUnanswered(session: E2ESession, seq: number, round: string): Promise<void> {
  const { page } = session;
  await pressWorkbenchKey(page, HIDE_TOASTS_PRESS);
  await waitUntil(async () => (await notificationTexts(page)).length === 0, `${round}：右下の知らせが畳まれる`, 10_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await describeNotices(session)}）`);
  });
  // 記録は1秒ごとにまとめて書かれる。畳んだあとの分が書かれるのを待ってから読む
  await page.waitForTimeout(1_500);
  const entry = (await failedEntries(session)).find((one) => one.seq === seq);
  expect(entry?.answer ?? null, `${round}：畳んだ知らせには、まだ答えが来ていない（押されても閉じられてもいない）`).toBeNull();
}

test("「編集部へ渡す」の失敗の知らせを押さずに畳んでも、もう一度押すと「いま動いています」と断られず、同じ知らせまで進む", async () => {
  await withVsCode(
    "編集部へ渡すの知らせを待たない",
    [{ name: EPISODE, text: "　一話の本文。\n" }],
    async (session) => {
      const root = rootOf(session.workFolder);
      const remote = path.join(root, EDITING_REMOTE);
      const remoteBefore = (await git(remote, ["rev-parse", "main"])).trim();

      // 1回目：失敗の知らせ（ボタンつき）まで進み、押さずに右下から畳む（一覧には残り、答えは来ないまま）
      const first = await shareOnce(session, "1回目");
      await hideUnanswered(session, first, "1回目");

      // 2回目：断られずに、同じ確認の窓と同じ知らせまで進む
      const second = await shareOnce(session, "2回目");
      await hideUnanswered(session, second, "2回目");

      // 3回目も通る（畳んだ知らせが重なっても札を持ち続けない）
      await shareOnce(session, "3回目");

      // 手元の送り先へは何も送っていない（断ったのは送る前）
      expect((await git(remote, ["rev-parse", "main"])).trim(), "編集用の送り先は変わらない").toBe(remoteBefore);
    },
    LAUNCH
  );
}, 240_000);
