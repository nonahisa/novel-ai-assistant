import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { validateCharacterExtractResult } from "../../../src/core/characterExtractionValidation";
import { SPEECH_STYLE_MAX_CHARS } from "../../../src/core/speechStyle";
import type {
  CharacterExtractResult,
  ExtractedCharacter,
} from "../../../src/prompts/characterExtract";

/**
 * 抽出（P-04a）の口調にも、AIで再読込（P-20 2.4）と同じ直し方を当てる
 * （作者の裁定 2026-10-17「人物の抽出の口調にも、再読込と同じ直し方を当てる」）。
 *
 * - 長すぎる口調は、**文の切れ目**で切る（読点で「…と、」のまま残さない）
 * - 口調に書いた一人称が、**その話の台詞のどこにも無い**なら、口調の欄だけを落とす
 *   （人物は残す。落とした件は検算の記録に出す）
 */

function chunkOf(text: string): Chunk {
  return {
    filePath: "012.txt",
    index: 0,
    text,
    startLine: 0,
    hash: "speech-like-enrich",
    chapterStart: 12,
    chapterEnd: 12,
  };
}

// 第12話の形を写した場面：皇子の語り（地の文）に「余」があり、冒険者の台詞は「俺」
const BODY = [
  "余は窓の外を眺めた。退屈な授業だ。",
  "ライナは槍を担ぎ直した。",
  "「俺が先に行く。お前らは後ろだ」",
].join("\n");

const QUOTE = "「俺が先に行く。お前らは後ろだ」";

function raina(extra: Partial<ExtractedCharacter>): CharacterExtractResult {
  return {
    characters: [
      {
        name: "ライナ",
        entityType: "person",
        evidence: "ライナは槍を担ぎ直した。",
        ...extra,
      },
    ],
  };
}

describe("抽出の検算：台詞に無い一人称を書いた口調は、口調の欄だけを落とす", () => {
  test("「場面により余」の余は地の文にしか無いので、口調を落として人物は残す", () => {
    const value = "一人称は俺、場面により余。ぶっきらぼうに短く言い切る。";
    const result = validateCharacterExtractResult(
      raina({ speechStyle: value, speechEvidence: QUOTE }),
      chunkOf(BODY)
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.name).toBe("ライナ");
    expect(result.accepted[0].data.speechStyle).toBeUndefined();
    expect(result.accepted[0].data.speechEvidence).toBeUndefined();
    expect(result.droppedSpeechStyles).toEqual([
      {
        characterName: "ライナ",
        speechStyle: value,
        speechEvidence: QUOTE,
        reason: "first_person_unspoken",
        unspoken: ["余"],
      },
    ]);
  });

  test("台詞にある一人称だけなら、口調はそのまま残す", () => {
    const value = "一人称は俺。ぶっきらぼうに短く言い切る。";
    const result = validateCharacterExtractResult(
      raina({ speechStyle: value, speechEvidence: QUOTE }),
      chunkOf(BODY)
    );
    expect(result.accepted[0].data.speechStyle).toBe(value);
    expect(result.droppedSpeechStyles).toEqual([]);
  });

  test("ほかの人物の台詞にある一人称は、これまでどおり一人称の部分だけ外す", () => {
    // 台詞の話し手までは確かめない（`firstPersonsUnspokenInDialogue` の限界）。
    // 話のどこかの台詞にあれば、根拠の台詞との照合（first_person_unquoted）に任せる
    const body = `${BODY}\nミアが手を振った。\n「ウチも行くで」`;
    const value = "一人称は「ウチ」。ぶっきらぼうに短く言い切る。";
    const result = validateCharacterExtractResult(
      raina({ speechStyle: value, speechEvidence: QUOTE }),
      chunkOf(body)
    );
    expect(result.accepted[0].data.speechStyle).toBe("ぶっきらぼうに短く言い切る。");
    expect(result.droppedSpeechStyles.map((entry) => entry.reason)).toEqual([
      "first_person_unquoted",
    ]);
  });
});

describe("抽出の検算：長すぎる口調は文の切れ目で切る", () => {
  test("上限の手前に句点があれば、読点ではなく句点で切る", () => {
    const value =
      "一人称は俺。語尾は「〜だ」で言い切り、仲間には軽口を叩くが、" +
      "敵の前では口数が減って低い声で唸るように話し、怒ると早口になって声が裏返る";
    expect([...value].length).toBeGreaterThan(SPEECH_STYLE_MAX_CHARS);
    const result = validateCharacterExtractResult(
      raina({ speechStyle: value, speechEvidence: QUOTE }),
      chunkOf(BODY)
    );
    expect(result.accepted[0].data.speechStyle).toBe("一人称は俺。");
  });

  test("句点が無ければ、括弧の外の読点まで戻して句点で閉じる", () => {
    const value =
      "語尾は「〜だ」で言い切り、仲間には軽口を叩くが敵の前では口数が減って" +
      "低い声で唸るように話し怒ると早口になって声が裏返ってしまうことがよくある";
    expect([...value].length).toBeGreaterThan(SPEECH_STYLE_MAX_CHARS);
    const result = validateCharacterExtractResult(
      raina({ speechStyle: value, speechEvidence: QUOTE }),
      chunkOf(BODY)
    );
    expect(result.accepted[0].data.speechStyle).toBe("語尾は「〜だ」で言い切り。");
  });
});
