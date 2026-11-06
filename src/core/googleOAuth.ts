/**
 * Google のログイン（OAuth 2.0、デスクトップアプリの流れ）のうち、
 * **画面と待ち受けを除いた純粋な部分**（設計書5.10.5。段階2、0.132.0）。
 *
 * 作るもの：PKCE の code_verifier と code_challenge（S256）・承認の URL・
 * 戻ってきた URL の読み取り・トークンを取る／更新する要求の本文・
 * トークンの応答の検証・更新の要否。
 *
 * **乱数とハッシュは呼び手から渡す**（`randomBytes`・`sha256`）。`node:crypto` を
 * 静的に読むとブラウザ版とモバイル版で落ちる（設計書5.8）。手元では
 * `core/runtime.ts` の乱数と `core/hash.ts` の `sha256Bytes`（16進なので
 * `hexToBytes` を通す）を渡す想定。`vscode`・`node:` は読まない
 * （`googleOAuth.test.ts` が見張る）。
 *
 * ## 公式の頁で確かめた所（2026-11-07、developers.google.com/identity/protocols/oauth2/native-app）
 *
 * - 承認：`https://accounts.google.com/o/oauth2/v2/auth`、トークン：`https://oauth2.googleapis.com/token`
 * - 承認の要求：`client_id`・`redirect_uri`（loopback は `http://127.0.0.1:<番号>`。
 *   クライアントに登録したものと**完全に同じ**でなければならない）・
 *   `response_type=code`・`scope`（空白区切り）・`code_challenge`・
 *   `code_challenge_method=S256`・`state`（CSRF よけ）
 * - code_verifier は43〜128字、使える字は `A-Z a-z 0-9 - . _ ~`。
 *   code_challenge は BASE64URL(SHA256(ASCII(verifier)))、詰め物（=）なし
 * - トークンの要求：`client_id`・`client_secret`（任意）・`code`・`code_verifier`・
 *   `grant_type=authorization_code`・`redirect_uri`。更新は `grant_type=refresh_token`・
 *   `refresh_token`
 * - 応答：`access_token`・`expires_in`（秒）・`refresh_token`・`scope`・
 *   `token_type`（いつも Bearer）。「インストール型のアプリには refresh token が
 *   いつも返る」。`invalid_grant` の符号がある。拒んだときは `error=access_denied`
 * - 範囲 `https://www.googleapis.com/auth/drive.file`（機密でない範囲。
 *   developers.google.com/workspace/drive/api/guides/api-specific-auth）
 *
 * ## 見立て（確かめていない）
 *
 * - `access_type=offline`：デスクトップの頁には載っていない（refresh token は
 *   いつも返るとある）。ウェブサーバーの流れの頁にある指定で、付けても害は
 *   ないと見て付けた（指示どおり）
 * - トークンの失敗の本文が `{ "error": "…", "error_description": "…" }` の形
 *   （OAuth 2.0 の決まり。頁には書いていない）。読めなければ `unknown`
 * - `client_secret`：デスクトップのクライアントにも Google は秘密を発行するが、
 *   配る拡張機能の中では守れない（公開クライアント。下書き〔9〕）。渡されれば送る
 */

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/**
 * refresh token を置く SecretStorage の鍵の名前。**ログにも設定にも書かない**
 * （CLAUDE.md 規則5）。置き場は呼び手（`vscode.SecretStorage`）
 */
export const GOOGLE_DRIVE_SECRET_KEY = "novelai.googleDrive.refreshToken";

/** SecretStorage に置く形（呼び手が JSON にして置く） */
export interface StoredGoogleCredential {
  refreshToken: string;
  /** 許された範囲（空白区切り）。drive.file が外されていれば使わない */
  scope: string;
  /** 受け取った時刻（ISO 8601）。テスト中のアプリは7日で切れるので、知らせに使う */
  obtainedAt: string;
}

/** SecretStorage の口の型（ここでは扱いの型だけ。中身は呼び手） */
export interface GoogleCredentialVault {
  get(): Promise<StoredGoogleCredential | undefined>;
  store(credential: StoredGoogleCredential): Promise<void>;
  delete(): Promise<void>;
}

