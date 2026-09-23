import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import {
  AdvicePolicyStore,
  ADVICE_POLICY_DEFAULT_KEY,
  ADVICE_POLICY_KEY_PREFIX,
  advicePolicyKey,
} from "../../../src/core/advicePolicyStore";
import { scoreAnswers, type AdviceProfile } from "../../../src/core/advicePolicy";

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
 * 2. 作品が自分の値を持っていたら、**そちらが勝つ**——ただし**既定を
 *    後から答え直したら、既定が勝つ**（2026-09-23。下の節）
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

  test("作品が自分の値を持っていたら、そちらが勝つ（既定と同じ日か、それより後に答えた値）", async () => {
    const store = new AdvicePolicyStore(memento());
    await store.setDefault(READER);
    await store.set("w1", TASTE);

    expect(store.getEffective("w1")?.scores).toEqual(TASTE.scores);
    // 別の作品は、まだ既定のまま
    expect(store.getEffective("w2")?.scores).toEqual(READER.scores);
  });
});

/**
 * **答え直した既定が、推定で写された作品の値に負けていた**（点検、2026-09-23）。
 *
 * 相談で推定が一度でも動くと、その作品に既定の写しができる
 * （`workChatPanel.updateAdvicePolicy`）。0.79.0 で作品ごとの入口を外したので、
 * 作者が答え直せるのは既定だけ——なのに相談は写しを先に使い、答え直しが
 * **二度と届かなかった**。
 *
 * 規則：**作者が9問に答えた日（`updatedAt`）の新しいほうが勝つ。** 推定は
 * この日を動かさないので、自動の写しは写した元の日付のまま残る。
 */
describe("答え直した既定は、それより古い作品の値に勝つ", () => {
  /** 既定から写され、相談の推定で動いた作品の値 */
  function drifted(from: AdviceProfile): AdviceProfile {
    return {
      ...from,
      scores: { ...from.scores, taste: from.scores.taste + 1.5 },
      baseScores: from.scores,
    };
  }

  test("既定を答え直すと、相談はその答えを使う（推定で動いた分は捨てる）", async () => {
    const store = new AdvicePolicyStore(memento());
    await store.setDefault(READER);
    // 相談で推定が動いて、作品に写しができた（日付は写した元のまま）
    await store.set("w1", drifted(READER));

    // 作者が既定を答え直した（後の日付）
    const again: AdviceProfile = {
      ...TASTE,
      updatedAt: "2026-09-20T00:00:00.000Z",
    };
    await store.setDefault(again);

    expect(store.getEffective("w1")?.scores).toEqual(again.scores);
    expect(store.getEffective("w1")?.updatedAt).toBe(again.updatedAt);
    // 作品の値そのものは消さない（読むだけ）
    expect(store.get("w1")?.scores).toEqual(drifted(READER).scores);
  });

  test("答え直したあとに推定で動いた作品の値は、そのまま勝つ", async () => {
    const store = new AdvicePolicyStore(memento());
    await store.setDefault(READER);
    // 写しは既定と同じ診断日を持つ（推定は日付を動かさない）
    await store.set("w1", drifted(READER));

    expect(store.getEffective("w1")?.scores).toEqual(drifted(READER).scores);
  });

  test("既定が勝つときも、作品で読み取った新しい調子は引き継ぐ", async () => {
    // 調子（受容度・自信度）は9問では聞かない（6.86.2）。答え直しで
    // 捨てると、診断をやり直した直後から「受け取れる人」扱いに戻ってしまう
    // ——既定の答え直し（writerDiagnosis）も、調子は前のものを引き継いでいる
    const store = new AdvicePolicyStore(memento());
    const state = {
      acceptance: "low" as const,
      confidence: "mid" as const,
      updatedAt: "2026-09-19T00:00:00.000Z",
      lowStreak: 2,
    };
    await store.set("w1", { ...drifted(READER), state });
    await store.setDefault({ ...TASTE, updatedAt: "2026-09-20T00:00:00.000Z" });

    const effective = store.getEffective("w1");
    expect(effective?.scores).toEqual(TASTE.scores);
    expect(effective?.state).toEqual(state);
  });

  test("既定の調子のほうが新しければ、そちらを使う", async () => {
    const store = new AdvicePolicyStore(memento());
    const older = {
      acceptance: "low" as const,
      confidence: "low" as const,
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const newer = {
      acceptance: "high" as const,
      confidence: "mid" as const,
      updatedAt: "2026-09-21T00:00:00.000Z",
    };
    await store.set("w1", { ...drifted(READER), state: older });
    await store.setDefault({
      ...TASTE,
      updatedAt: "2026-09-20T00:00:00.000Z",
      state: newer,
    });

    expect(store.getEffective("w1")?.state).toEqual(newer);
  });

  test("日付が読めなければ、作品の値を残す（決められないときは手元を動かさない）", async () => {
    const store = new AdvicePolicyStore(memento());
    await store.set("w1", { ...TASTE, updatedAt: "いつか" });
    await store.setDefault({ ...READER, updatedAt: "2026-09-20T00:00:00.000Z" });

    expect(store.getEffective("w1")?.scores).toEqual(TASTE.scores);
  });
});

describe("既定の消し方と鍵", () => {

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
