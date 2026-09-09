/**
 * Node が内蔵する通信部品（undici）の待ち時間を、こちらの待ち時間へ揃える
 * （設計書6.63）。
 *
 * ## 何が起きていたか
 *
 * 作者のログ（2026-09-01）で、設定900秒・台帳600秒にしてあるのに
 * **302秒で `UND_ERR_HEADERS_TIMEOUT` が出た**。
 *
 * `node_modules/undici/lib/dispatcher/client.js` に
 * `headersTimeout ... : 300e3` とある——**応答ヘッダーを待つ上限が
 * 既定で300秒**である。Ollamaへは「まとめて1回で返す」形で頼んでいるので、
 * **ヘッダーは生成が全部終わってから届く**。生成が300秒を超えると、
 * こちらの `AbortController` の出番が来る前に undici が諦める。
 *
 * **こちらの設定は、出番が来る前に切られていた。** 0.29.1 で
 * 「`fetch failed` を『接続できない』で片づけない」と直したのは**分類だけ**で、
 * 原因はこれだった（あのときの実測はヘッダーが先に返る相手で試したため、
 * この経路を踏んでいなかった）。
 *
 * ## なぜ動的 import なのか
 *
 * `undici` は Node にしか無い。ブラウザ版（vscode.dev）では
 * **静的 import しただけで起動の瞬間に落ちる**（CLAUDE.md 規則7）。
 * `canRunProcesses()` で確かめてから `await import()` する。
 *
 * ブラウザの `fetch` にはこの制限が無いので、**渡せなくても実害は無い**。
 */
import { canRunProcesses } from "../core/runtime";

/** 作った待ち受け役を使い回す。毎回作ると接続が使い回されない */
const cache = new Map<number, unknown>();

/**
 * `fetch` へ渡す `dispatcher`。用意できなければ undefined（従来どおり）。
 *
 * **失敗しても黙って諦める。** ここが無くても通信そのものは成り立つ
 * （既定の300秒に戻るだけ）。取れないことを理由に、作者の操作を
 * 止めるほうが害が大きい。
 */
export async function timeoutDispatcher(
  timeoutMs: number
): Promise<unknown | undefined> {
  if (!canRunProcesses()) return undefined;
  const cached = cache.get(timeoutMs);
  if (cached) return cached;
  try {
    // **`.js` を付ける**（CLAUDE.md 規則7）。付けないと解決できない
    const undici = await import("undici");
    const agent = new undici.Agent({
      // ヘッダーが来るまでの上限。**ここが本題**
      headersTimeout: timeoutMs,
      // 本文が途切れてからの上限。ヘッダーだけ来て止まる相手にも効く
      bodyTimeout: timeoutMs,
    });
    cache.set(timeoutMs, agent);
    return agent;
  } catch {
    // undici を読み込めない環境（将来のNode、束ね方の変化）でも動き続ける
    return undefined;
  }
}

/** テストから、覚えた待ち受け役を捨てる */
export function clearDispatcherCache(): void {
  cache.clear();
}
