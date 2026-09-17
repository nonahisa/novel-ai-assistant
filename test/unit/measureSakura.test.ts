import { describe, expect, it } from "vitest";
import {
  SAKURA_TOKEN_ENV,
  askSakura,
  promptChunksOf,
  readSakuraToken,
  resultsOfValidated,
  runSakuraChunks,
  toOpenAIJsonSchema,
  validateArgsOf,
} from "../../scripts/measureSakura.mjs";
import { toOpenAIJsonSchema as productToOpenAIJsonSchema } from "../../src/ai/jsonSchema";
import { PROOFREAD_SCHEMA } from "../../src/prompts/proofread";

/*
  さくらのAI（クラウド）で測る道（`scripts/measure.mjs --runner sakura`）を、
  **本物のさくらへ繋がずに**確かめる。偽の fetch を渡せば、鍵の扱いも、
  `novel.validate` へ戻す形も、ここで見られる。

  確かめるのは3つ。
    ① 環境変数が無ければ止まる（作者に鍵を尋ねない）
    ② 鍵が記録にもログにも出ない
    ③ 応答を `novel.validate` へ渡す形が正しい
*/

/** 見分けやすい作り物の鍵。**本物は使わない** */
const FAKE_TOKEN = "sk-test-DO-NOT-USE-0123456789";

/** さくらの応答（OpenAI互換）を作る */
function chatResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: "preview/gemma-4-31B-it",
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
    text: async () => content,
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

