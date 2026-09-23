import { describe, it, expect } from "vitest";
import {
  splitIntoChunks,
  mergeAdjacentChunks,
  splitMergedChunk,
  splitChunkInHalf,
  withLineNumbers,
  locateChunkLine,
} from "../../src/core/chunker";

/**
 * まとめたチャンクで返ってきた行番号を、元のファイルへ戻せること。
 *
 * **ここを間違えると原稿が壊れる。** 誤字脱字はAIに「何行目」を言わせ、
 * その値で本文の位置を決めて書き換える。まとめたあとに戻せないと、
 * **2話目以降の指摘が1話目のファイルの、まったく違う行を書き換える。**
 *
 * 行番号を振るのは `withLineNumbers`、戻すのは `locateChunkLine`。
 * **2つが噛み合っていることを、振った番号をそのまま渡して確かめる。**
 */

function chunkOf(filePath: string, text: string, chapter: number) {
  return splitIntoChunks(filePath, text, chapter, chapter, {
    maxChars: 100_000,
  })[0];
}

const first = "一行目\n二行目\n三行目";
const second = "あ行目\nい行目";
const third = "ア行目\nイ行目\nウ行目\nエ行目";

describe("まとめていないチャンク", () => {
  it("振った番号が、そのまま元ファイルの行番号になる", () => {
    const chunk = chunkOf("a.txt", first, 1);
    expect(withLineNumbers(chunk).split("\n")[0]).toBe("1: 一行目");
    expect(locateChunkLine(chunk, 1)).toEqual({ filePath: "a.txt", line: 1 });
    expect(locateChunkLine(chunk, 3)).toEqual({ filePath: "a.txt", line: 3 });
  });

  it("ヘッダーの分ずれていても、そのずれを保つ", () => {
    // 投稿サイト形式では本文がファイルの途中から始まる（locateBody）
    const base = chunkOf("a.txt", first, 1);
    const shifted = { ...base, startLine: 10 };
    expect(withLineNumbers(shifted).split("\n")[0]).toBe("11: 一行目");
    expect(locateChunkLine(shifted, 11)).toEqual({
      filePath: "a.txt",
      line: 11,
    });
  });

  it("範囲の外は受け取らない", () => {
    // AIは平気で範囲外の行を返す
    const chunk = chunkOf("a.txt", first, 1);
    expect(locateChunkLine(chunk, 0)).toBeUndefined();
    expect(locateChunkLine(chunk, 4)).toBeUndefined();
    expect(locateChunkLine(chunk, 1.5)).toBeUndefined();
  });
});

describe("まとめたチャンク", () => {
  const merged = mergeAdjacentChunks(
    [
      chunkOf("a.txt", first, 1),
      chunkOf("b.txt", second, 2),
      chunkOf("c.txt", third, 3),
    ],
    { maxChars: 100_000 }
  );

  it("3話が1つになる", () => {
    expect(merged).toHaveLength(1);
  });

  it("振った番号は、まとめた本文の通し番号になる", () => {
    const numbered = withLineNumbers(merged[0]).split("\n");
    expect(numbered[0]).toBe("1: 一行目");
    // 区切りの空行を挟んで続く
    expect(numbered[4]).toBe("5: あ行目");
  });

  it("1話目の行は1話目のファイルへ戻る", () => {
    expect(locateChunkLine(merged[0], 1)).toEqual({
      filePath: "a.txt",
      line: 1,
    });
    expect(locateChunkLine(merged[0], 3)).toEqual({
      filePath: "a.txt",
      line: 3,
    });
  });

  it("2話目の行は2話目のファイルの、正しい行へ戻る", () => {
    // ここが壊れていると、b.txt の指摘が a.txt を書き換える
    expect(locateChunkLine(merged[0], 5)).toEqual({
      filePath: "b.txt",
      line: 1,
    });
    expect(locateChunkLine(merged[0], 6)).toEqual({
      filePath: "b.txt",
      line: 2,
    });
  });

  it("3話目の行も正しく戻る", () => {
    expect(locateChunkLine(merged[0], 8)).toEqual({
      filePath: "c.txt",
      line: 1,
    });
    expect(locateChunkLine(merged[0], 11)).toEqual({
      filePath: "c.txt",
      line: 4,
    });
  });

  it("振った番号すべてが、元の行文と一致する", () => {
    // **これが本命の検査である。** 1つずつ突き合わせれば、
    // 境界の取り違えが1行でもあれば落ちる
    const sources = new Map([
      ["a.txt", first.split("\n")],
      ["b.txt", second.split("\n")],
      ["c.txt", third.split("\n")],
    ]);
    const numbered = withLineNumbers(merged[0]).split("\n");

    numbered.forEach((numberedLine, index) => {
      const text = numberedLine.slice(numberedLine.indexOf(": ") + 2);
      const located = locateChunkLine(merged[0], index + 1);
      if (text === "") {
        // 区切りに入れた空行。どの話のものでもない
        return;
      }
      expect(located, `${index + 1}行目が戻せない`).toBeDefined();
      const lines = sources.get(located!.filePath);
      expect(lines?.[located!.line - 1], `${index + 1}行目の戻り先`).toBe(text);
    });
  });

  it("範囲の外は受け取らない", () => {
    expect(locateChunkLine(merged[0], 99)).toBeUndefined();
  });
});

describe("まとめたものを話ごとに戻す", () => {
  it("戻したチャンクでも行番号が正しい", () => {
    // 出力が入り切らなかったときの再試行で使う。ここで0に戻すと、
    // 話の途中を先頭と見なして別の行を書き換える
    const base = chunkOf("a.txt", first, 1);
    const shifted = { ...base, startLine: 10 };
    const merged = mergeAdjacentChunks(
      [shifted, chunkOf("b.txt", second, 2)],
      { maxChars: 100_000 }
    );
    const parts = splitMergedChunk(merged[0]);

    expect(parts).toHaveLength(2);
    expect(parts[0].startLine).toBe(10);
    expect(withLineNumbers(parts[0]).split("\n")[0]).toBe("11: 一行目");
    expect(locateChunkLine(parts[0], 11)).toEqual({
      filePath: "a.txt",
      line: 11,
    });
    expect(locateChunkLine(parts[1], 1)).toEqual({
      filePath: "b.txt",
      line: 1,
    });
  });
});

describe("半分に割る", () => {
  it("後半の開始行が、割った位置ぶん後ろになる", () => {
    // 両方に同じ開始行を入れると、後半の指摘がすべて前半の行を指す
    const text = Array.from({ length: 400 }, (_, i) => `${i + 1}行目の本文`).join(
      "\n"
    );
    const chunk = chunkOf("a.txt", text, 1);
    const halves = splitChunkInHalf(chunk);
    expect(halves).toBeDefined();
    if (!halves) return;

    expect(halves[0].startLine).toBe(0);
    expect(halves[1].startLine).toBeGreaterThan(0);

    // 後半の1行目に振られた番号が、元の本文の同じ行を指す
    const numbered = withLineNumbers(halves[1]).split("\n")[0];
    const lineNumber = Number(numbered.slice(0, numbered.indexOf(":")));
    const body = numbered.slice(numbered.indexOf(": ") + 2);
    expect(text.split("\n")[lineNumber - 1]).toBe(body);
  });
});
