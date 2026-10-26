import { describe, expect, it } from "vitest";
import { parseVerifyOutcome } from "../../../src/core/contradictionVerifyValidation";
import {
  deathVerifyMaterialOf,
  factVerifyPromptVersion,
  factVerifySourceOf,
} from "../../../src/core/factContradictionFlow";
import {
  buildContradictionVerifyPrompt,
  CONTRADICTION_VERIFY_DEATH_VERSION,
  CONTRADICTION_VERIFY_VERSION,
  VERIFY_DEATH_KEEP_SENTENCES,
  VERIFY_DEATH_SOURCE_NOTE,
  VERIFY_IDENTITY_SOURCE_NOTE,
  VERIFY_REJECT_REASONS,
  VERIFY_SPEECH_NOTE,
  VERIFY_TRAVEL_SOURCE_NOTE,
  verifyRejectReasonsFor,
} from "../../../src/prompts/contradictionVerify";

/**
 * P-12b death 1.0：死亡後の登場（事実の照合の `findPostDeathAppearances`）から来た指摘にだけ、
 * 確かめの文面を分ける（2026-10-26 の体と心の組の実測 2回目）。
 *
 * e4b は台の仕込み②（第2話で死んだハツが第5話の地の文で味噌汁を作る）を、
 * 「「死亡」という設定は、その時点での事実の記述であり、行動の描写とは矛盾しない」と
 * 「そもそも食い違っていない」で取り下げた。本命（settled）・future・travel・identity の
 * 文面が変わらないことは、それぞれのテストが見張る。
 */
const READING =
  "第2話 7行目に死亡の記録がある。第5話 1行目に『行動＝味噌汁を作っていた』が出てくる";
const DEATH_CONTEXT = "6: \n7: 　祖母のハツが息を引き取ったのは、その夕方のことだった。\n8: ";

const S5 = {
  chapterLabel: "第5話",
  contextWithLineNumbers: "1: 　朝、台所でハツが味噌汁を作っていた。\n2: 　文佳は湯気の向こうの背中を、黙って見ていた。",
  excerpt: "朝、台所でハツが味噌汁を作っていた。",
  settingSays: "第2話 7行目・地の文：死亡＝息を引き取った",
  textSays: "第5話 1行目・地の文：行動＝味噌汁を作っていた",
  category: "状態",
  settingKnownAt: "第2話",
  source: "death" as const,
  death: { reading: READING, deathContext: DEATH_CONTEXT },
};

