import { describe, expect, test } from "vitest";
import { redactUrlCredentials } from "../../src/core/redactUrl";

/**
 * URLに埋め込まれた資格情報（`https://user:token@host/...`）を落とす。
 *
 * GitHubの案内どおりに `https://<トークン>@github.com/...` を貼る人がいる。
 * そのURLはログにも残り、作者がログを貼って助けを求めたときに漏れる。
 */
describe("URLの資格情報を落とす", () => {
  test("ユーザー名とパスワードを落とす", () => {
    expect(
      redactUrlCredentials("送り先: https://nonahisa:ghp_secretvalue@github.com/a/b.git")
    ).toBe("送り先: https://***@github.com/a/b.git");
  });

  test("トークンだけを書いた形も落とす", () => {
    expect(
      redactUrlCredentials("https://github_pat_11ABCDEFG@github.com/a/b.git")
    ).toBe("https://***@github.com/a/b.git");
  });

  test("ssh の git@ も落とす（形は残す）", () => {
    expect(redactUrlCredentials("ssh://git@github.com/a/b.git")).toBe(
      "ssh://***@github.com/a/b.git"
    );
  });

  test("資格情報の無いURLは変えない", () => {
    const text = "送り先: https://github.com/nonahisa/novel.git（main）";

    expect(redactUrlCredentials(text)).toBe(text);
  });

  test("メールアドレスは消さない", () => {
    // `//` から始まるURLの中だけを見る。文中の `@` を巻き込むと、
    // コミットする人のメールアドレスまで消えてログが読めなくなる
    const text = "user.email: nonahisa@example.com";

    expect(redactUrlCredentials(text)).toBe(text);
  });

  test("1行に複数のURLがあっても、すべて落とす", () => {
    expect(
      redactUrlCredentials(
        "https://a:b@github.com/x/y.git → https://c:d@gitlab.com/x/y.git"
      )
    ).toBe("https://***@github.com/x/y.git → https://***@gitlab.com/x/y.git");
  });
});
