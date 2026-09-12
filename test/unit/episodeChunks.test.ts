import { describe, expect, test } from "vitest";
import {
  chunksOfEpisodeFile,
  episodeBodySources,
  shiftLines,
} from "../../src/core/episodeChunks";
import {
  locateChunkLine,
  segmentAtLine,
  segmentsOf,
  withLineNumbers,
} from "../../src/core/chunker";

/**
 * 1ファイル分の本文からチャンクを作る共通の口（設計書6.23）。
 *
 * **合本は、話ごとに切らないと話数が付かない。** 丸ごと切ると全チャンクが
 * 合本の先頭の話数（ふつう1）になり、伏線の候補が全部「第1話で張られた」に
 * なる（作者の報告、2026-09-12）。
 */

/** 区切り行の形は `collectedFile.test.ts` と同じ（なろうのDLファイル） */
const COLLECTED = [
  "【タイトル】",
  "見本の作品",
  "",
  "【あらすじ】",
  "　試すための短い話。",
  "",
  "------------------------- エピソード1開始 -------------------------",
  "【エピソードタイトル】",
  "１話　出会い",
  "",
  "【本文】",
  "",
  "　一話目の合言葉は青い封筒である。",
  "",
  "【リアクション】",
  "いいね: 3件",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２話　再会",
  "",
  "【本文】",
  "",
  "　二話目の合言葉は赤い切符である。",
  "",
  "------------------------- エピソード3開始 -------------------------",
  "【エピソードタイトル】",
  "３話　別離",
  "",
  "【本文】",
  "",
  "　三話目の合言葉は銀の懐中時計である。",
  "",
  "【後書き】",
  "　読んでいただきありがとうございます。",
  "",
].join("\r\n");

const PATH = "C:/works/all.txt";

/** 合本ではない、ふつうの1話1ファイル */
const PLAIN = ["　ばらのファイルの本文である。", "", "　続きの段落。"].join(
  "\n"
);

describe("話ごとのチャンク（合本）", () => {
  test("各チャンクの内訳に、中の話数が入る", () => {
    const chunks = chunksOfEpisodeFile(
      PATH,
      COLLECTED,
      { chapterStart: 1, chapterEnd: 3 },
      { maxChars: 8000 }
    );

    // まとめない指定なので、話の数だけ返る
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.chapterStart)).toEqual([1, 2, 3]);
    expect(
      chunks.flatMap((chunk) =>
        segmentsOf(chunk).map((segment) => segment.chapterStart)
      )
    ).toEqual([1, 2, 3]);
    // 後書き・リアクションは本文に入れない
    expect(chunks.join("")).not.toContain("ありがとうございます");
  });

  test("まとめても、内訳に3話分の話数が残る", () => {
    const chunks = chunksOfEpisodeFile(
      PATH,
      COLLECTED,
      { chapterStart: 1, chapterEnd: 3 },
      { maxChars: 8000, mergeChars: 8000 }
    );

    expect(chunks).toHaveLength(1);
    const segments = segmentsOf(chunks[0]);
    expect(segments.map((segment) => segment.chapterStart)).toEqual([1, 2, 3]);
    // まとめたチャンク全体の範囲は、最初の話から最後の話まで
    expect(chunks[0].chapterStart).toBe(1);
    expect(chunks[0].chapterEnd).toBe(3);
    // 内訳の範囲を切り出すと、その話の本文が取り出せる
    const third = chunks[0].text.slice(segments[2].start, segments[2].end);
    expect(third).toContain("銀の懐中時計");
    expect(third).not.toContain("青い封筒");
  });

  test("行番号は元ファイルのものにする（頭書きの分だけずれない）", () => {
    const sources = episodeBodySources(PATH, COLLECTED, {
      chapterStart: 1,
      chapterEnd: 3,
    });

    expect(sources).toHaveLength(3);
    const lines = COLLECTED.replace(/\r\n?/g, "\n").split("\n");
    for (const source of sources) {
      // その本文の1行目が、元ファイルの同じ行に在る
      expect(lines[source.lineOffset]).toBe(source.body.split("\n")[0]);
    }

    const chunks = chunksOfEpisodeFile(
      PATH,
      COLLECTED,
      { chapterStart: 1, chapterEnd: 3 },
      { maxChars: 8000 }
    );
    expect(chunks.map((chunk) => chunk.startLine)).toEqual(
      sources.map((source) => source.lineOffset)
    );
  });
});

