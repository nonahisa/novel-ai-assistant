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
