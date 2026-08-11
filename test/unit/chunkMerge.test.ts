import { describe, expect, test } from "vitest";
import {
  decideContextSize,
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

describe("確保するコンテキスト長", () => {
  test("チャンクと指示と応答が全部入る大きさにする", () => {
    // 20,000字のチャンクを16,384トークンのコンテキストへ送っていたため、
    // 入力が入り切らず出力の余地も残らなかった。
    // 実データで39チャンク中33件が「出力上限で切り詰め」になった
    const size = decideContextSize({
      chunkChars: 20000,
      outputTokens: 16384,
      contextWindow: 131072,
    });

    // 本文20,000字＋指示7,000字 ≒ 38,572トークン。これに応答分が乗る
    expect(size).toBeGreaterThan(38572 + 16384);
    expect(size).toBeLessThanOrEqual(131072);
  });

  test("モデルの上限は超えない", () => {
    // 超える値を渡すと、モデル側で黙って切り捨てられる
    expect(
      decideContextSize({
        chunkChars: 20000,
        outputTokens: 16384,
        contextWindow: 8192,
      })
    ).toBe(8192);
  });

  test("本文が短くても、指示の分は必ず見込む", () => {
    // 本文が10字でも、抽出の指示だけで約7,000字（1万トークン近く）ある。
    // 本文の長さだけで決めると、指示が入り切らない
    expect(
      decideContextSize({
        chunkChars: 10,
        outputTokens: 10,
        contextWindow: 131072,
      })
    ).toBeGreaterThan(10000);
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
