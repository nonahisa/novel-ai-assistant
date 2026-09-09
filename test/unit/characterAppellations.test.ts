import { describe, expect, test } from "vitest";
import {
  buildAppellationIndex,
  findMergeCandidates,
} from "../../src/core/characterMerge";
import { emptyCharacter, type Character } from "../../src/models/character";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";

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

  test.each([
    ["お嬢様"],
    ["奥様"],
    ["王女殿下"],
  ])("肩書きだけの呼び方 %s は、呼称の索引に入れない", (title) => {
    // 一覧は書かれたままの形（「お嬢様」）で持ち、照合の側は敬称を落とした形
    // （「お嬢」）で見ていたため、この2語は一度も効いていなかった（実機確認A-18）
    const characters = [
      emptyCharacter("char_001", "文佳"),
      speaker("char_002", "太志", [{ target: "文佳", terms: [title] }]),
    ];

    expect(buildAppellationIndex(characters).get("char_001")).toEqual(["文佳"]);
  });

  test.each([
    ["僕"],
    ["私"],
    ["あんた"],
    ["お嬢様"],
    ["お母さん"],
    ["母"],
  ])("別名に入った %s を、同一人物の根拠にしない", (word) => {
    // 実データ：「密倉 文佳／三門太志＝僕」「太志／フミカ＝あんた」
    // 「フミカ／斉藤＝お嬢様」。どれも別人なのに strong で並んでいた
    const characters = [
      { ...emptyCharacter("char_001", "密倉 文佳"), aliases: [word] },
      { ...emptyCharacter("char_002", "三門太志"), aliases: [word] },
    ];

    expect(findMergeCandidates(characters)).toEqual([]);
  });

  test("誰にでも使う呼び方でも、名前そのものが同じなら候補には出す", () => {
    // 実データで「お母さん」が4件に割れていた。根拠から外しただけだと、
    // 本当の重複を直す手立てが無くなる。確信度を落として断りを添える
    const characters = [
      emptyCharacter("char_001", "お母さん"),
      emptyCharacter("char_002", "お母さん"),
    ];

    const candidates = findMergeCandidates(characters);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe("same_name");
    expect(candidates[0].confidence).toBe("weak");
    expect(candidates[0].weakNote).toContain("誰にでも使う");
  });

  test("無関係な2人は候補にしない", () => {
    const characters = [
      emptyCharacter("char_001", "ホンゴー"),
      emptyCharacter("char_002", "ジャック"),
    ];

    expect(findMergeCandidates(characters)).toEqual([]);
  });
});

/**
 * 代名詞と家族関係語の一覧は `core/genericPersonWords.ts` が1か所で持つ。
 *
 * 写しを作ると、片方にだけ語を足したときに
 * 「抽出では弾くのに、統合候補では根拠になる」という食い違いが起きる
 * （実機確認A-18で、実際に片方だけ手当てされていた）。
 */
describe("誰にでも使う呼び方の一覧", () => {
  const read = (relative: string): string =>
    readFileSync(
      nodePath.join(__dirname, "..", "..", "src", relative),
      "utf8"
    );

  test("抽出の検算と、統合候補の両方が同じ一覧を読む", () => {
    const merge = read("core/characterMerge.ts");
    const validation = read("core/characterExtractionValidation.ts");

    expect(merge).toContain('from "./genericPersonWords"');
    expect(validation).toContain('from "./genericPersonWords"');
    // 写しを作らない
    expect(merge).not.toContain('"あんた"');
    expect(validation).not.toContain('"あんた"');
  });
});
