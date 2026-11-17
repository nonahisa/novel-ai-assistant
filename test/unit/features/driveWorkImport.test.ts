import * as nodePath from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { Uri, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import { createDriveClient } from "../../../src/core/driveApi";
import { sendToDrive } from "../../../src/core/driveSyncEngine";
import { emptyDriveSyncRecord } from "../../../src/core/driveSyncRecord";
import { IGNORED_PATHS } from "../../../src/core/workRegistry";
import { importDriveWorkInto } from "../../../src/features/driveWorkImport";
import { createFakeDrive, createFakeWork } from "../support/fakeDrive";

/**
 * ドライブから新しいフォルダーへ作品を取り寄せる（設計書5.10.9）。**既にあるフォルダーへは
 * 絶対に取り寄せない**（GitHub から取り寄せる 5.5.11 と同じ守り）。置くのは `create` だけで、
 * 受け取りの関所（競合の印・道の照らし方）を通る。
 */

const enc = (text: string) => new TextEncoder().encode(text);
const PARENT = Uri.file(nodePath.resolve("/ds3/取り寄せ")).fsPath;
const UID = "w-2026-aaaa";

let disk: Map<string, Uint8Array>;
let drive: ReturnType<typeof createFakeDrive>;
const client = () => createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });

beforeEach(async () => {
  disk = new Map();
  workspace.fs = memoryFs(disk, {
    methods: ["createDirectory", "readFile", "writeFile", "rename", "delete", "stat", "readDirectory"],
    readDirectory: "nested",
    folderStat: { type: 2, ctime: 0, mtime: 0, size: 0 },
  });
  workspace.textDocuments.length = 0;
  drive = createFakeDrive({ reportsSha256: true });
  const work = createFakeWork({
    ".aiwriter/config.json": JSON.stringify({ title: "取り寄せる作品", workUid: UID }),
    "本文/第1話.txt": "一行目\r\n",
    ".gitignore": ".aiwriter/drive-sync/\n",
  });
  const sent = await sendToDrive({
    client: client(),
    layout: { workFolderName: UID, deviceId: "desk-a1b2", deviceName: "デスクトップ" },
    local: work.local,
    writer: work.writer,
    record: emptyDriveSyncRecord("desk-a1b2"),
    ignoredPaths: IGNORED_PATHS,
    now: new Date("2026-11-18T00:00:00Z"),
  });
  expect(sent.kind).toBe("sent");
});

describe("新しいフォルダーへ取り寄せる", () => {
  test("全部を受け取ってバイトのまま置き、この端末の控えを書く", async () => {
    const destination = nodePath.join(PARENT, "取り寄せる作品");
    const result = await importDriveWorkInto(
      { client: client(), deviceId: "note-c3d4", deviceName: "ノートPC" },
      UID,
      destination
    );
    expect(result.kind).toBe("received");
    expect([...(disk.get(nodePath.join(destination, "本文", "第1話.txt")) as Uint8Array)]).toEqual([...enc("一行目\r\n")]);
    expect(disk.has(nodePath.join(destination, ".aiwriter", "config.json"))).toBe(true);
    expect(disk.has(nodePath.join(destination, ".aiwriter", "drive-sync", "note-c3d4.json"))).toBe(true);
  });

  test("既にあるフォルダーへは取り寄せない（中身に1バイトも触れない）", async () => {
    const destination = nodePath.join(PARENT, "前からある");
    disk.set(nodePath.join(destination, "本文", "第1話.txt"), enc("手元の原稿"));
    const before = new Map(disk);
    const result = await importDriveWorkInto(
      { client: client(), deviceId: "note-c3d4", deviceName: "ノートPC" },
      UID,
      destination
    );
    expect(result.kind).toBe("exists");
    expect(disk).toEqual(before);
    expect(drive.requests.filter((r) => r.op === "read")).toHaveLength(0);
  });
});
