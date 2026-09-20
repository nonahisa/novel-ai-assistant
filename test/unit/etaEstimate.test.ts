import { describe, expect, test } from "vitest";
import {
  MIN_ETA_SAMPLES,
  describeDuration,
  estimateRemainingMs,
  estimateRunMs,
  describeRunTimeEstimate,
} from "../../src/core/etaEstimate";

/**
 * 残り時間の見当（設計書6.8.19。作者の指摘、2026-09-20）。
 *
 * 219話の矛盾検知は6時間規模になるのに、押す前も走っている最中も
 * 「それが10分なのか6時間なのか」はどこにも出ていなかった。
 *
 * **作者が決めたいのは「夜に回すか、いま回すか」である。** だから粒度は
 * 粗くてよく、代わりに**当てずっぽうを書かない**——測っていなければ
 * 数字を作らない。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("作者が読んで判断できる粒度で言う", () => {
  test("1分に満たなければ「1分未満」（秒は出さない）", () => {
    expect(describeDuration(3_000)).toBe("1分未満");
    expect(describeDuration(59_000)).toBe("1分未満");
  });

  test("10分より短いうちは1分刻み", () => {
    expect(describeDuration(4 * MINUTE)).toBe("およそ4分");
    expect(describeDuration(4.4 * MINUTE)).toBe("およそ4分");
  });

  test("10分を超えたら5分刻み", () => {
    expect(describeDuration(14 * MINUTE)).toBe("およそ15分");
    expect(describeDuration(32 * MINUTE)).toBe("およそ30分");
  });

  test("1時間からは30分刻み", () => {
    // 「4時間28分53秒」は正確だが、判断の材料にはならない
    expect(describeDuration(4 * HOUR + 29 * MINUTE)).toBe("およそ4時間30分");
    expect(describeDuration(6 * HOUR)).toBe("およそ6時間");
  });

  test("丸めて60分になったら、時間へ繰り上げる", () => {
    // 「およそ60分」とは言わない
    expect(describeDuration(59 * MINUTE)).toBe("およそ1時間");
  });

  test("ちょうどの時間には、0分を付けない", () => {
    expect(describeDuration(5 * HOUR)).toBe("およそ5時間");
  });

  test("壊れた値でも文字列は返す（画面が空にならない）", () => {
    expect(describeDuration(Number.NaN)).toBe("1分未満");
  });
});

describe("走っている最中の見当（済んだぶんの平均 × 残り）", () => {
  test("平均に残りの件数を掛ける", () => {
    // 3件に3分かかったなら、1件1分。残り207件で約207分
    const ms = estimateRemainingMs(3, 210, 3 * MINUTE);

    expect(ms).toBe(207 * MINUTE);
    expect(describeDuration(ms!)).toBe("およそ3時間30分");
  });

  test("**数件進むまでは言わない**（立ち上がりの遅れが1件目に乗る）", () => {
    expect(estimateRemainingMs(MIN_ETA_SAMPLES - 1, 210, MINUTE)).toBeUndefined();
    expect(estimateRemainingMs(MIN_ETA_SAMPLES, 210, MINUTE)).toBeDefined();
  });

  test("全部終わっていれば、残りは言わない", () => {
    expect(estimateRemainingMs(10, 10, 10 * MINUTE)).toBeUndefined();
  });

  test("時間が測れていなければ言わない", () => {
    expect(estimateRemainingMs(5, 10, 0)).toBeUndefined();
  });
});

describe("押す前の見積もり（速さ × 1回に書く量）", () => {
  test("実測が2つそろっていれば見積もる", () => {
    // 10トークン/秒で1回1,000トークンなら、1件100秒。180件で5時間
    const ms = estimateRunMs(180, 10, 1_000);

    expect(describeDuration(ms!)).toBe("およそ5時間");
  });

  test("**速さを測っていなければ、数字を作らない**", () => {
    // ここで既定値を置くと、当てずっぽうが実測の顔をして並ぶ
    expect(estimateRunMs(180, undefined, 1_000)).toBeUndefined();
  });

  test("1回に書く量を測っていなければ、数字を作らない", () => {
    expect(estimateRunMs(180, 10, undefined)).toBeUndefined();
  });

  test("送るものが無ければ、数字を作らない", () => {
    expect(estimateRunMs(0, 10, 1_000)).toBeUndefined();
  });

  test("壊れた値でも数字を作らない", () => {
    expect(estimateRunMs(180, 0, 1_000)).toBeUndefined();
    expect(estimateRunMs(180, 10, -5)).toBeUndefined();
  });
});

/**
 * **見積もりの出どころを名乗る**（実装ルール6の例外条件3。2026-09-21）。
 *
 * 実機で見つけた。プロット逸脱を10話に掛けると、押す前に
 * 「10件 ≒ およそ15分（**これまでの実測から**）」と出たが、**実際は39秒**
 * だった（23倍の過大）。
 *
 * **数字が嘘だったのではない。** 1回あたりの出力量は同梱の表から来ており、
 * あれは「切り詰められていない回の実測の**最大**」である。容量の見積もりには
 * 最大が正しい（足りないと落ちる）が、**所要時間に最大を使えば必ず過大になる。**
 *
 * **ここで直すのは名乗りだけ**——同梱の値を使ったときに、この機械の実測と
 * 同じ顔をさせない。数字そのもの（最大ではなく普段の量で見積もる）は別の話。
 */
describe("見積もりの出どころを名乗る", () => {
  test("この機械の実測から出したときは、そう名乗る", () => {
    const text = describeRunTimeEstimate({
      count: 10,
      unit: "話",
      ms: 39_000,
      bundled: false,
    });

    expect(text).toContain("これまでの実測から");
    expect(text).not.toContain("同梱");
  });

  test("**同梱の値を使ったときは、同梱だと分かるようにする**", () => {
    const text = describeRunTimeEstimate({
      count: 10,
      unit: "話",
      ms: 900_000,
      bundled: true,
    });

    expect(text).toContain("同梱");
    // **「これまでの実測から」を名乗らせない。** ここが実機で外した点
    expect(text).not.toContain("これまでの実測から");
  });

  test("同梱のときは、多めに見ていることも言う", () => {
    // 同梱の値は**最大**なので、時間は必ず多めに出る。
    // 数字を直すまでの間、読む側が割り引けるようにする
    const text = describeRunTimeEstimate({
      count: 10,
      unit: "話",
      ms: 900_000,
      bundled: true,
    });

    expect(text).toContain("多め");
  });

  test("見当が付かないときは、出どころに関わらず正直に言う", () => {
    for (const bundled of [true, false]) {
      const text = describeRunTimeEstimate({
        count: 10,
        unit: "話",
        ms: undefined,
        bundled,
      });

      expect(text, String(bundled)).toContain("見当が付きません");
      // 走り出したあとに出す、という約束もそのまま残す
      expect(text, String(bundled)).toContain(`${MIN_ETA_SAMPLES}話`);
    }
  });
});
