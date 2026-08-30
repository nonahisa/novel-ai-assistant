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
 * `fetch` が投げた失敗を、種別と手がかりに分ける（作者のログ、2026-08-29）。
 *
 * ## なぜ要るか
 *
 * Node の `fetch` は、どんな理由で失敗しても `TypeError: fetch failed` と
 * しか名乗らない。**理由は `cause` にだけ入っている。** 以前はここを見ずに
 * すべて `not_running`（AIが起動していない）に丸めていたので、実機のログに
 * こうなった。
 *
 *     15:26:05 AIへ送信: 1/9
 *     15:31:14 種別: not_running ／ 詳細: fetch failed
 *
 * **5分9秒も答えていたものを「起動していない」と言っていた。** 起動して
 * いなければ接続は即座に断られるし、その直前にモデル一覧も引けている。
 * 案内（AIを起動してください）は的外れで、しかもログに残るのは
 * `fetch failed` の5文字だけ——**原因にたどり着く手がかりが無かった**
 * （規則5「エラーの本文を捨てない」に反していた）。
 *
 * ## 分け方
 *
 * `cause` の `code` だけを見る。**文面では判断しない**（Nodeの版で変わるし、
 * 環境によって訳される）。**分からないものは動かさない**——これまでどおり
 * `not_running` に落とす。案内が変わってしまうので、確かめられたものだけ移す。
 */
export function classifyFetchFailure(error: Error, label: string): AIError {
  const codes = failureCodes(error);
  const detail = describeCause(error, codes);

  if (codes.some((code) => DROPPED_CODES.has(code))) {
    return new AIError(
      `${label}との接続が答えの途中で切れました。`,
      "connection_lost",
      detail
    );
  }
  if (codes.some((code) => TIMEOUT_CODES.has(code))) {
    // こちらのタイマーより先に、通信の層が諦めた場合。作者から見れば
    // 「時間切れ」であり、直し方（待ち時間を延ばす）も同じである
    return new AIError(
      `${label}の応答が時間内に届きませんでした。`,
      "timeout",
      detail
    );
  }
  return new AIError(
    `${label}に接続できません。ネットワーク接続を確認してください。`,
    "not_running",
    detail
  );
}

/** 答えている途中で切れた。**起動していないのとは別物** */
const DROPPED_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/** 通信の層が先に諦めた。作者にとっては時間切れ */
const TIMEOUT_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT",
]);

/**
 * `cause` の連なりをたどって `code` を集める。
 *
 * undici は `TypeError → AggregateError → 個々のエラー` のように
 * 何段も包むことがあるので、**1段だけ見て終わらない**。
 */
function failureCodes(error: unknown, depth = 0): string[] {
  if (depth > 4 || error === null || typeof error !== "object") return [];
  const holder = error as { code?: unknown; cause?: unknown; errors?: unknown };
  const codes: string[] = [];
  if (typeof holder.code === "string") codes.push(holder.code);
  if (Array.isArray(holder.errors)) {
    for (const nested of holder.errors) {
      codes.push(...failureCodes(nested, depth + 1));
    }
  }
  codes.push(...failureCodes(holder.cause, depth + 1));
  return codes;
}

/** ログへ残す手がかり。**`fetch failed` だけでは何も分からない** */
function describeCause(error: Error, codes: string[]): string {
  const causeMessage =
    error.cause instanceof Error ? error.cause.message : undefined;
  return [error.message, codes.join("/"), causeMessage]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join(" / ");
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
    throw classifyFetchFailure(err, request.label);
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
