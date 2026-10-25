import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import {
  ADVICE_HISTORY_MAX,
  ADVICE_REDIAGNOSE_DAYS,
  MAX_AXIS_SCORE,
  SIGNAL_STEP,
} from "../../../src/core/advicePolicy";
import {
  READER_QUESTIONS,
  READER_TYPES,
  resolveReaderType,
  scoreReaderAnswers,
} from "../../../src/core/readerTarget";
import {
  applyAuthorReaderSignals,
  authorReaderBaseScores,
  authorReaderNote,
  authorReaderProfileFromAnswers,
  authorReaderTypeDisplay,
  AUTHOR_READER_ESTIMATE_NOTE,
  AUTHOR_READER_PENDING_NOTE,
  describeAuthorReaderChange,
  describeAuthorReaderEstimate,
  isAnsweredAuthorReader,
  isAuthorReaderEstimatePending,
  isAuthorReaderEstimateSettled,
  isAuthorReaderTuned,
  shownAuthorReader,
  parseAuthorReaderSignals,
  recordEstimatedAuthorReaderType,
  AUTHOR_READER_HISTORY_MAX,
  AUTHOR_READER_QUESTIONS,
  AUTHOR_READER_REDIAGNOSE_DAYS,
  type AuthorReaderProfile,
} from "../../../src/core/authorReaderType";
import {
  AuthorReaderTypeStore,
  AUTHOR_READER_TYPE_KEY,
} from "../../../src/core/authorReaderTypeStore";
import { ADVICE_POLICY_KEY_PREFIX } from "../../../src/core/advicePolicyStore";

/**
 * **作者自身の読者タイプ**（設計書6.101、実装の順「1」）。
 *
 * 作品のターゲット読者（6.91）とは別物である。あちらは「この作品は誰に
 * 届けるか」、こちらは「**作者自身が読者として何を求めるか**」で、
 * **作品ごとではなく作者ごとに1つ**持つ。
 *
 * ここで守るのは4つ。
 *
 * 1. **問いの構造は 6.91 と共有する**（軸・点数はそのまま、文面だけ変える）
 * 2. **作者ごとに1つ**——作品IDで分かれない
 * 3. **履歴の上限・再診断の目安は 6.86 と同じ値**（写しを作らない）
 * 4. **変わったら必ず見せる**——何が何に・なぜ・戻し方の3点
 */

/** その場かぎりの保管庫（`advicePolicyDefault.test.ts` と同じ形） */
function memento(): vscode.Memento {
  const box = new Map<string, unknown>();
  return {
    keys: () => [...box.keys()],
    get: <T>(key: string, fallback?: T) =>
      (box.has(key) ? box.get(key) : fallback) as T,
    update: async (key: string, value: unknown) => {
      if (value === undefined) box.delete(key);
      else box.set(key, value);
    },
  } as vscode.Memento;
}

/** 読み慣れがいちばん高くなる並び（考察層あたり） */
const LORE = [2, 2, 2, 2, 1, 1, 0, 0, 0];
/** どの軸も低い並び（すきま層） */
const LIGHT = [0, 0, 0, 0, 0, 0, 0, 0, 0];

const NOW = new Date("2026-09-19T10:00:00.000Z");

