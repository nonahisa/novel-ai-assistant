import { describe, expect, test } from "vitest";
import {
  CONTRADICTION_TOM_TOOLS,
  buildContradictionCheckPrompt,
  replyToContradictionToolCall,
} from "../../../src/prompts/contradictionCheck";
import { normalizeToolCalls } from "../../../src/ai/toolCalls";

/**
 * 矛盾検知（P-12）で、相手の立場に立つ構えを**道具（tool）としても**渡す。
 *
 * ## 何を固めるか
 *
 * 1. 道具は2本（`perspective_taking` / `joint_attention`）で、必須の引数が揃っている
 * 2. **説明は英語のまま**——Theory of Mind と joint attention は英語の学習
 *    データで濃い術語で、訳すとモデルの中でその概念に結びつきにくくなる
 * 3. **プロンプト本文のべた書きは残す。** 道具は概念を常在させる役、本文の段は
 *    書かせる場で、役が違う。どちらが効いているかは実データで測ってから決める
 * 4. 呼ばれたときの受け答えは、**モデル自身が書いた中身をそのまま返す**
 *    （`familiar-ai` と同じく、こちらで何かを計算するものではない）
 */

/** 道具1本を名前で引く（並び順に依存させない） */
function toolNamed(name: string): {
  function: { description: string; parameters: { required: readonly string[] } };
} {
  const found = CONTRADICTION_TOM_TOOLS.find(
    (tool) => tool.function.name === name
  );
  if (!found) throw new Error(`道具 ${name} がありません`);
  return found as unknown as {
    function: { description: string; parameters: { required: readonly string[] } };
  };
}

describe("道具の定義（P-12）", () => {
  test("2本あり、Ollamaの形をしている", () => {
    expect(CONTRADICTION_TOM_TOOLS).toHaveLength(2);
    for (const tool of CONTRADICTION_TOM_TOOLS) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.parameters.type).toBe("object");
    }
  });

  test("perspective_taking は who と asThem を必須にする", () => {
    expect(toolNamed("perspective_taking").function.parameters.required).toEqual([
      "who",
      "asThem",
    ]);
  });

  test("joint_attention は target を必須にする", () => {
    expect(toolNamed("joint_attention").function.parameters.required).toEqual([
      "target",
    ]);
  });

  test("説明は英語のまま（訳さない）", () => {
    // 日本語の文字が1つでも入っていたら、訳されたということ
    const japanese = /[ぁ-んァ-ン一-龥]/;
    for (const tool of CONTRADICTION_TOM_TOOLS) {
      expect(japanese.test(tool.function.description)).toBe(false);
    }
    expect(toolNamed("perspective_taking").function.description).toContain(
      "Theory of Mind"
    );
    expect(toolNamed("joint_attention").function.description).toContain(
      "Joint attention"
    );
  });

  test("プロンプト本文のべた書きは残っている（道具と役が違う）", () => {
    const text = buildContradictionCheckPrompt({
      chapterLabel: "第1話",
      chunkTextWithLineNumbers: "1: 本文",
      characterDetails: "灯：左腕を骨折している",
      locationDetails: "",
      worldviewSummary: "",
      previousSynopses: "",
      categories: ["人物"],
    });
    expect(text).toContain("perspective_taking");
    expect(text).toContain("joint_attention");
  });
});

describe("道具が呼ばれたときの受け答え", () => {
  test("perspective_taking：asThem をそのまま添えて返す", () => {
    const reply = replyToContradictionToolCall({
      name: "perspective_taking",
      arguments: { who: "灯", asThem: "俺は左腕を折っている" },
    });
    expect(reply).toContain("灯");
    expect(reply).toContain("俺は左腕を折っている");
  });

  test("joint_attention：target をそのまま添えて返す", () => {
    const reply = replyToContradictionToolCall({
      name: "joint_attention",
      arguments: { target: "折れた腕" },
    });
    expect(reply).toContain("折れた腕");
  });

  test("引数が無くても返事はする（会話を噛み合わせたまま次へ進ませる）", () => {
    expect(
      replyToContradictionToolCall({ name: "perspective_taking", arguments: {} })
    ).toBeTruthy();
    expect(
      replyToContradictionToolCall({ name: "joint_attention", arguments: {} })
    ).toBeTruthy();
  });

  test("知らない道具は undefined（呼ぶ側が既定の返事を入れる）", () => {
    expect(
      replyToContradictionToolCall({ name: "unknown_tool", arguments: {} })
    ).toBeUndefined();
  });

  test("Ollamaが返した形から、そのまま受け答えへ繋がる", () => {
    // **経路を通して確かめる。** 揃える部品（`normalizeToolCalls`）と
    // 受け答えの形が食い違うと、道具を呼ばれた瞬間にだけ壊れる
    const calls = normalizeToolCalls([
      { function: { name: "joint_attention", arguments: '{"target":"折れた腕"}' } },
    ]);
    expect(calls).toHaveLength(1);
    expect(replyToContradictionToolCall(calls[0])).toContain("折れた腕");
  });
});
