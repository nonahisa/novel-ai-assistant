import { describe, expect, test } from "vitest";
import {
  SAKURA_AI_CHAT_COMPLETIONS_ENDPOINT,
  SAKURA_AI_SMOKE_MODEL,
  runSakuraAiSmoke,
} from "../../scripts/sakuraAiSmoke.mjs";

const TOKEN = "uuid:secret";
const RESPONSE_CONTENT = "接続確認OK";

function createSuccessResponse(): Response {
  return new Response(
    JSON.stringify({
      model: "gemma-4-31B-it",
      choices: [{ message: { content: RESPONSE_CONTENT } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("Sakura AI smoke client", () => {
  test("OpenAI互換の成功応答からモデル名と本文文字数を返す", async () => {
    const result = await runSakuraAiSmoke({
      token: TOKEN,
      fetchImpl: async () => createSuccessResponse(),
    });

    expect(result).toEqual({ model: "gemma-4-31B-it", contentLength: 6 });
  });

  test("固定モデルとBearer認証を含む接続確認リクエストを送る", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;

    await runSakuraAiSmoke({
      token: TOKEN,
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return createSuccessResponse();
      },
    });

    expect(SAKURA_AI_CHAT_COMPLETIONS_ENDPOINT).toBe(
      "https://api.ai.sakura.ad.jp/v1/chat/completions"
    );
    expect(SAKURA_AI_SMOKE_MODEL).toBe("gemma-4-31B-it");
    expect(requestUrl).toBe("https://api.ai.sakura.ad.jp/v1/chat/completions");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(requestInit?.body));
    expect(body).toMatchObject({
      model: "gemma-4-31B-it",
      temperature: 0,
      max_tokens: 32,
      stream: false,
    });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ role: "user" });
    expect(body.messages[0].content).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });

  test("トークンがない場合はリクエストを送らずに失敗する", async () => {
    let fetchCalled = false;

    await expect(
      runSakuraAiSmoke({
        token: "",
        fetchImpl: async () => {
          fetchCalled = true;
          return createSuccessResponse();
        },
      })
    ).rejects.toThrow("Sakura AI account token is required");

    expect(fetchCalled).toBe(false);
  });

  test.each([401, 429])("HTTP %i の失敗はステータスだけを示す", async (status) => {
    const logs: string[] = [];

    const error = await runSakuraAiSmoke({
      token: TOKEN,
      fetchImpl: async () => new Response("credential or response secret", { status }),
      log: (line) => logs.push(line),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`Sakura AI smoke test failed: HTTP ${status}`);
    expect(logs).toEqual([]);
  });

  test("不正なJSON応答を拒否する", async () => {
    await expect(
      runSakuraAiSmoke({
        token: TOKEN,
        fetchImpl: async () => new Response("not json", { status: 200 }),
      })
    ).rejects.toThrow("Sakura AI smoke test failed: invalid JSON response");
  });

  test("モデル名がない応答を拒否する", async () => {
    await expect(
      runSakuraAiSmoke({
        token: TOKEN,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: RESPONSE_CONTENT } }] }),
            { status: 200 }
          ),
      })
    ).rejects.toThrow("Sakura AI smoke test failed: response model is missing");
  });

  test("空白だけの本文を拒否する", async () => {
    await expect(
      runSakuraAiSmoke({
        token: TOKEN,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              model: "gemma-4-31B-it",
              choices: [{ message: { content: "  \n" } }],
            }),
            { status: 200 }
          ),
      })
    ).rejects.toThrow("Sakura AI smoke test failed: response content is blank");
  });

  test("ログへトークンと応答本文を含めない", async () => {
    const logs: string[] = [];

    await runSakuraAiSmoke({
      token: TOKEN,
      fetchImpl: async () => createSuccessResponse(),
      log: (line) => logs.push(line),
    });

    expect(logs).toEqual([
      "Sakura AI smoke test passed: model=gemma-4-31B-it, contentLength=6",
    ]);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(RESPONSE_CONTENT);
  });
});