describe("9問は、6.91 の問いを主語だけ変えて使う", () => {
  test("軸と点数の並びは、そっくり同じものを使っている", () => {
    // **写しを作らない。** 別の配列を手で書くと、軸の並びや点数が
    // 片方だけ直る日が来て、同じ物差しで測っているつもりが崩れる
    expect(AUTHOR_READER_QUESTIONS).toHaveLength(READER_QUESTIONS.length);
    for (const [index, question] of AUTHOR_READER_QUESTIONS.entries()) {
      const origin = READER_QUESTIONS[index];
      expect(question.id, `${index}`).toBe(origin.id);
      expect(question.axis, question.id).toBe(origin.axis);
      expect(
        question.choices.map((choice) => choice.score),
        question.id
      ).toEqual(origin.choices.map((choice) => choice.score));
    }
  });

  test("文面は9問すべて書き換わっている（主語が違う）", () => {
    for (const [index, question] of AUTHOR_READER_QUESTIONS.entries()) {
      const origin = READER_QUESTIONS[index];
      // 問いの文は必ず変わる。ここが同じなら、書き換えを忘れている
      expect(question.text, question.id).not.toBe(origin.text);
      // 選択肢は**どちらから読んでも同じ言い方になるもの**があるので
      //（「気持ちよく終わること」）、1つも変わっていないときだけ落とす
      const changed = question.choices.filter(
        (choice, choiceIndex) =>
          choice.label !== origin.choices[choiceIndex].label
      );
      expect(changed.length, question.id).toBeGreaterThan(0);
    }
  });

  test("**書く側の判断ではなく、読む側の答えを聞いている**", () => {
    // 6.91 は「あなたの作品はどうか」を聞く。ここで同じ聞き方をすると、
    // 作品の話に引きずられて、自分の読み癖が出てこない
    for (const question of AUTHOR_READER_QUESTIONS) {
      expect(question.text, question.id).not.toContain("書い");
      expect(question.text, question.id).not.toContain("書きま");
      expect(question.text, question.id).not.toContain("作品の中だけの言葉が出たとき");
    }
  });

  test("同じ採点を通せる（答えの並びが揃っている）", () => {
    // 軸と点数を共有している証拠。別の採点関数を作らない
    expect(scoreReaderAnswers(LORE).familiarity).toBe(6);
    expect(scoreReaderAnswers(LIGHT)).toEqual({
      familiarity: 0,
      posture: 0,
      craving: 0,
    });
  });
});

describe("作者ごとに1つ持つ", () => {
  test("作品IDを取らない鍵で保存する", async () => {
    const box = memento();
    const store = new AuthorReaderTypeStore(box);
    expect(store.get()).toBeUndefined();

    const profile = authorReaderProfileFromAnswers(LORE, NOW);
    await store.set(profile);

    expect(store.get()?.scores).toEqual(profile.scores);
    // 鍵は1つだけ。作品の数だけ写しを作らない
    expect(box.keys()).toEqual([AUTHOR_READER_TYPE_KEY]);
  });

  test("助言方針（6.86）の鍵と踏み合わない", () => {
    expect(AUTHOR_READER_TYPE_KEY.startsWith(ADVICE_POLICY_KEY_PREFIX)).toBe(
      false
    );
  });

  test("消せる（素の状態に戻る）", async () => {
    const store = new AuthorReaderTypeStore(memento());
    await store.set(authorReaderProfileFromAnswers(LORE, NOW));
    await store.clear();
    expect(store.get()).toBeUndefined();
  });
});

describe("履歴と再診断の目安は 6.86 に揃える", () => {
  test("上限も日数も、同じ値を使い回している", () => {
    expect(AUTHOR_READER_HISTORY_MAX).toBe(ADVICE_HISTORY_MAX);
    expect(AUTHOR_READER_REDIAGNOSE_DAYS).toBe(ADVICE_REDIAGNOSE_DAYS);
  });

  test("答え直すと前回が履歴に積まれる。上限で切れる", () => {
    let profile = authorReaderProfileFromAnswers(LIGHT, NOW);
    expect(profile.history ?? []).toEqual([]);

    // 上限より多く積んでも、残るのは上限まで
    for (let i = 0; i < AUTHOR_READER_HISTORY_MAX + 3; i++) {
      profile = authorReaderProfileFromAnswers(
        i % 2 === 0 ? LORE : LIGHT,
        NOW,
        profile
      );
    }
    expect(profile.history).toHaveLength(AUTHOR_READER_HISTORY_MAX);
    expect(profile.history?.[0].source).toBe("diagnosis");
  });

  test("出どころ（診断・推定）を記録に残す", () => {
    const diagnosed = authorReaderProfileFromAnswers(LIGHT, NOW);
    expect(diagnosed.source).toBe("diagnosis");

    // 推定から推定へ（2026-10-25 からは、答えた値の上には推定を書かない）
    const first = recordEstimatedAuthorReaderType(
      undefined,
      scoreReaderAnswers(LIGHT),
      NOW
    );
    const estimated = recordEstimatedAuthorReaderType(
      first,
      scoreReaderAnswers(LORE),
      NOW
    );
    expect(estimated.source).toBe("estimated");
    expect(estimated.answers).toBeUndefined();
    // 前の状態は履歴に残る（消さない）
    expect(estimated.history?.[0].source).toBe("estimated");
    expect(estimated.history?.[0].scores).toEqual(first.scores);

    // 推定のあとに9問へ答えると、推定は履歴へ「推定」として積まれる
    const answered = authorReaderProfileFromAnswers(LIGHT, NOW, estimated);
    expect(answered.source).toBe("diagnosis");
    expect(answered.history?.[0].source).toBe("estimated");
  });

  test("推定でタイプが変わらなければ、履歴を積まない", () => {
    const first = recordEstimatedAuthorReaderType(
      undefined,
      scoreReaderAnswers(LIGHT),
      NOW
    );
    const same = recordEstimatedAuthorReaderType(first, first.scores, NOW);
    expect(same.history ?? []).toEqual([]);
  });
});

