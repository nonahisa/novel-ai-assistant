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
 * 2. 開いていなければ、**パネルの列を避けて、避けない列を名指しする**。
 *    避けるのは「前に出ているタブがパネル（WebView）の列」と「提案・シーンメモの
 *    パネルがいて、編集の面を1つも持たない列」。どの列が前面かでは決めない（下記）
 * 3. 避ける先が無ければ、パネルの横へ新しく開く（パネルの上に重ねない）
 * 4. 避ける列が1つも無ければ **決めない**——下段の提案パネルから飛ぶ道は
 *    これまでどおり「前面の列」で正しい
 *
 * **前面の列（`isActive`）を根拠にしない**（ノートPC・1.141.0 の E2E、2026-10-11）。
 * 以前は「前面の列がパネルなら避ける」だったが、拡張機能から見た前面の列が
 * 原稿の列のままのことがあり、そのとき「決めない」を返して、VS Code は実際に
 * 前面にある提案パネルの列へ話を開いた（パネルが裏へ回り、続けて指摘を押せない）。
 * 焦点の動きのタイミングで揺れるので、単独では通り全件でだけ落ちた。
 * 列ごとの前に出ているタブは焦点に左右されないので、そちらで決める。
 * 前面の列は、避けない列が複数あるときの好みの順にだけ使う。
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

  const avoided = groups.filter(isPanelColumn);
  if (avoided.length === 0) {
    return { reason: "列は指定なし（パネルの列が無い）" };
  }
  const avoidedText = avoided.map((group) => group.viewColumn).join("・");

  /*
    **原稿の面がある列を先に選ぶ。** 「パネルでない列」というだけで選ぶと、
    設定資料や出力タブしか無い列へ本文を押し込むことがある。
    候補が複数なら前面の列を好み、無ければ左の列（作者が本文を置く側）。
  */
  const open = groups.filter((group) => !avoided.includes(group));
  const pick = (candidates: readonly vscode.TabGroup[]) =>
    candidates.find((group) => group.isActive) ??
    [...candidates].sort((a, b) => a.viewColumn - b.viewColumn)[0];
  const elsewhere =
    pick(open.filter((group) => group.tabs.some(isEditorTab))) ?? pick(open);
  if (elsewhere) {
    return {
      column: elsewhere.viewColumn,
      reason: `パネルの列（${avoidedText}）を避けて${elsewhere.viewColumn}列目へ`,
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
 * 右の列に住むパネル（提案・シーンメモ）の viewType。
 *
 * **`proposalPanel.ts`・`sceneMemoPanel.ts` から import しない。** 2つとも
 * このファイルを import しているので、輪になる。名前を変えたら
 * `editorColumnForLocation.test.ts` と一緒にここも直す。
 */
const SIDE_PANEL_TYPES = ["novelai.proposals", "novelai.sceneMemos"];

/**
 * 本文を開くときに避ける列か。
 *
 * - 前に出ているタブがパネル（WebView）の列——開くとパネルが裏へ回る
 * - 提案・シーンメモのパネルがいて、編集の面を1つも持たない列——パネルが裏に
 *   回っていても、その列は本文の置き場ではない。**編集の面がある列は避けない**
 *   （原稿の列の裏にパネルを置いている人の本文を、主の列から追い出さない）
 */
function isPanelColumn(group: vscode.TabGroup): boolean {
  if (isPanelGroup(group)) return true;
  return !group.tabs.some(isEditorTab) && group.tabs.some(isSidePanelTab);
}

function isSidePanelTab(tab: vscode.Tab): boolean {
  try {
    const input: unknown = tab.input;
    return (
      input instanceof vscode.TabInputWebview &&
      SIDE_PANEL_TYPES.some(
        (type) => input.viewType === type || input.viewType.endsWith(`-${type}`)
      )
    );
  } catch {
    return false;
  }
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
