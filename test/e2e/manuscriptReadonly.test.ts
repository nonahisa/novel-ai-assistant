/**
 * 読み取り専用の原稿に打った字はどうなるか（調べるための画面の自動テスト。2026-10-15）。
 *
 * 別の担当の観測（1回、1.141.0）：設定 `files.readonlyInclude` で読み取り専用にした原稿を原稿エディターで
 * 開いて打つと、`applyEdit` は true を返し画面にも字が出るのに、タブに未保存の印が付かず、
 * ファイルも変わらなかった。製品（`src/features/manuscriptEditor.ts`）は読み取り専用をどこでも見ていない。
 *
 * ここでは次の道で、打つ→ Ctrl+S → タブを閉じる、の各段で何が起きるかを書き留める。
 *   A. `files.readonlyInclude` ＋ 原稿エディター
 *   B. `files.readonlyInclude` ＋ 素のテキストエディター（VS Code 本体の扱いを比べる）
 *   C. Windows の読み取り専用属性（attrib +R）＋ 原稿エディター（作者に起こりうるのはこちら）
 *   D. A のまま VS Code の窓を閉じる
 *
 * 観測は `[読み取り専用の観測]` の行で標準出力へ出す（報告の材料。通った件の出力は Vitest が
 * 出さないので、環境変数 `NOVELAI_E2E_OBSERVE_FILE` に道を渡すとそこへも控える）。
 * 確かめ（expect）は「作者の字が知らされずに消えない」こと。
 *
 * 2026-10-15 の結果（1.141.0、2回とも同じ）：
 *   A・D は **知らされずに消える**——未保存の印が付かず、Ctrl+S で下の欄に「保存しました（20字）」が出て
 *   actions.log にも「保存しました」と残るのに、ファイルは元のまま。タブを閉じても窓を閉じても確認が出ず、
 *   開き直すと字は無い。だから `test.fails` にしていた。
 *   0.107.4 で直した：当てても文書が未保存にならない便を「入らなかった」と返し（文書の本文は
 *   メモリ上では変わっていた——下の欄の「保存しました（20字）」は打った後の字数——ので、本文の見比べでは気づけない）（画面に［本文をコピー］つきの
 *   赤字）、右下に読み取り専用の知らせを出し、［保存］は「保存しました」と言わない。A・D は `test` へ戻し、
 *   期待をそれに合わせた（窓を閉じても VS Code は確認を出さないので、D は「閉じる前に知らされている」を見る）。
 *   作者の裁定（2026-10-15 23時）で、A の赤字を読み取り専用の文（秒を数えない・［開き直す］を出さない）にし、
 *   拡張機能の側にも控えを置いて、タブを閉じて開き直したときに控えの帯（［戻す］）が出るようにした。
 *   A はその2つも見る（この期待は書き直しただけで、まだ走らせていない）。
 *   B は本体が打たせない（「Editor is read-only because the file was set read-only via settings…」の吹き出し）。
 *   C は未保存の印が付き、Ctrl+S で「Failed to save … File is read-only」の知らせ、閉じるときに保存の確認が出る
 *   （知らされる）。
 *
 * **AI は呼ばない。**
 */
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { classOpen, composeText, footText, openEpisode, placeCaretAfter, rescueBarText } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  dialogText,
  focusTextEditor,
  notificationTexts,
  pressWorkbenchKey,
  quickOpen,
  readTabState,
  statusBarTexts,
  tabIsDirty,
  textEditorVisibleText,
} from "./support/workbenchDom";

const run = promisify(execFile);

const EPISODE = "001_はじまり.txt";
const ORIGINAL = "一行目の文。\n二行目の文。\n三行目の文。\n";
const TYPED = "短い";
const AFTER = "一行目の文。\n二行目の短い文。\n三行目の文。\n";

async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

async function actionsLog(session: E2ESession): Promise<string> {
  try {
    return await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8");
  } catch {
    return "（無し）";
  }
}

/** 調べた様子を1行で出す（報告の材料。テストの成否とは別に必ず出す） */
function note(label: string, detail: object): void {
  const line = `[読み取り専用の観測] ${label} ${JSON.stringify(detail)}`;
  console.log(line);
  // 通ったテストの標準出力は Vitest が出さないので、控えを置く先を環境変数で渡せるようにする
  const file = process.env.NOVELAI_E2E_OBSERVE_FILE;
  if (file) appendFileSync(file, line + "\n", "utf8");
}

