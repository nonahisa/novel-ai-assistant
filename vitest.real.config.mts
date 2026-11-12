import { defineConfig } from "vitest/config";

/**
 * 本物の AivisSpeech へ向けた画面の自動テスト（`npm run test:e2e:real`）。
 *
 * **検査ではないので `npm run check`・CI・配布の検査にも、`test:e2e` の全件にも入れない。**
 * 本物の音声エンジンが要り、1件が数分〜30分かかる。名前を `*.real.ts` にして、
 * E2E の設定（`test/e2e/**\/*.test.ts`）に拾われないようにしてある（`manual:shots` の `*.shots.ts` と同じ分け方）。
 * 環境変数 `NOVELAI_REAL_AIVIS=1` が無ければ、中の試験は飛ばされる。
 * 土台と片づけは E2E と同じもの（`test/e2e/support/`）を使う。
 */
export default defineConfig({
  test: {
    include: ["test/e2e/real/**/*.real.ts"],
    environment: "node",
    // 残ったテスト用 VS Code と一時フォルダーを、走りの最初と最後に片づける（E2E と同じ）
    globalSetup: ["test/e2e/support/globalSetup.ts"],
    fileParallelism: false,
    // 声づくりは CPU で長い（書き出しが約32分）。各件の上限は件ごとに指定する
    testTimeout: 50 * 60_000,
    hookTimeout: 120_000,
  },
});