/**
 * **作者自身の読者タイプの推定**（設計書6.101。作者の裁定、2026-10-25
 * 「推定を作る」、同日昼「推し量れるまで隠す」「微調整する」）。守るのは4つ。
 *
 * 1. **9問の答えが土台**——答えそのものは書き換えず、微調整はその上に乗る
 * 2. **推定は推定として区別して残す**（`source: "estimated"`・答えを持たない）
 * 3. **AIの出力を信用しない**——軸の -1・0・+1 以外と、層の名前は捨てる
 * 4. **動きは 6.86 と同じ速さ**（±0.5、0〜6）
 */
describe("相談から推し量る（6.101）", () => {
  test("9問に答えていたら、答えは書き換えず、点数だけを微調整する", () => {
    const answered = authorReaderProfileFromAnswers(LIGHT, NOW);
    const later = new Date("2026-09-20T10:00:00.000Z");
    const after = applyAuthorReaderSignals(
      answered,
      { familiarity: 1, posture: 1, craving: 1 },
      later
    );
    expect(isAnsweredAuthorReader(answered)).toBe(true);
    expect(after).not.toBe(answered);
    expect(after?.source).toBe("diagnosis");
    expect(after?.answers).toEqual(LIGHT);
    expect(after?.baseScores).toEqual(scoreReaderAnswers(LIGHT));
    expect(after?.scores).toEqual({
      familiarity: SIGNAL_STEP,
      posture: SIGNAL_STEP,
      craving: SIGNAL_STEP,
    });
    // 答えた日は動かさない（答え直しの目安が来なくなる）。微調整の日は別に持つ
    expect(after?.updatedAt).toBe(NOW.toISOString());
    expect(after?.tunedAt).toBe(later.toISOString());
  });

  test("推定は答えを上書きしない（下の口も、答えた値には書かない）", () => {
    const answered = authorReaderProfileFromAnswers(LIGHT, NOW);
    const after = recordEstimatedAuthorReaderType(
      answered,
      scoreReaderAnswers(LORE),
      NOW
    );
    expect(after).toBe(answered);
    expect(after.source).toBe("diagnosis");
    expect(after.answers).toEqual(LIGHT);
  });

  test("出どころが食い違っていても、答えが残っていれば答えた値として守る", () => {
    const odd: AuthorReaderProfile = {
      scores: scoreReaderAnswers(LIGHT),
      answers: LIGHT,
      source: "estimated",
      updatedAt: NOW.toISOString(),
    };
    const after = applyAuthorReaderSignals(odd, { craving: 1 }, NOW);
    // 推定の点数に置き換えず、答えを土台にした微調整として扱う
    expect(after?.answers).toEqual(LIGHT);
    expect(after?.baseScores).toEqual(odd.scores);
    expect(isAnsweredAuthorReader(after)).toBe(true);
  });

  test("まだ何も無ければ、3軸とも中ほど（3点）から ±0.5 で動かす", () => {
    const after = applyAuthorReaderSignals(
      undefined,
      { familiarity: 1, craving: -1 },
      NOW
    );
    expect(after?.source).toBe("estimated");
    expect(after?.answers).toBeUndefined();
    expect(after?.scores).toEqual({
      familiarity: 3 + SIGNAL_STEP,
      posture: 3,
      craving: 3 - SIGNAL_STEP,
    });
    expect(after?.updatedAt).toBe(NOW.toISOString());
  });

  test("0〜6 に収める。端に張り付いたら動かない（同じものを返す）", () => {
    const top: AuthorReaderProfile = {
      scores: { familiarity: MAX_AXIS_SCORE, posture: 3, craving: 3 },
      source: "estimated",
      updatedAt: NOW.toISOString(),
    };
    expect(applyAuthorReaderSignals(top, { familiarity: 1 }, NOW)).toBe(top);
    expect(applyAuthorReaderSignals(top, { familiarity: 0 }, NOW)).toBe(top);
    expect(applyAuthorReaderSignals(top, undefined, NOW)).toBe(top);
  });

  test("何も読み取れなければ、無いものは無いまま（推測で作らない）", () => {
    expect(applyAuthorReaderSignals(undefined, { posture: 0 }, NOW)).toBeUndefined();
  });

  test("推定を重ねると、見せていた層が変わった回だけ履歴に積む", () => {
    let profile: AuthorReaderProfile | undefined;
    const types: string[] = [];
    // 読み慣れを上へ4回（5点で「高」）→ 求めるものを上へ4回
    const signals = [
      ...Array(4).fill({ familiarity: 1 }),
      ...Array(4).fill({ craving: 1 }),
    ];
    for (const signal of signals) {
      profile = applyAuthorReaderSignals(profile, signal, NOW);
      if (profile) types.push(resolveReaderType(profile.scores));
    }
    expect(profile?.scores.familiarity).toBe(5);
    // 雑食層 → （線を越えて）読み慣れの層 → 別の層、と2回変わるが、
    // 隠していた雑食層からの変化は積まない（作者に見せていない）
    const changes = types.filter((type, i) => i > 0 && type !== types[i - 1]);
    expect(changes.length).toBe(2);
    expect(profile?.history ?? []).toHaveLength(1);
    for (const entry of profile?.history ?? []) {
      expect(entry.source).toBe("estimated");
      expect(entry.typeId).not.toBe("omnivore");
    }
    // 上の端まで動かしても 6 で止まる
    for (let i = 0; i < 4; i++) {
      profile = applyAuthorReaderSignals(profile, { familiarity: 1 }, NOW);
    }
    expect(profile?.scores.familiarity).toBe(MAX_AXIS_SCORE);
  });

  test("AIの値は -1・0・+1 だけを通す。層の名前や指示語は捨てる", () => {
    expect(parseAuthorReaderSignals({ familiarity: 1, posture: -1, craving: 0 })).toEqual({
      familiarity: 1,
      posture: -1,
      craving: 0,
    });
    // 指示語がそのまま返ってきた形・範囲の外・小数
    expect(parseAuthorReaderSignals({ familiarity: "+1" })).toBeUndefined();
    expect(parseAuthorReaderSignals({ familiarity: 3, posture: 0.5 })).toBeUndefined();
    // **層の名前を言ってきても使わない**（名前はコードが点数から決める）
    expect(parseAuthorReaderSignals({ type: "考察層" })).toBeUndefined();
    expect(parseAuthorReaderSignals({ type: "考察層", craving: 1 })).toEqual({
      craving: 1,
    });
    expect(parseAuthorReaderSignals(null)).toBeUndefined();
    expect(parseAuthorReaderSignals([1, 1, 1])).toBeUndefined();
    expect(parseAuthorReaderSignals("familiarity")).toBeUndefined();
  });

  test("推し量ったタイプの名前は、いまの表（11タイプ）の中にしか出ない", () => {
    const known = new Set(Object.keys(READER_TYPES));
    const values = [-1, 0, 1] as const;
    let profile: AuthorReaderProfile | undefined;
    for (let i = 0; i < 60; i++) {
      const signal = {
        familiarity: values[i % 3],
        posture: values[(i * 2) % 3],
        craving: values[(i * 5 + 1) % 3],
      };
      profile = applyAuthorReaderSignals(profile, signal, NOW);
      if (profile) {
        expect(known.has(resolveReaderType(profile.scores))).toBe(true);
      }
    }
  });

  test("初めて推し量ったら言う。出発点の中ほど（雑食層）のうちは言わない", () => {
    const neutralStep = applyAuthorReaderSignals(undefined, { craving: 1 }, NOW);
    // 3.5 は「中」のまま——どの軸にもまだ傾きが無いので言わない
    expect(describeAuthorReaderEstimate(undefined, neutralStep)).toEqual([]);

    let profile = neutralStep;
    let lines: string[] = [];
    for (let i = 0; i < 4 && lines.length === 0; i++) {
      const next = applyAuthorReaderSignals(profile, { craving: 1 }, NOW);
      lines = describeAuthorReaderEstimate(profile, next);
      profile = next;
    }
    const text = lines.join("\n");
    expect(text).toContain("推し量りました");
    expect(text).toContain(
      READER_TYPES[resolveReaderType(profile!.scores)].label
    );
    expect(text).toContain(AUTHOR_READER_ESTIMATE_NOTE);
  });

  test("画面の呼び名は、推し量ったものならそう分かる。推し量れるまでは層を出さない", () => {
    const pending = applyAuthorReaderSignals(undefined, { craving: 1 }, NOW)!;
    expect(authorReaderTypeDisplay(pending)).toBe(AUTHOR_READER_PENDING_NOTE);
    expect(authorReaderTypeDisplay(pending)).not.toContain(READER_TYPES.omnivore.label);

    const settled = recordEstimatedAuthorReaderType(undefined, scoreReaderAnswers(LORE), NOW);
    expect(authorReaderTypeDisplay(settled)).toContain("推し量った");
    const answered = authorReaderProfileFromAnswers(LIGHT, NOW);
    expect(authorReaderTypeDisplay(answered)).not.toContain("推し量った");
    expect(AUTHOR_READER_ESTIMATE_NOTE).toContain("あなたが決めたものではありません");
  });
});

