import * as path from "path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { workScan } from "../../src/mcp/tools/workScan";
import {
  PROOFREAD_RUN_INPUT,
  proofreadPrompt,
  proofreadRun,
  proofreadValidate,
} from "../../src/mcp/tools/proofread";
import { contradictionMaterial } from "../../src/mcp/tools/contradiction";
import { foreshadowPrompt } from "../../src/mcp/tools/foreshadow";
import { ollamaGenerate } from "../../src/mcp/tools/ollama";

/**
 * 外から呼ぶ口（MCPのツール）を、**転送層を通さずに**確かめる（設計書6.87.8）。
 *
 * ツールの中身は `src/mcp/tools/*.ts` にあり、`server.ts` は配線だけなので、
 * ここではハンドラを直に呼ぶ。stdio を立てて確かめるのは
 * `scripts/smokeMcp.mjs`（あちらは束ができてからでないと走らない）。
 *
 * **本物の原稿は読まない。** 作り物のフォルダー（`test/fixtures/mcp-work`）
 * だけを相手にする。
 */
const WORK = path.join(__dirname, "..", "fixtures", "mcp-work");

/** 手元で使う想定のモデルと同じくらいの上限。チャンクの大きさはここから決まる */
const NUM_CTX = 32768;

describe("work.scan", () => {
  test("3話入りの合本と単話で、合わせて4話を返す", () => {
    const result = workScan({ folder: WORK });

    // ファイルは2つ、話は4つ（**合本を1件として返さない**）
    expect(result.fileCount).toBe(2);
    expect(result.episodes).toHaveLength(4);
    expect(result.episodes.map((episode) => episode.chapter)).toEqual([
      4, 1, 2, 3,
    ]);
    expect(result.episodes.map((episode) => episode.insideCollected)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    // 合本の中の話にはタイトルが付いている
    expect(result.episodes[1].title).toBe("灯");
    // 頭書き（【タイトル】【あらすじ】）は字数に入れない
    expect(result.episodes[1].chars).toBeGreaterThan(0);
    expect(result.episodes[1].chars).toBeLessThan(60);
    expect(result.skipped).toEqual([]);
  });

  test("作品フォルダーの外は読めない", () => {
    // `..` で外へ出る指定は断る（`core/pathText.ts` の `goesOutside`）。
    // **読めてしまうと、作者が渡していないファイルをAIへ送ることになる**
    expect(() =>
      proofreadPrompt({
        folder: WORK,
        filePath: path.join("..", "..", "..", "package.json"),
        numCtx: NUM_CTX,
      })
    ).toThrow(/作品フォルダーの外/);
  });
});

describe("proofread", () => {
  test("runner を省くとエラーになる（既定を作らない）", async () => {
    // 転送層は zod で弾く。**`runner` は必須**
    const shape = z.object(PROOFREAD_RUN_INPUT);
    const parsed = shape.safeParse({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    expect(parsed.success).toBe(false);

    // ハンドラを直に呼んでも、既定へ倒れずに止まる
    await expect(
      proofreadRun({
        folder: WORK,
        filePath: "本文/004_よあけ.txt",
        numCtx: NUM_CTX,
      } as unknown as Parameters<typeof proofreadRun>[0])
    ).rejects.toThrow(/runner/);
  });

  test("runner が claude なら、プロンプトと戻し先が返る（本文は投げない）", async () => {
    const result = await proofreadRun({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
      runner: "claude",
    });

    expect(result.runner).toBe("claude");
    if (result.runner !== "claude") throw new Error("claude のはず");
    expect(result.validateWith).toBe("proofread.validate");
    expect(result.systemPrompt.length).toBeGreaterThan(0);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].chunkId).toContain("004_よあけ.txt");
    // 本文が入っていること（行番号付き）
    expect(result.chunks[0].userPrompt).toContain("まず最初に");
  });

  test("文体メモを空のまま投げない（F-21）", () => {
    const result = proofreadPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    // `設定/plot.md` の人称と `設定/keep_words.json` の語が載る
    expect(result.narrativeStyle).toBe("三人称一元");
    expect(result.styleNote).toContain("掠れて");
    expect(result.chunks[0].userPrompt).toContain("掠れて");
  });

  test("本文に実在しない原文の指摘は、検算で落ちる", () => {
    const prompts = proofreadPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    const chunkId = prompts.chunks[0].chunkId;

    const response = JSON.stringify({
      issues: [
        {
          line: 2,
          original: "まず最初に",
          suggestion: "まず",
          reason: "冗長",
          explanation: "同じ意味が重なっている",
          confidence: "high",
        },
        {
          line: 2,
          original: "この言い回しは本文のどこにもない",
          suggestion: "なおす",
          reason: "冗長",
          explanation: "でっち上げ",
          confidence: "high",
        },
      ],
    });

    const result = proofreadValidate({ folder: WORK, chunkId, response });

    expect(result.accepted.map((issue) => issue.original)).toEqual([
      "まず最初に",
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("original_not_found");
  });

  test("作者が「直さない」と決めた語を含む指摘は出さない", () => {
    const prompts = proofreadPrompt({
      folder: WORK,
      filePath: "本文/collected.txt",
      numCtx: NUM_CTX,
    });
    const chunkId = prompts.chunks[prompts.chunks.length - 1].chunkId;
    const response = JSON.stringify({
      issues: [
        {
          line: 1,
          original: "掠れて読めなかった",
          suggestion: "かすれて読めなかった",
          reason: "漢字ひらき",
          explanation: "ひらがなにする",
          confidence: "high",
        },
      ],
    });

    const result = proofreadValidate({ folder: WORK, chunkId, response });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("kept_word");
  });

  test("chunkId の形が違えば、そこで止まる", () => {
    expect(() =>
      proofreadValidate({
        folder: WORK,
        chunkId: "本文/004_よあけ.txt",
        response: "{}",
      })
    ).toThrow(/chunkId/);
  });
});

describe("contradiction.material", () => {
  test("本文に出てくる人物だけを、その話の時点で返す", () => {
    const result = contradictionMaterial({
      folder: WORK,
      filePath: "本文/collected.txt",
      numCtx: NUM_CTX,
    });

    expect(result.settingsCount.people).toBe(1);
    const first = result.chunks[0];
    // 「少年」は本文に出てくるので、材料がある
    expect(first.hasAnything).toBe(true);
    expect(first.characterDetails).toContain("少年");
    // 第1話には、それより前のあらすじは無い
    expect(first.previousSynopses).toBe("");
    // 第2話以降には、前の話のあらすじが載る
    const second = result.chunks.find((chunk) => chunk.chapterLabel === "第2話");
    expect(second?.previousSynopses).toContain("第1話");
  });
});

describe("foreshadow.prompt", () => {
  test("張った話より前の本文には、回収の確認を掛けない", () => {
    const result = foreshadowPrompt({
      folder: WORK,
      filePath: "本文/collected.txt",
      numCtx: NUM_CTX,
      mode: "resolve",
    });

    expect(result.ledger.open).toBe(1);
    // 第1話（張った話）から後だけが対象。**張った箇所を「回収」と言わせない**
    for (const chunk of result.chunks) {
      expect(chunk.targetIds).toEqual(["foreshadow_0001"]);
    }
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  test("detect では台帳の名前を渡して、同じものを二度出させない", () => {
    const result = foreshadowPrompt({
      folder: WORK,
      filePath: "本文/004_よあけ.txt",
      numCtx: NUM_CTX,
    });
    expect(result.mode).toBe("detect");
    expect(result.chunks[0].userPrompt).toContain("帰らない父の船");
  });
});

describe("ollama.generate", () => {
  test("手元でない宛先は、allowRemote が無ければ断る（投げない）", async () => {
    await expect(
      ollamaGenerate({
        endpoint: "http://example.com:11434",
        model: "dummy",
        systemPrompt: "s",
        userPrompt: "u",
        numCtx: 4096,
      })
    ).rejects.toThrow(/allowRemote/);
  });
});
