import { describe, expect, it } from "vitest";
import {
  adaptImportedNotation,
  appendSubtitle,
  decodeImportedText,
  describeImportChoices,
  erasedCharCount,
  isEpisodeBodyEmpty,
  planEpisodeImport,
  replaceEpisodeBody,
  replaceEpisodeTitle,
  titleCandidate,
} from "../../../src/core/episodeImport";

/**
 * 原稿エディターの［入力］の取り込み（作者の決定 2026-11-08。設計書6.25.13）の判断の部分。
 * 窓・読み書きは `test/unit/features/manuscriptImport.test.ts`。
 */

/** カクヨムのダウンロードの形（冒頭の欄だけで本文が空） */
const KAKUYOMU_EMPTY = [
  "【タイトル】",
  "第三話　雪の朝",
  "",
  "【公開状態】",
  "未公開",
  "",
  "【文字数】",
  "0文字",
  "",
  "【本文（0行）】",
  "",
].join("\n");

const KAKUYOMU_WITH_AFTERWORD = [
  "【タイトル】",
  "第三話　雪の朝",
  "",
  "【本文（2行）】",
  "　古い本文です。",
  "",
  "【後書き】",
  "読んでくださってありがとうございます。",
  "",
].join("\n");

describe("本文が空か", () => {
  it("空白と改行だけなら空", () => {
    expect(isEpisodeBodyEmpty("")).toBe(true);
    expect(isEpisodeBodyEmpty("\n　\n  \n")).toBe(true);
    expect(isEpisodeBodyEmpty("　書きかけ")).toBe(false);
  });

  it("冒頭の欄だけのカクヨム形式の話も空とみなす", () => {
    expect(isEpisodeBodyEmpty(KAKUYOMU_EMPTY)).toBe(true);
  });

  it("後書きだけがあっても、本文の欄が空なら空", () => {
    const text = KAKUYOMU_WITH_AFTERWORD.replace("　古い本文です。", "");
    expect(isEpisodeBodyEmpty(text)).toBe(true);
    expect(isEpisodeBodyEmpty(KAKUYOMU_WITH_AFTERWORD)).toBe(false);
  });
});

describe("本文の所だけを差し替える", () => {
  it("空の話へ入れても、冒頭の欄は1文字も変わらない", () => {
    const result = replaceEpisodeBody(KAKUYOMU_EMPTY, "\n\n　新しい本文。\n二行目。\n\n");
    const head = KAKUYOMU_EMPTY.slice(0, KAKUYOMU_EMPTY.indexOf("【本文（0行）】") + "【本文（0行）】".length);
    expect(result.startsWith(head)).toBe(true);
    expect(result.endsWith("【本文（0行）】\n　新しい本文。\n二行目。\n")).toBe(true);
  });

  it("【本文】の見出しで字が終わっていても、同じ行へ続けない", () => {
    const text = "【タイトル】\n題\n\n【本文】";
    expect(replaceEpisodeBody(text, "本文。")).toBe("【タイトル】\n題\n\n【本文】\n本文。");
  });

  it("後書きは残し、欄どうしの空行もそのまま", () => {
    const result = replaceEpisodeBody(KAKUYOMU_WITH_AFTERWORD, "　取り込んだ文。");
    expect(result).toBe(
      [
        "【タイトル】",
        "第三話　雪の朝",
        "",
        "【本文（2行）】",
        "　取り込んだ文。",
        "",
        "【後書き】",
        "読んでくださってありがとうございます。",
        "",
      ].join("\n")
    );
  });

  it("頭の欄の無い原稿は全文が本文（末尾の改行の有無は元に合わせる）", () => {
    expect(replaceEpisodeBody("古い。\n", "新しい。")).toBe("新しい。\n");
    expect(replaceEpisodeBody("古い。", "新しい。\n")).toBe("新しい。");
    expect(replaceEpisodeBody("", "新しい。")).toBe("新しい。\n");
  });
});

describe("上書きで消える字数", () => {
  it("冒頭の欄と後書きは数えず、本文の純文字数を返す", () => {
    // 「古い本文です。」の7字（字下げの全角空白は数えない）
    expect(erasedCharCount(KAKUYOMU_WITH_AFTERWORD, ".txt")).toBe(7);
    expect(erasedCharCount("あいう\nえお\n", ".txt")).toBe(5);
  });
});

