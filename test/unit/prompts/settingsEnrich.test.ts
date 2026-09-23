import { describe, expect, test } from "vitest";
import {
  buildEnrichPrompt,
  buildEnrichSchema,
  ENRICHABLE_FIELDS,
  MISATTRIBUTED_KEY,
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

    expect(schema.required).toEqual([
      ...ENRICHABLE_FIELDS.character.map((field) => field.key),
      MISATTRIBUTED_KEY,
    ]);
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

  test("留意点が無いときは、従来どおりの依頼文にする", () => {
    // 空でも押せる操作なので、書かなかったときに指示が変わってはいけない
    const prompt = buildEnrichPrompt({
      workTitle: "テスト作品",
      kind: "character",
      target: {
        kindLabel: "登場人物",
        name: "アジャーノ",
        currentSettings: "名前: アジャーノ",
      },
      excerpts: [{ label: "第1話", text: "アジャーノは頷いた。" }],
    });

    expect(prompt).not.toContain("作者からの留意点");
    expect(prompt).not.toContain("混入している可能性");
  });
});

/**
 * AIで再読込（設計書6.31.1）。
 *
 * 実データで、アジャーノの記録に別人（皇子）の場面の記述が入っていた。
 * 作者が留意点を書けるようにし、混入と判断されたものは
 * 項目には入れず、分けて返させる。
 */
describe("留意点つきの再読込", () => {
  const withNotes = (notes: string) =>
    buildEnrichPrompt({
      workTitle: "テスト作品",
      kind: "character",
      target: {
        kindLabel: "登場人物",
        name: "アジャーノ",
        currentSettings: "名前: アジャーノ",
      },
      excerpts: [{ label: "第5話", text: "アジャーノは頭を垂れた。" }],
      notes,
    });

  test("留意点を原文のまま渡す", () => {
    // 言い換えると、作者が名指しした相手（〇〇）が失われる
    const prompt = withNotes("他の登場人物の殿下の情報が混入しています。");

    expect(prompt).toContain("作者からの留意点");
    expect(prompt).toContain("他の登場人物の殿下の情報が混入しています。");
  });

  test("確信できる記述だけで書き直させる", () => {
    const prompt = withNotes("殿下の情報が混入しています。");

    expect(prompt).toContain("混入している可能性");
    expect(prompt).toContain("確信できる記述だけ");
  });

  test("はじいた記述の書き方を、必ず指示する", () => {
    // 留意点が無いときも項目自体はスキーマにあるので、
    // 何を入れる欄なのかは常に説明しておく
    const prompt = buildEnrichPrompt({
      workTitle: "テスト作品",
      kind: "character",
      target: {
        kindLabel: "登場人物",
        name: "アジャーノ",
        currentSettings: "名前: アジャーノ",
      },
      excerpts: [{ label: "第5話", text: "アジャーノは頭を垂れた。" }],
    });

    expect(prompt).toContain(MISATTRIBUTED_KEY);
    expect(prompt).toContain("belongsTo");
    expect(prompt).toContain("evidence");
    // 逐語でないと、本文との照合ができない
    expect(prompt).toContain("一字一句");
    // 空配列を返す道を書いておかないと、無理に何か入れてくる
    expect(prompt).toContain("空の配列");
  });

  test("はじいた記述は、4項目すべてを必須にする", () => {
    // 誰のものか・どの項目か・何を・どこに書いてあるか。
    // 1つでも欠けると作者は行き先を決められない。
    // 任意にすると小さいモデルが落とす、はこの作品の定石
    const schema = buildEnrichSchema("character") as {
      properties: Record<
        string,
        { type: string; items?: { required?: string[] } }
      >;
    };

    const misattributed = schema.properties[MISATTRIBUTED_KEY];
    expect(misattributed.type).toBe("array");
    expect(misattributed.items?.required).toEqual([
      "belongsTo",
      "field",
      "value",
      "evidence",
    ]);
  });

  test("留意点が無いときも、はじく場所はスキーマに置く", () => {
    // 指示のあるときだけ項目を出し入れすると、
    // モデルによっては「知らない項目」として黙って落とす
    for (const kind of ["character", "ability", "location"] as const) {
      const schema = buildEnrichSchema(kind) as { required: string[] };
      expect(schema.required).toContain(MISATTRIBUTED_KEY);
    }
  });
});

describe("項目を充実させる提案（続き）", () => {
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
