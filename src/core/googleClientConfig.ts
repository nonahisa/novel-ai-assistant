/**
 * Google のログインに使うクライアント（作者が Google Cloud で作った OAuth クライアント。
 * 種類は「デスクトップ アプリ」）の読み書き（設計書5.10.9。段階3）。
 *
 * **クライアント ID は作者が製品の画面で入れる**（命令「Google ドライブの接続を設定」）。
 * 製品に同梱しない——はじめは Google のアプリを「テスト中」のまま作者だけで使う
 * （設計書5.10.1）ので、作者のプロジェクトのクライアントを使う。
 *
 * client secret は**秘密としては扱わない**（デスクトップ アプリは公開クライアントで、
 * 配る物の中では守れない。設計書5.10.5）。それでも**ログ・画面・リポジトリには出さない**
 * ——置き場は SecretStorage（`GOOGLE_DRIVE_CLIENT_KEY`）で、作品のフォルダーには書かない。
 *
 * `vscode`・`node:` を読まない（`googleClientConfig.test.ts` が見張る）。
 */

/** クライアントを置く SecretStorage の鍵の名前（refresh token とは別の鍵） */
export const GOOGLE_DRIVE_CLIENT_KEY = "novelai.googleDrive.client";

export interface GoogleClientConfig {
  clientId: string;
  /** デスクトップ アプリにも発行される。無くても送らずに進む（PKCE で足りる見立て） */
  clientSecret?: string;
}

export type GoogleClientRead =
  | { ok: true; client: GoogleClientConfig }
  | { ok: false; reason: string };

/**
 * クライアント ID の形。Google の ID は「数字-英数字.apps.googleusercontent.com」
 * （ダウンロードした JSON と Cloud の画面で見える形）。形が違えば、写し間違いとして断る
 * ——そのままログインへ進むと、Google の画面で「エラー 401」が出て原因が分かりにくい
 */
const CLIENT_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*\.apps\.googleusercontent\.com$/;

/** client secret として受け取る形（空白と制御文字を含まない、200字まで） */
const CLIENT_SECRET_PATTERN = /^[!-~]{1,200}$/;

export function isGoogleClientId(value: string): boolean {
  return CLIENT_ID_PATTERN.test(value);
}

export function isGoogleClientSecret(value: string): boolean {
  return CLIENT_SECRET_PATTERN.test(value);
}

/** 入力の窓で入れた値を確かめる（前後の空白は落とす。中の空白は写し間違いとして断る） */
export function readGoogleClientInput(input: {
  clientId: string;
  clientSecret?: string;
}): GoogleClientRead {
  const clientId = input.clientId.trim();
  if (!isGoogleClientId(clientId)) {
    return {
      ok: false,
      reason: "クライアント ID の形ではありません（末尾が .apps.googleusercontent.com のものです）",
    };
  }
  const secret = input.clientSecret?.trim();
  if (secret === undefined || secret === "") return { ok: true, client: { clientId } };
  if (!isGoogleClientSecret(secret)) {
    return { ok: false, reason: "クライアント シークレットの形ではありません" };
  }
  return { ok: true, client: { clientId, clientSecret: secret } };
}

/**
 * Google Cloud でダウンロードした JSON（`client_secret_….json`）を読む。
 *
 * 読むのは「デスクトップ アプリ」の形（`installed`）だけ。「ウェブ アプリケーション」
 * （`web`）は戻り先を登録した URL に限るので、手元の番号で待ち受ける形（loopback）では
 * 使えない——読めても、ログインの最後で Google に断られるので、ここで種類を伝えて断る
 */
export function parseGoogleClientJson(text: string): GoogleClientRead {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, reason: "JSON として読めません" };
  }
  if (!isPlainObject(value)) return { ok: false, reason: "Google のクライアントの JSON ではありません" };
  if (!isPlainObject(value.installed)) {
    if (isPlainObject(value.web)) {
      return {
        ok: false,
        reason: "「ウェブ アプリケーション」のクライアントです。種類を「デスクトップ アプリ」にして作り直してください",
      };
    }
    return { ok: false, reason: "Google のクライアントの JSON ではありません" };
  }
  const { client_id: clientId, client_secret: clientSecret } = value.installed;
  if (typeof clientId !== "string") return { ok: false, reason: "クライアント ID が入っていません" };
  return readGoogleClientInput({
    clientId,
    clientSecret: typeof clientSecret === "string" ? clientSecret : undefined,
  });
}

/** SecretStorage に置く文字（呼び手が置く） */
export function serializeGoogleClient(client: GoogleClientConfig): string {
  return JSON.stringify(
    client.clientSecret === undefined
      ? { clientId: client.clientId }
      : { clientId: client.clientId, clientSecret: client.clientSecret }
  );
}

/** SecretStorage から読んだ文字。壊れていれば直さず「読めない」 */
export function parseStoredGoogleClient(text: string | undefined): GoogleClientRead {
  if (text === undefined) return { ok: false, reason: "接続の設定がまだありません" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "接続の設定が読めません" };
  }
  if (!isPlainObject(value) || typeof value.clientId !== "string") {
    return { ok: false, reason: "接続の設定が読めません" };
  }
  return readGoogleClientInput({
    clientId: value.clientId,
    clientSecret: typeof value.clientSecret === "string" ? value.clientSecret : undefined,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
