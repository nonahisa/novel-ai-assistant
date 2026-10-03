import { defineConfig } from "vitest/config";

/**
 * 広報の動画を撮る台本（`npm run promo:record`、設計書6.114）。
 *
 * **検査ではないので `npm run check` にも `test:e2e` にも入れない。** 名前を
 * `*.promo.ts` にして、E2E の設定（`test/e2e/**\/*.test.ts`）に拾われないようにしてある。
 * 土台と片づけは E2E と同じもの（`test/e2e/support/`）を使う。
 */
export default defineConfig({
  test: {
    include: ["test/e2e/promo/**/*.promo.ts"],
    environment: "node",
    // 残ったテスト用 VS Code と一時フォルダーを、走りの最初と最後に片づける（E2E と同じ）
    globalSetup: ["test/e2e/support/globalSetup.ts"],
    fileParallelism: false,
    // 起動＋撮影＋ffmpeg の変換
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
