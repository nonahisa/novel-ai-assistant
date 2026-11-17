import { describe, expect, test } from "vitest";
import { createDriveClient } from "../../../src/core/driveApi";
import { sendToDrive } from "../../../src/core/driveSyncEngine";
import { emptyDriveSyncRecord } from "../../../src/core/driveSyncRecord";
import { describeDriveWorkSync, runDriveWorkSync } from "../../../src/core/driveWorkSync";
import { IGNORED_PATHS } from "../../../src/core/workRegistry";
import { createFakeDrive, createFakeWork } from "../support/fakeDrive";

/**
 * 競合マーカーの入ったファイルは送らずに止める（実装ルール1・設計書5.5.3）。
 * 送ると、もう1台がマーカー入りの原稿を「新しい中身」として受け取る。
 */

const MARKED = "<<<<<<< HEAD\nこちら\n=======\nあちら\n>>>>>>> main\n";

describe("送る前の競合マーカー", () => {
  test("1つでもあれば、何も送らずに道を返す（目録もファイルも書かない）", async () => {
    const drive = createFakeDrive();
    const work = createFakeWork({ "本文/第1話.txt": "ふつう", "本文/第2話.txt": MARKED });
    const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
    const result = await sendToDrive({
      client,
      layout: { workFolderName: "w-1", deviceId: "desk-a1b2", deviceName: "デスクトップ" },
      local: work.local,
      writer: work.writer,
      record: emptyDriveSyncRecord("desk-a1b2"),
      ignoredPaths: IGNORED_PATHS,
      now: new Date("2026-11-18T00:00:00Z"),
    });
    expect(result).toEqual({ kind: "conflict_markers", paths: ["本文/第2話.txt"] });
    expect(drive.requests.filter((r) => r.op === "upload" || r.op === "update")).toHaveLength(0);
  });

  test("［保存・同期］の知らせは、送っていないことと道を先に書く", async () => {
    const drive = createFakeDrive();
    const work = createFakeWork({ "本文/第2話.txt": MARKED });
    const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
    const result = await runDriveWorkSync({
      client,
      layout: { workFolderName: "w-1", deviceId: "desk-a1b2", deviceName: "デスクトップ" },
      local: work.local,
      writer: work.writer,
      record: emptyDriveSyncRecord("desk-a1b2"),
      ignoredPaths: IGNORED_PATHS,
      now: new Date("2026-11-18T00:00:00Z"),
      sizes: new Map(),
    });
    expect(result).toEqual({ kind: "conflict_markers", paths: ["本文/第2話.txt"] });
    expect(describeDriveWorkSync("作品", result)).toMatchObject({ problem: true });
    expect(describeDriveWorkSync("作品", result).text).toMatch(/^「作品」は Google ドライブへ送っていません。.*本文\/第2話\.txt/);
  });
});
