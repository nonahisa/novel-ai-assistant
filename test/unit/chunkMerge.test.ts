import { describe, expect, test } from "vitest";
import {
  contextSizeForPrompt,
  locateChunkLine,
  mergeAdjacentChunks,
  segmentsOf,
  splitChunkInHalf,
  splitIntoChunks,
  splitMergedChunk,
  type Chunk,
} from "../../src/core/chunker";
import { chaptersForCandidate } from "../../src/core/groundedEvidence";
import { validateCharacterExtractResult } from "../../src/core/characterExtractionValidation";

/**
 * 短い話をまとめて1回で送る仕組み。
 *
 * 1回の呼び出しごとに本文とは別に約5,600字の指示を送っているため、
 * 1話2,000字の作品では指示のほうが大きい。まとめると呼び出し回数と
 * 送信量が減るが、**まとめたせいで登場話数が狂ってはいけない。**
 */

function episode(chapter: number, text: string): Chunk {
  return splitIntoChunks(
    `episode_${String(chapter).padStart(4, "0")}.txt`,
    text,
    chapter,
    chapter,
    { maxChars: 8000 }
  )[0];
}

describe("短い話をまとめる", () => {
  test("収まるだけ隣どうしをまとめる", () => {
    const chunks = [
      episode(1, "あ".repeat(100)),
      episode(2, "い".repeat(100)),
      episode(3, "う".repeat(100)),
    ];

    const merged = mergeAdjacentChunks(chunks, { maxChars: 250 });

    // 1つ目と2つ目で204字。3つ目を足すと超えるので分かれる
    expect(merged).toHaveLength(2);
    expect(segmentsOf(merged[0]).map((s) => s.chapterStart)).toEqual([1, 2]);
    expect(segmentsOf(merged[1]).map((s) => s.chapterStart)).toEqual([3]);
    expect(merged[0].chapterStart).toBe(1);
    expect(merged[0].chapterEnd).toBe(2);
  });

  test("まとめても本文は変えない（区切りは空行だけ）", () => {
    const merged = mergeAdjacentChunks(
      [episode(1, "本文A"), episode(2, "本文B")],
      { maxChars: 1000 }
    );

    // 「第2話」のような目印は書き足さない。
    // 本文に無い文字列を混ぜると、AIが引用として返してくることがある
    expect(merged[0].text).toBe("本文A\n\n本文B");
  });

  test("大きいファイルを分割した断片は混ぜない", () => {
    // 前後がつながっている断片を別の話と隣り合わせると、文脈が切れる
    const long = splitIntoChunks("long.txt", "あ".repeat(300), 5, 5, {
      maxChars: 100,
    });
    expect(long.length).toBeGreaterThan(1);

    const merged = mergeAdjacentChunks(
      [episode(1, "短い話"), ...long, episode(9, "短い話")],
      { maxChars: 5000 }
    );

    expect(merged).toHaveLength(2 + long.length);
  });

  test("合本の中の話も、同じファイルのままでまとめられる", () => {
    // 全話が1ファイルに入っている作品では、話ごとに分けたチャンクが
    // すべて同じファイルパスになる。ファイルが違うことを条件にしていると
    // 1つもまとまらず、219話が219回の呼び出しになってしまう
    const inner = (chapter: number, text: string): Chunk =>
      splitIntoChunks("N2600GO.txt", text, chapter, chapter, {
        maxChars: 8000,
      })[0];

    const merged = mergeAdjacentChunks(
      [inner(1, "あ".repeat(100)), inner(2, "い".repeat(100))],
      { maxChars: 1000 }
    );

    expect(merged).toHaveLength(1);
    expect(segmentsOf(merged[0]).map((s) => s.chapterStart)).toEqual([1, 2]);
  });

  test("0を渡したら、まとめない", () => {
    const chunks = [episode(1, "あ"), episode(2, "い")];

    expect(mergeAdjacentChunks(chunks, { maxChars: 0 })).toHaveLength(2);
  });
});

/**
 * **本文が空のチャンクは、行番号の対応を壊す。**
 *
 * まとめるとき、区切り（空行）を入れるかどうかを「ここまでの本文があるか」で
 * 決めていた。そのため束の先頭が空文字だと区切りが入らず、**内訳2つの開始位置が
 * どちらも0**になる。`locateChunkLine` は前から見るので、まとめた本文の1行目が
 * 空のほうのファイルの行だと判定され、誤字脱字の指摘が
 * 「位置を特定できませんでした」で黙って捨てられる。
 *
 * 空のチャンクが生まれる道は3つある。
 *   (a) メモ行だけで末尾に改行の無い話（`blankMemoLines` で全部消える）
 *   (b) 0バイトの話ファイル（推敲・矛盾には `.trim()` の関所が無い）
 *   (c) 合本の中の空の話
 *
 * 送っても何も指摘できないものは、そもそも作らない・束ねない。
 */
