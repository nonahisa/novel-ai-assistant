import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildContradictionVerifyPrompt,
  CONTRADICTION_VERIFY_FUTURE_VERSION,
  CONTRADICTION_VERIFY_VERSION,
  VERIFY_FUTURE_FACTS_NOTE,
  VERIFY_FUTURE_SOURCE_NOTE,
  VERIFY_FUTURE_SOURCE_NOTE_WITH_FACTS,
  VERIFY_KNOWN_AT_NONE_FUTURE,
  VERIFY_KNOWN_AT_NONE_SMALL,
  VERIFY_REJECT_REASONS,
  verifyRejectReasonsFor,
} from "../../../src/prompts/contradictionVerify";

/**
 * P-12b 1.3：「あとで判明する事実」（future）から来た指摘にだけ、確かめの文面を変える
 * （作者の裁定 2026-10-19 夜「A+C で実装する」）。
 *
 * e4b は第3話の地の文「ミナは今日も学校で授業を受け」（第4話で判明する「三ヶ月前に
 * 退学」）を「作中の変化」で、26b は第2話の瀬戸の台詞「俺は生まれてからずっと本屋だ」
 * （第5話で判明する「元刑事」）を「まだ明かされていない」で取り下げた。future の
 * 照合は「設定が対象の話より後に分かる」ことが前提なので、その2つの理由が前提
 * そのもので当たりを消していた。
 */
