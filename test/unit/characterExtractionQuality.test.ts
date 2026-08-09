import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { Chunk } from "../../src/core/chunker";
import {
  parseResult,
  validateCharacterExtractResult,
} from "../../src/core/characterExtractionValidation";
import { mergeExtractedCharacters } from "../../src/core/characterMerge";
import {
  emptyCharacter,
  type Character,
} from "../../src/models/character";
import {
  CHARACTER_EXTRACT_SCHEMA,
  CHARACTER_EXTRACT_VERSION,
  type CharacterExtractResult,
} from "../../src/prompts/characterExtract";

interface AddressPeriodExpectation {
  targetName: string;
  term: string;
  firstChapter: number;
  lastChapter: number;
}

interface IdentityExpectation {
  id: string;
  canonicalName: string;
  members: string[];
  appearedChapters: number[];
  addressTerms?: AddressPeriodExpectation[];
}

interface ProtectedExpectation {
  identity: string;
  path: Array<string | number>;
  value: unknown;
}

interface QualityFixture {
  expectedIdentities: IdentityExpectation[];
  distinctIdentityPairs: Array<[string, string]>;
  forbiddenNames: string[];
  expectedAliases: Record<string, string[]>;
  initialCharacters: Array<{
    identity: string;
    id: string;
    values: Partial<Character>;
  }>;
  protectedExpectations: ProtectedExpectation[];
  expectedConflicts: Array<{
    characterName: string;
    field: string;
    values: string[];
  }>;
  responses: Array<{ chunk: Chunk; response: CharacterExtractResult }>;
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
  test("固定応答を実経路で検証・マージして品質しきい値を満たす", () => {
    const accepted = fixture.responses.flatMap(({ chunk, response }) => {
      // fixtureも実際のプロバイダ応答と同じ文字列境界を通す。
      const parsed = parseResult(JSON.stringify(response));
      if (!parsed) throw new Error("固定応答をJSONとして解析できません。");
      return validateCharacterExtractResult(parsed, chunk).accepted;
    });

    const initialCharacters = buildInitialCharacters(fixture);
    const merged = mergeExtractedCharacters(initialCharacters, accepted);
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

    for (const forbiddenName of fixture.forbiddenNames) {
      // 集団名詞はモブとして残す方針なので、
      // 禁止対象は「ネームドキャラとして現れないこと」とする。
      expect(
        merged.characters.some(
          (character) => !character.isMob && character.name === forbiddenName
        )
      ).toBe(false);
    }

    // モブは消さずに残す。黙って失われていないことを確認する。
    const mobs = merged.characters.filter((character) => character.isMob);
    expect(mobs.map((character) => character.name)).toEqual(["兵士たち"]);
    for (const [name, aliases] of Object.entries(fixture.expectedAliases)) {
      const character = merged.characters.find((item) => item.name === name);
      expect(character?.aliases).toEqual(expect.arrayContaining(aliases));
    }
    expect(merged.conflicts).toEqual(
      expect.arrayContaining(fixture.expectedConflicts)
    );

    assertDistinctIdentities(fixture, merged.characters);
    assertChapterAndAddressPeriods(fixture, merged.characters);
  });

  test("v2.5の構造化出力契約を公開する", () => {
    expect(CHARACTER_EXTRACT_VERSION).toBe("2.5");
    expect(CHARACTER_EXTRACT_SCHEMA.properties.characters.items.properties)
      .toHaveProperty("entityType");
    expect(CHARACTER_EXTRACT_SCHEMA.properties.characters.items.required)
      .toEqual(expect.arrayContaining(["name", "entityType", "evidence"]));
  });

  test("説明の項目を必須にして、モデルが黙って落とすのを防ぐ", () => {
    // 省略可能にすると、小さいモデルは面倒な項目を出力しない。
    // null は許すので「読み取れなかった」と明示させる形になる
    expect(CHARACTER_EXTRACT_SCHEMA.properties.characters.items.required).toEqual(
      expect.arrayContaining(["role", "personality", "appearance"])
    );
    expect(CHARACTER_EXTRACT_SCHEMA.properties.abilities.items.required).toEqual(
      expect.arrayContaining(["description"])
    );
    expect(CHARACTER_EXTRACT_SCHEMA.properties.locations.items.required).toEqual(
      expect.arrayContaining(["description"])
    );
  });

  test("一覧用の紹介と所属を必ず返させる", () => {
    const character = CHARACTER_EXTRACT_SCHEMA.properties.characters.items;
    expect(character.required).toEqual(
      expect.arrayContaining(["summary", "affiliation"])
    );
    // 長さの上限はスキーマにも書くが、守られる保証はないのでコード側でも切る
    expect(character.properties.summary.maxLength).toBe(50);

    for (const kind of ["abilities", "locations"] as const) {
      expect(CHARACTER_EXTRACT_SCHEMA.properties[kind].items.required).toEqual(
        expect.arrayContaining(["summary"])
      );
    }
  });

