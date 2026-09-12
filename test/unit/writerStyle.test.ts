import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildWriterStyle,
  describeWriterStyle,
  diagnosisNarrative,
  tutorialAdvice,
  tutorialGoals,
  WRITER_QUESTIONS,
  WRITER_PLAN_TYPES,
  type TutorialGoal,
  type WriterStyle,
} from "../../src/core/writerStyle";

/**
 * 作家のタイプ診断と、はじめの案内（設計書6.90）。
 *
 * ここで守るのは3つ。
 *
 * 1. **案内するコマンドが実在すること。** 押しても何も起きない項目を
 *    並べたら、はじめて使う人はそこで詰まる。過去に実在しないコマンドID
 *    （`novelai.extractCharacters`）を指したことがある（0.49.3、二重起動の一覧）
 * 2. **どの答えでも、行き止まりにならないこと。** 432通りの組み合わせを
 *    全部通して、目的が1つ以上出て、助言と操作が付くことを見る
 * 3. **「なぜ出ているか」が必ず付くこと**（作者の指摘、2026-09-13
 *    「おそらく今はなぜその選択肢がでているかわからないと思います」）
 */

/** `package.json` に登録されているコマンド（＝実際に押せるもの） */
const REGISTERED: ReadonlySet<string> = new Set(
  (
    JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8")
    ) as { contributes?: { commands?: { command: string }[] } }
  ).contributes?.commands?.map((entry) => entry.command) ?? []
);

/** 診断で取りうる答えを、すべて並べる */
function allStyles(): WriterStyle[] {
  const out: WriterStyle[] = [];
  const pick = (key: keyof WriterStyle): string[] => {
    const question = WRITER_QUESTIONS.find((entry) => entry.key === key);
    if (!question) throw new Error(`質問が無い: ${key}`);
    return question.choices.map((choice) => choice.value);
  };
  for (const situation of pick("situation")) {
    for (const plan of pick("plan")) {
      for (const revise of pick("revise")) {
        for (const material of pick("material")) {
          for (const outlet of pick("outlet")) {
            const style = buildWriterStyle({
              situation,
              plan,
              revise,
              material,
              outlet,
            });
            if (!style) throw new Error("組み立てられない答えがある");
            out.push(style);
          }
        }
      }
    }
  }
  return out;
}

describe("執筆スタイルの質問", () => {
  test("5問あり、スタイルの全項目を1問ずつ覆う", () => {
    expect(WRITER_QUESTIONS).toHaveLength(5);
    expect(WRITER_QUESTIONS.map((question) => question.key)).toEqual([
      "situation",
      "plan",
      "revise",
      "material",
      "outlet",
    ]);
  });

  test("どの問いにも選択肢が2つ以上あり、値が重複しない", () => {
    for (const question of WRITER_QUESTIONS) {
      expect(question.choices.length, question.id).toBeGreaterThan(1);
      const values = question.choices.map((choice) => choice.value);
      expect(new Set(values).size, question.id).toBe(values.length);
      for (const choice of question.choices) {
        // **選ぶときの手掛かりを必ず付ける。** 短い札だけだと、
        // どちらとも取れる答えで作者が迷う
        expect(choice.label.length, question.id).toBeGreaterThan(0);
        expect(choice.detail.length, question.id).toBeGreaterThan(0);
      }
    }
  });

  test("**知らない値は受け取らない**（保存したものを読み直す道も、ここを通る）", () => {
    const ok = buildWriterStyle({
      situation: "starting",
      plan: "designer",
      revise: "inline",
      material: "memo",
      outlet: "serial",
    });
    expect(ok).toBeDefined();

    // 古い版の値・手で書き換えた値・項目の欠け
    expect(
      buildWriterStyle({
        situation: "starting",
        plan: "むかしの値",
        revise: "inline",
        material: "memo",
        outlet: "serial",
      })
    ).toBeUndefined();
    expect(
      buildWriterStyle({ situation: "starting", plan: "designer" })
    ).toBeUndefined();
    expect(buildWriterStyle({})).toBeUndefined();
  });
});

describe("診断の言い返し", () => {
  test("**足りないものを言わない**（品定めにしない）", () => {
    for (const style of allStyles()) {
      const text = diagnosisNarrative(style).join("\n");
      for (const word of ["できていません", "足りません", "べきです", "問題"]) {
        expect(text.includes(word), `${describeWriterStyle(style)}：${word}`).toBe(
          false
        );
      }
    }
  });

  test("段取りの呼び名が必ず出る（何と見立てたかを隠さない）", () => {
    for (const style of allStyles()) {
      const text = diagnosisNarrative(style).join("\n");
      expect(text).toContain(WRITER_PLAN_TYPES[style.plan].label);
    }
  });
});