/** 手元に持つトークン（アクセストークンは保存しない。1時間ほどで切れる） */
export interface GoogleTokenSet {
  accessToken: string;
  /** 切れる時刻（ミリ秒） */
  expiresAt: number;
  refreshToken?: string;
  scope: string;
}

/** 乱数の口。`n` バイトの暗号用の乱数 */
export type RandomBytes = (n: number) => Uint8Array;
/** SHA-256 の口（生のバイトを返す） */
export type Sha256 = (bytes: Uint8Array) => Uint8Array;

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * code_verifier を作る。32バイトの乱数を base64url にすると43字（下限ちょうど）。
 * 乱数が足りない・使えない字が混ざる口を渡されたら投げる（作り直さずに止める）
 */
export function createCodeVerifier(randomBytes: RandomBytes, byteLength = 32): string {
  const bytes = randomBytes(byteLength);
  if (bytes.length !== byteLength) throw new Error("乱数の長さが足りません");
  const verifier = base64UrlEncode(bytes);
  if (!VERIFIER_PATTERN.test(verifier)) throw new Error("code_verifier の形になりません");
  return verifier;
}

/** code_challenge（S256）＝ BASE64URL(SHA256(ASCII(verifier)))、詰め物なし */
export function codeChallengeS256(verifier: string, sha256: Sha256): string {
  if (!VERIFIER_PATTERN.test(verifier)) throw new Error("code_verifier の形ではありません");
  return base64UrlEncode(sha256(new TextEncoder().encode(verifier)));
}

/** state（CSRF よけ）。16バイトの乱数 */
export function createState(randomBytes: RandomBytes): string {
  return base64UrlEncode(randomBytes(16));
}

/** loopback の戻り先。番号は待ち受けた番号（呼び手） */
export function loopbackRedirectUri(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("待ち受けの番号が範囲の外です");
  }
  return `http://127.0.0.1:${port}`;
}

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: DRIVE_FILE_SCOPE,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
    access_type: "offline",
  });
  if (input.loginHint) params.set("login_hint", input.loginHint);
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export type AuthorizationRedirect =
  | { ok: true; code: string }
  | {
      ok: false;
      /** `access_denied`＝作者が拒んだ。`state_mismatch`＝ほかから来た戻り（CSRF の見立て） */
      kind: "access_denied" | "state_mismatch" | "no_code" | "error";
      /** Google が返した `error` の符号（あれば。ログ用） */
      error?: string;
    };

/**
 * 待ち受けに戻ってきた要求の道（`/?code=…&state=…`）を読む。
 * **state が合わなければ code があっても使わない**
 */
export function parseAuthorizationRedirect(
  requestPath: string,
  expectedState: string
): AuthorizationRedirect {
  let params: URLSearchParams;
  try {
    params = new URL(requestPath, "http://127.0.0.1").searchParams;
  } catch {
    return { ok: false, kind: "no_code" };
  }
  if (params.get("state") !== expectedState) return { ok: false, kind: "state_mismatch" };
  const error = params.get("error");
  if (error) {
    return { ok: false, kind: error === "access_denied" ? "access_denied" : "error", error };
  }
  const code = params.get("code");
  return code ? { ok: true, code } : { ok: false, kind: "no_code" };
}

