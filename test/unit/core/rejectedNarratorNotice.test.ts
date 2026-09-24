import { describe, expect, test } from "vitest";
import type { RejectedCharacterCandidate } from "../../../src/core/characterExtractionValidation";
import {
  describeRejectedNarrators,
  describeRejectedNarratorsForLog,
} from "../../../src/core/rejectedNarratorNotice";

/** この一文だけは、どの経路でも必ず出す（作者が次に何をすればよいか） */
const LAST_LINE =
  "人物一覧の誰かに当たるなら、その人の資料へ手で書き足してください。";

describe("語り手らしき候補を捨てたことの知らせ", () => {
  test("捨てたものが無ければ、何も出さない", () => {
    // 毎回出る断り書きは読まれなくなる
    expect(describeRejectedNarrators([])).toBe("");
    expect(describeRejectedNarratorsForLog([])).toBe("");
  });

  test("名前が決められない以外の理由だけなら、何も出さない", () => {
    const rejected: RejectedCharacterCandidate[] = [
      { name: "谷村修一", reason: "ungrounded" },
      { name: "先生", reason: "non_person" },
      { name: null, reason: "invalid_shape" },
    ];

    expect(describeRejectedNarrators(rejected)).toBe("");
    expect(describeRejectedNarratorsForLog(rejected)).toBe("");
  });

  test("捨てた名前と中身を添えて出し、最後に手で書き足す案内を置く", () => {
    const text = describeRejectedNarrators([
      {
        name: "僕",
        reason: "pronoun_name",
        details: { appearance: "背が高い。右目の下に小さなほくろ" },
      },
    ]);

    expect(text).toContain(
      "地の文の語り手らしき人物を1件、名前が決められないため登録しませんでした。"
    );
    expect(text).toContain(
      "AIは「僕」という名前で返しています（外見：背が高い。右目の下に小さなほくろ）。"
    );
    expect(text).toContain(
      "一人称で書かれた作品では、語り手が自分の名前を名乗らないことがあります。"
    );
    expect(text).toContain(LAST_LINE);
  });

  test("説明的な名前で捨てたものも同じ知らせに出る", () => {
    const text = describeRejectedNarrators([
      { name: "語り手", reason: "descriptive_name", details: { role: "主人公" } },
    ]);

    expect(text).toContain("AIは「語り手」という名前で返しています（役割：主人公）。");
    expect(text).toContain(LAST_LINE);
  });

  test("中身が無ければ、名前だけを出す（空の括弧を付けない）", () => {
    const text = describeRejectedNarrators([{ name: "僕", reason: "pronoun_name" }]);

    expect(text).toContain("AIは「僕」という名前で返しています。");
    expect(text).not.toContain("（）");
    expect(text).toContain(LAST_LINE);
  });

  test("同じ名前が何チャンクからも返ってきても、1人として1回だけ出す", () => {
    // 一人称の作品では「僕」が話の数だけ返ってくる。畳まないと
    // 同じ行が何十行も並んで、肝心の案内が読まれなくなる
    const text = describeRejectedNarrators([
      { name: "僕", reason: "pronoun_name", details: { appearance: "背が高い" } },
      { name: "僕", reason: "pronoun_name", details: { gender: "男性" } },
      { name: "僕", reason: "pronoun_name" },
    ]);

    expect(text).toContain("地の文の語り手らしき人物を1件、");
    expect(text.match(/AIは「僕」/gu)).toHaveLength(1);
    // 項目ごとに、最初に中身のあったものを拾う（チャンクによって
    // 埋まっている欄が違うので、1件目だけを見ると取りこぼす）
    expect(text).toContain("（外見：背が高い / 性別：男性）");
  });

  test("多いときは画面に並べきらず、残りは操作ログへ回す", () => {
    const text = describeRejectedNarrators([
      { name: "僕", reason: "pronoun_name" },
      { name: "俺", reason: "pronoun_name" },
      { name: "わたし", reason: "pronoun_name" },
      { name: "主人公", reason: "descriptive_name" },
    ]);

    expect(text).toContain("地の文の語り手らしき人物を4件、");
    expect(text).toContain("ほか1件は操作ログに残してあります。");
    expect(text).not.toContain("AIは「主人公」");
    expect(text).toContain(LAST_LINE);
  });

  test("操作ログには、全件の名前と中身を切らずに残す", () => {
    const long = "あ".repeat(120);
    const forLog = describeRejectedNarratorsForLog([
      { name: "僕", reason: "pronoun_name", details: { appearance: long } },
      { name: "俺", reason: "pronoun_name" },
      { name: "わたし", reason: "pronoun_name" },
      { name: "主人公", reason: "descriptive_name" },
    ]);

    expect(forLog).toContain(long);
    expect(forLog).toContain("「主人公」");
    // 画面のほうは長い値を切る（件数の行が読めなくなるため）
    expect(
      describeRejectedNarrators([
        { name: "僕", reason: "pronoun_name", details: { appearance: long } },
      ])
    ).not.toContain(long);
  });
});