describe("はじめの案内", () => {
  test("**432通りのどの答えでも、行き止まりにならない**", () => {
    const styles = allStyles();
    expect(styles).toHaveLength(4 * 3 * 3 * 3 * 4);

    for (const hasWork of [false, true]) {
      for (const style of styles) {
        const goals = tutorialGoals(style, hasWork);
        expect(goals.length, describeWriterStyle(style)).toBeGreaterThan(0);
        for (const goal of goals) {
          // **なぜこれが出ているかを必ず添える**（作者の指摘、2026-09-13）
          expect(goal.why.length, goal.label).toBeGreaterThan(0);

          const advice = tutorialAdvice(style, goal.goal);
          expect(advice.advice.length, goal.label).toBeGreaterThan(0);
          expect(advice.steps.length, goal.label).toBeGreaterThan(0);
        }
      }
    }
  });

  test("**案内するコマンドは、すべて実在する**", () => {
    const seen = new Set<string>();
    for (const hasWork of [false, true]) {
      for (const style of allStyles()) {
        for (const goal of tutorialGoals(style, hasWork)) {
          for (const step of tutorialAdvice(style, goal.goal).steps) {
            seen.add(step.command);
            expect(
              REGISTERED.has(step.command),
              `${step.command}（${step.label}）が package.json に無い`
            ).toBe(true);
            // 押す前に、なぜ出ているかが読めること
            expect(step.why.length, step.command).toBeGreaterThan(0);
          }
        }
      }
    }
    // 案内が1つも出ていない、という取りこぼしを防ぐ
    expect(seen.size).toBeGreaterThan(8);
  });

  test("作品を登録する前は、作品が要る目的を出さない", () => {
    for (const style of allStyles()) {
      const goals = tutorialGoals(style, false).map((entry) => entry.goal);
      for (const needsWork of ["keep_writing", "polish", "publish"] as const) {
        // 「これから書き始める」等では、まだ作品が無いので出さない。
        // ただし situation が何であれ、登録前に「続きを書く」は押せない
        if (style.situation !== "editing") {
          expect(goals.includes(needsWork), describeWriterStyle(style)).toBe(
            false
          );
        }
      }
    }
  });

  test("即興派には先に本文、設計派には先にプロットを出す", () => {
    const base = {
      situation: "starting",
      revise: "after_all",
      material: "memo",
      outlet: "serial",
    };
    const improviser = buildWriterStyle({ ...base, plan: "improviser" });
    const designer = buildWriterStyle({ ...base, plan: "designer" });
    if (!improviser || !designer) throw new Error("組み立てられない");

    expect(tutorialAdvice(improviser, "start_new").steps[0].command).toBe(
      "novelai.createWorkFromManuscript"
    );
    expect(tutorialAdvice(designer, "start_new").steps[0].command).toBe(
      "novelai.createWorkWithPlot"
    );
  });

  test("書き終えてから直す人にはまとめて、区切りで直す人には1つずつ", () => {
    const base = {
      situation: "have_files",
      plan: "hybrid",
      material: "memo",
      outlet: "serial",
    };
    const afterAll = buildWriterStyle({ ...base, revise: "after_all" });
    const perEpisode = buildWriterStyle({ ...base, revise: "per_episode" });
    if (!afterAll || !perEpisode) throw new Error("組み立てられない");

    expect(tutorialAdvice(afterAll, "polish").steps[0].command).toBe(
      "novelai.runProofreadingSuite"
    );
    expect(tutorialAdvice(perEpisode, "polish").steps[0].command).toBe(
      "novelai.checkTypos"
    );
  });

  test("目的はすべて `tutorialAdvice` が受けられる（取りこぼしが無い）", () => {
    const style = buildWriterStyle({
      situation: "have_files",
      plan: "hybrid",
      revise: "per_episode",
      material: "memo",
      outlet: "serial",
    });
    if (!style) throw new Error("組み立てられない");

    const all: TutorialGoal[] = [
      "bring_in",
      "start_new",
      "keep_writing",
      "polish",
      "publish",
      "review",
    ];
    for (const goal of all) {
      expect(tutorialAdvice(style, goal).advice.length, goal).toBeGreaterThan(0);
    }
  });
});
