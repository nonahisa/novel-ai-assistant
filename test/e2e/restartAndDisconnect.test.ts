/**
 * つながりの切れ・再起動をまたぐ（画面の自動テスト、設計書6.25.9・6.25.11・6.25.5・6.37・6.113。
 * 実機確認リスト 156・200・288・6132 を、仕分け 2026-10-12 の束 E9 として移した。作者の裁定
 * 「仕分けて機械の分から減らす」）。同じ束の 289 は `hostRestartDisconnect.test.ts` の2件目が覆う。
 *
 * 何を見張るか：
 * - 156：原稿エディターと校正・メモパネルを左右に開いたまま拡張機能ホストを再起動し、「つながりが
 *   切れました」を**再読み込みせずに閉じ**、校正・メモパネルの行を押すと、切れた原稿へ飛ぶときの問いの
 *   窓が出る（作者の裁定 2026-10-15）。［ウィンドウを再読み込み］で開き直したあと、目当ての行が示され、
 *   **どの列にも同じ話の2枚目ができない**
 * - 200：第1話と第2話を横書きで開いたまま VS Code を開き直し（第2話のタブは背景で、画面がまだ
 *   作られていない）、第1話で［縦書きにする］と字の大きさを変えて［次の話 →］を押すと、第2話が
 *   **縦書き・同じ字の大きさ**で出る。第2話を閉じて開き直すと、覚えていた見た目（横書き・元の大きさ）で
 *   開き、さっきの見た目がもう一度当たらない
 * - 288：原稿エディターのつながりが切れたまま打つと、4秒で下の欄に赤字「打った字を原稿へ送り直して
 *   います（N秒）」が出て秒が数え上がり、30秒で2段目（入りません）へ変わる
 * - 6132：名前の付け替えの待ち（`workspaceState`）が、VS Code を閉じて開き直しても残っている
 *
 * **項目の前提と実装が違っていたところ**（変えずに報告する）：
 * - 288 の2段目は、項目では「入りません。本文をコピーで控えてから、開き直してください」と［開き直す］→
 *   ［本文をコピー］で押せる →［開き直す］で3秒後に再読み込みの案内、と書いてある。製品（2026-10-02 から。
 *   `views/manuscriptEditorHtml.ts` の `hostSilent`）は、**知らせのあと拡張機能から何も届いていなければ
 *   ［開き直す］を出さず**、はじめから「Ctrl+Shift+P →『開発者: ウィンドウの再読み込み』」を案内する
 *   （押しても相手がいないので動かない、タブを閉じる道へ誘わない）。つながりが本当に切れた形を作ると
 *   こちらになるので、ここではそれを見る。［開き直す］の3秒の案内は、この形では出ない
 * - 288 の［本文をコピー］は押さない。押すと**この機械の OS のクリップボードを書き換える**（画面の外の
 *   窓でも同じ）。テストを走らせる機械で作者が控えたものを消しうるため
 * - 156 の「押したときの『校正・メモ：…』の行」は、いまの製品のログに無い（`src` を探しても、その頭の
 *   行を書く所が無い）。代わりに、行へ飛ぶ道（`features/manuscriptEditor.ts` の `revealLine`）が書く
 *   「原稿エディタ：…」の行で、押したことが届いたかを見る
 *
 * 拡張機能ホストの再起動は 1.141.0 でだけ見張れる（`hostRestartDisconnect.test.ts` の冒頭）。
 * **製品には何も足さない。** 再起動のキーは使い捨ての keybindings.json に足す。
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { characterFileName, emptyCharacter, type Character } from "../../src/models/character";
import { DEFAULT_SETTINGS_DIR } from "../../src/models/types";
import {
  caretPosition,
  classOpen,
  dropEditsToHost,
  frontFrameShowing,
  memoPanelFrame,
  openEpisode,
  placeCaretAfter,
  waitForManuscriptFrame,
} from "./support/manuscriptFrame";
import { describeNotices } from "./support/noticeRecord";
import { answerInput, runCommand, waitForQuickInput } from "./support/quickInput";
import { proposalPanelFrame } from "./support/sampleFinding";
import { defaultCharactersFolder, writeCharactersTo } from "./support/settingsFixture";
import { restartVsCode, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  acceptQuickPick,
  activateTab,
  activeTabNames,
  closeDialog,
  countTabsNamed,
  dialogText,
  editorGroupTabs,
  pickQuickPickRow,
  pressDialogButton,
  pressWorkbenchKey,
  readTabState,
  tabNamesInclude,
  waitForQuickPick,
} from "./support/workbenchDom";

/** 拡張機能ホストを再起動するキー（`hostRestartDisconnect.test.ts` と同じ組。起こすたびに別の keybindings.json） */
const RESTART_HOST_KEY = "ctrl+alt+shift+r";
const RESTART_HOST_PRESS = "Control+Alt+Shift+KeyR";
const RESTART_LAUNCH = {
  keybindings: [{ key: RESTART_HOST_KEY, command: "workbench.action.restartExtensionHost" }],
};

/** 製品のモーダル（`features/manuscriptEditor.ts` の `warnDisconnected`）の見出し */
const DISCONNECTED_MESSAGE = "開いていた原稿エディターとのつながりが切れました";

/** 切れた原稿へ飛ぶときの問いの窓（`features/manuscriptEditor.ts` の `askDisconnectedReveal`）の見出し */
const REVEAL_DISCONNECTED_MESSAGE = "拡張機能の再起動でつながりが切れています";

/** 問いの窓の、既定のボタン（`RELOAD_WINDOW_ITEM`） */
const RELOAD_BUTTON = "ウィンドウを再読み込み";

