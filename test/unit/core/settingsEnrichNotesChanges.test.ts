import { describe, expect, test } from "vitest";
import { describeEnrichTarget } from "../../../src/core/settingsEnrichCheck";
import { describeCharacter } from "../../../src/core/settingsSummary";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { buildEnrichPrompt } from "../../../src/prompts/settingsEnrich";

/**
 * AIで再読込の留意点を、変化の記録にも効かせる（作者の裁定 2026-10-15 の6）。
 *
 * 発端：アジャーノに「他の登場人物『殿下』の情報が混入しています。」と書いて
 * 再読込しても、変化の記録にある第12話「帝国の皇子」を AI が根拠として持ち越し、
 * 紹介に「第12話から皇子」と書いた（26b・31b とも、4回中4回）。
 * 留意点があるときは**変化の記録を材料から外す**。記録そのものは書き換えない。
 */

function ajano(): Character {
  const character = emptyCharacter("char_007", "アジャーノ");
  character.summary = "オーク肉を納品しに来た人物。";
  character.role = "納品人";
  character.appearedChapters = [5, 10, 12, 15];
  character.changes = [
    {
      field: "role",
      value: "B級冒険者",
      chapters: [10],
      timepointId: null,
      note: null,
      evidence: null,
      source: "extracted",
    },
    {
      field: "role",
      value: "皇子",
      chapters: [12],
      timepointId: null,
      note: null,
      evidence: null,
      source: "extracted",
    },
  ];
  return character;
}

const context = { customFields: [], characters: [] };

describe("留意点があるとき", () => {
  test("【現在の設定】に変化の記録を出さない（第12話の「皇子」が材料に入らない）", () => {
    const text = describeEnrichTarget("character", ajano(), {
      ...context,
      notes: "他の登場人物『殿下』の情報が混入しています。",
    });
    expect(text).not.toContain("変化（");
    expect(text).not.toContain("皇子");
    // 変化以外の項目はそのまま渡す
    expect(text).toContain("役割: 納品人");
  });

  test("組んだ頼みにも変化の記録と関与度の印が入らない", () => {
    const record = ajano();
    const notes = "他の登場人物『殿下』の情報が混入しています。";
    const prompt = buildEnrichPrompt({
      workTitle: "作品",
      kind: "character",
      target: {
        kindLabel: "登場人物",
        name: record.name,
        currentSettings: describeEnrichTarget("character", record, { ...context, notes }),
      },
      excerpts: [],
      notes,
    });
    const current = prompt.slice(prompt.indexOf("【現在の設定】"), prompt.indexOf("【本文の抜粋】"));
    expect(current).not.toContain("変化（");
    expect(current).not.toContain("［関与度");
    // 渡していない変化について書けと頼まない（26b が「（高）」だけを紹介へ写した）
    expect(prompt).not.toContain("関与度");
    expect(prompt).not.toContain("（高）");
    expect(prompt).toContain("その人物が何者かが一目で分かる紹介。まず役割と立場を書く。");
  });

  test("記録そのものは書き換えない（材料から外すだけ。実装ルール2）", () => {
    const record = ajano();
    const before = JSON.stringify(record);
    describeEnrichTarget("character", record, { ...context, notes: "混入しています" });
    expect(JSON.stringify(record)).toBe(before);
    expect(record.changes).toHaveLength(2);
  });
});

describe("留意点が無いとき・ほかの道", () => {
  test("留意点が空なら、これまでどおり変化の記録を渡す", () => {
    for (const notes of [undefined, "", "   "]) {
      const text = describeEnrichTarget("character", ajano(), { ...context, notes });
      expect(text, String(notes)).toContain("変化（role）");
    }
  });

  test("留意点が無い回は、変化の段落と関与度の説明をこれまでどおり送る", () => {
    const record = ajano();
    const prompt = buildEnrichPrompt({
      workTitle: "作品",
      kind: "character",
      target: {
        kindLabel: "登場人物",
        name: record.name,
        currentSettings: describeEnrichTarget("character", record, context),
      },
      excerpts: [],
    });
    expect(prompt).toContain("現在の設定に［関与度 ◯（高）］と付いた変化があれば");
    expect(prompt).toContain("現在の設定に**変化**が並んでいることがあります");
    expect(prompt).toContain("変化（role）");
  });

  test("相談（P-18）などが使う describeCharacter の既定は変えない", () => {
    expect(describeCharacter(ajano())).toContain("変化（role）");
  });
});
