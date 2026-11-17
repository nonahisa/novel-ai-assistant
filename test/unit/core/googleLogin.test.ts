import { describe, expect, test } from "vitest";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { DriveApiError } from "../../../src/core/driveApi";
import {
  createGoogleAccessTokens,
  googleLoginNextAction,
  logoutGoogle,
  runGoogleLogin,
  type GoogleLoginDeps,
  type GoogleLoginFailureKind,
} from "../../../src/core/googleLogin";
import { DRIVE_FILE_SCOPE, hexToBytes } from "../../../src/core/googleOAuth";
import { sha256Bytes } from "../../../src/core/hash";
import { createFakeGoogle, createMemoryVault, type ConsentBehavior } from "../support/fakeGoogleAuth";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/**
 * Google の提供者の手順（設計書5.10.9）。偽の承認の画面・待ち受け・トークンの口で往復させる。
 * 本物の Google には出ない。
 */

const CLIENT = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-fake" };
const sha256 = (bytes: Uint8Array) => hexToBytes(sha256Bytes(bytes));

function deps(google: ReturnType<typeof createFakeGoogle>, vault = createMemoryVault(), extra: Partial<GoogleLoginDeps> = {}) {
  const logs: string[] = [];
  const value: GoogleLoginDeps = {
    client: CLIENT,
    listen: google.listen,
    openBrowser: google.openBrowser,
    fetch: google.fetch,
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    sha256,
    nowMs: () => Date.parse("2026-11-18T09:00:00.000Z"),
    vault,
    log: (line) => logs.push(line),
    ...extra,
  };
  return { value, vault, logs };
}

describe("ログインの1往復", () => {
  test("許可すると refresh token を鍵の置き場へ置き、ブラウザへ済んだ頁を返し、待ち受けを閉じる", async () => {
    const google = createFakeGoogle(CLIENT);
    const { value, vault, logs } = deps(google);
    const result = await runGoogleLogin(value);
    expect(result.ok).toBe(true);
    expect(vault.value()).toMatchObject({ scope: DRIVE_FILE_SCOPE, obtainedAt: "2026-11-18T09:00:00.000Z" });
    expect(vault.value()?.refreshToken).toMatch(/^1\/\/fake-refresh-/);
    expect(google.responses.at(-1)).toMatchObject({ status: 200 });
    expect(google.responses.at(-1)?.html).toContain("ログインが済みました");
    expect(google.isListening()).toBe(false);
    // トークンの要求に client secret と verifier を載せた（偽物が S256 で照らした）
    expect(google.tokenRequests[0].get("client_secret")).toBe(CLIENT.clientSecret);
    // ログに鍵・code・client secret を出さない
    const joined = logs.join("\n");
    expect(joined).not.toMatch(/1\/\/fake|ya29\.|code-\d|GOCSPX/);
  });

  test("先にブラウザが /favicon.ico を取りに来ても、それを戻りと読まない", async () => {
    const google = createFakeGoogle(CLIENT);
    google.setBehavior("favicon_first");
    const result = await runGoogleLogin(deps(google).value);
    expect(result.ok).toBe(true);
    expect(google.responses[0]).toMatchObject({ path: "/favicon.ico", status: 404 });
  });

  const failures: [ConsentBehavior, GoogleLoginFailureKind][] = [
    ["deny", "access_denied"],
    ["wrong_state", "state_mismatch"],
    ["uncheck_scope", "scope_missing"],
  ];
  for (const [behavior, kind] of failures) {
    test(`${behavior} → ${kind}。鍵の置き場へ何も置かず、待ち受けを閉じる`, async () => {
      const google = createFakeGoogle(CLIENT);
      google.setBehavior(behavior);
      const { value, vault } = deps(google);
      const result = await runGoogleLogin(value);
      expect(result).toMatchObject({ ok: false, kind });
      expect(vault.value()).toBeUndefined();
      expect(google.isListening()).toBe(false);
      // ほかから来た戻りの code はトークンに替えない
      if (behavior === "wrong_state") expect(google.tokenRequests).toHaveLength(0);
    });
  }

  test("戻りが来ないまま上限を過ぎたら timeout。待ち受けを閉じる", async () => {
    const google = createFakeGoogle(CLIENT);
    google.setBehavior("never");
    const result = await runGoogleLogin(deps(google, undefined, { stop: Promise.resolve("timeout") }).value);
    expect(result).toMatchObject({ ok: false, kind: "timeout" });
    expect(google.isListening()).toBe(false);
  });

  test("ブラウザを開けなければ browser_not_opened", async () => {
    const google = createFakeGoogle(CLIENT);
    const result = await runGoogleLogin(deps(google, undefined, { openBrowser: async () => false }).value);
    expect(result).toMatchObject({ ok: false, kind: "browser_not_opened" });
  });

  test("トークンの口へ送れなければ network。鍵は置かない", async () => {
    const google = createFakeGoogle(CLIENT);
    google.setTokenFault("network");
    const { value, vault } = deps(google);
    expect(await runGoogleLogin(value)).toMatchObject({ ok: false, kind: "network" });
    expect(vault.value()).toBeUndefined();
  });

  test("失敗の種別ごとに、次の操作の文が1つある（サービス名を決め打ちしない所は Google だけ）", () => {
    const kinds: GoogleLoginFailureKind[] = [
      "browser_not_opened", "listen_failed", "timeout", "cancelled", "access_denied", "state_mismatch",
      "redirect_error", "network", "reauthorize", "scope_missing", "no_refresh_token", "rate_limited",
      "server", "bad_response", "unknown",
    ];
    for (const kind of kinds) expect(googleLoginNextAction(kind)).toMatch(/。$/);
  });
});

