/**
 * 「原稿 UTF-8 変換」を、本物の VS Code で押して確かめる（画面の自動テスト、設計書5.4.2・6.113。
 * 0.149.0。作者の指示 2026-11-09「知らせる時は、原稿の文字コード変換を案内してください」）。
 *
 * 実機確認リスト 0.149.0 の3項目を機械へ移したもの。バイト列の作り方・計画・窓の文は単体テスト
 * （`unit/core/sjisToUtf8.test.ts`・`textFileConvertUtf8.test.ts`・`unit/features/convertToUtf8.test.ts`）が
 * 見ている。ここで見るのは**開いている文書の読み直しは単体テストに写せない**部分——
 *
 * 1. 原稿エディターと素のエディターで1話ずつ開いたまま、作品一覧の話の右クリック →「原稿 UTF-8 変換」
 *    →「作品の Shift_JIS の話すべて」→ 窓で2話の名前を確かめて［UTF-8 に変換する］：
 *    2つのタブが化けずに同じ本文のまま表示され続け（「まだ Shift_JIS のまま表示されています」が出ない）、
 *    ファイルは UTF-8（BOM なし）で改行（CRLF）がそのまま、編集履歴に「文字コードを変えた」が2行、
 *    そのまま打って保存すると「♡」が化けずに書ける（「〓」にならない）
 * 2. 「エンコード付きで再度開く」で Shift_JIS を選んで開いていた話：変換のあと、タブが化けない。
 *    **「まだ Shift_JIS のまま表示されています」が出るかは VS Code の版で変わる**（文字コードを指定して
 *    開き直す口は新しい版にだけある。1.90 には無く、そのときだけ知らせが出る）。この件は、知らせが出たら
 *    ［タブを閉じて開き直す］まで押して、**最後に化けていない**ことを見る（出なければ、そのまま化けていない）
 * 3. 設定 `files.encoding` を `shiftjis` にした作品：窓に BOM を付ける旨が出て、変換した話は先頭が
 *    EF BB BF で、閉じて開き直しても化けない
 *
 * **VS Code の版**：この件は既定の 1.141.0 で書いた。1.90.0 は `.vscode-test/` にあるが、画面の自動テストの
 * 部品（`workbenchDom.ts` のタブ・選ぶ画面の読み取り）は 1.138/1.141 で確かめたもので、1.90 では走らせていない。
 *
 * 文書を Shift_JIS で読ませる道：1 は `files.autoGuessEncoding`（中身から当てる）、2 は本体の
 * 「Change File Encoding → Reopen with Encoding」（作者の手順どおり）、3 は設定 `files.encoding`。
 * **AI は呼ばない。**
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import iconv = require("iconv-lite");
import { expect, test } from "vitest";
import {
  composeText,
  frontFrameAgain,
  openEpisode,
  placeCaretAfter,
} from "./support/manuscriptFrame";
import { runCommand } from "./support/quickInput";
import { expandTreeRow, SIDEBAR_LAUNCH, showSidebar, treeContextMenu } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  activateTab,
  clearNotifications,
  dialogText,
  focusTextEditor,
  notificationTexts,
  pressDialogButton,
  quickOpen,
  quickPickRows,
  quickPickTitle,
  textEditorVisibleText,
  waitForQuickPick,
} from "./support/workbenchDom";
import { CLOSE_ACTIVE_EDITOR_PRESS } from "./support/keys";

const FIRST = "第1話_駅.txt";
const SECOND = "第2話_雨.txt";
/** 改行は CRLF（変換のあとも変わらないことを見る）。Shift_JIS で書ける字だけで作る */
const FIRST_BODY = "　終電を逃した駅のホームに、雨の音だけが残っていた。\r\n　傘も持たず、時計の針ばかりを見つめていた。\r\n　零時を過ぎても、次の電車は来なかった。\r\n";
const SECOND_BODY = "　翌朝の空は、嘘のように晴れ渡っていた。\r\n　昨夜の雨が、街の埃を洗い流したのだろう。\r\n　通りには、洗濯物を干す人の姿が見えた。\r\n";
const SECOND_MARK = "洗濯物を干す人";
const FIRST_MARK = "次の電車は来なかった";

