import { describe, expect, test } from "vitest";
import { validateContradictions } from "../../../src/core/contradictionValidation";
import type { Chunk } from "../../../src/core/chunker";

/**
 * あとの話から来た台詞の指摘を、検算（self_denied）で落とさない
 * （作者の裁定 2026-10-26「直してから閉じる」。設計書6.10.5）。
 *
 * 検出の段は、あとの話で判明する事実と台詞が食い違うとき「low にして、発言者が
 * 知らない／偽っている可能性と書け」と頼む。さくら Kimi-K2.6 はその断りを書いた
 * うえで「**地の文との**矛盾ではない」と書き、検算の打ち消しの網に掛かって消えた
 * （`docs/measurements/2026-10-26-future-facts-sakura-kimi.md` 114行、S1 base 試行2）。
 *
 * **両側から押さえる。** 通る1本だけでは、何も落とさない実装が満点になる。
 */
const chunk: Chunk = {
  filePath: "C:/works/005.txt",
  index: 0,
  text: "瀬戸は手帳を閉じた。\n「刑事なんて、一度もやったことはないよ」\n瀬戸はそう言って、窓の外を見た。",
  startLine: 0,
  chapterStart: 5,
  chapterEnd: 5,
  hash: "future-speech",
  segments: [],
} as unknown as Chunk;

/** 記録の 114 行の note（S1 base 試行2）をそのまま写したもの */
const RECORDED_NOTE =
  "瀬戸の発言であり、後の話で元刑事であることが判明する。発言者が偽っている可能性があるため、地の文との矛盾ではない。";

function speech(overrides: Record<string, unknown> = {}) {
  return {
    line: 2,
    excerpt: "「刑事なんて、一度もやったことはないよ」",
    category: "人物",
    settingSays: "瀬戸の紹介（第7話で判明）: 二十年、刑事をしていた",
    textSays: "刑事をやったことはないと言っている",
    note: RECORDED_NOTE,
    severity: "medium",
    confidence: "medium",
    ...overrides,
  };
}

function narration(overrides: Record<string, unknown> = {}) {
  return speech({
    line: 3,
    excerpt: "瀬戸はそう言って、窓の外を見た。",
    textSays: "窓の外を見た",
    ...overrides,
  });
}

function run(item: Record<string, unknown>, source?: "settled" | "future") {
  return validateContradictions(
    { contradictions: [item] },
    chunk,
    source ? { source } : undefined
  );
}

describe("あとの話から来た台詞の、「地の文との矛盾ではない」", () => {
  test("記録の note の形は、future なら落とさず low で残す", () => {
    const result = run(speech(), "future");

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    // モデルの申告（medium）は使わない。台詞の食い違いは low の決まり
    expect(result.accepted[0].confidence).toBe("low");
    // 断りは note のまま作者へ届く
    expect(result.accepted[0].note).toBe(RECORDED_NOTE);
  });

  test("引用から括弧が落ちていても、本文で括弧の中なら台詞と読む", () => {
    const result = run(speech({ excerpt: "刑事なんて、一度もやったことはないよ" }), "future");

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].confidence).toBe("low");
  });

  test("本命（settled）の突き合わせでは、今までどおり落とす", () => {
    const result = run(speech(), "settled");

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("self_denied");
  });

  test("出どころを渡さない呼び方（MCP など）も、今までどおり落とす", () => {
    const result = run(speech());

    expect(result.rejected[0].reason).toBe("self_denied");
  });

  test("地の文の指摘は、断りがあっても今までどおり落とす", () => {
    const result = run(narration(), "future");

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("self_denied");
  });

  test("発言者の断りが無ければ落とす", () => {
    const result = run(
      speech({ note: "後の話で元刑事であることが判明する。地の文との矛盾ではない。" }),
      "future"
    );

    expect(result.rejected[0].reason).toBe("self_denied");
  });

  test("断りがあっても、ふつうの打ち消し（「矛盾とは言えない」）なら落とす", () => {
    const result = run(
      speech({ note: "発言者が偽っている可能性があるが、矛盾とは言えない。" }),
      "future"
    );

    expect(result.rejected[0].reason).toBe("self_denied");
  });

  test("断りがあっても、ほかに打ち消しが残っていれば落とす", () => {
    const result = run(
      speech({
        note: "発言者が偽っている可能性があるため、地の文との矛盾ではない。時系列として整合している。",
      }),
      "future"
    );

    expect(result.rejected[0].reason).toBe("self_denied");
  });

  test("打ち消しの無い台詞の指摘は、申告の確信度のまま通す（今までどおり）", () => {
    const result = run(
      speech({ note: "発言者が偽っている可能性。", confidence: "high" }),
      "future"
    );

    expect(result.accepted[0].confidence).toBe("high");
  });
});
