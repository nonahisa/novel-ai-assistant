import { z } from "zod";
import { describeError } from "./shared";

/**
 * `run` ツールの返し方（設計書6.87.8 の5・6）。
 *
 * **`runner` に既定を作らない。** `ollama` なら原稿はこの機械から出ないが、
 * `claude` は本文が Anthropic へ渡る。どちらも一長一短で、選ぶのは作者である。
 *
 * **`ollama` のときは検算まで通した結果しか返さない。** プロンプトだけ呼んで
 * `validate` を通さない使い方は、**製品に無い不具合を見つけたことになる**
 * （CLAUDE.md の「繰り返し起きた失敗」5番）。
 */

/** `validate` へ戻してもらうときの決まり文句。ツールの説明にも出す */
export const VALIDATE_NOTE =
  "検算（validate）を通していない結果は、製品の結果ではありません。";

export function claudeNote(validateWith: string): string {
  return `プロンプトだけを返しました。AIの応答は ${validateWith} へ戻してください。${VALIDATE_NOTE}`;
}

/** `validate` に渡す応答。**文字列のまま受ける**（製品の解析器へ通すため） */
export function responseInput() {
  return z
    .string()
    .describe(`AIの応答（JSONの文字列）。${VALIDATE_NOTE}`);
}

export function chunkIdInput() {
  return z
    .string()
    .describe("`prompt` か `run` が返した chunkId。そのまま渡してください");
}

export interface ClaudeRunResult<P> {
  runner: "claude";
  note: string;
  systemPrompt: string;
  schema: unknown;
  validateWith: string;
  chunks: P[];
}

export interface OllamaRunResult<R> {
  runner: "ollama";
  note: string;
  model: string;
  results: R[];
  /** 失敗したチャンク。**黙って飛ばさない**（件数だけでは何も分からない） */
  failures: Array<{ chunkId: string; reason: string }>;
}

export type RunOutcome<P, R> = ClaudeRunResult<P> | OllamaRunResult<R>;

/**
 * チャンクごとに回す。
 *
 * **1つ失敗しても全体を止めない**（CLAUDE.md の実装スタイル）。理由を
 * 残して次へ進み、最後にまとめて返す。
 */
export async function runChunks<P extends { chunkId: string }, R>(
  model: string,
  items: readonly P[],
  ask: (item: P) => Promise<R>
): Promise<OllamaRunResult<R>> {
  const results: R[] = [];
  const failures: Array<{ chunkId: string; reason: string }> = [];
  for (const item of items) {
    try {
      results.push(await ask(item));
    } catch (error) {
      failures.push({ chunkId: item.chunkId, reason: describeError(error) });
    }
  }
  return {
    runner: "ollama",
    note: `手元の Ollama で検算まで通しました（原稿はこの機械から出ていません）。${VALIDATE_NOTE}`,
    model,
    results,
    failures,
  };
}
