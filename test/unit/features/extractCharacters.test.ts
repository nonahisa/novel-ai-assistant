import { describe, expect, test } from "vitest";
import * as extraction from "../../src/features/extractCharacters";
import type { ExtractedCharacter } from "../../src/prompts/characterExtract";
import { emptyCharacter } from "../../src/models/character";

describe("人物抽出オーケストレーションの補助処理", () => {
  test("既存人物と前チャンクの名前・別名を重複なく次へ渡す", () => {
    const buildKnownCharacterNames = (
      extraction as unknown as {
        buildKnownCharacterNames: (
          existing: Array<{ name: string; aliases: string[] }>,
          extracted: Array<{ data: ExtractedCharacter }>
        ) => string[];
      }
    ).buildKnownCharacterNames;

    expect(
      buildKnownCharacterNames(
        [{ name: "灯", aliases: ["あかり"] }],
        [
          { data: { name: "澪", aliases: ["白瀬さん", "灯"] } },
          { data: { name: "澪", aliases: [] } },
        ]
      )
    ).toEqual(["灯", "あかり", "澪", "白瀬さん"]);
  });

  test("プロンプトへ渡す既知名は、人数で100人まで数える", () => {
    /*
      **以前は「名前＋別名」を1件ずつ100件で切っていた。** 別名を持つ人が
      多いと人数の2倍以上になり（21人の作品で46件）、50人を超える作品では
      後ろの人物が丸ごと落ちて、同一人物の判定が効かなくなっていた。
      落ちるのは一覧の後ろ＝新しく出てきた人物で、**いちばん取り違えやすい人**
      から消える。
    */
    const buildForPrompt = (
      extraction as unknown as {
        buildKnownCharacterNamesForPrompt: (
          existing: Array<{ name: string; aliases: string[] }>,
          extracted: Array<{ data: ExtractedCharacter }>
        ) => string[];
      }
    ).buildKnownCharacterNamesForPrompt;

    const existing = Array.from({ length: 120 }, (_, index) => ({
      name: `人物${index + 1}`,
      aliases: [`別名${index + 1}`],
    }));

    const names = buildForPrompt(existing, []);

    // 100人目までは本名が入る
    expect(names).toContain("人物100");
    // 101人目からは落ちる（人数の上限）
    expect(names).not.toContain("人物101");
    expect(names).not.toContain("別名101");
    // 本名と別名は隣り合わせで渡す
    expect(names.slice(0, 4)).toEqual([
      "人物1",
      "別名1",
      "人物2",
      "別名2",
    ]);
  });

  test("名前の総数が溢れるときは、本名を残して別名から落とす", () => {
    // 本名が無ければその人物の存在ごと伝わらない。別名は1つ欠けても、
    // 「同じ人かもしれない」の手掛かりが1つ減るだけで済む
    const buildForPrompt = (
      extraction as unknown as {
        buildKnownCharacterNamesForPrompt: (
          existing: Array<{ name: string; aliases: string[] }>,
          extracted: Array<{ data: ExtractedCharacter }>
        ) => string[];
      }
    ).buildKnownCharacterNamesForPrompt;

    // 100人 × 別名3つ＝400件。総数の上限（200件）に収まらない
    const existing = Array.from({ length: 100 }, (_, index) => ({
      name: `人物${index + 1}`,
      aliases: [`甲${index + 1}`, `乙${index + 1}`, `丙${index + 1}`],
    }));

    const names = buildForPrompt(existing, []);

    // 100人ぶんの本名は全部ある
    for (const person of existing) expect(names).toContain(person.name);
    // 落ちるのは後ろの人の別名
    expect(names).not.toContain("甲100");
    expect(names.length).toBeLessThanOrEqual(200);
  });

  test("変更された人物だけを保存対象にする", () => {
    const selectChangedCharacters = (
      extraction as unknown as {
        selectChangedCharacters: (
          characters: ReturnType<typeof emptyCharacter>[],
          changedIds: string[]
        ) => ReturnType<typeof emptyCharacter>[];
      }
    ).selectChangedCharacters;
    const first = emptyCharacter("char_001", "灯");
    const second = emptyCharacter("char_002", "主人公");
    const untouched = emptyCharacter("char_003", "澪");

    expect(
      selectChangedCharacters(
        [first, second, untouched],
        ["char_001", "char_002"]
      ).map((character) => character.id)
    ).toEqual(["char_001", "char_002"]);
  });
});

/**
 * 出力上限で切り詰められたとき、同じ大きさの残りも先に分けておく仕組み
 * （実データでは39チャンク中33件が同じ理由で失敗した）。
 *
 * **キャッシュに答えがあるものは分けない。** 分けると `wholeFile:false` の
 * 新しいハッシュになるので、既にある命中を捨てたうえ、**二度と当たらない鍵**を
 * 作ることになる。1回も呼ばずに済んだはずのチャンクが、毎回送られ続ける。
 */
describe("先回りで分け直す対象を選ぶ", () => {
  const shouldPresplitChunk = (
    extraction as unknown as {
      shouldPresplitChunk: (options: {
        chunkChars: number;
        tooBigChars: number;
        cached: boolean;
      }) => boolean;
    }
  ).shouldPresplitChunk;

  test("同じ大きさ以上のものは、先に分ける", () => {
    expect(
      shouldPresplitChunk({ chunkChars: 20000, tooBigChars: 20000, cached: false })
    ).toBe(true);
    expect(
      shouldPresplitChunk({ chunkChars: 24000, tooBigChars: 20000, cached: false })
    ).toBe(true);
  });

  test("小さいものは、そのまま送ってみる", () => {
    // 切り詰められた本人より小さいなら、通る見込みがある
    expect(
      shouldPresplitChunk({ chunkChars: 19999, tooBigChars: 20000, cached: false })
    ).toBe(false);
  });

  test("キャッシュに答えがあるものは、大きくても分けない", () => {
    // 分けると鍵が変わり、命中を捨てたうえ二度と当たらない鍵を作る
    expect(
      shouldPresplitChunk({ chunkChars: 24000, tooBigChars: 20000, cached: true })
    ).toBe(false);
  });
});