describe("アクセストークンの口", () => {
  test("ログインのあと、更新して返す。期限内なら2回目は送らない。forceRefresh なら送る", async () => {
    const google = createFakeGoogle(CLIENT);
    const { value, vault } = deps(google);
    await runGoogleLogin(value);
    let now = Date.parse("2026-11-18T09:00:00.000Z");
    const tokens = createGoogleAccessTokens({ client: async () => CLIENT, vault, fetch: google.fetch, nowMs: () => now });
    const first = await tokens.source({ forceRefresh: false });
    expect(first).toMatch(/^ya29\.fake-/);
    const requests = google.tokenRequests.length;
    expect(await tokens.source({ forceRefresh: false })).toBe(first);
    expect(google.tokenRequests).toHaveLength(requests);
    expect(await tokens.source({ forceRefresh: true })).not.toBe(first);
    // 切れる5分前を過ぎたら更新する
    now += 3599 * 1000 - 4 * 60 * 1000;
    const before = google.tokenRequests.length;
    await tokens.source({ forceRefresh: false });
    expect(google.tokenRequests.length).toBe(before + 1);
  });

  test("ログインしていなければ auth_expired（Drive の口の種別で投げる）", async () => {
    const google = createFakeGoogle(CLIENT);
    const tokens = createGoogleAccessTokens({
      client: async () => CLIENT,
      vault: createMemoryVault(),
      fetch: google.fetch,
      nowMs: () => 0,
    });
    await expect(tokens.source({ forceRefresh: false })).rejects.toMatchObject({ kind: "auth_expired" });
    expect(google.tokenRequests).toHaveLength(0);
  });

  test("7日で切れた（invalid_grant）は auth_expired。鍵は消さない（ログインし直せば置き換わる）", async () => {
    const google = createFakeGoogle(CLIENT);
    const { value, vault } = deps(google);
    await runGoogleLogin(value);
    google.expireRefreshTokens();
    const tokens = createGoogleAccessTokens({ client: async () => CLIENT, vault, fetch: google.fetch, nowMs: () => 0 });
    const error = await tokens.source({ forceRefresh: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveApiError);
    expect(error).toMatchObject({ kind: "auth_expired" });
    expect(vault.value()).toBeDefined();
  });

  test("429・5xx・送れない は、それぞれ rate_limited・server・network", async () => {
    const google = createFakeGoogle(CLIENT);
    const { value, vault } = deps(google);
    await runGoogleLogin(value);
    const tokens = createGoogleAccessTokens({ client: async () => CLIENT, vault, fetch: google.fetch, nowMs: () => 0 });
    const cases: [Parameters<typeof google.setTokenFault>[0], string][] = [
      [{ status: 429, body: {} }, "rate_limited"],
      [{ status: 503, body: {} }, "server"],
      ["network", "network"],
      [{ status: 400, body: { error: "invalid_request" } }, "unknown"],
    ];
    for (const [fault, kind] of cases) {
      google.setTokenFault(fault);
      await expect(tokens.source({ forceRefresh: true })).rejects.toMatchObject({ kind });
    }
  });

  test("ログアウトで鍵を消し、手元のアクセストークンも捨てる", async () => {
    const google = createFakeGoogle(CLIENT);
    const { value, vault } = deps(google);
    await runGoogleLogin(value);
    const tokens = createGoogleAccessTokens({ client: async () => CLIENT, vault, fetch: google.fetch, nowMs: () => 0 });
    await tokens.source({ forceRefresh: false });
    await logoutGoogle({ vault, tokens });
    expect(vault.value()).toBeUndefined();
    await expect(tokens.source({ forceRefresh: false })).rejects.toMatchObject({ kind: "auth_expired" });
  });
});

describe("モバイル版へそのまま持っていける（vscode・node:・paths を読まない）", () => {
  for (const name of ["googleLogin.ts", "googleClientConfig.ts"]) {
    test(`${name} から静的にたどれる先に、vscode・node:・core/paths.ts が無い`, () => {
      const reach = walkStaticImports([path.join(SRC, "core", name)]);
      const bare = reach.bare.map((item) => `${relativeName(item.file)} → ${item.spec}`);
      expect(bare.filter((line) => /→ (vscode|node:)/.test(line))).toEqual([]);
      const paths = path.join(SRC, "core", "paths.ts");
      expect(reach.files.has(paths) ? chainTo(reach, paths) : "").toBe("");
    });
  }
});