/**
 * 操作ログ（`actions.log`）を全部読む。**書き先は作品のログか、作品が引けなければ保管庫のログ**
 * （`core/logger.ts` の `useLogFile`）で、拡張機能ホストを起動し直した直後はどちらへ向くか決まって
 * いない（`watchDisconnectedManuscripts` の注釈）。両方を読み、置き場の名前を頭に付けて返す
 */
async function readActionLogs(session: E2ESession): Promise<string> {
  const files: string[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > 7) return;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name === "actions.log") files.push(full);
    }
  };
  await walk(path.join(session.workFolder, ".aiwriter"), 0);
  await walk(path.join(session.root, "user-data", "User", "globalStorage"), 0);
  const parts: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    parts.push(`【${path.relative(session.root, file)}】\n${text}`);
  }
  return parts.join("\n");
}

/**
 * `after` のうち、`before`（前に読んだ全文）に無かった行。ログの行は時刻つきなので、同じ文でも
 * 書かれた時が違えば別の行になる（置き場が2つあっても、行の有り無しで比べれば足りる）
 */
function addedLines(before: string, after: string): string[] {
  const seen = new Set(before.split(/\r?\n/));
  return after.split(/\r?\n/).filter((line) => line.trim() !== "" && !seen.has(line));
}

/**
 * 拡張機能ホストを再起動する。再起動の確かめの窓（VS Code 本体）が出たら［Restart Anyway］で進み、
 * 押したあとも原稿のタブが残っていることを確かめる（`hostRestartDisconnect.test.ts` と同じ。1.141.0）
 */
async function restartExtensionHost(page: Page, episode: string): Promise<void> {
  await pressWorkbenchKey(page, RESTART_HOST_PRESS);
  let seen: string | undefined;
  await waitUntil(async () => (seen = await dialogText(page)) !== undefined, "再起動の確かめの窓が出る", 8_000).catch(() => undefined);
  if (seen !== undefined) {
    if (!seen.includes("Restart Anyway")) {
      throw new Error(`拡張機能ホストの再起動で、思っていない窓が出ました：${JSON.stringify(seen)}`);
    }
    await pressDialogButton(page, "Restart Anyway");
  }
  await page.waitForTimeout(3_000);
  const tabs = (await editorGroupTabs(page)).flat();
  expect(tabNamesInclude(tabs, episode), `拡張機能ホストの再起動で、原稿のタブが閉じました（タブ：${JSON.stringify(tabs)}）`).toBe(true);
}

/* ────────────────────────────── 156 ────────────────────────────── */

const MEMO_EPISODE = "001_はじまり.txt";
const MEMO_TEXT = "一のメモ";

