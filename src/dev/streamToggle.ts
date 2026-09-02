import * as vscode from "vscode";
import { setStreamingOverride, streamingEnabled } from "../ai/ollamaStream";

/**
 * Ollamaのストリーミング受信（設計書6.63.1）を、押して切り替える道具。
 *
 * **配布物には入らない。** `esbuild.js` が本番ビルドで `__DEV_HELPERS__` を
 * `false` に畳むので、このファイルは束に入らない（`npm run verify:vsix` が見張る）。
 *
 * ## なぜ要るのか
 *
 * これまで実験を有効にする道は環境変数 `NOVELAI_OLLAMA_STREAM=1` だけで、
 * `.vscode/launch.json` を書き換えてF5を掛け直さないと試せなかった。
 * **試すまでが遠すぎる**（作者の指摘、2026-09-03）。流す道と、まとめて受け取る道を
 * 同じ材料で比べたいのに、比べるたびに拡張機能開発ホストを開き直すことになる。
 *
 * ## 押した分は保存しない
 *
 * 切り替えはウィンドウを閉じるまでで、設定にも `globalState` にも残さない。
 * **実験の旗が残ると、実験したことを忘れた頃に「本番の道と挙動が違う」と
 * 悩むことになる。** 開き直せば必ず既定（＝配布と同じ道）へ戻るのが、
 * 実験の後始末として確実である。
 *
 * ## 効いているかは、ログで見る
 *
 * 流して受け取ったときだけ、ログに「Ollama：流して受信（…）」が出る
 * （`ollamaProvider.ts`）。切り替えの通知でそこを案内するのは、
 * **押しただけでは何も見えない**ためである。
 */

export function registerStreamToggle(
  _context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "novelai.dev.toggleOllamaStream",
    () => {
      const next = !streamingEnabled();
      setStreamingOverride(next);
      void vscode.window.showInformationMessage(describeState(next));
    }
  );
}

/**
 * 切り替えたあとの状態を伝える文。
 *
 * **記号を使わない。** 通知はプレーンテキストなので、強調に使った `*` が
 * そのまま画面へ出る（`test/unit/plainTextUi.test.ts` が見張っている）。
 */
function describeState(enabled: boolean): string {
  if (!enabled) {
    return (
      "Ollamaのストリーミング受信：切。" +
      "まとめて1回で受け取る、配布と同じ道に戻りました。"
    );
  }
  return (
    "Ollamaのストリーミング受信：入（このウィンドウの間だけ）。" +
    "ログに「流して受信」が出れば効いています。"
  );
}
