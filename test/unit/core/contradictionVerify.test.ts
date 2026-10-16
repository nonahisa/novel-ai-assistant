import { describe, expect, it } from "vitest";
import {
  describeVerifyResults,
  guardNotYetRevealed,
  parseVerifyOutcome,
  undecidedOutcome,
} from "../../../src/core/contradictionVerifyValidation";
import { buildKnownAtIndex } from "../../../src/core/contradictionValidation";
import { factsRevealedAfter } from "../../../src/core/settingsAsOf";
import type { RecordChange } from "../../../src/models/jsonValidation";

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

/**
 * 口調の但し書き（P-12b 1.1）の言葉が、答えの中身として返ってきたとき
 * （CLAUDE.md「繰り返し起きた失敗」3番）。
 */
describe("口調の但し書きの言葉が答えに写ったとき（2026-10-11）", () => {
  it("但し書きの言葉を理由の欄に書いた却下は、却下として受け取らない", () => {
    const result = outcome({
      verdict: "却下",
      reason: "設定の語尾の変わり型",
      explanation: "『〜ですわ』は『〜でしょ』『〜ね』『〜よ』の語尾の変わり型に含まれる",
      confidence: "medium",
    });
    expect(result.keep).toBe(true);
    expect(result.undecided).toBe(true);
  });

  it("「残せ」の文を説明に写したまま却下してきたら、判断できなかったものとして通す", () => {
    const result = outcome({
      verdict: "却下",
      reason: "そもそも食い違っていない",
      explanation: "本文にきっかけが描かれていなければ、食い違いとして残してください。",
      confidence: "low",
    });
    expect(result.keep).toBe(true);
    expect(result.undecided).toBe(true);
  });

  /**
   * 罠1（蓬田「なんだ、そんな顔をするな」）の正しい却下。但し書きの1文目
   * （同じ話し方のまま語尾だけ違うなら食い違いではない）を写すのは正しい根拠。
   */
  it("「同じ話し方なら食い違いではない」を写した却下は、そのまま却下", () => {
    const result = outcome({
      verdict: "却下",
      reason: "そもそも食い違っていない",
      explanation:
        "設定に挙がった語尾は例なので、同じ話し方（くだけた・ぶっきらぼう など）のまま語尾だけが違うなら食い違いではありません。",
      confidence: "high",
    });
    expect(result.keep).toBe(false);
    expect(result.reason).toBe("そもそも食い違っていない");
  });

  it("10-10 の 26b の却下（変わり型と言うだけ）は、読み取りでは消さない判断をしない（頼み方で直す）", () => {
    // 説明の意味をコードで判定しない（「変形」「変わり型」は罠の正しい却下にも出る）
    const result = outcome({
      verdict: "却下",
      reason: "そもそも食い違っていない",
      explanation: "『〜ですわ』は『〜でしょ』『〜ね』『〜よ』の語尾の変わり型に含まれる",
      confidence: "medium",
    });
    expect(result.keep).toBe(false);
  });
});

/*
  「まだ明かされていない」の却下に、根拠があるかを話数で確かめる（2026-10-16）。

  手元のAIの測定（`docs/measurements/2026-10-16-ai-measure.md`）で、作者の作品の
  写しの第10話の「わたくし、手加減は苦手ですのよ」（設定の一人称は「ボク」）を、
  検出の段は `settingSays: "一人称: ボク"` と正しく挙げたのに、検証の段が
  「まだ明かされていない（一人称の設定が不明）」で取り下げた。

  原因は検証へ渡す「この設定が分かる話」が空（プロンプトでは「（不明）」）だった
  こと。索引（`buildKnownAtIndex`）は変化の記録の値と**完全に一致する**ときしか
  話数を返さず、一人称は変化の記録に載らない。26b は「（不明）」を「設定が不明」と
  読み、3回とも同じ理由で却下した（「第3話」を渡すと3回とも採用）。

  検出へ渡す材料は**その話の時点で分かっていることだけ**（設計書6.10.3）なので、
  「この話より後で明かされる」と言える記録が無いのに却下するのは根拠が無い。
*/
describe("「まだ明かされていない」の却下を話数で確かめる（2026-10-16）", () => {
  const notYet = outcome({
    verdict: "却下",
    reason: "まだ明かされていない",
    explanation:
      "一人称の設定が不明であり、初対面や初登場時の振る舞いとして矛盾とは断定できないため。",
    confidence: "high",
  });

  it("再現：第10話の一人称の指摘は、索引から話数が引けないので却下を受け取らない", () => {
    // 写しのエルシーと同じ形：一人称は変化の記録に無い
    const knownAt = buildKnownAtIndex([
      {
        changes: [
          { field: "role", value: "冒険者", chapters: [8, 10] },
          { field: "personality", value: "冷静沈着", chapters: [10] },
        ],
      },
    ]);
    const guarded = guardNotYetRevealed(notYet, knownAt, "一人称: ボク", 10);
    expect(guarded.keep).toBe(true);
    expect(guarded.undecided).toBe(true);
    // AIの「一人称の設定が不明」を作者へ見せない（資料には一人称がある）
    expect(guarded.explanation).not.toContain("設定が不明");
  });

  it("引けた話数がすべて対象の話以前なら、却下を受け取らない", () => {
    const knownAt = buildKnownAtIndex([
      { changes: [{ field: "role", value: "近衛騎士", chapters: [3, 5] }] },
    ]);
    const guarded = guardNotYetRevealed(notYet, knownAt, "近衛騎士", 10);
    expect(guarded.keep).toBe(true);
    expect(guarded.undecided).toBe(true);
  });

  it("対象より後の話で分かる設定なら、却下のまま", () => {
    const knownAt = buildKnownAtIndex([
      { changes: [{ field: "role", value: "古竜", chapters: [15] }] },
    ]);
    const guarded = guardNotYetRevealed(notYet, knownAt, "古竜", 10);
    expect(guarded.keep).toBe(false);
    expect(guarded.reason).toBe("まだ明かされていない");
  });

  it("対象の話が分からなければ、却下のまま（材料も話数で絞れていない）", () => {
    const guarded = guardNotYetRevealed(notYet, new Map(), "一人称: ボク", null);
    expect(guarded.keep).toBe(false);
  });

  it("ほかの理由の却下と採用には触れない", () => {
    const other = outcome({
      verdict: "却下",
      reason: "作中の変化",
      explanation: "成長による変化",
      confidence: "high",
    });
    expect(guardNotYetRevealed(other, new Map(), "x", 10)).toBe(other);
    const kept = outcome({ verdict: "採用", reason: "", explanation: "", confidence: "high" });
    expect(guardNotYetRevealed(kept, new Map(), "x", 10)).toBe(kept);
  });
});