/**
 * **推し量れるまで隠す**（作者の裁定、2026-10-25 昼「推し量れるまで隠した上で、
 * 推定である旨記載してください」）。
 *
 * 出発点が3点（真ん中＝雑食層）なので、隠さないと、はじめはほぼ必ず
 * 「雑食層（推し量ったもの）」が出る。線は「層が出発点から離れたか」。
 */
describe("推し量れるまで出さない（6.101）", () => {
  /** 求めるものだけを n 回上へ動かした推定 */
  function cravingUp(times: number): AuthorReaderProfile | undefined {
    let profile: AuthorReaderProfile | undefined;
    for (let i = 0; i < times; i++) {
      profile = applyAuthorReaderSignals(profile, { craving: 1 }, NOW);
    }
    return profile;
  }

  test("線の手前（上へ3回＝4.5点）は出さず、越えたら（4回＝5点）出す", () => {
    const before = cravingUp(3)!;
    expect(before.scores.craving).toBe(4.5);
    expect(isAuthorReaderEstimateSettled(before)).toBe(false);
    expect(shownAuthorReader(before)).toBeUndefined();
    expect(isAuthorReaderEstimatePending(before)).toBe(true);

    const after = cravingUp(4)!;
    expect(after.scores.craving).toBe(5);
    expect(isAuthorReaderEstimateSettled(after)).toBe(true);
    expect(shownAuthorReader(after)).toBe(after);
    expect(isAuthorReaderEstimatePending(after)).toBe(false);
  });

  test("下へは3回（1.5点で「低」）で層が変わり、出る", () => {
    let profile: AuthorReaderProfile | undefined;
    for (let i = 0; i < 2; i++) {
      profile = applyAuthorReaderSignals(profile, { posture: -1 }, NOW);
    }
    expect(shownAuthorReader(profile)).toBeUndefined();
    profile = applyAuthorReaderSignals(profile, { posture: -1 }, NOW);
    expect(shownAuthorReader(profile)).toBeDefined();
  });

  test("9問に答えた値は、真ん中（雑食層）でも出す", () => {
    const middle = authorReaderProfileFromAnswers([1, 1, 1, 1, 1, 1, 1, 1, 1], NOW);
    expect(resolveReaderType(middle.scores)).toBe("omnivore");
    expect(shownAuthorReader(middle)).toBe(middle);
  });

  test("線を越えた回に初めて「推し量りました」と言う。手前では黙る", () => {
    for (let n = 1; n <= 3; n++) {
      expect(describeAuthorReaderEstimate(cravingUp(n - 1), cravingUp(n))).toEqual([]);
    }
    const text = describeAuthorReaderEstimate(cravingUp(3), cravingUp(4)).join("\n");
    expect(text).toContain("推し量りました");
    expect(text).toContain(AUTHOR_READER_ESTIMATE_NOTE);
  });

  test("出していた層が線の手前へ戻ったら、出すのをやめたと言う（黙って消さない）", () => {
    const shown = cravingUp(4)!;
    const back = applyAuthorReaderSignals(shown, { craving: -1 }, NOW)!;
    expect(shownAuthorReader(back)).toBeUndefined();
    const text = describeAuthorReaderEstimate(shown, back).join("\n");
    expect(text).toContain("出すのをやめました");
  });

  test("隠していた雑食層は、線の手前で9問に答えても履歴に残らない", () => {
    const answered = authorReaderProfileFromAnswers(LORE, NOW, cravingUp(2));
    expect(answered.history ?? []).toEqual([]);
    expect(describeAuthorReaderChange(cravingUp(2), answered)).toEqual([]);
  });
});

