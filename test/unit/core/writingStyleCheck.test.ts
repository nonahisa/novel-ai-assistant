import { describe, expect, test } from "vitest";
import { checkWritingStyle } from "../../../src/core/writingStyleCheck";
import type { Chunk } from "../../../src/core/chunker";

function makeChunk(text: string, startLine = 0): Chunk {
  return {
    filePath: "C:\\work\\001.txt",
    index: 0,
    text,
    startLine,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "hash-1",
  };
}

describe("三点リーダー・ダッシュの偶数使用", () => {
  test("奇数個の三点リーダーを検出する", () => {
    const chunk = makeChunk("彼は…と呟いた。");
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === "…");
    expect(found).toBeDefined();
    expect(found?.suggestion).toBe("……");
    expect(found?.confidence).toBe("medium");
  });

  test("偶数個（2個）は検出しない", () => {
    const chunk = makeChunk("彼は……と呟いた。");
    const findings = checkWritingStyle(chunk);
    expect(findings.find((f) => f.target.includes("…"))).toBeUndefined();
  });

  test("3個（奇数）も検出し、1個足す提案にする", () => {
    const chunk = makeChunk("彼は………と黙り込んだ。");
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === "………");
    expect(found).toBeDefined();
    expect(found?.suggestion).toBe("…………");
  });

  test("奇数個のダッシュを検出する", () => {
    const chunk = makeChunk("突然―扉が開いた。");
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === "―");
    expect(found).toBeDefined();
    expect(found?.suggestion).toBe("――");
  });

  test("偶数個のダッシュは検出しない", () => {
    const chunk = makeChunk("突然――扉が開いた。");
    const findings = checkWritingStyle(chunk);
    expect(findings.find((f) => f.target.includes("―"))).toBeUndefined();
  });
});

/**
 * ダッシュに使われる2つの文字（作者の実機報告、2026-08-29）。
 *
 * 「主従の悪だくみが始まった――」の2本のあいだに隙間が見え、しかも
 * **偶数個なのに「奇数だ」と指摘された。** 片方が欧文の U+2014、もう片方が
 * 和文の U+2015 だったためである。
 *
 * **この2つは、見た目でも編集画面でも見分けが付かない。** 取り違えると
 * 試験そのものが嘘になるので、ここでは符号から文字を作る。
 */
describe("ダッシュの字の混在", () => {
  /** 欧文のダッシュ（U+2014 EM DASH） */
  const EM = String.fromCodePoint(0x2014);
  /** 和文のダッシュ（U+2015 HORIZONTAL BAR）。作法で使うのはこちら */
  const BAR = String.fromCodePoint(0x2015);

  test("字が違うことを、まず確かめておく", () => {
    // ここが同じなら、以下の試験は何も見ていないことになる
    expect(EM).not.toBe(BAR);
  });

  test("混ざった2個は、偶数でも指摘して字を揃える", () => {
    const chunk = makeChunk("主従の悪だくみが始まった" + EM + BAR);
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === EM + BAR);

    expect(found).toBeDefined();
    // 個数はそのまま2個。字だけを和文へ揃える
    expect(found?.suggestion).toBe(BAR + BAR);
    expect(found?.reason).toContain("ダッシュの字が混ざっています");
    expect(found?.confidence).toBe("medium");
  });

  test("欧文のダッシュ1個は、字を揃えたうえで偶数にする", () => {
    const chunk = makeChunk("突然" + EM + "扉が開いた。");
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === EM);

    expect(found).toBeDefined();
    expect(found?.suggestion).toBe(BAR + BAR);
  });

  test("和文のダッシュだけの偶数個は、これまでどおり指摘しない", () => {
    const chunk = makeChunk("突然" + BAR + BAR + "扉が開いた。");
    const findings = checkWritingStyle(chunk);

    expect(findings.find((f) => f.target.includes(BAR))).toBeUndefined();
  });

  test("和文のダッシュだけの奇数個は、これまでどおりの理由で指摘する", () => {
    const chunk = makeChunk("突然" + BAR + "扉が開いた。");
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === BAR);

    expect(found).toBeDefined();
    expect(found?.suggestion).toBe(BAR + BAR);
    // 字は混ざっていないので、混在の理由文にはしない
    expect(found?.reason).not.toContain("ダッシュの字が混ざっています");
  });

  test("三点リーダーの判定は変えていない", () => {
    // ダッシュ側をいじった巻き添えで「…」が壊れていないこと
    const odd = checkWritingStyle(makeChunk("彼は…と呟いた。"));
    expect(odd.find((f) => f.target === "…")?.suggestion).toBe("……");

    const even = checkWritingStyle(makeChunk("彼は……と呟いた。"));
    expect(even.find((f) => f.target.includes("…"))).toBeUndefined();
  });
});

