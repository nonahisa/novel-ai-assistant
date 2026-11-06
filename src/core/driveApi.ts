import { concatBytes } from "./concatBytes";

/**
 * Google Drive API の小さな口（設計書5.10。段階2、0.132.0）。
 *
 * できるのは5つだけ：フォルダーを探す・作る（無ければ）・子の一覧・
 * ファイルを読む・書く（新規と更新）。道（「本文/第1話.txt」）をフォルダーの
 * IDへ解くのは口の外（`driveSyncEngine.ts`）の仕事にした。
 *
 * **送受信は引数で渡す**（`fetch` に似た関数と、アクセストークンを返す関数）。
 * 手元の VS Code・モバイル版・テストの偽のドライブで同じ口を使うため。
 * そのため `vscode`・`node:` を import しない（`driveApi.test.ts` が見張る）。
 * `core/logger.ts` も vscode を読むので使わず、ログは呼び手の `log` へ渡す。
 *
 * ## 公式の頁で確かめた所（2026-11-07、developers.google.com/workspace/drive/api）
 *
 * - 一覧：`GET https://www.googleapis.com/drive/v3/files`、`q` に
 *   `'<ID>' in parents and trashed = false`、`name = '…'`、フォルダーは
 *   `mimeType = 'application/vnd.google-apps.folder'`。名前の `'` と円記号は
 *   円記号で逃がす。続きは `pageToken`／`nextPageToken`（無ければ終わり）。
 *   `pageSize` の上限は1000。`fields` は `nextPageToken, files(id, name)` の形
 * - フォルダーを作る：`POST https://www.googleapis.com/drive/v3/files` に
 *   `name`・`mimeType`・`parents`（親のIDの配列）
 * - 新規：`POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`。
 *   `multipart/related; boundary=…`、1部目が `application/json; charset=UTF-8` の
 *   項目、2部目が中身。区切りの前に `--`、最後の区切りの後ろにも `--`。5MB以下
 * - 更新：`PATCH https://www.googleapis.com/upload/drive/v3/files/{ID}`、
 *   `uploadType=media` は中身だけ（項目なし）
 * - 読む：`GET https://www.googleapis.com/drive/v3/files/{ID}?alt=media`
 * - エラーの本文は `{ error: { code, message, errors: [{ reason, … }] } }`。
 *   401 `authError` はトークンを更新、403 の `storageQuotaExceeded`・
 *   `userRateLimitExceeded`・`rateLimitExceeded`・`insufficientFilePermissions`・
 *   `appNotAuthorizedToFile`、404 `notFound`、429、5xx は指数で待って再試行
 * - File の `sha256Checksum` は「あれば」入る（Drive に中身を持つファイルだけ）。
 *   `createdTime` は RFC 3339
 *
 * ## 見立て（確かめていない）
 *
 * - `sha256Checksum` の表記が16進の小文字であること（頁に書いていない）。
 *   違っていても、合わなければ中身を読んで確かめる道へ落ちるだけにしてある
 * - 親に `'root'`（マイドライブ）を使えること
 * - 名前に「/」を含めてよいこと（道をそのまま名前にしている。`driveSyncEngine.ts`）
 * - 「5MB」が 5×1000×1000 か 5×1024×1024 か。小さいほうで止める
 *
 * ## 失敗の扱い（CLAUDE.md 規則5）
 *
 * - **失敗から学ばない**：失敗したから次から別の書き方をする、という覚え方をしない
 * - **エラー文（`message`）から原因を当てない**。分けるのは状態の番号と、
 *   公式の頁が並べている `reason` の符号だけ
 * - **HTTP 400 を「要求の形が悪い」と決めつけない**：400 は `unknown` に入れ、
 *   本文をログへ残す
 * - **鍵をログに出さない**：アクセストークンは URL に入れず、ヘッダーはログに書かない。
 *   本文の抜粋もトークンらしい文字列を伏せる（`redactTokens`）
 * - 種別ごとに作者の次の操作を1つ（`driveNextAction`）
 */

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/** 一度に送れる大きさ（multipart・media の上限は 5MB。小さいほうの読みで止める） */
export const DRIVE_SIMPLE_UPLOAD_LIMIT = 5 * 1000 * 1000;

/** 一覧で受け取る項目。ここに無い項目は使わない */
const FILE_FIELDS = "id, name, mimeType, createdTime, sha256Checksum";

/** `fetch` の応答のうち、ここで使う所だけ */
export interface DriveHttpResponse {
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** `fetch` に似た送受信。本物の `fetch` をそのまま渡せる形 */
export type DriveFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }
) => Promise<DriveHttpResponse>;

