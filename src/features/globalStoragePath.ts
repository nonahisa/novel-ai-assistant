import type * as vscode from "vscode";
import { fromUri } from "../core/paths";

/**
 * 保管庫（`globalStorageUri`）の場所を、持ち回る文字列にする。
 *
 * **`vscode-userdata:` は手元に実体があるので OS のパスへ倒す**
 * （`core/modelTuningStore.ts`・`views/openDocument.ts` と同じ。拡張機能
 * 開発ホストではこの仕組みで渡ってくる）。`fromUri` の一般規則に任せると
 * `C:\vscode-userdata:\…` という無い場所を指す。
 *
 * **写しを作らない。** ここを読むところが2つになった時点で
 * （MCP の束の写しと、助言方針の控え）1か所へ出した——片方だけ直ると、
 * 同じ保管庫を指しているはずの2つが別の場所を指す。
 */
export function globalStorageRoot(context: vscode.ExtensionContext): string {
  const uri = context.globalStorageUri;
  return uri.scheme === "vscode-userdata" ? uri.fsPath : fromUri(uri);
}
