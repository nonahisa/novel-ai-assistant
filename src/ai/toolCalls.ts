import type { AIToolCall } from "./types";

/**
 * モデルが呼んだ道具（tool）を扱う小さな部品。
 *
 * **ここは VS Code にも通信にも依存しない。** 製品の道（`ai/ollamaProvider.ts`）
 * と MCP の道（`mcp/tools/ollama.ts`）の**両方から同じものを通す**ためである。
 * 片方だけで組み立てると、測定と製品で道具の受け方が違ってしまい、
 * 「製品と同じ経路で測る」という前提が崩れる。
 */

/** 道具に返す既定の返事。受け手が文言を持たないときに使う */
export const TOOL_CALL_ACK = "了解しました。続けてください。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ollama が返した `tool_calls` を、こちらの形（`AIToolCall`）へ揃える。
 *
 * **形を検めすぎて捨てない。** 名前さえ取れれば受けられるので、引数が
 * 読めない呼び出しも「引数なし」として通す（AIの出力は信用しない一方で、
 * 使える情報まで落とさない）。
 */
export function normalizeToolCalls(raw: unknown): AIToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: AIToolCall[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : undefined;
    const name = typeof fn?.name === "string" ? fn.name : undefined;
    if (!name) continue;
    calls.push({ name, arguments: readArguments(fn?.arguments) });
  }
  return calls;
}

/**
 * 引数を読む。**Ollamaはオブジェクトで返す**が、OpenAI互換の口を真似て
 * JSON文字列で返す機種があるので、文字列なら解いてみる。
 */
function readArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // 解けなければ「引数なし」として扱う。ここで止めると、
      // 道具を呼んだだけで機能全体が落ちる
    }
  }
  return {};
}

/**
 * 道具の結果を返して**会話を続ける**ためのメッセージを組み立てる（Ollamaの形）。
 *
 * 呼ばれた側は、
 * 1. モデルが返した assistant のメッセージ（道具の呼び出しつき）を戻し、
 * 2. その直後に道具ごとの結果（`role: "tool"`）を並べる。
 *
 * この順を崩すと、モデルは「自分が何を呼んだのか」を見失う。
 */
export function toolFollowUpMessages(params: {
  /** モデルが返した `tool_calls`（**そのままの形**で戻す） */
  rawToolCalls: readonly unknown[];
  /** 揃えたあとの呼び出し。返事を作るのに使う */
  calls: readonly AIToolCall[];
  /** 道具ごとの返事。`undefined` を返したら既定の返事にする */
  reply: (call: AIToolCall) => string | undefined;
}): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [
    // 本文は空でよい（道具を呼んだだけの手番なので、中身は tool_calls にある）
    { role: "assistant", content: "", tool_calls: params.rawToolCalls },
  ];
  for (const call of params.calls) {
    messages.push({
      role: "tool",
      // 新しい Ollama は「どの道具への返事か」をこれで見る。
      // 知らない欄は無視されるだけなので、古い版へ送っても害は無い
      tool_name: call.name,
      content: params.reply(call) ?? TOOL_CALL_ACK,
    });
  }
  return messages;
}