// 2026-10-12 ノートPC（89d8c269）で落ちた：パネルの行を押したことが操作ログに残らない（足された行：[]）。
// 2026-10-15 母艦で切り分け：再起動のあとも校正・メモパネルは画面に残るが、新しい拡張機能はこのパネルを知らず、押しても誰も受けなかった。
// 2026-10-15 に serializer を足して直した（作者の裁定「引き取れるようにする」）。ただし拡張機能ホストの再起動では serializer は
// 呼ばれないので、残ったタブを同じ列へ開き直して引き取る（`features/sceneMemoPanel.ts` の `registerSceneMemoPanelRestore`）。
// 開き直しの最中に、残ったパネルと新しいパネルが一瞬並ぶので、行は「引き取った」操作ログの行を待ってから押す（実機確認リスト 156）
test("原稿と校正・メモパネルを左右に開いたまま拡張機能ホストを再起動し、「つながりが切れました」を再読み込みせずに閉じてパネルの行を押すと問いの窓が出て、［ウィンドウを再読み込み］のあと目当ての行が示され、どの列にも同じ話の2枚目ができない", async () => {
  await withVsCode(
    "再起動をまたぐ：メモパネルから押して2枚目ができない",
    [{ name: MEMO_EPISODE, text: `一行目の文。\n// ${MEMO_TEXT}\n三行目の文。\n` }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, MEMO_EPISODE, "三行目の文");
      await placeCaretAfter(frame, "一行目の文");
      await page.keyboard.press("Control+Alt+KeyM");
      await waitUntil(
        async () => ((await (await memoPanelFrame(page))?.locator("button.go", { hasText: MEMO_TEXT }).count()) ?? 0) > 0,
        "校正・メモパネルが右に開き、メモの行が出る",
        30_000
      );
      const before = await readTabState(page);
      expect(before.length, `原稿とパネルが左右の2列に開く（${JSON.stringify(before)}）`).toBeGreaterThanOrEqual(2);
      expect(countTabsNamed((await editorGroupTabs(page)).flat(), MEMO_EPISODE), "再起動の前は原稿のタブが1枚").toBe(1);

      // 原稿は左の列で前に出たまま。再起動すると、新しい拡張機能が前に出ているタブを見て知らせる
      const logsBeforeRestart = await readActionLogs(session);
      await restartExtensionHost(page, MEMO_EPISODE);
      let modal: string | undefined;
      await waitUntil(async () => ((modal = await dialogText(page)) ?? "").includes(DISCONNECTED_MESSAGE), "「つながりが切れました」のモーダルが出る", 60_000).catch(
        (error: unknown) => {
          throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(modal)}）`);
        }
      );
      // 再読み込みせずに閉じる
      await closeDialog(page);

      /*
        新しい拡張機能が、残った校正・メモパネルを**作者の手を借りずに**引き取る（2026-10-15）。
        Ctrl+Alt+M で開き直す逃げ道は置かない——置くと、引き取れていなくても通ってしまう
      */
      const adopted = /校正・メモパネル：.*(開き直しました|引き取りました)/;
      await waitUntil(
        async () => addedLines(logsBeforeRestart, await readActionLogs(session)).some((line) => adopted.test(line)),
        "再起動のあと、新しい拡張機能が校正・メモパネルを引き取ったことが操作ログに残る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（足された行：${JSON.stringify(addedLines(logsBeforeRestart, await readActionLogs(session)).slice(-10))}` +
            `／タブ：${JSON.stringify(await readTabState(page))}／${await describeNotices(session)}）`
        );
      });
      // 残ったタブは閉じられ、校正・メモパネルは1枚だけ
      const memoTitle = "校正・メモパネル";
      await waitUntil(
        async () => (await editorGroupTabs(page)).flat().filter((name) => name.includes(memoTitle)).length === 1,
        "校正・メモパネルのタブが1枚だけになる",
        10_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（タブ：${JSON.stringify(await readTabState(page))}）`);
      });
      let panel: Frame | undefined;
      await waitUntil(
        async () => {
          panel = await memoPanelFrame(page);
          return panel !== undefined && (await panel.locator("button.go", { hasText: MEMO_TEXT }).count().catch(() => 0)) > 0;
        },
        "引き取った校正・メモパネルにメモの行が出る",
        30_000
      );
      if (!panel) throw new Error("校正・メモパネルが見つかりません");

      const logsBefore = await readActionLogs(session);
      await panel.locator("button.go", { hasText: MEMO_TEXT }).first().click();

      // 押したことが拡張機能に届く（行へ飛ぶ道が「原稿エディタ：…」の行を書く）
      const revealLine = /原稿エディタ：.*(台帳にありません|列目にあるので、そのタブを前に出します|タブが無いので、新しく開きます|同じ原稿のタブがほかにもあるところで)/;
      await waitUntil(
        async () => addedLines(logsBefore, await readActionLogs(session)).some((line) => revealLine.test(line)),
        "パネルの行を押したことが拡張機能に届き、行へ飛ぶ道が操作ログに残る",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（足された行：${JSON.stringify(addedLines(logsBefore, await readActionLogs(session)).slice(-10))}` +
            `／タブ：${JSON.stringify(await readTabState(page))}）`
        );
      });

      /*
        飛び先の原稿の面はつながりが切れているので、**素のエディターへ譲らず作者に訊く**（作者の裁定
        2026-10-15。`features/manuscriptEditor.ts` の `askDisconnectedReveal`）。0.106.6 までは左の列に
        素のエディターの2枚目ができていた
      */
      let asked: string | undefined;
      await waitUntil(async () => ((asked = await dialogText(page)) ?? "").includes(REVEAL_DISCONNECTED_MESSAGE), "切れた原稿へ飛ぶときの問いの窓が出る", 20_000).catch(
        async (error: unknown) => {
          throw new Error(
            `${String(error)}（いま出ている窓：${JSON.stringify(asked)}／タブ：${JSON.stringify(await readTabState(page))}` +
              `／足された行：${JSON.stringify(addedLines(logsBefore, await readActionLogs(session)).slice(-10))}）`
          );
        }
      );
      expect(asked, "既定の［ウィンドウを再読み込み］が並ぶ").toContain(RELOAD_BUTTON);
      expect(asked, "閉じて開き直す道も並ぶ").toContain("閉じて開き直す");
      expect(countTabsNamed((await editorGroupTabs(page)).flat(), MEMO_EPISODE), "問いの間に、同じ話の2枚目ができていない").toBe(1);

      // ［ウィンドウを再読み込み］を押す。控えの残る道で、再読み込みのあとに目当ての行が示される
      const oldFrame = await waitForManuscriptFrame(page, "三行目の文", "切れた原稿の面がまだ残っている", 5_000);
      const logsBeforeReload = await readActionLogs(session);
      await page.locator(".monaco-dialog-box .monaco-button", { hasText: RELOAD_BUTTON }).first().click();
      await waitUntil(() => oldFrame.isDetached(), "再読み込みで古い面が外れる", 30_000);
      const fresh = await waitForManuscriptFrame(page, "三行目の文", "再読み込みのあと、原稿エディターの面が本文を描く");

      const shownLine = /原稿エディタ：再読み込みの前に頼まれた\d+行目を示します/;
      await waitUntil(
        async () => addedLines(logsBeforeReload, await readActionLogs(session)).some((line) => shownLine.test(line)),
        "再読み込みのあと、頼まれていた行を示したことが操作ログに残る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（足された行：${JSON.stringify(addedLines(logsBeforeReload, await readActionLogs(session)).slice(-10))}` +
            `／タブ：${JSON.stringify(await readTabState(page))}）`
        );
      });
      let caret: { lineText: string; column: number } | undefined;
      await waitUntil(
        async () => ((caret = await caretPosition(fresh).catch(() => undefined))?.lineText ?? "").includes(MEMO_TEXT),
        "再読み込みのあと、カーソルがメモの行に来る",
        15_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（カーソル：${JSON.stringify(caret)}）`);
      });

      // どの列にも同じ話の2枚目ができない（しばらく見続ける）。原稿のタブは左の列のまま
      await holdsFor(
        async () => countTabsNamed((await editorGroupTabs(page)).flat(), MEMO_EPISODE) === 1,
        "再読み込みのあとも、どの列にも同じ話の2枚目ができない",
        5_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（タブ：${JSON.stringify(await readTabState(page))}` +
            `／足された行：${JSON.stringify(addedLines(logsBeforeReload, await readActionLogs(session)).slice(-10))}）`
        );
      });
      const groups = await editorGroupTabs(page);
      expect(tabNamesInclude(groups[0] ?? [], MEMO_EPISODE), `原稿のタブは左の列のまま（${JSON.stringify(groups)}）`).toBe(true);
    },
    RESTART_LAUNCH
  );
}, 300_000);

/** 問いの窓の、閉じて開き直す道のボタン（1回目 `CLOSE_AND_REOPEN_ITEM`・2回目 `COPIED_CLOSE_AND_REOPEN_ITEM`） */
const CLOSE_REOPEN_BUTTON = "閉じて開き直す";
const COPIED_CLOSE_REOPEN_BUTTON = "コピーしたので、閉じて開き直す";