describe("本文が空のチャンクは作らない", () => {
  test("メモ行だけの話は、チャンクを1つも返さない", () => {
    // 末尾に改行が無いので、メモを空行にすると本文が丸ごと消える（道(a)）
    expect(
      splitIntoChunks("memo.txt", "// あとで直す", 1, 1, { maxChars: 8000 })
    ).toEqual([]);
  });

  test("0バイトの話も、チャンクを1つも返さない", () => {
    // 道(b)。推敲・矛盾検知には本文の空判定が無く、ここまで届く
    expect(splitIntoChunks("empty.txt", "", 2, 2, { maxChars: 8000 })).toEqual(
      []
    );
  });

  test("空白と改行だけでも、チャンクを1つも返さない", () => {
    expect(
      splitIntoChunks("blank.txt", "\n\n 　\n", 3, 3, { maxChars: 8000 })
    ).toEqual([]);
  });
});

describe("本文が空のチャンクは束ねない", () => {
  /** 合本の中の空の話（道(c)）。手で組み立てないと、もう作れない */
  function emptyChunk(filePath: string, chapter: number): Chunk {
    return {
      filePath,
      index: 0,
      text: "",
      startLine: 0,
      chapterStart: chapter,
      chapterEnd: chapter,
      hash: `empty-${chapter}`,
      segments: [
        {
          filePath,
          chapterStart: chapter,
          chapterEnd: chapter,
          start: 0,
          end: 0,
          startLine: 0,
        },
      ],
      wholeFile: true,
    };
  }

  test("先頭が空でも、1行目は本文のあるファイルを指す", () => {
    const merged = mergeAdjacentChunks(
      [emptyChunk("empty.txt", 1), episode(2, "一行目\n二行目")],
      { maxChars: 1000 }
    );

    // 空の1件は捨てるので、束ねる相手がいなくなり1件だけが残る
    expect(merged).toHaveLength(1);
    expect(locateChunkLine(merged[0], 1)).toEqual({
      filePath: "episode_0002.txt",
      line: 1,
    });
  });

  test("あいだに空が挟まっても、前後は1つに束ねられる", () => {
    // 空で束が切れる（flushする）と、まとめる意味が無くなる。素通しにする
    const merged = mergeAdjacentChunks(
      [
        episode(1, "第一話の本文"),
        emptyChunk("empty.txt", 2),
        episode(3, "第三話の本文"),
      ],
      { maxChars: 1000 }
    );

    expect(merged).toHaveLength(1);
    expect(segmentsOf(merged[0]).map((s) => s.chapterStart)).toEqual([1, 3]);
    expect(merged[0].text).toBe("第一話の本文\n\n第三話の本文");
  });
});

describe("まとめたチャンクを元に戻す", () => {
  test("話ごとの本文と話数が元どおりになる", () => {
    // 出力上限で切り詰められたときにやり直すための道。
    // 部分的なJSONは解析できないので、諦めると1回ぶんが無駄になる
    const merged = mergeAdjacentChunks(
      [episode(1, "第一話の本文"), episode(2, "第二話の本文")],
      { maxChars: 1000 }
    );

    const split = splitMergedChunk(merged[0]);

    expect(split).toHaveLength(2);
    expect(split.map((chunk) => chunk.text)).toEqual([
      "第一話の本文",
      "第二話の本文",
    ]);
    expect(split.map((chunk) => chunk.chapterStart)).toEqual([1, 2]);
  });

  test("戻したチャンクのハッシュは、まとめる前と同じ", () => {
    // 同じならキャッシュがそのまま効く
    const before = [episode(1, "第一話の本文"), episode(2, "第二話の本文")];
    const merged = mergeAdjacentChunks(before, { maxChars: 1000 });

    expect(splitMergedChunk(merged[0]).map((c) => c.hash)).toEqual(
      before.map((c) => c.hash)
    );
  });

  test("まとめていないチャンクはそのまま返す", () => {
    const single = episode(1, "本文");

    expect(splitMergedChunk(single)).toEqual([single]);
  });
});

