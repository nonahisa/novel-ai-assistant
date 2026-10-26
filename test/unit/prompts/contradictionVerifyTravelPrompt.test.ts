import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseVerifyOutcome } from "../../../src/core/contradictionVerifyValidation";
import {
  buildContradictionVerifyPrompt,
  CONTRADICTION_VERIFY_TRAVEL_VERSION,
  VERIFY_TRAVEL_PENDING_SENTENCE,
  VERIFY_REJECT_REASONS,
  VERIFY_SPEECH_NOTE,
  VERIFY_TRAVEL_KEEP_SENTENCES,
  VERIFY_TRAVEL_SOURCE_NOTE,
  verifyRejectReasonsFor,
} from "../../../src/prompts/contradictionVerify";

/**
 * P-12b travel 1.0：移動の照合（事実の照合の `findTravelImpossibilities`）から来た指摘にだけ、
 * 確かめの文面を変える（作者の選択①、2026-10-25）。
 *
 * 旅の台で 26b は3件とも「8行目で港町にいることは作中の変化（移動）として成立する」
 * 「前夜から翌朝にかけて移動した結果」と、移動したことそのものを両立の理由にして取り下げ、
 * e4b は「まだ明かされていない」で取り下げた。本命（settled）と future の文面が
 * 変わらないことは `contradictionVerifyFuturePrompt.test.ts` のハッシュが見張る。
 */