/** 1回目の［閉じて開き直す］のあとに出る、コピーを頼む窓の見出し */
const COPY_FIRST_MESSAGE = "閉じる前に、つながりの切れた原稿エディターで［本文をコピー］を押してください";

/** いま出ている窓のボタンの名前（前後の空白を落とす） */
async function dialogButtons(page: Page): Promise<string[]> {
  const names = await page.locator(".monaco-dialog-box .monaco-button").allInnerTexts();
  return names.map((name) => name.trim()).filter((name) => name !== "");
}

/**
 * 156 の［閉じて開き直す］の道（0.106.7。作者の裁定 2026-10-15、設計書6.25.11）。
 *
 * 何を見張るか：
 * - 1回目の［閉じて開き直す］は「先に［本文をコピー］を押してください」の窓だけで、**タブを閉じない**
 *   （届いていなかった字の控えは切れた画面の中にしか無く、閉じると消えるため）
 * - もう一度同じ原稿の行を選ぶと、ボタンが［コピーしたので、閉じて開き直す］に替わる
 * - それを選ぶと、タブを閉じて**同じ列・同じ入口（縦／横）**で開き直し、その行が示される
 * - どの列にも同じ話の2枚目ができない
 *
 * ［本文をコピー］は押さない（この機械の OS のクリップボードを書き換えるため。288 と同じ）。
 * 製品はコピーしたかを確かめず、2回目の問いで「コピーした」と答えたことだけを見る。
 *
 * 「同じ入口」は、画面の DOM からは読めない（タブに入口の名前が出ない）ので、行へ飛ぶ道の操作ログの
 * 「（入口: …）」と、面の向き（`body.vertical`）が再起動の前と同じかで見る。
 */
