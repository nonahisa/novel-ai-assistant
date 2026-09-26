import { beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";

/**
 * 外から呼ぶ矛盾検知（P-12）が、製品（`features/checkContradictions.ts`）と同じ道を
 * 通るか（2026-09-26、作者の裁定「MCP の矛盾検知を製品と同じ道に揃える」）。
 *
 * **製品の経路を迂回した測定は、製品に無い不具合を見つけたことになる**
 * （CLAUDE.md の「繰り返し起きた失敗」5番）。MCP の `novel.run`／`novel.prompt` は
 * 次の2つで製品と違っていた。
 *
 *   1. **過去の場面の抜粋**（設計書6.74）：製品は前の話の関連場面を渡すのに、
 *      MCP は渡していなかった
 *   2. **検証の段**（P-12b、設計書6.10.5）：製品は見つけた指摘を1件ずつ問い直し、
 *      取り下げたものを出さない。MCP は検算だけで返していた
 *
 * 逸脱の 0.89.25（`mcpDeviationParity.test.ts`）と同じく、組み立てを
 * `core/contradictionAssembly.ts` へ寄せ、両方がそこを通ることを押さえる。
 */

const verifyReplies: string[] = [];
const asked: Array<{ systemPrompt: string; userPrompt: string }> = [];

vi.mock("../../../src/mcp/tools/ollama", () => ({
  ollamaGenerate: vi.fn(async (params: { systemPrompt: string; userPrompt: string }) => {
    asked.push({ systemPrompt: params.systemPrompt, userPrompt: params.userPrompt });
    if (params.systemPrompt === VERIFY_SYSTEM_PROMPT) {
      return { text: verifyReplies.shift() ?? "", model: "test" };
    }
    // 本文を読む段：本文の「少年は窓を開けた」の行を指す指摘を1件返す
    const line = /(\d+): 　まず最初に、少年は窓を開けた。/u.exec(params.userPrompt)?.[1];
    return {
      text: JSON.stringify({
        perspective_taking: [],
        joint_attention: [],
        contradictions: [
          {
            line: Number(line),
            excerpt: "少年は窓を開けた",
            category: "状態",
            settingSays: "少年は港町の防波堤で父の船を待ち続けている",
            textSays: "少年は家で窓を開けている",
            note: "",
            severity: "low",
            confidence: "medium",
          },
        ],
      }),
      model: "test",
    };
  }),
}));

import { CONTRADICTION_VERIFY_SYSTEM_PROMPT } from "../../../src/prompts/contradictionVerify";
import { contradictionPrompt, contradictionRun } from "../../../src/mcp/tools/contradiction";
import { chunkFromId, chunksOfWorkFile } from "../../../src/mcp/tools/shared";
import { excerptSourcesOfEpisode } from "../../../src/core/excerptSourceOf";
import { parseEpisodeFileName } from "../../../src/core/episodeParser";
import {
  buildContradictionPastSceneIndex,
  buildContradictionVerifyUserPrompt,
  selectContradictionPastScenes,
} from "../../../src/core/contradictionAssembly";
import { pastSceneMaxChars } from "../../../src/core/pastSceneSelect";

const VERIFY_SYSTEM_PROMPT = CONTRADICTION_VERIFY_SYSTEM_PROMPT;
const FIXTURE = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const EPISODE = "本文/004_よあけ.txt";
const NUM_CTX = 16384;

beforeEach(() => {
  verifyReplies.length = 0;
  asked.length = 0;
});

describe("過去の場面の抜粋（設計書6.74）", () => {
  test("第4話には、前の話（合本の第1〜3話）の関連場面を渡す", () => {
    const built = contradictionPrompt({ folder: FIXTURE, filePath: EPISODE, numCtx: NUM_CTX });
    const prompt = built.chunks[0].userPrompt;
    expect(prompt).toContain("【過去の場面の抜粋】");
    // 「少年」で引ける前の話の本文
    expect(prompt).toContain("少年は防波堤の先に立っていた");
  });

  test("抜粋は、製品と同じ core の関数で組んだものと1文字も違わない", () => {
    // 製品の `loadExcerptSources` は1ファイルごとに `excerptSourcesOfEpisode` を通す。
    // ここでは同じ関数で本文を割り、同じ関数で索引を組み・引く
    const bodyDir = nodePath.join(FIXTURE, "本文");
    const sources = fs
      .readdirSync(bodyDir)
      .sort((a, b) => a.localeCompare(b, "ja"))
      .flatMap((fileName) => {
        const parsed = parseEpisodeFileName(fileName);
        return excerptSourcesOfEpisode(
          {
            filePath: nodePath.join("本文", fileName),
            fileName,
            metaTitle: null,
            subtitle: parsed.subtitle,
            kind: parsed.kind,
            chapterStart: parsed.chapterStart,
            chapterEnd: parsed.chapterEnd,
          },
          fs.readFileSync(nodePath.join(bodyDir, fileName), "utf8")
        );
      });
    const { chunks } = chunksOfWorkFile(FIXTURE, EPISODE, NUM_CTX);
    const index = buildContradictionPastSceneIndex(
      sources,
      chunks.map((chunk) => chunk.chapterStart)
    );
    const expected = selectContradictionPastScenes(
      index,
      chunks[0],
      ["少年"],
      pastSceneMaxChars(NUM_CTX)
    ).text;

    expect(expected).not.toBe("");
    const built = contradictionPrompt({ folder: FIXTURE, filePath: EPISODE, numCtx: NUM_CTX });
    expect(built.chunks[0].userPrompt).toContain(expected);
  });

  test("製品も同じ core の関数を通している（写しを持たない）", () => {
    const product = fs.readFileSync(
      nodePath.join(__dirname, "..", "..", "..", "src", "features", "checkContradictions.ts"),
      "utf8"
    );
    for (const name of [
      "buildContradictionPastSceneIndex(",
      "selectContradictionPastScenes(",
      "buildContradictionVerifyUserPrompt(",
      "describeKnownAt(",
    ]) {
      expect(product, name).toContain(name);
    }
    // 前に製品の中にあった組み立ての写しが、戻ってきていないこと
    expect(product).not.toContain("buildContradictionVerifyPrompt(");
    expect(product).not.toContain(".selectWithDetail(");
  });
});

describe("検証の段（P-12b、設計書6.10.5）", () => {
  test("ollama で回すと、見つけた指摘を1件ずつ問い直し、却下を出さない", async () => {
    verifyReplies.push(
      JSON.stringify({
        verdict: "却下",
        reason: "そもそも食い違っていない",
        explanation: "家で窓を開けても、船を待っていることと両立する",
        confidence: "high",
      })
    );
    const outcome = await contradictionRun({
      folder: FIXTURE,
      filePath: EPISODE,
      numCtx: NUM_CTX,
      runner: "ollama",
      model: "gemma4:e4b",
    });
    if (outcome.runner !== "ollama") throw new Error("ollama の結果ではない");

    // 本文を読む段 1回 ＋ 検証 1回
    expect(asked.map((entry) => entry.systemPrompt === VERIFY_SYSTEM_PROMPT)).toEqual([
      false,
      true,
    ]);
    expect(outcome.results[0].accepted).toEqual([]);
    expect(outcome.results[0].verifyRejected).toEqual([
      {
        excerpt: "少年は窓を開けた",
        reason: "そもそも食い違っていない",
        explanation: "家で窓を開けても、船を待っていることと両立する",
      },
    ]);
    expect(outcome.verifyNote).not.toBe("");
  });

  test("検証のプロンプトは、製品と同じ関数で組んだものそのもの", async () => {
    verifyReplies.push(
      JSON.stringify({
        verdict: "採用",
        reason: "",
        explanation: "防波堤に居るはずの場面で家に居る",
        confidence: "medium",
      })
    );
    const outcome = await contradictionRun({
      folder: FIXTURE,
      filePath: EPISODE,
      numCtx: NUM_CTX,
      runner: "ollama",
      model: "gemma4:e4b",
    });
    if (outcome.runner !== "ollama") throw new Error("ollama の結果ではない");

    const kept = outcome.results[0].accepted;
    expect(kept).toHaveLength(1);
    // 検証で分かったことは補足へ足す（製品と同じ）
    expect(kept[0].note).toContain("検証: 防波堤に居るはずの場面で家に居る");

    const chunkId = outcome.results[0].chunkId;
    const expected = buildContradictionVerifyUserPrompt({
      chapterLabel: outcome.results[0].chapterLabel,
      chunk: chunkFromId(FIXTURE, chunkId),
      issue: { ...kept[0], note: "" },
      settingKnownAt: "",
    });
    expect(asked[1].userPrompt).toBe(expected);
  });

  test("検証の答えが読めなければ、指摘は消さずに通す（製品と同じ）", async () => {
    verifyReplies.push("読めない答え");
    const outcome = await contradictionRun({
      folder: FIXTURE,
      filePath: EPISODE,
      numCtx: NUM_CTX,
      runner: "ollama",
      model: "gemma4:e4b",
    });
    if (outcome.runner !== "ollama") throw new Error("ollama の結果ではない");
    expect(outcome.results[0].accepted).toHaveLength(1);
  });

  test("claude の道では検証を通せないことを黙らない", async () => {
    const outcome = await contradictionRun({
      folder: FIXTURE,
      filePath: EPISODE,
      numCtx: NUM_CTX,
      runner: "claude",
    });
    expect(outcome.verifyNote).toContain("検証の段");
    expect(outcome.note).toContain("検証の段");
    // AIは呼んでいない
    expect(asked).toEqual([]);
  });
});
