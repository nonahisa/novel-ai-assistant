import { describe, expect, test } from "vitest";
import { resolveReaderType, scoreReaderAnswers } from "../../../src/core/readerTarget";
import {
  applyAuthorReaderSignals,
  authorReaderProfileFromAnswers,
  describeAuthorReaderHistory,
  type AuthorReaderProfile,
} from "../../../src/core/authorReaderType";

/**
 * 作者自身の読者タイプの「これまでの変化」（設計書6.101）。
 *
 * 2026-10-25 夕、作者の実機で「これまでの変化」が
 * `没入層（undefined）` と出て、9問の答え（没入層）がどこにも残っていなかった。
 * 作者の保管庫の値（答え直す直前・直後）をそのまま使って写す。
 *
 * 時刻はすべて UTC。日付の表示は端末の時刻帯の日付だが、
 * 07時台（UTC）なら西は -7、東は +16 まで同じ日になる。
 */

const ANSWERED_AT = "2026-10-25T07:21:10.201Z";
const FIRST_TUNE = new Date("2026-10-25T07:28:12.686Z");
const SECOND_TUNE = new Date("2026-10-25T07:31:45.985Z");
const REDO_AT = new Date("2026-10-25T07:58:19.129Z");

/** 07:21 に答えた9問（没入層） */
const DEEP_ANSWERS = [0, 0, 0, 2, 0, 0, 0, 0, 1];
/** 07:58 に答え直した9問（雑食層） */
const REDO_ANSWERS = [1, 1, 2, 1, 1, 1, 1, 1, 0];

/** 09-19 に9問で雑食層（答えの並びは残っていないので点数だけ） */
const SEPTEMBER: AuthorReaderProfile = {
  scores: { familiarity: 4, posture: 4, craving: 2 },
  source: "diagnosis",
  updatedAt: "2026-09-19T11:28:08.026Z",
};

/** 作者の保管庫：答え直す直前（07:31 の微調整のあと） */
const BEFORE_REDO: AuthorReaderProfile = {
  scores: { familiarity: 1, posture: 2, craving: 2 },
  answers: DEEP_ANSWERS,
  source: "diagnosis",
  updatedAt: ANSWERED_AT,
  history: [
    {
      typeId: "deep_pure",
      scores: { familiarity: 0.5, posture: 2, craving: 1.5 },
      updatedAt: "2026-10-25T07:28:12.686Z",
      source: "tuned",
    },
    {
      typeId: "omnivore",
      scores: { familiarity: 4, posture: 4, craving: 2 },
      updatedAt: "2026-09-19T11:28:08.026Z",
      source: "diagnosis",
    },
  ],
  baseScores: { familiarity: 0, posture: 2, craving: 1 },
  tunedAt: "2026-10-25T07:31:45.985Z",
};

/** 作者の保管庫：答え直したあと（このとき動いていた束が書いたもの） */
const AFTER_REDO_SEEN: AuthorReaderProfile = {
  scores: { familiarity: 4, posture: 3, craving: 2 },
  answers: REDO_ANSWERS,
  source: "diagnosis",
  updatedAt: "2026-10-25T07:58:19.129Z",
  history: [
    {
      typeId: "deep_crave",
      scores: { familiarity: 1, posture: 2, craving: 2 },
      updatedAt: ANSWERED_AT,
      source: "diagnosis",
    },
    ...(BEFORE_REDO.history ?? []),
  ],
};

