import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
} from "../core/manuscriptViewTypes";
import { SUPPORTED_EXTENSIONS } from "../models/types";
import { logLine } from "../core/logger";
// ログの書き先：呼ぶ側が向ける（原稿を開く共通の口は作品を受け取らない。
// 前に出したことの1行だけで、向いていなければ出力パネルにだけ残る）

/**
 * 「いま作者が見ている本文」を、タブの側から見つける（設計書6.25.4）。
 *
 * **`vscode.window.activeTextEditor` だけでは足りない。** 本文を開く画面は
 * 素のエディタだけではなく、この拡張機能の原稿エディタ（WebView）や、
 * VS Code 1.131 の新しいMarkdown編集画面（hybrid Markdown editor）でも開く。
 * どちらも `TextEditor` を持たないので `activeTextEditor` は undefined になり、
 * そこだけを見ているコマンドは、本文を開いている作者に
 * 「本文のファイルを開いてから実行してください」と言い返していた
 * （実機、2026-09-12。「縦書きで開く」がhybridの画面から使えなかった）。
 *
 * ここは**タブの中身だけ**を見るので、`features` からも `extension.ts` からも
 * 同じ答えを引ける。判定と文言をこの1か所に置いてあるのは、同じ形のコマンドを
 * 足すたびに写しが増えて、直し漏れた側だけが使えなくなるのを防ぐためである。
 */

/** いまアクティブなタブが、カスタムエディタで開いている本文なら、その中身 */
interface ActiveCustomManuscript {
  uri: vscode.Uri;
  /** この拡張機能の原稿エディタで開いているか（hybridなど他の画面なら false） */
  ours: boolean;
}

