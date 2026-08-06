import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.mts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      coverage: {
        provider: "v8",
        include: [
          "src/core/textFile.ts",
          "src/core/characterStore.ts",
          "src/core/characterMerge.ts",
          "src/core/characterExtractionValidation.ts",
        ],
        thresholds: {
          perFile: true,
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 80,
        },
      },
    },
  })
);