const T6 = {
  chapterLabel: "第6話",
  contextWithLineNumbers: "10: 　＊\n11: \n12: 　翌朝、エドは港町に着いた。\n13: 　見慣れた宿の看板が、朝日に光っていた。",
  excerpt: "翌朝、エドは港町に着いた。",
  settingSays:
    "第6話 6行目・地の文：移動＝王都に戻った。場所の記録では、王都と港町のあいだは3日かかる（書かれた所要時間のうち、いちばん速いもの）",
  textSays: "第6話 12行目・地の文：移動＝港町に着いた",
  category: "時系列",
  settingKnownAt: "第6話",
  source: "travel" as const,
  travel: {
    travelTime: "場所の記録では、王都と港町のあいだは3日かかる（書かれた所要時間のうち、いちばん速いもの）",
    reading: "第6話6行目に『王都』、第6話12行目に『港町』。3日かかる道のりを、長く見積もっても1日で移っている",
    timeCue: "「翌朝」（前の場面の1日後と読みました）",
    leftContext: "4: 　＊\n5: \n6: 　王都に戻ったエドは、厩舎の親方に馬を返した。\n7: 　「無事でなによりだ」\n8: 　親方は栗毛の首をたたいた。",
  },
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("移動の照合の文面（travel 1.0）", () => {
  const prompt = buildContradictionVerifyPrompt(T6);

  it("出どころ・所要時間・コードの読み・時の手がかり・前側の前後を渡す", () => {
    expect(prompt).toContain(VERIFY_TRAVEL_SOURCE_NOTE);
    // 承認待ちの1文（travel 1.1）は承認待ちの距離を使った候補にだけ出る（下の travel 1.1 の項）
    for (const sentence of VERIFY_TRAVEL_KEEP_SENTENCES) {
      if (sentence !== VERIFY_TRAVEL_PENDING_SENTENCE) expect(prompt).toContain(sentence);
    }
    expect(prompt).toContain("【所要時間（場所の記録）】\n場所の記録では、王都と港町のあいだは3日かかる");
    expect(prompt).toContain("【コードの読み】\n第6話6行目に『王都』");
    expect(prompt).toContain("【時の手がかり（引用の段落の頭）】\n「翌朝」（前の場面の1日後と読みました）");
    expect(prompt).toContain("【前側の箇所の前後】\n4: 　＊");
    expect(prompt).toContain("6: 　王都に戻ったエドは");
  });

  /** e4b は「まだ明かされていない」で取り下げた。両側とも本文に書かれた所在である */
  it("却下の理由から「まだ明かされていない」を外す（大小とも）", () => {
    for (const smallModel of [false, true]) {
      expect(verifyRejectReasonsFor({ settingKnownAt: "第6話", smallModel, source: "travel" })).not.toContain(
        "まだ明かされていない"
      );
    }
    expect(prompt).not.toContain("まだ明かされていない");
    expect(prompt).toContain("発言者の誤り / 作中の変化 / 設定が古い / 引用が本文と違う / そもそも食い違っていない");
  });

  /** 26b は移動そのものを「作中の変化」と読んだ。移動したことだけでは当たらないと書く */
  it("「作中の変化」と「そもそも食い違っていない」を移動の照合の説明に差し替える", () => {
    expect(prompt).toContain("**作中の変化** … 本文に、記録より速く移る手段や、コードの読みより長い時の経過が書かれている場合だけ。");
    expect(prompt).toContain("移動したことだけでは、これに当たりません。");
    expect(prompt).not.toContain("人物の身の上が先へ進むのは矛盾ではありません");
    expect(prompt).toContain("**そもそも食い違っていない** … コードの読み（どの場所か・時がどれだけ経ったか）が本文と違っていて、両立する場合。");
    // 口調の但し書きは移動の照合には要らない
    expect(prompt).not.toContain(VERIFY_SPEECH_NOTE);
    expect(prompt).toContain("移動の指摘では、本文の時の経過が場所の記録の所要時間より短く");
  });

  it("材料の欄が空なら、その欄を出さない（出どころの説明は出す）", () => {
    const bare = buildContradictionVerifyPrompt({
      ...T6,
      travel: { travelTime: "", reading: "", timeCue: "", leftContext: "" },
    });
    expect(bare).toContain(VERIFY_TRAVEL_SOURCE_NOTE);
    expect(bare).not.toContain("【所要時間（場所の記録）】");
    expect(bare).not.toContain("【時の手がかり");
    expect(bare).not.toContain("【前側の箇所の前後】");
  });

  /**
   * 指示の言葉は答えに返ってくる（CLAUDE.md「繰り返し起きた失敗」3番）。説明の文に
   * 却下の理由の語を含めると、その語を写した却下が「決められた理由」として通る
   */
  it("出どころと「残せ」の文に、却下の理由の語を含めない", () => {
    for (const text of [VERIFY_TRAVEL_SOURCE_NOTE, ...VERIFY_TRAVEL_KEEP_SENTENCES]) {
      for (const reason of VERIFY_REJECT_REASONS) expect(text).not.toContain(reason);
    }
  });
});

/**
 * travel 1.1（作者の裁定 2026-10-26「1文足して測り直す」）：e4b が、承認待ちの距離を
 * 根拠にした候補を「所要時間は設定資料にない情報であり、本文の記述を優先すべき」
 * （設定が古い）で取り下げた（docs/measurements/2026-10-26-travel-ai-cues.md）。
 * 承認待ちの距離も根拠として扱うと、移動の照合の文面にだけ1文足す
 */
describe("承認待ちの距離の扱い（travel 1.1）", () => {
  it("版は 1.1", () => {
    expect(CONTRADICTION_VERIFY_TRAVEL_VERSION).toBe("1.1");
  });

  it("根拠に承認待ちの距離を使った候補にだけ、承認待ちの距離も根拠として扱う1文を置く", () => {
    const prompt = buildContradictionVerifyPrompt({
      ...T6,
      travel: { ...T6.travel, pendingDistance: true },
    });
    expect(prompt).toContain(VERIFY_TRAVEL_PENDING_SENTENCE);
    expect(buildContradictionVerifyPrompt(T6)).not.toContain(VERIFY_TRAVEL_PENDING_SENTENCE);
    // 写して却下してきたら判断できなかったものとして通す見張り（下の読み取り）に入れる
    expect(VERIFY_TRAVEL_KEEP_SENTENCES).toContain(VERIFY_TRAVEL_PENDING_SENTENCE);
  });

  /**
   * 旅の台の e4b が 2/3→1/3 に下がった（承認待ちを使わない候補を「作中の変化」で取り下げ。
   * docs/measurements/2026-10-26-travel-verify-1.1.md）。承認待ちを使わない候補の文面は
   * travel 1.0 と1文字も変えない。ハッシュは travel 1.0 の文面（a0433e0f）から取った
   */
  it("承認待ちの距離を使わない候補の文面は、travel 1.0 と1文字も同じ", () => {
    const pinned = {
      ...T6,
      travel: {
        ...T6.travel,
        leftContext: "4: 　＊\n5: \n6: 　王都に戻ったエドは、厩舎の親方に馬を返した。",
      },
    };
    const TRAVEL_1_0 = "2e88b7ee9a49c624429f03f5292ce901b5b2052b6e7b3e0ba6160e0b806ca2fe";
    for (const smallModel of [false, true]) {
      expect(sha(buildContradictionVerifyPrompt({ ...pinned, smallModel }))).toBe(TRAVEL_1_0);
      expect(
        sha(
          buildContradictionVerifyPrompt({
            ...pinned,
            smallModel,
            travel: { ...pinned.travel, pendingDistance: false },
          })
        )
      ).toBe(TRAVEL_1_0);
    }
  });

  it("本命（settled）と future の文面には出さない", () => {
    const { travel: _travel, ...rest } = T6;
    for (const source of ["settled", "future"] as const) {
      expect(buildContradictionVerifyPrompt({ ...rest, source })).not.toContain(
        VERIFY_TRAVEL_PENDING_SENTENCE
      );
    }
  });

  /**
   * 指示の言葉は答えに返ってくる（CLAUDE.md「繰り返し起きた失敗」3番）。e4b の却下の
   * 説明の型に、この1文をそのまま足して返してきたら、却下として受け取らない
   */
  it("この1文を写したまま「設定が古い」で却下してきたら、判断できなかったものとして通す", () => {
    const outcome = parseVerifyOutcome(
      JSON.stringify({
        verdict: "却下",
        reason: "設定が古い",
        explanation: `${VERIFY_TRAVEL_PENDING_SENTENCE}所要時間は設定資料にない情報であり、本文の記述を優先すべき。`,
        confidence: "high",
      })
    );
    expect(outcome).toMatchObject({ keep: true, undecided: true });
  });
});

describe("移動の照合の答えの読み取り", () => {
  const reply = (explanation: string, reason = "作中の変化") =>
    JSON.stringify({ verdict: "却下", reason, explanation, confidence: "high" });

  /** 「前提で、両立の理由にならない」と写しながら却下するのは、判断が逆を向いている */
  it("「残せ」の文を写したまま却下してきたら、判断できなかったものとして通す", () => {
    for (const sentence of VERIFY_TRAVEL_KEEP_SENTENCES) {
      const outcome = parseVerifyOutcome(reply(`${sentence}しかし移動したので問題ない。`));
      expect(outcome).toMatchObject({ keep: true, undecided: true });
    }
  });

  /** 時計の読み違いの却下（「その頃」が別の日だと本文から分かる）は正しい仕事として受け取る */
  it("語の一部（前提・所要時間）が出るだけの却下は、そのまま受け取る", () => {
    const outcome = parseVerifyOutcome(
      reply("本文では三日後と書かれており、所要時間の前提を満たしている。", "そもそも食い違っていない")
    );
    expect(outcome).toMatchObject({ keep: false, reason: "そもそも食い違っていない", undecided: false });
  });
});
