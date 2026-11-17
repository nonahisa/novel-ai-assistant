import { DriveApiError, type DriveAccessTokenSource } from "./driveApi";
import type { GoogleClientConfig } from "./googleClientConfig";
import {
  GOOGLE_TOKEN_ENDPOINT,
  buildAuthorizationUrl,
  buildRefreshRequestBody,
  buildTokenRequestBody,
  codeChallengeS256,
  createCodeVerifier,
  createState,
  googleTokenNextAction,
  loopbackRedirectUri,
  needsRefresh,
  parseAuthorizationRedirect,
  validateTokenResponse,
  type GoogleCredentialVault,
  type GoogleTokenFailureKind,
  type GoogleTokenSet,
  type RandomBytes,
  type Sha256,
  type StoredGoogleCredential,
} from "./googleOAuth";

/**
 * Google の提供者のうち、**手順の部分**（設計書5.10.9。段階3）。
 *
 * `googleOAuth.ts`（PKCE・URL・応答の検証）を、ログインの1往復とアクセストークンの
 * 更新につなぐ。**待ち受け・ブラウザを開く・送受信・鍵の置き場・時計は口で受け取る**
 * ——手元の VS Code は `node:http`（動的 import）と `vscode.env.openExternal` と
 * SecretStorage を渡し、試験は偽の口を渡して往復させる（本物の Google には出ない）。
 * `vscode`・`node:` を読まない（`googleLogin.test.ts` が見張る）。
 *
 * ## ログインの1往復
 *
 * 1. 手元の `127.0.0.1` の空いている番号で待ち受ける（`listen`）
 * 2. PKCE の verifier・challenge と state を作り、承認の URL をブラウザで開く
 * 3. 戻ってきた要求（`/?code=…&state=…`）を読む。**state が合わなければ code を使わない**
 * 4. code をトークンに替え、refresh token を鍵の置き場へ置く
 *
 * 待ち受けは、成功しても失敗しても必ず閉じる。
 */

/** 送受信（トークンの口だけ。`fetch` をそのまま渡せる形） */
export type GoogleTokenFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string }
) => Promise<{ status: number; text(): Promise<string> }>;

/** 待ち受けに届いた要求1つ */
export interface LoopbackRequest {
  /** 要求の道（`/?code=…&state=…`。`/favicon.ico` などもありうる） */
  path: string;
  /** ブラウザへ返す頁 */
  respond(status: number, html: string): Promise<void>;
}

/** 手元の待ち受け（`127.0.0.1` の、空いている番号） */
export interface LoopbackListener {
  port: number;
  /** 次に届いた要求。閉じたあとは返らない */
  next(): Promise<LoopbackRequest>;
  close(): Promise<void>;
}

export type GoogleLoginFailureKind =
  /** ブラウザを開けなかった */
  | "browser_not_opened"
  /** 待ち受けを始められなかった */
  | "listen_failed"
  /** 待つ上限を過ぎた */
  | "timeout"
  /** 作者がやめた */
  | "cancelled"
  /** 許可の画面で拒んだ */
  | "access_denied"
  /** ほかから来た戻り（CSRF の見立て）。code は使っていない */
  | "state_mismatch"
  /** 戻りに code が無い・Google が別の error を返した */
  | "redirect_error"
  /** トークンの口へ送れなかった */
  | "network"
  | GoogleTokenFailureKind;

export type GoogleLoginResult =
  | { ok: true; credential: StoredGoogleCredential; tokens: GoogleTokenSet }
  | { ok: false; kind: GoogleLoginFailureKind; status?: number; error?: string };

export interface GoogleLoginDeps {
  client: GoogleClientConfig;
  listen(): Promise<LoopbackListener>;
  /** 承認の URL を開く。開けなければ false */
  openBrowser(url: string): Promise<boolean>;
  fetch: GoogleTokenFetch;
  randomBytes: RandomBytes;
  sha256: Sha256;
  nowMs(): number;
  vault: GoogleCredentialVault;
  /**
   * 待つのをやめる合図（上限の時間・作者の［やめる］）。どちらかで解ける約束を渡す。
   * 渡さなければ戻りが来るまで待つ（試験だけ）
   */
  stop?: Promise<"timeout" | "cancelled">;
  /** ログの1行。**トークン・code・client secret は入れない** */
  log?: (line: string) => void;
}

/** ログインできたあとにブラウザへ返す頁（作者が見る） */
export const LOGIN_DONE_HTML = page("Google へのログインが済みました。この画面は閉じてかまいません。");
const LOGIN_FAILED_HTML = page("Google へのログインは済んでいません。VS Code に戻って、知らせを確かめてください。");

/**
 * ログインの1往復（上の1〜4）。鍵の置き場へ置くのは、トークンの応答が確かめに
 * 通ったときだけ（`validateTokenResponse`。drive.file が外されていれば置かない）
 */
