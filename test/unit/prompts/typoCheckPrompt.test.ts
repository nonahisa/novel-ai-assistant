import { describe, expect, test } from "vitest";
import { withLineNumbers, type Chunk } from "../../../src/core/chunker";
import {
  TYPO_CHECK_SYSTEM_PROMPT,
  TYPO_CHECK_SYSTEM_PROMPT_SMALL,
  TYPO_CHECK_VERSION,
  TYPO_CHECK_VERSION_SMALL,
  buildTypoCheckPrompt,
  typoPromptVersion,
} from "../../../src/prompts/typoCheck";
import { locateBody } from "../../../src/core/episodeChunks";

function makeChunk(text: string, startLine: number): Chunk {
  return {
    filePath: "C:\\work\\001.txt",
    index: 0,
    text,
    startLine,
    chapterStart: 1,
    chapterEnd: 1,
    hash: "hash-1",
  };
}

describe("行番号付きの本文", () => {
  test("startLineを基準に1始まりの行番号を振る", () => {
    const chunk = makeChunk("一行目\n二行目\n三行目", 0);
    expect(withLineNumbers(chunk)).toBe("1: 一行目\n2: 二行目\n3: 三行目");
  });

  test("チャンクがファイルの途中から始まる場合はその行番号から続く", () => {
    // startLine は0始まり。10行目（0始まりで9）から始まるチャンクの
    // 1行目は、ファイル上では10行目になる
    const chunk = makeChunk("続きの行", 9);
    expect(withLineNumbers(chunk)).toBe("10: 続きの行");
  });
});

describe("誤字脱字検知のプロンプト組み立て", () => {
  test("固有名詞辞書と本文が本文へ埋め込まれる", () => {
    const prompt = buildTypoCheckPrompt({
      chunkTextWithLineNumbers: "1: 彼は意外な行動に出た。",
      properNounDictionary: ["ホンゴー", "ウィズ"],
    });

    expect(prompt).toContain("1: 彼は意外な行動に出た。");
    expect(prompt).toContain("ホンゴー、ウィズ");
    expect(prompt).toContain("JSONのみ");
  });

  test("固有名詞が空でもプレースホルダーで埋める", () => {
    const prompt = buildTypoCheckPrompt({
      chunkTextWithLineNumbers: "1: 本文",
      properNounDictionary: [],
    });
    expect(prompt).toContain("（まだ登録されていません）");
  });
});

describe("大きいモデル向けと小さいモデル向けの2つの版（P-09 1.2）", () => {
  const base = {
    chunkTextWithLineNumbers: "1: 本文",
    properNounDictionary: [],
  };

  test("大きいモデル向け（既定）は、検算と揃えた書き方を渡す", () => {
    const prompt = buildTypoCheckPrompt(base);
    // 検算が通す形（空白・行末の句点・入力ミス）と、捨てる形（台詞の句点・字下げ）
    expect(prompt).toContain("紛れ込んだ空白は、空白とその直前の1字を target にする");
    expect(prompt).toContain("地の文の行末の句点抜け");
    expect(prompt).toContain("台詞（「」の中）の末尾に句点を足すこと");
    expect(prompt).toContain("入力ミス");
    expect(prompt).toContain("target の外にある前後の文字を suggestion に入れないこと");
    expect(prompt).toContain("ら抜き言葉・い抜き言葉（会話文でも地の文でも");
  });

  test("大きいモデル向けも、確信の強さは 1.1 のまま（low で出してよいとは言わない）", () => {
    // 「low で出してよい」は Kimi-K2.6 で誤検出を 2→14 に増やした（設計書6.8.20）
    const prompt = buildTypoCheckPrompt(base);
    expect(prompt).toContain("確信が持てないものは指摘しないこと");
    expect(prompt).not.toContain("low で出してかまいません");
    expect(prompt).not.toContain("前後の流れと合わない語の書き誤り");
    expect(TYPO_CHECK_SYSTEM_PROMPT).toContain("確信が持てないものは指摘しない");
  });

  test("小さいモデル向けは 1.1 の文のまま（書き方の指示を足さない）", () => {
    // 書き方の指示を足した版は、e4b で文まるごとの言い換えを増やした（設計書6.8.20）
    const prompt = buildTypoCheckPrompt({ ...base, forSmallModel: true });
    expect(prompt).toContain("確信が持てないものは指摘しないこと");
    expect(prompt).toContain("誤っている語のみ");
    expect(prompt).not.toContain("【target と suggestion の書き方】");
    expect(TYPO_CHECK_SYSTEM_PROMPT_SMALL).toContain("確信が持てないものは指摘しない");
    expect(TYPO_CHECK_SYSTEM_PROMPT_SMALL).not.toContain("根拠が本文にある");
  });

  test("版の名前：大きいモデル向けは 1.2、小さいモデル向けは 1.1（文が同じなので処理済みを飛ばさない）", () => {
    expect(typoPromptVersion(false)).toBe(TYPO_CHECK_VERSION);
    expect(typoPromptVersion(true)).toBe(TYPO_CHECK_VERSION_SMALL);
    expect(TYPO_CHECK_VERSION_SMALL).toBe("1.1");
    expect(TYPO_CHECK_VERSION).not.toBe(TYPO_CHECK_VERSION_SMALL);
  });
});

describe("メタデータヘッダーを除いた本文の実ファイル上の行番号", () => {
  test("ヘッダーが無ければ0行目から", () => {
    const raw = "本文1行目\n本文2行目";
    const located = locateBody(raw, raw, 0);
    expect(located.line).toBe(0);
  });

  test("ヘッダー分の行数だけ本文の開始行がずれる", () => {
    const raw =
      "【タイトル】\nケース００１\n\n【本文】\n本文1行目\n本文2行目";
    const body = "本文1行目\n本文2行目";
    const located = locateBody(raw, body, 0);
    // raw の行: 0:【タイトル】 1:ケース001 2:(空) 3:【本文】 4:本文1行目 ...
    expect(located.line).toBe(4);
  });

  test("見つからなければ0行目とみなす（安全側）", () => {
    const located = locateBody("何か別の文章", "見つからない本文", 0);
    expect(located.line).toBe(0);
  });

  test("合本のように同じ本文が複数話あっても、fromIndexで次の一致から探す", () => {
    const raw = "本文A\n区切り\n本文A\n終わり";
    const first = locateBody(raw, "本文A", 0);
    const second = locateBody(raw, "本文A", first.nextSearchIndex);
    expect(first.line).toBe(0);
    expect(second.line).toBe(2);
  });
});
