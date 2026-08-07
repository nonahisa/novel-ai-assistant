import { fileURLToPath } from "node:url";

export const SAKURA_AI_CHAT_COMPLETIONS_ENDPOINT =
  "https://api.ai.sakura.ad.jp/v1/chat/completions";
export const SAKURA_AI_SMOKE_MODEL = "gemma-4-31B-it";

export async function runSakuraAiSmoke({ token, fetchImpl = globalThis.fetch, log }) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("Sakura AI account token is required");
  }

  let response;
  try {
    response = await fetchImpl(SAKURA_AI_CHAT_COMPLETIONS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SAKURA_AI_SMOKE_MODEL,
        messages: [{ role: "user", content: "接続確認をお願いします。" }],
        temperature: 0,
        max_tokens: 32,
        stream: false,
      }),
    });
  } catch {
    throw new Error("Sakura AI smoke test failed: request failed");
  }

  if (!response.ok) {
    if (response.status !== 401 && response.status !== 429) {
      let body = "";
      try {
        const text = await response.text();
        body = typeof text === "string" ? text.trim() : "";
      } catch {
        body = "";
      }

      if (body) {
        const compact = body.replace(/\s+/g, " ").slice(0, 500);
        throw new Error(`Sakura AI smoke test failed: HTTP ${response.status}: ${compact}`);
      }
    }

    throw new Error(`Sakura AI smoke test failed: HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Sakura AI smoke test failed: invalid JSON response");
  }

  const model = payload?.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("Sakura AI smoke test failed: response model is missing");
  }
  if (model !== SAKURA_AI_SMOKE_MODEL) {
    throw new Error("Sakura AI smoke test failed: unexpected response model");
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Sakura AI smoke test failed: response content is blank");
  }

  const result = { model: SAKURA_AI_SMOKE_MODEL, contentLength: content.length };
  log?.(
    `Sakura AI smoke test passed: model=${SAKURA_AI_SMOKE_MODEL}, contentLength=${content.length}`
  );
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runSakuraAiSmoke({
    token: process.env.SAKURA_AI_ACCOUNT_TOKEN,
    log: (line) => console.log(line),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Sakura AI smoke test failed");
    process.exitCode = 1;
  });
}
