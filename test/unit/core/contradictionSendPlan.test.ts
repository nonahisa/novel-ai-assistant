import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  mustConfirmBeforeSending,
  planContradictionSends,
} from "../../../src/core/contradictionSendPlan";

/**
 * **確認を通らずに送る道を塞ぐ**（2026-09-23）。
 *
 * 矛盾検知は1つの区切りについてAIを2回呼ぶ（本命と、「あとで判明する事実」
 * との突き合わせ）。確認を出すかどうかを**処理済みでない本命の件数**で
 * 決めていたので、本命が全部処理済みで2回目だけが残っている状態（前回
 * 2回目の途中で中止したときなど）では、確認も同意も出さないまま2回目を
 * 送っていた。クラウドの「まるごと読む」でも同じ——作者の決まり
 * （毎回同意を取る）を破る。
 *
 * 決め方は**実際に送る呼び出しの一覧**が空かどうか。
 */

interface FakeChunk {
  hash: string;
  text: string;
}

const chunks: FakeChunk[] = [
  { hash: "a", text: "一話の本文" },
  { hash: "b", text: "二話の本文です" },
];

describe("送る予定の一覧（`planContradictionSends`）", () => {
  test("本命が全部処理済みでも、2回目が残っていれば送る予定に積む", () => {
    const plan = planContradictionSends(chunks, {
      settledCached: () => true,
      futureCached: (chunk) => chunk.hash === "a",
      settledChars: () => 100,
      futureChars: () => 80,
    });
    expect(plan.settled).toHaveLength(0);
    expect(plan.future.map((chunk) => chunk.hash)).toEqual(["b"]);
    expect(plan.total.calls).toBe(1);
    expect(plan.total.totalChars).toBe(80);
    // 同意の文面で言う「どの本文が出るか」も、この一覧から数える
    expect(plan.chunkCount).toBe(1);
    expect(plan.distinctBodyChars).toBe("二話の本文です".length);
    // **確認を出す**（これが出なかったのが不具合）
    expect(mustConfirmBeforeSending(plan)).toBe(true);
  });

  test("どちらも処理済みなら何も送らない（確認も出さない）", () => {
    const plan = planContradictionSends(chunks, {
      settledCached: () => true,
      futureCached: () => true,
      settledChars: () => 100,
      futureChars: () => 80,
    });
    expect(plan.total.calls).toBe(0);
    expect(mustConfirmBeforeSending(plan)).toBe(false);
  });

  test("検証だけが残っていても確認を出す", () => {
    const plan = planContradictionSends(chunks, {
      settledCached: () => true,
      futureCached: () => true,
      settledChars: () => 100,
      futureChars: () => undefined,
    });
    expect(mustConfirmBeforeSending(plan, 2)).toBe(true);
  });

  test("本命も2回目も送るときは、同じ本文を2度ぶん数える（のべ）", () => {
    const plan = planContradictionSends(chunks, {
      settledCached: () => false,
      futureCached: () => false,
      settledChars: () => 100,
      futureChars: () => 80,
    });
    expect(plan.total.calls).toBe(4);
    expect(plan.total.totalChars).toBe(360);
    expect(plan.chunkCount).toBe(2);
    expect(plan.total.bodyChars).toBe(2 * plan.distinctBodyChars);
  });

  test("本命を送らない区切り（照らし合わせる相手が無い）は、2回目も送らない", () => {
    const plan = planContradictionSends(chunks, {
      settledCached: () => false,
      futureCached: () => false,
      settledChars: (chunk) => (chunk.hash === "a" ? undefined : 100),
      futureChars: () => 80,
    });
    expect(plan.settled.map((chunk) => chunk.hash)).toEqual(["b"]);
    expect(plan.future.map((chunk) => chunk.hash)).toEqual(["b"]);
  });

  test("同じ本文の区切りは1度だけ積む（2つ目は1つ目の答えを引く）", () => {
    const twins = [chunks[0], { ...chunks[0] }];
    const plan = planContradictionSends(twins, {
      settledCached: () => false,
      futureCached: () => false,
      settledChars: () => 100,
      futureChars: () => 80,
    });
    expect(plan.total.calls).toBe(2);
  });
});

describe("矛盾検知への配線（書き方で押さえる）", () => {
  const source = readFileSync(
    join(__dirname, "..", "..", "..", "src", "features", "checkContradictions.ts"),
    "utf8"
  );

  test("確認を出すかどうかを、処理済みでない本命の件数で決めない", () => {
    expect(source).not.toMatch(/if\s*\(\s*pending\.length\s*>\s*0\s*\)/);
    expect(source).toMatch(/mustConfirmBeforeSending\(/);
  });

  test("同意の文面の本文の量と回数は、送る予定の一覧から数える", () => {
    const call = source.indexOf("describeWholeReadConsent({");
    expect(call).toBeGreaterThan(0);
    const args = source.slice(call, source.indexOf("});", call));
    expect(args).not.toMatch(/pending\./);
    expect(args).toMatch(/sendPlan\./);
  });
});