/**
 * **9問の答えを土台に、相談から微調整する**（作者の裁定、2026-10-25 昼
 * 「微調整した上で、微調整している旨を表示してください」）。
 */
describe("9問の答えを土台に微調整する（6.101）", () => {
  test("何度動いても、土台は最初の答えの点数のまま", () => {
    let profile: AuthorReaderProfile | undefined = authorReaderProfileFromAnswers(LIGHT, NOW);
    for (let i = 0; i < 5; i++) {
      profile = applyAuthorReaderSignals(profile, { craving: 1 }, NOW);
    }
    expect(profile?.baseScores).toEqual(scoreReaderAnswers(LIGHT));
    expect(profile?.answers).toEqual(LIGHT);
    expect(profile?.scores.craving).toBe(5 * SIGNAL_STEP);
    expect(isAuthorReaderTuned(profile!)).toBe(true);
    expect(authorReaderBaseScores(profile!)).toEqual(scoreReaderAnswers(LIGHT));
  });

  test("答え直すと、新しい答えが土台になる（微調整は捨てる）", () => {
    let profile: AuthorReaderProfile | undefined = authorReaderProfileFromAnswers(LIGHT, NOW);
    profile = applyAuthorReaderSignals(profile, { craving: 1 }, NOW)!;
    const redo = authorReaderProfileFromAnswers(LORE, NOW, profile);
    expect(redo.baseScores).toBeUndefined();
    expect(redo.scores).toEqual(scoreReaderAnswers(LORE));
    expect(authorReaderBaseScores(redo)).toEqual(scoreReaderAnswers(LORE));
    expect(isAuthorReaderTuned(redo)).toBe(false);
    // 答え直したあとの微調整は、新しい答えを土台にする
    const tuned = applyAuthorReaderSignals(redo, { posture: 1 }, NOW)!;
    expect(tuned.baseScores).toEqual(scoreReaderAnswers(LORE));
  });

  test("表示に「微調整」と土台の層が出る", () => {
    const base = authorReaderProfileFromAnswers(LIGHT, NOW);
    const baseLabel = READER_TYPES[resolveReaderType(base.scores)].label;
    expect(authorReaderNote(base)).toBeUndefined();
    expect(authorReaderTypeDisplay(base)).toBe(baseLabel);

    const small = applyAuthorReaderSignals(base, { craving: 1 }, NOW)!;
    // 層は変わっていない（0.5点）が、微調整していることは言う
    expect(resolveReaderType(small.scores)).toBe(resolveReaderType(base.scores));
    expect(authorReaderTypeDisplay(small)).toContain("微調整");
    const note = authorReaderNote(small)!;
    expect(note).toContain("微調整");
    expect(note).toContain(`9問の答え（${baseLabel}）を土台に`);
  });

  test("微調整で層が変わったら「答えは〇〇層、相談から〇〇層へ寄せています」と知らせる", () => {
    let profile: AuthorReaderProfile = authorReaderProfileFromAnswers(LIGHT, NOW);
    const baseLabel = READER_TYPES[resolveReaderType(profile.scores)].label;
    let lines: string[] = [];
    for (let i = 0; i < 6 && lines.length === 0; i++) {
      const next = applyAuthorReaderSignals(profile, { craving: 1 }, NOW)!;
      lines = describeAuthorReaderEstimate(profile, next);
      profile = next;
    }
    const nowLabel = READER_TYPES[resolveReaderType(profile.scores)].label;
    expect(nowLabel).not.toBe(baseLabel);
    expect(lines.join("\n")).toContain(`答えは${baseLabel}、相談から${nowLabel}へ寄せています`);
    expect(authorReaderTypeDisplay(profile)).toContain(`9問の答えは${baseLabel}`);
    expect(authorReaderNote(profile)).toContain(`いまは${nowLabel}へ寄せています`);
    // 層が変わったので履歴に積む。前の層は、答えを微調整したもの（1.5点）だった
    expect(profile.history?.[0].source).toBe("tuned");
    expect(profile.history?.[0].typeId).toBe(resolveReaderType(scoreReaderAnswers(LIGHT)));

    // 層が変わらない微調整では、何も言わない
    const same = applyAuthorReaderSignals(profile, { familiarity: 1 }, NOW)!;
    if (resolveReaderType(same.scores) === resolveReaderType(profile.scores)) {
      expect(describeAuthorReaderEstimate(profile, same)).toEqual([]);
    }

    // 答えの層へ戻ったら、戻ったことを言う
    const back = applyAuthorReaderSignals(profile, { craving: -1 }, NOW)!;
    expect(describeAuthorReaderEstimate(profile, back).join("\n")).toContain("戻りました");
  });
});

