import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { Chunk } from "../../src/core/chunker";
import {
  parseResult,
  validateCharacterExtractResult,
} from "../../src/core/characterExtractionValidation";
import { mergeExtractedCharacters } from "../../src/core/characterMerge";
import { emptyCharacter } from "../../src/models/character";
import {
  CHARACTER_EXTRACT_SCHEMA,
  CHARACTER_EXTRACT_VERSION,
} from "../../src/prompts/characterExtract";

interface QualityFixture {
  expectedNames: string[];
  forbiddenNames: string[];
  expectedAliases: Record<string, string[]>;
  expectedAuthorFields: Record<
    string,
    { authorNotes: string; exportNote: string }
  >;
  responses: Array<{ chunk: Chunk; response: string }>;
}

interface QualityMetrics {
  recall: number;
  falsePositives: number;
  falseMerges: number;
  authorProtectionViolations: number;
}

const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/character-extraction/balanced.json", import.meta.url)
);

let fixture: QualityFixture;

beforeAll(async () => {
  fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as QualityFixture;
});

describe("登場人物抽出の品質ゲート", () => {
  test("固定応答を検証・マージして品質しきい値を満たす", () => {
    const accepted = fixture.responses.flatMap(({ chunk, response }) => {
      const parsed = parseResult(response);
      if (!parsed) throw new Error("固定応答をJSONとして解析できません。");
      return validateCharacterExtractResult(parsed, chunk).accepted;
    });

    const protectedCharacter = emptyCharacter("char_001", "白瀬 澪");
    protectedCharacter.authorNotes = fixture.expectedAuthorFields["白瀬 澪"].authorNotes;
    protectedCharacter.exportNote = fixture.expectedAuthorFields["白瀬 澪"].exportNote;

    const merged = mergeExtractedCharacters([protectedCharacter], accepted);
    const metrics = calculateMetrics(fixture, merged.characters);

    console.log(
      `character extraction quality metrics: ${JSON.stringify(metrics)}`
    );

    expect(metrics).toEqual({
      recall: 1,
      falsePositives: 0,
      falseMerges: 0,
      authorProtectionViolations: 0,
    });

    for (const [name, aliases] of Object.entries(fixture.expectedAliases)) {
      const character = merged.characters.find((item) => item.name === name);
      expect(character?.aliases).toEqual(expect.arrayContaining(aliases));
    }
    for (const [name, fields] of Object.entries(
      fixture.expectedAuthorFields
    )) {
      const character = merged.characters.find((item) => item.name === name);
      expect(character).toMatchObject(fields);
    }
  });

  test("v1.5の構造化出力契約を公開する", () => {
    expect(CHARACTER_EXTRACT_VERSION).toBe("1.5");
    expect(CHARACTER_EXTRACT_SCHEMA.properties.characters.items.properties)
      .toHaveProperty("entityType");
    expect(CHARACTER_EXTRACT_SCHEMA.properties.characters.items.required)
      .toEqual(expect.arrayContaining(["name", "entityType", "evidence"]));
  });
});

function calculateMetrics(
  fixture: QualityFixture,
  characters: Array<{
    name: string;
    aliases: string[];
    authorNotes: string;
    exportNote: string;
  }>
): QualityMetrics {
  const expectedFound = fixture.expectedNames.filter((name) =>
    characters.some((character) => character.name === name)
  ).length;
  const falsePositives = characters.filter((character) =>
    fixture.forbiddenNames.includes(character.name)
  ).length;
  const falseMerges = Object.entries(fixture.expectedAliases).reduce(
    (count, [name, aliases]) => {
      const character = characters.find((item) => item.name === name);
      return count + aliases.filter((alias) => !character?.aliases.includes(alias)).length;
    },
    0
  );
  const authorProtectionViolations = Object.entries(
    fixture.expectedAuthorFields
  ).reduce((count, [name, fields]) => {
    const character = characters.find((item) => item.name === name);
    return count + Number(
      character?.authorNotes !== fields.authorNotes ||
        character?.exportNote !== fields.exportNote
    );
  }, 0);

  return {
    recall: expectedFound / fixture.expectedNames.length,
    falsePositives,
    falseMerges,
    authorProtectionViolations,
  };
}
