import { describe, expect, test } from "vitest";
import * as path from "node:path";
import {
  chunkFromId,
  chunkIdOf,
  chunksOfWorkFile,
  parseChunkId,
  selectChunks,
} from "../../src/mcp/tools/shared";
import { settingsPrompt } from "../../src/mcp/tools/settings";

/**
 * チャンクの呼び名が、**話をまたいでぶつからない**こと（設計書6.87.8）。
 *
 * **0.49.0 から 0.64.3 まで壊れていた。** `chunk.index` は話ごとに0から
 * 振り直されるので、合本（1ファイルに何話も入っている）で各話が1つの
 * チャンクに収まると、**3話とも同じ名前**になっていた。
 *
 * 影響は静かで重い。`chunkFromId` は最初に当たったものを返すので、
 * **第2話を検算したつもりで第1話の本文と照合する**。根拠照合（AIが
 * 言った箇所が本文に実在するか）が誤り、「何も指摘しない」か
 * 「全部が本文に無い」に倒れる——**どちらも不具合に見えない**。
 *
 * 単体テストでは見つからなかった（件数しか見ていなかった）。
 * **合本の fixture で鍵そのものを見る**ここが、再発を止める。
 */

const WORK = path.join(__dirname, "..", "fixtures", "mcp-work");
const NUM_CTX = 32768;

/** 第1〜3話が入っている合本。各話が1チャンクに収まる大きさ */
const COLLECTED = path.join("本文", "collected.txt");

describe("合本で、チャンクの呼び名がぶつからない", () => {
  test("話ごとに違う呼び名になる", () => {
    const { chunks, maxChars } = chunksOfWorkFile(WORK, COLLECTED, NUM_CTX);
    // 3話ぶんが、それぞれ1チャンクに収まっている（ぶつかりうる条件）
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.map((chunk) => chunk.index)).toContain(0);

    const ids = chunks.map((chunk) => chunkIdOf(COLLECTED, chunk, maxChars));
    expect(new Set(ids).size, `ぶつかっている: ${ids.join(" / ")}`).toBe(
      ids.length
    );
  });

  test("呼び名から、その話のチャンクが戻る", () => {
    const { chunks, maxChars } = chunksOfWorkFile(WORK, COLLECTED, NUM_CTX);
    for (const chunk of chunks) {
      const id = chunkIdOf(COLLECTED, chunk, maxChars);
      const back = chunkFromId(WORK, id);
      // **話数と本文の両方が戻る。** 話数だけ合っていても、本文が
      // 別の話なら検算は誤る
      expect(back.chapterStart).toBe(chunk.chapterStart);
      expect(back.text).toBe(chunk.text);
    }
  });

  test("prompt が返す呼び名も、話ごとに違う", () => {
    // **道具の口から出る形で確かめる。** 中の関数だけ見ていると、
    // 道具が別の作り方をしていたときに素通りする
    const result = settingsPrompt({
      folder: WORK,
      filePath: COLLECTED,
      numCtx: NUM_CTX,
    });
    const ids = result.chunks.map((chunk) => chunk.chunkId);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size, `ぶつかっている: ${ids.join(" / ")}`).toBe(
      ids.length
    );
  });
});

describe("呼び名の読み書き", () => {
  test("話数・番号・切った大きさが戻る", () => {
    const parsed = parseChunkId("本文/collected.txt#2-0@8027");
    expect(parsed).toEqual({
      filePath: "本文/collected.txt",
      chapter: 2,
      index: 0,
      maxChars: 8027,
    });
  });

  test("話数の読めないファイルは x", () => {
    const parsed = parseChunkId("about.txt#x-1@8027");
    expect(parsed.chapter).toBeNull();
    expect(parsed.index).toBe(1);
  });

  test("古い形（話数の無いもの）は受け取らない", () => {
    /*
      **受け取ると、別の話と照合していた頃の鍵がそのまま通る。**
      断って prompt を取り直させるほうが安全である。
    */
    expect(() => parseChunkId("本文/collected.txt#0@8027")).toThrow(
      /0\.64\.3/
    );
  });

  test("形の違うものは断る", () => {
    expect(() => parseChunkId("本文/collected.txt")).toThrow(/形が違います/);
    expect(() => parseChunkId("本文/collected.txt#あ-い@8027")).toThrow(
      /形が違います/
    );
  });
});

describe("チャンクを1つに絞る", () => {
  test("合本で chunkIndex を指定すると、ちょうど1つになる", () => {
    const { chunks } = chunksOfWorkFile(WORK, COLLECTED, NUM_CTX);
    // **「絞ったつもりで絞れていない」を止める。** 以前は話ごとに
    // index が振り直されるため、0 を指定すると3話ぶんが返っていた
    for (let at = 0; at < chunks.length; at++) {
      const selected = selectChunks(chunks, at);
      expect(selected).toHaveLength(1);
      expect(selected[0]).toBe(chunks[at]);
    }
  });

  test("無い番号は断る", () => {
    const { chunks } = chunksOfWorkFile(WORK, COLLECTED, NUM_CTX);
    expect(() => selectChunks(chunks, chunks.length)).toThrow(/チャンク/);
  });

  test("指定しなければ全部そのまま", () => {
    const { chunks } = chunksOfWorkFile(WORK, COLLECTED, NUM_CTX);
    expect(selectChunks(chunks)).toBe(chunks);
  });
});
