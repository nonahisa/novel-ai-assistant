import { describe, expect, test } from "vitest";
import { createDriveClient } from "../../../src/core/driveApi";
import {
  IME_DRIVE_FILE_NAME,
  IME_DRIVE_FOLDER_NAME,
  buildImeSenderJson,
  checkImeExport,
  imeCoreExecutable,
  imeCoreExecutableCandidates,
  isImeMachineId,
  parseImeSyncInfo,
  receiveImeLearning,
  runImeLearningSync,
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
    expect(imeCoreExecutable("C:\\Users\\u\\AppData\\Local\\rittoku-ime", "win32")).toBe(
      "C:\\Users\\u\\AppData\\Local\\rittoku-ime\\rittoku-ime-core.exe"
    );
    expect(imeCoreExecutable("/Users/u/Library/Application Support/rittoku-ime/", "darwin")).toBe(
      "/Users/u/Library/Application Support/rittoku-ime/rittoku-ime-core"
    );
    expect(imeCoreExecutable("/x", "linux")).toBeUndefined();
    expect(imeCoreExecutable(undefined, "win32")).toBeUndefined();
  });

  test("エンジンの候補は新しい置き場・新しい名前を先に、古い名前も後ろに並べる", () => {
    const win = imeCoreExecutableCandidates(
      ["C:\\L\\rittoku-ime", "C:\\L\\novel-ime", undefined],
      "win32"
    );
    // 改名の版（2026-11-18 夜）の rittoku-ime-core を先に。入れたあとも古い exe は残る
    expect(win).toEqual([
      "C:\\L\\rittoku-ime\\rittoku-ime-core.exe",
      "C:\\L\\rittoku-ime\\rittoku-core.exe",
      "C:\\L\\rittoku-ime\\novel-ime-core.exe",
      "C:\\L\\novel-ime\\rittoku-ime-core.exe",
      "C:\\L\\novel-ime\\rittoku-core.exe",
      "C:\\L\\novel-ime\\novel-ime-core.exe",
    ]);
    expect(imeCoreExecutableCandidates(["/a/novel-ime/"], "darwin")).toEqual([
      "/a/novel-ime/rittoku-ime-core",
      "/a/novel-ime/rittoku-core",
      "/a/novel-ime/novel-ime-core",
    ]);
    expect(imeCoreExecutableCandidates(["/x"], "linux")).toEqual([]);
  });

  test("sync-info の出力を読む。機械ID の形が違えば断る（ドライブのフォルダー名になる）", () => {
    expect(parseImeSyncInfo('{"machine":"1a2b3c4d","dir":"C:\\\\x\\\\記録","records":[]}\n')).toEqual({
      machineId: "1a2b3c4d",
      dir: "C:\\x\\記録",
    });
    expect(typeof parseImeSyncInfo('{"machine":"../x","dir":"d"}')).toBe("string");
    expect(typeof parseImeSyncInfo("使い方：…")).toBe("string");
  });
});

describe("写しの確かめ", () => {
  test("頭と終わりの行があり dev= がその機械なら通す。途中で切れた・別の機械・頭が無い は断る", () => {
    expect(checkImeExport(exportOf("aaaaaaaa"), "aaaaaaaa")).toBe(true);
    const cut = enc("#novel-ime-sync 1 dev=aaaaaaaa from=1 to=2 lines=2\n{}\n");
    expect(checkImeExport(cut, "aaaaaaaa")).toMatch(/終わり/);
    expect(checkImeExport(exportOf("bbbbbbbb"), "aaaaaaaa")).toMatch(/機械ID/);
    expect(checkImeExport(enc('{"t":1}\n#end dev=aaaaaaaa to=1\n'), "aaaaaaaa")).toMatch(/頭/);
  });

  test("送り手の印の形（オリジナルIME の設計書 6.3.1 の決まり）", () => {
    const text = buildImeSenderJson({ version: "1.0.26", machineId: "aaaaaaaa", at: new Date("2026-11-18T00:00:00Z") });
    expect(JSON.parse(text)).toEqual({ sender: "novel-ai-assistant", version: "1.0.26", machineId: "aaaaaaaa", at: "2026-11-18T00:00:00.000Z" });
  });
});

