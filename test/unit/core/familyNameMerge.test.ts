import { describe, expect, test } from "vitest";
import {
  mergeExtractedCharacters,
  sharedNameParts,
} from "../../src/core/characterMerge";
import { emptyCharacter } from "../../src/models/character";
import type { Character } from "../../src/models/character";

/**
 * 実データで見つかった不具合の再現（2026-08-15）。
 *
 * 「ジェクティ・コンストラクタ」「ヴォイド・コンストラクタ」
 * 「イント・コンストラクタ」（母・父・息子）が、姓だけの
 * 「コンストラクタ」という1件へまとめられていた。
 *
 * 姓だけのレコードが先にできると、家族が1人ずつ
 * 「候補が一人に決まる」判定を通ってしまい、次々に吸収される。
 */

function character(id: string, name: string, aliases: string[] = []): Character {
  const base = emptyCharacter(id, name);
  base.aliases = aliases;
  return base;
}

function extracted(name: string, aliases: string[] = []) {
  return { data: { name, aliases }, chapters: [1] };
}

describe("共有している名前の部分（＝姓）を見つける", () => {
  test("2人以上が持つ部分を姓とみなす", () => {
    const shared = sharedNameParts([
      character("c1", "イント・コンストラクタ"),
      character("c2", "ストリナ・コンストラクタ"),
    ]);

    expect(shared.has("コンストラクタ")).toBe(true);
    expect(shared.has("イント")).toBe(false);
  });

  test("1人しか持たない部分は姓とみなさない", () => {
    // 「イント」だけで呼ばれた場合に本人へ寄せられなくなると困る
    const shared = sharedNameParts([character("c1", "イント・コンストラクタ")]);

    expect(shared.size).toBe(0);
  });

  test("同じ人物の別名で二重に数えない", () => {
    // 別名を増やしただけで姓扱いされると、寄せ先が見つからなくなる
    const shared = sharedNameParts([
      character("c1", "イント・コンストラクタ", ["イント・コンストラクタ様"]),
    ]);

    expect(shared.has("コンストラクタ")).toBe(false);
  });

  test("区切りの無い名前は分割しない", () => {
    expect(sharedNameParts([character("c1", "ハルト"), character("c2", "ハルト")]).size).toBe(0);
  });
});

describe("姓が同じ別人をまとめない", () => {
  test("姓だけのレコードが家族を吸収しない", () => {
    // これが実際に起きた壊れ方
    const existing = [
      character("c1", "コンストラクタ"),
      character("c2", "イント・コンストラクタ"),
      character("c3", "ストリナ・コンストラクタ"),
    ];

    const result = mergeExtractedCharacters(existing, [
      extracted("ヴォイド・コンストラクタ"),
    ]);

    const family = result.characters.find((c) => c.name === "コンストラクタ");
    expect(family?.aliases ?? []).not.toContain("ヴォイド・コンストラクタ");
  });

  test("姓が同じでも、別人は別のレコードになる", () => {
    const result = mergeExtractedCharacters(
      [character("c1", "イント・コンストラクタ"), character("c2", "ストリナ・コンストラクタ")],
      [extracted("ヴォイド・コンストラクタ")]
    );

    expect(
      result.characters.filter((c) => c.name.includes("コンストラクタ"))
    ).toHaveLength(3);
  });
});

describe("重複レコードがあっても、名を姓と間違えない", () => {
  test("同じ人物が複数レコードに分かれていても、名は姓にしない", () => {
    // 実データで「ヴォイド・コンストラクタ」が3件に分裂しており、
    // 人数で数えると「ヴォイド」まで姓と判定された。そうなると
    // 「ヴォイド」だけで呼ばれたときに本人へ寄せられなくなる
    const shared = sharedNameParts([
      character("c1", "ヴォイド・コンストラクタ"),
      character("c2", "ヴォイド・コンストラクタ男爵"),
      character("c3", "イント・コンストラクタ"),
    ]);

    expect(shared.has("コンストラクタ")).toBe(true);
    expect(shared.has("ヴォイド")).toBe(false);
  });

  test("爵位は名前の一部として扱わない", () => {
    // 「ヴォイド・コンストラクタ男爵」と「ヴォイド・コンストラクタ」は同一人物
    const result = mergeExtractedCharacters(
      [character("c1", "ヴォイド・コンストラクタ男爵")],
      [extracted("ヴォイド・コンストラクタ")]
    );

    expect(result.characters).toHaveLength(1);
  });

  test("「男爵夫人」も落とす", () => {
    const result = mergeExtractedCharacters(
      [character("c1", "ジェクティ・コンストラクタ男爵夫人")],
      [extracted("ジェクティ・コンストラクタ")]
    );

    expect(result.characters).toHaveLength(1);
  });
});

describe("正しい寄せ方は壊さない", () => {
  test("名前が完全に一致すれば、これまでどおり寄せる", () => {
    const result = mergeExtractedCharacters(
      [character("c1", "イント・コンストラクタ")],
      [extracted("イント・コンストラクタ", ["イント君"])]
    );

    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].aliases).toContain("イント君");
  });

  test("姓を共有していない部分名なら、これまでどおり寄せる", () => {
    // 「マイナ」だけで呼ばれたとき、「マイナ・ノースウッド」へ寄せたい
    const result = mergeExtractedCharacters(
      [character("c1", "マイナ・ノースウッド")],
      [extracted("マイナ")]
    );

    expect(result.characters).toHaveLength(1);
  });
});
