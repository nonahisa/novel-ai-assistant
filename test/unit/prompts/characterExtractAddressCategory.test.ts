import { describe, expect, test } from "vitest";
import { ADDRESS_CATEGORY_GUIDES } from "../../../src/core/addressCategory";
import {
  CHARACTER_EXTRACT_SCHEMA,
  CHARACTER_EXTRACT_VERSION,
  buildCharacterExtractPrompt,
} from "../../../src/prompts/characterExtract";

/**
 * P-04a 5.12：呼称の区分の説明と、一人称を必須にしたこと
 * （作者の裁定 2026-10-26「直して測ってから入れる」）。
 */

const prompt = buildCharacterExtractPrompt({
  chunkText: "（本文）",
  chapterLabel: "第1話",
  knownCharacterNames: [],
});

// 節の名前は規則の文中でも引かれる（「【呼称の抽出ルール】）。」）ので、行頭の見出しで切る
const personRules = prompt.slice(
  prompt.indexOf("\n【登場人物の抽出ルール】"),
  prompt.indexOf("\n【呼称の抽出ルール】")
);
const addressRules = prompt.slice(
  prompt.indexOf("\n【呼称の抽出ルール】"),
  prompt.indexOf("\n【関係の抽出ルール】")
);

const personRequired: readonly string[] =
  CHARACTER_EXTRACT_SCHEMA.properties.characters.items.required;

describe("呼称の区分（addressTerms.category）の説明", () => {
  test("呼称の抽出ルールに、区分ごとの名前と意味が1行ずつある", () => {
    expect(addressRules).toContain("category");
    for (const guide of ADDRESS_CATEGORY_GUIDES) {
      expect(addressRules).toContain(`・${guide.label}：${guide.meaning}`);
    }
  });

  test("当てはまらないときは null と書いてある（作り話を誘わない）", () => {
    const flat = addressRules.replace(/[\s*]/gu, "");
    expect(flat).toContain("どれにも当たらなければnull");
  });

  test("区分の説明に固有の呼び名（「」の語）を置かない", () => {
    // 例の語は本文に無いまま答えに返ってくる（失敗3）。区分は型の名前だけで示す
    for (const guide of ADDRESS_CATEGORY_GUIDES) {
      expect(guide.label).not.toMatch(/[「」]/u);
      expect(guide.meaning).not.toMatch(/[「」]/u);
    }
  });
});

describe("一人称（firstPerson）", () => {
  test("必須にしない（5.13。必須にすると別名が押し出された）、null は許す", () => {
    expect(personRequired).not.toContain("firstPerson");
    const field =
      CHARACTER_EXTRACT_SCHEMA.properties.characters.items.properties.firstPerson;
    expect(field.type).toContain("null");
  });

  test("人物の抽出ルールに書き方があり、読み取れなければ null と書いてある", () => {
    const start = personRules.indexOf("- firstPerson");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = personRules.indexOf("\n- ", start + 1);
    const rule = personRules
      .slice(start, next < 0 ? undefined : next)
      .replace(/[\s*]/gu, "");
    expect(rule).toContain("本文の表記のまま");
    expect(rule).toContain("null");
    // 例の一人称を置かない（返ってきた語が本文に無くても検算が当たらないため）
    expect(rule).not.toMatch(/[「」]/u);
  });
});

describe("必須にしない欄（理由はスキーマのコメントと設計書 P-04a）", () => {
  test.each([
    // 必須に入れても別名は増えなかった（2026-09-08 09:40 の実測）
    "aliases",
    "addressTerms",
    // 仮名の名前は名前から導ける。必須にすると推測の読みが増え、読みの食い違いが増える
    "reading",
    // null の無い真偽値。必須にすると true を付けさせる圧になり、人物が一覧の脇へ回る
    "isMob",
  ])("%s は必須にしない", (field) => {
    expect(personRequired).not.toContain(field);
  });
});

test("版を上げた", () => {
  expect(CHARACTER_EXTRACT_VERSION).toBe("5.13");
});