export async function runGoogleLogin(deps: GoogleLoginDeps): Promise<GoogleLoginResult> {
  const log = deps.log ?? (() => undefined);
  let listener: LoopbackListener;
  try {
    listener = await deps.listen();
  } catch (error) {
    log(`[google] 待ち受けを始められませんでした（${error instanceof Error ? error.name : typeof error}）`);
    return { ok: false, kind: "listen_failed" };
  }
  try {
    const verifier = createCodeVerifier(deps.randomBytes);
    const state = createState(deps.randomBytes);
    const redirectUri = loopbackRedirectUri(listener.port);
    const url = buildAuthorizationUrl({
      clientId: deps.client.clientId,
      redirectUri,
      codeChallenge: codeChallengeS256(verifier, deps.sha256),
      state,
    });
    if (!(await deps.openBrowser(url))) return { ok: false, kind: "browser_not_opened" };

    // 戻りを待つ。根の道（`/`）でない要求（ブラウザが勝手に取りに来る `/favicon.ico` 等）は
    // 404 を返して待ち続ける——それを戻りと読むと、state が無いので「ほかから来た」になる
    let request: LoopbackRequest | undefined;
    for (;;) {
      const next = await Promise.race([
        listener.next().then((value) => ({ kind: "request" as const, value })),
        ...(deps.stop ? [deps.stop.then((why) => ({ kind: why }))] : []),
      ]);
      if (next.kind !== "request") return { ok: false, kind: next.kind };
      if (pathnameOf(next.value.path) === "/") {
        request = next.value;
        break;
      }
      await next.value.respond(404, page("ここには何もありません。"));
    }

    const redirect = parseAuthorizationRedirect(request.path, state);
    if (!redirect.ok) {
      await request.respond(400, LOGIN_FAILED_HTML);
      log(`[google] ログインの戻りを使いませんでした（${redirect.kind}${redirect.error ? ` ${redirect.error}` : ""}）`);
      if (redirect.kind === "access_denied") return { ok: false, kind: "access_denied", error: redirect.error };
      if (redirect.kind === "state_mismatch") return { ok: false, kind: "state_mismatch" };
      return { ok: false, kind: "redirect_error", error: redirect.error };
    }

    const exchanged = await postToken(
      deps.fetch,
      buildTokenRequestBody({
        clientId: deps.client.clientId,
        clientSecret: deps.client.clientSecret,
        code: redirect.code,
        codeVerifier: verifier,
        redirectUri,
      }),
      log,
      "トークンを受け取る"
    );
    if (!exchanged.ok) {
      await request.respond(502, LOGIN_FAILED_HTML);
      return { ok: false, kind: "network" };
    }
    const checked = validateTokenResponse({
      status: exchanged.status,
      bodyText: exchanged.bodyText,
      nowMs: deps.nowMs(),
      grant: "authorization_code",
    });
    if (!checked.ok) {
      await request.respond(400, LOGIN_FAILED_HTML);
      log(`[google] トークンを受け取れませんでした（HTTP ${checked.status} ${checked.kind}${checked.error ? ` ${checked.error}` : ""}）`);
      return { ok: false, kind: checked.kind, status: checked.status, error: checked.error };
    }
    const credential: StoredGoogleCredential = {
      refreshToken: checked.tokens.refreshToken as string,
      scope: checked.tokens.scope,
      obtainedAt: new Date(deps.nowMs()).toISOString(),
    };
    await deps.vault.store(credential);
    await request.respond(200, LOGIN_DONE_HTML);
    log("[google] ログインできました");
    return { ok: true, credential, tokens: checked.tokens };
  } finally {
    await listener.close().catch(() => undefined);
  }
}

/** ログインの失敗の種別ごとに、作者が次にする操作（1つ） */
export function googleLoginNextAction(kind: GoogleLoginFailureKind): string {
  switch (kind) {
    case "browser_not_opened":
      return "ブラウザを開けませんでした。既定のブラウザが設定されているか確かめてから、もう一度ログインしてください。";
    case "listen_failed":
      return "このパソコンでログインの戻りを待てませんでした。VS Code を開き直してから、もう一度ログインしてください。";
    case "timeout":
      return "ログインの画面が時間内に終わりませんでした。もう一度ログインしてください。";
    case "cancelled":
      return "ログインをやめました。続けるときは、もう一度ログインしてください。";
    case "access_denied":
      return "許可の画面で許可されませんでした。続けるときは、もう一度ログインして［続行］を押してください。";
    case "state_mismatch":
      return "ほかの画面からの戻りだったので使いませんでした。もう一度ログインしてください。";
    case "redirect_error":
      return "Google から戻ってきた中身が読めませんでした。ログを開いて、記録された内容を確かめてください。";
    case "network":
      return "ネットにつながっているか確かめてから、もう一度ログインしてください。";
    case "reauthorize":
    case "scope_missing":
    case "no_refresh_token":
    case "rate_limited":
    case "server":
    case "bad_response":
    case "unknown":
      return googleTokenNextAction(kind);
  }
}

