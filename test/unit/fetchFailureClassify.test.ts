import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchJson } from "../../src/ai/httpClient";
import { OllamaProvider } from "../../src/ai/ollamaProvider";
import { AIError } from "../../src/ai/types";

/**
 * 接続の失敗を「起動していない」と決めつけない（作者のログ、2026-08-29）。
 *
 * 実機のログにこう並んでいた。
 *
 *     15:26:05 AIへ送信: 1/9 第1話〜第2話（2話）
 *     15:31:14 --- AI呼び出しの失敗 ---
 *               種別: not_running
 *               詳細: fetch failed
 *
 * **5分9秒たってから「起動していない」は、事実と食い違う。** 起動して
 * いなければ接続は即座に断られるし、そもそも直前にモデル一覧を引けて
 * いる（抽出が始まっている）。実際に起きたのは**答えている途中で接続が
 * 切れた**ことで、案内すべきは「AIを起動してください」ではない。
 *
 * 原因は、fetch の失敗をすべて `not_running` に丸めていたことである。
 * Node の fetch は理由を `cause` に入れて `fetch failed` としか名乗らない
 * ので、**`message` だけを見ると全部同じ顔になる**。ログに残っていたのも
 * `fetch failed` の5文字で、原因にたどり着けなかった（規則5「エラーの
 * 本文を捨てない」に反していた）。
 */

function fetchFailedWith(code: string, message = "fetch failed"): TypeError {
  // Node の fetch は TypeError を投げ、理由は cause に入れる。
  // 実物と同じ形にしないと、直したつもりで直っていないことがある
  const cause = new Error(`socket hang up`) as Error & { code?: string };
  cause.code = code;
  return new TypeError(message, { cause });
}

async function ollamaFailure(error: unknown): Promise<AIError> {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(error))
  );
  const provider = new OllamaProvider();
  try {
    await provider.listModels();
  } catch (thrown) {
    if (thrown instanceof AIError) return thrown;
    throw thrown;
  }
  throw new Error("失敗するはずの呼び出しが成功した");
}

async function cloudFailure(error: unknown): Promise<AIError> {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(error))
  );
  try {
    await fetchJson({
      url: "https://example.test/v1/models",
      timeoutMs: 1000,
      label: "テストAI",
    });
  } catch (thrown) {
    if (thrown instanceof AIError) return thrown;
    throw thrown;
  }
  throw new Error("失敗するはずの呼び出しが成功した");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("接続の失敗を種別に分ける（Ollama）", () => {
  test("接続を断られたら「起動していない」", async () => {
    // ここは従来どおり。案内（AIを起動してください）が事実と合う唯一の場合
    const error = await ollamaFailure(fetchFailedWith("ECONNREFUSED"));

    expect(error.kind).toBe("not_running");
  });

  test("答えている途中で切れたら「起動していない」とは言わない", async () => {
    const error = await ollamaFailure(fetchFailedWith("ECONNRESET"));

    expect(error.kind).toBe("connection_lost");
  });

  test("切れた理由をログへ残す", async () => {
    // `fetch failed` だけでは原因にたどり着けない。
    // cause の code は、作者が検索できる唯一の手がかりである
    const error = await ollamaFailure(fetchFailedWith("ECONNRESET"));

    expect(error.detail).toContain("ECONNRESET");
  });

  test("受け取る前に待たされ続けたら、待ち時間の話にする", async () => {
    // undici が先に諦めた場合。こちらのタイマーは動いていないが、
    // 作者にとっては「時間切れ」であり、直し方も待ち時間の設定である
    const error = await ollamaFailure(fetchFailedWith("UND_ERR_HEADERS_TIMEOUT"));

    expect(error.kind).toBe("timeout");
  });

  test("名前を引けないのは「起動していない」に寄せる", async () => {
    const error = await ollamaFailure(fetchFailedWith("ENOTFOUND"));

    expect(error.kind).toBe("not_running");
  });

  test("理由が分からないときは、これまでどおり接続の問題として扱う", async () => {
    // **分からないものを新しい種別へ流さない。** 案内が変わるので、
    // 確かめられたものだけを移す
    const error = await ollamaFailure(new TypeError("fetch failed"));

    expect(error.kind).toBe("not_running");
  });
});

describe("接続の失敗を種別に分ける（クラウドAIの共通経路）", () => {
  test("答えている途中で切れたら「起動していない」とは言わない", async () => {
    const error = await cloudFailure(fetchFailedWith("ECONNRESET"));

    expect(error.kind).toBe("connection_lost");
    expect(error.detail).toContain("ECONNRESET");
  });

  test("接続を断られたら、これまでどおり", async () => {
    const error = await cloudFailure(fetchFailedWith("ECONNREFUSED"));

    expect(error.kind).toBe("not_running");
  });
});
