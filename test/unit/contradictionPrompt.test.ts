import { describe, expect, test } from "vitest";
import {
  buildContradictionCheckPrompt,
  CONTRADICTION_CATEGORIES,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  LIGHT_CATEGORIES,
} from "../../src/prompts/contradictionCheck";
import { buildTypoIssuePanelHtml } from "../../src/views/typoIssuePanelHtml";

/**
 * 矛盾検知のプロンプトと画面（設計書6.10.1）。
 *
 * **設定側が古い可能性を常に残す**のがこの機能の要である。
 * 断定させると、作者は正しい設定を本文に合わせて壊すことになる。
 */
function input(overrides: Partial<Parameters<typeof buildContradictionCheckPrompt>[0]> = {}) {
  return {
    chapterLabel: "第7話",
    chunkTextWithLineNumbers: "12: 「わたくしが参りますわ」",
    characterDetails: "月島 灯：一人称は「僕」",
    locationDetails: "",
    worldviewSummary: "",
    previousSynopses: "",
    categories: CONTRADICTION_CATEGORIES,
    ...overrides,
  };
}

describe("プロンプト", () => {
  test("断定させない", () => {
    const prompt = buildContradictionCheckPrompt(input());

    expect(prompt).toContain("設定側が誤っている可能性も考慮");
    expect(prompt).toContain("断定形にしないこと");
  });

  test("意図した変化と未回収の伏線を、矛盾と呼ばせない", () => {
    const prompt = buildContradictionCheckPrompt(input());

    expect(prompt).toContain("意図的に描かれた変化");
    expect(prompt).toContain("未回収の伏線は矛盾ではありません");
  });

  test("設定が示されていないことは指摘させない", () => {
    // 照らし合わせる相手が無いものは矛盾とは言えない
    expect(buildContradictionCheckPrompt(input())).toContain(
      "照らし合わせる相手が無いものは矛盾とは言えません"
    );
  });

  test("材料が無い欄は「登録されていません」と書く", () => {
    // 空欄のまま渡すと、モデルは何かを埋めようとする
    const prompt = buildContradictionCheckPrompt(
      input({ locationDetails: "", worldviewSummary: "" })
    );

    expect(prompt).toContain("（登録されていません）");
  });

  test("見る観点を絞れる", () => {
    // 小さいモデルでは1回の負荷を下げないと検出漏れが増える
    const prompt = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES })
    );

    expect(prompt).toContain("1. 人物：");
    expect(prompt).toContain("3. 時系列：");
    expect(prompt).not.toContain("世界法則：");
  });

  test("絞った観点だけを出力の選択肢に出す", () => {
    // 渡していない観点を返されると、検証で弾くことになる
    const prompt = buildContradictionCheckPrompt(
      input({ categories: LIGHT_CATEGORIES })
    );

    expect(prompt).toContain('"category": "人物|状態|時系列"');
  });

  test("引用は本文から写させる", () => {
    // 設定側の文を引いて「本文にこうある」と言うのを防ぐ
    expect(buildContradictionCheckPrompt(input())).toContain("本文からそのまま写す");
  });

  test("システムプロンプトで、迷ったら黙らせる", () => {
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT).toContain(
      "確信が持てないものは指摘しない"
    );
  });
});

describe("出力の形", () => {
  test("すべての項目を必須にする", () => {
    // 任意項目にすると、小さいモデルは埋めずに落とす
    const properties = Object.keys(
      CONTRADICTION_CHECK_SCHEMA.properties.contradictions.items.properties
    );

    expect(
      CONTRADICTION_CHECK_SCHEMA.properties.contradictions.items.required
    ).toEqual(properties);
  });

  test("置き換え案を持たない", () => {
    // どちらが正しいかは作者にしか決められない
    const properties = Object.keys(
      CONTRADICTION_CHECK_SCHEMA.properties.contradictions.items.properties
    );

    expect(properties).not.toContain("suggestion");
    expect(properties).toContain("settingSays");
    expect(properties).toContain("textSays");
  });
});

describe("画面", () => {
  const HTML = buildTypoIssuePanelHtml("test-nonce", "vscode-resource:");

  function script(): string {
    const found = HTML.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
    expect(found, "スクリプトが見つからない").toBeTruthy();
    return found![1];
  }

  test("スクリプトがJavaScriptとして読める", () => {
    expect(() => new Function(script())).not.toThrow();
  });

  test("矛盾には適用ボタンを出さない", () => {
    const code = script();
    const render = code.slice(
      code.indexOf("function renderContradiction"),
      code.indexOf("function renderItem")
    );

    expect(render).not.toContain("data-action=\"apply\"");
    expect(render).toContain("設定資料を見る");
    expect(render).toContain("本文を見る");
  });

  test("設定と本文を並べて見せる", () => {
    const code = script();

    expect(code).toContain("設定では");
    expect(code).toContain("本文では");
  });

  test("矛盾では「まとめて適用」を隠す", () => {
    expect(script()).toContain("message.canApplyAll === false");
  });
});
