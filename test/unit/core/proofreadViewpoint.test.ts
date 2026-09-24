import { describe, expect, test } from "vitest";
import {
  echoesViewpointGuide,
  explainProofreadReason,
  normalizeReason,
  validateProofreadIssues,
} from "../../../src/core/proofreadValidation";
import {
  buildProofreadPrompt,
  PROOFREAD_REASONS,
  PROOFREAD_VERSION,
  PROOFREAD_VIEWPOINT_EXAMPLE,
} from "../../../src/prompts/proofread";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 推敲の7つ目の観点「視点」（P-10 1.10、2026-09-25、人称のよじれ）。
 *
 * 2026-09-24 の測定では、AIは視点のはみ出しに気づいても受け皿が無く、
 * 「係り受け」に押し込むか（B）、「長文」の札で返して検算 `not_long` に
 * 落とされていた（C）。**指示どおりに答えたのに落ちる形**を作らないことと、
 * **指示の言葉がそのまま返る形**（CLAUDE.md の失敗3）を落とすことの両方を見る。
 */

// 台（seeded/contradiction）の第1話に仕込んだ3行を含む本文。行は 11〜14 行目
const TEXT = [
  "　最初にそれを聞いたとき、俺は損をしたのだと思った。",
  "　蓬田さんは内心、この無口な配達員を気に入っていた。",
  "　千夏は伝票を揃えながら、相沢くんはきっと来月も水筒を忘れるだろうと思い、少しだけ胸が温かくなった。",
  "「蓬田さんは本当はさびしいんだよ」",
].join("\n");

function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/001.txt",
    index: 0,
    text,
    startLine: 10,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "abc123",
    segments: [],
  } as unknown as Chunk;
}

const chunk = chunkOf(TEXT);

function validate(items: Array<Record<string, unknown>>) {
  return validateProofreadIssues({ issues: items }, chunk);
}

