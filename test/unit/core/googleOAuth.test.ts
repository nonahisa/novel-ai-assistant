import { describe, expect, test } from "vitest";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  DRIVE_FILE_SCOPE,
  GOOGLE_AUTH_ENDPOINT,
  base64UrlEncode,
  buildAuthorizationUrl,
  buildRefreshRequestBody,
  buildTokenRequestBody,
  codeChallengeS256,
  createCodeVerifier,
  createState,
  googleTokenNextAction,
  hexToBytes,
  loopbackRedirectUri,
  needsRefresh,
  parseAuthorizationRedirect,
  validateTokenResponse,
  type GoogleTokenFailureKind,
} from "../../../src/core/googleOAuth";
import { sha256Bytes } from "../../../src/core/hash";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/** 製品で渡す想定の SHA-256（`core/hash.ts` の16進をバイトへ） */
const sha256 = (bytes: Uint8Array) => hexToBytes(sha256Bytes(bytes));

describe("PKCE（S256）", () => {
  test("RFC 7636 の付録Bの例と一致する", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", sha256)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
  });

  test("Node の crypto と同じ値になる（自前の base64url と SHA-256 を自分のテストだけで正しいと言わない）", () => {
    for (let i = 0; i < 20; i++) {
      const verifier = createCodeVerifier((n) => new Uint8Array(randomBytes(n)));
      const expected = createHash("sha256").update(verifier, "ascii").digest("base64url");
      expect(codeChallengeS256(verifier, sha256)).toBe(expected);
    }
  });

  test("code_verifier は43字以上、使える字だけ", () => {
    const verifier = createCodeVerifier((n) => new Uint8Array(n).fill(255));
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(verifier).toHaveLength(43);
    // 乱数の口が短いものを返したら作らずに止める
    expect(() => createCodeVerifier(() => new Uint8Array(3))).toThrow();
    expect(() => codeChallengeS256("短い", sha256)).toThrow();
  });

  test("base64url は詰め物なしで Node と一致する（長さ0〜40）", () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = new Uint8Array(randomBytes(n));
      expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  test("state は乱数から作る", () => {
    expect(createState((n) => new Uint8Array(n))).toHaveLength(22);
  });
});

describe("承認の URL と戻り", () => {
  test("承認の URL：loopback・drive.file・S256・offline・state", () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: "client-1.apps.googleusercontent.com",
        redirectUri: loopbackRedirectUri(53682),
        codeChallenge: "CH",
        state: "ST",
      })
    );
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-1.apps.googleusercontent.com",
      redirect_uri: "http://127.0.0.1:53682",
      response_type: "code",
      scope: DRIVE_FILE_SCOPE,
      code_challenge: "CH",
      code_challenge_method: "S256",
      state: "ST",
      access_type: "offline",
    });
  });

  test("待ち受けの番号が範囲の外なら作らない", () => {
    for (const bad of [0, 65536, 1.5, -1]) expect(() => loopbackRedirectUri(bad)).toThrow();
  });

  test("戻ってきた道を読む。state が合わなければ code があっても使わない", () => {
    expect(parseAuthorizationRedirect("/?code=abc&state=ST", "ST")).toEqual({ ok: true, code: "abc" });
    expect(parseAuthorizationRedirect("/?code=abc&state=XX", "ST")).toEqual({ ok: false, kind: "state_mismatch" });
    expect(parseAuthorizationRedirect("/?code=abc", "ST")).toEqual({ ok: false, kind: "state_mismatch" });
    expect(parseAuthorizationRedirect("/?error=access_denied&state=ST", "ST")).toEqual({
      ok: false,
      kind: "access_denied",
      error: "access_denied",
    });
    expect(parseAuthorizationRedirect("/?error=invalid_request&state=ST", "ST")).toMatchObject({ kind: "error" });
    expect(parseAuthorizationRedirect("/?state=ST", "ST")).toEqual({ ok: false, kind: "no_code" });
  });

  test("トークンの要求の本文", () => {
    expect(
      Object.fromEntries(
        new URLSearchParams(
          buildTokenRequestBody({
            clientId: "c",
            code: "abc",
            codeVerifier: "v",
            redirectUri: "http://127.0.0.1:1",
          })
        )
      )
    ).toEqual({
      client_id: "c",
      code: "abc",
      code_verifier: "v",
      grant_type: "authorization_code",
      redirect_uri: "http://127.0.0.1:1",
    });
    expect(new URLSearchParams(buildRefreshRequestBody({ clientId: "c", clientSecret: "s", refreshToken: "r" })).get("client_secret")).toBe("s");
    expect(new URLSearchParams(buildRefreshRequestBody({ clientId: "c", refreshToken: "r" })).has("client_secret")).toBe(false);
  });
});

