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
    // 読み口（`core/fileRead.ts`）を `vscode.workspace.fs` 側へ固定する。
    // **試験も Node の上で動く**ので、入れないと本物のディスクを読みにいき、
    // 記憶の中に置いた作り物が見えなくなる（理由は `support/setup.ts`）
    setupFiles: ["./test/unit/support/setup.ts"],
  },
});