describe("視点の札を受ける", () => {
  test("視点の指摘は残し、修正案は必ず空にする（直すかどうかは作者が決める）", () => {
    const result = validate([
      {
        line: 12,
        original: "蓬田さんは内心、この無口な配達員を気に入っていた。",
        suggestion: "蓬田さんは、この無口な配達員を気に入っているようだった。",
        reason: "視点",
        explanation: "「俺」の語りなのに、蓬田さんの『内心』が言い切られています",
        confidence: "medium",
      },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ reason: "視点", suggestion: "" });
  });

  test("測定の B：視点の話を「係り受け」で返したら、視点へ付け替える", () => {
    const result = validate([
      {
        line: 12,
        original: "蓬田さんは内心、この無口な配達員を気に入っていた。",
        suggestion: "",
        reason: "係り受け",
        explanation: "一人称の「俺」の視点の中に、突然蓬田さんの内心が混ざり、視点が揺らぎます",
        confidence: "medium",
      },
    ]);
    expect(result.accepted.map((issue) => issue.reason)).toEqual(["視点"]);
  });

  test("「長文」の札でも、説明が視点の話なら not_long で落とさない", () => {
    const result = validate([
      {
        line: 13,
        original: "千夏は伝票を揃えながら、相沢くんはきっと来月も水筒を忘れるだろうと思い",
        suggestion: "",
        reason: "長文",
        explanation: "語り手の俺から、途中で千夏の気持ちへ視点が移っています",
        confidence: "medium",
      },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((issue) => issue.reason)).toEqual(["視点"]);
  });

  test("測定の C の答え（長文で、説明に視点の話が無い）は今までどおり not_long", () => {
    const result = validate([
      {
        line: 13,
        original:
          "千夏は伝票を揃えながら、相沢くんはきっと来月も水筒を忘れるだろうと思い、少しだけ胸が温かくなった。",
        suggestion: "",
        reason: "長文",
        explanation: "72字・読点2個で、千夏の動作と心情が一度に詰め込まれています",
        confidence: "medium",
      },
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["not_long"]);
  });

  test("漢字ひらき・語尾単調は、説明に「語り手」が出ても付け替えない", () => {
    const result = validate([
      {
        line: 11,
        original: "最初にそれを聞いたとき",
        suggestion: "最初にそれをきいたとき",
        reason: "漢字ひらき",
        explanation: "語り手の地の文で『聞いた（きいた）』が詰まります",
        confidence: "low",
      },
    ]);
    expect(result.accepted.map((issue) => issue.reason)).toEqual(["漢字ひらき"]);
  });

  test("説明の「唐突に」「不自然に」は、視点の札では落とさない", () => {
    const result = validate([
      {
        line: 13,
        original: "少しだけ胸が温かくなった。",
        suggestion: "",
        reason: "視点",
        explanation: "俺の語りの途中で、唐突に千夏の胸の内へ移り不自然です",
        confidence: "low",
      },
    ]);
    expect(result.rejected).toEqual([]);
  });

  test("実測の誤検出：語り手自身の独白を、長さ・語調の話として視点の札で出したものは落とす", () => {
    const base = {
      line: 11,
      original: "俺は損をしたのだと思った。",
      suggestion: "",
      reason: "視点",
      confidence: "medium",
    };
    const result = validate([
      { ...base, explanation: "「俺」の語りなのに、自分の心理描写が長いため、少し流れが止まります。" },
      { ...base, explanation: "「俺」の語りなのに、自己分析的な文章が続き、地の文のトーンが不安定になります。" },
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "forbidden_aspect",
      "forbidden_aspect",
    ]);
  });
});

describe("視点の札で落とすもの", () => {
  test("まるごと台詞なら、語りのずれではない（not_narration）", () => {
    const result = validate([
      {
        line: 14,
        original: "「蓬田さんは本当はさびしいんだよ」",
        suggestion: "",
        reason: "視点",
        explanation: "千夏が蓬田さんの心の中を言い切っています",
        confidence: "low",
      },
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["not_narration"]);
  });

  test("指示の文を写しただけの説明は落とす（語尾を変えた写しも）", () => {
    const base = {
      line: 12,
      original: "蓬田さんは内心、この無口な配達員を気に入っていた。",
      suggestion: "",
      reason: "視点",
      confidence: "medium",
    };
    const result = validate([
      { ...base, explanation: "語り手が知り得ない他人の心の中を、地の文が言い切っている" },
      { ...base, explanation: "語り手が知り得ない他人の心の中を地の文が言い切っています" },
      { ...base, explanation: PROOFREAD_VIEWPOINT_EXAMPLE },
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "guide_echo",
      "guide_echo",
      "guide_echo",
    ]);
  });

  test("本文の名前を挙げた説明は、写しとみない", () => {
    expect(
      echoesViewpointGuide("「俺」の語りなのに、蓬田さんの内心が言い切られています")
    ).toBe(false);
    // 短い説明は比べない（「視点」の二字は指示にも正しい説明にも出る）
    expect(echoesViewpointGuide("視点のずれ")).toBe(false);
  });

  test("指示の語を原文として返したら、本文に無いので落ちる", () => {
    const result = validate([
      {
        line: 12,
        original: "語り手が知り得ない他人の心の中",
        suggestion: "",
        reason: "視点",
        explanation: "蓬田さんの内心が書かれています",
        confidence: "low",
      },
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "original_not_found",
    ]);
  });
});

describe("札と指示", () => {
  test("札は7つで、視点が入っている", () => {
    expect(PROOFREAD_REASONS).toHaveLength(7);
    expect(normalizeReason("視点")).toBe("視点");
    expect(normalizeReason("視点のずれ")).toBe("視点");
    expect(explainProofreadReason("視点")).toContain("わざとなら");
  });

  test("プロンプトに視点の定義と「推し量りは違う」が入り、版は 1.10", () => {
    const prompt = buildProofreadPrompt({
      chunkTextWithLineNumbers: "1: 本文",
      narrativeStyle: "",
      maxIssues: 3,
    });
    expect(prompt).toContain("7. 視点");
    expect(prompt).toContain("視点のずれではありません");
    expect(prompt).toContain("、視点");
    expect(PROOFREAD_VERSION).toBe("1.10");
  });
});