const UPDATED = "UTF-8 に変換しました";
const STALE_NOTICE = "まだ Shift_JIS のまま表示されています";
const CONVERT_BUTTON = "UTF-8 に変換する";

const SJIS_FILES: Array<{ name: string; body: string }> = [
  { name: FIRST, body: FIRST_BODY },
  { name: SECOND, body: SECOND_BODY },
];

/** 話を Shift_JIS のバイトで置き直す（見本はいったん UTF-8 で書かれる） */
function sjisWork(bodies: ReadonlyArray<{ name: string; body: string }>): NonNullable<LaunchOptions["prepareWork"]> {
  return async ({ manuscriptFolder }) => {
    for (const { name, body } of bodies) {
      await writeFile(path.join(manuscriptFolder, name), iconv.encode(body, "shift_jis"));
    }
  };
}

function hex(bytes: Uint8Array, limit = 24): string {
  return Array.from(bytes.slice(0, limit), (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

async function readBytes(session: E2ESession, name: string): Promise<Uint8Array> {
  return readFile(path.join(session.manuscriptFolder, name)).catch(() => new Uint8Array());
}

/** 製品の書き戻しは「退避 → 削除 → 作り直し」。一瞬ファイルが無いので、その間は待つ */
async function waitForBytes(
  session: E2ESession,
  name: string,
  done: (bytes: Uint8Array) => boolean,
  label: string
): Promise<Uint8Array> {
  let last: Uint8Array = new Uint8Array();
  try {
    await waitUntil(
      async () => {
        last = await readBytes(session, name);
        return last.length > 0 && done(last);
      },
      label,
      30_000
    );
  } catch (error) {
    throw new Error(`${String(error)}（いまのバイト：${hex(last)}）`);
  }
  return last;
}

/** UTF-8（BOM なし）で、字と改行がそのままか */
function isPlainUtf8Of(bytes: Uint8Array, body: string): boolean {
  return Buffer.from(bytes).equals(Buffer.from(body, "utf8"));
}

async function describeNotices(page: Page): Promise<string> {
  return `知らせ：${JSON.stringify(await notificationTexts(page))}／窓：${JSON.stringify(await dialogText(page))}`;
}

/** 完了の知らせ（「N話を UTF-8 に変換しました」）が出るまで待つ */
async function waitConvertedNotice(page: Page, count: number): Promise<void> {
  await waitUntil(
    async () => (await notificationTexts(page)).some((text) => text.includes(`${count}話を ${UPDATED}`)),
    `「${count}話を ${UPDATED}。」の知らせが出る`,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await describeNotices(page)}）`);
  });
}

async function staleNoticeShown(page: Page): Promise<boolean> {
  return (await notificationTexts(page)).some((text) => text.includes(STALE_NOTICE));
}

/** 確かめの窓を待ち、本文（窓の文）を返す */
async function waitConfirmDialog(page: Page, includes: string): Promise<string> {
  let shown = "";
  await waitUntil(
    async () => {
      shown = (await dialogText(page)) ?? "";
      return shown.includes(includes);
    },
    `確かめの窓に「${includes}」が出る`,
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await describeNotices(page)}）`);
  });
  return shown;
}

/** 作品の編集履歴（`.aiwriter/history/edits.jsonl`）の「文字コードを変えた」の行 */
async function convertHistory(session: E2ESession): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(session.workFolder, ".aiwriter", "history", "edits.jsonl"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.action === "文字コードを変えた");
}

