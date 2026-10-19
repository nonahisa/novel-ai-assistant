import { describe, expect, it } from "vitest";
import {
  keepWithdrawnSpeechAsLow,
  parseVerifyOutcome,
} from "../../../src/core/contradictionVerifyValidation";

/**
 * 確かめの段（P-12b）が、あとの話から来た台詞の食い違いを「発言者の誤り」で
 * 取り下げたとき、消さずに確信度 low で残す（2026-10-19、作者の裁定の案2A）。
 * 測定: docs/measurements/2026-10-19-ai-three-field-items.md 項目2。
 */

const speechIssue = {
  excerpt: "俺は生まれてからずっと本屋だ。警察や役所とは一生縁がないね",
  textSays: "瀬戸は生まれてからずっと本屋だと言っている",
  // 26b 2回目の実際の note
  note: "瀬戸が嘘をついているか、あるいは単なる思い違いをしている可能性がある",
};

function withdrawn(reason: string): ReturnType<typeof parseVerifyOutcome> {
  return parseVerifyOutcome(
    JSON.stringify({
      verdict: "却下",
      reason,
      explanation: "発言者が偽っているだけで設定との矛盾ではない",
      confidence: "high",
    })
  );
}

describe("台詞の食い違いの取り下げを、low で残す", () => {
  it("あとの話から来た台詞を「発言者の誤り」で取り下げたら、low で残す", () => {
    const kept = keepWithdrawnSpeechAsLow(speechIssue, withdrawn("発言者の誤り"), "future");
    expect(kept).toBeDefined();
    expect(kept?.confidence).toBe("low");
    expect(kept?.note).toContain(speechIssue.note);
    expect(kept?.note).toContain("発言者の誤り");
  });

  it("「まだ明かされていない」で取り下げたものは対象にしない", () => {
    expect(
      keepWithdrawnSpeechAsLow(speechIssue, withdrawn("まだ明かされていない"), "future")
    ).toBeUndefined();
  });

  it("本命の突き合わせ（settled）の取り下げは今までどおり消す", () => {
    expect(
      keepWithdrawnSpeechAsLow(speechIssue, withdrawn("発言者の誤り"), "settled")
    ).toBeUndefined();
  });

  it("地の文の取り下げは消す", () => {
    expect(
      keepWithdrawnSpeechAsLow(
        {
          excerpt: "ミナは今日も学校で授業を受け",
          textSays: "学校に通っている",
          note: "設定は退学だが本文は通学している",
        },
        withdrawn("発言者の誤り"),
        "future"
      )
    ).toBeUndefined();
  });

  it.each(["作中の変化", "設定が古い", "引用が本文と違う", "そもそも食い違っていない"])(
    "ほかの取り下げ理由（%s）は消す",
    (reason) => {
      expect(keepWithdrawnSpeechAsLow(speechIssue, withdrawn(reason), "future")).toBeUndefined();
    }
  );

  it("採用されたものには何もしない", () => {
    const adopted = parseVerifyOutcome(
      JSON.stringify({ verdict: "採用", reason: "", explanation: "", confidence: "high" })
    );
    expect(keepWithdrawnSpeechAsLow(speechIssue, adopted, "future")).toBeUndefined();
  });
});
