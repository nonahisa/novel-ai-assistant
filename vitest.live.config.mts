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
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