test("原稿エディターと素のエディターで開いたまま、作品一覧の話から「作品の Shift_JIS の話すべて」を UTF-8 にすると、2つのタブは化けず、ファイルは UTF-8（BOM なし・CRLF のまま）になり、編集履歴が2行残り、♡ もそのまま保存できる", async () => {
  await withVsCode(
    "UTF-8 変換 2話開いたまま",
    SJIS_FILES.map(({ name, body }) => ({ name, text: body })),
    async (session) => {
      const { page } = session;
      await clearNotifications(page);

      /* ── 変換の前：2つのタブが読める（読めなければ、以降の「化けない」は意味が無い） ── */
      const frame = await openEpisode(page, FIRST, FIRST_MARK).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（Shift_JIS の話が読めて開きませんでした。files.autoGuessEncoding が当たらなかった可能性）`);
      });
      await quickOpen(page, SECOND);
      await waitUntil(
        async () => (await textEditorVisibleText(page)).includes(SECOND_MARK),
        "素のエディターに、Shift_JIS の第2話が化けずに出る",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（見えている字：${JSON.stringify((await textEditorVisibleText(page)).slice(0, 80))}）`);
      });
      expect(await composeText(frame)).toContain(FIRST_MARK);

      /* ── 作品一覧の第1話を右クリック →「原稿 UTF-8 変換」→「作品の Shift_JIS の話すべて」 ── */
      await showSidebar(page, E2E_WORK_TITLE);
      await expandTreeRow(page, E2E_WORK_TITLE);
      await treeContextMenu(page, "第1話 ", "原稿 UTF-8 変換");
      const rows = await waitForQuickPick(page, "原稿 UTF-8 変換");
      expect(rows.map((row) => row.label), "範囲の選択肢").toEqual(
        expect.arrayContaining(["この話だけ", "作品の Shift_JIS の話すべて"])
      );
      await page.locator(".quick-input-widget .quick-input-list .monaco-list-row", { hasText: "作品の Shift_JIS の話すべて" }).first().click();

      const confirm = await waitConfirmDialog(page, "2話を Shift_JIS から UTF-8 に変換します");
      expect(confirm).toContain(FIRST);
      expect(confirm).toContain(SECOND);
      await pressDialogButton(page, CONVERT_BUTTON);

      /* ── ファイル：UTF-8 になり、字と改行（CRLF）はそのまま。BOM は付かない ── */
      const first = await waitForBytes(session, FIRST, (bytes) => isPlainUtf8Of(bytes, FIRST_BODY), "第1話のファイルが UTF-8 になる");
      const second = await waitForBytes(session, SECOND, (bytes) => isPlainUtf8Of(bytes, SECOND_BODY), "第2話のファイルが UTF-8 になる");
      expect(hex(first, 3), "第1話の先頭が BOM になっていない").not.toBe("ef bb bf");
      expect(second.includes(0x0d), "改行は CRLF のまま").toBe(true);

      /* ── 画面：化けずに同じ本文のまま。「まだ Shift_JIS のまま」の知らせは出ない ── */
      await waitConvertedNotice(page, 2);
      await holdsFor(async () => !(await staleNoticeShown(page)), `「${STALE_NOTICE}」の知らせが出ない`, 4_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeNotices(page)}）`);
      });
      // いま前に出ているのは素のエディター（第2話）
      await holdsFor(async () => (await textEditorVisibleText(page)).includes(SECOND_MARK), "素のエディターの第2話が化けない", 2_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（見えている字：${JSON.stringify((await textEditorVisibleText(page)).slice(0, 80))}）`);
        }
      );
      await activateTab(page, FIRST);
      const front = await frontFrameAgain(page, frame, FIRST_MARK, "原稿エディターの第1話が前に出る");
      await holdsFor(async () => (await composeText(front)).includes(FIRST_MARK), "原稿エディターの第1話が化けない", 2_000);

      /* ── 編集履歴に「文字コードを変えた」が2行 ── */
      await waitUntil(async () => (await convertHistory(session)).length === 2, "編集履歴に「文字コードを変えた」が2行残る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（行：${JSON.stringify(await convertHistory(session))}）`);
        }
      );
      const history = await convertHistory(session);
      expect(history.map((entry) => String(entry.detail)).every((detail) => detail === "Shift_JIS → UTF-8")).toBe(true);

      /* ── そのまま打って保存：♡ が化けずに書ける（「〓」にならない） ── */
      await placeCaretAfter(front, "雨の音");
      await page.keyboard.insertText("♡");
      await page.keyboard.press("ControlOrMeta+KeyS");
      const saved = await waitForBytes(
        session,
        FIRST,
        (bytes) => Buffer.from(bytes).toString("utf8").includes("雨の音♡"),
        "打った「♡」が UTF-8 のまま保存される"
      );
      expect(Buffer.from(saved).toString("utf8"), "「〓」に置き換わっていません").not.toContain("〓");
      expect(Buffer.from(saved).toString("utf8").replace(/\r\n/g, "\n")).toBe(FIRST_BODY.replace(/\r\n/g, "\n").replace("雨の音", "雨の音♡"));
    },
    {
      settings: {
        ...SIDEBAR_LAUNCH.settings,
        // 第2話だけ素のエディターで開く（具体的な組を先に書く。ほかの話は原稿エディター）
        "workbench.editorAssociations": {
          "*_雨.txt": "default",
          "*.txt": "novelai.manuscriptEditorHorizontal",
          "*.md": "novelai.manuscriptEditorHorizontal",
        },
        // Shift_JIS の話を化けずに開かせる（設定で決め打ちせず、中身から当てる）
        "files.autoGuessEncoding": true,
      },
      keybindings: SIDEBAR_LAUNCH.keybindings,
      prepareWork: sjisWork(SJIS_FILES),
    }
  );
}, 300_000);

