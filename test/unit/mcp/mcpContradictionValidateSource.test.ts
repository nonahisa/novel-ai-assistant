import { describe, expect, test, vi } from "vitest";
import nodePath from "node:path";

/**
 * MCP の矛盾検知の検算にも、出どころを渡す（母艦の判断 2026-10-26「拡張機能と揃える」）。
 *
 * 0.112.3 で拡張機能（`features/checkContradictions.ts`）は検算
 * `validateContradictions` に `{ source }` を渡すようになった（あとの話から来た台詞を、
 * 「地の文との矛盾ではない」だけで落とさない。`keepsFutureSpeechDenial`）。
 * MCP の道には「あとで判明する事実」の段が無いので、指摘はすべて本命（settled）から来る。
 * **省いたときの既定に頼らず、確かめの段（`source: "settled"`）と同じく明示して渡す**——
 * 将来 future の段を足したとき、渡し忘れが静かに残らないように。
 */

const calls: unknown[][] = [];

vi.mock("../../../src/core/contradictionValidation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/contradictionValidation")>();
  return {
    ...actual,
    validateContradictions: (...args: Parameters<typeof actual.validateContradictions>) => {
      calls.push(args);
      return actual.validateContradictions(...args);
    },
  };
});

import { contradictionPrompt, contradictionValidate } from "../../../src/mcp/tools/contradiction";

const FIXTURE = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const EPISODE = "本文/004_よあけ.txt";

describe("MCP の検算の出どころ", () => {
  test("novel.validate の検算へ、本命（settled）と明示して渡す", () => {
    const { chunkId } = contradictionPrompt({ folder: FIXTURE, filePath: EPISODE, numCtx: 16384 })
      .chunks[0];
    calls.length = 0;
    contradictionValidate({
      folder: FIXTURE,
      chunkId,
      response: JSON.stringify({ contradictions: [] }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual({ source: "settled" });
  });
});
