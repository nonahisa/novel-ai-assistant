import { describe, it, expect } from "vitest";
import {
  describeNotationResult,
  NOTATION_SCOPE_NOTE,
  readGroupSelection,
} from "../../src/features/checkNotation";
import type { NotationCheckRunResult } from "../../src/features/checkNotation";
import type { TypoCheckIssue } from "../../src/features/checkTypos";
import type { IncomingCount } from "../../src/core/proposalBuckets";

/**
 * 表記ゆれの完了報告（設計書6.8.9）。
 *
 * **0件のときこそ、理由が要る。** パネルが空のままだと、作者は壊れていると
 * 受け取る。実際に「表記ゆれが提案パネルに出ません」と報告があった
 * （2026-08-21、作者が実機で発見）。
 *
 * 0件になる理由は4つあり、**作者が次に取る手がそれぞれ違う。**
 *
 * **「指摘 N件」の N は、提案パネルに残った件数である**（設計書6.8）。
 * 検知が作った件数をそのまま言うと、前に適用済み・解消済みだったものまで
 * 数えてしまい、パネルの見出しと食い違う。ほかの検知は 0.35.1 で
 * `describeCheckRunCounts` へ揃えたが、表記ゆれだけが残っていた。
 */

const issue = {
  filePath: "本文/001.txt",
  chunkHash: "notation:001.txt:g1",
  line: 3,
  original: "良い天気",
  target: "良い",
  suggestion: "よい",
  reason: "表記ゆれ",
  confidence: "high",
} as unknown as TypoCheckIssue;

/** 提案パネルに残った件数。既定は「1件も残らなかった」 */
function shown(over: Partial<IncomingCount> = {}): IncomingCount {
  return { remaining: 0, handled: 0, ...over };
}

function result(over: Partial<NotationCheckRunResult>): NotationCheckRunResult {
  return {
    issues: [],
    groupCount: 14,
    unifiedCount: 0,
    dismissedCount: 0,
    cancelled: false,
    ...over,
  };
}

describe("指摘が出たとき", () => {
  it("何組を揃えて何件出したかを言う", () => {
    const text = describeNotationResult(
      result({ issues: [issue, issue], unifiedCount: 3, selectedCount: 3 }),
      shown({ remaining: 2 })
    );
    expect(text).toContain("14組");
    expect(text).toContain("3組");
    expect(text).toContain("2件");
  });

  it("無視した分があれば、そう言う", () => {
    const text = describeNotationResult(
      result({ issues: [issue], unifiedCount: 1, dismissedCount: 5 }),
      shown({ remaining: 1 })
    );
    expect(text).toContain("5件");
    expect(text).toContain("無視");
  });

  it("途中で閉じたなら、そこから先を見ていないと言う", () => {
    const text = describeNotationResult(
      result({ issues: [issue], unifiedCount: 1, stoppedEarly: true }),
      shown({ remaining: 1 })
    );
    expect(text).toContain("途中で閉じた");
  });
});

describe("件数は提案パネルに残った数を言う", () => {
  /*
    **通知とパネルの見出しが食い違っていた**（設計書6.8）。誤字脱字などは
    0.35.1 で直したが、表記ゆれだけが「検知が作った件数」を言ったままで、
    前に適用済み・解消済みだった指摘まで数えていた。
  */
  it("前に片付いた分は「指摘」に数えず、別立てで言う", () => {
    const text = describeNotationResult(
      result({ issues: [issue, issue, issue], unifiedCount: 1 }),
      shown({ remaining: 1, handled: 2 })
    );
    expect(text).toContain("指摘 1件");
    expect(text).toContain("2件");
    // 検知が作った3件をそのまま言わない
    expect(text).not.toContain("指摘 3件");
  });

  it("全部が片付いていたなら「指摘 0件」と、その理由を言う", () => {
    // パネルは空になる。**黙って0件と言わない**——なぜ空なのかが要る
    const text = describeNotationResult(
      result({ issues: [issue], unifiedCount: 1 }),
      shown({ remaining: 0, handled: 1 })
    );
    expect(text).toContain("指摘 0件");
    expect(text).toContain("解消済み");
  });
});

