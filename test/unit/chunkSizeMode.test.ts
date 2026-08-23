import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE_MODE_AUTO,
  CHUNK_SIZE_MODE_MANUAL,
  decideChunkSize,
  describeChunkScope,
  parseChunkSizeMode,
  resolveChunkChars,
  resolveMergeChars,
  type Chunk,
} from "../../src/core/chunker";

/**
 * チャンクの大きさの決め方（設計書6.23）。
 *
 * 作者の指示（2026-08-23）：「設定画面上に『モデルによって可変』を選べる
 * ようにし、それをデフォルトにしてください」。
 *
 * **既定は自動。** 131,072受けられるモデルへ2,000字ずつ送るのは、
 * 呼び出し回数の面でも指示の使い回しの面でも損である。
 */

describe("設定の言葉を読む", () => {
  it("既定は自動", () => {
    expect(parseChunkSizeMode(undefined)).toBe("auto");
    expect(parseChunkSizeMode(CHUNK_SIZE_MODE_AUTO)).toBe("auto");
  });

  it("「文字数を指定する」だけが手動", () => {
    expect(parseChunkSizeMode(CHUNK_SIZE_MODE_MANUAL)).toBe("manual");
  });

  /** 知らない値が入っていても止まらない。安全側（自動）へ落とす */
  it("知らない言葉は自動として扱う", () => {
    expect(parseChunkSizeMode("よくわからない値")).toBe("auto");
  });
});

describe("1チャンクの字数", () => {
  it("自動なら、モデルのコンテキスト長から決める", () => {
    const resolved = resolveChunkChars({
      mode: "auto",
      configured: 5000,
      contextWindow: 131072,
    });
    expect(resolved.chars).toBe(decideChunkSize(131072));
    expect(resolved.from).toBe("model");
  });

  /** **自動のときは、指定値を見ない。** 見ると「自動」の意味が無くなる */
  it("自動なら、字数の指定があっても使わない", () => {
    const resolved = resolveChunkChars({
      mode: "auto",
      configured: 321,
      contextWindow: 8192,
    });
    expect(resolved.chars).not.toBe(321);
  });

  it("手動なら、指定した字数を使う", () => {
    const resolved = resolveChunkChars({
      mode: "manual",
      configured: 321,
      contextWindow: 131072,
    });
    expect(resolved).toEqual({ chars: 321, from: "setting" });
  });

  /**
   * **「指定する」を選んだのに字数が空、は起こりうる。**
   * そこで止めるより、モデルから決めて進めるほうがよい。
   */
  it("手動なのに字数が無ければ、モデルから決め直す", () => {
    for (const configured of [undefined, 0, -1, 0.5]) {
      const resolved = resolveChunkChars({
        mode: "manual",
        configured,
        contextWindow: 8192,
      });
      expect(resolved.chars, String(configured)).toBe(decideChunkSize(8192));
      expect(resolved.from, String(configured)).toBe("fallback");
    }
  });

  it("小さいモデルでも下限を割らない", () => {
    expect(
      resolveChunkChars({ mode: "auto", configured: 0, contextWindow: 1024 })
        .chars
    ).toBeGreaterThanOrEqual(1500);
  });
});

describe("まとめて送るときの字数", () => {
  /** **モデルが受けられる量を使い切るのが、呼び出し回数をいちばん減らす** */
  it("自動なら、チャンクの大きさまで詰める", () => {
    expect(
      resolveMergeChars({ mode: "auto", configured: 6000, chunkChars: 20000 })
    ).toBe(20000);
  });

  it("手動なら、指定した字数を使う", () => {
    expect(
      resolveMergeChars({ mode: "manual", configured: 6000, chunkChars: 20000 })
    ).toBe(6000);
  });

  /** 分割の目安を超えて詰め込むと、そのチャンクが入り切らない */
  it("手動でも、チャンクより大きくはしない", () => {
    expect(
      resolveMergeChars({ mode: "manual", configured: 9000, chunkChars: 2000 })
    ).toBe(2000);
  });

  it("手動で0を指定すれば、まとめない", () => {
    expect(
      resolveMergeChars({ mode: "manual", configured: 0, chunkChars: 20000 })
    ).toBe(0);
  });
});

/**
 * **まとめたチャンクでは、話が1つとは限らない**（設計書6.23）。
 *
 * 矛盾検知はAIへ「いま見ているのは第何話か」を渡す。1つ目の話の名前だけを
 * 渡すと、2話目以降の本文を1話目だと言って読ませることになる。
 */
describe("まとめたチャンクが含む話", () => {
  function chunk(files: string[]): Chunk {
    return {
      filePath: files[0],
      index: 0,
      text: files.map(() => "本文").join("\n"),
      startLine: 0,
      chapterStart: null,
      chapterEnd: null,
      hash: "h",
      segments: files.map((filePath, index) => ({
        filePath,
        chapterStart: null,
        chapterEnd: null,
        start: index * 3,
        end: index * 3 + 2,
        startLine: 0,
      })),
    };
  }

  const label = (filePath: string) =>
    ({ "1.md": "第1話", "2.md": "第2話", "3.md": "第3話" })[filePath];

  it("1話だけなら、その話の名前", () => {
    expect(describeChunkScope(chunk(["1.md"]), label)).toBe("第1話");
  });

  /** 全部並べると、20話まとめたときに読めなくなる */
  it("複数なら、端どうしを繋ぐ", () => {
    expect(describeChunkScope(chunk(["1.md", "2.md", "3.md"]), label)).toBe(
      "第1話〜第3話"
    );
  });

  it("名前が引けなければ、何も言わない", () => {
    expect(describeChunkScope(chunk(["4.md"]), label)).toBe("");
  });

  it("同じ話が2回出ても、重ねて数えない", () => {
    // 1つのファイルが2つに割れているとき
    expect(describeChunkScope(chunk(["1.md", "1.md"]), label)).toBe("第1話");
  });
});
