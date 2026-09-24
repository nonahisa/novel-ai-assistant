import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * `novel.run` の経路（MCP）にも、道具（tool）を渡す口と受けを持たせる。
 *
 * **ここが揃っていないと、測定が製品の結果にならない。** 道具の説明は
 * モデルの一覧に常在して、呼ばれなくても読まれる（unused-tool 効果）ので、
 * 渡す・渡さないでプロンプトそのものが変わる。
 *
 * 製品側（`ai/ollamaProvider.ts`）の受けは `test/unit/ai/ollamaTools.test.ts`
 * が見ている。ここで固めるのは**MCP の道も同じ振る舞いをすること**である。
 */

/** そのとき返す NDJSON（`localFetch` の差し替えが読む） */
let replies: string[] = [];
/** 送った本文（呼ばれた順） */
let sentBodies: Array<Record<string, unknown>> = [];

vi.mock("../../../src/ai/fetchTimeouts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/ai/fetchTimeouts")>();
  return {
    ...actual,
    localFetch: async (_url: string, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = replies[Math.min(sentBodies.length - 1, replies.length - 1)];
      return new Response(body, { status: 200 });
    },
  };
});

import { ollamaGenerate } from "../../../src/mcp/tools/ollama";

/** 本文だけを返す手番（流す形なので NDJSON の1行） */
function textLine(content: string): string {
  return `${JSON.stringify({ message: { content }, done: true })}\n`;
}

/** 道具だけを呼んだ手番（**本文は空になる**） */
function toolLine(name: string, args: Record<string, unknown>): string {
  return `${JSON.stringify({
    message: { content: "", tool_calls: [{ function: { name, arguments: args } }] },
    done: true,
  })}\n`;
}

const input = {
  model: "test-model",
  systemPrompt: "指示",
  userPrompt: "本文",
  numCtx: 8192,
  temperature: 0,
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "joint_attention",
      description: "Joint attention.",
      parameters: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
      },
    },
  },
];

afterEach(() => {
  replies = [];
  sentBodies = [];
});

describe("MCP の ollama.generate に道具を渡す", () => {
  test("渡さなければ tools を送らない", async () => {
    replies = [textLine("ok")];

    await ollamaGenerate(input);

    expect(sentBodies[0].tools).toBeUndefined();
  });

  test("渡せば tools に載る", async () => {
    replies = [textLine("ok")];

    await ollamaGenerate({ ...input, tools: TOOLS });

    expect(sentBodies[0].tools).toEqual(TOOLS);
  });

  test("道具だけが返ったら、1往復だけ受けてもう一度書かせる", async () => {
    replies = [
      toolLine("joint_attention", { target: "折れた腕" }),
      textLine('{"contradictions":[]}'),
    ];

    const result = await ollamaGenerate({
      ...input,
      tools: TOOLS,
      toolReply: (call) => `受け取りました：${String(call.arguments.target)}`,
    });

    expect(result.text).toBe('{"contradictions":[]}');
    expect(sentBodies).toHaveLength(2);
    // **2回目は道具を渡さない**（実測、2026-09-24。製品と同じ受け）。
    // 渡したままだと、呼び続けるモデル（qwen3.8-27b-cc）で必ず失敗する
    expect(sentBodies[0].tools).toEqual(TOOLS);
    expect(sentBodies[1].tools).toBeUndefined();
    const messages = sentBodies[1].messages as Array<Record<string, unknown>>;
    expect(messages[3]).toMatchObject({
      role: "tool",
      tool_name: "joint_attention",
      content: "受け取りました：折れた腕",
    });
  });

  test("受け答えを渡さなければ往復しない（従来どおり本文なしで止まる）", async () => {
    replies = [toolLine("joint_attention", { target: "折れた腕" }), textLine("ok")];

    await expect(ollamaGenerate({ ...input, tools: TOOLS })).rejects.toThrow(
      "本文がありません"
    );
    expect(sentBodies).toHaveLength(1);
  });

  test("道具を外しても本文が空なら、理由を残して失敗する", async () => {
    replies = [
      toolLine("joint_attention", { target: "折れた腕" }),
      textLine(""),
      textLine("ここまで来てはいけない"),
    ];

    await expect(
      ollamaGenerate({ ...input, tools: TOOLS, toolReply: () => "受け取りました" })
    ).rejects.toThrow("投げ直しましたが、本文が返りませんでした");
    expect(sentBodies).toHaveLength(2);
  });
});
