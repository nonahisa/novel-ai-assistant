import { describe, expect, test, vi } from "vitest";

// 機能側（`checkOpening.ts`）は VS Code API を静的importしている。
// 見たいのは整形だけなので、最小限の形だけ渡して読み込めるようにする
vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: {},
  workspace: { fs: {} },
  commands: {},
}));

import {
  buildOpeningCheckPrompt,
  OPENING_CHECK_SCHEMA,
  OPENING_ELEMENTS,
  OPENING_EXCERPT_MAX_CHARS,
  parseOpeningCheck,
  type OpeningCheckResult,
} from "../../../src/prompts/openingCheck";
import { renderOpeningCheck } from "../../../src/features/checkOpening";

/**
 * 冒頭診断（P-24、設計書6.30）。
 *
 * 見るのは3つ。
 *
 * 1. **指示語のなぞりを根拠にしない**——「なし」だけの根拠を表へ並べると、
 *    判定の裏づけがあるように見える（この作品で繰り返し起きた失敗3）
 * 2. **意図的な保留を、伝わらないものと同じ印にしない**——冒頭で伏せるのは
 *    技法なので、欠点として並べると作者は直さなくてよいものを直す
 * 3. **読めなかったものを、答えとして出さない**——「引きが無い」と
 *    「AIが答えなかった」は別のことである
 */

/** 6要素すべてが伝わる、という応答を作る */
function allConveyed(): unknown {
  return {
    elements: OPENING_ELEMENTS.map((element) => ({
      element,
      conveyed: true,
      note: `${element}の根拠`,
    })),
    hook: { present: true, note: "母の遺した手紙が読めない" },
    advice: "「なぜ」が伝わっていない。",
  };
}

function parsed(value: unknown): OpeningCheckResult {
  const result = parseOpeningCheck(JSON.stringify(value));
  if (!result) throw new Error("読み取れませんでした");
  return result;
}

function report(result: OpeningCheckResult, excerptChars = 2870): string {
  return renderOpeningCheck({
    workTitle: "図書塔の魔女",
    excerptChars,
    result,
  });
}

/** 表の行から、その要素の印と根拠を取り出す */
function row(markdown: string, element: string): string {
  const line = markdown
    .split("\n")
    .find((entry) => entry.startsWith(`| ${element} |`));
  if (!line) throw new Error(`「${element}」の行がありません`);
  return line;
}

describe("応答の読み取り", () => {
  test("指示語のなぞりは根拠にしない", () => {
    // プロンプトに書いた言葉が、そのまま中身として返ってくる。
    // 「なし」「特になし」だけの根拠は、根拠ではない
    const result = parsed({
      elements: [
        { element: "いつ", conveyed: false, note: "なし" },
        { element: "どこで", conveyed: false, note: "特になし" },
        { element: "誰が", conveyed: true, note: "「灯」と名乗る" },
      ],
      hook: { present: false, note: "変更なし" },
      advice: "変更不要",
    });

    expect(result.elements[0].note).toBe("");
    expect(result.elements[1].note).toBe("");
    // 本物の根拠は残す
    expect(result.elements[2].note).toBe("「灯」と名乗る");
    expect(result.hook?.note).toBe("");
    expect(result.advice).toBe("");
  });

  test("コードフェンスや前置きが付いていても読める", () => {
    const text =
      "はい、診断結果です。\n```json\n" +
      JSON.stringify(allConveyed()) +
      "\n```\n";

    expect(parseOpeningCheck(text)?.elements).toHaveLength(
      OPENING_ELEMENTS.length
    );
  });

  test("壊れたJSONは undefined", () => {
    expect(parseOpeningCheck("{ elements: [")).toBeUndefined();
    expect(parseOpeningCheck("診断できませんでした")).toBeUndefined();
    expect(parseOpeningCheck("")).toBeUndefined();
  });

  test("6要素が1つも読めなければ undefined", () => {
    // 診断の本体がそこなので、表が空の報告を見せても役に立たない
    expect(
      parseOpeningCheck(
        JSON.stringify({ elements: [], hook: { present: true, note: "謎" }, advice: "" })
      )
    ).toBeUndefined();
    expect(
      parseOpeningCheck(
        JSON.stringify({ elements: [{ element: "いつごろ", conveyed: true, note: "朝" }] })
      )
    ).toBeUndefined();
  });

  test("期待感と総評が欠けても、6要素は残す", () => {
    // 1項目のために診断まるごとを捨てるほうが損である
    const result = parsed({
      elements: [{ element: "誰が", conveyed: true, note: "「灯」と名乗る" }],
    });

    expect(result.elements).toHaveLength(1);
    // **読めなかったことを「引きが無い」に落とさない**
    expect(result.hook).toBeNull();
    expect(result.advice).toBe("");
  });

  test("同じ要素を2回返しても、先に来たものを残す", () => {
    const result = parsed({
      elements: [
        { element: "いつ", conveyed: true, note: "「開架の夜」とある" },
        { element: "いつ", conveyed: false, note: "言い直し" },
      ],
      hook: { present: false, note: "" },
      advice: "",
    });

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].note).toBe("「開架の夜」とある");
  });
});

