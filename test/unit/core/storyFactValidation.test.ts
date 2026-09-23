import { describe, expect, test } from "vitest";
import {
  describeStoryFactRejections,
  validateStoryFactResult,
  type StoryFactValidationInput,
} from "../../src/core/storyFactValidation";

/**
 * P-37 の応答の検算（設計書6.88）。
 *
 * **AIの出力を信用しない。** とくにこの作品では、プロンプトに書いた選択肢の並びが
 * そのまま値として返ってくる（`"static|state"`）。構造化出力に対応した
 * プロバイダなら enum で止まるが、対応していないものは何でも返す。
 *
 * 弾いたものは**理由ごとに数えて**報告する。理由ごとに直す場所が違うため。
 */
function input(
  overrides: Partial<StoryFactValidationInput> = {}
): StoryFactValidationInput {
  return {
    chunkLineStart: 10,
    chunkLineEnd: 40,
    chapter: 3,
    knownCharacterIds: new Set(["char_001", "char_006"]),
    knownNames: new Map([
      ["密倉文佳", "char_006"],
      ["文佳ちゃん", "char_006"],
      ["月島灯", "char_001"],
    ]),
    ...overrides,
  };
}

function fact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    line_start: 12,
    line_end: 12,
    subject: "char_006",
    predicate: "髪の色",
    value: "銀髪",
    kind: "static",
    story_time: "day+14 夕",
    modality: "narration",
    pov: "char_001",
    speaker: null,
    topic: null,
    ...overrides,
  };
}

describe("通すもの", () => {
  test("正しい1件を、事実として受け取る", () => {
    const { accepted, rejected } = validateStoryFactResult(
      { facts: [fact()] },
      input()
    );

    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      id: "fact:3:12:1",
      chapter: 3,
      lineRange: [12, 12],
      subject: "char_006",
      predicate: "髪の色",
      value: "銀髪",
      kind: "static",
      storyTime: { day: 14, part: "夕" },
      modality: "narration",
      pov: "char_001",
      speaker: null,
      topic: null,
    });
  });

  test("既知の表記は id に寄せる（subject・speaker・pov）", () => {
    // 寄せないと、同じ人物が場面ごとに別の主語になって照合が当たらない
    const { accepted } = validateStoryFactResult(
      {
        facts: [
          fact({
            subject: "文佳ちゃん",
            modality: "dialogue",
            speaker: "月島灯",
            pov: "密倉文佳",
          }),
        ],
      },
      input()
    );

    expect(accepted[0]).toMatchObject({
      subject: "char_006",
      speaker: "char_001",
      pov: "char_006",
    });
  });

  test("対応表に無い発言者は、書かれたまま残す（弾かない）", () => {
    // 名前のない語り手や通行人が喋ることはある。弾くのは subject だけ
    const { accepted, rejected } = validateStoryFactResult(
      { facts: [fact({ modality: "dialogue", speaker: "痩せた男" })] },
      input()
    );

    expect(rejected).toEqual([]);
    expect(accepted[0]?.speaker).toBe("痩せた男");
  });

  test("時期が読めなければ null にして通す（弾かない）", () => {
    // 「夕方」だけでは、どの日の夕方か決められない（設計書6.88.4）
    const { accepted, rejected } = validateStoryFactResult(
      { facts: [fact({ story_time: "夕方" }), fact({ story_time: null })] },
      input()
    );

    expect(rejected).toEqual([]);
    expect(accepted.map((entry) => entry.storyTime)).toEqual([null, null]);
  });

  test("同じ行に複数の事実があれば、id を分ける", () => {
    const { accepted } = validateStoryFactResult(
      { facts: [fact(), fact({ predicate: "所在", value: "図書室", kind: "state" })] },
      input()
    );

    expect(accepted.map((entry) => entry.id)).toEqual([
      "fact:3:12:1",
      "fact:3:12:2",
    ]);
  });
});

