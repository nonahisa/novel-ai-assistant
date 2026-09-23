import { describe, expect, test } from "vitest";
import {
  cutoffDate,
  logLineDate,
  pruneLogText,
} from "../../src/core/logRetention";

/**
 * ログの自動削除（設計書8.3、作者の要望 2026-08-16）。
 *
 * ログには**原稿の一部が入る**（相談の内容、AIの応答）ので、
 * 置きっぱなしにしない。既定は7日。
 *
 * **消しすぎないことが要点。** 読めない行を勝手に消すと、
 * 直近の記録まで失う。
 */
describe("行の日時を読む", () => {
  test.each([
    ["[2026-08-16 20:42:28] 抽出を開始", "2026-08-16"],
    ['{"timestamp":"2026-08-10 09:00:00","category":"typo"}', "2026-08-10"],
    ["## 2026-08-01 12:00:00 相談", "2026-08-01"],
  ])("%s → %s", (line, expected) => {
    expect(logLineDate(line)).toBe(expected);
  });

  test.each([
    "本文の続き",
    "",
    "2026-08-16 先頭に括弧が無い",
    "[不正な日時] 何か",
  ])("日時として読めない行: %s", (line) => {
    expect(logLineDate(line)).toBeUndefined();
  });
});

describe("残す日数", () => {
  test("7日前を境にする", () => {
    expect(cutoffDate("2026-08-16", 7)).toBe("2026-08-09");
  });

  test("月をまたぐ", () => {
    expect(cutoffDate("2026-09-03", 7)).toBe("2026-08-27");
  });
});

describe("古い行を落とす", () => {
  const today = "2026-08-16";

  test("境より古い行だけ消す", () => {
    const text = [
      "[2026-08-01 10:00:00] 古い",
      "[2026-08-09 10:00:00] ちょうど境",
      "[2026-08-16 10:00:00] 今日",
    ].join("\n");

    const result = pruneLogText(text, 7, today);

    expect(result.text).not.toContain("古い");
    expect(result.text).toContain("ちょうど境");
    expect(result.text).toContain("今日");
    expect(result.removed).toBe(1);
  });

  test("日時の無い行は、直前の行に付いていく", () => {
    // 相談のログは見出しの下に本文が続く。見出しだけ消すと中身が浮く
    const text = [
      "## 2026-08-01 10:00:00 相談",
      "作者: この人物の一人称は？",
      "AI: 「僕」です。",
      "## 2026-08-16 10:00:00 相談",
      "作者: 今日の質問",
    ].join("\n");

    const result = pruneLogText(text, 7, today);

    expect(result.text).not.toContain("この人物の一人称は？");
    expect(result.text).not.toContain("「僕」です。");
    expect(result.text).toContain("今日の質問");
  });

  test("日時のある行が1つも無いファイルには触れない", () => {
    // 形が違う＝この仕組みが想定していないファイル
    const text = "何かのメモ\n続き\n";

    expect(pruneLogText(text, 7, today).changed).toBe(false);
  });

  test("先頭に日時の無い行があっても、そこまでは残す", () => {
    // ファイルの冒頭に置いた注意書きを消さない
    const text = [
      "このファイルには原稿の一部が入ります。",
      "",
      "[2026-08-01 10:00:00] 古い",
      "[2026-08-16 10:00:00] 今日",
    ].join("\n");

    const result = pruneLogText(text, 7, today);

    expect(result.text).toContain("このファイルには原稿の一部が入ります。");
    expect(result.text).not.toContain("古い");
  });

  test("0日なら何もしない", () => {
    // 「消さない」設定
    const text = "[2020-01-01 00:00:00] とても古い";

    const result = pruneLogText(text, 0, today);

    expect(result.changed).toBe(false);
    expect(result.text).toBe(text);
  });

  test("消すものが無ければ書き戻さない", () => {
    // 中身が同じなのに書き込むと、更新時刻だけが変わる
    const text = "[2026-08-16 10:00:00] 今日";

    expect(pruneLogText(text, 7, today).changed).toBe(false);
  });

  test("空でも落ちない", () => {
    expect(pruneLogText("", 7, today).changed).toBe(false);
  });

  test("全部古ければ空になる", () => {
    const text = "[2020-01-01 00:00:00] 古い\n[2020-01-02 00:00:00] 古い";

    expect(pruneLogText(text, 7, today).text.trim()).toBe("");
  });
});
