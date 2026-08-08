import { describe, expect, test } from "vitest";
import {
  buildAppellationIndex,
  findMergeCandidates,
} from "../../src/core/characterMerge";
import { emptyCharacter, type Character } from "../../src/models/character";

/**
 * 呼称は「呼ぶ側」のレコードに入る。
 * speaker が target を terms のように呼ぶ、という形で組み立てる。
 */
function speaker(
  id: string,
  name: string,
  calls: Array<{ target: string; terms: string[] }> = []
): Character {
  return {
    ...emptyCharacter(id, name),
    addressTerms: calls.map((call) => ({
      targetName: call.target,
      targetId: null,
      authorLocked: false,
      forms: call.terms.map((term) => ({
        term,
        category: null,
        context: null,
        firstChapter: null,
        lastChapter: null,
        status: "current" as const,
        evidence: null,
      })),
    })),
  };
}

describe("その人物を指す呼称", () => {
  test("他人のレコードに書かれた呼称も集める", () => {
    // 「マルキオがリンセップを『リン』と呼ぶ」はマルキオ側に記録される。
    // リンセップのレコードだけを見ても分からない
    const characters = [
      emptyCharacter("char_003", "リンセップ・アウクト"),
      speaker("char_004", "マルキオ・イークェス", [
        { target: "リンセップ・アウクト", terms: ["リン", "王女殿下"] },
      ]),
    ];

    const index = buildAppellationIndex(characters);

    expect(index.get("char_003")).toContain("リン");
  });

  test("肩書きだけの呼び方は含めない", () => {
    // 「王女殿下」で一致させると、別の王女まで同一人物にしてしまう
    const characters = [
      emptyCharacter("char_003", "リンセップ・アウクト"),
      speaker("char_004", "マルキオ・イークェス", [
        { target: "リンセップ・アウクト", terms: ["王女殿下", "姫"] },
      ]),
    ];

    const index = buildAppellationIndex(characters);

    expect(index.get("char_003")).not.toContain("王女殿下");
    expect(index.get("char_003")).not.toContain("姫");
  });

  test("自分のレコードに書かれた自分への呼称も拾う", () => {
    // AIが呼ぶ側と呼ばれる側を取り違えることがあるため、両方に対応する
    const withSelf = [
      speaker("char_001", "リン", [{ target: "リン", terms: ["リンちゃん"] }]),
    ];

    expect(buildAppellationIndex(withSelf).get("char_001")).toContain(
      "リンちゃん"
    );
  });

  test("呼称が無ければ名前だけになる", () => {
    const characters = [emptyCharacter("char_001", "リン")];

    expect(buildAppellationIndex(characters).get("char_001")).toEqual(["リン"]);
  });

  test("宛先が誰でもない呼称は誰にも足さない", () => {
    const characters = [
      emptyCharacter("char_001", "リン"),
      speaker("char_004", "マルキオ", [
        { target: "見知らぬ誰か", terms: ["おい"] },
      ]),
    ];

    const index = buildAppellationIndex(characters);

    expect(index.get("char_001")).toEqual(["リン"]);
  });
});

describe("同一人物の候補検出", () => {
  test("実データで別人になった組を見つける", () => {
    // 「リン」「マル」と、フルネームの2件が別々に登録されていた
    const characters = [
      speaker("char_001", "リン", [{ target: "リン", terms: ["リン"] }]),
      speaker("char_002", "マル", [{ target: "マル", terms: ["マルくん"] }]),
      speaker("char_003", "リンセップ・アウクト", [
        { target: "マルキオ・イークェス", terms: ["マルくん"] },
      ]),
      speaker("char_004", "マルキオ・イークェス", [
        { target: "リンセップ・アウクト", terms: ["リン", "王女殿下"] },
      ]),
      emptyCharacter("char_005", "シーカー"),
    ];

    const candidates = findMergeCandidates(characters);
    const pairs = candidates.map((candidate) => candidate.names.join("+"));

    expect(pairs).toContain("リン+リンセップ・アウクト");
    expect(pairs).toContain("マル+マルキオ・イークェス");
    // 無関係の人物を巻き込まない
    expect(pairs.join()).not.toContain("シーカー");
  });

  test("肩書きが同じだけの別人は候補にしない", () => {
    const characters = [
      emptyCharacter("char_001", "リンセップ・アウクト"),
      emptyCharacter("char_002", "セラフィナ・ノート"),
      speaker("char_003", "侍女", [
        { target: "リンセップ・アウクト", terms: ["姫"] },
        { target: "セラフィナ・ノート", terms: ["姫"] },
      ]),
    ];

    expect(findMergeCandidates(characters)).toEqual([]);
  });

  test("無関係な2人は候補にしない", () => {
    const characters = [
      emptyCharacter("char_001", "ホンゴー"),
      emptyCharacter("char_002", "ジャック"),
    ];

    expect(findMergeCandidates(characters)).toEqual([]);
  });
});
