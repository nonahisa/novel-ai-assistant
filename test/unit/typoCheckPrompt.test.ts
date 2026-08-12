import { describe, expect, test } from "vitest";
import { withLineNumbers, type Chunk } from "../../src/core/chunker";
import { buildTypoCheckPrompt } from "../../src/prompts/typoCheck";
import { locateBody } from "../../src/features/checkTypos";

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
