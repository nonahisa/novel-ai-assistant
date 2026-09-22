import type * as vscode from "vscode";
import { storageRootFrom } from "../core/paths";

/**
 * 保管庫（`globalStorageUri`）の場所を、持ち回る文字列にする。
 *
 * **`vscode-userdata:` は手元だけ OS のパスへ倒す。** 判定そのものは
 * `core/paths.ts` の `storageRootFrom` にある（手元とブラウザで扱いが
 * 逆になる理由もそちら）。
 *
 * **写しを作らない。** ここを読むところが2つになった時点で
 * （MCP の束の写しと、助言方針の控え）1か所へ出した——片方だけ直ると、
 * 同じ保管庫を指しているはずの2つが別の場所を指す。
 */
export function globalStorageRoot(context: vscode.ExtensionContext): string {
  return storageRootFrom(context.globalStorageUri);
}