/** トークンを取る要求の本文（`application/x-www-form-urlencoded`） */
export function buildTokenRequestBody(input: {
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  if (input.clientSecret) params.set("client_secret", input.clientSecret);
  return params.toString();
}

/** トークンを更新する要求の本文 */
export function buildRefreshRequestBody(input: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  if (input.clientSecret) params.set("client_secret", input.clientSecret);
  return params.toString();
}

export type GoogleTokenFailureKind =
  /** `invalid_grant`：許可が切れた・取り消された（テスト中のアプリは7日で切れる）。ログインし直す */
  | "reauthorize"
  /** 許可の画面で drive.file の印が外された。もう一度許可するときに印を付けてもらう */
  | "scope_missing"
  /** 初めての許可なのに refresh token が無い。続けられない */
  | "no_refresh_token"
  /** 429 */
  | "rate_limited"
  /** 5xx */
  | "server"
  /** 2xx だが形が違う */
  | "bad_response"
  /** ほか（400 の他の符号を含む。決めつけない） */
  | "unknown";

export type GoogleTokenCheck =
  | { ok: true; tokens: GoogleTokenSet }
  | {
      ok: false;
      kind: GoogleTokenFailureKind;
      status: number;
      /** 応答の `error` の符号（ログ用。トークンは入らない） */
      error?: string;
    };

/** 種別ごとの、作者が次にする操作（1つ） */
export function googleTokenNextAction(kind: GoogleTokenFailureKind): string {
  switch (kind) {
    case "reauthorize":
      return "Google へのログインをやり直してください。";
    case "scope_missing":
      return "もう一度ログインし、許可の画面でドライブのファイルへの許可に印を付けてください。";
    case "no_refresh_token":
      return "Google のアカウントの画面でこのアプリの許可を外してから、もう一度ログインしてください。";
    case "rate_limited":
    case "server":
      return "しばらく待ってから、もう一度ログインしてください。";
    case "bad_response":
    case "unknown":
      return "ログを開いて、記録された内容を確かめてください。";
  }
}

/**
 * トークンの応答を確かめる。
 *
 * @param input.grant 初めての許可（`authorization_code`）か更新（`refresh_token`）か。
 *   更新の応答は refresh token をふつう含まないので、`previousRefreshToken` を引き継ぐ
 */
export function validateTokenResponse(input: {
  status: number;
  bodyText: string;
  nowMs: number;
  grant: "authorization_code" | "refresh_token";
  previousRefreshToken?: string;
}): GoogleTokenCheck {
  const { status } = input;
  let value: unknown;
  try {
    value = JSON.parse(input.bodyText);
  } catch {
    value = undefined;
  }
  const body = isPlainObject(value) ? value : undefined;

  if (status < 200 || status >= 300) {
    const error = typeof body?.error === "string" ? body.error : undefined;
    if (error === "invalid_grant") return { ok: false, kind: "reauthorize", status, error };
    if (status === 429) return { ok: false, kind: "rate_limited", status, error };
    if (status >= 500) return { ok: false, kind: "server", status, error };
    // 400 をほかの符号で決めつけない（規則5）
    return { ok: false, kind: "unknown", status, error };
  }

  if (!body) return { ok: false, kind: "bad_response", status };
  const { access_token: accessToken, expires_in: expiresIn, token_type: tokenType } = body;
  if (typeof accessToken !== "string" || accessToken === "") {
    return { ok: false, kind: "bad_response", status };
  }
  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
    return { ok: false, kind: "bad_response", status };
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { ok: false, kind: "bad_response", status };
  }
  const scope = typeof body.scope === "string" ? body.scope : "";
  // 許可の画面で範囲ごとに外せる。drive.file が無ければ、送っても 403 になるだけ
  if (!scope.split(/\s+/).includes(DRIVE_FILE_SCOPE)) {
    return { ok: false, kind: "scope_missing", status };
  }
  const issued = typeof body.refresh_token === "string" && body.refresh_token !== ""
    ? body.refresh_token
    : undefined;
  const refreshToken = issued ?? (input.grant === "refresh_token" ? input.previousRefreshToken : undefined);
  if (input.grant === "authorization_code" && refreshToken === undefined) {
    return { ok: false, kind: "no_refresh_token", status };
  }
  return {
    ok: true,
    tokens: {
      accessToken,
      expiresAt: input.nowMs + expiresIn * 1000,
      refreshToken,
      scope,
    },
  };
}

/** 切れる少し前（既定5分）から更新する。送っている途中で切れないように */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function needsRefresh(
  tokens: Pick<GoogleTokenSet, "expiresAt"> | undefined,
  nowMs: number,
  marginMs = REFRESH_MARGIN_MS
): boolean {
  return tokens === undefined || nowMs + marginMs >= tokens.expiresAt;
}

/** 16進の文字列をバイトへ（`core/hash.ts` の `sha256Bytes` は16進を返すため） */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("16進の文字列ではありません");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url（詰め物なし）。`Buffer` は node: なので自前 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64URL[(triple >> 18) & 63] + BASE64URL[(triple >> 12) & 63];
    if (i + 1 < bytes.length) out += BASE64URL[(triple >> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64URL[triple & 63];
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
