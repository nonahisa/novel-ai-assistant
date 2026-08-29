/**
 * 子プロセスへ渡す環境変数を整える。
 *
 * **このファイルは純粋にする**（`node:` を import しない）。
 * `ollamaLauncher.ts` と `lmstudioLauncher.ts` の両方から使うが、
 * 片方に置くともう片方から import することになり、
 * lmstudio →（`resolveExecutable`）→ ollama → lmstudio の循環になる。
 */

/**
 * 子へ継がせてはいけない、拡張機能ホストの環境変数。
 *
 * VS Codeの拡張機能ホストは Electron を素のNodeとして動かすため
 * **`ELECTRON_RUN_AS_NODE=1` を持っている。** 拡張機能が起こした `lms` は
 * これを継ぎ、`lms` が起こす LM Studio 本体（Electron製のデーモン）も継ぐ。
 * Electron はこの変数があると**素のNodeとして起動して即終了する**ので、
 * `lms server start` は「Timed out waiting for LM Studio daemon to start.」
 * で60秒かけて失敗する（作者の報告「自動起動しませんでした」の原因。
 * 実機で確認、2026-08-30）。**外すと本体は7.3秒で上がった。**
 *
 * 統合テストが「bad option」で落ちるのと同じ根である。Ollamaは Electron
 * ではないので今は害が無いが、**同じ穴を2か所に残さない**ため両方で落とす。
 */
const DROPPED_KEYS: readonly string[] = ["ELECTRON_RUN_AS_NODE"];

/**
 * 上の変数を落とした環境変数の写しを返す。
 *
 * **元は変えない。** `delete process.env.X` にすると拡張機能ホスト自身の
 * 環境を書き換えることになり、VS Code の内部処理やほかの拡張機能へ影響が
 * 及ぶ。落とした写しを作って、子にだけ渡す。
 */
export function childProcessEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const copied: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (DROPPED_KEYS.includes(key)) continue;
    copied[key] = value;
  }
  return copied;
}
