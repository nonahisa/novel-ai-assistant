import { defineConfig } from "vitest/config";

/**
 * 画面の自動テスト（E2E。`npm run test:e2e`、設計書6.113）。
 *
 * **`npm run check` には入れない。** 1件ごとに本物の VS Code を起こすので遅い
 * （`test:web` と同じ扱い）。配布前の関門へ入れるかは、安定を確かめてから決める。
 *
 * 単体テストの設定（`vitest.config.mts`）と違い、`vscode` を作り物へ差し替えない。
 * ここで動くのは Node の側（Playwright）だけで、`vscode` は読み込まない。
 */
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    // VS Code を1つずつ起こす。並べると打鍵と焦点が取り合いになる
    fileParallelism: false,
    // 起動（初回は取り寄せを含む）＋操作。1件で数十秒かかる
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
});
