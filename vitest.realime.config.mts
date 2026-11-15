import { defineConfig } from "vitest/config";

/**
 * 本物の日本語入力（オリジナルIME。殻は Setsuna）で原稿エディターへ打つ試し（`npm run test:realime`。2026-11-15 作者の依頼）。
 *
 * **`npm run check`・CI・配布の検査にも、`test:e2e` の全件にも入れない。** OS のキー（SendInput）を送るので、
 * 前に出ている窓へ届く。作者がこの PC を使っているときに流すと、作者の窓へ打ち込むおそれがある。
 * 名前を `*.realime.ts` にして、E2E の設定（`test/e2e/**\/*.test.ts`）に拾われないようにしてある
 * （`real/*.real.ts` と同じ分け方）。さらに環境変数 `NOVELAI_REAL_IME=1` が無ければ、中の試しは飛ばされる。
 *
 * 土台は E2E と同じもの（`test/e2e/support/`）。走りの最初と最後に、作者の IME の状態も戻す（`realIme/support/globalSetup.ts`）。
 */
export default defineConfig({
  test: {
    include: ["test/e2e/realIme/**/*.realime.ts"],
    environment: "node",
    globalSetup: ["test/e2e/realIme/support/globalSetup.ts"],
    // 前に出る窓は1つだけにする。並べると焦点を取り合い、打鍵が別の窓へ行く
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