test("拡張機能ホストの再起動で切れた原稿へ校正・メモパネルから飛ぶとき、［閉じて開き直す］は1回目はコピーを頼むだけで閉じず、もう一度選ぶと［コピーしたので、閉じて開き直す］が出て、選ぶと同じ列・同じ入口で開き直してその行が示され、2枚目ができない", async () => {
  await withVsCode(
    "再起動をまたぐ：切れた原稿を閉じて開き直す",
    [{ name: MEMO_EPISODE, text: `一行目の文。\n// ${MEMO_TEXT}\n三行目の文。\n` }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, MEMO_EPISODE, "三行目の文");
      const verticalBefore = await frame.evaluate(() => document.body.classList.contains("vertical"));
      await placeCaretAfter(frame, "一行目の文");
      await page.keyboard.press("Control+Alt+KeyM");
      await waitUntil(
        async () => ((await (await memoPanelFrame(page))?.locator("button.go", { hasText: MEMO_TEXT }).count()) ?? 0) > 0,
        "校正・メモパネルが右に開き、メモの行が出る",
        30_000
      );
      const before = await readTabState(page);
      expect(before.length, `原稿とパネルが左右の2列に開く（${JSON.stringify(before)}）`).toBeGreaterThanOrEqual(2);
      const groupsBefore = await editorGroupTabs(page);
      expect(tabNamesInclude(groupsBefore[0] ?? [], MEMO_EPISODE), `再起動の前、原稿のタブは左の列（${JSON.stringify(groupsBefore)}）`).toBe(true);
      expect(countTabsNamed(groupsBefore.flat(), MEMO_EPISODE), "再起動の前は原稿のタブが1枚").toBe(1);

      // 再起動して「つながりが切れました」を再読み込みせずに閉じる（156 と同じ）
      const logsBeforeRestart = await readActionLogs(session);
      await restartExtensionHost(page, MEMO_EPISODE);
      let modal: string | undefined;
      await waitUntil(async () => ((modal = await dialogText(page)) ?? "").includes(DISCONNECTED_MESSAGE), "「つながりが切れました」のモーダルが出る", 60_000).catch(
        (error: unknown) => {
          throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(modal)}）`);
        }
      );
      await closeDialog(page);

      // 新しい拡張機能が校正・メモパネルを引き取るのを待ってから押す（156 の注釈）
      const adopted = /校正・メモパネル：.*(開き直しました|引き取りました)/;
      await waitUntil(
        async () => addedLines(logsBeforeRestart, await readActionLogs(session)).some((line) => adopted.test(line)),
        "再起動のあと、新しい拡張機能が校正・メモパネルを引き取ったことが操作ログに残る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（足された行：${JSON.stringify(addedLines(logsBeforeRestart, await readActionLogs(session)).slice(-10))}` +
            `／タブ：${JSON.stringify(await readTabState(page))}／${await describeNotices(session)}）`
        );
      });
      const memoTitle = "校正・メモパネル";
      await waitUntil(
        async () => (await editorGroupTabs(page)).flat().filter((name) => name.includes(memoTitle)).length === 1,
        "校正・メモパネルのタブが1枚だけになる",
        10_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（タブ：${JSON.stringify(await readTabState(page))}）`);
      });

      /** 校正・メモパネルのメモの行を押し、切れた原稿へ飛ぶときの問いの窓が出るのを待って、その文を返す */
      const pressMemoRowAndWaitAsk = async (label: string): Promise<string> => {
        let panel: Frame | undefined;
        await waitUntil(
          async () => {
            panel = await memoPanelFrame(page);
            return panel !== undefined && (await panel.locator("button.go", { hasText: MEMO_TEXT }).count().catch(() => 0)) > 0;
          },
          `${label}：校正・メモパネルにメモの行が出ている`,
          30_000
        );
        if (!panel) throw new Error("校正・メモパネルが見つかりません");
        const logsBefore = await readActionLogs(session);
        await panel.locator("button.go", { hasText: MEMO_TEXT }).first().click();
        let asked: string | undefined;
        await waitUntil(async () => ((asked = await dialogText(page)) ?? "").includes(REVEAL_DISCONNECTED_MESSAGE), `${label}：切れた原稿へ飛ぶときの問いの窓が出る`, 20_000).catch(
          async (error: unknown) => {
            throw new Error(
              `${String(error)}（いま出ている窓：${JSON.stringify(asked)}／タブ：${JSON.stringify(await readTabState(page))}` +
                `／足された行：${JSON.stringify(addedLines(logsBefore, await readActionLogs(session)).slice(-10))}）`
            );
          }
        );
        return asked ?? "";
      };

      /* ── 1回目：［閉じて開き直す］はコピーを頼むだけで、タブを閉じない ── */
      await pressMemoRowAndWaitAsk("1回目");
      const firstButtons = await dialogButtons(page);
      expect(firstButtons, `1回目の問いのボタン（${JSON.stringify(firstButtons)}）`).toContain(RELOAD_BUTTON);
      expect(firstButtons, `1回目の問いのボタン（${JSON.stringify(firstButtons)}）`).toContain(CLOSE_REOPEN_BUTTON);
      expect(firstButtons, `1回目はまだ「コピーした」と答えられない（${JSON.stringify(firstButtons)}）`).not.toContain(COPIED_CLOSE_REOPEN_BUTTON);

      const oldFrame = await waitForManuscriptFrame(page, "三行目の文", "切れた原稿の面がまだ残っている", 5_000);
      /*
        **押すだけで、窓が消えるのは待たない**（`pressDialogButton` は「窓が消えた」まで待つ）。この［閉じて開き直す］は、
        1回目は閉じずに、すぐ次の窓「閉じる前に［本文をコピー］を押してください」を出す。次の窓が先に出ると、
        「窓が消えた」を待つ側は、新しい窓を見て消えないと判じる（ノートPCで毎回、5秒で時間切れになった。
        母艦では、次の窓が出るのが遅く、消えた瞬間が見えて通っていた）。次の窓が出たかは、下で文を待って確かめる
      */
      await page.locator(".monaco-dialog-box .monaco-button", { hasText: CLOSE_REOPEN_BUTTON }).first().click();
      let copyAsk: string | undefined;
      await waitUntil(async () => ((copyAsk = await dialogText(page)) ?? "").includes(COPY_FIRST_MESSAGE), "1回目のあと、先に［本文をコピー］を押すよう頼む窓が出る", 10_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(copyAsk)}／タブ：${JSON.stringify(await readTabState(page))}）`);
        }
      );
      await closeDialog(page);
      // 閉じない：切れた面はそのまま、タブは左の列に1枚のまま（しばらく見続ける）
      await holdsFor(
        async () => {
          const groups = await editorGroupTabs(page);
          return !oldFrame.isDetached() && countTabsNamed(groups.flat(), MEMO_EPISODE) === 1 && tabNamesInclude(groups[0] ?? [], MEMO_EPISODE);
        },
        "1回目の［閉じて開き直す］では、原稿のタブが閉じない（切れた面が残り、左の列に1枚のまま）",
        4_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（面が外れた：${oldFrame.isDetached()}／タブ：${JSON.stringify(await readTabState(page))}）`);
      });

      /* ── 2回目：同じ原稿の行をもう一度選ぶと［コピーしたので、閉じて開き直す］が出る ── */
      await pressMemoRowAndWaitAsk("2回目");
      const secondButtons = await dialogButtons(page);
      expect(secondButtons, `2回目の問いのボタン（${JSON.stringify(secondButtons)}）`).toContain(COPIED_CLOSE_REOPEN_BUTTON);
      expect(secondButtons, `2回目も既定の［ウィンドウを再読み込み］が並ぶ（${JSON.stringify(secondButtons)}）`).toContain(RELOAD_BUTTON);
      expect(secondButtons, `2回目は「コピー前」の［閉じて開き直す］が並ばない（${JSON.stringify(secondButtons)}）`).not.toContain(CLOSE_REOPEN_BUTTON);

      const logsBeforeReopen = await readActionLogs(session);
      await pressDialogButton(page, COPIED_CLOSE_REOPEN_BUTTON);

      // 切れたタブを閉じ、同じ列・同じ入口で開き直したことが操作ログに残る
      const reopenLine = /原稿エディタ：.*つながりの切れたタブを閉じ、(\d+)列目へ開き直します（入口: ([^）]+)）/;
      let reopen: RegExpExecArray | undefined;
      await waitUntil(
        async () => {
          for (const line of addedLines(logsBeforeReopen, await readActionLogs(session))) {
            const match = reopenLine.exec(line);
            if (match) {
              reopen = match;
              return true;
            }
          }
          return false;
        },
        "［コピーしたので、閉じて開き直す］のあと、切れたタブを閉じて開き直したことが操作ログに残る",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（足された行：${JSON.stringify(addedLines(logsBeforeReopen, await readActionLogs(session)).slice(-10))}` +
            `／タブ：${JSON.stringify(await readTabState(page))}／いま出ている窓：${JSON.stringify(await dialogText(page))}）`
        );
      });
      if (!reopen) throw new Error("開き直しの行が読めません");
      expect(reopen[1], `開き直すのは左の列（1列目）：${reopen[0]}`).toBe("1");
      const reopenedEntry = reopen[2];
      // 開き直しは共通の口を通り、渡した入口で新しく開く（`features/manuscriptTab.ts` の「タブが無いので、新しく開きます」）
      const openedLine = /原稿エディタ：.*タブが無いので、新しく開きます（入口: ([^／]+)／列: /;
      let freshEntry: string | undefined;
      await waitUntil(
        async () => {
          for (const line of addedLines(logsBeforeReopen, await readActionLogs(session))) {
            const match = openedLine.exec(line);
            if (match) {
              freshEntry = match[1];
              return true;
            }
          }
          return false;
        },
        "閉じたあと、同じ入口で新しく開いたことが操作ログに残る",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（足された行：${JSON.stringify(addedLines(logsBeforeReopen, await readActionLogs(session)).slice(-10))}）`);
      });
      expect(freshEntry, "閉じる前のタブの入口で開き直す").toBe(reopenedEntry);

      // 古い面は外れ、新しい面が本文を描き、カーソルがメモの行に来る（その行が示される）
      await waitUntil(() => oldFrame.isDetached(), "閉じたので、切れた面が外れる", 20_000);
      const fresh = await waitForManuscriptFrame(page, "三行目の文", "開き直した原稿エディターの面が本文を描く", 30_000);
      let caret: { lineText: string; column: number } | undefined;
      await waitUntil(
        async () => ((caret = await caretPosition(fresh).catch(() => undefined))?.lineText ?? "").includes(MEMO_TEXT),
        "開き直したあと、カーソルがメモの行に来る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（カーソル：${JSON.stringify(caret)}` +
            `／足された行：${JSON.stringify(addedLines(logsBeforeReopen, await readActionLogs(session)).slice(-10))}）`
        );
      });
      const verticalAfter = await fresh.evaluate(() => document.body.classList.contains("vertical"));
      expect(verticalAfter, "開き直した面の向き（縦／横）が再起動の前と同じ").toBe(verticalBefore);

      // どの列にも同じ話の2枚目ができない。原稿のタブは左の列に1枚
      await holdsFor(
        async () => {
          const groups = await editorGroupTabs(page);
          return countTabsNamed(groups.flat(), MEMO_EPISODE) === 1 && tabNamesInclude(groups[0] ?? [], MEMO_EPISODE);
        },
        "開き直したあとも、原稿のタブは左の列に1枚だけで、どの列にも2枚目ができない",
        5_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（タブ：${JSON.stringify(await readTabState(page))}` +
            `／足された行：${JSON.stringify(addedLines(logsBeforeReopen, await readActionLogs(session)).slice(-10))}）`
        );
      });
      expect(await dialogText(page), "開き直したあと、窓は残っていない").toBeUndefined();
    },
    RESTART_LAUNCH
  );
}, 300_000);

/* ────────────────────────────── 200 ────────────────────────────── */

const EP1 = "001_いち.txt";
const EP2 = "002_に.txt";

/** 面の見た目（縦書きか・字の大きさ px） */
async function faceLook(frame: Frame): Promise<{ vertical: boolean; size: number }> {
  return frame.evaluate(() => ({
    vertical: document.body.classList.contains("vertical"),
    size: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--novelai-size")) || 0,
  }));
}

// 2026-10-12 ノートPC（89d8c269）で落ちた（閉じた第2話を開き直すと30秒たっても描かれない）のは、quickOpen が候補の先頭を
// 確かめずに Enter を押し、前に出ていた第1話を選んでいたため。2026-10-15 に部品を直して skip を外した（実機確認リスト 200）
test("第1話と第2話を横書きで開いたまま VS Code を開き直し、第1話で縦書き・字の大きさを変えて［次の話 →］を押すと第2話が同じ見た目で出て、閉じて開き直すと元の見た目に戻る", async () => {
  await withVsCode(
    "開き直しをまたぐ：次の話へ見た目を引き継ぐ",
    [
      { name: EP1, text: "一の本文。\n" },
      { name: EP2, text: "二の本文。\n" },
    ],
    async (session) => {
      const first = await openEpisode(session.page, EP1, "一の本文");
      const original = await faceLook(first);
      expect(original.vertical, "横書きの入口で開く").toBe(false);
      expect(original.size, `字の大きさが読める ${JSON.stringify(original)}`).toBeGreaterThan(0);
      await openEpisode(session.page, EP2, "二の本文");

      // VS Code を閉じて開き直す（拡張機能ホストも作り直される。第2話のタブは背景で、画面はまだ作られない）
      await restartVsCode(session);
      const { page } = session;
      await waitUntil(
        async () => {
          const tabs = (await editorGroupTabs(page)).flat();
          return tabNamesInclude(tabs, EP1) && tabNamesInclude(tabs, EP2);
        },
        "開き直したあと、第1話と第2話のタブが戻る",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（タブ：${JSON.stringify(await readTabState(page))}）`);
      });

      // 第1話を前に出し、縦書きにして字を大きくする
      await activateTab(page, EP1);
      const ep1 = await frontFrameShowing(page, "一の本文", "開き直したあと、第1話の面が前に出て本文を描く", 60_000);
      await ep1.locator("#dir").click();
      await waitUntil(async () => (await faceLook(ep1)).vertical, "［縦書きにする］で第1話が縦書きになる", 10_000);
      await ep1.locator("#bigger").click();
      await ep1.locator("#bigger").click();
      await waitUntil(async () => (await faceLook(ep1)).size > original.size, "［＋］で字が大きくなる", 10_000);
      const changed = await faceLook(ep1);
      // 見た目の知らせ（appearance）が拡張機能へ届くのを少し待つ（次の話へ持って行く値はそれで決まる）
      await page.waitForTimeout(1_000);

      await ep1.locator("#next").click();
      await waitUntil(async () => tabNamesInclude(await activeTabNames(page), EP2), "［次の話 →］で第2話のタブが前に出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（タブ：${JSON.stringify(await readTabState(page))}）`);
        }
      );
      const ep2 = await frontFrameShowing(page, "二の本文", "第2話の面が前に出て本文を描く", 30_000);
      await waitUntil(
        async () => {
          const look = await faceLook(ep2);
          return look.vertical && look.size === changed.size;
        },
        "第2話が縦書き・同じ字の大きさで出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（第2話の見た目：${JSON.stringify(await faceLook(ep2))}／第1話で変えた見た目：${JSON.stringify(changed)}` +
            `／操作ログ：${JSON.stringify((await readActionLogs(session)).split(/\r?\n/).filter((line) => line.includes("見た目")).slice(-5))}）`
        );
      });
      expect(countTabsNamed((await editorGroupTabs(page)).flat(), EP2), "第2話は2枚目を作らず、背景のタブを前に出す").toBe(1);

      // 第2話のタブを閉じ、開き直す：覚えていた見た目（横書き・元の大きさ）で開き、さっきの見た目は当たらない
      await activateTab(page, EP2);
      await pressWorkbenchKey(page, "Control+KeyW");
      await waitUntil(async () => !tabNamesInclude((await editorGroupTabs(page)).flat(), EP2), "第2話のタブが閉じる", 10_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（タブ：${JSON.stringify(await readTabState(page))}）`);
        }
      );
      // 作者は作品一覧から開き直すが、ここではクイックオープンで開く（どちらも同じ横書きの入口で開き、
      // 置かれた見た目〔pendingAppearance〕を取りに行くのは開いた面の側。入口の道は見た目に関わらない）
      const reopened = await openEpisode(page, EP2, "二の本文");
      await holdsFor(
        async () => {
          const look = await faceLook(reopened);
          return !look.vertical && look.size === original.size;
        },
        "閉じて開き直した第2話が、横書き・元の字の大きさのまま",
        3_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（開き直した第2話の見た目：${JSON.stringify(await faceLook(reopened))}／元：${JSON.stringify(original)}）`);
      });
      const logs = await readActionLogs(session);
      expect(logs, "前に出したのに画面が立ち上がらなかった記録は出ない（立ち上がって見た目を取り出した）").not.toContain("前の話の見た目は引き継がずに捨てました");
    }
  );
}, 300_000);

