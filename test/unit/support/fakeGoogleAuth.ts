import { createHash } from "node:crypto";
import type { GoogleTokenFetch, LoopbackListener, LoopbackRequest } from "../../../src/core/googleLogin";
import { DRIVE_FILE_SCOPE, GOOGLE_AUTH_ENDPOINT, GOOGLE_TOKEN_ENDPOINT, type GoogleCredentialVault, type StoredGoogleCredential } from "../../../src/core/googleOAuth";

/**
 * Google のログインの偽物（記憶の中）。本物の Google には出ない。
 *
 * - 承認の画面：`openBrowser` に渡された URL を読み、作者が［続行］を押したまねで
 *   待ち受けへ `/?code=…&state=…` を届ける（`behavior` で拒む・ほかから来た戻り等を選ぶ）
 * - トークンの口：`fetch` の段でまねる。code・code_verifier（S256 で challenge と照らす）・
 *   redirect_uri が承認の要求と合わなければ `invalid_grant`。更新は発行した refresh token だけ
 *
 * 作り物を親切にしない：知らない要求は 400。照らす所は本物の決まり（RFC 7636・
 * Google の頁）と同じにして、口の書式の誤りもここで落ちるようにする。
 */

export type ConsentBehavior =
  | "approve"
  | "deny"
  /** state の違う戻り（ほかから来た） */
  | "wrong_state"
  /** 先に `/favicon.ico` が来てから戻る */
  | "favicon_first"
  /** 許可の画面で drive.file の印を外した */
  | "uncheck_scope"
  /** 戻りが来ない（待つ上限のまね） */
  | "never";

export function createFakeGoogle(options: { clientId: string; clientSecret?: string; onAccessToken?: (token: string) => void }) {
  let behavior: ConsentBehavior = "approve";
  let issued = 0;
  const codes = new Map<string, { challenge: string; redirectUri: string; scope: string }>();
  const refreshTokens = new Set<string>();
  const tokenRequests: URLSearchParams[] = [];
  let tokenFault: "network" | { status: number; body: unknown } | undefined;
  /** 7日で切れたまね（発行した refresh token を全部無効にする） */
  const expireRefreshTokens = () => refreshTokens.clear();

  const pending: LoopbackRequest[] = [];
  let waiter: ((request: LoopbackRequest) => void) | undefined;
  const responses: { path: string; status: number; html: string }[] = [];
  let listening = false;
  let port = 50000;

  const deliver = (path: string) => {
    const request: LoopbackRequest = {
      path,
      respond: async (status, html) => {
        responses.push({ path, status, html });
      },
    };
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(request);
    } else pending.push(request);
  };

  const listen = async (): Promise<LoopbackListener> => {
    port += 1;
    listening = true;
    return {
      port,
      next: () =>
        new Promise<LoopbackRequest>((resolve) => {
          const head = pending.shift();
          if (head) resolve(head);
          else waiter = resolve;
        }),
      close: async () => {
        listening = false;
      },
    };
  };

  const openBrowser = async (raw: string): Promise<boolean> => {
    const url = new URL(raw);
    if (`${url.origin}${url.pathname}` !== GOOGLE_AUTH_ENDPOINT) return false;
    const params = url.searchParams;
    if (params.get("client_id") !== options.clientId) throw new Error("client_id が違います");
    if (params.get("code_challenge_method") !== "S256" || params.get("response_type") !== "code") {
      throw new Error("承認の要求の形が違います");
    }
    const state = params.get("state") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(redirectUri)) throw new Error("戻り先が loopback ではありません");
    if (behavior === "never") return true;
    if (behavior === "deny") {
      deliver(`/?error=access_denied&state=${encodeURIComponent(state)}`);
      return true;
    }
    if (behavior === "favicon_first") deliver("/favicon.ico");
    const code = `code-${++issued}`;
    codes.set(code, {
      challenge: params.get("code_challenge") ?? "",
      redirectUri,
      scope: behavior === "uncheck_scope" ? "openid" : params.get("scope") ?? "",
    });
    deliver(`/?code=${code}&state=${encodeURIComponent(behavior === "wrong_state" ? "someone-else" : state)}&scope=x`);
    return true;
  };

  const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });

  const fetch: GoogleTokenFetch = async (url, init) => {
    if (url !== GOOGLE_TOKEN_ENDPOINT || init.method !== "POST") return json(400, { error: "invalid_request" });
    if (init.headers["Content-Type"] !== "application/x-www-form-urlencoded") return json(400, { error: "invalid_request" });
    const body = new URLSearchParams(init.body);
    tokenRequests.push(body);
    if (tokenFault === "network") throw new TypeError("fetch failed");
    if (tokenFault) return json(tokenFault.status, tokenFault.body);
    if (body.get("client_id") !== options.clientId) return json(401, { error: "invalid_client" });
    if (options.clientSecret !== undefined && body.get("client_secret") !== options.clientSecret) {
      return json(401, { error: "invalid_client" });
    }
    const access = () => {
      const token = `ya29.fake-${++issued}`;
      options.onAccessToken?.(token);
      return token;
    };
    if (body.get("grant_type") === "authorization_code") {
      const code = codes.get(body.get("code") ?? "");
      codes.delete(body.get("code") ?? "");
      if (!code) return json(400, { error: "invalid_grant" });
      const challenge = createHash("sha256").update(body.get("code_verifier") ?? "", "ascii").digest("base64url");
      if (challenge !== code.challenge || body.get("redirect_uri") !== code.redirectUri) {
        return json(400, { error: "invalid_grant" });
      }
      const refresh = `1//fake-refresh-${++issued}`;
      refreshTokens.add(refresh);
      return json(200, {
        access_token: access(),
        expires_in: 3599,
        refresh_token: refresh,
        scope: code.scope,
        token_type: "Bearer",
      });
    }
    if (body.get("grant_type") === "refresh_token") {
      if (!refreshTokens.has(body.get("refresh_token") ?? "")) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: access(), expires_in: 3599, scope: DRIVE_FILE_SCOPE, token_type: "Bearer" });
    }
    return json(400, { error: "unsupported_grant_type" });
  };

  return {
    listen,
    openBrowser,
    fetch,
    responses,
    tokenRequests,
    isListening: () => listening,
    setBehavior(next: ConsentBehavior) {
      behavior = next;
    },
    setTokenFault(next: typeof tokenFault) {
      tokenFault = next;
    },
    expireRefreshTokens,
  };
}

/** SecretStorage の作り物（1つの鍵） */
export function createMemoryVault(): GoogleCredentialVault & { value: () => StoredGoogleCredential | undefined } {
  let stored: string | undefined;
  return {
    get: async () => (stored === undefined ? undefined : (JSON.parse(stored) as StoredGoogleCredential)),
    store: async (credential) => {
      stored = JSON.stringify(credential);
    },
    delete: async () => {
      stored = undefined;
    },
    value: () => (stored === undefined ? undefined : (JSON.parse(stored) as StoredGoogleCredential)),
  };
}
