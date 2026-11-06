import { describe, expect, test } from "vitest";
import * as path from "node:path";
import {
  DRIVE_SIMPLE_UPLOAD_LIMIT,
  DriveApiError,
  createDriveClient,
  driveNextAction,
  escapeDriveQueryValue,
  redactTokens,
  type DriveErrorKind,
} from "../../../src/core/driveApi";
import { createFakeDrive, type FakeDrive } from "../support/fakeDrive";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/**
 * Drive API の小さな口（設計書5.10。段階2）。偽のドライブは `fetch` の段で
 * まねるので、組んだ URL・q・multipart の書式の誤りもここで落ちる。
 */

function clientFor(drive: FakeDrive, extra: { log?: string[]; sleeps?: number[]; refreshes?: boolean[] } = {}) {
  return createDriveClient({
    fetch: drive.fetch,
    accessToken: async ({ forceRefresh }) => {
      extra.refreshes?.push(forceRefresh);
      return drive.accessToken();
    },
    log: (line) => extra.log?.push(line),
    sleep: async (ms) => {
      extra.sleeps?.push(ms);
    },
  });
}

async function failureOf(promise: Promise<unknown>): Promise<DriveApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DriveApiError) return error;
    throw error;
  }
  throw new Error("失敗しませんでした");
}

