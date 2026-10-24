import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * sampling を頼む相手（＝いま繋いでいるクライアント）と、その宣言（設計書6.87.12）。
 *
 * **`sampling.ts` から切り出した。** 入力の形（`shared.ts` の `RUNNER_INPUT`）が
 * 断り文句を組むときに「相手が sampling に対応しているか」を見るため
 * （設計書6.87.15 の柱2の3）。`sampling.ts` は `shared.ts` を読むので、
 * そこから直接読むと読み込みが循環する。ここは何も読み込まない。
 *
 * **転送層が預ける。** ここから `server.ts` を参照すると読み込みが循環するので、
 * 向こうから預けてもらう形にする。
 */
let host: Server | undefined;

export function setSamplingHost(server: Server): void {
  host = server;
}

/** 試験から差し替えるための口。**本番では転送層しか呼ばない** */
export function clearSamplingHost(): void {
  host = undefined;
}

/** 頼む相手。預かっていなければ undefined */
export function samplingHost(): Server | undefined {
  return host;
}

/**
 * 相手が sampling に対応しているか。**3つの答えを持つ。**
 *
 * - `yes`：接続時に sampling を宣言した
 * - `no`：宣言を受け取ったが、sampling が無い（LM Studio など）
 * - `unknown`：相手を預かっていない、または宣言をまだ受け取っていない
 *
 * **分からないことを「対応していない」に畳まない。** 畳むと、繋ぐ前の
 * 呼び出しで、使える道を選択肢から消すことになる。
 */
export type SamplingSupport = "yes" | "no" | "unknown";

export function samplingSupport(): SamplingSupport {
  const capabilities = host?.getClientCapabilities();
  if (!capabilities) return "unknown";
  return capabilities.sampling ? "yes" : "no";
}