/**
 * アクセストークンを返す。`forceRefresh` が true なら、持っているものが
 * 期限内でも更新してから返す（401 を受けたあとの1回だけ使う）
 */
export type DriveAccessTokenSource = (options: { forceRefresh: boolean }) => Promise<string>;

export interface DriveFileEntry {
  id: string;
  name: string;
  mimeType: string;
  createdTime?: string;
  sha256Checksum?: string;
}

export type DriveErrorKind =
  /** 送れなかった（ネットが無い・名前が引けない等。fetch が例外を投げた） */
  | "network"
  /** 401。トークンを更新しても通らなかった */
  | "auth_expired"
  /** 403 の権限の符号（`insufficientFilePermissions`・`appNotAuthorizedToFile`） */
  | "permission"
  /** 403 `storageQuotaExceeded` */
  | "storage_full"
  /** 429、403 の `userRateLimitExceeded`・`rateLimitExceeded`。待っても通らなかった */
  | "rate_limited"
  /** 404 */
  | "not_found"
  /** 5xx。待っても通らなかった */
  | "server"
  /** 送る前に止めた（5MB を超える） */
  | "too_large"
  /** 2xx だが、応答が読めない（IDが無い等） */
  | "bad_response"
  /** 上のどれでもない（400 を含む。本文はログに残す） */
  | "unknown";

export class DriveApiError extends Error {
  constructor(
    readonly kind: DriveErrorKind,
    readonly detail: {
      status?: number;
      reason?: string;
      /** 伏せ字にした本文の抜粋（ログ用。画面には出さない） */
      bodyExcerpt?: string;
      operation: string;
    }
  ) {
    super(`${detail.operation}: ${kind}${detail.status ? ` (HTTP ${detail.status})` : ""}`);
    this.name = "DriveApiError";
  }
}

/** 種別ごとの、作者が次にする操作（1つ） */
export function driveNextAction(kind: DriveErrorKind): string {
  switch (kind) {
    case "network":
      return "ネットにつながっているか確かめてから、もう一度［保存・同期］を押してください。";
    case "auth_expired":
      return "Google へのログインをやり直してください。";
    case "permission":
      return "Google の許可の画面で、ファイルへの許可をもう一度与えてください。";
    case "storage_full":
      return "Google ドライブの空きを増やしてから、もう一度［保存・同期］を押してください。";
    case "rate_limited":
    case "server":
      return "しばらく待ってから、もう一度［保存・同期］を押してください。";
    case "not_found":
      return "Google ドライブの画面で「統合小説執筆環境」のフォルダーが消えたり動いたりしていないか確かめてください。";
    case "too_large":
      return "5MB を超えるファイルはまだ送れません。送らないものへ入れるか、分けてください。";
    case "bad_response":
    case "unknown":
      return "ログを開いて、記録された内容を確かめてください。";
  }
}

/** 本文の抜粋に混ざったトークンらしい文字列を伏せる（Google の形の見立て） */
export function redactTokens(text: string): string {
  // 伏せ字は記号を重ねない（画面の文字列の網が Markdown の強調と読むため）
  return text
    .replace(/ya29\.[0-9A-Za-z_-]+/g, "ya29.(伏せ字)")
    .replace(/1\/\/[0-9A-Za-z_-]+/g, "1//(伏せ字)")
    .replace(/(Bearer\s+)[0-9A-Za-z._~+/=-]+/gi, "$1(伏せ字)");
}

/** `q` の中の文字列を逃がす（公式の頁：`'` と円記号を円記号で） */
export function escapeDriveQueryValue(value: string): string {
  const backslash = String.fromCharCode(0x5c);
  return value.split(backslash).join(backslash + backslash).split("'").join(backslash + "'");
}

export interface DriveClient {
  /** 親の下の、その名前のフォルダー（ごみ箱を除く）。作った順（古い順） */
  findFolders(parentId: string, name: string): Promise<DriveFileEntry[]>;
  /**
   * 親の下にその名前のフォルダーが無ければ作る。**同じ名前が2つ以上あれば
   * いちばん古いものを使う**（2台が同時に初めて送ると2つできうる。どちらの
   * 端末も同じものを選ぶように）。`duplicates` は見つかった数−1
   */
  ensureFolder(parentId: string, name: string): Promise<{ id: string; duplicates: number }>;
  /** 子の一覧（ごみ箱を除く）。続きの頁を最後まで読む */
  listChildren(folderId: string): Promise<DriveFileEntry[]>;
  readFile(fileId: string): Promise<Uint8Array>;
  createFile(parentId: string, name: string, bytes: Uint8Array, mimeType?: string): Promise<DriveFileEntry>;
  updateFile(fileId: string, bytes: Uint8Array): Promise<DriveFileEntry>;
}