describe("フォルダー・一覧・読み書き", () => {
  test("無ければ作り、2回目は探して同じものを返す", async () => {
    const drive = createFakeDrive();
    const client = clientFor(drive);
    const first = await client.ensureFolder("root", "統合小説執筆環境");
    const second = await client.ensureFolder("root", "統合小説執筆環境");
    expect(second).toEqual({ id: first.id, duplicates: 0 });
    expect(drive.requests.filter((r) => r.op === "createFolder")).toHaveLength(1);
  });

  test("一覧の q と fields は公式の頁の形そのもの", async () => {
    const drive = createFakeDrive();
    const client = clientFor(drive);
    await client.findFolders("root", "統合小説執筆環境");
    await client.listChildren("id-9");
    const [find, list] = drive.requests;
    expect(find.url.searchParams.get("q")).toBe(
      "'root' in parents and trashed = false and name = '統合小説執筆環境' and mimeType = 'application/vnd.google-apps.folder'"
    );
    expect(list.url.searchParams.get("q")).toBe("'id-9' in parents and trashed = false");
    expect(list.url.searchParams.get("fields")).toBe(
      "nextPageToken, files(id, name, mimeType, createdTime, sha256Checksum)"
    );
    expect(list.url.searchParams.get("pageSize")).toBe("1000");
    // トークンは URL に入れない
    expect(list.url.toString()).not.toContain("token-1");
  });

  test("名前の ' と円記号は円記号で逃がす（作品名にアポストロフィがあっても探せる）", async () => {
    const backslash = String.fromCharCode(0x5c);
    expect(escapeDriveQueryValue(`It's${backslash}x`)).toBe(`It${backslash}'s${backslash}${backslash}x`);
    const drive = createFakeDrive();
    const client = clientFor(drive);
    const name = `作者's ${backslash}メモ`;
    const made = await client.ensureFolder("root", name);
    expect(await client.ensureFolder("root", name)).toEqual({ id: made.id, duplicates: 0 });
  });

  test("一覧の続きの頁を最後まで読む", async () => {
    const drive = createFakeDrive({ pageLimit: 2 });
    const client = clientFor(drive);
    const folder = await client.ensureFolder("root", "x");
    for (let i = 0; i < 5; i++) await client.createFile(folder.id, `f${i}.txt`, new Uint8Array([i]));
    const listed = await client.listChildren(folder.id);
    expect(listed.map((entry) => entry.name).sort()).toEqual(["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
    expect(drive.requests.filter((r) => r.op === "list" && r.url.searchParams.get("q")?.includes(folder.id))).toHaveLength(3);
  });

  test("置いて・読んで・書き換える。中身に区切りの文字列があっても壊れない", async () => {
    const drive = createFakeDrive();
    const client = clientFor(drive);
    const folder = await client.ensureFolder("root", "x");
    // 区切りの候補そのものを本文に含める
    const tricky = new TextEncoder().encode("前置き\r\n--novelai-drive-0\r\n本文\r\n--novelai-drive-0--\r\n");
    const created = await client.createFile(folder.id, "本文/第1話.txt", tricky);
    expect(created.name).toBe("本文/第1話.txt");
    expect(await client.readFile(created.id)).toEqual(tricky);
    const next = new TextEncoder().encode("書き直した");
    await client.updateFile(created.id, next);
    expect(await client.readFile(created.id)).toEqual(next);
    const upload = drive.requests.find((r) => r.op === "upload");
    expect(upload?.url.searchParams.get("uploadType")).toBe("multipart");
  });

  test("5MB を超えるものは送らずに止める", async () => {
    const drive = createFakeDrive();
    const client = clientFor(drive);
    const before = drive.requests.length;
    const error = await failureOf(client.createFile("root", "大きい.bin", new Uint8Array(DRIVE_SIMPLE_UPLOAD_LIMIT + 1)));
    expect(error.kind).toBe("too_large");
    expect(drive.requests.length).toBe(before);
  });

  test("同じ名前のフォルダーが2つあれば古いほうを使い、重なった数を返す", async () => {
    const drive = createFakeDrive();
    const older = drive.addRaw("root", "統合小説執筆環境", "application/vnd.google-apps.folder", new Uint8Array());
    drive.addRaw("root", "統合小説執筆環境", "application/vnd.google-apps.folder", new Uint8Array());
    const client = clientFor(drive);
    expect(await client.ensureFolder("root", "統合小説執筆環境")).toEqual({ id: older.id, duplicates: 1 });
  });
});

describe("失敗の扱い（規則5）", () => {
  const cases: {
    label: string;
    status: number;
    reason?: string;
    kind: DriveErrorKind;
    retried: boolean;
  }[] = [
    { label: "403 空き容量", status: 403, reason: "storageQuotaExceeded", kind: "storage_full", retried: false },
    { label: "403 利用者のレート", status: 403, reason: "userRateLimitExceeded", kind: "rate_limited", retried: true },
    { label: "403 計画のレート", status: 403, reason: "rateLimitExceeded", kind: "rate_limited", retried: true },
    { label: "403 書く権限", status: 403, reason: "insufficientFilePermissions", kind: "permission", retried: false },
    { label: "403 アプリの許可", status: 403, reason: "appNotAuthorizedToFile", kind: "permission", retried: false },
    { label: "403 知らない符号", status: 403, reason: "domainPolicy", kind: "unknown", retried: false },
    { label: "404", status: 404, reason: "notFound", kind: "not_found", retried: false },
    { label: "429", status: 429, reason: "rateLimitExceeded", kind: "rate_limited", retried: true },
    { label: "500", status: 500, kind: "server", retried: true },
    { label: "503", status: 503, kind: "server", retried: true },
    // 400 を「要求の形が悪い」と決めつけない。符号が badRequest でも unknown
    { label: "400 badRequest", status: 400, reason: "badRequest", kind: "unknown", retried: false },
    { label: "400 本文なし", status: 400, kind: "unknown", retried: false },
  ];

  test.each(cases)("$label → $kind", async ({ status, reason, kind, retried }) => {
    const drive = createFakeDrive();
    const sleeps: number[] = [];
    const log: string[] = [];
    const client = clientFor(drive, { sleeps, log });
    drive.setFault(() => ({
      status,
      body: reason
        ? { error: { code: status, message: "ya29.secretTOKEN を含む文", errors: [{ reason }] } }
        : "",
    }));
    const error = await failureOf(client.listChildren("root"));
    expect(error.kind).toBe(kind);
    expect(error.detail.status).toBe(status);
    // 待って送り直すのはレート上限と 5xx だけ。3回まで、1秒・2秒・4秒
    expect(sleeps).toEqual(retried ? [1000, 2000, 4000] : []);
    expect(drive.requests).toHaveLength(retried ? 4 : 1);
    // 本文はログへ残すが、トークンらしいものは伏せる
    expect(log.join("\n")).toContain(`HTTP ${status}`);
    expect(log.join("\n")).not.toContain("secretTOKEN");
    expect(driveNextAction(kind).length).toBeGreaterThan(0);
  });

  test("待っている間に通れば成功（2回目で通る）", async () => {
    const drive = createFakeDrive();
    let calls = 0;
    drive.setFault(() => (calls++ === 0 ? { status: 503 } : undefined));
    const client = clientFor(drive);
    await expect(client.listChildren("root")).resolves.toEqual([]);
  });

  test("401 は一度だけトークンを更新して送り直す。通れば成功", async () => {
    const drive = createFakeDrive();
    const refreshes: boolean[] = [];
    let first = true;
    const client = createDriveClient({
      fetch: drive.fetch,
      accessToken: async ({ forceRefresh }) => {
        refreshes.push(forceRefresh);
        if (first) {
          first = false;
          return "古いトークン";
        }
        return drive.accessToken();
      },
    });
    await expect(client.listChildren("root")).resolves.toEqual([]);
    expect(refreshes).toEqual([false, true]);
  });

  test("更新しても 401 なら auth_expired（それ以上は送らない）", async () => {
    const drive = createFakeDrive();
    const refreshes: boolean[] = [];
    drive.setFault(() => ({ status: 401, body: { error: { code: 401, errors: [{ reason: "authError" }] } } }));
    const error = await failureOf(clientFor(drive, { refreshes }).listChildren("root"));
    expect(error.kind).toBe("auth_expired");
    expect(refreshes).toEqual([false, true]);
    expect(drive.requests).toHaveLength(2);
  });

  test("送れなかった（fetch が投げた）→ network。送り直さない", async () => {
    const drive = createFakeDrive();
    drive.setFault(() => "network");
    const error = await failureOf(clientFor(drive).listChildren("root"));
    expect(error.kind).toBe("network");
    expect(drive.requests).toHaveLength(1);
  });

  test("2xx でも形が違えば bad_response", async () => {
    const drive = createFakeDrive();
    drive.setFault(() => ({ status: 200, body: "<html>" }));
    expect((await failureOf(clientFor(drive).listChildren("root"))).kind).toBe("bad_response");
    drive.setFault(() => ({ status: 200, body: { files: [{ name: "IDが無い" }] } }));
    expect((await failureOf(clientFor(drive).listChildren("root"))).kind).toBe("bad_response");
  });

  test("ログに Authorization の値を書かない", async () => {
    const drive = createFakeDrive({ token: "ya29.abcDEF" });
    const log: string[] = [];
    drive.setFault(() => ({ status: 500 }));
    await failureOf(clientFor(drive, { log }).listChildren("root"));
    expect(log.join("\n")).not.toContain("abcDEF");
  });

  test("種別ごとの次の操作は1つずつで、直し方の違うものは文も違う", () => {
    const kinds: DriveErrorKind[] = [
      "network", "auth_expired", "permission", "storage_full", "rate_limited",
      "not_found", "server", "too_large", "bad_response", "unknown",
    ];
    for (const kind of kinds) expect(driveNextAction(kind)).toMatch(/。$/);
    const distinct = new Set(["network", "auth_expired", "permission", "storage_full", "rate_limited", "not_found", "too_large", "unknown"].map((k) => driveNextAction(k as DriveErrorKind)));
    expect(distinct.size).toBe(8);
    // 開発の内輪の呼び名を出さない
    for (const kind of kinds) expect(driveNextAction(kind)).not.toContain("母艦");
  });

  test("トークンらしい文字列を伏せる", () => {
    expect(redactTokens("access ya29.A0AfH6SM-x_y and 1//0gAbc-_d and Bearer abc.def")).toBe(
      "access ya29.(伏せ字) and 1//(伏せ字) and Bearer (伏せ字)"
    );
  });
});

describe("モバイル版へそのまま持っていける（vscode・node:・paths を読まない）", () => {
  test("driveApi.ts から静的にたどれる先に、vscode・node: ・core/paths.ts が無い", () => {
    const reach = walkStaticImports([path.join(SRC, "core", "driveApi.ts")]);
    const bare = reach.bare.map((item) => `${relativeName(item.file)} → ${item.spec}`);
    expect(bare.filter((line) => /→ (vscode|node:)/.test(line))).toEqual([]);
    const paths = path.join(SRC, "core", "paths.ts");
    expect(reach.files.has(paths) ? chainTo(reach, paths) : "").toBe("");
  });
});
