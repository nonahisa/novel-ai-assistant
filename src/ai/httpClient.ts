import { AIError } from "./types";

/**
 * クラウドAPIを叩くための共通部品。
 *
 * OpenAIとGeminiは公式SDKを入れずに素のfetchで呼ぶ。
 * 依存を増やすと配布前の `npm audit` の面倒が増えるうえ、
 * 使うのは「モデル一覧」と「1回生成」の2つだけで、
 * SDKの機能をほとんど使わないため。
 */

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
    const response = await fetch(request.url, {
      method: request.method ?? (request.body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...(request.headers ?? {}),
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    });

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
    // 接続拒否・名前解決失敗はネットワーク側の問題とみなす
    throw new AIError(
      `${request.label}に接続できません。ネットワーク接続を確認してください。`,
      "not_running",
      err.message
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
      trimmed
    );
  }
  if (status === 403) {
    return new AIError(
      `${label}のこのAPIキーには権限がありません（モデル未開放、または請求設定が未完了の可能性があります）。`,
      "permission_denied",
      trimmed
    );
  }
  if (status === 404) {
    return new AIError(
      `指定したモデルが見つかりません。`,
      "model_not_found",
      trimmed
    );
  }
  if (status === 429) {
    return new AIError(
      `${label}のレート上限に達しました。しばらく待ってから再実行してください。`,
      "rate_limited",
      trimmed,
      retryAfterMs
    );
  }
  if (status >= 500) {
    return new AIError(
      `${label}のサーバがエラーを返しました (HTTP ${status})。しばらく待ってから再実行してください。`,
      "bad_response",
      trimmed
    );
  }
  return new AIError(
    `${label}がエラーを返しました (HTTP ${status})。`,
    "bad_response",
    trimmed
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