export interface DriveClientOptions {
  fetch: DriveFetch;
  accessToken: DriveAccessTokenSource;
  /** ログの1行（呼び手が `logLine` 等へつなぐ）。鍵は入れない */
  log?: (line: string) => void;
  /** 待つ（テストでは待たずに数える） */
  sleep?: (ms: number) => Promise<void>;
  /** レート上限・5xx のときの再試行の回数（最初の1回を除く）。既定3 */
  maxRetries?: number;
}

const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

export function createDriveClient(options: DriveClientOptions): DriveClient {
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;

  /**
   * 1つの要求を送る。401 は1回だけトークンを更新して送り直し、レート上限と
   * 5xx は指数で待って `maxRetries` 回まで。**ほかの失敗は送り直さない**
   * （同じものを送っても通らない。原因を推して形を変えて送ることもしない）
   */
  async function send(
    operation: string,
    method: string,
    url: string,
    extra: { headers?: Record<string, string>; body?: Uint8Array | string } = {}
  ): Promise<DriveHttpResponse> {
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      const token = await options.accessToken({ forceRefresh: refreshed });
      let response: DriveHttpResponse;
      try {
        response = await options.fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(extra.headers ?? {}) },
          body: extra.body,
        });
      } catch (error) {
        // fetch の例外の文は環境ごとに違うので、原因の言い当てに使わない。種類の名前だけ残す
        log(`[drive] ${operation}: 送れませんでした（${error instanceof Error ? error.name : typeof error}）`);
        throw new DriveApiError("network", { operation });
      }
      if (response.status >= 200 && response.status < 300) return response;

      const bodyText = await safeText(response);
      const reason = errorReason(bodyText);
      const bodyExcerpt = redactTokens(bodyText).slice(0, 400);
      log(
        `[drive] ${operation}: HTTP ${response.status}${reason ? ` ${reason}` : ""} ${bodyExcerpt}`
      );
      const kind = classify(response.status, reason);

      if (kind === "auth_expired" && !refreshed) {
        refreshed = true;
        continue;
      }
      if ((kind === "rate_limited" || kind === "server") && attempt < maxRetries) {
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
        attempt += 1;
        continue;
      }
      throw new DriveApiError(kind, { status: response.status, reason, bodyExcerpt, operation });
    }
  }

  async function sendJson(
    operation: string,
    method: string,
    url: string,
    extra: { headers?: Record<string, string>; body?: Uint8Array | string } = {}
  ): Promise<unknown> {
    const response = await send(operation, method, url, extra);
    const text = await safeText(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      log(`[drive] ${operation}: 応答がJSONとして読めません ${redactTokens(text).slice(0, 400)}`);
      throw new DriveApiError("bad_response", { status: response.status, operation });
    }
  }

  async function list(operation: string, q: string): Promise<DriveFileEntry[]> {
    const out: DriveFileEntry[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const params = new URLSearchParams({
        q,
        pageSize: "1000",
        fields: `nextPageToken, files(${FILE_FIELDS})`,
      });
      if (pageToken) params.set("pageToken", pageToken);
      const value = await sendJson(operation, "GET", `${API}?${params.toString()}`);
      if (!isPlainObject(value) || !Array.isArray(value.files)) {
        throw new DriveApiError("bad_response", { operation });
      }
      for (const item of value.files) {
        const entry = readEntry(item);
        if (!entry) throw new DriveApiError("bad_response", { operation });
        out.push(entry);
      }
      if (typeof value.nextPageToken !== "string" || value.nextPageToken === "") return out;
      pageToken = value.nextPageToken;
    }
  }

  async function entryFrom(operation: string, value: unknown): Promise<DriveFileEntry> {
    const entry = readEntry(value);
    if (!entry) throw new DriveApiError("bad_response", { operation });
    return entry;
  }

  const client: DriveClient = {
    async findFolders(parentId, name) {
      const q =
        `'${escapeDriveQueryValue(parentId)}' in parents and trashed = false` +
        ` and name = '${escapeDriveQueryValue(name)}'` +
        ` and mimeType = '${DRIVE_FOLDER_MIME}'`;
      const found = await list("フォルダーを探す", q);
      return found.sort(compareDriveEntriesByAge);
    },

    async ensureFolder(parentId, name) {
      const found = await client.findFolders(parentId, name);
      if (found.length > 0) return { id: found[0].id, duplicates: found.length - 1 };
      const params = new URLSearchParams({ fields: FILE_FIELDS });
      const created = await sendJson("フォルダーを作る", "POST", `${API}?${params.toString()}`, {
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME, parents: [parentId] }),
      });
      return { id: (await entryFrom("フォルダーを作る", created)).id, duplicates: 0 };
    },

    async listChildren(folderId) {
      return list("一覧を読む", `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`);
    },

    async readFile(fileId) {
      const response = await send(
        "ファイルを読む",
        "GET",
        `${API}/${encodeURIComponent(fileId)}?alt=media`
      );
      return new Uint8Array(await response.arrayBuffer());
    },

    async createFile(parentId, name, bytes, mimeType = "application/octet-stream") {
      const operation = "ファイルを置く";
      if (bytes.byteLength > DRIVE_SIMPLE_UPLOAD_LIMIT) {
        throw new DriveApiError("too_large", { operation });
      }
      const boundary = chooseBoundary(bytes);
      const metadata = JSON.stringify({ name, parents: [parentId] });
      const body = concat([
        utf8(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
            `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
        ),
        bytes,
        utf8(`\r\n--${boundary}--\r\n`),
      ]);
      const params = new URLSearchParams({ uploadType: "multipart", fields: FILE_FIELDS });
      const value = await sendJson(operation, "POST", `${UPLOAD}?${params.toString()}`, {
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      return entryFrom(operation, value);
    },

    async updateFile(fileId, bytes) {
      const operation = "ファイルを書き換える";
      if (bytes.byteLength > DRIVE_SIMPLE_UPLOAD_LIMIT) {
        throw new DriveApiError("too_large", { operation });
      }
      const params = new URLSearchParams({ uploadType: "media", fields: FILE_FIELDS });
      const value = await sendJson(
        operation,
        "PATCH",
        `${UPLOAD}/${encodeURIComponent(fileId)}?${params.toString()}`,
        { headers: { "Content-Type": "application/octet-stream" }, body: bytes }
      );
      return entryFrom(operation, value);
    },
  };
  return client;
}

/**
 * 状態の番号と `reason` の符号で種別を決める。**`message` の文は見ない**。
 * 400 は `unknown`（規則5：要求の形が悪いと決めつけない）
 */
function classify(status: number, reason: string | undefined): DriveErrorKind {
  if (status === 401) return "auth_expired";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 500 && status < 600) return "server";
  if (status === 403) {
    if (reason === "storageQuotaExceeded") return "storage_full";
    if (reason === "userRateLimitExceeded" || reason === "rateLimitExceeded") return "rate_limited";
    if (reason === "insufficientFilePermissions" || reason === "appNotAuthorizedToFile") {
      return "permission";
    }
  }
  return "unknown";
}

/** 本文の `error.errors[0].reason`。読めなければ undefined */
function errorReason(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value) || !isPlainObject(value.error)) return undefined;
    const errors = value.error.errors;
    if (!Array.isArray(errors) || errors.length === 0 || !isPlainObject(errors[0])) return undefined;
    return typeof errors[0].reason === "string" ? errors[0].reason : undefined;
  } catch {
    return undefined;
  }
}

async function safeText(response: DriveHttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function readEntry(value: unknown): DriveFileEntry | undefined {
  if (!isPlainObject(value)) return undefined;
  const { id, name, mimeType, createdTime, sha256Checksum } = value;
  if (typeof id !== "string" || id === "" || typeof name !== "string") return undefined;
  return {
    id,
    name,
    mimeType: typeof mimeType === "string" ? mimeType : "",
    createdTime: typeof createdTime === "string" ? createdTime : undefined,
    sha256Checksum: typeof sha256Checksum === "string" ? sha256Checksum : undefined,
  };
}

/** 作った順（古い順）。時刻が無い・同じならIDの順（どの端末でも同じ答えになるように） */
export function compareDriveEntriesByAge(left: DriveFileEntry, right: DriveFileEntry): number {
  const l = left.createdTime ? Date.parse(left.createdTime) : Number.POSITIVE_INFINITY;
  const r = right.createdTime ? Date.parse(right.createdTime) : Number.POSITIVE_INFINITY;
  if (l !== r) return l < r ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * 中身に現れない区切りを選ぶ。区切りの文字列が中身に含まれると、
 * 受け取る側が中身の途中で切ってしまう（固定の区切りでは原稿次第で壊れる）
 */
function chooseBoundary(bytes: Uint8Array): string {
  for (let n = 0; ; n++) {
    const candidate = `novelai-drive-${n}`;
    if (!includesBytes(bytes, utf8(candidate))) return candidate;
  }
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(parts: Uint8Array[]): Uint8Array {
  return parts.reduce((joined, part) => concatBytes(joined, part), new Uint8Array(0));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
