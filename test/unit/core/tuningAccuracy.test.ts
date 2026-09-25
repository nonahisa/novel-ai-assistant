import { describe, expect, test } from "vitest";
import {
  TUNING_ACCURACY_BODY,
  describeTypoAccuracyHint,
  describeTypoAccuracyRecord,
  describeTypoAccuracyScore,
  isTypoAccuracyCurrent,
  scoreTypoAccuracy,
  typoAccuracyRecord,
} from "../../../src/core/tuningAccuracy";
import {
  TUNING_WORK_PARAGRAPHS,
  TUNING_WORK_PLANTED_TYPOS,
  TUNING_WORK_PROPER_NOUNS,
  TUNING_WORK_SAMPLE_VERSION,
  TUNING_WORK_TRAPS,
} from "../../../src/core/tuningWorkSample";
import { validateTypoIssues } from "../../../src/core/typoCheckValidation";
import { parseModelTuning } from "../../../src/core/modelTuning";
import {
  TYPO_CHECK_VERSION,
  TYPO_CHECK_VERSION_SMALL,
} from "../../../src/prompts/typoCheck";
import type { Chunk } from "../../../src/core/chunker";

/**
 * AIチューニングの「誤字脱字の精度の目安」の答え合わせ（設計書6.49.9）。
 *
 * **当たりと誤検出の両方を数える**（CLAUDE.md の失敗2）。何も指摘しない
 * モデルが満点にならないこと、何でも指摘するモデルも満点にならないことを
 * 見張る。
 */

/** 1段落目が1行目。段落の番号から行番号へ */
function lineOf(paragraph: number): number {
  return paragraph + 1;
}

/** 置いた誤りを、そのまま正しく直した指摘 */
function perfectIssues() {
  return TUNING_WORK_PLANTED_TYPOS.map((typo) => ({
    line: lineOf(typo.paragraph),
    original: typo.target,
    target: typo.target,
    suggestion: typo.suggestion,
  }));
}

