/**
 * 画面の自動テストの走りの最初と最後（vitest の globalSetup。設計書6.113）。
 *
 * **最初**：前の走りが途中で止められて残したテスト用 VS Code と一時フォルダーを片づける。
 * **最後**：時間切れ・失敗で1件ごとの片づけが届かなかったものを片づける。
 * どちらも `cleanup.ts` の台帳に載ったものだけを相手にする。
 *
 * 片づける前に、この走りを台帳の持ち主として名乗る——同じ作業場で同時に
 * 走っているほかの走りの VS Code を止めないため（`cleanup.ts` の sweepLaunches）。
 *
 * **`vscode://` の受け手も最初に控えて最後に戻す**（2026-10-17）。試験用の VS Code は
 * 起動するたびに自分を受け手として登録し、終わっても戻さない。作者の機械で外部AIの
 * 依頼が試験版の窓へ届き、確認の窓が作者に見えなかった。1件ごとではなく走り全体で
 * 1回にする（件ごとに起こすので、件ごとに戻しても次の件でまた書き換わるだけ）。
 */
import { restoreProtocolHandler, snapshotProtocolHandler } from "../../../scripts/protocolHandlerGuard.mjs";
import { claimRunOwnership, sweepLaunches } from "./cleanup";

export default async function setup(): Promise<() => Promise<void>> {
  claimRunOwnership();
  const protocolSnapshot = snapshotProtocolHandler();
  await sweepLaunches();
  return async () => {
    try {
      await sweepLaunches();
    } finally {
      // VS Code を止めてから戻す（動いている試験版が書き直さないように）
      restoreProtocolHandler(protocolSnapshot);
    }
  };
}
