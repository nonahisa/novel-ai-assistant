import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchJson } from "../../../src/ai/httpClient";
import { setLocalFetchForTests } from "../../../src/ai/fetchTimeouts";
import {
  AIError,
  isFetchCeilingTimeout,
  recoveryForAIError,
} from "../../../src/ai/types";

/**
 * **こちらの待ち時間より先に、Node の通信部品の上限で切れた時間切れを見分ける**
 * （作者の裁定「案内を直す」、2026-10-23）。
 *
 * VS Code が差し替えた fetch は、クラウドのAIへの頼みで渡した待ち時間を捨て、
 * 応答の頭を300秒しか待たない。偽の Gemini（ヘッダーも返さず黙る）で、設定900秒の
 * 相談が302秒で切れた。このとき「待ち時間を延ばす」案内は効かない。
 */

/** 実測した形（2026-08-31）：TypeError: fetch failed / cause に undici の符号 */
function headersTimeout(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocalFetchForTests(undefined);
});

describe("クラウドのAIが Node の上限で切れたら、延ばす案内を出さない", () => {
  test("クラウドの口で切れたら、待った秒数で言い、延ばす案内を言わない", async () => {
    // **本物の時計に頼らない。** 「すぐ失敗するので0秒」としていたら、遅い CI で
    // 0.6秒かかって1秒に丸められ落ちた（2026-10-31）。時計を止め、偽の fetch の中で
    // 実測と同じ302秒だけ進めてから切る
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.stubGlobal("fetch", () => {
      vi.setSystemTime(Date.now() + 302_000);
      return Promise.reject(headersTimeout());
    });
    const error = await fetchJson({
      url: "https://example.invalid/v1",
      body: {},
      timeoutMs: 900_000,
      label: "Gemini",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).kind).toBe("timeout");
    expect(isFetchCeilingTimeout(error)).toBe(true);
    if (!isFetchCeilingTimeout(error)) return;
    expect(error.configuredSeconds).toBe(900);
    // 偽の fetch が進めた302秒を、待った秒数として言う
    expect(error.waitedSeconds).toBe(302);
    expect(error.message).toBe(
      "Geminiの応答がタイムアウトしました（Node側の上限。302秒で切れました）。" +
        "この上限は待ち時間の設定では変わりません。一度に送る量を減らしてください。"
    );
    expect(error.message).not.toContain("延ば");
    // ほかの画面の案内（共通の案内）も、秒数を延ばせとは言わない
    const recovery = recoveryForAIError(error);
    expect(recovery).not.toContain("延ば");
    expect(recovery).toBe("「1チャンクの文字数」を小さくすると、一度に送る量が減ります。");
    // 符号は記録に残す（実装ルール5「エラーの本文を捨てない」）
    expect(error.detail).toContain("UND_ERR_HEADERS_TIMEOUT");
  });

  test("手元のAIの口で切れたなら、こちらの待ち時間どおりなので今までどおり延ばす案内", async () => {
    // 手元の口は npm の undici へこちらの待ち時間を渡すので、切れたのは設定の秒数である
    setLocalFetchForTests(() => Promise.reject(headersTimeout()));
    const error = await fetchJson({
      url: "http://localhost:1234/v1",
      body: {},
      timeoutMs: 900_000,
      label: "LM Studio",
      local: true,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).kind).toBe("timeout");
    expect(isFetchCeilingTimeout(error)).toBe(false);
    expect((error as AIError).message).toContain("待ち時間を延ばすか");
  });

  test("接続の待ち時間切れは、応答の頭の上限ではないので見分けの対象にしない", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
        })
      )
    );
    const error = await fetchJson({
      url: "https://example.invalid/v1",
      body: {},
      timeoutMs: 900_000,
      label: "Gemini",
    }).catch((e: unknown) => e);
    expect((error as AIError).kind).toBe("timeout");
    expect(isFetchCeilingTimeout(error)).toBe(false);
  });
});
