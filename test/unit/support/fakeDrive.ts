import type { DriveFetch, DriveHttpResponse } from "../../../src/core/driveApi";
import { hashBytes } from "../../../src/core/hash";
import type { LocalWorkFiles, LocalWorkWriter, LocalWriteOutcome } from "../../../src/core/driveSyncEngine";

/**
 * Google ドライブの偽物（記憶の中）。**`fetch` の段で**まねる——
 * `createDriveClient` が組む URL・`q`・本文（multipart）をそのまま読んで答えるので、
 * 口の書式の誤りもここで落ちる。まねるのは `driveApi.ts` が使う5つの要求だけ。
 *
 * 作り物を親切にしない：知らない要求は 400 を返す（テストが通ってしまわないように）。
 */

const FOLDER = "application/vnd.google-apps.folder";

export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parent: string;
  createdTime: string;
  bytes: Uint8Array;
  trashed: boolean;
}

export interface FakeRequest {
  method: string;
  url: URL;
  /** どの操作か（`list`・`createFolder`・`upload`・`update`・`read`） */
  op: string;
}

export type FakeFault =
  | { status: number; body?: unknown }
  | "network"
  | undefined;

export interface FakeDriveOptions {
  /** 正しいアクセストークン。違えば 401 */
  token?: string;
  /** 1頁に返す数（続きの頁を試す） */
  pageLimit?: number;
  /** `sha256Checksum` を返すか（本物は「あれば」） */
  reportsSha256?: boolean;
}

export function createFakeDrive(options: FakeDriveOptions = {}) {
  const files = new Map<string, FakeDriveFile>();
  const requests: FakeRequest[] = [];
  let nextId = 1;
  let clock = Date.parse("2026-11-07T00:00:00.000Z");
  let token = options.token ?? "token-1";
  /** 要求のたびに呼ぶ。返したものを答えにする（undefined ならふつうに答える） */
  let fault: (request: FakeRequest) => FakeFault = () => undefined;

  const respond = (status: number, body: unknown): DriveHttpResponse => {
    const bytes =
      body instanceof Uint8Array ? body : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
    return {
      status,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  };

  const meta = (file: FakeDriveFile) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    createdTime: file.createdTime,
    ...(options.reportsSha256 && file.mimeType !== FOLDER ? { sha256Checksum: hashBytes(file.bytes) } : {}),
  });

  const add = (parent: string, name: string, mimeType: string, bytes: Uint8Array): FakeDriveFile => {
    clock += 1000;
    const file: FakeDriveFile = {
      id: `id-${nextId++}`,
      name,
      mimeType,
      parent,
      createdTime: new Date(clock).toISOString(),
      bytes,
      trashed: false,
    };
    files.set(file.id, file);
    return file;
  };

  const fetch: DriveFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const op = opOf(init.method, url);
    const request: FakeRequest = { method: init.method, url, op };
    requests.push(request);
    const injected = fault(request);
    if (injected === "network") throw new TypeError("fetch failed");
    if (injected) return respond(injected.status, injected.body ?? "");
    if (init.headers.Authorization !== `Bearer ${token}`) {
      return respond(401, { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } });
    }

    switch (op) {
      case "list": {
        const q = url.searchParams.get("q") ?? "";
        const parsed = parseQuery(q);
        if (!parsed) return respond(400, { error: { code: 400, message: `q を読めません: ${q}` } });
        const matched = [...files.values()].filter(
          (file) =>
            file.parent === parsed.parent &&
            !file.trashed &&
            (parsed.name === undefined || file.name === parsed.name) &&
            (parsed.mimeType === undefined || file.mimeType === parsed.mimeType)
        );
        const start = Number(url.searchParams.get("pageToken") ?? "0");
        const limit = options.pageLimit ?? 1000;
        const page = matched.slice(start, start + limit);
        const next = start + limit < matched.length ? String(start + limit) : undefined;
        return respond(200, { files: page.map(meta), ...(next ? { nextPageToken: next } : {}) });
      }
      case "createFolder": {
        const body = JSON.parse(String(init.body)) as { name: string; mimeType: string; parents: string[] };
        if (body.mimeType !== FOLDER || body.parents.length !== 1) return respond(400, "");
        return respond(200, meta(add(body.parents[0], body.name, FOLDER, new Uint8Array())));
      }
      case "upload": {
        const type = (init.headers["Content-Type"] ?? "").match(/^multipart\/related; boundary=(.+)$/);
        if (!type || !(init.body instanceof Uint8Array)) return respond(400, "");
        const parts = splitMultipart(init.body, type[1]);
        if (!parts) return respond(400, "");
        const metadata = JSON.parse(new TextDecoder().decode(parts.metadata)) as { name: string; parents: string[] };
        return respond(200, meta(add(metadata.parents[0], metadata.name, parts.mimeType, parts.media)));
      }
      case "update": {
        const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const file = files.get(id);
        if (!file) return respond(404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
        if (!(init.body instanceof Uint8Array)) return respond(400, "");
        file.bytes = init.body.slice();
        return respond(200, meta(file));
      }
      case "read": {
        const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const file = files.get(id);
        if (!file) return respond(404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
        return respond(200, file.bytes.slice());
      }
      default:
        return respond(400, { error: { code: 400, message: "知らない要求です" } });
    }
  };

  return {
    fetch,
    files,
    requests,
    accessToken: async () => token,
    setToken(value: string) {
      token = value;
    },
    setFault(next: (request: FakeRequest) => FakeFault) {
      fault = next;
    },
    clearFault() {
      fault = () => undefined;
    },
    /** 道（名前の並び）で子を探す。テストで中を覗くため */
    find(...names: string[]): FakeDriveFile | undefined {
      let parent = "root";
      let found: FakeDriveFile | undefined;
      for (const name of names) {
        found = [...files.values()]
          .filter((file) => file.parent === parent && file.name === name && !file.trashed)
          .sort((a, b) => a.createdTime.localeCompare(b.createdTime))[0];
        if (!found) return undefined;
        parent = found.id;
      }
      return found;
    },
    addRaw: add,
  };
}

