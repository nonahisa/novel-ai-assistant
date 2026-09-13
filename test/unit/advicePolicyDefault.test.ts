import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import {
  AdvicePolicyStore,
  ADVICE_POLICY_DEFAULT_KEY,
  ADVICE_POLICY_KEY_PREFIX,
  advicePolicyKey,
} from "../../src/core/advicePolicyStore";
import { scoreAnswers, type AdviceProfile } from "../../src/core/advicePolicy";

/**
 * 助言方針の**作者ごとの既定**（設計書6.90.2）。
 *
 * 使用開始時の診断（6.90）は、**まだ作品が1つも無いところ**で9問に答える。
 * 置き先が作品ごとしか無かったので、0.51.0 では**その答えを捨てていた**
 * ——作者の指摘「診断に11タイプは入ってないということですか？」で分かった。
 *
 * ここで守るのは3つ。
 *
 * 1. 作品に無ければ**既定へ落ちる**（はじめの1作で効く）
 * 2. 作品が自分の値を持っていたら、**そちらが勝つ**
 * 3. 鍵が**作品ごとの接頭辞と踏み合わない**
 */

/** その場かぎりの保管庫 */
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

function profileOf(answers: number[]): AdviceProfile {
  const scores = scoreAnswers(answers);
  return {
    scores,
    baseScores: scores,
    answers,
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

/** 読者志向がいちばん高くなる並び */
const READER = profileOf([2, 2, 2, 0, 0, 0, 0, 0, 0]);
/** 嗜好志向がいちばん高くなる並び */
const TASTE = profileOf([0, 0, 0, 0, 0, 0, 2, 2, 2]);

describe("作者ごとの既定", () => {
  test("作品に無ければ、既定へ落ちる", () => {
    const store = new AdvicePolicyStore(memento());
    expect(store.getEffective("w1")).toBeUndefined();

    void store.setDefault(READER);
    // 使用開始時の診断で入れた値が、はじめの1作で効く
    expect(store.getEffective("w1")?.scores).toEqual(READER.scores);
    // ただし「その作品の値」としてはまだ無い
    expect(store.get("w1")).toBeUndefined();
  });

  test("作品が自分の値を持っていたら、そちらが勝つ", async () => {
    const store = new AdvicePolicyStore(memento());
    await store.setDefault(READER);
    await store.set("w1", TASTE);

    expect(store.getEffective("w1")?.scores).toEqual(TASTE.scores);
    // 別の作品は、まだ既定のまま
    expect(store.getEffective("w2")?.scores).toEqual(READER.scores);
  });

  test("作品の方針を消しても、既定は残る", async () => {
    // **「方針を消す」は、その作品の上書きを外す操作である。**
    // 作者が自分で答えた既定まで消えるのは行き過ぎ
    const store = new AdvicePolicyStore(memento());
    await store.setDefault(READER);
    await store.set("w1", TASTE);

    await store.clear("w1");

    expect(store.get("w1")).toBeUndefined();
    expect(store.getEffective("w1")?.scores).toEqual(READER.scores);
  });

  test("**鍵が、作品ごとの接頭辞と踏み合わない**", () => {
    // `novelai.advicePolicy.default` にしていたら、`default` という ID の
    // 作品ができたときに既定を上書きしてしまう
    expect(ADVICE_POLICY_DEFAULT_KEY.startsWith(ADVICE_POLICY_KEY_PREFIX)).toBe(
      false
    );
    expect(ADVICE_POLICY_DEFAULT_KEY).not.toBe(advicePolicyKey("default"));
  });

  test("既定を入れても、作品ごとの値は増えない", async () => {
    // 既定は1つの鍵に収まる。作品の数だけ写しを作らない
    const box = memento();
    const store = new AdvicePolicyStore(box);
    await store.setDefault(READER);

    const keys = box.keys().filter((key) => key.startsWith(ADVICE_POLICY_KEY_PREFIX));
    expect(keys).toEqual([]);
  });
});
