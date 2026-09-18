import { describe, expect, it } from "vitest";
import nodePath from "node:path";
import {
  factContradictionPrompt,
  factContradictionValidate,
  factContradictionRun,
} from "../../src/mcp/tools/factContradiction";
import { novelPrompt, novelRun } from "../../src/mcp/tools/features";
import { STORY_FACT_EXTRACT_VERSION } from "../../src/prompts/storyFactExtract";

/**
 * 矛盾検知（事実の照合）を外から呼ぶ口（設計書6.88 の評価セット）。
 *
 * **測れることを、測る前に確かめる。** 0.46.0〜0.46.3 で実装されたのに
 * MCP の一覧に無く、**効くのかどうかが一度も分からなかった**のがそもそもの
 * 発端である。ここで見るのは「配線が通っているか」——精度そのものは
 * `scripts/measure.mjs` が実データで測る。
 */

/** 答え付きの台（P-12 と**同じ仕込み**を使う。台を分けると比べられない） */
const WORK = nodePath.join(
  __dirname,
  "..",
  "fixtures",
  "seeded",
  "contradiction"
);

const NUM_CTX = 32768;

describe("事実の照合——プロンプトを組む", () => {
  it("filePath を省くと、作品ぜんたいのチャンクを返す", () => {
    /*
      **ここが P-12 との違いである。** 第2話で折った足が第4話でどちらの
      ギプスか、という型は**話をまたがないと拾えない**。1話ずつ回す形に
      すると、6.88 の値打ちが原理的に消える。
    */
    const result = factContradictionPrompt({ folder: WORK, numCtx: NUM_CTX });
    const files = new Set(
      result.chunks.map((chunk) => chunk.chunkId.split("#")[0])
    );
    expect(files.size).toBeGreaterThanOrEqual(5);
    expect(result.promptVersion).toBe(STORY_FACT_EXTRACT_VERSION);
    expect(result.validateWith).toBe(
      "novel.validate（feature: factContradiction）"
    );
  });

  it("**矛盾ではなく事実を抜く段だ**と断っている", () => {
    // 4段のうち1段しか渡せないことを黙ると、呼んだ側は
    // 「指摘が0件だった」と読む（本当は照合をしていないだけ）
    const result = factContradictionPrompt({ folder: WORK, numCtx: NUM_CTX });
    expect(result.note).toContain("事実");
    expect(result.note).toContain("novel.run");
  });

  it("人物の対応表を渡している（id で揃えないと主語が割れる）", () => {
    const result = factContradictionPrompt({ folder: WORK, numCtx: NUM_CTX });
    expect(result.knownCharacters).toBeGreaterThan(0);
    expect(result.chunks[0].userPrompt).toContain("char_");
  });

  it("filePath を渡せば、その話だけに絞れる", () => {
    const result = factContradictionPrompt({
      folder: WORK,
      filePath: "本文/004_ギプスが外れた日.txt",
      numCtx: NUM_CTX,
    });
    for (const chunk of result.chunks) {
      expect(chunk.chunkId).toContain("004_ギプスが外れた日.txt");
    }
  });

  it("numCtx が無ければ、束ねた入口が名前を挙げて断る", () => {
    expect(() =>
      novelPrompt({ folder: WORK, feature: "factContradiction" })
    ).toThrow(/numCtx/);
  });
});

describe("事実の照合——1チャンクぶんの検算", () => {
  const prompt = factContradictionPrompt({ folder: WORK, numCtx: NUM_CTX });
  const first = prompt.chunks[0];

  it("prompt が返した chunkId で、事実を受け取れる", () => {
    const result = factContradictionValidate({
      folder: WORK,
      chunkId: first.chunkId,
      response: JSON.stringify({
        facts: [
          {
            line_start: 1,
            line_end: 1,
            subject: "char_0001",
            predicate: "所在",
            value: "坂の上",
            kind: "state",
            story_time: null,
            modality: "narration",
            pov: null,
            speaker: null,
            topic: null,
          },
        ],
      }),
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].predicate).toBe("所在");
    // **矛盾ではないと断る**（照合には作品ぜんたいの事実が要る）
    expect(result.note).toContain("矛盾ではありません");
  });

  it("**AIの出力を信用しない**——本文に無い行は弾く", () => {
    const result = factContradictionValidate({
      folder: WORK,
      chunkId: first.chunkId,
      response: JSON.stringify({
        facts: [
          {
            line_start: 99999,
            line_end: 99999,
            subject: "char_0001",
            predicate: "所在",
            value: "坂の上",
            kind: "state",
            story_time: null,
            modality: "narration",
            pov: null,
            speaker: null,
            topic: null,
          },
        ],
      }),
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("line_out_of_range");
  });

  it("読み取れない応答は、その場で断る（黙って0件にしない）", () => {
    expect(() =>
      factContradictionValidate({
        folder: WORK,
        chunkId: first.chunkId,
        response: "すみません、分かりません",
      })
    ).toThrow(/読み取れません/);
  });
});

describe("事実の照合——回す", () => {
  it("runner を省略できない（既定で埋めない）", async () => {
    await expect(
      novelRun({
        folder: WORK,
        feature: "factContradiction",
        numCtx: NUM_CTX,
      })
    ).rejects.toThrow(/runner/);
  });

  it("runner が ollama なら model が要る", async () => {
    await expect(
      factContradictionRun({
        folder: WORK,
        numCtx: NUM_CTX,
        runner: "ollama",
      })
    ).rejects.toThrow(/model/);
  });

  it("claude へは、抽出のプロンプトと**1段しか渡せない断り**を返す", async () => {
    const outcome = await factContradictionRun({
      folder: WORK,
      numCtx: NUM_CTX,
      runner: "claude",
    });
    expect(outcome.runner).toBe("claude");
    if (outcome.runner !== "claude") return;
    expect(outcome.chunks.length).toBeGreaterThan(0);
    expect(outcome.validateWith).toBe(
      "novel.validate（feature: factContradiction）"
    );
    expect(outcome.note).toContain("novel.run");
  });
});
