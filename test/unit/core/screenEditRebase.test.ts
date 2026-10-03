import { describe, expect, it } from "vitest";
import {
  createScreenEditLedger,
  rebaseScreenEdit,
  textFingerprint,
} from "../../../src/core/screenEditRebase";

/**
 * 画面がまだ知らない本体の変更を、打った字の便で戻さない（設計書6.25.9。
 * 作者の裁定「塞ぐ」、2026-10-04）。
 *
 * 0.98.2 までは、本体が文書を変えてから画面へ届くまで（120ミリ秒）に打つと、
 * 画面の全文がそのまま当たり、本体の変更（傍点を外した等）が戻っていた。
 */

const BASE = "前の字と《《強調》》と後ろの字。";
/** 本体が傍点を外した文書 */
const UNEMPHASIZED = "前の字と強調と後ろの字。";

describe("打った所だけを当て直す（rebaseScreenEdit）", () => {
  it("打った所が本体の変更より後ろなら、増減ぶんずらして当てる", () => {
    const screen = BASE + "あ";
    expect(rebaseScreenEdit(BASE, screen, UNEMPHASIZED)).toEqual({
      kind: "apply",
      text: UNEMPHASIZED + "あ",
    });
  });

  it("打った所が本体の変更より前なら、位置はそのまま", () => {
    const screen = "い" + BASE;
    expect(rebaseScreenEdit(BASE, screen, UNEMPHASIZED)).toEqual({
      kind: "apply",
      text: "い" + UNEMPHASIZED,
    });
  });

  it("本体の変更の端にちょうど接して打った字も、どちらも残る", () => {
    // 》》のすぐ後ろ（本体の変更の終わり）に「！」
    const screen = "前の字と《《強調》》！と後ろの字。";
    expect(rebaseScreenEdit(BASE, screen, UNEMPHASIZED)).toEqual({
      kind: "apply",
      text: "前の字と強調！と後ろの字。",
    });
  });

  it("打った所が本体の変更と重なったら、当てない（どちらが正しいか決められない）", () => {
    const screen = "前の字とあと後ろの字。";
    expect(rebaseScreenEdit(BASE, screen, UNEMPHASIZED)).toEqual({ kind: "conflict" });
  });

  it("同じ位置へ両方が字を足したときも、当てない（同じ字なら二重に入るため）", () => {
    expect(rebaseScreenEdit("あい", "あうい", "あえい")).toEqual({ kind: "conflict" });
    // 同じ字なら「うう」と二重に入るところだった。控え帳の側では、文書がもう画面の
    // 本文と同じなら当て直しまで行かずにそのまま通す
    expect(rebaseScreenEdit("あい", "あうい", "あうい")).toEqual({ kind: "conflict" });
    const ledger = createScreenEditLedger();
    ledger.rememberSent("あい");
    expect(ledger.decide({ text: "あうい", base: textFingerprint("あい") }, "あうい")).toMatchObject({
      kind: "apply",
      text: "あうい",
    });
  });

  it("画面に新しく打った所が無ければ、文書のまま", () => {
    expect(rebaseScreenEdit(BASE, BASE, UNEMPHASIZED)).toEqual({ kind: "apply", text: UNEMPHASIZED });
  });

  it("本体の変更が無ければ、画面の本文のまま", () => {
    expect(rebaseScreenEdit(BASE, BASE + "あ", BASE)).toEqual({ kind: "apply", text: BASE + "あ" });
  });

  it("サロゲートペアの字（絵文字）を挟んでも、片割れを作らない", () => {
    const base = "😀前😀後";
    const doc = "😀前😀後ろ";
    const screen = "😀X前😀後";
    const result = rebaseScreenEdit(base, screen, doc);
    expect(result).toEqual({ kind: "apply", text: "😀X前😀後ろ" });
  });
});

