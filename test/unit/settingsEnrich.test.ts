import { describe, expect, test } from "vitest";
import {
  buildEnrichPrompt,
  buildEnrichSchema,
  ENRICHABLE_FIELDS,
} from "../../src/prompts/settingsEnrich";
import { SUMMARY_MAX_CHARS } from "../../src/core/summaryLimit";

describe("項目を充実させる提案", () => {
  test("種別ごとに提案する項目を決める", () => {
    const keys = (kind: "character" | "ability" | "location") =>
      ENRICHABLE_FIELDS[kind].map((field) => field.key);

    expect(keys("character")).toContain("personality");
    expect(keys("character")).toContain("appearance");
    // 人物に「代償」を聞いても意味がない
    expect(keys("character")).not.toContain("cost");
    expect(keys("ability")).toContain("cost");
    expect(keys("location")).toContain("region");
  });

  test("編集できない項目は提案させない", () => {
    // 登場話数や抽出根拠は本文から機械的に求まる値。
    // AIに書かせると、次の抽出で戻されて食い違う
    for (const kind of ["character", "ability", "location"] as const) {
      const keys = ENRICHABLE_FIELDS[kind].map((field) => field.key);
      expect(keys).not.toContain("appearedChapters");
      expect(keys).not.toContain("evidence");
      expect(keys).not.toContain("authorNotes");
    }
  });

  test("全項目を必須にして、面倒な項目を落とさせない", () => {
    const schema = buildEnrichSchema("character") as {
      required: string[];
      properties: Record<string, { type: unknown; maxLength?: number }>;
    };

    expect(schema.required).toEqual(
      ENRICHABLE_FIELDS.character.map((field) => field.key)
    );
    // null は許す。「読み取れなかった」と明示させるため
    expect(schema.properties.role.type).toEqual(["string", "null"]);
  });

  test("文字数の上限をスキーマに載せる", () => {
    const schema = buildEnrichSchema("character") as {
      properties: Record<string, { maxLength?: number }>;
    };

    expect(schema.properties.summary.maxLength).toBe(SUMMARY_MAX_CHARS);
    expect(schema.properties.role.maxLength).toBeUndefined();
  });

  test("プロンプトに現在の設定と抜粋と項目の説明を載せる", () => {
    const prompt = buildEnrichPrompt({
      workTitle: "テスト作品",
      kind: "character",
      target: {
        kindLabel: "登場人物",
        name: "リンセップ・アウクト",
        currentSettings: "名前: リンセップ・アウクト\n役割: 王女",
      },
      excerpts: [{ label: "第1話", text: "リンは扇を広げた。" }],
    });

    expect(prompt).toContain("リンセップ・アウクト");
    expect(prompt).toContain("役割: 王女");
    expect(prompt).toContain("--- 第1話 ---");
    expect(prompt).toContain("personality（性格）");
    // 分析口調ではなく設定として書かせる
    expect(prompt).toContain("設定として書いてください");
    // 推測で埋めさせない
    expect(prompt).toContain("読み取れない項目は null");
  });

  test("関与度の高い変化だけを紹介へ書かせる", () => {
    // 紹介は80字しかない。「課長になった」と「髪を切った」が同じ形で並ぶと、
    // AIは書きやすいほう（外見）から埋める（2026-08-26）
    const prompt = buildEnrichPrompt({
      workTitle: "テスト作品",
      kind: "character",
      target: {
        kindLabel: "登場人物",
        name: "文佳",
        currentSettings: `名前: 文佳
変化（role）: 新人（第1〜3話）→ 課長（第7、8話）［関与度 65（高）］`,
      },
      excerpts: [{ label: "第7話", text: "文佳は辞令を受け取った。" }],
    });

    expect(prompt).toContain("関与度");
    expect(prompt).toContain("（高）だけ");
    // 印をそのまま値に書き写してくるのが、この作品で繰り返し起きている失敗
    expect(prompt).toContain("値に書かないでください");
  });

  test("抜粋が無いことを隠さない", () => {
    const prompt = buildEnrichPrompt({
      workTitle: "テスト作品",
      kind: "location",
      target: { kindLabel: "場所", name: "図書塔", currentSettings: "名前: 図書塔" },
      excerpts: [],
    });

    expect(prompt).toContain("該当する場面が見つかりませんでした");
  });
});