describe("構造化出力のスキーマ", () => {
  /** そのオブジェクト定義の項目が、すべて required に並んでいるか */
  function requiresAll(schema: {
    properties: Record<string, unknown>;
    required: readonly string[];
  }): void {
    expect([...schema.required].sort()).toEqual(
      Object.keys(schema.properties).sort()
    );
  }

  test("すべての項目が required（任意にすると小さいモデルが埋めずに落とす）", () => {
    requiresAll(OPENING_CHECK_SCHEMA);
    requiresAll(OPENING_CHECK_SCHEMA.properties.elements.items);
    requiresAll(OPENING_CHECK_SCHEMA.properties.hook);
  });

  test("要素名は6つに限る", () => {
    expect(OPENING_CHECK_SCHEMA.properties.elements.items.properties.element.enum)
      .toEqual(OPENING_ELEMENTS);
  });
});

describe("プロンプト", () => {
  test("材料が無いことを黙って隠さない", () => {
    const prompt = buildOpeningCheckPrompt({
      workTitle: "図書塔の魔女",
      genre: "",
      logline: "",
      openingText: "本文",
    });

    expect(prompt).toContain("（未設定）");
    expect(prompt).toContain(String(OPENING_EXCERPT_MAX_CHARS));
  });

  test("作文をさせず、意図的な保留を欠点として扱わせない", () => {
    const prompt = buildOpeningCheckPrompt({
      workTitle: "作品",
      genre: "ハイファンタジー",
      logline: "ログライン",
      openingText: "本文",
    });

    expect(prompt).toContain("書き換え案");
    expect(prompt).toContain("意図的な保留");
    expect(prompt).toContain("すべて揃っている必要はありません");
    // 造語を誤りとして扱わせない（この作品の共通の約束）
    expect(prompt).toContain("造語");
  });
});