export type FakeDrive = ReturnType<typeof createFakeDrive>;

function opOf(method: string, url: URL): string {
  const isUpload = url.pathname.startsWith("/upload/drive/v3/files");
  const isApi = url.pathname.startsWith("/drive/v3/files");
  if (method === "GET" && isApi && url.pathname === "/drive/v3/files") return "list";
  if (method === "GET" && isApi && url.searchParams.get("alt") === "media") return "read";
  if (method === "POST" && isApi && url.pathname === "/drive/v3/files") return "createFolder";
  if (method === "POST" && isUpload && url.searchParams.get("uploadType") === "multipart") return "upload";
  if (method === "PATCH" && isUpload && url.searchParams.get("uploadType") === "media") return "update";
  return "unknown";
}

/** `driveApi.ts` が組む形の q だけを読む。円記号の逃がしを戻す */
function parseQuery(q: string): { parent: string; name?: string; mimeType?: string } | undefined {
  const match = q.match(
    /^'((?:[^'\\]|\\.)*)' in parents and trashed = false(?: and name = '((?:[^'\\]|\\.)*)' and mimeType = '([^']*)')?$/
  );
  if (!match) return undefined;
  const unescape = (value: string) => value.replace(/\\(.)/g, "$1");
  return {
    parent: unescape(match[1]),
    name: match[2] === undefined ? undefined : unescape(match[2]),
    mimeType: match[3],
  };
}

