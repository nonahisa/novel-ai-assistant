import { describe, expect, test } from "vitest";
import { createDriveClient } from "../../../src/core/driveApi";
import {
  IME_DRIVE_FILE_NAME,
  IME_DRIVE_FOLDER_NAME,
  buildImeSenderJson,
  checkImeExport,
  imeCoreExecutable,
  parseImeSyncInfo,
  receiveImeLearning,
  sendImeLearning,
} from "../../../src/core/imeLearningSync";
import { createFakeDrive } from "../support/fakeDrive";

/**
 * オリジナルIME の学習の同期（設計書5.10.8）。偽のドライブで往復させる。
 * **本物のエンジン（novel-ime-core）は動かさない**（作者の学習に触れない）。
 */

const enc = (text: string) => new TextEncoder().encode(text);
const exportOf = (dev: string, lines: string[] = ['{"t":1,"dev":"x","n":1,"op":"選んだ"}']) =>
  enc(`#novel-ime-sync 1 dev=${dev} from=1 to=${lines.length} lines=${lines.length}\n${lines.join("\n")}\n#end dev=${dev} to=${lines.length}\n`);

describe("エンジンの場所と sync-info", () => {
  test("IME 連動と同じ置き場の中の exe。Linux は無い", () => {
    expect(imeCoreExecutable("C:\\Users\\u\\AppData\\Local\\novel-ime", "win32")).toBe(
      "C:\\Users\\u\\AppData\\Local\\novel-ime\\novel-ime-core.exe"
    );
    expect(imeCoreExecutable("/Users/u/Library/Application Support/novel-ime/", "darwin")).toBe(
      "/Users/u/Library/Application Support/novel-ime/novel-ime-core"
    );
    expect(imeCoreExecutable("/x", "linux")).toBeUndefined();
    expect(imeCoreExecutable(undefined, "win32")).toBeUndefined();
  });

  test("sync-info の出力を読む。機械ID の形が違えば断る（ドライブのフォルダー名になる）", () => {
    expect(parseImeSyncInfo('{"machine":"m-1a2b3c","dir":"C:\\\\x\\\\記録","records":[]}\n')).toEqual({
      machineId: "m-1a2b3c",
      dir: "C:\\x\\記録",
    });
    expect(typeof parseImeSyncInfo('{"machine":"../x","dir":"d"}')).toBe("string");
    expect(typeof parseImeSyncInfo("使い方：…")).toBe("string");
  });
});

describe("写しの確かめ", () => {
  test("頭と終わりの行があり dev= がその機械なら通す。途中で切れた・別の機械・頭が無い は断る", () => {
    expect(checkImeExport(exportOf("m-aaaa"), "m-aaaa")).toBe(true);
    const cut = enc("#novel-ime-sync 1 dev=m-aaaa from=1 to=2 lines=2\n{}\n");
    expect(checkImeExport(cut, "m-aaaa")).toMatch(/終わり/);
    expect(checkImeExport(exportOf("m-bbbb"), "m-aaaa")).toMatch(/機械ID/);
    expect(checkImeExport(enc('{"t":1}\n#end dev=m-aaaa to=1\n'), "m-aaaa")).toMatch(/頭/);
  });

  test("送り手の印の形（オリジナルIME の設計書 6.3.1 の決まり）", () => {
    const text = buildImeSenderJson({ version: "1.0.26", machineId: "m-aaaa", at: new Date("2026-11-18T00:00:00Z") });
    expect(JSON.parse(text)).toEqual({ sender: "novel-ai-assistant", version: "1.0.26", machineId: "m-aaaa", at: "2026-11-18T00:00:00.000Z" });
  });
});

describe("偽のドライブで2台が往復する", () => {
  test("自分のフォルダーにだけ書き、受け取りは自分の分を読まない。同じ中身は書き直さない", async () => {
    const drive = createFakeDrive({ reportsSha256: true });
    const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
    expect(await sendImeLearning({ client, machineId: "m-desk", bytes: exportOf("m-desk") })).toEqual({ kind: "sent" });
    expect(await sendImeLearning({ client, machineId: "m-desk", bytes: exportOf("m-desk") })).toEqual({ kind: "unchanged" });
    await sendImeLearning({ client, machineId: "m-note", bytes: exportOf("m-note") });
    expect(drive.find("統合小説執筆環境", IME_DRIVE_FOLDER_NAME, "m-desk", IME_DRIVE_FILE_NAME)).toBeDefined();

    const atDesk = await receiveImeLearning({ client, machineId: "m-desk" });
    expect(atDesk.received.map((r) => r.machineId)).toEqual(["m-note"]);
    expect(new TextDecoder().decode(atDesk.received[0].bytes)).toContain("#end dev=m-note");
  });

  test("書いている途中の写し・名前の違う写しは sync-in へ渡さない（skipped）", async () => {
    const drive = createFakeDrive();
    const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
    await sendImeLearning({ client, machineId: "m-note", bytes: enc("#novel-ime-sync 1 dev=m-note\n{}\n") });
    await sendImeLearning({ client, machineId: "m-mac1", bytes: exportOf("m-note") });
    const atDesk = await receiveImeLearning({ client, machineId: "m-desk" });
    expect(atDesk.received).toEqual([]);
    expect(atDesk.skipped.map((s) => s.machineId)).toEqual(["m-mac1", "m-note"]);
  });

  test("まだ誰も送っていなければ空", async () => {
    const drive = createFakeDrive();
    const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
    expect(await receiveImeLearning({ client, machineId: "m-desk" })).toEqual({ received: [], skipped: [] });
  });
});
