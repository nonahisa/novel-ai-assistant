import * as nodePath from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { Uri, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import { createDriveClient } from "../../../src/core/driveApi";
import { findDriveUnsent } from "../../../src/core/driveDestination";
import { isSendableSyncPath } from "../../../src/core/driveSyncPlan";
import { runDriveWorkSync } from "../../../src/core/driveWorkSync";
import { hashBytes } from "../../../src/core/hash";
import { DRIVE_SYNC_RECORD_IGNORE_RULE, ensureOnUseIgnoreRule } from "../../../src/core/workRegistry";
import { DRIVE_IGNORED_PATHS, readRecord, workFiles, writeRecord } from "../../../src/features/driveSync";
import { createFakeDrive } from "../support/fakeDrive";

/**
 * 製品の手元の口（`workFiles`・`readRecord`・`writeRecord`）で2台を往復させる（設計書5.10.9）。
 * 記憶の中のフォルダー2つと偽のドライブ。`syncOneWork` と同じ順（除外の行を足す → 控えを読む →
 * 送る → 受け取る → 控えを書く）で回し、次を見る：
 *
 * - 1回そろえたあと、2台とも「送っていない変更」が0件（控え・.gitignore が残らない）
 * - 2回目の送りは0件
 * - 控えの置き場（`.aiwriter/drive-sync/`）・回復先・キャッシュはドライブへ出ない
 */

const DESK = { root: Uri.file(nodePath.resolve("/ds3/デスク/作品")).fsPath, device: "desk-a1b2", name: "デスクトップ" };
const NOTE = { root: Uri.file(nodePath.resolve("/ds3/ノート/作品")).fsPath, device: "note-c3d4", name: "ノートPC" };
const enc = (text: string) => new TextEncoder().encode(text);

let disk: Map<string, Uint8Array>;
let drive: ReturnType<typeof createFakeDrive>;

beforeEach(() => {
  disk = new Map();
  workspace.fs = memoryFs(disk, {
    methods: ["createDirectory", "readFile", "writeFile", "rename", "delete", "stat", "readDirectory"],
    readDirectory: "nested",
    folderStat: { type: 2, ctime: 0, mtime: 0, size: 0 },
  });
  workspace.textDocuments.length = 0;
  drive = createFakeDrive({ reportsSha256: true });
  for (const side of [DESK, NOTE]) {
    disk.set(nodePath.join(side.root, ".aiwriter", "config.json"), enc('{"title":"作品","workUid":"w-2026-0001"}'));
  }
  disk.set(nodePath.join(DESK.root, "本文", "第1話.txt"), enc("一行目\r\n"));
  disk.set(nodePath.join(DESK.root, ".novelai-recovery", "x.bak"), enc("控え"));
  disk.set(nodePath.join(DESK.root, ".aiwriter", "cache", "c.json"), enc("{}"));
});

const workOf = (side: typeof DESK) => ({ id: side.device, title: "作品", folderPath: side.root }) as unknown as WorkEntry;

async function sync(side: typeof DESK) {
  const work = workOf(side);
  await ensureOnUseIgnoreRule(work.folderPath, DRIVE_SYNC_RECORD_IGNORE_RULE);
  const loaded = await readRecord(work, side.device);
  if (!loaded.ok) throw new Error(loaded.reason);
  const files = workFiles(work, side.device);
  const result = await runDriveWorkSync({
    client: createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined }),
    layout: { workFolderName: "w-2026-0001", deviceId: side.device, deviceName: side.name },
    local: files.local,
    writer: files.writer,
    record: loaded.record,
    ignoredPaths: DRIVE_IGNORED_PATHS,
    now: new Date("2026-11-18T09:00:00Z"),
    sizes: await files.sizes(),
  });
  if (result.kind === "done" && result.recordChanged) await writeRecord(work, side.device, result.record);
  return result;
}

async function unsent(side: typeof DESK) {
  const work = workOf(side);
  const loaded = await readRecord(work, side.device);
  if (!loaded.ok) throw new Error(loaded.reason);
  const files = workFiles(work, side.device);
  const local = new Map<string, string>();
  for (const entry of await files.local.list()) {
    const bytes = await files.local.read(entry);
    if (bytes) local.set(entry, hashBytes(bytes));
  }
  return findDriveUnsent({
    record: loaded.record,
    local,
    isSendable: (entry) => isSendableSyncPath(entry, { ownDeviceId: side.device, ignoredPaths: DRIVE_IGNORED_PATHS }),
  });
}

describe("製品の手元の口で2台を往復する", () => {
  test("1回そろえたら、2台とも送っていない変更が0件。2回目の送りは0件。控え・回復先・キャッシュは出ない", async () => {
    const first = await sync(DESK);
    expect(first.kind).toBe("done");
    const atNote = await sync(NOTE);
    expect(atNote).toMatchObject({ kind: "done", receive: { kind: "received", conflicts: [] } });
    expect([...(disk.get(nodePath.join(NOTE.root, "本文", "第1話.txt")) as Uint8Array)]).toEqual([...enc("一行目\r\n")]);
    // デスクトップがもう一度そろえる（ノートの .gitignore・config は同じ中身なので食い違いにしない）
    const again = await sync(DESK);
    expect(again).toMatchObject({ kind: "done", receive: { kind: "received", conflicts: [] } });

    expect(await unsent(DESK)).toEqual([]);
    expect(await unsent(NOTE)).toEqual([]);
    const second = await sync(DESK);
    expect(second.kind === "done" ? second.uploaded : ["?"]).toEqual([]);

    const names = [...drive.files.values()].map((file) => file.name);
    expect(names.some((name) => name.startsWith(".aiwriter/drive-sync/"))).toBe(false);
    expect(names.some((name) => name.startsWith(".novelai-recovery/"))).toBe(false);
    expect(names.some((name) => name.startsWith(".aiwriter/cache/"))).toBe(false);
    expect(names).toContain(".gitignore");
  });
});