/** その場所は本文（`.txt` / `.md`）か */
function isManuscriptFile(uri: vscode.Uri): boolean {
  const extension = path.extname(fromUri(uri)).toLowerCase();
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * いまアクティブなタブが、カスタムエディタで開いている本文かを見る。
 *
 * **VS Code 側の viewType の名前を決め打ちしない。** hybrid Markdown editor の
 * IDは VS Code の都合で変わりうるので、当てにすると次の更新で黙って効かなくなる。
 * ここで確かめるのは「本文のファイルを、カスタムエディタで開いている」ことだけで、
 * この拡張機能の原稿エディタかどうかは `ours` で区別する。
 *
 * 読めない環境（古いVS Code・試験の代役）では undefined を返し、
 * 呼び出し側はこれまでどおり `activeTextEditor` の道へ落ちる。
 */
function activeCustomManuscriptTab(): ActiveCustomManuscript | undefined {
  try {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input: unknown = tab?.input;
    if (!(input instanceof vscode.TabInputCustom)) return undefined;
    if (
      input.viewType === MANUSCRIPT_EDITOR_VIEW_TYPE ||
      input.viewType === MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
    ) {
      return { uri: input.uri, ours: true };
    }
    return isManuscriptFile(input.uri)
      ? { uri: input.uri, ours: false }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * いまアクティブなタブが本文を開いているなら、その場所。
 *
 * **原稿エディタでも、VS Code のMarkdown編集画面でも同じ答えを返す。**
 * 場所さえ分かれば自前の画面で開き直せるので、ここで断る理由が無い
 * （「縦書きで開く」「横書きで開く」「組んで書く」は、開き直すだけの操作）。
 */
export function activeManuscriptTabUri(): vscode.Uri | undefined {
  return activeCustomManuscriptTab()?.uri;
}

/**
 * いまアクティブなタブが、この拡張機能以外のカスタムエディタで本文を開いているなら、
 * その場所（hybrid Markdown editor がこれに当たる）。
 *
 * **本文を書き換える操作は、ここから先へ進めない。** ルビ・傍点は
 * `editor.edit`（作者自身の編集操作なのでCtrl+Zが効く）で本文へ書き込むが、
 * hybridの画面は `TextEditor` を持たないので、そもそも編集の当て先が無い。
 * ファイルへ直接書けば、画面が抱えている未保存の内容と食い違う。
 */
export function activeForeignManuscriptTabUri(): vscode.Uri | undefined {
  const active = activeCustomManuscriptTab();
  return active && !active.ours ? active.uri : undefined;
}

/**
 * 「本文が見つからない」ときに出す文言。
 *
 * **状況で分ける。** 何も開いていないのと、開いてはいるがこの操作では
 * 扱えないのとでは、作者が次に取る行動が違う。後者に「本文を開いてから」と
 * 言うと、開いている本人には打つ手が無くなる（実機、2026-09-12）。
 */
export function manuscriptNotOpenMessage(): string {
  if (activeForeignManuscriptTabUri()) {
    return (
      "開いているのは VS Code の Markdown 画面です。" +
      "作品一覧から開き直すと、この操作が使えます。"
    );
  }
  return "本文のファイルを開いてから実行してください。";
}

/** 上の文言を警告として出す。**写しを作らず、必ずここを通す** */
export function warnManuscriptNotOpen(): void {
  void vscode.window.showWarningMessage(manuscriptNotOpenMessage());
}

/**
 * 原稿エディターの台帳の鍵（作者の報告、2026-08-29「誤字脱字パネルから本文に飛びません」）。
 *
 * **登録・削除・照会を、この1本に通す。** 以前は登録側が
 * `document.uri.toString()`、照会側が `paths.toUri(filePath).toString()` で
 * 別々に組み立てていた。同じファイルでも、Windowsのドライブ文字の大小
 * （`c:` と `C:`）や、日本語を含む道の百分率符号化の仕方が経路によって
 * 違えば、文字列は一致しない。**開いているのに「開いていない」と判定され、
 * 押しても何も起きない**という終わり方になる。
 *
 * 比べ方は、この作品がほかの場所で使っているもの（`samePath`）と揃える。
 * 原稿を開く共通の口（下の `openManuscriptFile`）もタブをこの鍵で探すので、
 * `manuscriptEditor.ts` からここへ移した（向こうは再輸出している）。
 */
export function manuscriptLedgerKey(location: string | vscode.Uri): string {
  const filePath = typeof location === "string" ? location : fromUri(location);
  return path.pathKeyForComparison(filePath);
}

/**
 * その原稿の、原稿エディターのタブ（あれば入口と列）。
 *
 * 同じ原稿のタブが2つあれば、**その列で前に出ているもの**を選ぶ
 * （作者がいま見ている面）。どれも背景なら、最初に見つかったもの。
 * タブを読めない環境では undefined（これまでどおりの開き方へ）。
 */
export function existingManuscriptTab(
  key: string
): { viewType: string; column: vscode.ViewColumn } | undefined {
  try {
    let fallback: { viewType: string; column: vscode.ViewColumn } | undefined;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input: unknown = tab.input;
        if (
          !(input instanceof vscode.TabInputCustom) ||
          (input.viewType !== MANUSCRIPT_EDITOR_VIEW_TYPE &&
            input.viewType !== MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE) ||
          manuscriptLedgerKey(input.uri) !== key
        ) {
          continue;
        }
        const found = { viewType: input.viewType, column: group.viewColumn };
        if (tab.isActive) return found;
        fallback ??= found;
      }
    }
    return fallback;
  } catch {
    return undefined;
  }
}

/**
 * 原稿を原稿エディターで開く。**原稿を開く道はすべてここを通す**
 * （作者の裁定、2026-10-03「直す」。設計書6.25.11）。
 *
 * **同じ原稿のタブが既にあれば、そのタブの入口と列で開く**（＝前に出すだけ）。
 * VS Code は、別の入口（縦と横）や別の列へ `openWith` すると、同じ原稿の
 * **2枚目の面**を作る（`supportsMultipleEditorsPerDocument: false` でも
 * 止まらない。1.138.0 で確かめた）。同じ入口・同じ列なら前に出すだけで済む。
 * 2枚の面が同じ文書を抱えると、片方で打った字がもう片方へ送られ、
 * 打ちかけが入れ替わる危なさがある（規則1）。
 *
 * タブが無い（・読めない）ときは、頼まれた入口と列で開く（これまでどおり）。
 *
 * **作者が意図して入口を替える操作はここを通さない**——VS Code の
 * 「エディターを再度開く」は VS Code 自身が開き、打った字が入らない画面の
 * 開き直し（`reopenForRescue`）は同じタブを閉じてから開く。
 *
 * @param viewType タブが無いときの入口（作品の種類で決まる既定など）
 * @param column タブが無いときの列（`ViewColumn` か、`viewColumn` を持つ指定）
 * @returns 実際に使った入口と、既存のタブを前に出したか
 */
export async function openManuscriptFile(
  location: string | vscode.Uri,
  viewType: string,
  column?: vscode.ViewColumn | vscode.TextDocumentShowOptions
): Promise<{ viewType: string; reused: boolean }> {
  const uri = typeof location === "string" ? path.toUri(location) : location;
  const existing = existingManuscriptTab(manuscriptLedgerKey(location));
  if (existing) {
    // 前に出すだけで済ませる。入口か列が違うと2枚目になる
    logLine(
      `原稿エディタ：${fromUri(uri)} のタブが${existing.column}列目にあるので、そのタブを前に出します（入口: ${existing.viewType}）。`
    );
    await vscode.commands.executeCommand(
      "vscode.openWith",
      uri,
      existing.viewType,
      existing.column
    );
    return { viewType: existing.viewType, reused: true };
  }
  await vscode.commands.executeCommand("vscode.openWith", uri, viewType, column);
  return { viewType, reused: false };
}
