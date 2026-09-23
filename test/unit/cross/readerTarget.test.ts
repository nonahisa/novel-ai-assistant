import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  describeReaderGap,
  readerAxesOf,
  readerGaps,
  readerTypeLabel,
  READER_AXIS_ORDER,
  READER_GAP_THRESHOLD,
  READER_QUESTIONS,
  READER_TYPES,
  resolveReaderType,
  scoreReaderAnswers,
  type ReaderScores,
  type ReaderTypeId,
} from "../../../src/core/readerTarget";
import { READER_TYPE_PROMPTS } from "../../../src/prompts/readerTarget";

/**
 * **ターゲット読者の分類**（設計書6.91）。
 *
 * 作者の依頼（2026-09-13）：「作者の分類と同じように、ターゲット読者の
 * 分類も行えないでしょうか？」
 *
 * ここで確かめるのは、**分類が一意に決まること**と、
 * **作家タイプ（6.86）と同じ骨格を写しではなく共有で作れていること**。
 */

function scores(
  familiarity: number,
  posture: number,
  craving: number
): ReaderScores {
  return { familiarity, posture, craving };
}

describe("9問", () => {
  test("各軸3問・各問0〜2点になっている", () => {
    expect(READER_QUESTIONS).toHaveLength(9);
    for (const axis of READER_AXIS_ORDER) {
      const forAxis = READER_QUESTIONS.filter((q) => q.axis === axis);
      expect(forAxis, axis).toHaveLength(3);
    }
    for (const question of READER_QUESTIONS) {
      expect(question.choices.map((c) => c.score), question.id).toEqual([0, 1, 2]);
    }
  });

  test("**願望ではなく、書くときの判断を聞く**", () => {
    // 「どんな読者に読んでほしいですか」は答えやすいが当たらない。
    // 6.86 が「あなたは〜ですか」を避けたのと同じ理由（自己像を聞くと、
    // なりたい姿のほうを答えてしまう）
    for (const question of READER_QUESTIONS) {
      expect(question.text, question.id).not.toContain("読んでほしい");
      expect(question.text, question.id).not.toContain("どんな読者");
    }
  });

  test("答えを軸ごとに合計する", () => {
    // A=2,2,2 / B=0,0,0 / C=1,1,1
    const answers = [2, 2, 2, 0, 0, 0, 1, 1, 1];
    expect(scoreReaderAnswers(answers)).toEqual(scores(6, 0, 3));
  });

  test("**途中でやめた答えも、そこまでで測れる**（足りない分は0点）", () => {
    expect(scoreReaderAnswers([2, 2])).toEqual(scores(4, 0, 0));
  });
});

describe("タイプの判定", () => {
  test("主軸だけのとき、副軸は付かない", () => {
    // 読み慣れだけが高く、ほかは低い
    expect(readerAxesOf(scores(6, 0, 0))).toEqual({ main: "familiarity" });
    expect(resolveReaderType(scores(6, 0, 0))).toBe("lore_flow");
  });

  test("副軸が中以上なら、組み合わせで決まる", () => {
    expect(resolveReaderType(scores(6, 4, 0))).toBe("lore_deep");
    expect(resolveReaderType(scores(6, 0, 4))).toBe("lore_crave");
    expect(resolveReaderType(scores(0, 6, 0))).toBe("deep_pure");
    // 4点は「中」なので副軸になる（低は副軸にならない）
    expect(resolveReaderType(scores(4, 6, 0))).toBe("deep_lore");
    expect(resolveReaderType(scores(0, 6, 4))).toBe("deep_crave");
  });

  test("**全中は「雑食層」**（どれか一つを主とは呼ばない）", () => {
    expect(readerAxesOf(scores(3, 3, 3))).toEqual({});
    expect(resolveReaderType(scores(3, 3, 3))).toBe("omnivore");
  });

  /**
   * **ここが作家タイプと違う。**
   *
   * 6.86 では全低が「目的模索型（まだ定まらない）」だった。読者では違う——
   * 初めての題材を、隙間の時間に、気持ちよく読む人のことで、
   * WEB小説でいちばん数が多い。**迷いではなく、宛先である。**
   */
  test("**全低は「すきま層」**——迷いではなく、はっきりした宛先", () => {
    expect(resolveReaderType(scores(0, 0, 0))).toBe("light");
    expect(READER_TYPES.light.label).toBe("すきま層");
  });

  test("同点でも、同じ答えから同じタイプが出る", () => {
    // 軸の見る順（READER_AXIS_ORDER）で先にあるものが主軸になる
    const first = resolveReaderType(scores(6, 6, 0));
    for (let i = 0; i < 5; i += 1) {
      expect(resolveReaderType(scores(6, 6, 0))).toBe(first);
    }
    expect(first).toBe("lore_deep");
  });

  test("11タイプが、どれも到達できる", () => {
    const reached = new Set<ReaderTypeId>();
    for (let a = 0; a <= 6; a += 1) {
      for (let b = 0; b <= 6; b += 1) {
        for (let c = 0; c <= 6; c += 1) {
          reached.add(resolveReaderType(scores(a, b, c)));
        }
      }
    }
    expect(reached.size).toBe(Object.keys(READER_TYPES).length);
    expect(reached.size).toBe(11);
  });

  test("呼び名は「〜層」で揃える（作家タイプの「〜型」と取り違えないため）", () => {
    for (const [id, info] of Object.entries(READER_TYPES)) {
      expect(info.label.endsWith("層"), id).toBe(true);
    }
  });
});

