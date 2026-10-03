/**
 * 画面の自動テストの走りの最初と最後（vitest の globalSetup。設計書6.113）。
 *
 * **最初**：前の走りが途中で止められて残したテスト用 VS Code と一時フォルダーを片づける。
 * **最後**：時間切れ・失敗で1件ごとの片づけが届かなかったものを片づける。
 * どちらも `cleanup.ts` の台帳に載ったものだけを相手にする。
 *
 * 片づける前に、この走りを台帳の持ち主として名乗る——同じ作業場で同時に
 * 走っているほかの走りの VS Code を止めないため（`cleanup.ts` の sweepLaunches）。
 */
import { claimRunOwnership, sweepLaunches } from "./cleanup";

export default async function setup(): Promise<() => Promise<void>> {
  claimRunOwnership();
  await sweepLaunches();
  return async () => {
    await sweepLaunches();
  };
}