describe("訊くか・何を並べるか", () => {
  const base = {
    bodyEmpty: false,
    collected: false,
    numbered: true,
    isLatest: false,
    shiftCount: 3,
  };

  it("本文が空なら訊かずにその話へ入れる", () => {
    expect(planEpisodeImport({ ...base, bodyEmpty: true })).toEqual({ kind: "fill" });
  });

  it("本文が入っていれば、次の話・最後に加える・上書きの3つ", () => {
    expect(planEpisodeImport(base)).toEqual({
      kind: "ask",
      choices: ["next", "last", "overwrite"],
    });
  });

  it("最後の話なら、次の話と最後に加えるは1つになる（2つ）", () => {
    expect(planEpisodeImport({ ...base, isLatest: true, shiftCount: 0 })).toEqual({
      kind: "ask",
      choices: ["last", "overwrite"],
    });
    // 作品の最後ではなくても、後ろにずらす話が無ければ同じ
    expect(planEpisodeImport({ ...base, shiftCount: 0 })).toEqual({
      kind: "ask",
      choices: ["last", "overwrite"],
    });
  });

  it("話数を持たない話からは、次の話として足さない", () => {
    expect(planEpisodeImport({ ...base, numbered: false })).toEqual({
      kind: "ask",
      choices: ["last", "overwrite"],
    });
  });

  it("合本では上書きも番号ずらしもしない（最後に加えるだけ）", () => {
    expect(planEpisodeImport({ ...base, collected: true })).toEqual({
      kind: "ask",
      choices: ["last"],
    });
  });

  it("窓の説明に、名前の変わる話の数と消える字数が入る", () => {
    const lines = describeImportChoices({
      choices: ["next", "last", "overwrite"],
      sourceName: "雪の朝.docx",
      importedChars: 1200,
      next: { number: 4, fileName: "004.txt" },
      shiftCount: 3,
      lastFileName: "011.txt",
      erasedChars: 2345,
    });
    expect(lines.join("\n")).toContain("あとの話のファイル名が変わります（3話）");
    expect(lines.join("\n")).toContain("2345字が消え");
    expect(lines.join("\n")).toContain("「011.txt」");
    expect(lines[0]).toContain("1200字");
  });
});

