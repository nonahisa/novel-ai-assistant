import { describe, expect, test } from "vitest";
import { SECRET_PREFIXES, redactSecrets } from "../../src/core/logger";

/**
 * 鍵の見張りが2か所にある——**その2つを揃えたままにする**ための番人。
 *
 * ・ログの伏せ字（`src/core/logger.ts`）：作者がログを貼るときの漏れを防ぐ
 * ・配布物の出口走査（`scripts/releaseSupport.mjs`）：VSIXに鍵を入れない
 *
 * 片方に接頭辞を足して、もう片方を忘れるのが一番ありがちな壊れ方である。
 * 走査側は `.mjs`（リリース手順から直接動かす素のNode）で、伏せ字側は
 * TypeScriptなので、**共有モジュールにはできない**。代わりに、
 * 「同じ形の値を、両方が知っているか」をここで確かめる。
 */

const { FORBIDDEN_CONTENT_PATTERNS: forbiddenContentPatterns } = (await import(
  "../../scripts/releaseSupport.mjs"
)) as { FORBIDDEN_CONTENT_PATTERNS: RegExp[] };

describe("鍵の見張りの揃い", () => {
  test.each(SECRET_PREFIXES)(
    "%s で始まる値は、ログでも伏せられ、配布物にも入れない",
    (prefix) => {
      // 本物の鍵は使わない。長さだけ本物に寄せた作り物で確かめる
      const sample = `${prefix}${"A1b2C3d4E5".repeat(4)}`;

      expect(redactSecrets(`key=${sample}`)).not.toContain(sample);
      expect(
        forbiddenContentPatterns.some((pattern) => pattern.test(sample))
      ).toBe(true);
    }
  );

  test("ありふれた語は配布物の走査に引っかからない", () => {
    // `sk-` は `task-` `risk-` の中にも現れる。ここを緩く見ると、
    // 配布のたびに無関係な行で止まって、走査そのものが信用されなくなる
    const innocent = "class=\"task-list-item-checkbox-container\"";

    expect(
      forbiddenContentPatterns.some((pattern) => pattern.test(innocent))
    ).toBe(false);
  });
});
