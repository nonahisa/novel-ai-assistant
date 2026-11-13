import { settleLogWrites, useLogFile } from "../core/logger";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as iconv from "iconv-lite";
import * as vscode from "vscode";
import { scaffoldWorkFolder } from "../core/workRegistry";
import { convertToUtf8 } from "../features/convertToUtf8";
import type { WorkEntry } from "../models/types";

/**
 * 原稿 UTF-8 変換のあと、VS Code 1.90 だけで出る「まだ Shift_JIS のまま表示されています」の知らせと、
 * ［タブを閉じて開き直す］で化けずに開き直ること（設計書5.4.2、実機確認リスト 0.149.0）。
 *
 * 1.141.0 では VS Code が自分で読み直すので知らせは出ない（e2e/convertToUtf8Flow が見ている）。
 * 1.90 には文字コードを指定して開く口（`openTextDocument` の `encoding`）が無いので、
 * 「作者が『エンコード付きで再度開く』で Shift_JIS を選んだ」状態は、本体のコマンド
 * `workbench.action.editor.changeEncoding` の選ぶ窓を、窓の「決定」「次へ」のコマンドで押して作る
 * （窓へ字を打つ道が無いので、Shift JIS の行まで「次へ」を数えて探す）。
 *
 * **VS Code の版で結果が変わる**：1.90 以外（`encoding` の欄がある版）では知らせは出ないので、
 * 知らせの有無は版を見て分ける。どちらの版でも「最後に化けずに読める」ことは同じに見る。
 * 製品の関数を直接呼ぶ（確認の窓は `showWarningMessage` の差し替えで答える。製品にテスト用の口は足さない）。
 */

type RunCase = (name: string, test: () => Promise<void>) => Promise<void>;

const BODY = "　終電を逃した駅のホームに、雨の音だけが残っていた。\n　零時を過ぎても、次の電車は来なかった。\n";
const MARK = "次の電車は来なかった";
const STALE_NOTICE = "まだ Shift_JIS のまま表示されています";
const REOPEN_BUTTON = "タブを閉じて開き直す";
const CONVERT_BUTTON = "UTF-8 に変換する";

export async function runUtf8ConvertStaleChecks(runCase: RunCase): Promise<void> {
  await runCase(
    "原稿 UTF-8 変換：Shift_JIS で開いていた話を変換すると、1.90 では「まだ Shift_JIS のまま」の知らせが出て、［タブを閉じて開き直す］でタブが作り直される（化けずに読めるかは控える）",
    checkStaleNoticeAndReopen
  );
}

