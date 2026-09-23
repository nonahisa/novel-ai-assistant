import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createBurstGate } from "../../../src/core/burstGate";

/**
 * 原稿エディタと普通のエディタで同じ原稿を開き、普通のエディタで打つと、
 * 1文字ごとに「外で変わったので画面へ送り直します」が操作ログへ入った
 * （0.81.4、既知の残り）。**ひと続きの最初の1回だけ**書く。
 */
describe("ひと続きの最初の1回だけ通す", () => {
  test("打ち続けている間は1回だけ。手を止めてまた打てば、また1回", () => {
    const gate = createBurstGate(5000);
    const passed: Array<number | undefined> = [];
    // 0秒から0.2秒おきに10打鍵
    for (let i = 0; i < 10; i++) passed.push(gate.hit(i * 200)?.skippedBefore);
    expect(passed.filter((value) => value !== undefined)).toEqual([0]);

    // 10秒手を止めてから打つと、また書く。前のひと続きで書かなかった9回を添える
    expect(gate.hit(12_000)).toEqual({ skippedBefore: 9 });
    expect(gate.hit(12_100)).toBeUndefined();
  });

  test("打ち続けるだけで、同じ行が定期的に積み上がらない（時間で区切らない）", () => {
    const gate = createBurstGate(5000);
    let written = 0;
    // 1分間、1秒おきに打ち続ける
    for (let second = 0; second < 60; second++) {
      if (gate.hit(second * 1000)) written++;
    }
    expect(written).toBe(1);
  });
});

describe("原稿エディタが、外からの変更の記録をこの関所に通す", () => {
  test("「外で変わったので画面へ送り直します」は burstGate を通してから書く", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../src/features/manuscriptEditor.ts"),
      "utf8"
    );
    const at = source.indexOf("が外で変わったので画面へ送り直します");
    expect(at).toBeGreaterThan(0);
    // 記録の直前（同じ if の中）で関所を叩いている
    const before = source.slice(Math.max(0, at - 800), at);
    expect(before).toContain("externalChangeGate.hit(");
  });
});
