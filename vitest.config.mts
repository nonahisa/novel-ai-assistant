import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // ビルドのときに esbuild が埋める印（開発用の道具を束に入れるか）。
  // **試験では true。** 開発用の道具も試験の対象にする
  define: { __DEV_HELPERS__: "true" },
  resolve: {
    alias: {
      vscode: fileURLToPath(
        new URL("./test/unit/support/vscodeStub.ts", import.meta.url)
      ),
    },
  },
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    /*
      **時間帯を日本時間に固定する**（2026-09-24）。

      CI（GitHub Actions）は UTC で走るため、**手元では通るのに CI だけ落ちる**
      試験があった（`features/contestForecast.test.ts` の3件。完成予定日が
      そろって1日手前になる）。**製品の側は正しい**——執筆統計の「今日」は
      日付の境目（既定 午前4時）を引いてから**その土地の暦**で決める作りで、
      深夜に書く作者のためにそうしてある。試験が `vi.setSystemTime` で
      固定している時刻（`12:00+09:00`）が、UTC では 03:00 になって
      **境目をまたいでいた**のが原因である。

      **試験だけを揃える。** 作者も作品も日本語なので、日本時間で固定すれば
      手元と CI が同じ結果になる。**製品の振る舞いは変えない。**
    */
    env: { TZ: "Asia/Tokyo" },
    // 読み口（`core/fileRead.ts`）を `vscode.workspace.fs` 側へ固定する。
    // **試験も Node の上で動く**ので、入れないと本物のディスクを読みにいき、
    // 記憶の中に置いた作り物が見えなくなる（理由は `support/setup.ts`）
    setupFiles: ["./test/unit/support/setup.ts"],
  },
});
