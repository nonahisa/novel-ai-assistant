import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { describe, expect, test } from "vitest";
import { runByRunner } from "../../../src/mcp/tools/run";
import { openChunkCache } from "../../../src/mcp/tools/chunkCacheFile";

/**
 * MCP の `novel.run`（runner ollama）で、同じ要素の繰り返しで途中止めした答えを
 * **控えに残し、次は聞き直さない**か（作者の裁定、2026-10-10。設計書6.77 の 15）。
 *
 * 同じ `chunks.json` を拡張機能も読むので（設計書6.87.17）、こちらで書いた
 * 控えにも途中止めの印が付いていなければならない。
 */

const PROMPTS = {
  systemPrompt: "s",
  schema: { type: "object" },
  temperature: 0,
  chunks: [{ chunkId: "c1", userPrompt: "u1" }],
};

const ANSWER = JSON.stringify({ issues: [{ line: 1, target: "いますい" }] });
const MARK = { reason: "repetition" as const, stoppedAt: 6, kept: 2 };

describe("途中止めの答えの控え（MCP）", () => {
  test("1回目の途中止めの答えを控え、2回目はAIを呼ばずに控えから返す", async () => {
    const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-stopped-"));
    try {
      let calls = 0;
      const cache = {
        folder,
        feature: "typo_check",
        promptVersion: "test",
        hashOf: (chunkId: string) => `hash-${chunkId}`,
        parse: (text: string) => JSON.parse(text) as unknown,
      };
      const run = () =>
        runByRunner(
          { runner: "ollama", model: "test-model", numCtx: 8192 },
          PROMPTS,
          "novel.validate（feature: typo）",
          (_chunkId, text) => JSON.parse(text) as unknown,
          async () => {
            calls += 1;
            return { text: ANSWER, truncated: false, stoppedEarly: MARK };
          },
          cache
        );

      const first = await run();
      expect(calls).toBe(1);
      expect(first).toMatchObject({ runner: "ollama", results: [JSON.parse(ANSWER)] });

      const store = openChunkCache(folder);
      await store.load();
      const keyBase = {
        feature: "typo_check",
        promptVersion: "test",
        providerId: "ollama",
        model: "test-model",
      };
      expect(store.get("hash-c1", keyBase)).toEqual(JSON.parse(ANSWER));
      // **途中止めだったことが控えから分かる**
      expect(store.stoppedEarlyOf("hash-c1", keyBase)).toEqual(MARK);

      const second = await run();
      expect(calls).toBe(1);
      expect(second).toMatchObject({ runner: "ollama", results: [JSON.parse(ANSWER)] });
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
