import { describe, expect, test } from "vitest";
import { formatLogTime, redactSecrets } from "../../src/core/logger";

describe("ログの時刻", () => {
  test("作者の時計に合わせる（UTCで書かない）", () => {
    // UTCで書くと日本時間とは9時間ずれる。1分前の行が9時間前に見え、
    // 動いているのに止まったように見えた（実際に作者がそう判断した）
    const now = new Date(2026, 7, 10, 22, 19, 37);

    expect(formatLogTime(now)).toBe("2026-08-10 22:19:37");
  });

  test("1桁の月日・時刻を0で埋める", () => {
    // 桁が揃っていないと、並べたときに読み取りにくい
    expect(formatLogTime(new Date(2026, 0, 2, 3, 4, 5))).toBe(
      "2026-01-02 03:04:05"
    );
  });
});

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

  test.each([
    ["ghp_1234567890abcdefghij", "ghp_***"],
    ["gho_1234567890abcdefghij", "gho_***"],
    ["ghu_1234567890abcdefghij", "ghu_***"],
    ["ghs_1234567890abcdefghij", "ghs_***"],
    ["ghr_1234567890abcdefghij", "ghr_***"],
    ["github_pat_11ABCDEFG0abcdefghij", "github_pat_***"],
  ])("GitHubのトークンも伏せる: %s", (secret, expected) => {
    // GitHub同期の失敗はURLごとログに残る。作者がトークンを埋め込んだURLを
    // 貼っていると、そのままログへ出ていた
    expect(redactSecrets(`remote: ${secret}`)).toBe(`remote: ${expected}`);
  });

  test("URLに埋め込まれた資格情報を落とす", () => {
    expect(
      redactSecrets("送り先を登録: https://user:ghp_abcdefghij@github.com/a/b.git")
    ).toBe("送り先を登録: https://***@github.com/a/b.git");
  });

  test("普通の文章は変えない", () => {
    const message = "モデルが見つかりません (HTTP 404)";

    expect(redactSecrets(message)).toBe(message);
  });

  test("短い似た文字列は伏せない", () => {
    // 「sk-」で始まるだけの短い語まで潰すと、読めるはずの情報が消える
    expect(redactSecrets("sk-1")).toBe("sk-1");
  });

  test("語の途中の「sk-」は伏せない", () => {
    // `task-` `risk-` のような語まで潰すと、ログが伏せ字だらけになって読めない
    const message = "task-list-item-checkbox が見つかりません";

    expect(redactSecrets(message)).toBe(message);
  });
});
