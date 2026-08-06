import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