describe("0件のとき、理由を言い分ける", () => {
  it("そもそも表記ゆれが無かった", () => {
    const text = describeNotationResult(result({ groupCount: 0 }), shown());
    expect(text).toContain("見つかりませんでした");
  });

  it("揃える表記を選ぶ前に閉じた", () => {
    // **これが作者の踏んだ道である。** もう一度やればよいと伝える
    const text = describeNotationResult(
      result({ stoppedEarly: true, selectedCount: 14 }),
      shown()
    );
    expect(text).toContain("閉じた");
    expect(text).toContain("もう一度");
  });

  it("すべて「この組は揃えない」を選んだ", () => {
    const text = describeNotationResult(
      result({ selectedCount: 5, unifiedCount: 0 }),
      shown()
    );
    expect(text).toContain("5組");
    expect(text).toContain("揃えない");
  });

  it("全部が「今後直さない」に登録済みだった", () => {
    // 次に取る手が違う（「指摘対象外を管理」から外す）
    const text = describeNotationResult(
      result({ selectedCount: 2, unifiedCount: 2, dismissedCount: 30 }),
      shown()
    );
    expect(text).toContain("30件");
    expect(text).toContain("指摘対象外を管理");
  });

  it("どの理由にも当てはまらなくても、黙らない", () => {
    const text = describeNotationResult(
      result({ selectedCount: 1, unifiedCount: 1 }),
      shown()
    );
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("指摘は作られませんでした");
  });
});

/**
 * 揃える組の選択の読み方（作者の実機報告、2026-09-05）。
 *
 * 「校正をまとめて実行で表記ゆれを何も選ばないと動かず終わります」。
 * **「0組のまま確定」と「Escで閉じた」を同じ `undefined` に潰していた**
 * ため、まとめ実行（設計書6.80）が「作者が止めた」と読んで残りの校正を
 * 1つも走らせず、しかも1件目なので通知も出なかった。
 */
describe("揃える組の選択", () => {
  it("何も選ばずに確定したのは「今回は揃えない」（止める意思ではない）", () => {
    expect(readGroupSelection([])).toEqual({ kind: "none" });
  });

  it("Escで閉じたのは、止める意思", () => {
    expect(readGroupSelection(undefined)).toEqual({ kind: "cancelled" });
  });

  it("選ばれた組はそのまま渡す", () => {
    expect(readGroupSelection(["良い/よい"])).toEqual({
      kind: "picked",
      groups: ["良い/よい"],
    });
  });
});

/**
 * **拾える範囲を、実際より広く読ませない**（作者の実機報告、2026-09-06）。
 *
 * これまでの案内は「同じ語が2通り以上の書き方で本文に出ている場合だけを
 * 対象にしています」で、作者には「どんな2通りでも拾う」と読めた。
 * 実際に見ているのは、固有名詞の**ひらがな⇄カタカナの入れ替え**と、
 * 決まった語の一覧だけである（「おばあさん／お婆さん」は拾えない）。
 */
describe("拾える範囲の断り", () => {
  it("かなの入れ替えが対象だと書いてある", () => {
    expect(NOTATION_SCOPE_NOTE).toContain("ひらがな・カタカナ");
  });

  it("漢字の開き閉じは対象外だと断っている", () => {
    expect(NOTATION_SCOPE_NOTE).toContain("対象外");
    // 実機で拾えなかった実例をそのまま示す。抽象的な断りより通じる
    expect(NOTATION_SCOPE_NOTE).toContain("おばあさん");
  });

  it("1行に収まる長さである（QuickPickの見出しに入る）", () => {
    expect(NOTATION_SCOPE_NOTE).not.toContain("\n");
    expect(NOTATION_SCOPE_NOTE.length).toBeLessThan(80);
  });
});
