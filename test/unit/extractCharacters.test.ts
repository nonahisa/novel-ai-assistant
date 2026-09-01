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