describe("レポートの整形", () => {
  test("伝わるものは ◯", () => {
    expect(row(report(parsed(allConveyed())), "いつ")).toContain("◯");
  });

  test("意図的に伏せているものは △（伝わらないものと同じ印にしない）", () => {
    const markdown = report(
      parsed({
        elements: [
          {
            element: "誰が",
            conveyed: false,
            note: "意図的な保留。名前を明かさない一人称である",
          },
          { element: "なぜ", conveyed: false, note: "動機が分からないまま" },
        ],
        hook: { present: true, note: "謎がある" },
        advice: "総評",
      })
    );

    expect(row(markdown, "誰が")).toContain("△");
    expect(row(markdown, "なぜ")).toContain("—");
    expect(row(markdown, "なぜ")).not.toContain("△");
  });

  test("返らなかった要素も行を残し、判定が無いことを書く", () => {
    // 行ごと落とすと、6要素のうち何を見たのかが分からなくなる
    const markdown = report(
      parsed({
        elements: [{ element: "いつ", conveyed: true, note: "「開架の夜」" }],
      })
    );

    for (const element of OPENING_ELEMENTS) {
      expect(row(markdown, element).length).toBeGreaterThan(0);
    }
    expect(row(markdown, "どこで")).toContain("判定が返りませんでした");
  });

  test("引きの判定が返らなければ、「無い」とは書かない", () => {
    const markdown = report(parsed({ elements: [{ element: "いつ", conveyed: true, note: "朝" }] }));

    expect(markdown).toContain("## 続きを読みたくなる引き");
    expect(markdown).toContain("判定が返りませんでした");
    expect(markdown).not.toContain("引きは見当たりませんでした");
  });

  test("引きが無いと判定されたときは、そう書く", () => {
    const markdown = report(
      parsed({
        elements: [{ element: "いつ", conveyed: true, note: "朝" }],
        hook: { present: false, note: "日常の描写が続く" },
        advice: "総評",
      })
    );

    expect(markdown).toContain("引きは見当たりませんでした");
    expect(markdown).toContain("日常の描写が続く");
  });

  test("見出しと末尾の断りを出す", () => {
    const markdown = report(parsed(allConveyed()), 2870);

    expect(markdown.startsWith("# 冒頭診断：図書塔の魔女")).toBe(true);
    expect(markdown).toContain("## 読者に伝わるか（5W1H）");
    expect(markdown).toContain("## 総評");
    // **どこまで見たのかを必ず添える。** 全体を読んだ診断だと受け取られると、
    // 「後半で説明している」ものまで欠点に見える
    expect(markdown).toContain(
      "この診断は冒頭 2870 字だけを見ています。判断するのは作者です。"
    );
  });

  test("根拠に縦棒が入っても表が崩れない", () => {
    const markdown = report(
      parsed({
        elements: [
          { element: "いつ", conveyed: true, note: "「夜|明け」と書かれている" },
        ],
        hook: { present: false, note: "" },
        advice: "",
      })
    );

    // 逃がすだけで、中身は消さない
    expect(row(markdown, "いつ")).toContain("\\|");
    expect(row(markdown, "いつ")).toContain("夜");
    expect(row(markdown, "いつ").split(" | ")).toHaveLength(3);
  });
});

/**
 * 助言の構え（プロンプト設計書1.9、作者の方針 2026-09-24）。
 *
 * 「高い水準でバランスをとっているとき、無理に助言を言わなくてもいい。
 * ほめることができる場所は、省略せずきちんとほめて」。
 */