  test("人物・能力・場所を1回の呼び出しで返す契約になっている", () => {
    // 種別ごとにAIを呼ぶと同じ本文を3回読ませることになるため、
    // 1チャンク1回で3種類とも受け取る形にしている。
    const properties = CHARACTER_EXTRACT_SCHEMA.properties;
    expect(properties).toHaveProperty("abilities");
    expect(properties).toHaveProperty("locations");
    expect(properties).toHaveProperty("abilitySystem");

    // 捏造を弾けるよう、能力・場所にも逐語根拠を必須にする
    expect(properties.abilities.items.required).toEqual(
      expect.arrayContaining(["name", "evidence"])
    );
    expect(properties.locations.items.required).toEqual(
      expect.arrayContaining(["name", "evidence"])
    );
  });
});

function buildInitialCharacters(fixture: QualityFixture): Character[] {
  const identities = new Map(
    fixture.expectedIdentities.map((identity) => [identity.id, identity])
  );
  return fixture.initialCharacters.map((initial) => {
    const identity = identities.get(initial.identity);
    if (!identity) throw new Error(`未知のfixture identity: ${initial.identity}`);
    const character = emptyCharacter(initial.id, identity.canonicalName);
    Object.assign(character, structuredClone(initial.values));
    return character;
  });
}

function calculateMetrics(
  fixture: QualityFixture,
  characters: Character[]
): QualityMetrics {
  const actualByIdentity = new Map(
    fixture.expectedIdentities.map((identity) => [
      identity.id,
      characters.filter((character) => matchesIdentity(character, identity)),
    ])
  );
  const expectedFound = [...actualByIdentity.values()].filter(
    (actual) => actual.length > 0
  ).length;

  // 許可名リスト方式ではなく、生成された全レコードを期待identityへ照合する。
  // モブ（集団名詞）は意図して残している記録なので、
  // ネームドキャラの純度を測るこの指標からは除く。
  const falsePositives = characters.filter(
    (character) =>
      !character.isMob &&
      fixture.expectedIdentities.every(
        (identity) => !matchesIdentity(character, identity)
      )
  ).length;

  const unintendedCollapses = characters.reduce((count, character) => {
    const matchingGroups = fixture.expectedIdentities.filter((identity) =>
      matchesIdentity(character, identity)
    ).length;
    return count + Math.max(0, matchingGroups - 1);
  }, 0);
  const unconsolidatedGroups = [...actualByIdentity.values()].reduce(
    (count, actual) => count + Math.max(0, actual.length - 1),
    0
  );

  const authorProtectionViolations = fixture.protectedExpectations.reduce(
    (count, expectation) => {
      const actual = actualByIdentity.get(expectation.identity) ?? [];
      if (actual.length !== 1) return count + 1;
      const actualValue = valueAtPath(actual[0], expectation.path);
      return count + Number(!isDeepStrictEqual(actualValue, expectation.value));
    },
    0
  );

  return {
    recall: expectedFound / fixture.expectedIdentities.length,
    falsePositives,
    falseMerges: unintendedCollapses + unconsolidatedGroups,
    authorProtectionViolations,
  };
}

function matchesIdentity(
  character: Pick<Character, "name" | "aliases">,
  identity: IdentityExpectation
): boolean {
  const actualNames = new Set([character.name, ...character.aliases]);
  return identity.members.some((member) => actualNames.has(member));
}

function valueAtPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function assertDistinctIdentities(
  fixture: QualityFixture,
  characters: Character[]
): void {
  const identities = new Map(
    fixture.expectedIdentities.map((identity) => [identity.id, identity])
  );
  for (const [leftId, rightId] of fixture.distinctIdentityPairs) {
    const left = identities.get(leftId);
    const right = identities.get(rightId);
    if (!left || !right) throw new Error("distinctIdentityPairsが不正です。");
    const leftRecord = characters.find((character) =>
      matchesIdentity(character, left)
    );
    const rightRecord = characters.find((character) =>
      matchesIdentity(character, right)
    );
    expect(leftRecord?.id).toBeDefined();
    expect(rightRecord?.id).toBeDefined();
    expect(leftRecord?.id).not.toBe(rightRecord?.id);
  }
}

function assertChapterAndAddressPeriods(
  fixture: QualityFixture,
  characters: Character[]
): void {
  for (const identity of fixture.expectedIdentities) {
    const matches = characters.filter((character) =>
      matchesIdentity(character, identity)
    );
    expect(matches, identity.id).toHaveLength(1);
    expect(matches[0].appearedChapters, identity.id).toEqual(
      identity.appearedChapters
    );

    for (const expected of identity.addressTerms ?? []) {
      const address = matches[0].addressTerms.find(
        (item) => item.targetName === expected.targetName
      );
      const form = address?.forms.find((item) => item.term === expected.term);
      expect(form, `${identity.id}:${expected.targetName}:${expected.term}`)
        .toMatchObject({
          firstChapter: expected.firstChapter,
          lastChapter: expected.lastChapter,
        });
    }
  }
}