describe("当たりと誤検出を両方数える", () => {
  test("全部を正しく直せば、7件中7件・誤検出0", () => {
    const score = scoreTypoAccuracy(perfectIssues());
    expect(score.total).toBe(TUNING_WORK_PLANTED_TYPOS.length);
    expect(score.hits).toBe(score.total);
    expect(score.falsePositives).toBe(0);
    expect(score.wrongFixes).toBe(0);
  });

  test("何も指摘しないモデルは満点にならない（0件）", () => {
    const score = scoreTypoAccuracy([]);
    expect(score.hits).toBe(0);
    expect(score.missed).toHaveLength(score.total);
    expect(describeTypoAccuracyScore(score)).toContain(`見逃し${score.total}件`);
  });

  test("何でも指摘するモデルは、誤検出が数に出る", () => {
    const score = scoreTypoAccuracy([
      ...perfectIssues(),
      // 誤りでない所への指摘（言い換え）
      { line: 1, original: "霧に包まれていた", target: "包まれていた", suggestion: "覆われていた" },
      { line: 3, original: "古い海図", target: "古い", suggestion: "古びた" },
    ]);
    expect(score.hits).toBe(score.total);
    expect(score.falsePositives).toBe(2);
    expect(score.falsePositiveItems.map((item) => item.target)).toEqual([
      "包まれていた",
      "古い",
    ]);
    // 罠ではない所への誤検出は、罠に掛かった数に入れない
    expect(score.trapHits).toBe(0);
    expect(score.trapTotal).toBe(TUNING_WORK_TRAPS.length);
  });

  test("罠（誤りではないのに直したくなる語）への指摘は誤検出に数え、掛かった罠の数を別に数える", () => {
    const score = scoreTypoAccuracy([
      ...perfectIssues(),
      // 正しい「以外」を「意外」へ
      { line: 1, original: "祖父以外にいない", target: "以外", suggestion: "意外" },
      // 造語を「星読み」へ。同じ罠へ2件
      { line: 4, original: "星詠みの針", target: "詠み", suggestion: "読み" },
      { line: 4, original: "星詠みの針を窓辺", target: "星詠み", suggestion: "星読み" },
      // 方言を標準語へ
      { line: 3, original: "使うとった暗号じゃ", target: "使うとった", suggestion: "使っていた" },
    ]);
    expect(score.hits).toBe(score.total);
    // 作者が消して回る指摘の数（4件）はそのまま誤検出に出る
    expect(score.falsePositives).toBe(4);
    // 掛かった罠は3つ（同じ罠への2件目は、罠の数を増やさない）
    expect(score.trapHits).toBe(3);
    expect(score.trapItems.map((item) => item.kind)).toEqual([
      "正しい同音の語",
      "造語",
      "造語",
      "方言",
    ]);
  });

  test("罠の一覧を渡さなければ、罠は数えない（台を差し替えた答え合わせ）", () => {
    const score = scoreTypoAccuracy(
      [{ line: 1, original: "祖父以外にいない", target: "以外", suggestion: "意外" }],
      TUNING_WORK_PARAGRAPHS,
      TUNING_WORK_PLANTED_TYPOS,
      []
    );
    expect(score.falsePositives).toBe(1);
    expect(score.trapHits).toBe(0);
    expect(score.trapTotal).toBe(0);
  });

  test("切り方が違っても、当てた結果が同じなら当たり（「りり」→「り」）", () => {
    const score = scoreTypoAccuracy([
      { line: 1, original: "しっかりりと", target: "りり", suggestion: "り" },
    ]);
    expect(score.hits).toBe(1);
    expect(score.falsePositives).toBe(0);
  });

  test("場所は合っても直し方が違えば当たりにしない（誤検出にも数えない）", () => {
    const score = scoreTypoAccuracy([
      { line: 2, original: "会っていますか", target: "会って", suggestion: "遭って" },
    ]);
    expect(score.hits).toBe(0);
    expect(score.wrongFixes).toBe(1);
    expect(score.falsePositives).toBe(0);
  });

  test("同じ誤りへの2件目は、誤検出に数えない", () => {
    const score = scoreTypoAccuracy([
      { line: 4, original: "話を効いて", target: "効いて", suggestion: "聞いて" },
      { line: 4, original: "話を効いてみよう", target: "効", suggestion: "聞" },
    ]);
    expect(score.hits).toBe(1);
    expect(score.falsePositives).toBe(0);
  });
});

