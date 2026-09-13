import { describe, expect, test } from "vitest";
import {
  buildWriterGuide,
  WRITER_GUIDE_TITLE,
} from "../../src/core/writerGuideDoc";
import { ADVICE_TYPES } from "../../src/core/advicePolicy";
import {
  buildWriterStyle,
  WRITER_PLAN_TYPES,
  tutorialAdvice,
  tutorialGoals,
  WRITER_QUESTIONS,
  type WriterStyle,
} from "../../src/core/writerStyle";

/**
 * はじめの案内の紙（設計書6.90）。
 *
 * **この紙は、選択肢より前に読ませるもの**である（作者の指摘、2026-09-13
 * 「すぐに選択肢を表示するのではなく、作者が何をしたいか聞き取って、
 * アドバイスしてから選択肢を表示してください」）。
 *
 * そこで確かめるのは「なぜそれを勧めるのかが、押す前に読めるか」に尽きる。
 */

function styleOf(overrides: Partial<Record<string, string>> = {}): WriterStyle {
  const base: Record<string, string> = {};
  for (const question of WRITER_QUESTIONS) {
    base[question.key] = question.choices[0].value;
  }
  const style = buildWriterStyle({ ...base, ...overrides });
  if (!style) throw new Error("組み立てられない");
  return style;
}

function guideFor(style: WriterStyle, hasWork: boolean): string {
  const goal = tutorialGoals(style, hasWork)[0];
  return buildWriterGuide({
    style,
    goal,
    advice: tutorialAdvice(style, goal.goal),
  });
}

describe("はじめの案内の紙", () => {
  test("**なぜその選択肢が出たのか**が、紙に書いてある", () => {
    const style = styleOf();
    const goal = tutorialGoals(style, false)[0];
    const guide = buildWriterGuide({
      style,
      goal,
      advice: tutorialAdvice(style, goal.goal),
    });

    expect(guide).toContain(WRITER_GUIDE_TITLE);
    expect(guide).toContain(goal.label);
    // 目的が出ていた理由
    expect(guide).toContain(goal.why);
  });

  test("**操作は、1つずつ理由つきで並ぶ**", () => {
    const style = styleOf({ situation: "have_files", material: "in_head" });
    const goal = tutorialGoals(style, false)[0];
    const advice = tutorialAdvice(style, goal.goal);
    const guide = buildWriterGuide({ style, goal, advice });

    advice.steps.forEach((step, index) => {
      expect(guide).toContain(`### ${index + 1}. ${step.label}`);
      expect(guide).toContain(step.why);
    });
  });

  test("いまはできないことは、番号を振らずに別の章へ置く", () => {
    // 押せる顔で並べない。番号の付いた章は「できること」だけ
    const style = styleOf({ situation: "have_files", material: "in_head" });
    const goal = tutorialGoals(style, false)[0];
    const advice = tutorialAdvice(style, goal.goal);
    expect(advice.later.length).toBeGreaterThan(0);

    const guide = buildWriterGuide({ style, goal, advice });
    expect(guide).toContain("## いまはまだ、できないこと");
    for (const line of advice.later) {
      expect(guide).toContain(`- ${line}`);
    }
  });

  test("**どの答えでも、3つの約束が最後に載る**", () => {
    for (const hasWork of [false, true]) {
      for (const situation of ["have_files", "posted", "starting", "editing"]) {
        const guide = guideFor(styleOf({ situation }), hasWork);
        expect(guide, situation).toContain("AIが原稿を書き換えることはありません");
        expect(guide, situation).toContain("文字コードも改行も変えず");
        expect(guide, situation).toContain("作家タイプ診断");
      }
    }
  });

  test("助言方針を決めていれば添え、決めていなければ触れない", () => {
    const style = styleOf();
    const goal = tutorialGoals(style, false)[0];
    const advice = tutorialAdvice(style, goal.goal);

    const without = buildWriterGuide({ style, goal, advice });
    expect(without).not.toContain("相談のときの言い方");

    const withPolicy = buildWriterGuide({
      style,
      goal,
      advice,
      advicePolicy: { label: "均衡模索型", summary: "方向づけの相談が効きます。" },
    });
    expect(withPolicy).toContain("相談のときの言い方");
    expect(withPolicy).toContain("均衡模索型");
  });

  test("**最後に、ほかのタイプの一覧が載る**（作者の指定、2026-09-13）", () => {
    const guide = guideFor(styleOf(), false);
    expect(guide).toContain("## ほかのタイプ");
    // 段取りの3つは名前も説明も載る
    for (const info of Object.values(WRITER_PLAN_TYPES)) {
      expect(guide, info.label).toContain(info.label);
      expect(guide, info.label).toContain(info.summary);
    }
    // 11タイプも載る
    for (const info of Object.values(ADVICE_TYPES)) {
      expect(guide, info.label).toContain(info.label);
    }
  });

  test("**いまの自分に印が付く**（隣と見比べられる）", () => {
    const style = styleOf({ plan: "improviser" });
    const goal = tutorialGoals(style, false)[0];
    const guide = buildWriterGuide({
      style,
      goal,
      advice: tutorialAdvice(style, goal.goal),
      advicePolicy: { label: "均衡模索型", summary: "方向づけの相談が効きます。" },
    });

    expect(guide).toContain("**即興派****← いまのあなた**");
    expect(guide).toContain("**均衡模索型****← いまのあなた**");
    // 印は1つずつ（ほかのタイプには付かない）
    expect(guide.split("← いまのあなた").length - 1).toBe(2);
  });

  test("9問に答えていなければ、そう書いたうえで一覧は出す", () => {
    const guide = guideFor(styleOf(), false);
    expect(guide).toContain("まだ9問には答えていません");
    // 答えていないのに「あなたは◯◯型です」とは言わない
    expect(guide).not.toContain("相談のときの言い方");
    // それでも一覧は読める
    expect(guide).toContain("### 相談のときの言い分け");
  });

  test("紙は作品フォルダーへ入らないと、紙自身が断っている", () => {
    // 置き場を誤解されると、GitHub に上がると思われる
    expect(guideFor(styleOf(), false)).toContain(
      "作品フォルダーにも GitHub にも入りません"
    );
  });
});