/** アクセストークンの口（Drive の口へ渡す）。`reset` はログアウトで手元の写しを捨てる */
export interface GoogleAccessTokens {
  source: DriveAccessTokenSource;
  /** 手元に持っているアクセストークンを捨てる（ログアウト・ログインし直したとき） */
  reset(): void;
  /** ログインしたばかりのトークンを手元に持つ（すぐ送るときに更新を1回省く） */
  adopt(tokens: GoogleTokenSet): void;
}

/**
 * アクセストークンを返す口。**アクセストークンは保存しない**（1時間ほどで切れる。
 * 手元の写しだけ）。切れる5分前から、鍵の置き場の refresh token で更新する。
 *
 * 失敗は `DriveApiError` で投げる——Drive の口（`driveApi.ts`）がそのまま受け、
 * `driveNextAction` で作者の次の操作が1つ出る。
 *
 * - ログインしていない・`invalid_grant`（7日で切れた・取り消された）→ `auth_expired`
 *   （ログインし直す）。**鍵は消さない**——ログインし直せば置き換わる。失敗したから消す、
 *   という覚え方をしない（実装ルール5）
 * - drive.file が外された → `permission`
 * - 429 → `rate_limited`、5xx → `server`、送れない → `network`、ほか → `unknown`
 */
export function createGoogleAccessTokens(deps: {
  client: () => Promise<GoogleClientConfig | undefined>;
  vault: GoogleCredentialVault;
  fetch: GoogleTokenFetch;
  nowMs(): number;
  log?: (line: string) => void;
}): GoogleAccessTokens {
  const log = deps.log ?? (() => undefined);
  let cached: GoogleTokenSet | undefined;
  const operation = "アクセストークンを取る";

  const source: DriveAccessTokenSource = async ({ forceRefresh }) => {
    if (!forceRefresh && cached && !needsRefresh(cached, deps.nowMs())) return cached.accessToken;
    const client = await deps.client();
    const credential = await deps.vault.get();
    if (!client || !credential) {
      throw new DriveApiError("auth_expired", { operation, reason: "not_logged_in" });
    }
    const sent = await postToken(
      deps.fetch,
      buildRefreshRequestBody({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken: credential.refreshToken,
      }),
      log,
      operation
    );
    if (!sent.ok) throw new DriveApiError("network", { operation });
    const checked = validateTokenResponse({
      status: sent.status,
      bodyText: sent.bodyText,
      nowMs: deps.nowMs(),
      grant: "refresh_token",
      previousRefreshToken: credential.refreshToken,
    });
    if (!checked.ok) {
      log(`[google] アクセストークンを更新できませんでした（HTTP ${checked.status} ${checked.kind}${checked.error ? ` ${checked.error}` : ""}）`);
      cached = undefined;
      throw new DriveApiError(driveKindOf(checked.kind), {
        operation,
        status: checked.status,
        reason: checked.error,
      });
    }
    cached = checked.tokens;
    // 更新で新しい refresh token が返ったら置き換える（返らないのがふつう）
    if (checked.tokens.refreshToken && checked.tokens.refreshToken !== credential.refreshToken) {
      await deps.vault.store({
        refreshToken: checked.tokens.refreshToken,
        scope: checked.tokens.scope,
        obtainedAt: new Date(deps.nowMs()).toISOString(),
      });
    }
    return checked.tokens.accessToken;
  };

  return {
    source,
    reset: () => {
      cached = undefined;
    },
    adopt: (tokens) => {
      cached = tokens;
    },
  };
}

/** ログアウト：鍵の置き場から refresh token を消し、手元のアクセストークンも捨てる */
export async function logoutGoogle(input: {
  vault: GoogleCredentialVault;
  tokens?: GoogleAccessTokens;
}): Promise<void> {
  input.tokens?.reset();
  await input.vault.delete();
}

function driveKindOf(kind: GoogleTokenFailureKind) {
  switch (kind) {
    case "reauthorize":
    case "no_refresh_token":
      return "auth_expired" as const;
    case "scope_missing":
      return "permission" as const;
    case "rate_limited":
      return "rate_limited" as const;
    case "server":
      return "server" as const;
    case "bad_response":
      return "bad_response" as const;
    case "unknown":
      return "unknown" as const;
  }
}

async function postToken(
  fetch: GoogleTokenFetch,
  body: string,
  log: (line: string) => void,
  operation: string
): Promise<{ ok: true; status: number; bodyText: string } | { ok: false }> {
  try {
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      bodyText = "";
    }
    return { ok: true, status: response.status, bodyText };
  } catch (error) {
    // 例外の文は環境ごとに違うので、原因の言い当てに使わない。種類の名前だけ残す
    log(`[google] ${operation}: 送れませんでした（${error instanceof Error ? error.name : typeof error}）`);
    return { ok: false };
  }
}

function pathnameOf(requestPath: string): string {
  try {
    return new URL(requestPath, "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function page(message: string): string {
  return (
    '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>統合小説執筆環境</title></head>' +
    `<body style="font-family:sans-serif;padding:2em"><p>${message}</p></body></html>`
  );
}
