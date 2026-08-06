import { describe, expect, test } from "vitest";
import { splitIntoChunks } from "../../src/core/chunker";

describe("本文チャンク分割", () => {
  test.each([0, -1, 0.5, Number.NaN])(
    "進捗しない maxChars=%s を拒否する",
    (maxChars) => {
      expect(() =>
        splitIntoChunks("001.txt", "長い本文", 1, 1, { maxChars })
      ).toThrow("maxChars");
    }
  );
});