describe("元の本文の控え帳（createScreenEditLedger）", () => {
  it("元の本文が今の文書と同じなら、画面の本文をそのまま当てる（ふだんの道）", () => {
    const ledger = createScreenEditLedger();
    ledger.rememberSent(BASE);
    const decision = ledger.decide({ text: BASE + "あ", base: textFingerprint(BASE) }, BASE);
    expect(decision).toMatchObject({ kind: "apply", text: BASE + "あ", rebased: false });
  });

  it("本体の変更が画面へ届く前に打った便は、変更のあとの文書へ当て直す", () => {
    const ledger = createScreenEditLedger();
    ledger.rememberSent(BASE);
    const decision = ledger.decide({ text: BASE + "あ", base: textFingerprint(BASE) }, UNEMPHASIZED);
    expect(decision).toMatchObject({ kind: "apply", text: UNEMPHASIZED + "あ", rebased: true });
  });

  it("当て直したあとの次の便は、前の便の本文を元にして、前の便の字を二重に入れない", () => {
    const ledger = createScreenEditLedger();
    ledger.rememberSent(BASE);
    const first = BASE + "あ";
    const decided = ledger.decide({ text: first, base: textFingerprint(BASE) }, UNEMPHASIZED);
    expect(decided.kind).toBe("apply");
    ledger.rememberApplied(first);
    // 文書は当て直した本文。画面はまだ傍点の外れを知らずに打ち続ける
    const doc = UNEMPHASIZED + "あ";
    const second = BASE + "あい";
    expect(ledger.decide({ text: second, base: textFingerprint(first) }, doc)).toMatchObject({
      kind: "apply",
      text: UNEMPHASIZED + "あい",
      rebased: true,
    });
  });

  it("届いたかが分からず送り直した便（元＝自分の本文）は、もう入っていれば何も変えない", () => {
    const ledger = createScreenEditLedger();
    ledger.rememberSent(BASE);
    const typed = BASE + "あ";
    ledger.rememberApplied(typed);
    // 入ったあとに本体が傍点を外した。送り直しが、それを戻してはいけない
    const doc = UNEMPHASIZED + "あ";
    expect(ledger.decide({ text: typed, base: textFingerprint(typed) }, doc)).toMatchObject({
      kind: "apply",
      text: doc,
    });
  });

  it("入れられなかった便の上に打った便は、さかのぼった元で当てる（入っていない字を入ったことにしない）", () => {
    const ledger = createScreenEditLedger();
    ledger.rememberSent(BASE);
    const first = BASE + "あ";
    ledger.rememberRejected(first, textFingerprint(BASE));
    const second = BASE + "あい";
    expect(ledger.decide({ text: second, base: textFingerprint(first) }, BASE)).toMatchObject({
      kind: "apply",
      text: second,
    });
    // 送り直し（元＝自分の本文）も同じ
    expect(ledger.decide({ text: first, base: textFingerprint(first) }, BASE)).toMatchObject({
      kind: "apply",
      text: first,
    });
  });

  it("重なったら当てず、そのあと同じ鎖で打った便もさかのぼって判断する", () => {
    const ledger = createScreenEditLedger();
    ledger.rememberSent(BASE);
    const screen = "前の字とあと後ろの字。";
    const decision = ledger.decide({ text: screen, base: textFingerprint(BASE) }, UNEMPHASIZED);
    expect(decision).toMatchObject({ kind: "conflict", reason: "overlap" });
    ledger.rememberRejected(screen, decision.baseKey);
    const next = "前の字とあい後ろの字。";
    expect(ledger.decide({ text: next, base: textFingerprint(screen) }, UNEMPHASIZED)).toMatchObject({
      kind: "conflict",
      reason: "overlap",
    });
  });

  it("元の本文を覚えていなければ当てない（届かなかった便の上に打った・控えを越えた）", () => {
    const ledger = createScreenEditLedger();
    expect(ledger.decide({ text: BASE + "あ", base: textFingerprint("知らない本文") }, BASE)).toMatchObject({
      kind: "conflict",
      reason: "unknownBase",
    });
  });

  it("文書がもう画面の本文なら、元を問わずそのまま（何も変えない）", () => {
    const ledger = createScreenEditLedger();
    expect(ledger.decide({ text: BASE, base: textFingerprint("知らない本文") }, BASE)).toMatchObject({
      kind: "apply",
      text: BASE,
    });
  });

  it("元の指紋が無い便（指紋を添える前の送り手）は、今までどおり画面の本文を当てる", () => {
    const ledger = createScreenEditLedger();
    expect(ledger.decide({ text: BASE + "あ" }, UNEMPHASIZED)).toMatchObject({
      kind: "apply",
      text: BASE + "あ",
    });
  });

  it("覚える数を越えた古い本文は忘れる", () => {
    const ledger = createScreenEditLedger(2);
    ledger.rememberSent("一");
    ledger.rememberSent("二");
    ledger.rememberSent("三");
    expect(ledger.decide({ text: "一あ", base: textFingerprint("一") }, "一")).toMatchObject({
      kind: "conflict",
      reason: "unknownBase",
    });
    expect(ledger.decide({ text: "三あ", base: textFingerprint("三") }, "三")).toMatchObject({
      kind: "apply",
    });
  });

  it("自分自身を元にした「入れられなかった」でも、さかのぼりが輪にならない", () => {
    const ledger = createScreenEditLedger();
    ledger.rememberRejected("あ", textFingerprint("あ"));
    expect(ledger.decide({ text: "あい", base: textFingerprint("あ") }, "う")).toMatchObject({
      kind: "conflict",
      reason: "unknownBase",
    });
  });
});

describe("本文の指紋（textFingerprint）", () => {
  it("字数を添え、同じ本文には同じ指紋を返す", () => {
    expect(textFingerprint("あいう")).toBe(textFingerprint("あいう"));
    expect(textFingerprint("あいう")).toMatch(/^[0-9a-f]{8}:3$/);
    expect(textFingerprint("あいう")).not.toBe(textFingerprint("あいえ"));
  });
});
