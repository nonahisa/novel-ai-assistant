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
 *
 * ## 渡しただけでは届かなかった（2026-09-23）
 *
 * VS Code（1.138 で確認）は、拡張機能の中の `globalThis.fetch` を
 * `@vscode/proxy-agent` の `createFetchPatch` で差し替えている。証明書を
 * 足す設定（addCertificatesV1/V2、既定で入）が効いていると、差し替えた
 * fetch は `init.dispatcher` を**自分で作る新しい `undici.Agent` に置き換える**
 * ——こちらの `headersTimeout`/`bodyTimeout` は捨てられ、300秒に戻る。
 *
 * ノートPCの実測（VS Code 1.138.0、310秒黙る模擬サーバー、同じ Agent）：
 * `globalThis.fetch`＋Agent は306秒で `UND_ERR_HEADERS_TIMEOUT`、
 * **npm の `undici` の `fetch`＋同じ Agent は311秒で 200。**
 *
 * そこで口を2つに分ける。
 *
 * - **手元のAI（Ollama・LM Studio）は `localFetch`**：npm の undici の
 *   fetch を直接呼ぶ。VS Code のプロキシと社内証明書の対応は失うが、
 *   宛先は手元（localhost）なので困らない。CPUだけの機械では、応答の頭が
 *   300秒を越えるのはこちらである
 * - **クラウドのAIは `cloudFetch`**：`globalThis.fetch` のまま。プロキシと
 *   証明書を保つ。dispatcher も渡すが、差し替えのある VS Code では
 *   捨てられる（差し替えの無い環境——古い VS Code・MCPサーバー——でだけ効く）。
 *   クラウドの応答の頭は300秒を越えないので、いまは実害が無い
 */
import { canRunProcesses } from "../core/runtime";

/** 作った待ち受け役を使い回す。毎回作ると接続が使い回されない */
const cache = new Map<number, unknown>();

/** 型だけを取る（値の import は動的に行う。ブラウザ版で落ちるため） */
type UndiciModule = typeof import("undici");

/**
 * npm の undici を読み込む。ブラウザ版・読み込めない環境では undefined。
 *
 * **1回だけ読む。** 待ち受け役と fetch の両方がここを通るので、
 * 読み込みの失敗も1回で覚える（毎回投げ直させない）。
 */
let undiciLoading: Promise<UndiciModule | undefined> | undefined;
function loadUndici(): Promise<UndiciModule | undefined> {
  if (!canRunProcesses()) return Promise.resolve(undefined);
  undiciLoading ??= import("undici").catch(() => undefined);
  return undiciLoading;
}

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
    const undici = await loadUndici();
    if (!undici) return undefined;
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

/** `localFetch`・`cloudFetch` が受け取る形。`globalThis.fetch` と同じ */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 単体テストが手元の口を差し替えるための入れ物（`setLocalFetchForTests`） */
let localFetchForTests: FetchLike | undefined;

/**
 * **手元のAI（Ollama・LM Studio）へ投げる口。**
 *
 * npm の undici の `fetch` を、こちらの待ち時間で作った待ち受け役を付けて
 * 直接呼ぶ。`globalThis.fetch` は VS Code が差し替えており、渡した
 * 待ち受け役を捨てるため（冒頭の「渡しただけでは届かなかった」）。
 *
 * **ブラウザ版では `globalThis.fetch` へ落ちる。** undici が無く、
 * そもそもブラウザから手元のAIには届かないので実害は無い。
 *
 * 返す `Response` は undici のものだが、製品が使う読み方
 * （`ok`・`status`・`json()`・`text()`・`body.getReader()`）は同じに動く。
 */
export async function localFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const dispatcher = await timeoutDispatcher(timeoutMs);
  const withDispatcher = withTimeoutDispatcher(init, dispatcher);
  if (localFetchForTests) return localFetchForTests(url, withDispatcher);
  const undici = await loadUndici();
  if (!undici) return globalThis.fetch(url, withDispatcher);
  // 型は undici 独自の Request/Response だが、中身は WHATWG の fetch と同じ
  const response = await undici.fetch(
    url,
    withDispatcher as unknown as Parameters<UndiciModule["fetch"]>[1]
  );
  return response as unknown as Response;
}

/**
 * **クラウドのAIへ投げる口。** `globalThis.fetch` のまま投げる。
 *
 * VS Code の差し替えを通すので、**プロキシと社内証明書の対応を保つ**。
 * 待ち受け役も渡すが、差し替えのある VS Code では捨てられる
 * （差し替えの無い環境でだけ効く）。クラウドの応答の頭は300秒を越えない。
 */
export async function cloudFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const dispatcher = await timeoutDispatcher(timeoutMs);
  return globalThis.fetch(url, withTimeoutDispatcher(init, dispatcher));
}

/**
 * `dispatcher` は `RequestInit` の型には無い（Node 独自の拡張）。
 * 付け方を1か所にまとめる——呼ぶ側に書き散らすと、付け忘れが字面で見えない
 */
function withTimeoutDispatcher(init: RequestInit, dispatcher: unknown): RequestInit {
  return dispatcher ? ({ ...init, dispatcher } as RequestInit) : init;
}

/**
 * 単体テストから、手元の口の行き先を差し替える。`undefined` で製品の道へ戻す。
 *
 * **単体テストの下ごしらえ（`test/unit/support/setup.ts`）が
 * `globalThis.fetch` へ回している。** 手元のAIの試験の多くは
 * `vi.stubGlobal("fetch", …)` で応答を作っており、製品の道（undici）の
 * ままだと本物の通信へ出てしまうため。製品の道そのものは
 * `localFetchBypassesPatch.test.ts` が本物の HTTP サーバーで見る。
 */
export function setLocalFetchForTests(impl: FetchLike | undefined): void {
  localFetchForTests = impl;
}
