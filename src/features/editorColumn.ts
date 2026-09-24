import * as vscode from "vscode";
import * as paths from "../core/paths";

/**
 * 本文を「どの列」へ開くかを決める（作者の報告、2026-09-19）。
 *
 * 「該当場所へのリンクをクリックすると、左の画面ではなく右の画面が動きます」
 * ——飛び先の処理が列を指定していなかったため、VS Code の既定どおり
 * **いま前面の列**へ原稿が開いていた。下段の提案パネル（`WebviewView`）は
 * 編集の列を占めないので、前面の列＝原稿の列で**たまたま**正しかった。
 * シーンメモのパネルは `ViewColumn.Beside`（原稿の右）に住むため、そこから
 * 押すと原稿がパネルの列へ飛び込み、書いていた面が置き去りになる。
 *
 * **判断をここ1つに集める。** 素のエディタ（`revealLocation.ts`）と原稿
 * エディタ（`manuscriptEditor.ts`）で別々に決めると、片方だけが直る日が来る。
 */

/**
 * **広く見る画面**（執筆統計・年表・相関図など）を開く列（作者の裁定、2026-09-23）。
 *
 * 「前面の列」（`ViewColumn.Active`）に開くと、提案パネルやシーンメモの
 * 細い右の列が前面のときにそこへ開き、表やグラフが詰まった（ノートPCの実機で
 * 執筆統計がそうなった）。作者「真ん中ですね」。
 *
 * **本文の列へ開く**：見えている本文のうちいちばん左の列、本文が無ければ1列目。
 * 1列目に決め打ちしないのは、本文を2列目に置いている人がいるため（下の
 * `columnForLocation` と同じ考え）。右の列のパネル（提案・シーンメモ）は
 * `ViewColumn.Beside` のまま、この関数を使わない。
 */
export function wideViewColumn(): vscode.ViewColumn {
  const columns = vscode.window.visibleTextEditors
    .map((editor) => editor.viewColumn)
    .filter((column): column is vscode.ViewColumn => column !== undefined && column > 0);
  return columns.length > 0 ? Math.min(...columns) : vscode.ViewColumn.One;
}

/** 列を決めた結果。**理由まで返す**——降りた枝を呼び出し側が1行残せるように */
export interface ColumnChoice {
  /** 開く列。`undefined` は「決めない」＝これまでどおり VS Code に任せる */
  column?: vscode.ViewColumn;
  /** 記録に残す一言 */
  reason: string;
}

/**
 * その場所を開くべき列。
 *
 * 1. **既にそのファイルが開いている列があれば、そこ**（作者が置いた場所を
 *    動かさない。2列目に原稿を置いている人がいるので `ViewColumn.One` の
 *    決め打ちはしない）
 * 2. 開いていなくて、**前面がパネル（WebView のタブ）なら、その列を避ける**
 * 3. 避ける先が無ければ、パネルの横へ新しく開く（パネルの上に重ねない）
 * 4. 前面が本文・原稿のタブなら **決めない**——下段の提案パネルから飛ぶ道は
 *    これまでどおり「前面の列」で正しい
 */
export function columnForLocation(location: string): ColumnChoice {
  let groups: readonly vscode.TabGroup[];
  try {
    groups = vscode.window.tabGroups.all;
  } catch {
    // タブの種類を読めない環境（古いVS Code・試験の代役）。
    // **列を決められないことを理由に、飛べなくしない**
    return { reason: "列は指定なし（タブを読めない環境）" };
  }
  if (groups.length === 0) return { reason: "列は指定なし（タブが無い）" };

  // タブの場所は `fromUri` 由来（ブラウザ版では符号化された形）なので、
  // 符号を解いて比べる鍵（`pathKeyForComparison`）にそろえる
  const wanted = paths.pathKeyForComparison(location);
  for (const group of groups) {
    for (const tab of group.tabs) {
      const uri = tabUri(tab);
      if (!uri) continue;
      if (paths.pathKeyForComparison(paths.fromUri(uri)) === wanted) {
        return {
          column: group.viewColumn,
          reason: `既に開いている列（${group.viewColumn}）へ`,
        };
      }
    }
  }

  const active = groups.find((group) => group.isActive);
  if (!active || !isPanelGroup(active)) {
    return { reason: "列は指定なし（前面が編集の面）" };
  }

  /*
    **原稿の面がある列を先に選ぶ。** 「前面でない列」というだけで選ぶと、
    設定資料や出力タブしか無い列へ本文を押し込むことがある。
  */
  const elsewhere =
    groups.find((group) => group !== active && group.tabs.some(isEditorTab)) ??
    groups.find((group) => group !== active);
  if (elsewhere) {
    return {
      column: elsewhere.viewColumn,
      reason: `パネルの列（${active.viewColumn}）を避けて${elsewhere.viewColumn}列目へ`,
    };
  }

  return {
    column: vscode.ViewColumn.Beside,
    reason: "ほかに列が無いので、パネルの横の列へ",
  };
}

/**
 * その種類の画面（`createWebviewPanel` の viewType）が開いている列。
 * 無ければ undefined（2026-09-23）。
 *
 * 提案パネルを、シーンメモが開いている列へ重ねるのに使う——右の列を
 * 基準にするという作者の指示で、`ViewColumn.Beside` だけだと、前面が
 * シーンメモのときに、さらに右へ列が増える。
 *
 * **VS Code はタブの viewType に内部の接頭辞を付ける**
 * （`mainThreadWebview-novelai.sceneMemos` のように）ので、末尾で比べる。
 */
export function columnOfWebviewPanel(viewType: string): vscode.ViewColumn | undefined {
  let groups: readonly vscode.TabGroup[];
  try {
    groups = vscode.window.tabGroups.all;
  } catch {
    return undefined;
  }
  for (const group of groups) {
    for (const tab of group.tabs) {
      try {
        const input: unknown = tab.input;
        if (
          input instanceof vscode.TabInputWebview &&
          (input.viewType === viewType || input.viewType.endsWith(`-${viewType}`))
        ) {
          return group.viewColumn;
        }
      } catch {
        // 種類を読めない環境では「見つからない」と同じ扱いにする
      }
    }
  }
  return undefined;
}

/** そのタブが指しているファイル。指していなければ undefined */
function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input: unknown = tab.input;
  try {
    if (input instanceof vscode.TabInputText) return input.uri;
    if (input instanceof vscode.TabInputCustom) return input.uri;
    if (input instanceof vscode.TabInputNotebook) return input.uri;
  } catch {
    // 種類を読めない環境では「ファイルを指していない」と同じ扱いにする
    return undefined;
  }
  return undefined;
}

/** そのタブが、本文を編集している面か（原稿エディタは `TabInputCustom`） */
function isEditorTab(tab: vscode.Tab): boolean {
  return tabUri(tab) !== undefined;
}

/**
 * その列の前面がパネル（WebView）か。
 *
 * **原稿エディタは `TabInputCustom` であって `TabInputWebview` ではない。**
 * ここを取り違えると、原稿の面を「パネル」と見て避けてしまい、飛び先が
 * 原稿から離れる。
 */
function isPanelGroup(group: vscode.TabGroup): boolean {
  const input: unknown = group.activeTab?.input;
  try {
    return input instanceof vscode.TabInputWebview;
  } catch {
    return false;
  }
}
