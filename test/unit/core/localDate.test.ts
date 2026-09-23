import { afterEach, describe, expect, test } from "vitest";
import { localDateKey } from "../../src/core/localDate";

/**
 * 「今後直さない」に足した語の日付が1日ずれた（実機、2026-09-11）。
 * `toISOString().slice(0, 10)` は UTC の日付なので、日本では
 * **朝9時より前に押すと前日**になる。
 *
 * **時差そのものを跨いで確かめる。** 試験機の時計に合わせて期待値を
 * 組み立てると、UTC の機械では「UTC で切っても同じ」になり、
 * 直したはずのものが試験を素通りする。`process.env.TZ` を置き換えると
 * Node はその場から新しい時差で日付を組み立てるので、日本と UTC の
 * 両方を1回の試験で通せる。
 */
const original = process.env.TZ;
afterEach(() => {
  process.env.TZ = original;
});

describe("localDateKey", () => {
  test("日本時間の朝9時前でも、その日の日付を返す", () => {
    process.env.TZ = "Asia/Tokyo";
    // 日本時間の 2026-09-11 08:30。UTC ではまだ 09-10 の23:30である
    const at = new Date("2026-09-11T08:30:00+09:00");
    expect(at.toISOString().slice(0, 10)).toBe("2026-09-10");
    expect(localDateKey(at)).toBe("2026-09-11");
  });

  test("日付が変わった直後（日本時間 00:05）も当日", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(localDateKey(new Date("2026-09-11T00:05:00+09:00"))).toBe(
      "2026-09-11"
    );
  });

  test("時差の無い場所では UTC の日付と同じになる", () => {
    process.env.TZ = "UTC";
    expect(localDateKey(new Date("2026-09-10T23:30:00Z"))).toBe("2026-09-10");
  });

  test("西回りの時差でも、その場の暦の日付になる", () => {
    // ホノルル（UTC-10）。UTC では 09-11 だが、現地はまだ 09-10 の夜
    process.env.TZ = "Pacific/Honolulu";
    expect(localDateKey(new Date("2026-09-11T05:00:00Z"))).toBe("2026-09-10");
  });

  test("月と日は2桁に揃える", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(localDateKey(new Date("2026-01-05T10:00:00+09:00"))).toBe(
      "2026-01-05"
    );
  });

  test("引数なしなら今日", () => {
    expect(localDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