describe("作者の読者タイプの「これまでの変化」（2026-10-25 夕の実機）", () => {
  test("前提：保管庫の点数が指す層（ずれて別の理由で通らないように）", () => {
    expect(scoreReaderAnswers(DEEP_ANSWERS)).toEqual({ familiarity: 0, posture: 2, craving: 1 });
    expect(resolveReaderType({ familiarity: 0, posture: 2, craving: 1 })).toBe("deep_pure");
    expect(resolveReaderType({ familiarity: 0.5, posture: 2, craving: 1.5 })).toBe("deep_pure");
    expect(resolveReaderType({ familiarity: 1, posture: 2, craving: 2 })).toBe("deep_crave");
    expect(scoreReaderAnswers(REDO_ANSWERS)).toEqual({ familiarity: 4, posture: 3, craving: 2 });
    expect(resolveReaderType(scoreReaderAnswers(REDO_ANSWERS))).toBe("omnivore");
  });

  test("問題A：微調整の項目（tuned）には出どころの呼び名が出る（undefined にならない）", () => {
    const lines = describeAuthorReaderHistory(AFTER_REDO_SEEN);
    expect(lines.join("\n")).not.toContain("undefined");
    expect(lines).toContain("2026-10-25 没入層（9問のお答えを相談から微調整したもの）");
  });

  test("問題B前半：微調整中に答え直すと、微調整の結果は「微調整したもの」として積まれる", () => {
    const redo = authorReaderProfileFromAnswers(REDO_ANSWERS, REDO_AT, BEFORE_REDO);
    // 実機で積まれた「感涙層・9問のお答え・07:21」には、いまのコードではならない
    expect(redo.history?.[0]).toEqual({
      typeId: "deep_crave",
      scores: { familiarity: 1, posture: 2, craving: 2 },
      updatedAt: "2026-10-25T07:31:45.985Z",
      source: "tuned",
    });
  });

  test("問題B後半：答え→微調整2回（2回目で層が変わる）→答え直し、で9問の答えが履歴に残る", () => {
    let profile: AuthorReaderProfile = authorReaderProfileFromAnswers(
      DEEP_ANSWERS,
      new Date(ANSWERED_AT),
      SEPTEMBER
    );
    // 07:28 の微調整：0.5 ずつ動くが層は没入層のまま（積まない）
    profile = applyAuthorReaderSignals(profile, { familiarity: 1, craving: 1 }, FIRST_TUNE)!;
    expect(resolveReaderType(profile.scores)).toBe("deep_pure");
    expect(profile.history).toHaveLength(1);
    // 07:31 の微調整：感涙層へ。積むのは、作者に見えていた「9問の答え（没入層）」
    profile = applyAuthorReaderSignals(profile, { familiarity: 1, craving: 1 }, SECOND_TUNE)!;
    expect(resolveReaderType(profile.scores)).toBe("deep_crave");
    expect(profile.history?.[0]).toEqual({
      typeId: "deep_pure",
      scores: { familiarity: 0, posture: 2, craving: 1 },
      updatedAt: ANSWERED_AT,
      source: "diagnosis",
    });

    // 07:58 に答え直して雑食層
    profile = authorReaderProfileFromAnswers(REDO_ANSWERS, REDO_AT, profile);
    expect(describeAuthorReaderHistory(profile)).toEqual([
      "2026-10-25 雑食層（いま）",
      "2026-10-25 感涙層（9問のお答えを相談から微調整したもの）",
      "2026-10-25 没入層（9問のお答え）",
      "2026-09-19 雑食層（9問のお答え）",
    ]);
  });

  test("層の変わらない微調整のまま答え直したら、積むのは答えそのもの（微調整は作者に見えていない）", () => {
    let profile: AuthorReaderProfile = authorReaderProfileFromAnswers(
      DEEP_ANSWERS,
      new Date(ANSWERED_AT),
      SEPTEMBER
    );
    profile = applyAuthorReaderSignals(profile, { familiarity: 1, craving: 1 }, FIRST_TUNE)!;
    profile = authorReaderProfileFromAnswers(REDO_ANSWERS, REDO_AT, profile);
    expect(profile.history?.[0]).toEqual({
      typeId: "deep_pure",
      scores: { familiarity: 0, posture: 2, craving: 1 },
      updatedAt: ANSWERED_AT,
      source: "diagnosis",
    });
  });
});
