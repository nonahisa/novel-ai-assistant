import { describe, expect, test } from "vitest";
import {
  countMark,
  parsePhotoTranscription,
} from "../../../src/core/photoTranscribeValidation";
import {
  PHOTO_TRANSCRIBE_HINTS,
  PHOTO_TRANSCRIBE_SCHEMA,
  PHOTO_TRANSCRIBE_SYSTEM_PROMPT,
  UNREADABLE_MARK,
  buildPhotoTranscribePrompt,
} from "../../../src/prompts/photoTranscribe";
import {
  REPEATED_ELEMENT_LIMIT,
  findRepetition,
  salvageRepetition,
} from "../../../src/core/repeatedElements";

/**
 * 写真の書き起こし（P-48、設計書6.117.7）の答えの検算。
 *
 * **指示の言葉はそのまま返ってくる前提で書く**（CLAUDE.md の失敗3）。
 * **見逃しと誤検出の両方を見る**：指示の言葉は捨てるが、本文の中に同じ語が
 * 出る行は捨てない。〓は数えるが、無い所に数えない。
 */

function answer(lines: readonly string[]): string {
  return JSON.stringify({ lines: lines.map((text) => ({ text })) });
}

describe("書き起こしを読む", () => {
  test("行を改行でつなぎ、〓を数える。字下げ（行頭の全角空白）は残す", () => {
    const parsed = parsePhotoTranscription(
      answer(["　吾々は云うのも居た", "米軍の〓〓が見えた"])
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.text).toBe("　吾々は云うのも居た\n米軍の〓〓が見えた");
    expect(parsed.value.unreadable).toBe(2);
    expect(parsed.value.latinRuns).toEqual([]);
    expect(parsed.value.droppedEchoes).toBe(0);
  });

  test("空の行は捨てる（繰り返しの見張りに掛からないよう、空の要素は書かせない）", () => {
    const parsed = parsePhotoTranscription(answer(["一行目", "", "　", "二行目"]));
    expect(parsed.ok && parsed.value.text).toBe("一行目\n二行目");
  });

  test("1要素に改行を入れて返されても、行に割って並べ直す", () => {
    const parsed = parsePhotoTranscription(answer(["一行目\n二行目\r\n三行目"]));
    expect(parsed.ok && parsed.value.text).toBe("一行目\n二行目\n三行目");
  });

  test.each(PHOTO_TRANSCRIBE_HINTS)("指示の言葉「%s」だけの行は捨てて数える", (hint) => {
    const parsed = parsePhotoTranscription(answer(["本文の行", hint, `「${hint}」。`]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.text).toBe("本文の行");
    expect(parsed.value.droppedEchoes).toBe(2);
  });

  test("本文の中に指示と同じ語が出る行は捨てない（誤検出しない）", () => {
    const line = "彼は読めない字を指でなぞり、書き起こしを諦めた。";
    const parsed = parsePhotoTranscription(answer([line]));
    expect(parsed.ok && parsed.value.text).toBe(line);
    expect(parsed.ok && parsed.value.droppedEchoes).toBe(0);
  });

  test("指示の言葉しか無ければ、失敗にして理由を言う", () => {
    const parsed = parsePhotoTranscription(answer(["読めない字", "一字一句"]));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("指示の言葉");
  });

  test("1行も無ければ失敗にする", () => {
    const parsed = parsePhotoTranscription(answer([]));
    expect(parsed.ok).toBe(false);
  });

  test("JSONでなければ失敗にする", () => {
    expect(parsePhotoTranscription("写真には手書きの文字が書かれています。").ok).toBe(false);
  });

  test("コードの囲みや前置きが付いていても読む", () => {
    const parsed = parsePhotoTranscription(
      "はい。\n```json\n" + answer(["一行目"]) + "\n```"
    );
    expect(parsed.ok && parsed.value.text).toBe("一行目");
  });

  test("英字の連なり（測定で wider が混じった）を行つきで数える。2字以下は数えない", () => {
    const parsed = parsePhotoTranscription(answer(["そこは wider な道", "第 B 号", "ＡＢＣ通り"]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.latinRuns).toEqual([
      { line: 1, text: "wider" },
      { line: 3, text: "ＡＢＣ" },
    ]);
  });

  test("写真の説明らしい行は捨てずに印を付ける", () => {
    const parsed = parsePhotoTranscription(
      answer(["この写真には手書きの文字があります", "本文の行", "ノートに日付が書かれています。"])
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.descriptiveLines).toEqual([1, 3]);
    expect(parsed.value.text.split("\n")).toHaveLength(3);
  });

  test("〓の数え方（作者が直したあとの文でも数え直す）", () => {
    expect(countMark("〓あ〓〓")).toBe(3);
    expect(countMark("なし")).toBe(0);
  });
});

describe("頼み方（P-48）", () => {
  test("依頼文とシステム指示に、守らせる決まりが入っている", () => {
    const prompt = buildPhotoTranscribePrompt("1枚目・左のページ");
    expect(prompt).toContain("1枚目・左のページ");
    expect(prompt).toContain(UNREADABLE_MARK);
    expect(PHOTO_TRANSCRIBE_SYSTEM_PROMPT).toContain("一字一句");
    expect(PHOTO_TRANSCRIBE_SYSTEM_PROMPT).toContain("推測で補わない");
    // 昔の字体を今の書き方へ直させない（測定で「云」を「言」へ直した）
    expect(PHOTO_TRANSCRIBE_SYSTEM_PROMPT).toContain("「云う」を「言う」に");
    expect(prompt).toContain("空いている行は書かないで");
  });

  test("行は文字列でなくオブジェクトの配列（繰り返しの見張りが見る形）", () => {
    expect(PHOTO_TRANSCRIBE_SCHEMA.properties.lines.type).toBe("array");
    expect(PHOTO_TRANSCRIBE_SCHEMA.properties.lines.items.type).toBe("object");
  });

  test("同じ行を繰り返す答えは、流して受け取る途中で止まり、1つ目までで閉じられる", () => {
    const repeated = Array.from({ length: REPEATED_ELEMENT_LIMIT + 2 }, () => ({ text: "同じ行" }));
    // 閉じていない（書き続けている途中の）答え
    const streaming = JSON.stringify({ lines: [{ text: "最初の行" }, ...repeated] }).slice(0, -3);
    const stop = findRepetition(streaming);
    expect(stop).toBeDefined();
    if (!stop) return;
    const salvaged = salvageRepetition(streaming, stop);
    expect(salvaged).toBeDefined();
    const parsed = parsePhotoTranscription(salvaged ?? "");
    expect(parsed.ok && parsed.value.text).toBe("最初の行\n同じ行");
  });
});

describe("指示の例の字と、作者からの頼みの返り（P-48 1.1）", () => {
  test("例に挙げた字（國・學・體・ゝ・ゞ）は捨てずに数える（写真と見比べてもらう）", () => {
    const parsed = parsePhotoTranscription(answer(["國の學校", "こゝろ", "人々の体"]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 「々」と今の字（体）は数えない
    expect(parsed.value.exampleChars).toBe(3);
    expect(parsed.value.text).toBe("國の學校\nこゝろ\n人々の体");
  });

  test("例の字が無ければ0（誤検出しない）", () => {
    const parsed = parsePhotoTranscription(answer(["国の学校", "人々の体"]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.exampleChars).toBe(0);
  });

  test("原則2の例が行ごと返ってきたら捨てる", () => {
    const parsed = parsePhotoTranscription(answer(["「國」を「国」に直さない。", "本文の行"]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.text).toBe("本文の行");
    expect(parsed.value.droppedEchoes).toBe(1);
  });

  test("頼みの文が行ごと返ってきたら捨てる。本文の中に同じ語がある行は捨てない", () => {
    const parsed = parsePhotoTranscription(
      answer(["【作者からの頼み】", "旧字体はそのまま。", "旧字体はそのままだと彼は云う", "本文の行"]),
      { requestEchoes: ["旧字体はそのまま。"] }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.text).toBe("旧字体はそのままだと彼は云う\n本文の行");
    expect(parsed.value.droppedEchoes).toBe(2);
  });

  test("頼みを渡さなければ、頼みと同じ行も捨てない（頼みの無い回に本文を失わない）", () => {
    const parsed = parsePhotoTranscription(answer(["旧字体はそのまま。"]));
    expect(parsed.ok).toBe(true);
  });
});