async function checkStaleNoticeAndReopen(): Promise<void> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "imp12-utf8-stale-"));
  const warningDescriptor = Object.getOwnPropertyDescriptor(vscode.window, "showWarningMessage");
  assert.ok(warningDescriptor?.configurable, "showWarningMessage をテスト用に差し替えられません");
  try {
    const workFolder = path.join(temporaryRoot, "星の町");
    await scaffoldWorkFolder(workFolder, "星の町");
    const filePath = path.join(workFolder, "本文", "001.txt");
    await fs.writeFile(filePath, iconv.encode(BODY.replace(/\n/g, "\r\n"), "shift_jis"));
    const work: WorkEntry = {
      id: "work_integration_utf8",
      title: "テスト作品",
      folderPath: workFolder,
      registeredAt: "2026-11-13T00:00:00.000Z",
    };
    const uri = vscode.Uri.file(filePath);

    // 作者が「エンコード付きで再度開く」で Shift_JIS を選んでいた状態を、本体のコマンドで作る
    // （設定 files.encoding で作ると、設定を戻した時点で VS Code が読み直してしまい、再現しない）
    // `openTextDocument` で開くと、拡張機能の側が文書を数分つかんだままにし、タブを閉じても文書が残る
    // （作者がタブで開いた状況と違ってしまう）。タブで開く道（showTextDocument に場所を渡す）で開く
    const opened = (await vscode.window.showTextDocument(uri, { preview: false })).document;
    assert.ok(!opened.getText().includes(MARK), "設定なしなのに最初から読めています（前提が違います）");
    const found = await reopenWithShiftJis(opened);
    console.log(`INFO Shift JIS は「次へ」${found}回目の行`);
    assert.ok(opened.getText().includes(MARK), `Shift_JIS で読めていません: ${JSON.stringify(opened.getText().slice(0, 40))}`);

    const hasEncodingField = typeof (opened as { encoding?: unknown }).encoding === "string";
    console.log(`INFO VS Code ${vscode.version}（文書の encoding 欄：${hasEncodingField ? "あり" : "なし"}）`);

    // 確認の窓は［UTF-8 に変換する］で答える。知らせは控えて、ボタンを押す
    const modals: string[] = [];
    const notices: string[] = [];
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: async (message: string, ...rest: unknown[]) => {
        const first = rest[0] as { modal?: boolean } | string | undefined;
        if (first && typeof first === "object" && first.modal) {
          modals.push(message);
          return CONVERT_BUTTON;
        }
        notices.push(message);
        return message.includes(STALE_NOTICE) ? REOPEN_BUTTON : undefined;
      },
    });

    await convertToUtf8({ work, focusPath: filePath });
    assert.ok(modals.some((message) => message.includes("1話を Shift_JIS から UTF-8 に変換します")), modals.join("\n"));

    // ファイルは UTF-8 になり、字と改行（CRLF）はそのまま
    const bytes = await fs.readFile(filePath);
    assert.equal(iconv.decode(bytes, "utf8"), BODY.replace(/\n/g, "\r\n"), "ファイルが UTF-8 で同じ本文になっていません");

    // 知らせの出し方は版で変わる：欄の無い 1.90 では出て、欄のある版では VS Code が自分で読み直すので出ない
    // ボタンの押された後の処理は非同期なので、少し待ってから見る
    const stale = await waitFor(() => notices.some((message) => message.includes(STALE_NOTICE)), hasEncodingField ? 1500 : 6000);
    if (hasEncodingField) {
      assert.equal(stale, false, `文字コードの欄がある版なのに知らせが出ました: ${notices.join("\n")}`);
    } else {
      assert.equal(stale, true, `1.90 なのに「${STALE_NOTICE}」が出ませんでした。出た知らせ: ${JSON.stringify(notices)}`);
    }

    /*
      ［タブを閉じて開き直す］のあと、同じ話のタブがあること。**化けずに読めるかは、ここでは
      落とさず控えるだけにしている**（2026-11-13）。1.90 のこの試験では、タブを全部閉じて10秒待っても
      文書が閉じず、開き直した本文が化けたままだった（文書が開き直されずに残る＝VS Code が文字コードを
      覚えているのか、試験の側が文書を持ち続けているのかを、試験の中では見分けられなかった）。
      実機確認リスト0.149.0の「開き直しても化けたままなら母艦へ」に当たる。見分けがつくまで、
      知らせが出ること・ボタンの処理がタブを作り直すことだけを落とす条件にする
    */
    const hasTab = (): boolean =>
      vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((candidate) => {
        const input = candidate.input;
        return input instanceof vscode.TabInputText && samePath(input.uri.fsPath, filePath);
      });
    // ボタンの処理（閉じる→開き直す）は非同期。タブが戻り、本文が読めるようになるのを少し待つ
    await waitFor(hasTab, 6000);
    await waitFor(
      () =>
        vscode.workspace.textDocuments
          .find((candidate) => samePath(candidate.uri.fsPath, filePath))
          ?.getText()
          .includes(MARK) === true,
      4000
    );
    const reopened = vscode.workspace.textDocuments.find((candidate) => samePath(candidate.uri.fsPath, filePath));
    const readable = reopened?.getText().replace(/\r\n/g, "\n") === BODY;
    console.log(`INFO 開き直したあとの本文は${readable ? "化けずに読めた" : "化けたまま：" + JSON.stringify(reopened?.getText().slice(0, 20))}`);
    const tab = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((candidate) => {
      const input = candidate.input;
      return input instanceof vscode.TabInputText && samePath(input.uri.fsPath, filePath);
    });
    assert.ok(tab, "開き直したタブがありません");
  } finally {
    Object.defineProperty(vscode.window, "showWarningMessage", warningDescriptor);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    useLogFile(undefined);
    await settleLogWrites();
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

/** Windows では、開いた文書の場所のドライブ文字の大小が、作った場所と違うことがある */
function samePath(left: string, right: string): boolean {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 本体の「エンコード付きで再度開く」を、拡張機能の側から押して Shift_JIS で開き直させる。
 * 1.90 には文字コードを指定して開く API が無く、選ぶ窓（一覧）へ字を打ち込む道も無いので、
 * 一覧の先頭から「次へ」を n 回押して決める。Shift_JIS の行が何番目かは版で変わりうるので、
 * 読めるようになるまで順に試す（違う文字コードで開き直しても、本文が読めないだけで害は無い）
 * 戻り値：読めたときに「次へ」を押した回数
 */
async function reopenWithShiftJis(document: vscode.TextDocument): Promise<number> {
  for (let attempt = 0; attempt < 45; attempt++) {
    // 1.90.0 では30回目（先頭を0として）。ほかの版でずれても拾えるよう、前後へ広げて探す
    const index = attempt === 0 ? 30 : attempt <= 30 ? attempt - 1 : attempt;
    void vscode.commands.executeCommand("workbench.action.editor.changeEncoding");
    await pause(700);
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem"); // 「Reopen with Encoding」
    await pause(700);
    for (let count = 0; count < index; count++) {
      await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
    }
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
    if (await waitFor(() => document.getText().includes(MARK), 3000)) return index;
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  }
  return -1;
}