describe("鍵の受け取り方", () => {
  it("環境変数が無ければ、測らずに止まる", () => {
    expect(() => readSakuraToken({})).toThrowError(new RegExp(SAKURA_TOKEN_ENV));
  });

  it("空白だけの環境変数も「無い」として扱う", () => {
    expect(() => readSakuraToken({ [SAKURA_TOKEN_ENV]: "   " })).toThrowError(
      new RegExp(SAKURA_TOKEN_ENV)
    );
  });

  it("あれば前後の空白を落として返す", () => {
    expect(readSakuraToken({ [SAKURA_TOKEN_ENV]: ` ${FAKE_TOKEN} ` })).toBe(
      FAKE_TOKEN
    );
  });

  it("断り文句に鍵の置き場所を書く（尋ねるのではなく、設定してもらう）", () => {
    let message = "";
    try {
      readSakuraToken({});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(SAKURA_TOKEN_ENV);
    expect(message).toContain("設定してください");
  });
});

describe("鍵が漏れないこと", () => {
  it("鍵は Authorization ヘッダにだけ載り、本文には入らない", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return chatResponse('{"issues":[]}');
    };

    await askSakura({
      token: FAKE_TOKEN,
      model: "preview/gemma-4-31B-it",
      systemPrompt: "あなたは校正者です。",
      userPrompt: "本文",
      schema: PROOFREAD_SCHEMA,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(seen).toHaveLength(1);
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    // 本文（送るJSON）には1文字も入らない
    expect(String(seen[0].init.body)).not.toContain(FAKE_TOKEN);
  });

  it("返り値にも、記録に残す欄にも鍵は入らない", async () => {
    const fetchImpl = async () => chatResponse('{"issues":[]}');
    const answered = await askSakura({
      token: FAKE_TOKEN,
      model: "preview/gemma-4-31B-it",
      systemPrompt: "s",
      userPrompt: "u",
      schema: PROOFREAD_SCHEMA,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(JSON.stringify(answered)).not.toContain(FAKE_TOKEN);
  });

  it("失敗の本文は残すが、そこにも鍵は入らない", async () => {
    // **本文は捨てない**（実装ルール5）。どの項目が悪いかはここにしか無い
    const fetchImpl = async () =>
      errorResponse(401, '{"error":{"message":"invalid token"}}');
    let message = "";
    try {
      await askSakura({
        token: FAKE_TOKEN,
        model: "preview/gemma-4-31B-it",
        systemPrompt: "s",
        userPrompt: "u",
        schema: PROOFREAD_SCHEMA,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("401");
    expect(message).toContain("invalid token");
    expect(message).not.toContain(FAKE_TOKEN);
  });

  it("画面へ出す1行にも、記録にも鍵は出ない（1チャンク落ちた回）", async () => {
    const logs: string[] = [];
    const outcome = await runSakuraChunks({
      promptResponse: {
        systemPrompt: "s",
        schema: PROOFREAD_SCHEMA,
        chunks: [
          { chunkId: "本文/001.txt#1-0@1400", userPrompt: "u1" },
          { chunkId: "本文/001.txt#1-1@1400", userPrompt: "u2" },
        ],
      },
      baseArgs: { folder: "C:/work", feature: "proofread" },
      ask: async ({ userPrompt }: { userPrompt: string }) => {
        if (userPrompt === "u1") throw new Error("さくらのAI HTTP 429: rate limited");
        return { text: '{"issues":[]}' };
      },
      validate: async () => ({ chunkId: "本文/001.txt#1-1@1400", accepted: [], rejected: [] }),
      log: (line: string) => logs.push(line),
    });

    // **1件の失敗で止めない**（実装ルール5）
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.results).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(FAKE_TOKEN);
  });
});

describe("さくらへ投げる形", () => {
  it("スキーマの直し方が製品（src/ai/jsonSchema.ts）と同じ", () => {
    // **写しを置いたまま片方だけ直る**のをここで止める
    expect(toOpenAIJsonSchema(PROOFREAD_SCHEMA)).toEqual(
      productToOpenAIJsonSchema(PROOFREAD_SCHEMA)
    );
  });

  it("断られた指定（response_format）だけを外して出し直す", async () => {
    const bodies: string[] = [];
    let call = 0;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      call += 1;
      if (call === 1) {
        return errorResponse(400, "response_format is not supported by this model");
      }
      return chatResponse('{"issues":[]}');
    };

    const answered = await askSakura({
      token: FAKE_TOKEN,
      model: "preview/gemma-4-31B-it",
      systemPrompt: "s",
      userPrompt: "u",
      schema: PROOFREAD_SCHEMA,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("response_format");
    expect(bodies[1]).not.toContain("response_format");
    expect(answered.droppedResponseFormat).toBe(true);
  });

  it("原因の分からない失敗では出し直さない（当てにいかない）", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return errorResponse(500, "internal error");
    };
    await expect(
      askSakura({
        token: FAKE_TOKEN,
        model: "preview/gemma-4-31B-it",
        systemPrompt: "s",
        userPrompt: "u",
        schema: PROOFREAD_SCHEMA,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow("500");
    expect(calls).toBe(1);
  });
});

describe("novel.validate へ渡す形", () => {
  it("検算に要る項目だけを渡す（numCtx・chunkIndex・model は渡さない）", () => {
    const args = validateArgsOf(
      {
        folder: "C:/work",
        feature: "proofread",
        filePath: "本文/001.txt",
        numCtx: 32768,
        chunkIndex: 0,
        model: "preview/gemma-4-31B-it",
        options: { categories: "light" },
      },
      { chunkId: "本文/001.txt#1-0@1400", response: '{"issues":[]}' }
    );

    expect(args).toEqual({
      folder: "C:/work",
      feature: "proofread",
      filePath: "本文/001.txt",
      options: { categories: "light" },
      chunkId: "本文/001.txt#1-0@1400",
      response: '{"issues":[]}',
    });
  });

  it("チャンクに切らない機能では chunkId を渡さない", () => {
    const args = validateArgsOf(
      { folder: "C:/work", feature: "deviation", filePath: "本文/001.txt" },
      { chunkId: null, response: '{"issues":[]}' }
    );
    expect(args.chunkId).toBeUndefined();
    expect(args.response).toBe('{"issues":[]}');
  });

  it("チャンクごとに投げ、chunkId をそのまま戻す", async () => {
    const validated: Array<Record<string, unknown>> = [];
    const outcome = await runSakuraChunks({
      promptResponse: {
        systemPrompt: "s",
        schema: PROOFREAD_SCHEMA,
        chunks: [
          { chunkId: "本文/001.txt#1-0@1400", userPrompt: "u1" },
          { chunkId: "本文/001.txt#1-1@1400", userPrompt: "u2" },
        ],
      },
      baseArgs: {
        folder: "C:/work",
        feature: "proofread",
        filePath: "本文/001.txt",
        numCtx: 32768,
      },
      ask: async () => ({ text: '{"issues":[]}' }),
      validate: async (args: Record<string, unknown>) => {
        validated.push(args);
        return { chunkId: args.chunkId, accepted: [], rejected: [] };
      },
    });

    expect(validated.map((args) => args.chunkId)).toEqual([
      "本文/001.txt#1-0@1400",
      "本文/001.txt#1-1@1400",
    ]);
    // 検算に要らない項目は混ぜない
    expect(validated[0].numCtx).toBeUndefined();
    expect(outcome.results).toHaveLength(2);
    expect(outcome.failures).toHaveLength(0);
  });

  it("話を丸ごと1回で見る機能は、userPrompt を1つ投げる", async () => {
    const chunks = promptChunksOf({ systemPrompt: "s", userPrompt: "まるごと" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkId).toBeNull();
    expect(chunks[0].userPrompt).toBe("まるごと");
  });

  it("chunks も userPrompt も無ければ止める（形が変わったと分かるように）", () => {
    expect(() => promptChunksOf({ systemPrompt: "s" })).toThrowError(
      /novel\.prompt/
    );
  });
});

describe("検算の返り値の数え方", () => {
  it("包まれていない結果（validate の返り値）も1件として数える", () => {
    // **`novel.run` と形が違う。** 包まれていないので、run 用の読み方だけでは
    // 何件出ても0件になる
    const results = resultsOfValidated(
      { chunkId: "本文/001.txt#1-0@1400", accepted: [{ reason: "漢字ひらき" }], rejected: [] },
      "本文/001.txt"
    );
    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe("本文/001.txt#1-0@1400");
    expect(results[0].accepted).toHaveLength(1);
  });

  it("chunkId を持たない結果には、呼んだ側のラベルを置く", () => {
    const results = resultsOfValidated({ accepted: [], rejected: [] }, "本文/001.txt");
    expect(results[0].chunkId).toBe("本文/001.txt");
  });
});