/** multipart/related の2部を切り出す（公式の頁の形：区切りの前に --、最後に --） */
function splitMultipart(
  body: Uint8Array,
  boundary: string
): { metadata: Uint8Array; media: Uint8Array; mimeType: string } | undefined {
  const enc = new TextEncoder();
  const first = enc.encode(`--${boundary}\r\n`);
  const middle = enc.encode(`\r\n--${boundary}\r\n`);
  const last = enc.encode(`\r\n--${boundary}--\r\n`);
  const blank = enc.encode("\r\n\r\n");
  if (indexOf(body, first, 0) !== 0) return undefined;
  const metaHead = indexOf(body, blank, first.length);
  const metaEnd = indexOf(body, middle, metaHead);
  if (metaHead < 0 || metaEnd < 0) return undefined;
  const mediaHeadStart = metaEnd + middle.length;
  const mediaHead = indexOf(body, blank, mediaHeadStart);
  if (mediaHead < 0) return undefined;
  const header = new TextDecoder().decode(body.slice(mediaHeadStart, mediaHead));
  const mediaStart = mediaHead + blank.length;
  // 最後の区切りは末尾にあるはず（中身の途中の同じ並びで切らない）
  if (indexOf(body, last, body.length - last.length) !== body.length - last.length) return undefined;
  return {
    metadata: body.slice(metaHead + blank.length, metaEnd),
    media: body.slice(mediaStart, body.length - last.length),
    mimeType: header.replace(/^Content-Type: /, ""),
  };
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = Math.max(0, from); i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * 偽の作品フォルダー（記憶の中）。書く口は本物と同じ約束を守る：
 * 期待ハッシュが今の中身と合わなければ書かない・既にあるファイルへ `create` しない。
 */
export function createFakeWork(initial: Record<string, string> = {}) {
  const disk = new Map<string, Uint8Array>();
  for (const [entry, text] of Object.entries(initial)) disk.set(entry, new TextEncoder().encode(text));
  /** 書かずに断る道（未保存の文書・校閲中のまね） */
  const refuse = new Set<string>();
  /** 書く口が中身の形を変える（改行を LF へ揃える）まね */
  let normalizeEol = false;
  /**
   * 元の文の置き場（設計書5.10.7。本物は `.aiwriter/drive-sync/bases/<端末ID>/<ハッシュ>`）。
   * 作品の中身とは別に持つ（本物でも、作品の一覧・数え直しには入れない）
   */
  const bases = new Map<string, Uint8Array>();
  /** 書く口が呼ばれた直前に動かす（合わせている間に作者が書いた、のまね） */
  let beforeWrite: ((entry: string) => void) | undefined;

  const local: LocalWorkFiles = {
    list: async () => [...disk.keys()],
    read: async (entry) => disk.get(entry)?.slice(),
    listBases: async () => [...bases.keys()],
    readBase: async (hash) => bases.get(hash)?.slice(),
  };

  const put = (entry: string, bytes: Uint8Array): LocalWriteOutcome => {
    const stored = normalizeEol
      ? new TextEncoder().encode(new TextDecoder().decode(bytes).replace(/\r\n/g, "\n"))
      : bytes.slice();
    disk.set(entry, stored);
    return { ok: true, writtenHash: hashBytes(stored) };
  };

  const writer: LocalWorkWriter = {
    replace: async (entry, bytes, expectedLocalHash) => {
      beforeWrite?.(entry);
      if (refuse.has(entry)) return { ok: false, reason: "未保存の変更があります" };
      const current = disk.get(entry);
      if (!current || hashBytes(current) !== expectedLocalHash) {
        return { ok: false, reason: "読み込んだあとで変わっています" };
      }
      return put(entry, bytes);
    },
    create: async (entry, bytes) => {
      if (refuse.has(entry)) return { ok: false, reason: "未保存の変更があります" };
      if (disk.has(entry)) return { ok: false, reason: "既にあります" };
      return put(entry, bytes);
    },
    writeBase: async (hash, bytes) => {
      // 本物は `atomicWriteFile` の `create`。名前が中身のハッシュなので、既にあれば同じ中身
      if (!bases.has(hash)) bases.set(hash, bytes.slice());
      return { ok: true, writtenHash: hashBytes(bytes) };
    },
    removeBase: async (hash) => {
      bases.delete(hash);
    },
  };

  return {
    disk,
    local,
    writer,
    refuse,
    bases,
    setBeforeWrite(next: ((entry: string) => void) | undefined) {
      beforeWrite = next;
    },
    setNormalizeEol(value: boolean) {
      normalizeEol = value;
    },
    text(entry: string): string | undefined {
      const bytes = disk.get(entry);
      return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
    },
    write(entry: string, text: string) {
      disk.set(entry, new TextEncoder().encode(text));
    },
    remove(entry: string) {
      disk.delete(entry);
    },
  };
}

export type FakeWork = ReturnType<typeof createFakeWork>;
