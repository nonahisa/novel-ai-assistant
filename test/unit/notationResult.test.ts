import { describe, it, expect } from "vitest";
import {
  describeNoGroups,
  describeNotationResult,
  dropKeptGroups,
  NOTATION_SCOPE_NOTE,
  readGroupSelection,
} from "../../src/features/checkNotation";
import type { NotationCheckRunResult } from "../../src/features/checkNotation";
import type { TypoCheckIssue } from "../../src/features/checkTypos";
import type { IncomingCount } from "../../src/core/proposalBuckets";
import type { NotationVariantGroup } from "../../src/core/notationVariants";
import type { KeepWord } from "../../src/models/keepWord";

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
    keptGroupCount: 0,
    cancelled: false,
    ...over,
  };
}

/** 「今後直さない」に登録された語。日付とメモは判定に使わない */
function keep(...words: string[]): KeepWord[] {
  return words.map((word) => ({ word, note: "", addedAt: "2026-09-22" }));
}

/** 表記ゆれの1組。件数は見ないので、出現は1つずつでよい */
function group(label: string, ...surfaces: string[]): NotationVariantGroup {
  return {
    kind: "kana_kanji",
    key: `kana_kanji:${label}`,
    label,
    forms: surfaces.map((surface) => ({
      surface,
      occurrences: [
        {
          filePath: "本文/001.txt",
          line: 1,
          lineText: surface,
          column: 0,
        },
      ],
    })),
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

  it("見つけた組が全部「今後直さない」だったなら、無かったことにしない", () => {
    const text = describeNotationResult(
      result({ groupCount: 0, keptGroupCount: 3 }),
      shown()
    );
    expect(text).not.toContain("見つかりませんでした");
    expect(text).toContain("3組");
    expect(text).toContain("今後直さない");
    expect(text).toContain("指摘対象外を管理");
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

  /*
    **2つの置き場を取り違えていた**（0.75.3）。`dismissedCount` の実体は
    「無視」ボタンの記録（`TypoDismissedHistory`）で、「指摘対象外を管理」が
    読む `設定/keep_words.json` とは別物である。案内どおりに「指摘対象外を
    管理」を開いても、作者はそこで何も見つけられなかった。
  */
  it("全部が以前「無視」にしたものだった（『今後直さない』とは言わない）", () => {
    const text = describeNotationResult(
      result({ selectedCount: 2, unifiedCount: 2, dismissedCount: 30 }),
      shown()
    );
    expect(text).toContain("30件");
    expect(text).toContain("無視");
    expect(text).not.toContain("指摘対象外を管理");
  });

  it("「今後直さない」で外した組は、無視とは別に名指しする", () => {
    const text = describeNotationResult(
      result({ selectedCount: 2, unifiedCount: 2, dismissedCount: 30, keptGroupCount: 4 }),
      shown()
    );
    // 無視した指摘の件数と、今後直さないで外した組の数は別の数である
    expect(text).toContain("30件");
    expect(text).toContain("4組");
    expect(text).toContain("今後直さない");
    // 外す場所を案内してよいのは「今後直さない」の側だけ
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
 * 「今後直さない」が表記ゆれにも効く（0.75.3）。
 *
 * 提案パネルの「今後直さない」は分類を見ずに出るので、表記ゆれの指摘からも
 * 押せる。押すと `設定/keep_words.json` へ入るが、**表記ゆれだけが
 * `KeepWordStore` を読んでいなかった**（誤字脱字・推敲は読んでいた）。
 * そのため、押しても同じ組が次の実行でまた並んだ。
 */
describe("「今後直さない」に登録済みの組は出さない", () => {
  it("登録済みの語を含む組は、組ごと出さない", () => {
    const { groups, keptGroupCount } = dropKeptGroups(
      [group("良い ↔ よい", "良い", "よい")],
      keep("よい")
    );
    expect(groups).toEqual([]);
    expect(keptGroupCount).toBe(1);
  });

  it("組のどちらの表記で登録されていても外れる", () => {
    // 揃える先が守られている以上、反対側だけ書き換えさせても意味がない
    const { groups } = dropKeptGroups(
      [group("良い ↔ よい", "良い", "よい")],
      keep("良い")
    );
    expect(groups).toEqual([]);
  });

  it("登録の無い組はそのまま出る", () => {
    const { groups, keptGroupCount } = dropKeptGroups(
      [group("全て ↔ すべて", "全て", "すべて")],
      keep("よい")
    );
    expect(groups.map((entry) => entry.label)).toEqual(["全て ↔ すべて"]);
    expect(keptGroupCount).toBe(0);
  });

  it("1つも登録が無ければ、すべてそのまま通る", () => {
    const groups = [group("全て ↔ すべて", "全て", "すべて")];
    expect(dropKeptGroups(groups, []).groups).toEqual(groups);
  });
});

/**
 * 0件の案内（0.75.3）。**純関数に切り出したのは**、0件の理由が
 * 「見つからなかった」と「見つけたが全部守られていた」で違うためである。
 */
describe("1組も出せなかったときの書き出し", () => {
  it("守って外した組が無ければ「見つかりませんでした」", () => {
    expect(describeNoGroups(0)).toContain("見つかりませんでした");
  });

  it("守って外した組があるなら、その数と外し方を言う", () => {
    const text = describeNoGroups(2);
    expect(text).toContain("2組");
    expect(text).toContain("今後直さない");
    expect(text).toContain("指摘対象外を管理");
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

  it("**数字の全角半角も対象だと書いてある**（0.49.4 の積み残し）", () => {
    // 0.49.4 で数字の組を足したのに、断りには入っていなかった。
    // 案内に無いものが指摘に出ると、作者は「なぜこれが出たのか」を調べる
    expect(NOTATION_SCOPE_NOTE).toContain("数字");
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
