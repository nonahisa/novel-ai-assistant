import { describe, expect, test } from "vitest";
import * as path from "node:path";
import { createDriveClient } from "../../../src/core/driveApi";
import { sendToDrive } from "../../../src/core/driveSyncEngine";
import { emptyDriveSyncRecord } from "../../../src/core/driveSyncRecord";
import { listDriveWorks } from "../../../src/core/driveWorkImport";
import { IME_DRIVE_FOLDER_NAME, sendImeLearning } from "../../../src/core/imeLearningSync";
import { IGNORED_PATHS } from "../../../src/core/workRegistry";
import { createFakeDrive, createFakeWork } from "../support/fakeDrive";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/**
 * 作品の無い機械が、ドライブから作品を取り寄せる（設計書5.10.9）。ここは一覧づくり：
 * ドライブの `統合小説執筆環境/` の作品のフォルダー（workUid）を並べ、作品の名前は
 * いちばん新しく送った端末の `.aiwriter/config.json` の題から取る。
 */

const client = (drive: ReturnType<typeof createFakeDrive>) =>
  createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });

async function send(drive: ReturnType<typeof createFakeDrive>, uid: string, deviceId: string, title: string, at: string) {
  const work = createFakeWork({
    ".aiwriter/config.json": JSON.stringify({ title, workUid: uid }),
    "本文/第1話.txt": `${title}の本文`,
  });
  const sent = await sendToDrive({
    client: client(drive),
    layout: { workFolderName: uid, deviceId, deviceName: deviceId.startsWith("desk") ? "デスクトップ" : "ノートPC" },
    local: work.local,
    writer: work.writer,
    record: emptyDriveSyncRecord(deviceId),
    ignoredPaths: IGNORED_PATHS,
    now: new Date(at),
  });
  expect(sent.kind).toBe("sent");
}

describe("ドライブの作品の一覧", () => {
  test("作品の番号ごとに1行。名前はいちばん新しく送った端末の題。IME の置き場・番号の形でないフォルダーは出さない", async () => {
    const drive = createFakeDrive();
    await send(drive, "w-2026-aaaa", "desk-a1b2", "古い題", "2026-11-17T00:00:00Z");
    await send(drive, "w-2026-aaaa", "note-c3d4", "新しい題", "2026-11-18T00:00:00Z");
    await send(drive, "w-2026-bbbb", "desk-a1b2", "二つ目", "2026-11-18T00:00:00Z");
    await sendImeLearning({
      client: client(drive),
      machineId: "0123456789abcdef",
      bytes: new TextEncoder().encode("#novel-ime-sync 1 dev=0123456789abcdef from=0 to=0 lines=0\n#end dev=0123456789abcdef to=0\n"),
    });
    const root = drive.find("統合小説執筆環境");
    drive.addRaw(root?.id ?? "", "../外", "application/vnd.google-apps.folder", new Uint8Array());

    const works = await listDriveWorks({ client: client(drive), exclude: new Set() });
    expect(works.map((work) => [work.workUid, work.title])).toEqual([
      ["w-2026-aaaa", "新しい題"],
      ["w-2026-bbbb", "二つ目"],
    ]);
    expect(works[0].devices.map((device) => device.deviceName).sort()).toEqual(["デスクトップ", "ノートPC"]);
    expect(works.some((work) => work.workUid === IME_DRIVE_FOLDER_NAME)).toBe(false);
  });

  test("この機械に登録済みの番号は出さない。まだ何も無ければ空", async () => {
    const drive = createFakeDrive();
    expect(await listDriveWorks({ client: client(drive), exclude: new Set() })).toEqual([]);
    await send(drive, "w-2026-aaaa", "desk-a1b2", "題", "2026-11-18T00:00:00Z");
    expect(await listDriveWorks({ client: client(drive), exclude: new Set(["w-2026-aaaa"]) })).toEqual([]);
  });

  test("題の読めない作品も、番号で出す（目録が読めない端末は数えない）", async () => {
    const drive = createFakeDrive();
    const work = createFakeWork({ "本文/第1話.txt": "本文だけ" });
    await sendToDrive({
      client: client(drive),
      layout: { workFolderName: "w-2026-cccc", deviceId: "desk-a1b2", deviceName: "デスクトップ" },
      local: work.local,
      writer: work.writer,
      record: emptyDriveSyncRecord("desk-a1b2"),
      ignoredPaths: IGNORED_PATHS,
      now: new Date("2026-11-18T00:00:00Z"),
    });
    const works = await listDriveWorks({ client: client(drive), exclude: new Set() });
    expect(works).toMatchObject([{ workUid: "w-2026-cccc", title: undefined }]);
  });
});

describe("モバイル版へそのまま持っていける", () => {
  test("driveWorkImport.ts から静的にたどれる先に、vscode・node:・core/paths.ts が無い", () => {
    const reach = walkStaticImports([path.join(SRC, "core", "driveWorkImport.ts")]);
    const bare = reach.bare.map((item) => `${relativeName(item.file)} → ${item.spec}`);
    expect(bare.filter((line) => /→ (vscode|node:)/.test(line))).toEqual([]);
    const paths = path.join(SRC, "core", "paths.ts");
    expect(reach.files.has(paths) ? chainTo(reach, paths) : "").toBe("");
  });
});
