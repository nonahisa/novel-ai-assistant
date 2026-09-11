import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
} from "../core/manuscriptViewTypes";
import { SUPPORTED_EXTENSIONS } from "../models/types";

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
