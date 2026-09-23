import { describe, expect, test } from "vitest";
import { describeRejectReasons } from "../../src/core/foreshadowValidation";

/**
 * 却下の内訳をログに出す（設計書6.35.7）。
 *
 * 実データで伏線の回収の確認が「候補0件 / 本文と合わない10件」——検出率0%——
 * になったが、**10件がどの理由で落ちたのかが残っていなかった**ので、
 * プロンプトの問題か照合が厳しすぎるのかを切り分けられなかった
 * （作者のログ、2026-08-29）。
 */
describe("却下の内訳", () => {
  test("多い順に、作者が読める言葉で並べる", () => {
    const text = describeRejectReasons([
      { reason: "quote_not_found" },
      { reason: "unknown_id" },
      { reason: "quote_not_found" },
      { reason: "planted_echo" },
      { reason: "quote_not_found" },
    ]);
    // 同数のものは内部の名前順（planted_echo < unknown_id）。
    // 何順かより、**実行のたびに揺れない**ことが要る
    expect(text).toBe("引用が本文に無い 3件、張った箇所そのもの 1件、実在しない伏線番号 1件");
  });

  test("同数なら並びが揺れない（実行のたびに順が変わらない）", () => {
    const once = describeRejectReasons([{ reason: "shape" }, { reason: "duplicate" }]);
    const twice = describeRejectReasons([{ reason: "duplicate" }, { reason: "shape" }]);
    expect(once).toBe(twice);
  });

  test("却下が無ければ空（成功した回のログを汚さない）", () => {
    expect(describeRejectReasons([])).toBe("");
  });

  test("知らない理由でも、数だけは伝える", () => {
    // 理由が増えたときに、ログから消えてしまわないこと
    expect(describeRejectReasons([{ reason: "future_reason" }])).toBe("future_reason 1件");
  });

  test("作者が実際に踏んだ形（10件すべて却下）で、原因が読み取れる", () => {
    // 「本文と合わない 10件」だけでは何も分からなかった回
    const text = describeRejectReasons(
      Array.from({ length: 10 }, () => ({ reason: "unknown_id" }))
    );
    expect(text).toBe("実在しない伏線番号 10件");
  });
});