describe("行番号の戻し（合本）", () => {
  test("まとめたチャンクの行番号が、元ファイルの行へ戻る", () => {
    // **ここを間違えると原稿が壊れる。** 誤字脱字はAIに「何行目」を言わせ、
    // その値で本文の位置を決めて書き換える
    const chunks = chunksOfEpisodeFile(
      PATH,
      COLLECTED,
      { chapterStart: 1, chapterEnd: 3 },
      { maxChars: 8000, mergeChars: 8000 }
    );
    const numbered = withLineNumbers(chunks[0]).split("\n");
    const fileLines = COLLECTED.replace(/\r\n?/g, "\n").split("\n");

    for (const body of [
      "　一話目の合言葉は青い封筒である。",
      "　二話目の合言葉は赤い切符である。",
      "　三話目の合言葉は銀の懐中時計である。",
    ]) {
      // AIが返すであろう番号（`withLineNumbers` が振ったもの）を作る
      const numberedLine = numbered.find((line) => line.endsWith(body))!;
      const said = parseInt(numberedLine.split(":")[0], 10);

      const at = locateChunkLine(chunks[0], said);
      expect(at?.filePath).toBe(PATH);
      // 戻した行に、同じ本文が在る（1始まり）
      expect(fileLines[at!.line - 1]).toBe(body);
    }
  });
});

/**
 * 指摘の話数は、チャンクの内訳から引く。
 *
 * **ファイル単位では引けない。** 合本は走査では1件の話なので、ファイルの
 * 場所から引くと全部が先頭の話（第1話）になる（作者の報告、2026-09-12）。
 */
describe("行から話数を引く（合本）", () => {
  const BY_CHAPTER: Array<[string, number]> = [
    ["青い封筒", 1],
    ["赤い切符", 2],
    ["銀の懐中時計", 3],
  ];

  test("まとめたチャンクでも、指した行の話数になる", () => {
    const chunks = chunksOfEpisodeFile(
      PATH,
      COLLECTED,
      { chapterStart: 1, chapterEnd: 3 },
      { maxChars: 8000, mergeChars: 8000 }
    );
    const numbered = withLineNumbers(chunks[0]).split("\n");

    for (const [word, chapter] of BY_CHAPTER) {
      const said = parseInt(
        numbered.find((line) => line.includes(word))!.split(":")[0],
        10
      );
      expect(segmentAtLine(chunks[0], said)?.chapterStart).toBe(chapter);
    }
  });

  test("まとめていないチャンクでも、同じ話数になる", () => {
    const chunks = chunksOfEpisodeFile(
      PATH,
      COLLECTED,
      { chapterStart: 1, chapterEnd: 3 },
      { maxChars: 8000 }
    );

    for (const [word, chapter] of BY_CHAPTER) {
      const chunk = chunks.find((item) => item.text.includes(word))!;
      const said = parseInt(
        withLineNumbers(chunk)
          .split("\n")
          .find((line) => line.includes(word))!
          .split(":")[0],
        10
      );
      expect(segmentAtLine(chunk, said)?.chapterStart).toBe(chapter);
    }
  });

  test("範囲の外を指したら、内訳を返さない", () => {
    const chunks = chunksOfEpisodeFile(
      PATH,
      COLLECTED,
      { chapterStart: 1, chapterEnd: 3 },
      { maxChars: 8000, mergeChars: 8000 }
    );

    // AIは平気で範囲外の行を返す。話数を当てずっぽうで埋めない
    expect(segmentAtLine(chunks[0], 9999)).toBeUndefined();
    expect(segmentAtLine(chunks[0], 0)).toBeUndefined();
  });
});

/**
 * 逸脱検知は、チャンクではなく**話まるごと**を1回で送る（設計書6.10.2）。
 * `locateChunkLine` を通らないので、行を戻すのは `shiftLines` の仕事になる。
 *
 * ここで見るのは往復——AIが「本文の何行目」と言った値を元ファイルの行へ
 * 戻したとき、**同じ文がそこに在るか**である。ずれると「該当箇所へ移動」が
 * 別の話の行を開く。
 */