async function tabs(page: Page): Promise<string> {
  return JSON.stringify(
    (await readTabState(page)).map((group) => group.tabs.map((tab) => `${tab.name}${tab.dirty ? "●" : ""}${tab.active ? "*" : ""}`))
  );
}

/** 知らせ・窓・帯・タブ・ファイルをまとめて控える */
interface Snapshot {
  tabs: string;
  dirty: boolean;
  file: string;
  notifications: string[];
  dialog: string | undefined;
  statusBar: string[];
}

async function snapshot(session: E2ESession): Promise<Snapshot> {
  const { page } = session;
  return {
    tabs: await tabs(page),
    dirty: await tabIsDirty(page, EPISODE),
    file: await fileText(session),
    notifications: await notificationTexts(page),
    dialog: await dialogText(page),
    statusBar: (await statusBarTexts(page)).filter((text) => !/^Ln \d|UTF|CRLF|LF|Spaces|Plain|Layout/.test(text)),
  };
}

/** 画面の下の赤字（#unsentText）の文 */
async function unsentText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("unsentText")?.textContent ?? "").catch(() => "（読めない）");
}

/** 閉じるキー（本体向け。WebView に焦点があっても届くよう `pressWorkbenchKey` で押す） */
const CLOSE_KEY = { key: "ctrl+alt+shift+w", command: "workbench.action.closeActiveEditor" };
const CLOSE_PRESS = "Control+Alt+Shift+KeyW";

/**
 * 原稿エディターで打って、保存して、閉じるまでを見る（A と C で共通）。
 * @returns 閉じるとき確認の窓が出たか・字がファイルに入ったか
 */
interface ManuscriptRun {
  lost: boolean;
  warned: boolean;
  /** 打った直後の知らせ（右下） */
  noticesAfterType: string[];
  /** 打った直後に「打った字が入っていない」赤字（#unsent。［本文をコピー］つき）が出ていたか */
  unsentAfterType: boolean;
  /** 打った直後の赤字の文（#unsentText） */
  unsentTextAfterType: string;
  /** 開き直したときの控えの帯（#rescue）が開いていたか・その文 */
  rescueAfterReopen: { open: boolean; text: string };
  /** Ctrl+S の後の下の欄の文 */
  footAfterSave: string;
  /** Ctrl+S の後の操作ログ */
  logAfterSave: string;
}

