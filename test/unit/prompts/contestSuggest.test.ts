import { describe, expect, test } from "vitest";
import {
  buildContestSuggestPrompt,
  CONTEST_SUGGEST_SCHEMA,
  CONTEST_SUGGEST_SYSTEM_PROMPT,
  CONTEST_SUGGEST_TEMPERATURE,
  CONTEST_SUGGEST_VERSION,
} from "../../../src/prompts/contestSuggest";
import { CONTEST_SUGGEST_LIMITS, validateContestSuggestions } from "../../../src/core/contestSuggestValidation";
import { hasWorkProfile, workProfileText, type WorkProfile } from "../../../src/core/contestMatchText";

/**
 * P-41 応募先の提案（設計書6.3.6.5）。見本はすべて作り物。
 */

const PROFILE: WorkProfile = {
  title: "潮騒の図書館",
  kind: "小説",
  format: "長編",
  genre: "ヒューマンドラマ",
  logline: "海辺の図書館で働く司書が、失われた本を探す。",
  outline: "",
  blurb: "",
};

const CANDIDATES = [
  {
    id: "C1",
    name: "第5回 うみかぜ文学賞",
    deadline: "2026-11-30",
    chars: "20,000〜40,000字（原稿用紙換算）",
    text: "第5回 うみかぜ文学賞\n募集作品：海の出てくる物語",
  },
  {
    id: "C2",
    name: "第2回 ほしぞらメディア大賞",
    deadline: "2027-01-08",
    chars: "字数の制限なし",
    text: "第2回 ほしぞらメディア大賞\n募集作品：ジャンル不問",
  },
];

describe("P-41 のプロンプト", () => {
  const prompt = buildContestSuggestPrompt({ profile: PROFILE, candidates: CANDIDATES });

  test("候補は番号で渡し、番号で答えさせる（名前の書き写し違いで照合を外さない）", () => {
    expect(prompt).toContain("C1");
    expect(prompt).toContain("C2");
    expect(prompt).toContain("第5回 うみかぜ文学賞");
    expect(CONTEST_SUGGEST_SYSTEM_PROMPT).toContain("候補の中からだけ");
  });

  test("作品の概要は、書かれた項目だけを渡す", () => {
    expect(prompt).toContain("ジャンル：ヒューマンドラマ");
    expect(prompt).toContain("ログライン：海辺の図書館");
    expect(prompt).not.toContain("あらすじ：");
    expect(prompt).not.toContain("紹介文：");
  });

  test("上限の数をプロンプトとコードで揃える", () => {
    expect(prompt).toContain(`${CONTEST_SUGGEST_LIMITS.suggestions}件`);
  });

  test("版・温度・形の定め", () => {
    expect(CONTEST_SUGGEST_VERSION).toBe("1.0");
    expect(CONTEST_SUGGEST_TEMPERATURE).toBeGreaterThanOrEqual(0);
    expect(CONTEST_SUGGEST_TEMPERATURE).toBeLessThanOrEqual(0.5);
    expect(CONTEST_SUGGEST_SCHEMA.properties.suggestions.items.required).toEqual(["id", "reason"]);
  });

  /**
   * CLAUDE.md の繰り返し起きた失敗3。**プロンプトに書いた言葉が、そのまま答えに
   * 返ってくる前提で検査を書く。** プロンプトの中の鉤括弧の言葉を答えにしても、
   * 検算が外すことを確かめる。
   */
  test("プロンプトに書いた言葉がそのまま理由として返っても、使わない", () => {
    const quoted = [...(CONTEST_SUGGEST_SYSTEM_PROMPT + prompt).matchAll(/「([^」]{1,20})」/gu)].map(
      (match) => match[1]
    );
    const echoes = ["理由", "reason", "なし", `（${CONTEST_SUGGEST_LIMITS.reason}字以内）`, ...quoted];
    for (const echo of echoes) {
      const result = validateContestSuggestions(
        JSON.stringify({ suggestions: [{ id: "C1", reason: echo }] }),
        CANDIDATES
      );
      // 鉤括弧の言葉のうち、文として意味をなすもの（例示の理由）は外れなくてもよいが、
      // プロンプトには例示の理由を書いていないので、ここに挙がるのは指示の言葉だけ
      expect(result, `「${echo}」がそのまま通った`).toBeUndefined();
    }
  });
});

describe("作品の概要", () => {
  test("種類・形式だけでは材料にならない", () => {
    expect(hasWorkProfile({ ...PROFILE, genre: "", logline: "" })).toBe(false);
    expect(hasWorkProfile(PROFILE)).toBe(true);
  });

  test("長いあらすじは切って渡す", () => {
    const text = workProfileText({ ...PROFILE, outline: "あ".repeat(5000) });
    expect(text.length).toBeLessThan(2500);
  });
});
