import { describe, expect, it } from "vitest";
import { parseVerifyOutcome } from "../../../src/core/contradictionVerifyValidation";
import {
  factVerifyPromptVersion,
  factVerifySourceOf,
  identityVerifyMaterialOf,
} from "../../../src/core/factContradictionFlow";
import {
  buildContradictionVerifyPrompt,
  CONTRADICTION_VERIFY_IDENTITY_VERSION,
  CONTRADICTION_VERIFY_VERSION,
  VERIFY_IDENTITY_KEEP_SENTENCES,
  VERIFY_IDENTITY_SOURCE_NOTE,
  VERIFY_REJECT_REASONS,
  VERIFY_SPEECH_NOTE,
  VERIFY_TRAVEL_SOURCE_NOTE,
  verifyRejectReasonsFor,
} from "../../../src/prompts/contradictionVerify";

/**
 * P-12b identity 1.0：体と心の照合（事実の照合の `findDwellingDrift`）から来た指摘にだけ、
 * 確かめの文面を分ける（母艦の判断④、2026-10-26）。
 *
 * 移動の照合は文面を分けるまで全件が「作中の変化」で取り下げられていた（travel 1.0）。
 * 心が別の体にいることも「作中の変化」と読まれうるので、最初から分ける。本命（settled）・
 * future・travel の文面が変わらないことは、それぞれのテストのハッシュが見張る。
 */
const RECORD =
  "心と体の記録（作者が人物の編集で付けたもの）では、三門太志の心が密倉文佳の体にいるのは第2話から第4話";
const READING =
  "第6話 6行目、密倉文佳の体に〈三門太志〉の心がいる。心と体の記録の範囲（第2話から第4話）の外で、本文に心が入る描写も無い";

const S6 = {
  chapterLabel: "第6話",
  contextWithLineNumbers: "4: 　＊\n5: \n6: 　その夜、鏡の前の文佳の体で、太志がもう一度名乗った。\n7: 　「俺は三門太志だ」",
  excerpt: "その夜、鏡の前の文佳の体で、太志がもう一度名乗った。",
  settingSays: `第6話 1行目・地の文：人格＝密倉文佳。${RECORD}`,
  textSays: "第6話 6行目・地の文：人格＝三門太志",
  category: "状態",
  settingKnownAt: "第6話",
  source: "identity" as const,
  identity: { record: RECORD, reading: READING },
};

describe("体と心の照合の文面（identity 1.0）", () => {
  const prompt = buildContradictionVerifyPrompt(S6);

  it("出どころ・心と体の記録・コードの読みを渡す", () => {
    expect(prompt).toContain(VERIFY_IDENTITY_SOURCE_NOTE);
    for (const sentence of VERIFY_IDENTITY_KEEP_SENTENCES) expect(prompt).toContain(sentence);
    expect(prompt).toContain(`【心と体の記録】\n${RECORD}`);
    expect(prompt).toContain(`【コードの読み】\n${READING}`);
    // 移動の照合の文面は混ぜない
    expect(prompt).not.toContain(VERIFY_TRAVEL_SOURCE_NOTE);
  });

  it("却下の理由から「まだ明かされていない」を外す（大小とも）", () => {
    for (const smallModel of [false, true]) {
      expect(
        verifyRejectReasonsFor({ settingKnownAt: "第6話", smallModel, source: "identity" })
      ).not.toContain("まだ明かされていない");
    }
    expect(prompt).not.toContain("まだ明かされていない");
  });

  it("「作中の変化」と「そもそも食い違っていない」を体と心の照合の説明に差し替える", () => {
    expect(prompt).toContain("**作中の変化** … 本文に、その心がその体に入る・戻る・入れ替わる描写が書かれている場合だけ。");
    expect(prompt).toContain("心が別の体にいることだけでは、これに当たりません。");
    expect(prompt).not.toContain("人物の身の上が先へ進むのは矛盾ではありません");
    expect(prompt).toContain("**そもそも食い違っていない** … コードの読み（その場面でどの心がその体を動かしているか）が本文と違っていて、両立する場合。");
    expect(prompt).not.toContain(VERIFY_SPEECH_NOTE);
    expect(prompt).toContain("体と心の指摘では、記録の外の心がその体にいて");
  });

  it("出どころと「残せ」の文に、却下の理由の語を含めない（指示の言葉は答えに返ってくる）", () => {
    for (const text of [VERIFY_IDENTITY_SOURCE_NOTE, ...VERIFY_IDENTITY_KEEP_SENTENCES]) {
      for (const reason of VERIFY_REJECT_REASONS) expect(text).not.toContain(reason);
    }
  });

  it("「残せ」の文を写したまま却下してきたら、判断できなかったものとして通す", () => {
    const outcome = parseVerifyOutcome(
      JSON.stringify({
        verdict: "却下",
        reason: "作中の変化",
        explanation: VERIFY_IDENTITY_KEEP_SENTENCES[0],
        confidence: "medium",
      })
    );
    expect(outcome.keep).toBe(true);
  });
});

describe("体と心の照合の候補の振り分けと控えの鍵", () => {
  it("origin が identity の候補だけ identity の文面と版（1.2:identity1.0）", () => {
    expect(CONTRADICTION_VERIFY_IDENTITY_VERSION).toBe("1.0");
    expect(factVerifySourceOf({ origin: "identity" })).toBe("identity");
    expect(factVerifySourceOf({})).toBe("settled");
    expect(factVerifyPromptVersion("identity")).toBe(`${CONTRADICTION_VERIFY_VERSION}:identity1.0`);
    // 本命の版は変えない
    expect(factVerifyPromptVersion("settled")).toBe(CONTRADICTION_VERIFY_VERSION);
  });

  it("材料は候補の根拠（心と体の記録）と理由（コードの読み）。ほかの候補なら無い", () => {
    expect(identityVerifyMaterialOf({ origin: "identity", basis: RECORD, reason: READING })).toEqual({
      record: RECORD,
      reading: READING,
    });
    expect(identityVerifyMaterialOf({ origin: "travel", basis: "x", reason: "y" })).toBeUndefined();
    expect(identityVerifyMaterialOf({ reason: "y" })).toBeUndefined();
  });
});