describe("助言の構え（1.9）：無理に言わない・ほめる所は省かない", () => {
  const opening =
    "開架の夜、図書塔の灯が一つずつ消えていく。\n" +
    "灯は母の遺した手紙を胸に抱えたまま、最上階の扉の前に立っていた。\n" +
    "読めない文字で書かれたその手紙だけが、母と彼女を繋いでいる。";

  function withStrengths(advice: unknown, strengths: unknown): string {
    return JSON.stringify({
      ...(allConveyed() as Record<string, unknown>),
      advice,
      strengths,
    });
  }

  test("助言0件＋ほめる欄ありの応答が検査を通り、「見当たりません」とほめ言葉が並ぶ", () => {
    const result = parseOpeningCheck(
      withStrengths("", [
        {
          quote: "図書塔の灯が一つずつ消えていく",
          why: "一文目で場所と時刻と不穏さが同時に伝わる",
        },
        {
          quote: "読めない文字で書かれたその手紙",
          why: "謎が主人公の動機と結びついている",
        },
      ]),
      opening
    );
    // 助言0件を「読めなかった」にしない
    expect(result).toBeDefined();
    expect(result?.advice).toBe("");
    expect(result?.strengths).toHaveLength(2);

    const markdown = report(result as OpeningCheckResult);
    expect(markdown).toContain("直すべき所は見当たりません");
    expect(markdown).not.toContain("総評が返りませんでした");
    expect(markdown).toContain("図書塔の灯が一つずつ消えていく");
    expect(markdown).toContain("謎が主人公の動機と結びついている");
    // **ほめる欄を助言より先に出す**
    expect(markdown.indexOf("## 効いている所")).toBeGreaterThanOrEqual(0);
    expect(markdown.indexOf("## 効いている所")).toBeLessThan(
      markdown.indexOf("## 総評")
    );
  });

  test("「特になし」「直すべき所は見当たりません」のような埋め草は助言にしない", () => {
    for (const filler of ["特になし", "なし", "空文字", "直すべき所は見当たりません。", "改善点はありません"]) {
      const result = parseOpeningCheck(withStrengths(filler, []), opening);
      expect(result?.advice, filler).toBe("");
      const markdown = report(result as OpeningCheckResult);
      expect(markdown, filler).toContain("直すべき所は見当たりません");
      // 埋め草そのものは項目として並べない
      if (filler !== "直すべき所は見当たりません。") {
        expect(markdown, filler).not.toContain(filler);
      }
    }
  });

  test("続きのある本物の助言は、埋め草と見なさない", () => {
    const advice = "直すべき所はほぼ見当たりませんが、「なぜ」の手がかりがもう一つあると読み進めやすくなります。";
    const result = parseOpeningCheck(withStrengths(advice, []), opening);
    expect(result?.advice).toBe(advice);
  });

  test("本文に無い引用のほめ言葉は落とし、落としたことを書く", () => {
    const result = parseOpeningCheck(
      withStrengths("", [
        { quote: "灯は母の遺した手紙を胸に抱えたまま", why: "人物と目的が一度に見える" },
        // 本文に無い文（作文）
        { quote: "塔の鐘が十三回鳴った", why: "異常事態が引きになっている" },
        // 前半だけ本物で後半が作文（断片のすべてを照合する）
        { quote: "開架の夜。鐘が十三回鳴った", why: "時刻が伝わる" },
      ]),
      opening
    );
    expect(result?.strengths.map((item) => item.quote)).toEqual([
      "灯は母の遺した手紙を胸に抱えたまま",
    ]);
    expect(result?.strengthsDropped).toBe(2);
    const markdown = report(result as OpeningCheckResult);
    expect(markdown).not.toContain("十三回");
    expect(markdown).toContain("本文に見つからない引用");
  });

  test("ほめる欄を件数で切らない（10件でも全部出す）", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `第${index + 1}の良い文がここにある。`);
    const source = lines.join("\n");
    const result = parseOpeningCheck(
      withStrengths(
        "",
        lines.map((line) => ({ quote: line, why: "効いている理由" }))
      ),
      source
    );
    expect(result?.strengths).toHaveLength(10);
    const markdown = report(result as OpeningCheckResult);
    for (const line of lines) expect(markdown).toContain(line);
  });

  test("総評の欄そのものが無い応答は「返りませんでした」のまま（0件と取り違えない）", () => {
    const result = parsed({
      elements: [{ element: "誰が", conveyed: true, note: "「灯」と名乗る" }],
    });
    expect(report(result)).toContain("総評が返りませんでした");
  });

  test("プロンプト：件数を強いず、見当たらなければ空でよいと言い、ほめる欄を頼む", () => {
    const prompt = buildOpeningCheckPrompt({
      workTitle: "作品",
      genre: "",
      logline: "",
      openingText: "本文",
    });
    expect(prompt).not.toMatch(/1点だけ advice に書いてください/);
    expect(prompt).toContain("見当たらなければ");
    expect(prompt).toContain("strengths");
    expect(prompt).toContain("なぜ効いている");
    expect(OPENING_CHECK_SCHEMA.required).toContain("strengths");
  });
});