/** 本体の「Change File Encoding → Reopen with Encoding → Shift JIS」（作者の手順） */
async function reopenWithShiftJis(page: Page): Promise<void> {
  await runCommand(page, "Change File Encoding");
  await waitUntil(async () => (await quickPickTitle(page)) !== undefined, "文字コードの選ぶ画面が出る", 15_000);
  const action = page.locator(".quick-input-widget .quick-input-list .monaco-list-row", { hasText: /Reopen with Encoding/i }).first();
  await waitUntil(async () => (await action.count()) > 0, "「Reopen with Encoding」の行が出る", 10_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（並び：${JSON.stringify((await quickPickRows(page)).map((row) => row.label))}）`);
  });
  await action.click();
  // 文字コードの一覧。絞り込んで先頭の「Shift JIS」を押す
  await waitUntil(async () => (await quickPickRows(page)).length > 3, "文字コードの一覧が出る", 10_000);
  await page.keyboard.insertText("Shift JIS");
  const target = page.locator(".quick-input-widget .quick-input-list .monaco-list-row", { hasText: /Shift ?JIS/i }).first();
  await waitUntil(async () => (await target.count()) > 0, "一覧に「Shift JIS」の行が出る", 10_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（並び：${JSON.stringify((await quickPickRows(page)).map((row) => row.label))}）`);
  });
  await target.click();
}

