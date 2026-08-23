import { describe, expect, it } from "vitest";
import {
  describeVerifyResults,
  parseVerifyOutcome,
  undecidedOutcome,
} from "../../src/core/contradictionVerifyValidation";
import { factsRevealedAfter } from "../../src/core/settingsAsOf";
import type { RecordChange } from "../../src/models/jsonValidation";

/**
 * 矛盾の検証（設計書6.10.5）と、将来の事実との突き合わせ（6.10.4）。
 *
 * 作者の指示（2026-08-23）：「検証でチャンクが増えてもかまいません。
 * 検出された内容に対し、検証を行うフェーズを追加してください。将来判明する
 * 事実と、それ以前の記述が矛盾している場合も検出したいです」。
 *
 * **ここでいちばん危ないのは、本物の指摘を黙って消すこと。**
 * 検証は誤検出を減らすための工程であって、通信の失敗や応答の崩れで
 * 本物を消してよい理由にはならない。
 */

function outcome(json: unknown): ReturnType<typeof parseVerifyOutcome> {
  return parseVerifyOutcome(JSON.stringify(json));
}

describe("検証の答えを読む", () => {
  it("採用はそのまま通す", () => {
    const result = outcome({
      verdict: "採用",
      reason: "",
      explanation: "地の文どうしが食い違っている",
      confidence: "high",
    });
    expect(result.keep).toBe(true);
    expect(result.undecided).toBe(false);
    expect(result.explanation).toContain("地の文");
  });

  it("理由のある却下は取り下げる", () => {
    const result = outcome({
      verdict: "却下",
      reason: "まだ明かされていない",
      explanation: "第4話で判明する事実",
      confidence: "high",
    });
    expect(result.keep).toBe(false);
    expect(result.reason).toBe("まだ明かされていない");
  });

  /**
   * **「採用」以外を却下と読まない。**
   * 応答が少し崩れただけで本物の指摘が消える。
   */
  it("知らない判定は、判断せずに通す", () => {
    const result = outcome({
      verdict: "たぶん矛盾",
      reason: "",
      explanation: "",
      confidence: "low",
    });
    expect(result.keep).toBe(true);
    expect(result.undecided).toBe(true);
  });

  /**
   * **理由の無い却下は受け取らない。**
   * 何を根拠に消したのかが残らないと、作者は「なぜ出ないのか」を追えない。
   */
  it("理由の無い却下は、通したうえで判断できなかったと扱う", () => {
    const result = outcome({
      verdict: "却下",
      reason: "",
      explanation: "なんとなく",
      confidence: "low",
    });
    expect(result.keep).toBe(true);
    expect(result.undecided).toBe(true);
  });

  it("決められた理由以外の却下も受け取らない", () => {
    const result = outcome({
      verdict: "却下",
      reason: "気に入らない",
      explanation: "",
      confidence: "low",
    });
    expect(result.keep).toBe(true);
    expect(result.undecided).toBe(true);
  });

  it("JSONでない応答は、通す", () => {
    const result = parseVerifyOutcome("すみません、判断できません。");
    expect(result.keep).toBe(true);
    expect(result.undecided).toBe(true);
  });

  it("前後に文が付いていても読める", () => {
    const result = parseVerifyOutcome(
      'はい。```json\n{"verdict":"却下","reason":"作中の変化","explanation":"進学","confidence":"high"}\n```'
    );
    expect(result.keep).toBe(false);
    expect(result.reason).toBe("作中の変化");
  });

  it("確信度が読めなければ low にする", () => {
    const result = outcome({
      verdict: "採用",
      reason: "",
      explanation: "",
      confidence: "とても高い",
    });
    expect(result.confidence).toBe("low");
  });

  it("判断できなかったときの答えは、通す側", () => {
    expect(undecidedOutcome("理由").keep).toBe(true);
    expect(undecidedOutcome("理由").undecided).toBe(true);
  });
});

describe("検証の結果を伝える", () => {
  /** **何件消したかを黙らない**（消しすぎているのか判断できなくなる） */
  it("取り下げた件数と、理由の内訳を出す", () => {
    const text = describeVerifyResults(
      [
        { reason: "まだ明かされていない" },
        { reason: "まだ明かされていない" },
        { reason: "作中の変化" },
      ],
      0
    );
    expect(text).toContain("3件を取り下げ");
    expect(text).toContain("まだ明かされていない 2件");
    expect(text).toContain("作中の変化 1件");
  });

  it("検証できなかったものは、残したと言う", () => {
    const text = describeVerifyResults([], 2);
    expect(text).toContain("2件は検証できず");
    expect(text).toContain("そのまま残しました");
  });

  it("何も無ければ、何も言わない", () => {
    expect(describeVerifyResults([], 0)).toBe("");
  });
});

/**
 * **「まだ知らない」と「両立しない」は別である**（設計書6.10.4）。
 *
 * 第4話で「3ヶ月前に退学した」と分かったとき、第3話がその件に触れて
 * いないのは矛盾ではない。だが第3話に「先週、学校で表彰された」と
 * 書いてあれば両立しない。後者を拾うための材料を集める。
 */
describe("あとで判明する事実", () => {
  function change(field: string, value: string, chapters: number[]): RecordChange {
    return {
      field,
      value,
      chapters,
      timepointId: null,
      note: null,
      evidence: null,
      source: "extracted",
    };
  }

  const record = {
    changes: [
      change("role", "小学生", [1]),
      change("role", "定時制高校生（退学扱い）", [4]),
      change("appearance", "美少女", [5]),
    ],
  };
  const fields = ["role", "appearance"];

  it("その話より後の事実だけを集める", () => {
    const facts = factsRevealedAfter(record, fields, 3);
    expect(facts.map((f) => f.value)).toEqual([
      "定時制高校生（退学扱い）",
      "美少女",
    ]);
  });

  it("近い先の話から順に並べる", () => {
    const facts = factsRevealedAfter(record, fields, 1);
    expect(facts.map((f) => f.chapter)).toEqual([4, 5]);
  });

  it("最後まで来れば、先の事実は無い", () => {
    expect(factsRevealedAfter(record, fields, 5)).toEqual([]);
  });

  it("話が分からないときは集めない", () => {
    expect(factsRevealedAfter(record, fields, null)).toEqual([]);
  });

  it("話数の分からない記録は集めない", () => {
    const noChapter = { changes: [change("role", "謎の人物", [])] };
    expect(factsRevealedAfter(noChapter, fields, 1)).toEqual([]);
  });

  it("変化の記録を持たない種類では、集めない", () => {
    expect(factsRevealedAfter({ role: "商店街" }, fields, 1)).toEqual([]);
  });
});