describe("製品の検算を通した形で数える", () => {
  /** 精度の段が送るのと同じチャンク */
  const chunk: Chunk = {
    filePath: "",
    index: 0,
    text: TUNING_ACCURACY_BODY,
    startLine: 0,
    chapterStart: null,
    chapterEnd: null,
    hash: "",
  };

  test("本文は4段落を1行ずつ並べたもの", () => {
    expect(TUNING_ACCURACY_BODY.split("\n")).toEqual([...TUNING_WORK_PARAGRAPHS]);
  });

  test("置いた誤りの正しい直しは、検算が1件も捨てない（捨てると満点が取れない台になる）", () => {
    const validated = validateTypoIssues(
      {
        issues: TUNING_WORK_PLANTED_TYPOS.map((typo) => ({
          line: lineOf(typo.paragraph),
          original: TUNING_WORK_PARAGRAPHS[typo.paragraph].slice(
            Math.max(0, TUNING_WORK_PARAGRAPHS[typo.paragraph].indexOf(typo.target) - 4),
            TUNING_WORK_PARAGRAPHS[typo.paragraph].indexOf(typo.target) +
              typo.target.length +
              4
          ),
          target: typo.target,
          suggestion: typo.suggestion,
          reason: "誤変換",
          confidence: "high",
        })),
      },
      chunk,
      [...TUNING_WORK_PROPER_NOUNS],
      []
    );
    expect(validated.rejected).toEqual([]);
    const score = scoreTypoAccuracy(validated.accepted);
    expect(score.hits).toBe(TUNING_WORK_PLANTED_TYPOS.length);
    expect(score.falsePositives).toBe(0);
  });

  /*
    **実接続の生の答え**（2026-09-26、さくらの gpt-oss-120b、文の版2、P-09 1.2）。

    版1の測定で、検算が「本文に無い引用」で1件落としていた。生の答えを
    控えて見ると、落ちた3件はどれも**モデルの写し間違い**だった——
    「読めるのは」を「読んだのは」、「灯台」を「灯」＋置き換え文字2つ
    （U+FFFD。サーバーが返した答えにすでに入っていた）、「掛け直し」を
    「掛か直し」と写し、写し間違えた字を「直して」いる。本文に無い引用を
    落とすのは検算の仕事どおりなので、検算は緩めない。
  */
  test("写し間違えた引用は検算が落とし、口語の台詞への指摘は罠に掛かったと数える（実接続の答え）", () => {
    const issue = (line: number, original: string, target: string, suggestion: string) => ({
      line,
      original,
      target,
      suggestion,
      reason: "誤変換",
      confidence: "high",
    });
    const validated = validateTypoIssues(
      {
        issues: [
          issue(1, "栓はしっかりりと閉じられ、中には", "しっかりり", "しっかり"),
          issue(1, "この島でこれを読んだのは、祖父以外に", "読んだ", "読める"),
          issue(2, "灯��の方へ行く道は、こっちで会っていますか", "灯��", "灯台"),
          issue(2, "こっちで会っていますか", "会って", "合って"),
          issue(2, "青年は礼言い、額の汗をぬぐった", "礼言い", "礼を言い"),
          issue(2, "二つ目の角を左です。", "左です", "左に"),
          issue(3, "古い海図を広げてていた。", "てて", "て"),
          issue(3, "とは以外だった。", "以外だった", "意外だった"),
          issue(3, "眼鏡を掛か直し、", "掛か直し", "掛け直し"),
          issue(4, "話を効いてみようと決めた。", "効いて", "聞いて"),
        ],
      },
      chunk,
      [...TUNING_WORK_PROPER_NOUNS],
      []
    );
    expect(validated.rejected.map((rejected) => [rejected.target, rejected.reason])).toEqual([
      ["読んだ", "ungrounded"],
      ["灯��", "ungrounded"],
      ["掛か直し", "ungrounded"],
    ]);
    const score = scoreTypoAccuracy(validated.accepted);
    expect(score.hits).toBe(6);
    expect(score.missed.map((typo) => typo.target)).toEqual(["名前を読んだ"]);
    expect(score.falsePositives).toBe(1);
    expect(score.trapHits).toBe(1);
    expect(score.trapItems).toEqual([{ target: "左です", suggestion: "左に", kind: "口語の台詞" }]);
  });
});