describe("トークンの応答の検証", () => {
  const NOW = Date.parse("2026-11-07T00:00:00.000Z");
  const good = {
    access_token: "ya29.x",
    expires_in: 3599,
    refresh_token: "1//r",
    scope: `openid ${DRIVE_FILE_SCOPE}`,
    token_type: "Bearer",
  };
  const check = (status: number, body: unknown, grant: "authorization_code" | "refresh_token" = "authorization_code", previousRefreshToken?: string) =>
    validateTokenResponse({
      status,
      bodyText: typeof body === "string" ? body : JSON.stringify(body),
      nowMs: NOW,
      grant,
      previousRefreshToken,
    });

  test("正しい応答", () => {
    expect(check(200, good)).toEqual({
      ok: true,
      tokens: { accessToken: "ya29.x", expiresAt: NOW + 3599 * 1000, refreshToken: "1//r", scope: good.scope },
    });
  });

  test("更新の応答に refresh token が無ければ前のものを引き継ぐ", () => {
    const { refresh_token: _drop, ...withoutRefresh } = good;
    expect(check(200, withoutRefresh, "refresh_token", "1//old")).toMatchObject({
      ok: true,
      tokens: { refreshToken: "1//old" },
    });
  });

  const failures: [string, number, unknown, GoogleTokenFailureKind][] = [
    ["許可が切れた（invalid_grant）", 400, { error: "invalid_grant" }, "reauthorize"],
    ["400 のほかの符号は決めつけない", 400, { error: "invalid_request" }, "unknown"],
    ["400 本文なし", 400, "", "unknown"],
    ["429", 429, "", "rate_limited"],
    ["500", 500, "", "server"],
    ["drive.file が外された", 200, { ...good, scope: "openid" }, "scope_missing"],
    ["初めてなのに refresh token が無い", 200, { ...good, refresh_token: undefined }, "no_refresh_token"],
    ["access_token が空", 200, { ...good, access_token: "" }, "bad_response"],
    ["token_type が違う", 200, { ...good, token_type: "MAC" }, "bad_response"],
    ["expires_in が無い", 200, { ...good, expires_in: undefined }, "bad_response"],
    ["JSON でない", 200, "<html>", "bad_response"],
  ];

  test.each(failures)("%s → %s", (_label, status, body, kind) => {
    const result = check(status, body);
    expect(result).toMatchObject({ ok: false, kind, status });
    expect(googleTokenNextAction(kind)).toMatch(/。$/);
  });

  test("更新の要否：切れる5分前から", () => {
    const tokens = { expiresAt: NOW + 10 * 60 * 1000 };
    expect(needsRefresh(tokens, NOW)).toBe(false);
    expect(needsRefresh(tokens, NOW + 5 * 60 * 1000)).toBe(true);
    expect(needsRefresh(undefined, NOW)).toBe(true);
  });
});

describe("モバイル版へそのまま持っていける（vscode・node:・paths を読まない）", () => {
  test("googleOAuth.ts から静的にたどれる先に、vscode・node: ・core/paths.ts が無い", () => {
    const reach = walkStaticImports([path.join(SRC, "core", "googleOAuth.ts")]);
    const bare = reach.bare.map((item) => `${relativeName(item.file)} → ${item.spec}`);
    expect(bare.filter((line) => /→ (vscode|node:)/.test(line))).toEqual([]);
    const paths = path.join(SRC, "core", "paths.ts");
    expect(reach.files.has(paths) ? chainTo(reach, paths) : "").toBe("");
  });
});
