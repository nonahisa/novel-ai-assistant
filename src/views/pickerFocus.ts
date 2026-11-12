import * as vscode from "vscode";
import { logStep } from "../core/logger";

/**
 * 上部の選ぶ窓（確認）が出ている間に、WebView が焦点を取り返したら、窓へ戻す。
 *
 * **VS Code 本体の焦点の戻し方と、窓が続けて出る流れが重なると起きる**（2026-11-13、
 * ノートPCの画面の自動テストで見つけた）。1つ目の窓（範囲の窓など）が閉じると、本体は
 * 焦点を元のエディターへ戻す。WebView へは **50ms 遅らせてから「focus」の便を中へ送る**
 * （本体の `_focusDelayer`。遅らせた時点で別の入力欄に焦点があれば送らない）。便を送った
 * あと、WebView がそれを処理するまでの間に2つ目の窓（実行の確認）が出ると、**窓が出たあとに
 * WebView が焦点を取る。** 確認の窓は外をクリックしても閉じない（`ignoreFocusOut`）ので、
 * 窓は出たまま、Enter も矢印も WebView の中へ行き、作者が Enter を押しても走らない。
 * 遅い機械（ノートPC）の縦書きの原稿で、組み直しが WebView を塞いでいる間に起きた。
 *
 * **作者が自分で移した焦点は戻さない。** WebView は、押して（ポインターで）焦点を受けた
 * ときは知らせない（`manuscriptEditorHtml.ts` の `focusWithoutPointer`）。時間で分けないのは、
 * 遅い機械ほど間合いが延びて外れるため。キー（Ctrl+1 など）で原稿へ移した焦点は見分けが
 * 付かないので、**1つの窓につき1回だけ**戻す——2回目に移したら、そのまま原稿に置く。
 */

/** いま出ている窓の数（窓の中から別の窓を出すことはないが、数で持てば入れ子でも崩れない） */
let openPickers = 0;
/** いま出ている窓で、もう焦点を戻したか */
let reclaimedForThisPicker = false;

/** 窓を出している間、WebView からの知らせで焦点を戻せるようにする */
export async function whilePickerOpen<T>(show: () => Thenable<T>): Promise<T> {
  openPickers++;
  reclaimedForThisPicker = false;
  try {
    return await show();
  } finally {
    openPickers--;
  }
}

/**
 * WebView が、作者が押さずに焦点を受けたと知らせてきた。窓が出ていれば窓へ戻す。
 * `from` は記録に出す WebView の名前（「原稿エディター」など）
 */
export function reclaimPickerFocus(from: string): void {
  if (openPickers === 0 || reclaimedForThisPicker) return;
  reclaimedForThisPicker = true;
  logStep(`確認の窓が出ている間に${from}が焦点を取ったので、窓へ戻しました`);
  // 本体のコマンド（Quick Input に焦点を当てる）。1.90 にもある。
  // 無い版・効かない場面でも、窓はクリックで選べるので記録だけ残して続ける
  void Promise.resolve(vscode.commands.executeCommand("workbench.action.focusQuickOpen")).catch((error: unknown) => {
    logStep(`確認の窓へ焦点を戻せませんでした: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** 試験用：状態を初めに戻す */
export function resetPickerFocusForTest(): void {
  openPickers = 0;
  reclaimedForThisPicker = false;
}
