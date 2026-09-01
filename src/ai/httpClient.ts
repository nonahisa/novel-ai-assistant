import { timeoutDispatcher } from "./fetchTimeouts";
import { AIError } from "./types";

/**
 * クラウドAPIを叩くための共通部品。
 *
 * OpenAIとGeminiは公式SDKを入れずに素のfetchで呼ぶ。
 * 依存を増やすと配布前の `npm audit` の面倒が増えるうえ、
 * 使うのは「モデル一覧」と「1回生成」の2つだけで、
 * SDKの機能をほとんど使わないため。
 */

/**
 * `fetch` が投げた失敗が、**Node自身の待ち時間切れ**か。
 *
 * **`AbortError` だけがタイムアウトではない。** Nodeの `fetch`（undici）は
 * こちらの `AbortController` とは別に自前の待ち時間を持っており、そちらが
 * 切れると `TypeError: fetch failed` を投げる。名前が `AbortError` では
 * ないので、そのままでは「接続できない」（`not_running`）に落ちる。
 * **直し方が真逆になる**——起動を確かめても直らず、要るのは待ち時間を
 * 延ばすかチャンクを小さくすることである。
 *
 * 見るのは `cause.code`。**文言では判定しない**（0.28.4と同じ理由）。
 *
 * **既定でこれが起きる秒数は当てにしない。** 手元のNode 24では、応答を
 * 返さないサーバへ投げても6分待って切れなかった（2026-08-31に実測）。
 * 版や環境で変わるので、`fetch failed` を見たら`cause.code`で判ずる。
 */
/**
 * `fetch failed` の**中身**を、ログに残せる形にする。
 *
 * Nodeの `fetch` は失敗をすべて `TypeError: fetch failed` にまとめ、
 * **本当の理由は `cause` にしか無い**。`err.message` だけを残すと、
 * ログには「fetch failed」の5文字しか出ず、
 * 「Ollamaが落ちた」「接続が切れた」「時間切れ」の区別が付かない。
 *
 * **実際に困った**（作者のログ、2026-08-31 00:03）。抽出の9チャンク目が
 * 303秒で `種別: not_running / 詳細: fetch failed` になったが、8チャンク
 * 目まで通っているのでOllamaは動いていた。**符号が残っていないため、
 * 何が起きたのか後から判らない**（CLAUDE.md 規則5「エラーの本文を捨てない」）。
 */
export function describeFetchFailure(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } })?.cause;
  const message =
    error instanceof Error ? error.message : String(error ?? "不明な失敗");
  if (!cause) return message;
  const parts = [message];
  if (typeof cause.code === "string") parts.push(cause.code);
  if (typeof cause.message === "string" && cause.message !== message) {
    parts.push(cause.message);
  }
  return parts.join(" / ");
}

