import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  halveMergedChunk,
  locateChunkLine,
  mergeAdjacentChunks,
  splitIntoChunks,
} from "../../../src/core/chunker";
import {
  describeWholeReadConsent,
  WHOLE_READ_CONSENT_LABEL,
} from "../../../src/core/wholeReadConsent";
import { CONTRADICTION_READ_MODE_CHOICES } from "../../../src/features/checkContradictions";

/**
 * **まるごと読む矛盾検知**（作者の裁定 A3⑤、2026-09-23。設計書6.10.7）。
 *
 * 作者の問い「全量読み込みの同意がなくても実行可能な状態になるということで
 * しょうか？」への答え——**いいえ。分けて読む矛盾検知はそのまま残り、
 * まるごと読むのは並ぶ別の選択肢。** 見ること：
 * - 押したときに2つから選べる（分けて読むが先頭＝これまでどおり）
 * - クラウドでまるごと読むときは毎回同意を取り、覚えない
 * - 手元のAIでは同意を取らない（原稿が外へ出ない）
 * - 長い作品は区切って読ませ、切り詰められたら半分ずつに戻す
 */

const SOURCE = readFileSync(
  join(__dirname, "..", "..", "..", "src", "features", "checkContradictions.ts"),
  "utf8"
);

describe("読み方を選ぶ", () => {
  test("分けて読む・まるごと読むの2つ。先頭はこれまでどおりの分けて読む", () => {
    expect(CONTRADICTION_READ_MODE_CHOICES.map((choice) => choice.mode)).toEqual([
      "chunked",
      "whole",
    ]);
  });

  test("まるごとの説明に、クラウドでは毎回確かめることを書く", () => {
    const whole = CONTRADICTION_READ_MODE_CHOICES.find(
      (choice) => choice.mode === "whole"
    );
    expect(whole?.detail).toMatch(/クラウド/);
    expect(whole?.detail).toMatch(/毎回/);
  });
});

describe("クラウドへまるごと送る前の同意", () => {
  const text = describeWholeReadConsent({
    serviceName: "Gemini",
    bodyChars: 112400,
    totalChars: 131000,
    calls: 2,
    inputTokens: 95000,
    maxOutputTokens: 20000,
  });

  test("本文がまるごと、どのサービスへ出るかを言う（名前は渡されたもの）", () => {
    expect(text).toContain("本文がまるごと Gemini へ出ます");
    expect(text).toContain("112,400字");
    expect(text).toContain("2回に区切って");
  });

  test("金額は作らない（分からないと言う）", () => {
    expect(text).not.toMatch(/\d\s*円/);
    expect(text).toContain("金額はこの拡張機能には分かりません");
  });

  test("毎回出ること・覚えないことを言う", () => {
    expect(text).toContain("毎回出ます（覚えません）");
    expect(text).toContain(`「${WHOLE_READ_CONSENT_LABEL}」`);
  });

  test("サービス名が空でも、決め打ちの名前を出さない", () => {
    const blank = describeWholeReadConsent({
      serviceName: " ",
      bodyChars: 1,
      totalChars: 1,
      calls: 1,
      inputTokens: 1,
      maxOutputTokens: 1,
    });
    expect(blank).toContain("利用中のAIサービス");
  });
});

describe("矛盾検知への配線（書き方で押さえる）", () => {
  test("クラウドでまるごと読むときは、覚えない確認（remember を渡さない）", () => {
    // まるごとのときは remember を外す
    expect(SOURCE).toMatch(/remember:\s*wholeRead\s*\?\s*undefined/);
    // 同意のボタンは「送る」、警告の顔
    expect(SOURCE).toMatch(/cloudWhole\s*\?\s*WHOLE_READ_CONSENT_LABEL/);
    expect(SOURCE).toMatch(/kind:\s*cloudWhole\s*\?\s*"warning"/);
  });

  test("クラウドでまるごと読むときは、まとめ実行でも確認を飛ばさない", () => {
    expect(SOURCE).toMatch(/options\.suiteConfirmed\s*&&\s*!cloudWhole/);
  });

  test("手元かどうかは共通の一覧で決める（サービス名を決め打ちしない）", () => {
    expect(SOURCE).toMatch(/isLocalProviderId\(resolved\.provider\.id\)/);
  });

  test("区切りはまるごと読む大きさで決める", () => {
    expect(SOURCE).toMatch(/wholeRead,?\s*\n?\s*\}\);/);
    expect(SOURCE).toMatch(/collectManuscriptChunks\(\{[\s\S]*?wholeRead/);
  });

  test("切り詰められたら、まるごとのときは半分ずつに戻す", () => {
    expect(SOURCE).toMatch(
      /wholeRead\s*\?\s*halveMergedChunk\(chunk\)\s*:\s*splitMergedChunk\(chunk\)/
    );
  });
});

describe("切り詰められた区切りを、話の切れ目で半分に戻す（`halveMergedChunk`）", () => {
  function episode(filePath: string, chapter: number, length: number) {
    return splitIntoChunks(filePath, "あ".repeat(length), chapter, chapter, {
      maxChars: 100_000,
    })[0];
  }
  const episodes = [1, 2, 3, 4, 5, 6].map((chapter) =>
    episode(`${chapter}.txt`, chapter, 1000)
  );
  const [whole] = mergeAdjacentChunks(episodes, { maxChars: 100_000 });

  test("6話の区切りは、1話ずつではなく2つ前後に分かれる", () => {
    const halves = halveMergedChunk(whole);
    expect(halves.length).toBeGreaterThanOrEqual(2);
    expect(halves.length).toBeLessThan(6);
    // 本文は1字も落とさない
    const total = halves.reduce(
      (sum, part) => sum + part.text.replace(/\s/g, "").length,
      0
    );
    expect(total).toBe(6000);
  });

  test("話数と行番号は元へ戻せる（原稿の位置を取り違えない）", () => {
    const halves = halveMergedChunk(whole);
    expect(halves[0].chapterStart).toBe(1);
    expect(halves[halves.length - 1].chapterEnd).toBe(6);
    const located = locateChunkLine(halves[halves.length - 1], 1);
    expect(located?.filePath).toMatch(/\d\.txt$/);
  });

  test("2話しか無ければ1話ずつ", () => {
    const [two] = mergeAdjacentChunks(episodes.slice(0, 2), { maxChars: 100_000 });
    expect(halveMergedChunk(two)).toHaveLength(2);
  });
});
