import { describe, expect, test } from "vitest";
import { formatLockSince, reviewLockBannerText } from "../../../src/core/reviewLockMessages";

/**
 * 原稿エディターの校閲中の帯の文（作者の裁定 2026-11-07。文はこのとおりに）。
 *
 * 「この話は校閲中です（編集者 kmizu・11月7日 18:30 から）。編集者が返すと書けます。」
 *
 * **時刻はこの端末の時計で書く。** 期待値も `new Date(年, 月, 日, 時, 分)`（この端末の時計）で
 * 組むので、CI（UTC）でもこの PC（日本時間）でも同じ結果になる。
 */
describe("校閲中の帯の文", () => {
  const now = new Date(2026, 10, 8, 9, 0);
  const since = new Date(2026, 10, 7, 18, 30).toISOString();

  test("名前と時刻がそろっていれば、裁定の文そのもの", () => {
    expect(reviewLockBannerText({ editorLogin: "kmizu", since }, now)).toBe(
      "この話は校閲中です（編集者 kmizu・11月7日 18:30 から）。編集者が返すと書けます。"
    );
  });

  test("名前が分からなければ「編集者」とだけ", () => {
    expect(reviewLockBannerText({ since }, now)).toBe(
      "この話は校閲中です（編集者・11月7日 18:30 から）。編集者が返すと書けます。"
    );
  });

  test("時刻が読めなければ時刻を言わない", () => {
    expect(reviewLockBannerText({ editorLogin: "kmizu", since: "" }, now)).toBe(
      "この話は校閲中です（編集者 kmizu）。編集者が返すと書けます。"
    );
  });
});

describe("帯の時刻", () => {
  test("「11月7日 18:30」の形。分は2桁、時は1桁のまま", () => {
    expect(formatLockSince(new Date(2026, 10, 7, 18, 30).toISOString(), new Date(2026, 10, 8))).toBe(
      "11月7日 18:30"
    );
    expect(formatLockSince(new Date(2026, 0, 2, 9, 5).toISOString(), new Date(2026, 5, 1))).toBe(
      "1月2日 9:05"
    );
  });

  test("今年でなければ年を足す。読めない時刻は言わない", () => {
    expect(formatLockSince(new Date(2025, 11, 31, 23, 0).toISOString(), new Date(2026, 0, 1))).toBe(
      "2025年12月31日 23:00"
    );
    expect(formatLockSince("", new Date())).toBeUndefined();
    expect(formatLockSince("いつか", new Date())).toBeUndefined();
  });
});
