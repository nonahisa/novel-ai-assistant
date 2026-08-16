import { describe, expect, test } from "vitest";
import { organizationsFromAffiliations } from "../../src/core/settingsMerge";
import { emptyLocation } from "../../src/models/location";
import { emptyOrganization } from "../../src/models/organization";

/**
 * 名前が「null」の組織ができていた不具合の再現（作者の指摘、2026-08-16）。
 *
 * 設定資料パネルの組織タブに **`null`** という項目が並んでいた。
 * 実データを見ると `organizations/org_004_null.json` があり、
 * `name` が文字列の `"null"` になっていた（`summary` も `evidence` も空）。
 *
 * 抽出の経路（`validateExtractedOrganizations`）は `isValidSettingName` を
 * 通しているが、**人物の所属から組織を補う経路は素通しだった**。
 * AIが所属へ "null" と書くと、そのままレコードになる。
 *
 * この経路のレコードは説明も根拠も持たない**いちばん弱い記録**なので、
 * いちばん厳しく確かめてよい。
 */
describe("所属から組織を補うとき", () => {
  test("「null」という名前を作らない", () => {
    const result = organizationsFromAffiliations([], ["null"]);

    expect(result.organizations).toEqual([]);
    expect(result.added).toEqual([]);
  });

  test.each([
    "null",
    "undefined",
    "なし",
    "不明",
    "N/A",
    "none",
    "特になし",
    "その他",
  ])("値の代わりに書かれた「%s」を作らない", (name) => {
    expect(organizationsFromAffiliations([], [name]).added).toEqual([]);
  });

  test("文がそのまま所属に入っていても作らない", () => {
    // 「〜に所属している。」のような文は名前ではない
    const result = organizationsFromAffiliations([], [
      "冒険者ギルドに所属している。",
    ]);

    expect(result.added).toEqual([]);
  });

  test("普通の所属名はこれまでどおり作る", () => {
    const result = organizationsFromAffiliations([], [
      "久山小学校",
      "密倉グループ（秘書室）",
    ]);

    expect(result.added).toEqual(["久山小学校", "密倉グループ（秘書室）"]);
  });

  test("既にある組織は増やさない", () => {
    const existing = [emptyOrganization("org_001", "久山小学校")];
    const result = organizationsFromAffiliations(existing, ["久山小学校"]);

    expect(result.added).toEqual([]);
    expect(result.organizations).toHaveLength(1);
  });

  test("場所として登録済みなら組織にしない", () => {
    // 以前からの決まり。地名を所属に書かれることがある
    const places = [emptyLocation("loc_001", "王都")];
    const result = organizationsFromAffiliations([], ["王都"], places);

    expect(result.added).toEqual([]);
  });

  test("空文字や空白だけは作らない", () => {
    expect(organizationsFromAffiliations([], ["", "   "]).added).toEqual([]);
  });
});
