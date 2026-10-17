/**
 * AIの口（Ollama・LM Studio・クラウド）へ立てる `fetch` の作り物が返す応答
 * （2026-10-17。単体テストの前準備の写しを寄せた）。
 *
 * ## なぜここにあるのか
 *
 * プロバイダの試験（`test/unit/ai/` ほか）は、`vi.stubGlobal("fetch", ...)` で
 * 応答を差し込む。その応答の組み立て（JSON の応答・流し受信の行・
 * Ollama のモデル情報）が、同じ形で何本ものファイルに写されていた。
 *
 * **写す前と同じ応答を返す。** JSON の応答には `Content-Type` を付け、
 * Ollama のモデル情報（`/api/show`）には付けない——写す前がそうだった。
 * 製品は `response.json()` で読むので見出しを見ないが、揃えると「作り物を
 * 本物より親切にした」ことになりうるので、元の形のまま分けてある。
 *
 * `fetch` の差し替えそのもの（どの URL に何を返すか・送った本文を溜めるか）は、
 * 試験ごとに確かめたいことが違うので、各ファイルに残してある。
 */

/** JSON の応答（`Content-Type: application/json`） */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Ollama の流し受信（`stream: true`）の本文。1行に1つの JSON を並べ、最後も改行で終える */
export function ndjson(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

/**
 * Ollama の `/api/show`（モデル情報）の応答。読める長さだけを持たせる。
 *
 * 項目名の前置き（`test.`）はアーキテクチャ名で、プロバイダ（`ollamaProvider.ts`）は
 * 前置きを決め打ちせずに `*.context_length` を探す（CLAUDE.md 規則6）。そのため架空の
 * 名前にしてある。前置きを本物の名前で見る道（MCP の `general.architecture` から引く道）の
 * 試験には使わない。
 */
export function ollamaShowResponse(contextLength = 131_072): Response {
  return new Response(
    JSON.stringify({ model_info: { "test.context_length": contextLength } }),
    { status: 200 }
  );
}
