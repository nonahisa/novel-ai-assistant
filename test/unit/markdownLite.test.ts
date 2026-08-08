import { describe, expect, test } from "vitest";
import { renderMarkdownLite } from "../../src/core/markdownLite";

describe("Markdownの簡易整形", () => {
  test("段落にする", () => {
    expect(renderMarkdownLite("一行目\n\n二行目")).toBe(
      "<p>一行目</p><p>二行目</p>"
    );
  });

  test("太字と斜体を変換する", () => {
    expect(renderMarkdownLite("**初期の感情**は不満だった")).toBe(
      "<p><strong>初期の感情</strong>は不満だった</p>"
    );
    expect(renderMarkdownLite("*たぶん*そうだ")).toBe(
      "<p><em>たぶん</em>そうだ</p>"
    );
  });

  test("箇条書きをまとめる", () => {
    const html = renderMarkdownLite("* 一つ目\n* 二つ目\n\n続きの段落");

    expect(html).toBe(
      "<ul><li>一つ目</li><li>二つ目</li></ul><p>続きの段落</p>"
    );
  });

  test("中黒やハイフンの箇条書きも扱う", () => {
    expect(renderMarkdownLite("・一つ目\n- 二つ目")).toBe(
      "<ul><li>一つ目</li><li>二つ目</li></ul>"
    );
  });

  test("見出しは強調した段落にする", () => {
    // 見出しの階層までは再現しない
    expect(renderMarkdownLite("## 結論\n本文")).toBe(
      "<p><strong>結論</strong></p><p>本文</p>"
    );
  });

  test("コードは強調より先に処理する", () => {
    // コード内の記号を強調と誤認しない
    expect(renderMarkdownLite("`**そのまま**` を出す")).toBe(
      "<p><code>**そのまま**</code> を出す</p>"
    );
  });

  test("HTMLを無害化してから変換する", () => {
    // AIの応答にタグが混ざっても画面で効かせない
    const html = renderMarkdownLite('<img src=x onerror="alert(1)">');

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("タグを含む強調でも無害化が先に効く", () => {
    const html = renderMarkdownLite("**<script>bad()</script>**");

    expect(html).not.toContain("<script>");
    expect(html).toContain("<strong>&lt;script&gt;");
  });

  test("アンパサンドを二重にエスケープしない", () => {
    expect(renderMarkdownLite("A & B")).toBe("<p>A &amp; B</p>");
  });

  test("空文字は空を返す", () => {
    expect(renderMarkdownLite("")).toBe("");
    expect(renderMarkdownLite("   \n  ")).toBe("");
  });

  test("実際のAI応答を整形できる", () => {
    const answer = [
      "エピソード終了後、生活保護に対する見方は変化したかについて、",
      "本文には直接的な記述がありませんでした。",
      "",
      "*   **初期の感情（不満・批判）**: 当初は不満を示していました（第4話）。",
      "*   **結論**: 明確な行動は確認できませんでした。",
    ].join("\n");

    const html = renderMarkdownLite(answer);

    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>初期の感情（不満・批判）</strong>");
    expect(html).not.toContain("**");
  });
});
