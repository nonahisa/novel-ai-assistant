import { defineConfig } from "vitest/config";

/**
 * 手順書に載せる画面ショットを撮る台本（`npm run manual:shots`）。
 *
 * **検査ではないので `npm run check` にも `test:e2e` にも入れない。** 名前を
 * `*.shots.ts` にして、E2E の設定（`test/e2e/**\/*.test.ts`）に拾われないようにしてある。
 * 土台と片づけは E2E・広報の動画と同じもの（`test/e2e/support/`）を使う。
 */
export default defineConfig({
  test: {
    include: ["test/e2e/manual/**/*.shots.ts"],
    environment: "node",
    // 残ったテスト用 VS Code と一時フォルダーを、走りの最初と最後に片づける（E2E と同じ）
    globalSetup: ["test/e2e/support/globalSetup.ts"],
    fileParallelism: false,
    // 起動＋10場面ぶんの操作と撮影
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