describe("話まるごと送った指摘の、行の往復", () => {
  /** 送った本文の中で、その文が何行目か（1始まり。`withLineNumbers` と同じ） */
  function saidLine(body: string, text: string): number {
    return body.split("\n").indexOf(text) + 1;
  }

  test("合本の第2話以降も、元ファイルの行へ戻る", () => {
    const sources = episodeBodySources(PATH, COLLECTED, {
      chapterStart: 1,
      chapterEnd: 3,
    });
    const fileLines = COLLECTED.replace(/\r\n?/g, "\n").split("\n");

    for (const [index, body] of [
      "　一話目の合言葉は青い封筒である。",
      "　二話目の合言葉は赤い切符である。",
      "　三話目の合言葉は銀の懐中時計である。",
    ].entries()) {
      const source = sources[index];
      const said = saidLine(source.body, body);
      expect(said).toBeGreaterThan(0);
      // 合本は必ずずれている（ずれていないと、この試験が何も見ていない）
      expect(source.lineOffset).toBeGreaterThan(0);

      const shifted = shiftLines(
        { lineStart: said, lineEnd: said },
        source.lineOffset
      );
      expect(fileLines[shifted.lineStart - 1]).toBe(body);
      expect(shifted.lineEnd).toBe(shifted.lineStart);
    }
  });

  test("頭書きのあるファイルも、頭書きの分だけ戻る", () => {
    const raw = [
      "【タイトル】",
      "見本",
      "",
      "【本文】",
      "",
      "　本文の1行目。",
      "　本文の2行目。",
    ].join("\n");
    const [source] = episodeBodySources("C:/works/007.txt", raw, {
      chapterStart: 7,
      chapterEnd: 7,
    });

    const said = saidLine(source.body, "　本文の2行目。");
    const shifted = shiftLines(
      { lineStart: said, lineEnd: said },
      source.lineOffset
    );

    // 元ファイルでは7行目（1始まり）
    expect(shifted.lineStart).toBe(7);
    expect(raw.split("\n")[shifted.lineStart - 1]).toBe("　本文の2行目。");
  });

  test("ずれの無いファイルでは、行番号を動かさない", () => {
    const [source] = episodeBodySources("C:/works/005.txt", PLAIN, {
      chapterStart: 5,
      chapterEnd: 5,
    });

    expect(source.lineOffset).toBe(0);
    expect(shiftLines({ lineStart: 3, lineEnd: 4 }, source.lineOffset)).toEqual({
      lineStart: 3,
      lineEnd: 4,
    });
  });
});

describe("話ごとのチャンク（ばらのファイル）", () => {
  test("渡した話数がそのまま入り、まとめ直さない", () => {
    const chunks = chunksOfEpisodeFile(
      "C:/works/005.txt",
      PLAIN,
      { chapterStart: 5, chapterEnd: 5 },
      { maxChars: 8000, mergeChars: 8000 }
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chapterStart).toBe(5);
    expect(chunks[0].chapterEnd).toBe(5);
    expect(chunks[0].startLine).toBe(0);
    expect(chunks[0].text).toContain("ばらのファイルの本文");
    // ファイルをまたぐまとめは呼び出し側が行うので、ここでは印を残す
    expect(chunks[0].wholeFile).toBe(true);
  });

  test("範囲を持つ話（第3〜4話）も、渡したままにする", () => {
    const chunks = chunksOfEpisodeFile(
      "C:/works/003-004.txt",
      PLAIN,
      { chapterStart: 3, chapterEnd: 4 },
      { maxChars: 8000 }
    );

    expect(chunks[0].chapterStart).toBe(3);
    expect(chunks[0].chapterEnd).toBe(4);
  });

  test("頭書きのあるファイルは、本文だけを切って行番号をずらす", () => {
    const raw = [
      "【タイトル】",
      "見本",
      "",
      "【本文】",
      "",
      "　本文の1行目。",
      "",
      "【後書き】",
      "　あとがき。",
    ].join("\n");

    const chunks = chunksOfEpisodeFile(
      "C:/works/007.txt",
      raw,
      { chapterStart: 7, chapterEnd: 7 },
      { maxChars: 8000 }
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("本文の1行目");
    expect(chunks[0].text).not.toContain("あとがき");
    // 本文は6行目（0始まりで5）から始まる
    expect(chunks[0].startLine).toBe(5);
    expect(segmentsOf(chunks[0])[0].startLine).toBe(5);
  });

  test("中身の無いファイルからはチャンクを作らない", () => {
    expect(
      chunksOfEpisodeFile(
        "C:/works/empty.txt",
        "\n\n",
        { chapterStart: 1, chapterEnd: 1 },
        { maxChars: 8000 }
      )
    ).toEqual([]);
  });
});