describe("弾くもの", () => {
  function reasonOf(raw: Record<string, unknown>): string | undefined {
    return validateStoryFactResult({ facts: [raw] }, input()).rejected[0]?.reason;
  }

  test("選択肢の写し（static|state）を弾く", () => {
    // プロンプトでも直しているが、モデルは指示を無視するので両方で受ける
    expect(reasonOf(fact({ kind: "static|state" }))).toBe("unknown_kind");
    expect(reasonOf(fact({ modality: "narration|dialogue" }))).toBe(
      "unknown_modality"
    );
  });

  test("知らない種類・書かれ方を弾く", () => {
    expect(reasonOf(fact({ kind: "属性" }))).toBe("unknown_kind");
    expect(reasonOf(fact({ modality: "地の文" }))).toBe("unknown_modality");
  });

  test("チャンクの外の行を弾く", () => {
    // 本文に無い行を作られると、指摘の飛び先が別の場所になる
    expect(reasonOf(fact({ line_start: 5, line_end: 5 }))).toBe(
      "line_out_of_range"
    );
    expect(reasonOf(fact({ line_start: 12, line_end: 99 }))).toBe(
      "line_out_of_range"
    );
    expect(reasonOf(fact({ line_start: 20, line_end: 12 }))).toBe(
      "line_out_of_range"
    );
  });

  test("対応表に無い id の形の主語は弾き、知らない表記はそのまま通す", () => {
    // モデルが作った id は突き合わせようがない。表に無い人物（新顔）は
    // 本文の表記のまま残す（P-37）——弾くと新顔の事実が必ず落ちる
    expect(reasonOf(fact({ subject: "char_999" }))).toBe("unknown_subject");
    const result = validateStoryFactResult(
      { facts: [fact({ subject: "見知らぬ誰か" })] },
      input()
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.subject).toBe("見知らぬ誰か");
  });

  test("中身の無い値を弾く", () => {
    // 「不明」「記述なし」はプロンプトでも禁じているが、指示だけでは守られない
    expect(reasonOf(fact({ value: "不明" }))).toBe("empty_value");
    expect(reasonOf(fact({ value: "記述なし" }))).toBe("empty_value");
    expect(reasonOf(fact({ value: "" }))).toBe("empty_value");
  });

  test("発言者の無い台詞を弾く（黙って地の文にしない）", () => {
    // 地の文にすると、機械照合がいちばん強い証拠として扱ってしまう
    expect(reasonOf(fact({ modality: "dialogue", speaker: null }))).toBe(
      "dialogue_without_speaker"
    );
    expect(reasonOf(fact({ modality: "dialogue", speaker: "  " }))).toBe(
      "dialogue_without_speaker"
    );
  });

  test("項目が足りない・型が違うものを弾く", () => {
    expect(reasonOf(fact({ line_start: "12" }))).toBe("invalid_shape");
    expect(reasonOf(fact({ subject: "" }))).toBe("invalid_shape");
    expect(reasonOf(fact({ predicate: null }))).toBe("invalid_shape");
    expect(reasonOf(fact({ value: 3 }))).toBe("invalid_shape");
  });

  test("facts が無い応答は、丸ごと1件として返す", () => {
    const { accepted, rejected } = validateStoryFactResult({ ok: true }, input());

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ reason: "invalid_shape", raw: { ok: true } }]);
  });

  test("正しい件は、弾いた件に巻き込まれない", () => {
    // 1件の不良で全部を捨てると、そのチャンクの正しい事実まで消える
    const { accepted, rejected } = validateStoryFactResult(
      { facts: [fact({ kind: "static|state" }), fact()] },
      input()
    );

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe("弾いた内訳の報告", () => {
  test("理由ごとの件数を、多い順に並べる", () => {
    const text = describeStoryFactRejections([
      { reason: "unknown_kind" },
      { reason: "line_out_of_range" },
      { reason: "unknown_kind" },
    ]);

    expect(text).toBe("知らない種類 2件、行が範囲外 1件");
  });

  test("弾いた件が無ければ、何も言わない", () => {
    // うまくいった回のログを汚さない
    expect(describeStoryFactRejections([])).toBe("");
  });
});