/* ────────────────────────────── 288 ────────────────────────────── */

const UNSENT_EPISODE = "001_はじまり.txt";
const UNSENT_FIRST_LINE = "一行目の文。";

/**
 * 拡張機能から画面への便を、**画面の中で**受け取らせない（拡張機能ホストが起動し直して、この画面が
 * 受け手を失った形を作る。送る側は `dropEditsToHost` が落とす）。
 *
 * 製品の便は `type` を持つので、それだけを、画面の受け取り（`message` の聞き手）より先に止める
 * （窓そのものへ付けた捕まえる側の聞き手は、同じ窓の泡の側の聞き手より先に呼ばれる）。
 * **製品には何も足さない**——テストの側から、この面の窓に聞き手を足すだけ。面を作り直せば消える
 */
async function muteHostToFace(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const host = window as unknown as { __e2eMuteHost?: boolean };
    if (host.__e2eMuteHost) return;
    host.__e2eMuteHost = true;
    // 外側の枠は内側の window.postMessage で便を渡す。製品の受け手は先に登録されているので、
    // 受け手を足して止めるだけでは製品に届いてしまう（4秒ごとの count で「相手がいる」と判断された。
    // 2026-10-15 母艦で確かめた）。渡す手前で止める
    const original = window.postMessage.bind(window) as (message: unknown, ...rest: unknown[]) => void;
    (window as unknown as { postMessage: (message: unknown, ...rest: unknown[]) => void }).postMessage = (message: unknown, ...rest: unknown[]) => {
      const data = message as { type?: unknown } | null;
      if (data && typeof data.type === "string") return;
      original(message, ...rest);
    };
    window.addEventListener(
      "message",
      (event) => {
        const data = event.data as { type?: unknown } | null;
        if (data && typeof data.type === "string") event.stopImmediatePropagation();
      },
      true
    );
  });
}

