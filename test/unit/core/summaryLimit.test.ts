import { describe, expect, test } from "vitest";
import { clampSummary, SUMMARY_MAX_CHARS } from "../../src/core/summaryLimit";
import { buildCharacterMarkdown } from "../../src/core/settingsMarkdown";
import { emptyCharacter, type Character } from "../../src/models/character";

describe("紹介文の長さ", () => {
  // 上限は変わることがある（50→60）。テストが直書きしていると
  // 上限を動かすたびに書き直しになるので、定数から組み立てる
  test("上限以内はそのまま通す", () => {
    const text = "冒険者ギルドの生活保護課ケースワーカー。転移者で制度の考案者。";

    expect(clampSummary(text)).toBe(text);
  });

  test("上限を超えたら切り詰める", () => {
    // プロンプトで指示しても守られないので、コード側で確かめる
    const long = "あ".repeat(SUMMARY_MAX_CHARS + 30);

    expect([...(clampSummary(long) ?? "")]).toHaveLength(SUMMARY_MAX_CHARS);
  });

  test("切るときは句読点の切れ目まで戻す", () => {
    // 上限の6割より後ろにある句点で終わらせる
    const head = "あ".repeat(SUMMARY_MAX_CHARS - 15);
    const text = head + "。" + "い".repeat(30);

    // ぶつ切りにせず、読める形で終わらせる
    expect(clampSummary(text)).toBe(head + "。");
  });

  test("戻しすぎない", () => {
    // 先頭近くの句点まで戻すと情報がほとんど残らない
    const text = "あ。" + "い".repeat(SUMMARY_MAX_CHARS + 30);

    expect([...(clampSummary(text) ?? "")]).toHaveLength(SUMMARY_MAX_CHARS);
  });

  test("空やnullは未設定にする", () => {
    expect(clampSummary(null)).toBeNull();
    expect(clampSummary(undefined)).toBeNull();
    expect(clampSummary("   ")).toBeNull();
  });

  test("改行を1行にまとめる", () => {
    expect(clampSummary("前半\n  後半")).toBe("前半 後半");
  });

  test("サロゲートペアを1字として数える", () => {
    // 「𠮟」のような字を2字と数えると、実際より短く切れてしまう
    const text = "𠮟".repeat(SUMMARY_MAX_CHARS + 10);

    expect([...(clampSummary(text) ?? "")]).toHaveLength(SUMMARY_MAX_CHARS);
  });
});

describe("所属でのグループ分け", () => {
  function character(name: string, affiliation: string | null): Character {
    return { ...emptyCharacter(`char_${name}`, name), affiliation };
  }

  test("所属ごとに見出しを立てる", () => {
    const markdown = buildCharacterMarkdown(
      [
        character("ホンゴー", "生活保護課"),
        character("メモリー", "窓口課"),
        character("マルク", "生活保護課"),
      ],
      { workTitle: "テスト作品" }
    );

    expect(markdown).toContain("## 生活保護課");
    expect(markdown).toContain("## 窓口課");
    // 同じ所属は1つの見出しにまとめる
    expect(markdown.match(/## 生活保護課/g)).toHaveLength(1);
  });

  test("所属が読み取れない人物は末尾へまとめる", () => {
    const markdown = buildCharacterMarkdown(
      [character("謎の男", null), character("ホンゴー", "生活保護課")],
      { workTitle: "テスト作品" }
    );

    // 「所属不明」という組織があるように見せない
    expect(markdown).toContain("## 所属の記載なし");
    expect(markdown.indexOf("## 生活保護課")).toBeLessThan(
      markdown.indexOf("## 所属の記載なし")
    );
  });

  test("紹介文を名前の直後に出す", () => {
    const target = {
      ...character("ホンゴー", "生活保護課"),
      summary: "生活保護課のケースワーカー。転移者。",
    };

    const markdown = buildCharacterMarkdown([target], {
      workTitle: "テスト作品",
    });

    expect(markdown).toContain("### ホンゴー");
    expect(markdown).toContain("生活保護課のケースワーカー。転移者。");
  });
});