describe("台帳に残す形", () => {
  const score = scoreTypoAccuracy(perfectIssues().slice(0, 5));

  test("頼み方の版と文の版を一緒に残す", () => {
    const record = typoAccuracyRecord(score, false, "2026-09-26T01:02:03.000Z");
    expect(record.typoAccuracyHits).toBe(5);
    expect(record.typoAccuracyTotal).toBe(7);
    expect(record.typoAccuracyPromptVersion).toBe(TYPO_CHECK_VERSION);
    expect(record.typoAccuracySampleVersion).toBe(TUNING_WORK_SAMPLE_VERSION);
    expect(typoAccuracyRecord(score, true, "x").typoAccuracyPromptVersion).toBe(
      TYPO_CHECK_VERSION_SMALL
    );
    expect(record.typoAccuracyTrapHits).toBe(0);
    expect(record.typoAccuracyTrapTotal).toBe(TUNING_WORK_TRAPS.length);
    expect(describeTypoAccuracyRecord(record)).toBe(
      `誤字脱字：7件中5件・誤検出0件（うち罠0/${TUNING_WORK_TRAPS.length}）` +
        `（2026-09-26・P-09 ${TYPO_CHECK_VERSION}）`
    );
  });

  test("罠に掛かった数は、記録の一文にも、割り当ての目安にも出る", () => {
    const trapped = scoreTypoAccuracy([
      { line: 4, original: "星詠みの針", target: "詠み", suggestion: "読み" },
    ]);
    const record = typoAccuracyRecord(trapped, false, "2026-09-26T01:02:03.000Z");
    expect(describeTypoAccuracyRecord(record)).toContain(
      `誤検出1件（うち罠1/${TUNING_WORK_TRAPS.length}）`
    );
    expect(describeTypoAccuracyHint(record)).toContain(`誤検出1（うち罠1）`);
    expect(describeTypoAccuracyScore(trapped)).toContain("罠");
  });

  test("罠を数える前（文の版1）の結果は、罠を言わずに古い結果として出す", () => {
    // 版1の台帳には罠の欄が無い
    const old = {
      typoAccuracyHits: 6,
      typoAccuracyTotal: 7,
      typoAccuracyFalsePositives: 0,
      typoAccuracyPromptVersion: TYPO_CHECK_VERSION,
      typoAccuracySmallPrompt: false,
      typoAccuracySampleVersion: "1",
      typoAccuracyMeasuredAt: "2026-09-26T01:02:03.000Z",
    };
    const text = describeTypoAccuracyRecord(old) ?? "";
    expect(text).not.toContain("罠");
    expect(text).toContain("古い結果");
  });

  test("日付は作者の機械の暦で出す（世界時の頭10字を取らない）", () => {
    // 実接続（2026-09-26 朝6時、日本）で「2026-09-25」と出た。台帳の時刻は世界時
    const morning = new Date(2026, 8, 26, 6, 9, 0).toISOString();
    const record = typoAccuracyRecord(score, false, morning);
    expect(describeTypoAccuracyRecord(record)).toContain("2026-09-26");
  });

  test("台帳を読み直しても同じ（0件も読む）", () => {
    const record = typoAccuracyRecord(scoreTypoAccuracy([]), true, "2026-09-26T00:00:00Z");
    const read = parseModelTuning({ "ollama/gemma4:e4b": record }).get("ollama/gemma4:e4b");
    expect(read).toEqual(record);
    expect(isTypoAccuracyCurrent(read)).toBe(true);
  });

  test("頼み方か文の版が変わった結果は、古い結果として扱う", () => {
    const record = typoAccuracyRecord(score, false, "2026-09-26T00:00:00Z");
    expect(isTypoAccuracyCurrent(record)).toBe(true);
    expect(isTypoAccuracyCurrent({ ...record, typoAccuracyPromptVersion: "1.0" })).toBe(false);
    expect(isTypoAccuracyCurrent({ ...record, typoAccuracySampleVersion: "0" })).toBe(false);
    // 小さいモデル向けを送った結果は、小さいモデル向けのいまの版と比べる
    expect(
      isTypoAccuracyCurrent({
        ...record,
        typoAccuracySmallPrompt: true,
        typoAccuracyPromptVersion: TYPO_CHECK_VERSION_SMALL,
      })
    ).toBe(true);
    expect(describeTypoAccuracyHint({ ...record, typoAccuracyPromptVersion: "1.0" })).toContain(
      "古い結果"
    );
    expect(describeTypoAccuracyRecord({ ...record, typoAccuracySampleVersion: "0" })).toContain(
      "古い結果"
    );
  });

  test("測っていなければ何も言わない", () => {
    expect(describeTypoAccuracyHint(undefined)).toBeUndefined();
    expect(describeTypoAccuracyHint({})).toBeUndefined();
    expect(isTypoAccuracyCurrent(undefined)).toBe(false);
  });

  test("結果の文は「目安」と名乗り、良し悪しを言い切らない", () => {
    const text = describeTypoAccuracyScore(score);
    expect(text).toContain("目安");
    expect(text).toContain("4段落");
    expect(text).toContain("採った・退けた率");
  });
});
