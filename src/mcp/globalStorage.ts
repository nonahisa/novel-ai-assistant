import nodePath from "node:path";

/**
 * 拡張機能の保管庫（`globalStorageUri`）の場所を、MCP サーバー側から知る。
 *
 * **道は1つだけ。** 助言方針の控え（`adviceProfileMirror.ts`）で選んだ道を
 * ここへ出した——窓の札（`tools/windows.ts`）も同じ保管庫を読むので、
 * 2か所で別々に決めると、片方だけが別の場所を指す日が来る
 * （拡張機能側で `features/globalStoragePath.ts` へ寄せたのと同じ理由）。
 *
 * **どうやって知るか。** このプロセスは VS Code の外に居るので
 * `context.globalStorageUri` を持たない。**走っている束
 * （`dist/mcp-server.mjs`）そのものが保管庫に在る**——拡張機能は版に依らない
 * 場所（`globalStorage/<拡張機能ID>/`）へ束を写してから登録する
 * （設計書6.87.15）。だから**自分の居場所の親フォルダーが、そのまま保管庫**になる。
 *
 * 逃げ道として環境変数（`NOVELAI_GLOBAL_STORAGE`）も見る。束を別の場所へ
 * 写して走らせているとき（開発・試験）に、保管庫を明示できる。
 *
 * `node:path` を静的に import しているのは、**この束が Node 専用**だから
 * である。`core/` へは持ち込まない。
 */

/** 保管庫を明示する環境変数。**指定があればこちらが勝つ** */
export const GLOBAL_STORAGE_ENV = "NOVELAI_GLOBAL_STORAGE";

/**
 * 保管庫の場所。分からなければ `undefined`。
 *
 * **毎回調べ直す。** 走っている間に変わるものではないが、値を抱え込むと
 * 試験が環境変数を差し替えられない（`staleness.ts` が `process.argv` を
 * 引数で受けているのと同じ理由）。
 */
export function mcpGlobalStorageRoot(): string | undefined {
  const explicit = process.env[GLOBAL_STORAGE_ENV];
  if (explicit && explicit.trim()) return nodePath.resolve(explicit.trim());

  // 束の居場所＝保管庫（上の断り書き）。読めなければ諦める
  const bundle = process.argv[1];
  if (!bundle) return undefined;
  return nodePath.dirname(nodePath.resolve(bundle));
}