describe("宣言と実像のズレ", () => {
  test("**幅の大きい順に返す**", () => {
    const gaps = readerGaps(scores(0, 0, 0), scores(6, 3, 0));
    expect(gaps.map((gap) => gap.axis)).toEqual(["familiarity", "posture"]);
    expect(gaps[0].diff).toBe(6);
  });

  test("**1点差は言わない**（選択肢1つぶんで、読み方の差で動く）", () => {
    expect(readerGaps(scores(3, 3, 3), scores(4, 2, 3))).toEqual([]);
    expect(READER_GAP_THRESHOLD).toBe(2);
  });

  test("ずれていなければ空（「無い」は呼ぶ側が言う）", () => {
    expect(readerGaps(scores(3, 3, 3), scores(3, 3, 3))).toEqual([]);
  });

  test("**どちらが正しいとも言わない**", () => {
    const [gap] = readerGaps(scores(0, 3, 3), scores(6, 3, 3));
    const text = describeReaderGap(gap);
    expect(text).toContain("読み慣れ");
    expect(text).toContain("読み尽くしている");
    // 作者の答えを間違い扱いしない
    expect(text).not.toContain("間違");
    expect(text).not.toContain("正しく");
    expect(text).not.toContain("べき");
  });
});

describe("相談へ渡す方針", () => {
  const others = (id: ReaderTypeId) =>
    Object.entries(READER_TYPES)
      .filter(([other]) => other !== id)
      .map(([, info]) => info.label);

  test("11タイプぶん揃っている", () => {
    expect(Object.keys(READER_TYPE_PROMPTS).sort()).toEqual(
      Object.keys(READER_TYPES).sort()
    );
  });

  /**
   * **1回の相談で送るのは1つだけ**なので、各タイプの文章は独立していて
   * ほかのタイプの名前を含まない（P-36 と同じ約束）。混ざると、AIは
   * 「短く引きの強い話」と「長く余韻のある話」を両方勧めてくる。
   */
  test("**ほかのタイプの名前を含まない**", () => {
    for (const [id, text] of Object.entries(READER_TYPE_PROMPTS)) {
      for (const label of others(id as ReaderTypeId)) {
        expect(text, `${id} が ${label} に触れている`).not.toContain(label);
      }
    }
  });

  test("自分のタイプ名は名乗る（どのタイプ向けの文かが読めること）", () => {
    for (const [id, text] of Object.entries(READER_TYPE_PROMPTS)) {
      expect(text, id).toContain(READER_TYPES[id as ReaderTypeId].label);
    }
  });
});

/**
 * **判定の芯を写さない。**
 *
 * 作家タイプ（6.86）と読者タイプ（6.91）は測るものが違うだけで、
 * 測り方は同じである——3軸・各3問・0〜6点・主軸と副軸。
 * 同じ計算を2か所に置くと、片方だけ直る日が来る。
 */
describe("作家タイプと、判定の芯を分け合う", () => {
  const read = (path: string) =>
    readFileSync(resolve(__dirname, "../../../src", path), "utf8");

  test("どちらも `threeAxis.ts` を通る", () => {
    expect(read("core/advicePolicy.ts")).toContain('from "./threeAxis"');
    expect(read("core/readerTarget.ts")).toContain('from "./threeAxis"');
  });

  test("**段階の重みの表を、写していない**", () => {
    // LEVEL_RANK を持つのは threeAxis.ts だけ
    expect(read("core/threeAxis.ts")).toContain("LEVEL_RANK");
    expect(read("core/advicePolicy.ts")).not.toContain("LEVEL_RANK");
    expect(read("core/readerTarget.ts")).not.toContain("LEVEL_RANK");
  });

  test("軸を強い順に並べる計算も、1か所にしかない", () => {
    expect(read("core/threeAxis.ts")).toContain("function compareAxis");
    expect(read("core/advicePolicy.ts")).not.toContain("function compareAxis");
    expect(read("core/readerTarget.ts")).not.toContain("function compareAxis");
  });

  test("呼び名の一覧は、それぞれが別に持つ（混ぜない）", () => {
    // 作者のタイプと読者のタイプが同じファイルに並ぶと、
    // どちらを直しているのか分からなくなる
    const shared = read("core/threeAxis.ts");
    expect(shared).not.toContain("読者最適型");
    expect(shared).not.toContain("すきま層");
  });
});

describe("読者タイプの名前", () => {
  test("点数からラベルを引ける", () => {
    expect(readerTypeLabel(scores(0, 0, 0))).toBe("すきま層");
    expect(readerTypeLabel(scores(3, 3, 3))).toBe("雑食層");
  });

  test("**効くことと離れるところが、どのタイプにも書いてある**", () => {
    for (const [id, info] of Object.entries(READER_TYPES)) {
      expect(info.works.length, id).toBeGreaterThan(10);
      expect(info.loses.length, id).toBeGreaterThan(10);
    }
  });

  test("**作品の値踏みにしない**（読者像の説明であること）", () => {
    for (const [id, info] of Object.entries(READER_TYPES)) {
      const text = `${info.summary}${info.works}${info.loses}`;
      expect(text, id).not.toContain("浅い");
      expect(text, id).not.toContain("稚拙");
      expect(text, id).not.toContain("劣");
    }
  });
});
