import { describe, expect, test } from "vitest";
import { collect, parseResult } from "../../src/features/extractCharacters";
import * as extraction from "../../src/features/extractCharacters";
import type { Chunk } from "../../src/core/chunker";
import type { ExtractedCharacter } from "../../src/prompts/characterExtract";
import { emptyCharacter } from "../../src/models/character";

const chunk: Chunk = {
  filePath: "001.txt",
  index: 0,
  text: "灯は澪を見た。『澪さん』と灯が呼んだ。",
  hash: "fixture",
  chapterStart: 1,
  chapterEnd: 1,
};

describe("AI抽出結果の境界検証", () => {
  test("人物名と別名をtrimして保存する", () => {
    const out: Array<{ data: ExtractedCharacter; chapters: number[] }> = [];
    collect(
      out,
      {
        characters: [
          {
            name: "  灯  ",
            aliases: ["  あかり ", "", "灯"],
            evidence: "灯は澪を見た",
          },
        ],
      },
      chunk
    );

    expect(out).toEqual([
      {
        data: {
          name: "灯",
          aliases: ["あかり"],
          evidence: "灯は澪を見た",
        },
        chapters: [1],
      },
    ]);
  });

  test("モブ判定の真偽値を抽出結果に保持する", () => {
    const out: Array<{ data: ExtractedCharacter; chapters: number[] }> = [];
    collect(
      out,
      {
        characters: [
          {
            name: "取調官たち",
            aliases: [],
            isMob: true,
            evidence: "灯は澪を見た",
          },
        ],
      },
      chunk
    );

    expect(out[0].data.isMob).toBe(true);
  });

  test("配列でないネスト項目を捨て、マージ処理へ渡さない", () => {
    const parsed = parseResult(
      JSON.stringify({
        characters: [
          {
            name: "灯",
            aliases: "あかり",
            addressTerms: { targetName: "澪", term: "澪さん" },
            relations: [null, { name: "澪", relation: "友人" }],
          },
        ],
      })
    );
    const out: Array<{ data: ExtractedCharacter; chapters: number[] }> = [];
    collect(out, parsed!, chunk);

    expect(out[0].data.aliases).toEqual([]);
    expect(out[0].data.addressTerms).toEqual([]);
    expect(out[0].data.relations).toEqual([{ name: "澪", relation: "友人" }]);
  });

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

  test("変更され、かつ承認された人物だけを保存対象にする", () => {
    const selectChangedCharacters = (
      extraction as unknown as {
        selectChangedCharacters: (
          characters: ReturnType<typeof emptyCharacter>[],
          changedIds: string[],
          rejectedNames: string[]
        ) => ReturnType<typeof emptyCharacter>[];
      }
    ).selectChangedCharacters;
    const accepted = emptyCharacter("char_001", "灯");
    const rejected = emptyCharacter("char_002", "主人公");
    const untouched = emptyCharacter("char_003", "澪");

    expect(
      selectChangedCharacters(
        [accepted, rejected, untouched],
        ["char_001", "char_002"],
        ["主人公"]
      ).map((character) => character.id)
    ).toEqual(["char_001"]);
  });
});
