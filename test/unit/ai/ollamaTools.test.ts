import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OllamaProvider } from "../../../src/ai/ollamaProvider";
import { workspace } from "../support/vscodeStub";

/**
 * 道具（tool）を Ollama へ渡す口と、道具だけが返ったときの受け。
 *
 * ## なぜ道具として渡すのか
 *
 * `perspective_taking` と `joint_attention` は、いまプロンプト本文へ
 * べた書きしてある（`prompts/contradictionCheck.ts`）。本文の段は
 * **書かせる場**だが、道具として渡すと**説明がモデルの道具一覧に常在する**
 * ——別プロジェクト（`familiar-ai`）の実測では、**呼ばれなくても**それだけで
 * 答えの質が上がった（unused-tool 効果）。
 *
 * ## ここで固めること
 *
 * 1. 渡さなければ、これまでどおり `tools` を送らない（**空配列も送らない**）
 * 2. 渡せば `tools` に載る（`format` と同時に送れることは素の Ollama で確認済み）
 * 3. 道具だけが返った手番を「空の応答」で落とさず、**1往復だけ**受ける
 * 4. **往復は1回まで。** 2回目も道具だけなら打ち切って、何が起きたかを言う
 */

const params = {
  systemPrompt: "指示",
  userPrompt: "本文",
  model: "test-model",
  temperature: 0.0,
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "perspective_taking",
      description: "Perspective-taking (Theory of Mind).",
      parameters: {
        type: "object",
        properties: { who: { type: "string" }, asThem: { type: "string" } },
        required: ["who", "asThem"],
      },
    },
  },
] as const;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** 普通に本文が返る応答 */
function textReply(content: string): unknown {
  return {
    message: { content },
    done_reason: "stop",
    prompt_eval_count: 10,
    eval_count: 5,
  };
}

/** 道具だけを呼んだ手番（**本文は空になる**） */
function toolReply(name: string, args: Record<string, unknown>): unknown {
  return {
    message: { content: "", tool_calls: [{ function: { name, arguments: args } }] },
    done_reason: "stop",
    prompt_eval_count: 10,
    eval_count: 5,
  };
}

/**
 * 応答を順に返す `fetch` を立てて、送信本文を溜める。
 *
 * モデルの問い合わせ（`/api/show`）は生成ではないので数えない。
 */
function stubFetch(replies: unknown[]): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  let turn = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/show")) {
        return jsonResponse({ model_info: { "test.context_length": 131_072 } });
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const reply = replies[Math.min(turn, replies.length - 1)];
      turn++;
      return jsonResponse(reply);
    })
  );
  return bodies;
}

describe("Ollamaへ道具（tools）を渡す", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("渡さなければ、これまでどおり tools を送らない", async () => {
    const bodies = stubFetch([textReply("{}")]);

    await new OllamaProvider().generate(params);

    expect(bodies[0].tools).toBeUndefined();
  });

  test("渡せば tools に載る（形の強制と同時に送れる）", async () => {
    const bodies = stubFetch([textReply("{}")]);

    await new OllamaProvider().generate({
      ...params,
      tools: TOOLS,
      jsonSchema: { type: "object" },
    });

    expect(bodies[0].tools).toEqual(TOOLS);
    // **同時に送れることが要点である。** どちらかを落とすと、
    // 道具を渡した途端に応答がJSONでなくなる
    expect(bodies[0].format).toEqual({ type: "object" });
  });

  test("空の配列は送らない（渡し忘れと区別が付かない送り方をしない）", async () => {
    const bodies = stubFetch([textReply("{}")]);

    await new OllamaProvider().generate({ ...params, tools: [] });

    expect(bodies[0].tools).toBeUndefined();
  });
});

describe("道具だけが返ったときの受け（1往復）", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("受け口を渡せば、道具に返事をしてもう一度書かせる", async () => {
    const bodies = stubFetch([
      toolReply("perspective_taking", { who: "灯", asThem: "俺は腕を折っている" }),
      textReply('{"contradictions":[]}'),
    ]);

    const result = await new OllamaProvider().generate({
      ...params,
      tools: TOOLS,
      onToolCall: (call) => `受け取りました：${String(call.arguments.asThem)}`,
    });

    // 2回目の本文を使う（道具の手番は本文が空なので、そのままでは落ちる）
    expect(result.text).toBe('{"contradictions":[]}');
    expect(bodies).toHaveLength(2);

    /*
      **2回目は道具を渡さない**（実測、2026-09-24）。`qwen3.8-27b-cc` は
      返事を受け取っても呼び続け、答え付きの台が全5チャンク失敗した。
      `tool_choice: "none"` は素の Ollama で無視されるので、道具そのものを外す。
    */
    expect(bodies[0].tools).toEqual(TOOLS);
    expect(bodies[1].tools).toBeUndefined();

    // 2回目の会話には、モデルの手番と道具への返事がこの順で入っている
    const messages = bodies[1].messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(4);
    expect(messages[2].role).toBe("assistant");
    expect(messages[3]).toMatchObject({
      role: "tool",
      tool_name: "perspective_taking",
      content: "受け取りました：俺は腕を折っている",
    });

    // 送った量は2回ぶんを足して記録する（実際に2回呼んでいる）
    expect(result.usage?.inputTokens).toBe(20);
    expect(result.usage?.outputTokens).toBe(10);
  });

  test("受け口が無ければ往復しない（従来どおり空の応答として失敗する）", async () => {
    const bodies = stubFetch([
      toolReply("perspective_taking", { who: "灯", asThem: "俺は腕を折っている" }),
      textReply('{"contradictions":[]}'),
    ]);

    await expect(
      new OllamaProvider().generate({ ...params, tools: TOOLS })
    ).rejects.toThrow("空の応答");

    // **渡すかどうかで測り分けられることが要点。** 受けを渡していないのに
    // 勝手に往復すると、「定義を置くだけ」の測定ができなくなる
    expect(bodies).toHaveLength(1);
  });

  test("道具を外しても本文が空なら、理由を残して失敗する", async () => {
    // 道具を渡していない2回目まで空なのは、道具とは別の不調である。
    // **黙って空を返さない**（CLAUDE.md 規則5）
    const bodies = stubFetch([
      toolReply("joint_attention", { target: "折れた腕" }),
      textReply("   "),
      textReply("ここまで来てはいけない"),
    ]);

    await expect(
      new OllamaProvider().generate({
        ...params,
        tools: TOOLS,
        onToolCall: () => "受け取りました",
      })
    ).rejects.toThrow("投げ直しましたが、本文が返りませんでした");

    // 3回目は投げない（往復は1回まで）
    expect(bodies).toHaveLength(2);
  });

  test("本文が返っていれば、道具を呼んでいても往復しない", async () => {
    const bodies = stubFetch([
      {
        message: {
          content: '{"contradictions":[]}',
          tool_calls: [{ function: { name: "joint_attention", arguments: {} } }],
        },
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 5,
      },
      textReply("二度目は要らない"),
    ]);

    const result = await new OllamaProvider().generate({
      ...params,
      tools: TOOLS,
      onToolCall: () => "受け取りました",
    });

    expect(result.text).toBe('{"contradictions":[]}');
    expect(bodies).toHaveLength(1);
  });
});