test("「エンコード付きで再度開く」で Shift_JIS を選んで開いていた話を UTF-8 に変換しても、タブは化けない（知らせが出たら［タブを閉じて開き直す］で化けずに開き直る）", async () => {
  await withVsCode(
    "UTF-8 変換 再度開く",
    [{ name: FIRST, text: FIRST_BODY }],
    async (session) => {
      const { page } = session;
      await clearNotifications(page);

      // 設定なしの VS Code は Shift_JIS を UTF-8 と読んで化ける。作者が「再度開く」で Shift_JIS を選んだ状態にする
      await quickOpen(page, FIRST);
      await waitUntil(async () => (await textEditorVisibleText(page)).trim().length > 0, "素のエディターで話が開く（化けた形）", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（見えている字：${JSON.stringify((await textEditorVisibleText(page)).slice(0, 80))}）`);
        }
      );
      expect(await textEditorVisibleText(page), "設定なしでは化けて読めない前提").not.toContain(FIRST_MARK);
      await reopenWithShiftJis(page);
      await waitUntil(async () => (await textEditorVisibleText(page)).includes(FIRST_MARK), "Shift JIS で開き直すと読める", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（見えている字：${JSON.stringify((await textEditorVisibleText(page)).slice(0, 80))}）`);
        }
      );

      // 前に出ているタブから「原稿 UTF-8 変換」（Shift_JIS の話はこの1つだけなので、範囲は訊かれない）
      await runCommand(page, "原稿 UTF-8 変換");
      await waitConfirmDialog(page, "1話を Shift_JIS から UTF-8 に変換します");
      await pressDialogButton(page, CONVERT_BUTTON);
      await waitForBytes(session, FIRST, (bytes) => isPlainUtf8Of(bytes, FIRST_BODY), "ファイルが UTF-8 になる");
      await waitConvertedNotice(page, 1);

      /*
        化けたまま残る形（指定した文字コードを VS Code が覚えている）は、製品が開き直しで直すか、
        直せない版では知らせて［タブを閉じて開き直す］を出す。どちらでも**最後に読める**ことを見る
      */
      const stale = await waitUntil(async () => await staleNoticeShown(page), "（出るなら）まだ Shift_JIS のままの知らせ", 5_000).then(
        () => true,
        () => false
      );
      if (stale) {
        await page.locator(".notification-toast .monaco-button", { hasText: "タブを閉じて開き直す" }).first().click();
      }
      await waitUntil(
        async () => (await textEditorVisibleText(page)).includes(FIRST_MARK),
        `変換のあと、タブが化けずに読める（知らせは${stale ? "出た→開き直した" : "出なかった"}）`,
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（見えている字：${JSON.stringify((await textEditorVisibleText(page)).slice(0, 80))}／${await describeNotices(page)}）`);
      });
      // 読めたまま、2秒たっても揺り戻して化けない
      await holdsFor(async () => (await textEditorVisibleText(page)).includes(FIRST_MARK), "読めたあとに化けない", 2_500);
      // 化けたまま打って保存すると原稿が壊れる。読める状態で打って保存すると UTF-8 のまま入る
      await focusTextEditor(page);
      await page.keyboard.insertText("♡");
      await page.keyboard.press("ControlOrMeta+KeyS");
      const saved = await waitForBytes(
        session,
        FIRST,
        (bytes) => Buffer.from(bytes).toString("utf8").includes("♡"),
        "打った「♡」が UTF-8 のまま保存される"
      );
      expect(Buffer.from(saved).toString("utf8")).toContain(FIRST_MARK);
      expect(Buffer.from(saved).toString("utf8"), "「〓」にも「?」にもならない").not.toMatch(/[〓?]/);
    },
    {
      // 第1話は素のエディターで開く
      settings: { "workbench.editorAssociations": { "*.txt": "default", "*.md": "default" } },
      prepareWork: sjisWork([{ name: FIRST, body: FIRST_BODY }]),
    }
  );
}, 300_000);

test("設定 files.encoding が shiftjis の作品で変換すると、窓に BOM を付ける旨が出て、変換した話は先頭が EF BB BF になり、閉じて開き直しても化けない", async () => {
  await withVsCode(
    "UTF-8 変換 設定が shiftjis",
    [{ name: FIRST, text: FIRST_BODY }],
    async (session) => {
      const { page } = session;
      await clearNotifications(page);
      const frame = await openEpisode(page, FIRST, FIRST_MARK).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（設定 files.encoding が shiftjis でも読めませんでした）`);
      });
      expect(await composeText(frame)).toContain(FIRST_MARK);

      await runCommand(page, "原稿 UTF-8 変換");
      const confirm = await waitConfirmDialog(page, "1話を Shift_JIS から UTF-8 に変換します");
      expect(confirm).toContain("設定「files.encoding」が shiftjis なので、BOM を付けます");
      expect(confirm).toContain("BOM（先頭の印）を付けます。");
      await pressDialogButton(page, CONVERT_BUTTON);

      // 先頭が BOM。そのあとは UTF-8 の本文（改行はそのまま）
      const bytes = await waitForBytes(
        session,
        FIRST,
        (now) => now.length > 3 && now[0] === 0xef && now[1] === 0xbb && now[2] === 0xbf,
        "ファイルの先頭が BOM（EF BB BF）になる"
      );
      expect(Buffer.from(bytes.slice(3)).equals(Buffer.from(FIRST_BODY, "utf8")), `先頭のあと：${hex(bytes.slice(3))}`).toBe(true);
      await waitConvertedNotice(page, 1);

      // 閉じて開き直しても化けない（BOM があれば、設定が shiftjis でも UTF-8 と読まれる）
      await page.keyboard.press(CLOSE_ACTIVE_EDITOR_PRESS);
      const reopened = await openEpisode(page, FIRST, FIRST_MARK).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（開き直しで化けた可能性。${await describeNotices(page)}）`);
      });
      expect(await composeText(reopened)).toContain(FIRST_MARK);
    },
    {
      settings: { "files.encoding": "shiftjis" },
      prepareWork: sjisWork([{ name: FIRST, body: FIRST_BODY }]),
    }
  );
}, 300_000);