describe("変わったら必ず作者に見せる（3点）", () => {
  const before = authorReaderProfileFromAnswers(LIGHT, NOW);
  const after = authorReaderProfileFromAnswers(LORE, NOW, before);

  test("何が何に変わったか・なぜそう読み取ったか・戻し方が入る", () => {
    const lines = describeAuthorReaderChange(before, after);
    const text = lines.join("\n");

    const beforeLabel = READER_TYPES[resolveReaderType(before.scores)].label;
    const afterLabel = READER_TYPES[resolveReaderType(after.scores)].label;
    // ① 何が何に
    expect(text).toContain(beforeLabel);
    expect(text).toContain(afterLabel);
    // ② なぜそう読み取ったか
    expect(text).toContain("9問");
    // ③ 戻し方
    expect(text).toContain("やり直");
  });

  test("変わっていなければ、何も言わない", () => {
    expect(describeAuthorReaderChange(before, before)).toEqual([]);
    expect(describeAuthorReaderChange(undefined, before)).toEqual([]);
  });

  test("推定で変わったときは、そう読み取った理由をそう書く", () => {
    const estimatedBefore = recordEstimatedAuthorReaderType(
      undefined,
      scoreReaderAnswers(LIGHT),
      NOW
    );
    const estimated: AuthorReaderProfile = recordEstimatedAuthorReaderType(
      estimatedBefore,
      scoreReaderAnswers(LORE),
      NOW
    );
    const text = describeAuthorReaderChange(estimatedBefore, estimated).join("\n");
    expect(text).toContain("相談");
    expect(text).not.toContain("9問のお答え");
  });
});