async function unsentText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("unsentText")?.textContent ?? "").catch(() => "");
}

async function reopenButtonState(frame: Frame): Promise<{ hidden: boolean; disabled: boolean }> {
  return frame.evaluate(() => {
    const button = document.getElementById("unsentReopen") as HTMLButtonElement | null;
    return { hidden: button?.hidden ?? true, disabled: button?.disabled ?? true };
  });
}

// 2026-10-12 ノートPC（89d8c269）で落ちた（2段目が hostSilent でない文になる）のは、muteHostToFace の止め方がテストの誤りだったため。
// 拡張機能からの count が製品の受け手に届いていた。2026-10-15 に渡す手前で止めるよう直して skip を外した（実機確認リスト 288）
test("つながりが切れたまま打つと、4秒で赤字「打った字を原稿へ送り直しています（N秒）」が出て秒が数え上がり、30秒で再読み込みを案内する2段目に変わる（［開き直す］は出さない）", async () => {
  await withVsCode(
    "つながりの切れ：届かない字の知らせの段",
    [{ name: UNSENT_EPISODE, text: `${UNSENT_FIRST_LINE}\n` }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, UNSENT_EPISODE, "一行目の文");
      // 画面→拡張機能の「打った字」と、拡張機能→画面の便の両方を止める（受け手の居ない画面と同じ）
      await dropEditsToHost(frame);
      await muteHostToFace(frame);
      await placeCaretAfter(frame, UNSENT_FIRST_LINE);
      const typedAt = Date.now();
      await page.keyboard.insertText("乙");

      // 4秒で赤字の1段目
      await waitUntil(() => classOpen(frame, "unsent"), "届かない字の赤字が出る", 20_000);
      const shownAfter = Date.now() - typedAt;
      expect(shownAfter, `打ってから赤字が出るまで ${shownAfter}ms（製品の待ちは4秒）`).toBeGreaterThanOrEqual(3_500);
      const firstText = await unsentText(frame);
      const firstSeconds = /打った字を原稿へ送り直しています（(\d+)秒）/.exec(firstText);
      expect(firstSeconds, `1段目の文：${JSON.stringify(firstText)}`).not.toBeNull();
      // 秒が数え上がる
      await waitUntil(
        async () => {
          const now = /送り直しています（(\d+)秒）/.exec(await unsentText(frame));
          return now !== null && Number(now[1]) >= Number(firstSeconds?.[1] ?? 0) + 2;
        },
        "1段目の秒が数え上がる",
        10_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの文：${JSON.stringify(await unsentText(frame))}）`);
      });
      expect((await reopenButtonState(frame)).hidden, "1段目では［開き直す］は出ない").toBe(true);
      expect(await frame.locator("#unsentCopy").isVisible(), "1段目から［本文をコピー］がある").toBe(true);

      // 30秒で2段目。拡張機能から何も届いていないので、再読み込みを案内し、［開き直す］は出さない
      await waitUntil(async () => (await unsentText(frame)).includes("打った字が原稿に入りません"), "30秒で2段目（入りません）に変わる", 45_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの文：${JSON.stringify(await unsentText(frame))}）`);
        }
      );
      const second = await unsentText(frame);
      expect(second).toContain("拡張機能の更新や再起動で、つながりが切れたのかもしれません");
      expect(second).toContain("［本文をコピー］で控えてから、Ctrl+Shift+P →「開発者: ウィンドウの再読み込み」を");
      expect(second, "タブを閉じる道へ誘わない").toContain("タブは閉じないでください");
      expect((await reopenButtonState(frame)).hidden, "相手がいないので［開き直す］は出さない").toBe(true);
      expect(await frame.locator("#unsentCopy").isVisible(), "2段目にも［本文をコピー］がある").toBe(true);

      // 届かない字はファイルに入っていない
      const file = (await readFile(path.join(session.manuscriptFolder, UNSENT_EPISODE), "utf8")).replace(/\r\n/g, "\n");
      expect(file, "届かないはずの字がファイルに入りました").toBe(`${UNSENT_FIRST_LINE}\n`);
    }
  );
}, 240_000);