describe("偽のドライブで2台が往復する", () => {
  test("自分のフォルダーにだけ書き、受け取りは自分の分を読まない。同じ中身は書き直さない", async () => {
    const drive = createFakeDrive({ reportsSha256: true });
    const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
    expect(await sendImeLearning({ client, machineId: "d0d0d0d0d0d0d0d0", bytes: exportOf("d0d0d0d0d0d0d0d0") })).toEqual({ kind: "sent" });
    expect(await sendImeLearning({ client, machineId: "d0d0d0d0d0d0d0d0", bytes: exportOf("d0d0d0d0d0d0d0d0") })).toEqual({ kind: "unchanged" });
    await sendImeLearning({ client, machineId: "a1a1a1a1a1a1a1a1", bytes: exportOf("a1a1a1a1a1a1a1a1") });
    expect(drive.find("統合小説執筆環境", IME_DRIVE_FOLDER_NAME, "d0d0d0d0d0d0d0d0", IME_DRIVE_FILE_NAME)).toBeDefined();

    const atDesk = await receiveImeLearning({ client, machineId: "d0d0d0d0d0d0d0d0" });
    expect(atDesk.received.map((r) => r.machineId)).toEqual(["a1a1a1a1a1a1a1a1"]);
    expect(new TextDecoder().decode(atDesk.received[0].bytes)).toContain("#end dev=a1a1a1a1a1a1a1a1");
  });

  test("書いている途中の写し・名前の違う写しは sync-in へ渡さない（skipped）", async () => {
    const drive = createFakeDrive();
    const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
    await sendImeLearning({ client, machineId: "a1a1a1a1a1a1a1a1", bytes: enc("#novel-ime-sync 1 dev=a1a1a1a1a1a1a1a1\n{}\n") });
    await sendImeLearning({ client, machineId: "c2c2c2c2c2c2c2c2", bytes: exportOf("a1a1a1a1a1a1a1a1") });
    const atDesk = await receiveImeLearning({ client, machineId: "d0d0d0d0d0d0d0d0" });
    expect(atDesk.received).toEqual([]);
    expect(atDesk.skipped.map((s) => s.machineId)).toEqual(["a1a1a1a1a1a1a1a1", "c2c2c2c2c2c2c2c2"]);
  });

  test("まだ誰も送っていなければ空", async () => {
    const drive = createFakeDrive();
    const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
    expect(await receiveImeLearning({ client, machineId: "d0d0d0d0d0d0d0d0" })).toEqual({ received: [], skipped: [] });
  });
});

describe("1回の手順の順番（偽のエンジン）", () => {
  const DESK = "d0d0d0d0d0d0d0d0";
  const NOTE = "a1a1a1a1a1a1a1a1";
  function engine(exported: Uint8Array | string) {
    const calls: string[] = [];
    return {
      calls,
      engine: {
        info: async () => {
          calls.push("info");
          return { machineId: DESK, dir: "記録" };
        },
        exportAll: async () => {
          calls.push("export");
          return exported;
        },
        importExport: async (machineId: string) => {
          calls.push(`import:${machineId}`);
        },
      },
    };
  }

  test("送れたあとだけ送り手の印を書き、ほかの機械の写しだけを sync-in へ渡す", async () => {
    const drive = createFakeDrive();
    const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
    await sendImeLearning({ client, machineId: NOTE, bytes: exportOf(NOTE) });
    const fake = engine(exportOf(DESK));
    const result = await runImeLearningSync({
      engine: fake.engine,
      client,
      writeSender: async (machineId) => {
        fake.calls.push(`sender:${machineId}`);
      },
    });
    expect(result).toEqual({ sent: true, imported: [NOTE], skipped: [] });
    expect(fake.calls).toEqual(["info", "export", `sender:${DESK}`, `import:${NOTE}`]);
    expect(drive.find("統合小説執筆環境", IME_DRIVE_FOLDER_NAME, DESK, IME_DRIVE_FILE_NAME)).toBeDefined();
  });

  test("写しが無い・頭が違う・別の機械の写し なら送らず、送り手の印も書かない（受け取りは続ける）", async () => {
    for (const exported of ["写しがありません", enc("頭の無い文\n"), exportOf(NOTE)] as const) {
      const drive = createFakeDrive();
      const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
      const fake = engine(exported);
      const result = await runImeLearningSync({
        engine: fake.engine,
        client,
        writeSender: async () => {
          fake.calls.push("sender");
        },
      });
      expect(typeof result === "string" ? result : result.sent).not.toBe(true);
      expect(fake.calls).not.toContain("sender");
      expect(drive.find("統合小説執筆環境", IME_DRIVE_FOLDER_NAME, DESK)).toBeUndefined();
    }
  });

  test("送れない（ネットが切れた）ときは印を書かずに投げる", async () => {
    const drive = createFakeDrive();
    const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
    drive.setFault(() => "network");
    const fake = engine(exportOf(DESK));
    await expect(
      runImeLearningSync({ engine: fake.engine, client, writeSender: async () => void fake.calls.push("sender") })
    ).rejects.toMatchObject({ kind: "network" });
    expect(fake.calls).not.toContain("sender");
  });

  test("機械ID の形はエンジンと同じ（16進の8〜32字）", () => {
    expect(isImeMachineId("0123456789abcdef")).toBe(true);
    expect(isImeMachineId("1234567")).toBe(false);
    expect(isImeMachineId("m-desk-01")).toBe(false);
    expect(isImeMachineId("a".repeat(33))).toBe(false);
  });
});
