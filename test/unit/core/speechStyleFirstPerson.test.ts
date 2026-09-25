import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { validateCharacterExtractResult } from "../../../src/core/characterExtractionValidation";
import {
  claimedFirstPersons,
  withoutFirstPersonClaims,
} from "../../../src/core/speechStyle";
import type {
  CharacterExtractResult,
  ExtractedCharacter,
} from "../../../src/prompts/characterExtract";

/**
 * 口調の値に書かれた一人称を、根拠の台詞で確かめる（3巡目の測定、2026-09-25）。
 *
 * gemma4:26b がエルシーの口調を「一人称は「ウチ」。…」と書いた。「ウチ」は
 * 同じ作品のプラムの一人称で、根拠として写した台詞には一人称が無かった。
 * 検算は台詞が本文の台詞の中にあるかしか見ておらず、一人称は素通りしていた。
 */

// 実データの形を写した場面（プラムは「ウチ」、エルシーは一人称を言わない）
const BODY = [
  "プラムは包丁を置いた。",
  "「ウチが捌いたげるわ」",
  "エルシーは帳面から顔を上げた。",
  "「はい、こちらへどうぞ。素材は奥の台へ」",
].join("\n");

function chunkOf(text: string): Chunk {
  return {
    filePath: "001.txt",
    index: 0,
    text,
    startLine: 0,
    hash: "first-person",
    chapterStart: 1,
    chapterEnd: 1,
  };
}

function elsie(extra: Partial<ExtractedCharacter>): CharacterExtractResult {
  return {
    characters: [
      {
        name: "エルシー",
        entityType: "person",
        evidence: "エルシーは帳面から顔を上げた。",
        ...extra,
      },
    ],
  };
}

describe("口調の値から、書かれた一人称を読み取る", () => {
  test.each<[string, string[]]>([
    ["一人称は「ウチ」。丁寧だが、仕事中は簡潔に答える。", ["ウチ"]],
    ["一人称は「俺」。語尾は「〜だ」「〜だよ」など", ["俺"]],
    ["一人称は俺で、ぶっきらぼうに話す", ["俺"]],
    ["一人称：『わし』。古風な言い回し", ["わし"]],
    ["一人称は「僕」「俺」を使い分ける", ["僕", "俺"]],
    ["「拙者」という一人称で、武士らしく話す", ["拙者"]],
  ])("「%s」→ %j", (value, expected) => {
    expect(claimedFirstPersons(value)).toEqual(expected);
  });

  test.each([
    ["一人称は不明。明るく、余裕のある話し方。"],
    ["丁寧な敬語を使い、落ち着いた口調で話す。"],
    ["語尾に「〜だね」「〜だよ」など"],
  ])("一人称を書いていない「%s」は何も読み取らない", (value) => {
    expect(claimedFirstPersons(value)).toEqual([]);
  });

  test("一人称の部分だけを外す（残りの読みは残す）", () => {
    expect(withoutFirstPersonClaims("一人称は「ウチ」。丁寧だが、仕事中は簡潔に答える。")).toBe(
      "丁寧だが、仕事中は簡潔に答える。"
    );
    expect(withoutFirstPersonClaims("一人称は「ウチ」で、語尾に「〜わ」を付ける")).toBe(
      "語尾に「〜わ」を付ける"
    );
    expect(withoutFirstPersonClaims("一人称は「ウチ」")).toBe("");
  });
});

describe("抽出の検算：一人称が根拠の台詞に無ければ、口調から外す", () => {
  test("エルシーの口調の「ウチ」は、台詞に無いので一人称の部分を外して記録する", () => {
    const value = "一人称は「ウチ」。丁寧だが、仕事中は簡潔に答える。";
    const quote = "「はい、こちらへどうぞ。素材は奥の台へ」";
    const result = validateCharacterExtractResult(
      elsie({ speechStyle: value, speechEvidence: quote }),
      chunkOf(BODY)
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.speechStyle).toBe("丁寧だが、仕事中は簡潔に答える。");
    expect(result.accepted[0].data.speechEvidence).toBe(quote);
    expect(result.droppedSpeechStyles).toEqual([
      {
        characterName: "エルシー",
        speechStyle: value,
        speechEvidence: quote,
        reason: "first_person_unquoted",
        kept: "丁寧だが、仕事中は簡潔に答える。",
      },
    ]);
  });

  test("一人称のほかに何も書いていなければ、口調ごと外す", () => {
    const quote = "「はい、こちらへどうぞ。素材は奥の台へ」";
    const result = validateCharacterExtractResult(
      elsie({ speechStyle: "一人称は「ウチ」。", speechEvidence: quote }),
      chunkOf(BODY)
    );
    expect(result.accepted[0].data.speechStyle).toBeUndefined();
    expect(result.accepted[0].data.speechEvidence).toBeUndefined();
    expect(result.droppedSpeechStyles).toEqual([
      {
        characterName: "エルシー",
        speechStyle: "一人称は「ウチ」。",
        speechEvidence: quote,
        reason: "first_person_unquoted",
      },
    ]);
  });

  test("台詞に一人称があれば、そのまま残す（ひらがな・カタカナの違いは同じとみなす）", () => {
    const result = validateCharacterExtractResult(
      {
        characters: [
          {
            name: "プラム",
            entityType: "person",
            evidence: "プラムは包丁を置いた。",
            speechStyle: "一人称は「うち」。関西風の砕けた話し方",
            speechEvidence: "「ウチが捌いたげるわ」",
          },
        ],
      },
      chunkOf(BODY)
    );
    expect(result.accepted[0].data.speechStyle).toBe("一人称は「うち」。関西風の砕けた話し方");
    expect(result.droppedSpeechStyles).toEqual([]);
  });

  test("漢字の一人称は、台詞に読みのかなで書かれていても通す", () => {
    const body = "カイは笑った。\n「おれが行くよ、任せとけ」";
    const result = validateCharacterExtractResult(
      {
        characters: [
          {
            name: "カイ",
            entityType: "person",
            evidence: "カイは笑った。",
            speechStyle: "一人称は「俺」。気さくな話し方",
            speechEvidence: "「おれが行くよ、任せとけ」",
          },
        ],
      },
      chunkOf(body)
    );
    expect(result.accepted[0].data.speechStyle).toBe("一人称は「俺」。気さくな話し方");
    expect(result.droppedSpeechStyles).toEqual([]);
  });

  test("一人称を書いていない口調には何もしない", () => {
    const value = "丁寧だが、仕事中は簡潔に答える。";
    const result = validateCharacterExtractResult(
      elsie({ speechStyle: value, speechEvidence: "「はい、こちらへどうぞ。素材は奥の台へ」" }),
      chunkOf(BODY)
    );
    expect(result.accepted[0].data.speechStyle).toBe(value);
    expect(result.droppedSpeechStyles).toEqual([]);
  });
});