/* ────────────────────────────── 6132 ────────────────────────────── */

const OLD = "三門太志";
const NEW = "三門優一";
const NOTES = "三門太志は作者メモに書いたまま残す";

function cast(): Character[] {
  return [{ ...emptyCharacter("char_001", OLD), reading: "みかどたいし", appearedChapters: [1], authorNotes: NOTES }];
}

test("名前の付け替えを提案パネルに出したまま VS Code を閉じて開き直しても、付け替えの待ちが残っていて「人物名変更の資料反映」で資料が直る", async () => {
  await withVsCode(
    "開き直しをまたぐ：付け替えの待ち",
    [{ name: "001_はじまり.txt", text: `${OLD}は門を叩いた。\n` }],
    async (session) => {
      const page0 = session.page;
      await runCommand(page0, "人物名変更");
      await waitForQuickPick(page0, "名前を付け替える人物");
      await pickQuickPickRow(page0, OLD);
      await waitForQuickInput(page0, `「${OLD}」を何という名前にしますか`);
      await answerInput(page0, NEW);
      await waitForQuickInput(page0, `「${NEW}」の読み`);
      await answerInput(page0, "みかどゆういち");
      await waitForQuickPick(page0, "この対応で付け替えます");
      await acceptQuickPick(page0);
      await waitUntil(async () => (await dialogText(page0)) !== undefined, "範囲の確認の窓が出る", 20_000);
      await pressDialogButton(page0, "提案パネルに出す");
      // 提案パネルに並んだ＝待ちを書いたあと（待ちを書いてから提案を出す）
      await waitUntil(
        async () => ((await (await proposalPanelFrame(page0))?.locator('button[data-action="apply"]').count()) ?? 0) >= 1,
        "提案パネルに［適用］が並ぶ",
        30_000
      );

      // VS Code を閉じて開き直す
      await restartVsCode(session);
      const { page } = session;
      const since = Date.now();
      await runCommand(page, "人物名変更の資料反映");
      let confirm: string | undefined;
      await waitUntil(async () => (confirm = await dialogText(page)) !== undefined, "資料への反映の確認の窓が出る（待ちが残っている）", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（開き直したあと、待ちが消えている見込み。${await describeNotices(session, since)}）`);
        }
      );
      expect(confirm).toContain(`「${OLD}」→「${NEW}」を資料にも反映します`);
      await pressDialogButton(page, "資料も直す");

      const recordFile = path.join(defaultCharactersFolder(session.workFolder), characterFileName(cast()[0]));
      const renamedFile = path.join(defaultCharactersFolder(session.workFolder), characterFileName({ ...cast()[0], name: NEW }));
      const readRecord = async (): Promise<Character | undefined> => {
        for (const file of [recordFile, renamedFile]) {
          const text = await readFile(file, "utf8").catch(() => "");
          if (text) return JSON.parse(text) as Character;
        }
        return undefined;
      };
      await waitUntil(async () => (await readRecord())?.name === NEW, "開き直したあとの待ちで、人物の記録の名前が新しくなる", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（記録：${JSON.stringify(await readRecord())}／${await describeNotices(session, since)}）`);
        }
      );
      const record = await readRecord();
      expect(record?.reading, "開き直す前に打った読みが待ちに残っていた").toBe("みかどゆういち");
      expect(record?.authorNotes, "作者メモは無傷").toBe(NOTES);
    },
    {
      prepareWork: async ({ workFolder }) => {
        await writeCharactersTo(defaultCharactersFolder(workFolder), cast());
        await mkdir(path.join(workFolder, DEFAULT_SETTINGS_DIR), { recursive: true });
        await writeFile(path.join(workFolder, DEFAULT_SETTINGS_DIR, "plot.md"), `# プロット\n\n${OLD}が旅に出る。\n`, "utf8");
      },
    }
  );
}, 300_000);
