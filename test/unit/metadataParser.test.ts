import { describe, expect, test } from "vitest";
import { parseEpisodeMetadata } from "../../src/core/metadataParser";

describe("投稿サイトのメタデータ", () => {
  test("カクヨム形式のヘッダーと本文を分離する", () => {
    const parsed = parseEpisodeMetadata(
      "【タイトル】\n再会\n\n【文字数】\n1,826文字\n\n【更新日時】\n2026-08-05\n\n【本文（1行）】\n本文です。"
    );

    expect(parsed.hasMetadata).toBe(true);
    expect(parsed.title).toBe("再会");
    expect(parsed.declaredCharCount).toBe(1826);
    expect(parsed.updatedAt).toBe("2026-08-05");
    expect(parsed.body).toBe("本文です。");
  });

  test("通常の本文はそのまま返す", () => {
    const parsed = parseEpisodeMetadata("第一章\n本文");
    expect(parsed.hasMetadata).toBe(false);
    expect(parsed.body).toBe("第一章\n本文");
  });
});
