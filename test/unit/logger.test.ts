import { describe, expect, test } from "vitest";
import { redactSecrets } from "../../src/core/logger";

describe("ログの伏せ字", () => {
  test.each([
    ["sk-proj-abcdefghijklmnop", "sk-***"],
    ["AIzaSyABCDEFGHIJKLMNOP", "AIza***"],
    ["AQ.Ab8RN6JuQEwhj-nHcgmJ6ArXecZZxy", "AQ.***"],
  ])("APIキーらしき文字列を伏せる: %s", (secret, expected) => {
    // 作者がログを貼って助けを求めることを考えると、
    // 万一キーが混ざったときの被害が大きい
    expect(redactSecrets(`error: ${secret} is invalid`)).toBe(
      `error: ${expected} is invalid`
    );
  });

  test("普通の文章は変えない", () => {
    const message = "モデルが見つかりません (HTTP 404)";

    expect(redactSecrets(message)).toBe(message);
  });

  test("短い似た文字列は伏せない", () => {
    // 「sk-」で始まるだけの短い語まで潰すと、読めるはずの情報が消える
    expect(redactSecrets("sk-1")).toBe("sk-1");
  });
});