export function isFetchTimeout(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  return (
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

export interface JsonRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  /** エラーメッセージに出すサービス名（「ChatGPT」など） */
  label: string;
}

export async function fetchJson<T>(request: JsonRequest): Promise<T> {
  const controller = new AbortController();
  // 中止の理由で出すメッセージが変わる。作者が止めたのか、
  // 応答が遅すぎたのかで、次にすべきことが違うため。
  let abortSource: "caller" | "timeout" | undefined;
  const abort = (source: "caller" | "timeout") => {
    if (abortSource !== undefined) return;
    abortSource = source;
    controller.abort();
  };

  const timer = setTimeout(() => abort("timeout"), request.timeoutMs);
  const onExternalAbort = () => abort("caller");
  if (request.signal?.aborted) {
    onExternalAbort();
  } else {
    request.signal?.addEventListener("abort", onExternalAbort);
  }

  try {
    // **Nodeの通信部品にも、こちらの待ち時間を渡す**（設計書6.63）。
    // 渡さないと、応答ヘッダーを待つ上限（既定300秒）が先に効いてしまい、
    // 設定した待ち時間の出番が来ない
    const dispatcher = await timeoutDispatcher(request.timeoutMs);
    const response = await fetch(request.url, {
      method: request.method ?? (request.body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...(request.headers ?? {}),
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
      // 型には無い（Node独自の拡張）。ブラウザでは undefined になり無視される
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw toStatusError(
        response.status,
        detail,
        request.label,
        parseRetryAfterMs(response.headers.get("retry-after"), detail)
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new AIError(
        `${request.label}から形式が不正な応答が返りました。`,
        "bad_response"
      );
    }
  } catch (error) {
    if (error instanceof AIError) throw error;
    const err = error as Error;
    if (err.name === "AbortError") {
      if (abortSource === "caller") {
        throw new AIError("処理が中止されました。", "aborted");
      }
      throw new AIError(
        `${request.label}の応答がタイムアウトしました（${Math.round(
          request.timeoutMs / 1000
        )}秒）。設定でタイムアウトを延ばしてください。`,
        "timeout"
      );
    }
    // **Node自身の待ち時間切れは「接続できない」ではない**（isFetchTimeout）
    if (isFetchTimeout(error)) {
      throw new AIError(
        `${request.label}の応答がタイムアウトしました（Node側の上限）。` +
          "待ち時間を延ばすか、一度に送る量を減らしてください。",
        "timeout",
        describeFetchFailure(error)
      );
    }
    // 接続拒否・名前解決失敗はネットワーク側の問題とみなす
    throw new AIError(
      `${request.label}に接続できません。ネットワーク接続を確認してください。`,
      "not_running",
      describeFetchFailure(error)
    );
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * HTTPステータスを、UIが出し分けられる種別へ変換する。
 *
 * 種別ごとに `recoveryForAIError` が次の操作を1つ示すので、
 * 「エラーが出た」で終わらせず、必ずどれかに割り当てる。
 */
export function toStatusError(
  status: number,
  detail: string,
  label: string,
  retryAfterMs?: number
): AIError {
  const trimmed = detail.slice(0, 500);
  if (status === 401) {
    return new AIError(
      `${label}のAPIキーが正しくありません。再登録してください。`,
      "authentication_failed",
      trimmed,
      undefined,
      status
    );
  }
  if (status === 403) {
    return new AIError(
      `${label}のこのAPIキーには権限がありません（モデル未開放、または請求設定が未完了の可能性があります）。`,
      "permission_denied",
      trimmed,
      undefined,
      status
    );
  }
  if (status === 404) {
    return new AIError(
      `指定したモデルが見つかりません。`,
      "model_not_found",
      trimmed,
      undefined,
      status
    );
  }
  if (status === 429) {
    // OpenAIは残高切れも429で返す。待っても回復しないので分ける。
    // Geminiの無料枠上限は同じ文面でも待てば回復するため、
    // 明示的な insufficient_quota だけを残高切れとして扱う
    if (/insufficient_quota/i.test(detail)) {
      return new AIError(
        `${label}の残高が不足しています。請求設定を確認してください。`,
        "insufficient_credit",
        trimmed,
        undefined,
        status
      );
    }
    return new AIError(
      `${label}のレート上限に達しました。しばらく待ってから再実行してください。`,
      "rate_limited",
      trimmed,
      retryAfterMs,
      status
    );
  }
  if (status >= 500) {
    return new AIError(
      `${label}のサーバがエラーを返しました (HTTP ${status})。しばらく待ってから再実行してください。`,
      "bad_response",
      trimmed,
      undefined,
      status
    );
  }
  return new AIError(
    `${label}がエラーを返しました (HTTP ${status})。`,
    "bad_response",
    trimmed,
    undefined,
    status
  );
}

/**
 * 再試行までの待ち時間を読み取る。
 *
 * `Retry-After` ヘッダーが標準だが、Geminiは本文にしか入れてこない
 * （`"Please retry in 6.499650674s."` や `retryDelay: "6s"`）。
 * 無料枠は上限が低く、これを守って待てば続行できるため両方見る。
 */
export function parseRetryAfterMs(
  header: string | null,
  body: string
): number | undefined {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) {
      return Math.max(0, at - Date.now());
    }
  }

  const retryDelay = body.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
  if (retryDelay) return Number(retryDelay[1]) * 1000;

  const sentence = body.match(/retry in ([\d.]+)\s*s/i);
  if (sentence) return Number(sentence[1]) * 1000;

  return undefined;
}