async function typeSaveCloseInManuscript(session: E2ESession, label: string): Promise<ManuscriptRun> {
  const { page } = session;
  const frame = await openEpisode(page, EPISODE, "二行目の文");
  note(`${label}：開いた直後`, await snapshot(session));

  await placeCaretAfter(frame, "二行目の");
  await page.keyboard.insertText(TYPED);
  await waitUntil(async () => (await composeText(frame)).includes("二行目の短い文。"), "打った字が画面に出る");
  // 便が往復し、未保存の印が付くなら付くだけの間を置く
  await page.waitForTimeout(2_500);
  const afterType = {
    ...(await snapshot(session)),
    compose: await composeText(frame),
    unsent: await classOpen(frame, "unsent"),
    unsentText: await unsentText(frame),
    rescueBar: await rescueBarText(frame).catch(() => "（読めない）"),
    footNote: await footText(frame, "note").catch(() => "（読めない）"),
  };
  note(`${label}：打った後`, afterType);

  await page.keyboard.press("Control+KeyS");
  await page.waitForTimeout(4_000);
  const afterSave = {
    ...(await snapshot(session)),
    compose: await composeText(frame),
    footNote: await footText(frame, "note").catch(() => "（読めない）"),
    saveFail: await classOpen(frame, "saveFail").catch(() => "（読めない）"),
    rescueBar: await rescueBarText(frame).catch(() => "（読めない）"),
    log: await actionsLog(session),
  };
  note(`${label}：Ctrl+S の後`, afterSave);

  // 閉じる。未保存なら VS Code が保存の確認を出すはず
  await pressWorkbenchKey(page, CLOSE_PRESS);
  let closeDialog: string | undefined;
  await holdsFor(
    async () => {
      closeDialog = (await dialogText(page)) ?? closeDialog;
      return true;
    },
    "閉じたときの確認の窓を3秒見る",
    3_000
  );
  note(`${label}：タブを閉じた後`, { ...(await snapshot(session)), closeDialog, log: await actionsLog(session) });
  if (closeDialog !== undefined) {
    // 調べるだけなので保存しない（「Don't Save」）。窓が残ると片づけが止まる
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  // 開き直したとき、打った字は残っているか（メモリ上の文書が生きていれば戻ってくる）
  const reopened = await openEpisode(page, EPISODE, "二行目の").catch(() => undefined);
  let rescueAfterReopen = { open: false, text: "" };
  if (reopened) {
    await page.waitForTimeout(1_500);
    rescueAfterReopen = { open: await classOpen(reopened, "rescue"), text: await rescueBarText(reopened) };
    note(`${label}：開き直した後`, {
      ...(await snapshot(session)),
      compose: await composeText(reopened),
      rescue: rescueAfterReopen,
    });
  }

  const finalFile = await fileText(session);
  const notices = [...(await notificationTexts(page)), ...afterSave.notifications, ...afterType.notifications];
  const warned =
    closeDialog !== undefined ||
    afterSave.saveFail === true ||
    notices.some((text) => /読み取り|read-?only|保存できません|入れられませんでした|Failed to save|Unable to write/i.test(text)) ||
    /保存できませんでした/.test(String(afterSave.footNote));
  return {
    lost: finalFile !== AFTER,
    warned,
    noticesAfterType: afterType.notifications,
    unsentAfterType: afterType.unsent,
    unsentTextAfterType: afterType.unsentText,
    rescueAfterReopen,
    footAfterSave: String(afterSave.footNote),
    logAfterSave: afterSave.log,
  };
}

/* ── A. files.readonlyInclude ＋ 原稿エディター ── */

test(
  "A：files.readonlyInclude の原稿を原稿エディターで打つと、読み取り専用の知らせと控えの赤字が出て、Ctrl+S でも「保存しました」と言わない",
  async () => {
    const options: LaunchOptions = {
      settings: { "files.readonlyInclude": { "**/本文/*.txt": true } },
      keybindings: [CLOSE_KEY],
    };
    await withVsCode(
      "読み取り専用（設定）の原稿エディター",
      [{ name: EPISODE, text: ORIGINAL }],
      async (session) => {
        const result = await typeSaveCloseInManuscript(session, "A");
        note("A：結論", result);
        expect(result.lost && !result.warned, "打った字が保存されず、知らせも確認の窓も出ませんでした").toBe(false);
        // 打った直後に、読み取り専用だと右下で知らせる（打ち続ける前に気づけるように）
        expect(
          result.noticesAfterType.some((text) => /読み取り専用/.test(text) && /本文をコピー/.test(text)),
          `打った直後に読み取り専用の知らせが出ませんでした：${JSON.stringify(result.noticesAfterType)}`
        ).toBe(true);
        // 画面の下に、［本文をコピー］つきの「入っていない」赤字が出る
        expect(result.unsentAfterType, "打った字が入っていない赤字（控え）が出ませんでした").toBe(true);
        /*
          赤字は読み取り専用の文（作者の裁定、2026-10-15 23時）。秒を数える「送り直しています」や、
          開き直しても入らない［開き直す］へ誘う文にしない
        */
        expect(result.unsentTextAfterType).toContain("読み取り専用");
        expect(result.unsentTextAfterType).toContain("本文をコピー");
        expect(result.unsentTextAfterType).not.toMatch(/送り直しています|開き直す/);
        // 保存したと偽らない（下の欄にも操作ログにも）
        expect(result.footAfterSave).not.toMatch(/保存しました/);
        expect(result.logAfterSave).not.toMatch(/［保存］で保存しました/);
        /*
          タブを閉じても、拡張機能の側の控え（作業場の覚え）から、開き直したときに控えの帯で
          取り戻せる（作者の裁定、2026-10-15 23時。設計書6.25.9）
        */
        expect(result.rescueAfterReopen.open, "開き直したときに控えの帯が出ませんでした").toBe(true);
        expect(result.rescueAfterReopen.text).toContain("前回、原稿に入らなかった字があります");
      },
      options
    );
  }
);

/* ── B. files.readonlyInclude ＋ 素のテキストエディター ── */

test("B：files.readonlyInclude の原稿を素のテキストエディターで打つと、VS Code 本体はどう扱うか（観測）", async () => {
  await withVsCode(
    "読み取り専用（設定）の素のエディター",
    [{ name: EPISODE, text: ORIGINAL }],
    async (session) => {
      const { page } = session;
      await quickOpen(page, EPISODE);
      await waitUntil(async () => (await textEditorVisibleText(page)).includes("二行目の文"), "素のエディターに本文が出る", 20_000);
      note("B：開いた直後", await snapshot(session));
      await focusTextEditor(page);
      await page.keyboard.press("Control+End");
      await page.keyboard.type("足した字");
      await page.waitForTimeout(1_500);
      // 読み取り専用の素のエディターは、打つと「読み取り専用のエディターでは編集できません」の吹き出しを出す
      const hover = await page
        .locator(".monaco-editor-overlaymessage, .monaco-hover")
        .allInnerTexts()
        .catch(() => [] as string[]);
      note("B：打った後", { ...(await snapshot(session)), visible: await textEditorVisibleText(page), hover });
      await page.keyboard.press("Control+KeyS");
      await page.waitForTimeout(2_500);
      note("B：Ctrl+S の後", await snapshot(session));
      expect(await fileText(session), "読み取り専用のファイルが書き換わりました").toBe(ORIGINAL);
    },
    {
      settings: {
        "workbench.editorAssociations": {},
        "files.readonlyInclude": { "**/本文/*.txt": true },
      },
    }
  );
});

/* ── C. Windows の読み取り専用属性 ＋ 原稿エディター ── */

test(
  "C：読み取り専用属性（attrib +R）の原稿を原稿エディターで打つと、字がファイルに入るか、入らないことを知らされる",
  async () => {
    let target = "";
    const options: LaunchOptions = {
      keybindings: [CLOSE_KEY],
      prepareWork: async ({ manuscriptFolder }) => {
        target = path.join(manuscriptFolder, EPISODE);
        await run("attrib", ["+R", target]);
      },
    };
    await withVsCode(
      "読み取り専用（属性）の原稿エディター",
      [{ name: EPISODE, text: ORIGINAL }],
      async (session) => {
        try {
          const attr = (await run("attrib", [target])).stdout.trim();
          note("C：属性", { attr });
          const result = await typeSaveCloseInManuscript(session, "C");
          note("C：結論", result);
          expect(result.lost && !result.warned, "打った字が保存されず、知らせも確認の窓も出ませんでした").toBe(false);
        } finally {
          // 片づけ（一時フォルダーの削除）が属性で止まらないよう外す
          await run("attrib", ["-R", target]).catch(() => undefined);
        }
      },
      options
    );
  }
);

/* ── D. 打ったまま VS Code の窓を閉じる ── */

const CLOSE_WINDOW_KEY = { key: "ctrl+alt+shift+j", command: "workbench.action.closeWindow" };
const CLOSE_WINDOW_PRESS = "Control+Alt+Shift+KeyJ";

test(
  "D：files.readonlyInclude の原稿を原稿エディターで打つと、窓を閉じる前に読み取り専用の知らせと控えの赤字が出ている",
  async () => {
    await withVsCode(
      "読み取り専用（設定）で窓を閉じる",
      [{ name: EPISODE, text: ORIGINAL }],
      async (session) => {
        const { page } = session;
        const frame = await openEpisode(page, EPISODE, "二行目の文");
        await placeCaretAfter(frame, "二行目の");
        await page.keyboard.insertText(TYPED);
        await waitUntil(async () => (await composeText(frame)).includes("二行目の短い文。"), "打った字が画面に出る");
        await page.waitForTimeout(2_500);
        const afterType = await snapshot(session);
        const unsentOpen = await classOpen(frame, "unsent");
        note("D：打った後", { ...afterType, unsent: unsentOpen });
        /*
          窓を閉じるとき VS Code は確認を出さない（文書が未保存にならないため。製品からは止められない）。
          そこで**閉じる前に知らされている**ことを確かめる——読み取り専用の知らせと、
          ［本文をコピー］つきの赤字
        */
        const warnedBeforeClose =
          unsentOpen && afterType.notifications.some((text) => /読み取り専用/.test(text));
        await pressWorkbenchKey(page, CLOSE_WINDOW_PRESS).catch(() => undefined);
        let dialog: string | undefined;
        let closed = false;
        await holdsFor(
          async () => {
            closed = page.isClosed();
            if (!closed) dialog = (await dialogText(page).catch(() => undefined)) ?? dialog;
            return true;
          },
          "窓を閉じたあと3秒見る",
          3_000
        );
        note("D：窓を閉じた後", { closed, dialog, file: await fileText(session), log: await actionsLog(session) });
        const silentlyLost = closed && dialog === undefined && (await fileText(session)) !== AFTER;
        expect(silentlyLost && !warnedBeforeClose, "知らせも確認も出ずに窓が閉じ、打った字が消えました").toBe(false);
        expect(warnedBeforeClose, `閉じる前に読み取り専用の知らせと控えの赤字が出ていませんでした：${JSON.stringify(afterType.notifications)}`).toBe(true);
      },
      { settings: { "files.readonlyInclude": { "**/本文/*.txt": true } }, keybindings: [CLOSE_WINDOW_KEY] }
    );
  }
);
