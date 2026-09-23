import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import {
  ADVICE_HISTORY_MAX,
  ADVICE_REDIAGNOSE_DAYS,
} from "../../../src/core/advicePolicy";
import {
  READER_QUESTIONS,
  READER_TYPES,
  resolveReaderType,
  scoreReaderAnswers,
} from "../../../src/core/readerTarget";
import {
  authorReaderProfileFromAnswers,
  describeAuthorReaderChange,
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

    const estimated = recordEstimatedAuthorReaderType(
      diagnosed,
      scoreReaderAnswers(LORE),
      NOW
    );
    expect(estimated.source).toBe("estimated");
    // 前の状態は履歴に残る（消さない）
    expect(estimated.history?.[0].source).toBe("diagnosis");
    expect(estimated.history?.[0].scores).toEqual(diagnosed.scores);
  });

  test("推定でタイプが変わらなければ、履歴を積まない", () => {
    const diagnosed = authorReaderProfileFromAnswers(LIGHT, NOW);
    const same = recordEstimatedAuthorReaderType(
      diagnosed,
      diagnosed.scores,
      NOW
    );
    expect(same.history ?? []).toEqual([]);
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
    const estimated: AuthorReaderProfile = recordEstimatedAuthorReaderType(
      before,
      scoreReaderAnswers(LORE),
      NOW
    );
    const text = describeAuthorReaderChange(before, estimated).join("\n");
    expect(text).toContain("相談");
    expect(text).not.toContain("9問のお答え");
  });
});