describe("死亡後の登場の文面（death 1.1）", () => {
  const prompt = buildContradictionVerifyPrompt(S5);

  it("出どころ・問い・コードの読み・死亡の箇所の前後を渡す", () => {
    expect(prompt).toContain(VERIFY_DEATH_SOURCE_NOTE);
    for (const sentence of VERIFY_DEATH_KEEP_SENTENCES) expect(prompt).toContain(sentence);
    expect(prompt).toContain("死亡のあとに、地の文でその人物が行動していることが両立するか");
    // 両立する描写の例を並べる（幽霊・回想・夢・転生・憑依・噂・誤報）
    for (const word of ["幽霊", "回想", "夢", "転生", "憑依", "噂", "誤報"]) {
      expect(prompt).toContain(word);
    }
    expect(prompt).toContain(`【コードの読み】\n${READING}`);
    expect(prompt).toContain(`【死亡の箇所の前後】\n${DEATH_CONTEXT.trim()}`);
    // ほかの照合の文面は混ぜない
    expect(prompt).not.toContain(VERIFY_TRAVEL_SOURCE_NOTE);
    expect(prompt).not.toContain(VERIFY_IDENTITY_SOURCE_NOTE);
  });

  /*
    death 1.1：e4b は仕込み②（第5話のハツ）を「指摘の根拠となる「幽霊」の描写（第5話6行目）が
    あるため」と「作中の変化」で取り下げた。第5話6行目の幽霊は別の人物（千早）のもの
    （docs/measurements/2026-10-26-death-verify.md）
  */
  it("幽霊・回想の描写が指摘された人物自身のものかを確かめさせる（別の人物の描写は理由にならない）", () => {
    expect(VERIFY_DEATH_KEEP_SENTENCES.some((s) => s.includes("指摘された人物自身"))).toBe(true);
    expect(VERIFY_DEATH_KEEP_SENTENCES.some((s) => s.includes("別の人物の描写"))).toBe(true);
    expect(prompt).toContain("指摘された人物自身");
    expect(prompt).toContain("別の人物の描写は、両立の理由になりません。");
    // 「作中の変化」の説明も、その人物自身の描写に限る
    expect(prompt).toContain("本文に、その人物自身の幽霊・転生・憑依・生き返り");
  });

  it("死亡の箇所の前後が無ければ、その欄を出さない", () => {
    const without = buildContradictionVerifyPrompt({
      ...S5,
      death: { reading: READING, deathContext: "" },
    });
    expect(without).not.toContain("【死亡の箇所の前後】");
    expect(without).toContain(`【コードの読み】\n${READING}`);
  });

  it("却下の理由から「まだ明かされていない」を外す（大小とも）", () => {
    for (const smallModel of [false, true]) {
      expect(
        verifyRejectReasonsFor({ settingKnownAt: "第2話", smallModel, source: "death" })
      ).not.toContain("まだ明かされていない");
    }
    expect(prompt).not.toContain("まだ明かされていない");
  });

  it("「作中の変化」と「そもそも食い違っていない」を死亡後の登場の説明に差し替える", () => {
    expect(prompt).toContain("死んだあとに出てくることだけでは、これに当たりません。");
    expect(prompt).not.toContain("人物の身の上が先へ進むのは矛盾ではありません");
    // e4b の取り下げ文（「死亡はその時点の事実の記述」）を、この理由に当たらないと書く
    expect(prompt).toContain("死亡がその時点の事実の記述であることだけでは、これに当たりません。");
    expect(prompt).not.toContain(VERIFY_SPEECH_NOTE);
    expect(prompt).toContain("死亡の指摘では、死んだ人物があとの話の地の文で行動していて");
  });

  it("出どころと「残せ」の文に、却下の理由の語を含めない（指示の言葉は答えに返ってくる）", () => {
    for (const text of [VERIFY_DEATH_SOURCE_NOTE, ...VERIFY_DEATH_KEEP_SENTENCES]) {
      for (const reason of VERIFY_REJECT_REASONS) expect(text).not.toContain(reason);
    }
  });

  it("「残せ」の文を写したまま却下してきたら、判断できなかったものとして通す", () => {
    for (const sentence of VERIFY_DEATH_KEEP_SENTENCES) {
      const outcome = parseVerifyOutcome(
        JSON.stringify({
          verdict: "却下",
          reason: "そもそも食い違っていない",
          explanation: sentence,
          confidence: "medium",
        })
      );
      expect(outcome.keep).toBe(true);
    }
  });
});

describe("死亡後の登場の候補の振り分けと控えの鍵", () => {
  it("origin が death の候補だけ death の文面と版（1.2:death1.1）", () => {
    // 1.1：幽霊・回想の描写が指摘された人物自身のものかを確かめる文を足した（2026-10-26）
    expect(CONTRADICTION_VERIFY_DEATH_VERSION).toBe("1.1");
    expect(factVerifySourceOf({ origin: "death" })).toBe("death");
    expect(factVerifyPromptVersion("death")).toBe(`${CONTRADICTION_VERIFY_VERSION}:death1.1`);
    // 本命・体と心の版は変えない
    expect(factVerifyPromptVersion("settled")).toBe(CONTRADICTION_VERIFY_VERSION);
    expect(factVerifyPromptVersion("identity")).toBe(`${CONTRADICTION_VERIFY_VERSION}:identity1.0`);
  });

  it("材料はコードの読みと、死亡の箇所の前後（窓の外にあるときだけ）。ほかの候補なら無い", () => {
    const source = ["一", "二", "三", "四", "五", "六", "祖母のハツが息を引き取った。", "八", "九"].join("\n");
    const material = deathVerifyMaterialOf({
      candidate: { origin: "death", reason: READING },
      leftPlace: { filePath: "本文/002.txt", line: 7 },
      leftSourceText: source,
      rightPlace: { filePath: "本文/005.txt", line: 1 },
    });
    expect(material?.reading).toBe(READING);
    expect(material?.deathContext).toContain("祖母のハツが息を引き取った。");
    // 同じファイルの窓の中なら、前後は確かめの窓に入っているので重ねない
    expect(
      deathVerifyMaterialOf({
        candidate: { origin: "death", reason: READING },
        leftPlace: { filePath: "本文/005.txt", line: 2 },
        leftSourceText: source,
        rightPlace: { filePath: "本文/005.txt", line: 4 },
      })?.deathContext
    ).toBe("");
    expect(
      deathVerifyMaterialOf({
        candidate: { origin: "identity", reason: "y" },
        rightPlace: { filePath: "本文/005.txt", line: 1 },
      })
    ).toBeUndefined();
  });
});