const T1 = {
  chapterLabel: "第3話 放課後",
  contextWithLineNumbers: "1: ミナは今日も学校で授業を受け、放課後になると制服のまま瀬戸書房へ向かった。",
  excerpt: "ミナは今日も学校で授業を受け、放課後になると制服のまま瀬戸書房へ向かった。",
  settingSays: "ミナの紹介（第4話で判明）: 十七歳の少女。三ヶ月前に高校を退学している。",
  textSays: "学校で授業を受けている",
  category: "人物",
  settingKnownAt: "",
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * **本命（settled）の文面は1文字も変えない。** 直す前（1.2）の関数で同じ入力から組んだ
 * 文面のハッシュを固定する（2026-10-19 夜、直す前のコードで取った値）。変わると、作者の
 * クラウドAIの確かめの控えが、鍵は同じなのに別の文面で得た答えになる
 */
describe("本命（settled）の文面は 1.2 のまま", () => {
  const BEFORE = {
    largeNone: "cdb4389884f5e0f4eb76db3ee22d303cd727c892610533bd5039e91d95ccae53",
    smallNone: "abe5e8ecaf76f4b4202c7847eedba54d9d3a7ba6b10b48c010736b297f26be16",
    known: "6094e7a069247657bbccd71368b3737e46f249edb8efb06a4b06d0f5db89824e",
  };

  it("大きいモデル・話数なし", () => {
    expect(sha(buildContradictionVerifyPrompt(T1))).toBe(BEFORE.largeNone);
    expect(sha(buildContradictionVerifyPrompt({ ...T1, source: "settled" }))).toBe(
      BEFORE.largeNone
    );
  });

  it("小さいモデル・話数なし", () => {
    expect(sha(buildContradictionVerifyPrompt({ ...T1, smallModel: true }))).toBe(
      BEFORE.smallNone
    );
    expect(
      sha(buildContradictionVerifyPrompt({ ...T1, smallModel: true, source: "settled" }))
    ).toBe(BEFORE.smallNone);
  });

  it("話数あり（大小とも同じ文面）", () => {
    for (const smallModel of [false, true]) {
      expect(
        sha(buildContradictionVerifyPrompt({ ...T1, settingKnownAt: "第4話", smallModel }))
      ).toBe(BEFORE.known);
    }
  });

  it("本命の文面に、future の言葉が入らない", () => {
    const settled = buildContradictionVerifyPrompt(T1);
    expect(settled).not.toContain("【指摘の出どころ】");
    expect(settled).not.toContain(VERIFY_FUTURE_SOURCE_NOTE);
    expect(settled).not.toContain(VERIFY_KNOWN_AT_NONE_FUTURE);
  });

  it("版の定数は 1.2 のまま。future の版は別に持つ（1.4）", () => {
    expect(CONTRADICTION_VERIFY_VERSION).toBe("1.2");
    expect(CONTRADICTION_VERIFY_FUTURE_VERSION).toBe("1.4");
  });
});

describe("future から来た指摘の文面（1.3）", () => {
  const known = buildContradictionVerifyPrompt({
    ...T1,
    settingKnownAt: "第4話",
    source: "future",
  });

  it("T1：出どころの一文と「第4話」があり、「まだ明かされていない」が無い", () => {
    expect(known).toContain("【指摘の出どころ】");
    expect(known).toContain(VERIFY_FUTURE_SOURCE_NOTE);
    expect(known).toContain("- この設定が分かる話: 第4話");
    expect(known).not.toContain("まだ明かされていない");
  });

  it("大きいモデルでも小さいモデルでも同じ文面", () => {
    for (const settingKnownAt of ["第4話", ""]) {
      expect(
        buildContradictionVerifyPrompt({ ...T1, settingKnownAt, source: "future", smallModel: true })
      ).toBe(buildContradictionVerifyPrompt({ ...T1, settingKnownAt, source: "future" }));
    }
  });

  it("却下の理由は5つで、「まだ明かされていない」を選べる形で置かない", () => {
    for (const smallModel of [false, true]) {
      for (const settingKnownAt of ["第4話", ""]) {
        const reasons = verifyRejectReasonsFor({ settingKnownAt, smallModel, source: "future" });
        expect(reasons).toHaveLength(5);
        expect(reasons).not.toContain("まだ明かされていない");
      }
    }
    const reasonLine = known.split("\n").find((line) => line.includes('"reason"')) ?? "";
    expect(reasonLine).toContain(
      VERIFY_REJECT_REASONS.filter((reason) => reason !== "まだ明かされていない").join(" / ")
    );
    expect(known).toContain("1. **発言者の誤り**");
    expect(known).toContain("5. **そもそも食い違っていない**");
    expect(known).not.toContain("6. ");
  });

  /**
   * 「作中の変化」は、判明した事実が対象の話より後の出来事と読めるときだけ。
   * 「三ヶ月前に退学」のように対象の話の時点で既に起きていたことには当たらない
   */
  it("「作中の変化」は future 用の説明になる（1.2 の説明は出さない）", () => {
    expect(known).toContain("2. **作中の変化** … 判明した事実が、対象の話の時点より後に起きた変化と読める場合だけ");
    expect(known).toContain("作中の変化には当たりません");
    // 例は測定の台の仕込み（三ヶ月前の退学）と重ならない事実にしてある（答えを教えて測らないため）
    expect(known).toContain("一年前に東京から越してきた");
    expect(known).not.toContain("人物の身の上が先へ進むのは矛盾ではありません");
  });

  it("話数が引けないときは、事実と逆の案内も「（不明）」も使わず、後の話だとだけ言う", () => {
    for (const smallModel of [false, true]) {
      const none = buildContradictionVerifyPrompt({ ...T1, source: "future", smallModel });
      expect(none).toContain(`- この設定が分かる話: ${VERIFY_KNOWN_AT_NONE_FUTURE}`);
      expect(none).not.toContain(VERIFY_KNOWN_AT_NONE_SMALL);
      expect(none).not.toContain("（不明）");
    }
    expect(VERIFY_KNOWN_AT_NONE_FUTURE).toContain("対象の話より後の話");
  });

  it("出どころの一文・中立の文は、決められた却下の理由の語を含まない（答えに写っても理由と読まれない）", () => {
    for (const text of [VERIFY_FUTURE_SOURCE_NOTE, VERIFY_KNOWN_AT_NONE_FUTURE]) {
      for (const reason of VERIFY_REJECT_REASONS) {
        expect(text).not.toContain(reason);
      }
      expect(text).not.toContain("明かされていない");
    }
  });
});

/**
 * P-12b 1.4：future の指摘に、**コードが特定した、照らしたあとの話の事実の文**を渡す
 * （作者の裁定「事実の文を渡す」、2026-10-23）。台Bで 26b は、検出の段で本当の食い違い
 * （第5話の「四十歳まで東京で中学の教師」）を note に書き、settingSays には「宗一は
 * 七十八歳である。」と書いた。確かめの段は settingSays と本文だけを比べて「そもそも
 * 食い違っていない」で消した。
 */
describe("future の指摘に、照らした事実の文を渡す（1.4）", () => {
  const T2 = {
    chapterLabel: "第2話",
    contextWithLineNumbers: "1: 宗一はこの町で生まれ、七十八年間、一度も町の外で暮らしたことがない。",
    excerpt: "宗一はこの町で生まれ、七十八年間、一度も町の外で暮らしたことがない。",
    settingSays: "宗一は七十八歳である。",
    textSays: "七十八年間、一度も町の外で暮らしたことがない",
    category: "人物",
    settingKnownAt: "第5話",
    source: "future" as const,
  };
  const FACT = "宗一の紹介（第5話で判明）: 七十八歳の老人。四十歳まで東京で中学の教師をしていた。";
  const NOTE = "第5話で判明する、四十歳まで東京で教師をしていたことと食い違う";
  const withFacts = buildContradictionVerifyPrompt({
    ...T2,
    futureFacts: [FACT],
    detectionNote: NOTE,
  });

  it("版は future だけ 1.4 に上がり、本命は 1.2 のまま", () => {
    expect(CONTRADICTION_VERIFY_FUTURE_VERSION).toBe("1.4");
    expect(CONTRADICTION_VERIFY_VERSION).toBe("1.2");
  });

  it("照らした事実の欄に事実の文があり、見比べる指示がある", () => {
    expect(withFacts).toContain(`【照らした事実（あとの話で判明）】\n- ${FACT}`);
    expect(withFacts).toContain(VERIFY_FUTURE_FACTS_NOTE);
    expect(withFacts).toContain(VERIFY_FUTURE_SOURCE_NOTE_WITH_FACTS);
    expect(withFacts).not.toContain(VERIFY_FUTURE_SOURCE_NOTE);
  });

  it("検出の段の補足は、事実の文より下に参考として置く", () => {
    expect(withFacts).toContain(`【検出の段の補足（AIが書いた文。参考）】\n${NOTE}`);
    expect(withFacts.indexOf(FACT)).toBeLessThan(withFacts.indexOf(NOTE));
    // 補足が空なら欄ごと出さない
    const noNote = buildContradictionVerifyPrompt({ ...T2, futureFacts: [FACT], detectionNote: "  " });
    expect(noNote).not.toContain("【検出の段の補足");
  });

  it("欄は【却下すべき場合】より上（判断材料の並び）", () => {
    expect(withFacts.indexOf("【照らした事実")).toBeLessThan(withFacts.indexOf("【却下すべき場合】"));
  });

  it("事実の文を渡さなければ、1.3 と同じ文面（出どころの一文は前のまま）", () => {
    const without = buildContradictionVerifyPrompt(T2);
    expect(without).toContain(VERIFY_FUTURE_SOURCE_NOTE);
    expect(without).not.toContain("【照らした事実");
    expect(without).not.toContain("【検出の段の補足");
  });

  it("本命（settled）では、事実の文を渡されても使わない", () => {
    const settled = buildContradictionVerifyPrompt({
      ...T2,
      source: "settled",
      futureFacts: [FACT],
      detectionNote: NOTE,
    });
    expect(settled).not.toContain("【照らした事実");
    expect(settled).not.toContain(NOTE);
  });

  it("新しい指示の文は、決められた却下の理由の語を含まない（答えに写っても理由と読まれない）", () => {
    for (const text of [VERIFY_FUTURE_FACTS_NOTE, VERIFY_FUTURE_SOURCE_NOTE_WITH_FACTS]) {
      for (const reason of VERIFY_REJECT_REASONS) {
        expect(text).not.toContain(reason);
      }
      expect(text).not.toContain("明かされていない");
    }
  });
});
