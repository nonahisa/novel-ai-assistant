import { describe, expect, test } from "vitest";
import {
  CONTEST_SUGGEST_LIMITS,
  validateContestSuggestions,
} from "../../../src/core/contestSuggestValidation";

/**
 * AIが並べた応募先を、コードで確かめる（設計書6.3.6.5、P-41）。
 *
 * - **提案された公募が候補に実在すること**（番号で照合。番号が無ければ名前で）
 * - **理由の中身が指示の言葉の返りでないこと**（CLAUDE.md の繰り返し起きた失敗3）
 * - 重複・上限・字数はコードが揃える
 */

const CANDIDATES = [
  { id: "C1", name: "第3回 あおぞらBL大賞" },
  { id: "C2", name: "第2回 ほしぞらメディア大賞" },
  { id: "C3", name: "第5回 うみかぜ文学賞" },
];

function answer(value: unknown): string {
  return JSON.stringify(value);
}

describe("提案を確かめる", () => {
  test("候補に実在するものだけを、AIの並べた順で残す", () => {
    const result = validateContestSuggestions(
      answer({
        suggestions: [
          { id: "C3", reason: "海を舞台にした作品で、募集の題材と重なるため。" },
          { id: "C9", reason: "存在しない候補。" },
          { id: "C1", reason: "BLの長編を募集しており、作品の種類と合うため。" },
        ],
      }),
      CANDIDATES
    );
    expect(result?.suggestions.map((entry) => entry.name)).toEqual([
      "第5回 うみかぜ文学賞",
      "第3回 あおぞらBL大賞",
    ]);
    expect(result?.notes.join("")).toContain("候補に無い公募 1件");
  });

  test("番号の書き方の揺れ（全角・小文字・空白）は同じと見る。番号が無ければ名前で照合", () => {
    const result = validateContestSuggestions(
      answer({
        suggestions: [
          { id: " ｃ２ ", reason: "ジャンル不問で、完結前でも応募できるため。" },
          { name: "第5回　うみかぜ文学賞", reason: "海の話を募っているため。" },
        ],
      }),
      CANDIDATES
    );
    expect(result?.suggestions.map((entry) => entry.id)).toEqual(["C2", "C3"]);
  });

  test("同じ公募を2度挙げたら、最初の1つだけ", () => {
    const result = validateContestSuggestions(
      answer({
        suggestions: [
          { id: "C1", reason: "一つ目の理由です。" },
          { id: "C1", reason: "二つ目の理由です。" },
        ],
      }),
      CANDIDATES
    );
    expect(result?.suggestions).toHaveLength(1);
    expect(result?.suggestions[0].reason).toBe("一つ目の理由です。");
  });

  test("理由が指示の言葉の返り（「理由」「（80字以内）」「なし」「reason」）なら、その提案を外す", () => {
    const result = validateContestSuggestions(
      answer({
        suggestions: [
          { id: "C1", reason: "理由" },
          { id: "C2", reason: "（80字以内）" },
          { id: "C3", reason: "なし" },
        ],
      }),
      CANDIDATES
    );
    expect(result).toBeUndefined();
    const mixed = validateContestSuggestions(
      answer({
        suggestions: [
          { id: "C1", reason: "reason" },
          { id: "C2", reason: "応募先に合う理由" },
          { id: "C3", reason: "海の話を募っているため。" },
        ],
      }),
      CANDIDATES
    );
    expect(mixed?.suggestions.map((entry) => entry.id)).toEqual(["C3"]);
    expect(mixed?.notes.join("")).toContain("指示の言葉がそのまま返ってきた 2件");
  });

  test("理由が長すぎれば切り詰めて「…」を付ける", () => {
    const long = "あ".repeat(CONTEST_SUGGEST_LIMITS.reason + 30);
    const result = validateContestSuggestions(
      answer({ suggestions: [{ id: "C1", reason: long }] }),
      CANDIDATES
    );
    const reason = result?.suggestions[0].reason ?? "";
    expect([...reason]).toHaveLength(CONTEST_SUGGEST_LIMITS.reason);
    expect(reason.endsWith("…")).toBe(true);
    expect(result?.notes.join("")).toContain("切り詰めました");
  });

  test("上限（5件）を超えた分は外す", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ id: `C${index + 1}`, name: `賞${index + 1}` }));
    const result = validateContestSuggestions(
      answer({
        suggestions: many.map((entry) => ({ id: entry.id, reason: `${entry.name}の募集に合うため。` })),
      }),
      many
    );
    expect(result?.suggestions).toHaveLength(CONTEST_SUGGEST_LIMITS.suggestions);
    expect(CONTEST_SUGGEST_LIMITS.suggestions).toBe(5);
  });

  test("JSON でない・欄が無い・挙げたものが1件も残らないときは undefined（使わない）", () => {
    expect(validateContestSuggestions("これはJSONではありません", CANDIDATES)).toBeUndefined();
    expect(validateContestSuggestions(answer({ items: [] }), CANDIDATES)).toBeUndefined();
    expect(
      validateContestSuggestions(answer({ suggestions: [{ id: "C9", reason: "無い候補" }] }), CANDIDATES)
    ).toBeUndefined();
  });

  /**
   * **空の配列は「合う公募なし」という正しい答え**（残課題 F8）。プロンプトが
   * そう頼んでいる。「読めなかった」（undefined）と同じにすると、頼んだとおりに
   * 答えたAIを失敗として扱う。
   */
  test("空の配列は、読めた0件として返す（読めなかったとは分ける）", () => {
    expect(validateContestSuggestions(answer({ suggestions: [] }), CANDIDATES)).toEqual({
      suggestions: [],
      notes: [],
    });
  });

  test("コードの柵（```json）で包まれて返っても読む", () => {
    const fenced = "```json\n" + answer({ suggestions: [{ id: "C1", reason: "BLを募っているため。" }] }) + "\n```";
    expect(validateContestSuggestions(fenced, CANDIDATES)?.suggestions).toHaveLength(1);
  });
});
