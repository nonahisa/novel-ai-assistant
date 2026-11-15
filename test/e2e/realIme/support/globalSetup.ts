/**
 * 本物の IME の試し（`npm run test:realime`）の、走りの最初と最後。
 *
 * 画面の自動テストの片づけ（`test/e2e/support/globalSetup.ts`。残ったテスト用 VS Code と一時フォルダー・
 * 自動の git pull の止め・`vscode://` の受け手の控え）をそのまま使い、そのうえで**作者の IME の状態を戻す**。
 *
 * 1件ごとの試しは、落ちても finally で `試しの前後.ps1 -After` を呼ぶ。それでも、時間切れや途中で
 * 止めたときは finally が届かず、控えが残る。残った控えは作者の本当の状態なので、
 * **最初に**それを `-After` で戻してから流し、**最後にも**もう一度戻す（控えが無ければ何もしない）。
 * 門（`NOVELAI_REAL_IME=1`）が閉じているときは、IME の側の台本を一切呼ばない。
 */
import e2eSetup from "../../support/globalSetup";
import { missingScripts, REAL_IME_ENABLED, trialAfter } from "./imeScripts";

async function restoreLeftover(when: string): Promise<void> {
  if (!REAL_IME_ENABLED || missingScripts()) return;
  try {
    if (await trialAfter(true)) console.error(`[本物のIME] 走りの${when}に、残っていた控えから作者の IME の状態を戻しました`);
  } catch (error) {
    // 戻しの失敗は隠さない（作者の IME の状態が試しのままのおそれ）。走りは止めず、文を残す
    console.error(`[本物のIME] 走りの${when}の戻しが通りませんでした：${String(error)}`);
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const teardown = await e2eSetup();
  await restoreLeftover("最初");
  return async () => {
    try {
      // 先にテスト用 VS Code を止める（動いている窓が IME の状態を書き直さないように）
      await teardown();
    } finally {
      await restoreLeftover("最後");
    }
  };
}