// `decideContextSize`（本文の字数＋固定12,000字で num_ctx を決めるもの）は
// 0.25.6 で**消した**（設計書6.27.10）。ここにあった4件の検査——とくに
// 「指示の見込みは実測（約10,000字）を下回らない」——は、**固定費の見込みが
// 実測に置いていかれないこと**を見張るためのものだった。
//
// いまは全機能が `contextSizeForPrompt`（組み上がったプロンプトの実測から
// 決める）を通り、見込むべき固定費が存在しない。**見張る対象そのものが
// 無くなった**ので、検査も消した。本文の割当が固定費に押されて縮むことは
// `contextBudget.test.ts` の `planChunkBudget` が見る。
describe("確保するコンテキスト長", () => {
  test("実物のプロンプトからは、その字数と応答が入る大きさにする", () => {
    // numCtx を渡してこない呼び出しのための見積り。
    // 30,000字は約42,858トークン。これに応答分が乗る
    const size = contextSizeForPrompt({
      promptChars: 30000,
      outputTokens: 8192,
      contextWindow: 131072,
    });

    expect(size).toBeGreaterThan(Math.ceil(30000 / 0.7) + 8192);
    expect(size).toBeLessThanOrEqual(131072);
  });

  test("実物のプロンプトには、指示ぶんの固定費を足さない", () => {
    // 送る文字列そのものが手元にあるので、二重に見込まない。
    // 20,000字は約28,572トークン。応答の8,192を足して1割の余裕まで
    const size = contextSizeForPrompt({
      promptChars: 20000,
      outputTokens: 8192,
      contextWindow: 131072,
    });

    // 「本文＋固定12,000字」で見込んでいた頃の値（約45,715＋8,192）より小さい
    expect(size).toBeLessThan(Math.ceil((45715 + 8192) * 1.1));
    expect(size).toBeGreaterThanOrEqual(Math.ceil(20000 / 0.7) + 8192);
  });

  test("モデルの上限は超えない", () => {
    // /api/show が取れないときは 8192 で頭打ちになる（従来の固定値と同じ）
    expect(
      contextSizeForPrompt({
        promptChars: 30000,
        outputTokens: 8192,
        contextWindow: 8192,
      })
    ).toBe(8192);
  });

  test("短いプロンプトでも4096は確保する", () => {
    // 極端に小さい num_ctx は、応答が数十トークンで切れる
    expect(
      contextSizeForPrompt({
        promptChars: 10,
        outputTokens: 0,
        contextWindow: 131072,
      })
    ).toBe(4096);
  });
});

describe("入り切らないチャンクを半分にする", () => {
  test("段落の切れ目で2つに割る", () => {
    // 大きいファイルの断片は話ごとに戻せない。捨てると呼び出しが無駄になる
    const chunk = episode(1, `${"あ".repeat(2000)}\n\n${"い".repeat(2000)}`);

    const halves = splitChunkInHalf(chunk);

    expect(halves).toHaveLength(2);
    expect(halves?.[0].text.endsWith("\n\n")).toBe(true);
    expect(halves?.[1].text.startsWith("い")).toBe(true);
    // 合わせると元の本文に戻る（本文を落とさない）
    expect(halves?.map((h) => h.text).join("")).toBe(chunk.text);
  });

  test("短いチャンクは割らない（際限なく割り続けない）", () => {
    expect(splitChunkInHalf(episode(1, "短い本文"))).toBeUndefined();
  });
});

describe("登場話数を本文の位置から決める", () => {
  const merged = mergeAdjacentChunks(
    [
      episode(1, "「おはよう」と灯が言った。"),
      episode(2, "澪は黙って歩いていた。"),
      episode(3, "カーラーンが扉を叩いた。"),
    ],
    { maxChars: 1000 }
  )[0];

  test("引用のある話だけを付ける", () => {
    // まとめたチャンク全体の話数を付けると、
    // 第3話にしか出ない人物が「第1〜3話に登場」になってしまう
    expect(
      chaptersForCandidate(merged, ["カーラーン"], "カーラーンが扉を叩いた")
    ).toEqual([3]);
  });

  test("引用が無くても、呼称のある話で決める", () => {
    expect(chaptersForCandidate(merged, ["澪"], null)).toEqual([2]);
  });

  test("どちらでも決まらなければ、まとめた範囲を返す", () => {
    // 取りこぼすより広く付ける（今までどおりの動き）
    expect(chaptersForCandidate(merged, ["誰か"], "本文に無い引用")).toEqual([
      1, 2, 3,
    ]);
  });

  test("まとめていないチャンクでは、これまでどおり", () => {
    const single = episode(7, "「おはよう」と灯が言った。");

    expect(chaptersForCandidate(single, ["灯"], "灯が言った")).toEqual([7]);
  });

  test("複数の話に出てくる人物には、その全部を付ける", () => {
    const both = mergeAdjacentChunks(
      [episode(1, "灯が笑った。"), episode(2, "灯が走った。")],
      { maxChars: 1000 }
    )[0];

    expect(chaptersForCandidate(both, ["灯"], null)).toEqual([1, 2]);
  });
});

describe("抽出の経路でも正しい話数が付く", () => {
  test("まとめて送っても、人物ごとに出てきた話だけが記録される", () => {
    const merged = mergeAdjacentChunks(
      [
        episode(1, "「おはよう」と灯が言った。朝の教室は静かだった。"),
        episode(2, "澪は黙って歩いていた。雨が降っていた。"),
      ],
      { maxChars: 1000 }
    )[0];

    const result = validateCharacterExtractResult(
      {
        characters: [
          {
            name: "灯",
            entityType: "person",
            evidence: "「おはよう」と灯が言った",
          },
          {
            name: "澪",
            entityType: "person",
            evidence: "澪は黙って歩いていた",
          },
        ],
      },
      merged
    );

    expect(result.rejected).toEqual([]);
    expect(
      result.accepted.map((item) => [item.data.name, item.chapters])
    ).toEqual([
      ["灯", [1]],
      ["澪", [2]],
    ]);
  });
});
