import { z } from "zod";
import { McpToolError, describeError } from "./shared";

/**
 * 手元の Ollama へ投げる（設計書6.87.8 の4）。
 *
 * **`num_ctx` を必ず明示する**（CLAUDE.md 規則6）。指定しないと既定の短い
 * コンテキストで動き、**入力が黙って切り捨てられる。** 128k対応のモデルでも
 * 同じで、切り捨てられたことは応答からは分からない。
 *
 * **`format` にスキーマを渡す**と形式が強制でき、パース失敗がほぼ無くなる。
 * **`think: false`** は、取り出すだけの仕事に思考モードが要らないため。
 *
 * **宛先が手元でなければ断る**（6.87.6 の2）。原稿が機械の外へ出るのは、
 * 作者が `allowRemote` で明示したときだけにする。
 */

export const DEFAULT_ENDPOINT = "http://localhost:11434";

/** 手元とみなす宛先。ここ以外は `allowRemote` が要る */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const OLLAMA_GENERATE_INPUT = {
  endpoint: z
    .string()
    .optional()
    .describe(`Ollama の場所。既定は ${DEFAULT_ENDPOINT}`),
  model: z.string().describe("モデル名（`ollama list` で出るもの）"),
  systemPrompt: z.string().describe("システムプロンプト"),
  userPrompt: z.string().describe("本文を含むプロンプト"),
  schema: z
    .unknown()
    .optional()
    .describe("応答のJSONスキーマ。渡すと形式が強制される（format）"),
  numCtx: z
    .number()
    .int()
    .positive()
    .describe("num_ctx。**省略できません**（既定値で動くと入力が黙って切れます）"),
  temperature: z
    .number()
    .optional()
    .describe("既定は 0.2（取り出す仕事なので揺らさない）"),
  allowRemote: z
    .boolean()
    .optional()
    .describe("手元以外の宛先へ本文を送ることを明示的に許す"),
};

export interface OllamaGenerateInput {
  endpoint?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schema?: unknown;
  numCtx: number;
  temperature?: number;
  allowRemote?: boolean;
}

/**
 * 宛先が手元か確かめる。
 *
 * **「手元でない」ときに止めるのであって、「外部だ」と当てにいくのではない。**
 * 読み取れない宛先も手元とはみなさない（安全側）。
 */
export function assertLocalOrAllowed(endpoint: string, allowRemote?: boolean) {
  if (allowRemote === true) return;
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new McpToolError(`Ollama の場所を読み取れません: ${endpoint}`);
  }
  if (LOCAL_HOSTS.has(host)) return;
  throw new McpToolError(
    `${endpoint} は手元ではありません。本文をそこへ送ってよければ allowRemote: true を付けてください` +
      "（手元の Ollama へ投げるかぎり、原稿はこの機械から出ません）"
  );
}

export interface OllamaGenerateResult {
  /** 応答の本文（スキーマを渡していればJSONの文字列） */
  text: string;
  model: string;
  endpoint: string;
  /** 何ミリ秒かかったか。遅いモデルを見分けるため */
  elapsedMs: number;
}

export async function ollamaGenerate(
  input: OllamaGenerateInput
): Promise<OllamaGenerateResult> {
  const endpoint = (input.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  assertLocalOrAllowed(endpoint, input.allowRemote);

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        stream: false,
        // 抽出の仕事に思考モードは要らない（遅くなるだけ）
        think: false,
        ...(input.schema === undefined ? {} : { format: input.schema }),
        options: {
          // **これを外さない。** 既定の短いコンテキストで動くと、
          // 入力が黙って切り捨てられる
          num_ctx: input.numCtx,
          temperature: input.temperature ?? 0.2,
        },
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      }),
    });
  } catch (error) {
    throw new McpToolError(
      `Ollama へ繋がりませんでした（${endpoint}）: ${describeError(error)}`
    );
  }

  if (!response.ok) {
    // **本文を捨てない**（CLAUDE.md 規則5）。原因はここにしか書かれていない
    const detail = await response.text().catch(() => "");
    throw new McpToolError(
      `Ollama がエラーを返しました（HTTP ${response.status}）: ${detail.slice(0, 500)}`
    );
  }

  const payload = (await response.json()) as {
    message?: { content?: unknown };
  };
  const content = payload.message?.content;
  if (typeof content !== "string") {
    throw new McpToolError("Ollama の応答に本文がありません。");
  }

  return {
    text: content,
    model: input.model,
    endpoint,
    elapsedMs: Date.now() - startedAt,
  };
}