describe("鉤括弧内文末の句点", () => {
  test("「。」の組み合わせを検出し、句点を落とす提案にする", () => {
    const chunk = makeChunk("「これはテストだ。」と彼は言った。");
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === "。」");
    expect(found).toBeDefined();
    expect(found?.suggestion).toBe("」");
  });

  test("『。』の組み合わせも検出する", () => {
    const chunk = makeChunk("『それは違う。』と反論した。");
    const findings = checkWritingStyle(chunk);
    expect(findings.find((f) => f.target === "。』")).toBeDefined();
  });

  test("句点が無ければ検出しない", () => {
    const chunk = makeChunk("「これはテストだ」と彼は言った。");
    const findings = checkWritingStyle(chunk);
    expect(findings.find((f) => f.target.includes("」"))).toBeUndefined();
  });
});

describe("感嘆符・疑問符後の空白", () => {
  test("後にスペースが無ければ検出する", () => {
    const chunk = makeChunk("何だって！本当か？困った。");
    const findings = checkWritingStyle(chunk);
    const marks = findings.filter((f) => f.reason.includes("感嘆符"));
    expect(marks).toHaveLength(2);
    expect(marks[0].target).toBe("！本");
    expect(marks[0].suggestion).toBe("！　本");
  });

  test("すでに全角スペースがあれば検出しない", () => {
    const chunk = makeChunk("何だって！　本当か？");
    const findings = checkWritingStyle(chunk);
    expect(findings.filter((f) => f.reason.includes("感嘆符"))).toHaveLength(0);
  });

  test("行末・閉じ括弧の直前・！？の連続は検出しない", () => {
    const chunk = makeChunk("「本当か！」　何だと！？　まさか！");
    const findings = checkWritingStyle(chunk);
    expect(findings.filter((f) => f.reason.includes("感嘆符"))).toHaveLength(0);
  });

  test("あらゆる閉じ括弧・句読点・リーダーの直前も検出しない", () => {
    // 「！》」に「1マス空けて」と出た（作者の指摘、2026-09-04）。
    // 」』）以外の閉じが一覧から漏れていた
    const chunk = makeChunk(
      "《破城槌！》『応！』（噓！）【何！】〔まさか！〕｛おい！｝［да！］" +
        "“なに！”とある。おい！、待て！。ほう！…続く！―終わり"
    );
    const findings = checkWritingStyle(chunk);
    expect(findings.filter((f) => f.reason.includes("感嘆符"))).toHaveLength(0);
  });
});

describe("行番号とテスト対象外のルール", () => {
  test("startLineを基準に1始まりの行番号を付ける", () => {
    const chunk = makeChunk("見出し\n彼は…と呟いた。", 9);
    const findings = checkWritingStyle(chunk);
    const found = findings.find((f) => f.target === "…");
    expect(found?.line).toBe(11);
  });

  test("すべての指摘に「意図的な表現であれば無視」という文言が入る", () => {
    const chunk = makeChunk("彼は…と呟いた。「テストだ。」何だって！困った。");
    const findings = checkWritingStyle(chunk);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.reason).toContain("意図的な表現であれば無視してください");
    }
  });
});

/**
 * 行の頭の字下げが半角（U+0020・U+00A0・タブ）になっている行（作者の報告 2026-11-16
 * 「校正で字下げが指摘されませんでした」。IME の設定で字下げが半角の空白になっていた）。
 * 本文は書き換えず、全角の空白へ置き換える案を指摘として出すだけ。
 */
describe("字下げが半角の空白", () => {
  const indentFindings = (text: string, filePath = "C:\\work\\001.txt") =>
    checkWritingStyle({ ...makeChunk(text), filePath }).filter((f) => f.reason.includes("字下げ"));

  test("行の頭の半角の空白を、全角の空白へ置き換える案で指摘する", () => {
    const found = indentFindings("　雨が上がった。\n 傘を閉じた。\n");
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
    expect(found[0].target).toBe(" 傘");
    expect(found[0].suggestion).toBe("　傘");
    expect(found[0].original.startsWith(" 傘")).toBe(true);
    expect(found[0].confidence).toBe("medium");
    expect(found[0].reason).toContain("意図的な表現であれば無視してください");
  });

  test("U+00A0・タブ・全角と半角の混ざりも、同じ数の全角へ", () => {
    const nbsp = String.fromCodePoint(0xa0);
    expect(indentFindings(`${nbsp}雨。`)[0]?.suggestion).toBe("　雨");
    expect(indentFindings("\t雨。")[0]?.suggestion).toBe("　雨");
    expect(indentFindings("　 雨。")[0]?.suggestion).toBe("　　雨");
  });

  test("指摘しない：全角の字下げ・字下げの無い行・会話文の頭・空白だけの行", () => {
    expect(indentFindings("　雨が上がった。\n「行こう」\n雨。\n   \n\n")).toEqual([]);
  });

  test("指摘しない：英字や数字が続く行（欧文・表の揃え）", () => {
    expect(indentFindings(" Hello World\n 12時\n")).toEqual([]);
  });

  test("Markdown では、箇条書き・引用・入れ子・コードの字下げを指摘しない。和文の頭の半角1つは指摘する", () => {
    const md = "C:\\work\\001.md";
    expect(indentFindings("  - 項目\n > 引用\n    コード\n\t入れ子\n 1. 番号\n", md)).toEqual([]);
    expect(indentFindings(" 雨が上がった。\n", md)).toHaveLength(1);
  });
});
