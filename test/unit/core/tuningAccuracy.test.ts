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
    expect(describeTypoAccuracyRecord(record)).toBe(
      `誤字脱字：7件中5件・誤検出0件（2026-09-26・P-09 ${TYPO_CHECK_VERSION}）`
    );
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
