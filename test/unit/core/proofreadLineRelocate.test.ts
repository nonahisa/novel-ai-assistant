import { describe, expect, test } from "vitest";
import { validateProofreadIssues } from "../../../src/core/proofreadValidation";
import type { Chunk } from "../../../src/core/chunker";

/**
 * 推敲の検算：AIが申告した行を、原文が実際にある行へ直す（設計書6.30、2026-10-10）。
 *
 * 矛盾検知（0.101.2）・誤字脱字と逸脱検知（0.101.3）と同じ決まり。
 * 原文の照合はチャンク全体で見るので、行番号を言い間違えても検算を通り、
 * ずれた行のまま一覧へ出ていた。視点・台詞の検査は「申告の行 → 最初に
 * 見つかった行」の順で探していたので、同じ原文が2か所あると遠いほうで
 * 検査することがあった。
 */

function chunkOf(text: string, startLine = 10): Chunk {
  return {
    filePath: "C:/works/001.txt",
    index: 0,
    text,
    startLine,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "abc123",
    segments: [],
  } as unknown as Chunk;
}

// 行は 11〜16 行目（startLine 10 の次から）
const PLAIN = chunkOf(
  [
    "　朝の駅は人が少なかった。",
    "　俺は改札を抜けて、ホームの端まで歩いた。",
    "　電車はなかなか来なかった。",
    "　ベンチに座って、鞄から本を取り出した。",
    "　風が冷たかった。",
    "　俺は改札を抜けて、ホームの端まで歩いた。",
  ].join("\n")
);

function kakari(line: number, original: string) {
  return {
    line,
    original,
    suggestion: "",
    reason: "係り受け",
    explanation: "どこに係るかが読み取りにくい",
    confidence: "medium",
  };
}

describe("推敲：申告の行を原文のある行へ直す", () => {
  test("申告がずれていたら、原文のある行へ直す", () => {
    const result = validateProofreadIssues(
      { issues: [kakari(11, "鞄から本を取り出した")] },
      PLAIN
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].line).toBe(14);
  });

  test("申告の行に原文があれば、そのまま", () => {
    const result = validateProofreadIssues(
      { issues: [kakari(14, "鞄から本を取り出した")] },
      PLAIN
    );
    expect(result.accepted[0].line).toBe(14);
  });

  test("同じ原文が2か所にあれば、申告に近いほうへ", () => {
    // 12 行目と 16 行目に同じ文。申告 15 は 16 のほうが近い
    const result = validateProofreadIssues(
      { issues: [kakari(15, "改札を抜けて、ホームの端まで")] },
      PLAIN
    );
    expect(result.accepted[0].line).toBe(16);
  });

  test("申告が範囲の外なら、直さずに落とす（今までどおり）", () => {
    const result = validateProofreadIssues(
      { issues: [kakari(3, "鞄から本を取り出した")] },
      PLAIN
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("line_out_of_range");
  });

  test("まとめたチャンクでも、番号は startLine + index + 1 のまま", () => {
    const merged = chunkOf(["　一行目。", "　二行目の文。", "　三行目の文。"].join("\n"), 40);
    const result = validateProofreadIssues(
      { issues: [kakari(41, "三行目の文")] },
      merged
    );
    expect(result.accepted[0].line).toBe(43);
  });
});

describe("推敲：視点の検査を、申告に近いほうの原文で行う", () => {
  // 1〜3行目は三人称の場面、区切りのあと 5〜9 行目は「俺」の場面。
  // 同じ一文が両方の場面にある。AIは「俺」の場面の行を1つずらして申告した
  const SENTENCE = "　蓬田さんは内心、この無口な配達員を気に入っていた。";
  const TWO_SCENES = chunkOf(
    [
      "　千夏は伝票を揃えていた。",
      SENTENCE,
      "　千夏は窓の外を見た。",
      "◇◇◇",
      "　俺は坂の途中で足を止めた。",
      SENTENCE,
      "　俺の足首はまだ痛んだ。",
      "　俺は息を整えた。",
      "　俺は荷物を持ち直した。",
    ].join("\n")
  );

  test("遠いほうの三人称の場面で検査して落とさない", () => {
    const result = validateProofreadIssues(
      {
        issues: [
          {
            // 正しくは 16 行目（startLine 10 + 6）。1つずれて 17
            line: 17,
            original: "蓬田さんは内心、この無口な配達員を気に入っていた。",
            suggestion: "",
            reason: "視点",
            explanation: "「俺」の語りなのに、蓬田さんの『内心』が言い切られています",
            confidence: "medium",
          },
        ],
      },
      TWO_SCENES
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].line).toBe(16);
  });
});