describe("取り込むテキストファイルの文字コード", () => {
  it("UTF-8 はそのまま読む（改行は LF へ）", () => {
    const result = decodeImportedText(new TextEncoder().encode("一行目\r\n二行目\r\n"));
    expect(result).toEqual({ ok: true, text: "一行目\n二行目\n", encodingLabel: "UTF-8" });
  });

  it("Shift_JIS を読み分ける", () => {
    // 「あいう」を Shift_JIS で書いたバイト列
    const result = decodeImportedText(new Uint8Array([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4]));
    expect(result).toEqual({ ok: true, text: "あいう", encodingLabel: "Shift_JIS" });
  });

  it("BOM 付きの UTF-16（メモ帳の Unicode）も読む", () => {
    // FF FE のあとに「あ」（U+3042）と改行
    const result = decodeImportedText(new Uint8Array([0xff, 0xfe, 0x42, 0x30, 0x0a, 0x00]));
    expect(result).toEqual({ ok: true, text: "あ\n", encodingLabel: "UTF-16" });
  });

  it("どの文字コードでも読めない（化ける）ものは取り込まず、理由を返す", () => {
    const result = decodeImportedText(new Uint8Array([0x82, 0xa0, 0xff, 0xff, 0x82]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("文字コードを読み分けられませんでした");
  });

  it("文字でないもの（NUL）が入っていれば断る", () => {
    const result = decodeImportedText(new Uint8Array([0x41, 0x00, 0x42]));
    expect(result.ok).toBe(false);
  });

  it("競合の印が残っていれば断る", () => {
    const result = decodeImportedText(
      new TextEncoder().encode("<<<<<<< HEAD\nあ\n=======\nい\n>>>>>>> other\n")
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("競合");
  });
});

describe("ルビと傍点の書き方を入れる先へ寄せる", () => {
  it("Markdown を .txt の話へ入れると、投稿サイトの記法になり見出しの # が落ちる", () => {
    expect(
      adaptImportedNotation("# 雪の朝\n{漢字|かんじ}と{{強調}}。", "markdown", "003.txt")
    ).toBe("雪の朝\n｜漢字《かんじ》と《《強調》》。");
  });

  it(".txt を .md の話へ入れると、この拡張機能の記法になる", () => {
    expect(adaptImportedNotation("｜漢字《かんじ》", "plain", "003.md")).toBe("{漢字|かんじ}");
  });

  it("同じ種類どうしは1文字も変えない", () => {
    expect(adaptImportedNotation("# 見出し\n{漢字|かんじ}", "markdown", "003.md")).toBe(
      "# 見出し\n{漢字|かんじ}"
    );
    expect(adaptImportedNotation("｜漢字《かんじ》", "plain", "003.txt")).toBe("｜漢字《かんじ》");
  });
});

describe("投稿先に合わせた傍点（作者の答え 2026-11-08「作品の投稿先に合わせる」）", () => {
  it("なろう（アルファポリス）の作品の .txt へは、傍点をルビの代用で入れる", () => {
    expect(adaptImportedNotation("{{強調}}と{漢字|かんじ}", "markdown", "003.txt", "narou")).toBe(
      "｜強調《・・》と｜漢字《かんじ》"
    );
  });

  it("投稿先の指定が無ければカクヨムの形", () => {
    expect(adaptImportedNotation("{{強調}}", "markdown", "003.txt")).toBe("《《強調》》");
  });
});

describe("頭の題らしい行（作者の答え 2026-11-08「題として扱うか訊く」）", () => {
  it("短く、句点で終わらず、字下げも括弧も無い1行目のあとに本文が続けば題らしい", () => {
    expect(titleCandidate("\n第三話　雪の朝\n\n　朝が来た。\n", "plain")).toEqual({
      title: "第三話　雪の朝",
      rest: "\n　朝が来た。\n",
    });
  });

  it("Markdown の見出しは題らしい（# は落とし、ルビは親文字だけ）", () => {
    expect(titleCandidate("# {雪|ゆき}の朝\n本文。\n", "markdown")).toEqual({
      title: "雪の朝",
      rest: "本文。\n",
    });
  });

  it("本文らしい1行目は題にしない（句点で終わる・字下げ・会話・長すぎる・後ろに本文が無い）", () => {
    expect(titleCandidate("朝が来た。\n二行目。\n", "plain")).toBeNull();
    expect(titleCandidate("　朝が来た\n二行目。\n", "plain")).toBeNull();
    expect(titleCandidate("「おはよう」\n二行目。\n", "plain")).toBeNull();
    expect(titleCandidate(`${"長".repeat(41)}\n二行目。\n`, "plain")).toBeNull();
    expect(titleCandidate("雪の朝\n", "plain")).toBeNull();
  });

  it("冒頭の欄の題を差し替える（空の欄なら入れる）", () => {
    expect(replaceEpisodeTitle("【タイトル】\n古い題\n\n【本文】\n本文。\n", "新しい題")).toBe(
      "【タイトル】\n新しい題\n\n【本文】\n本文。\n"
    );
    expect(replaceEpisodeTitle("【タイトル】\n\n【本文】\n", "新しい題")).toBe(
      "【タイトル】\n新しい題\n\n【本文】\n"
    );
  });

  it("冒頭の欄に題の欄が無ければ null（ほかの置き場で扱う）", () => {
    expect(replaceEpisodeTitle("本文だけ。\n", "題")).toBeNull();
    expect(replaceEpisodeTitle("【公開状態】\n未公開\n\n【本文】\n本文。\n", "題")).toBeNull();
  });

  it("新しく作る話の名前にサブタイトルを付ける（使えない記号は全角へ）", () => {
    expect(appendSubtitle("006.txt", "雪の朝", null)).toBe("006_雪の朝.txt");
    expect(appendSubtitle("第6話.md", "雪/朝", " ")).toBe("第6話 雪／朝.md");
  });
});
