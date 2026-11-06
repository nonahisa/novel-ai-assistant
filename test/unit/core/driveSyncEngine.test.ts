import { describe, expect, test } from "vitest";
import * as path from "node:path";
import { createDriveClient } from "../../../src/core/driveApi";
import {
  applyDriveConflictChoice,
  receiveFromDrive,
  sendToDrive,
  type DriveReceiveResult,
  type DriveSendResult,
} from "../../../src/core/driveSyncEngine";
import type { DriveManifest } from "../../../src/core/driveSyncPlan";
import { emptyDriveSyncRecord, type DriveSyncRecord } from "../../../src/core/driveSyncRecord";
import { IGNORED_PATHS } from "../../../src/core/workRegistry";
import { createFakeDrive, createFakeWork, type FakeDrive, type FakeWork } from "../support/fakeDrive";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

/**
 * 送る・受け取るの組み立て（設計書5.10。段階2）。偽のドライブ（`fetch` の段の
 * まね）と偽の作品フォルダー2つで往復させる。
 *
 * **見逃し（食い違いを素通り）と誤検出（訊かなくてよいものを訊く）の両方を数える**
 * （段階1と同じ）。往復の場面ごとに「作者に訊くべき食い違いの道」を正解として書き、
 * 最後の試験で場面をまとめて数える。
 */

const EP1 = "本文/第1話.txt";
const EP2 = "本文/第2話.txt";

interface Device {
  id: string;
  work: FakeWork;
  record: DriveSyncRecord;
  peerManifest?: DriveManifest;
  send(): Promise<DriveSendResult>;
  receive(): Promise<DriveReceiveResult>;
}

function makeDevice(drive: FakeDrive, id: string, name: string, initial: Record<string, string> = {}): Device {
  const work = createFakeWork(initial);
  const client = createDriveClient({ fetch: drive.fetch, accessToken: drive.accessToken, sleep: async () => undefined });
  const layout = { workFolderName: "作品-0001", deviceId: id, deviceName: name };
  const device: Device = {
    id,
    work,
    record: emptyDriveSyncRecord(id),
    async send() {
      const result = await sendToDrive({
        client,
        layout,
        local: work.local,
        record: device.record,
        ignoredPaths: IGNORED_PATHS,
        now: new Date("2026-11-07T12:00:00.000Z"),
        peerManifest: device.peerManifest,
      });
      if (result.kind === "sent") device.record = result.record;
      return result;
    },
    async receive() {
      const result = await receiveFromDrive({
        client,
        layout,
        local: work.local,
        writer: work.writer,
        record: device.record,
        ignoredPaths: IGNORED_PATHS,
      });
      if (result.kind === "received") {
        device.record = result.record;
        device.peerManifest = result.peerManifest;
      }
      return result;
    },
  };
  return device;
}

function received(result: DriveReceiveResult) {
  expect(result.kind).toBe("received");
  if (result.kind !== "received") throw new Error(result.kind);
  return result;
}

/** 場面ごとの「訊くべき食い違い」と「実際に訊いたもの」（最後にまとめて数える） */
const tally: { scene: string; expected: string[]; actual: string[] }[] = [];
function countConflicts(scene: string, result: DriveReceiveResult, expected: string[]) {
  const actual = result.kind === "received" ? result.conflicts.map((c) => c.decision.path).sort() : [];
  tally.push({ scene, expected: [...expected].sort(), actual });
  expect(actual).toEqual([...expected].sort());
}

describe("送る → 受け取る", () => {
  test("A が送った作品を B が受け取る。2回目は何も書かず、送り直しも書かない", async () => {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "第1話の本文", [EP2]: "第2話の本文" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");

    const sent = await a.send();
    expect(sent).toMatchObject({ kind: "sent", uploaded: [EP1, EP2], unchanged: 0 });
    // 目録はファイルより後に書く
    const order = drive.requests.filter((r) => r.op === "upload").map((r) => r.url.toString());
    expect(order).toHaveLength(3);
    expect(drive.find("統合小説執筆環境", "作品-0001", "desk-a1b2", "manifest.json")).toBeDefined();
    expect(drive.find("統合小説執筆環境", "作品-0001", "desk-a1b2", "files", EP1)).toBeDefined();

    const first = received(await b.receive());
    countConflicts("はじめて受け取る", first, []);
    expect(first.written.sort()).toEqual([EP1, EP2]);
    expect(b.work.text(EP1)).toBe("第1話の本文");

    const again = received(await b.receive());
    countConflicts("もう一度受け取る", again, []);
    expect(again.written).toEqual([]);

    const resent = await a.send();
    expect(resent).toMatchObject({ kind: "sent", uploaded: [], unchanged: 2 });
  });

  test("B が書き足して送ると、A が受け取る（向こうだけが変わった）", async () => {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    received(await b.receive());
    b.work.write(EP1, "一。B が書き足した");
    await b.send();
    const atA = received(await a.receive());
    countConflicts("向こうだけが変わった", atA, []);
    expect(atA.written).toEqual([EP1]);
    expect(a.work.text(EP1)).toBe("一。B が書き足した");
  });

  test("こちらが送った中身が戻ってきても、送ったあとで書き足した分は食い違いにも上書きにもしない", async () => {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    a.work.write(EP1, "一。送ったあとで A が書き足した");
    received(await b.receive());
    await b.send(); // B は何も書かずに送る（A の写しを持つだけ）
    const atA = received(await a.receive());
    countConflicts("自分の写しが戻ってきた", atA, []);
    expect(atA.written).toEqual([]);
    expect(a.work.text(EP1)).toBe("一。送ったあとで A が書き足した");
    // 続きは次の送りで B に届く
    await a.send();
    const atB = received(await b.receive());
    countConflicts("書き足しが届く", atB, []);
    expect(b.work.text(EP1)).toBe("一。送ったあとで A が書き足した");
  });
});

describe("2台で同じ話を直した → 片方で選んで送り返す", () => {
  async function diverged() {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "元の文", [EP2]: "第2話" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    received(await b.receive());
    await b.send();
    received(await a.receive());
    // ここで2台とも印が「元の文」。それぞれで同じ話を直す
    a.work.write(EP1, "A が直した文");
    b.work.write(EP1, "B が直した文");
    await b.send();
    return { drive, a, b };
  }

  test("食い違いは機械が選ばない。両側の中身を添えて返し、どちらの原稿も書き換えない", async () => {
    const { a } = await diverged();
    const atA = received(await a.receive());
    countConflicts("2台で同じ話を直した", atA, [EP1]);
    const report = atA.conflicts[0];
    expect(new TextDecoder().decode(report.localBytes)).toBe("A が直した文");
    expect(new TextDecoder().decode(report.remoteBytes)).toBe("B が直した文");
    expect(a.work.text(EP1)).toBe("A が直した文");
  });

  test("A で「左（このパソコン）を残す」→ 送る → B は訊かれずに受け取る → B が送り返すと A は何もしない", async () => {
    const { a, b } = await diverged();
    const atA = received(await a.receive());
    const chosen = await applyDriveConflictChoice({
      report: atA.conflicts[0],
      choice: "local",
      record: a.record,
      writer: a.work.writer,
    });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    a.record = chosen.record;

    // B が送り直す前に A が受け取り直しても、退けた B の中身を取り込まない
    const beforeBSees = received(await a.receive());
    countConflicts("選んだあと、相手がまだ受け取っていない", beforeBSees, []);
    expect(a.work.text(EP1)).toBe("A が直した文");

    await a.send();
    const atB = received(await b.receive());
    countConflicts("向こうで選び終えた食い違い", atB, []);
    expect(atB.written).toEqual([EP1]);
    expect(b.work.text(EP1)).toBe("A が直した文");

    await b.send();
    const back = received(await a.receive());
    countConflicts("送り返された", back, []);
    expect(back.written).toEqual([]);
    // 相手が受け取ったので、次の送りで「選び終えた」は外れる
    const next = await a.send();
    expect(next.kind === "sent" && next.manifest.resolvedConflicts.size).toBe(0);
  });

  test("B が受け取ったあと、元に戻して B の文になっても、A の古い選択で押し流さない", async () => {
    const { a, b } = await diverged();
    const atA = received(await a.receive());
    const chosen = await applyDriveConflictChoice({ report: atA.conflicts[0], choice: "local", record: a.record, writer: a.work.writer });
    if (!chosen.ok) throw new Error(chosen.reason);
    a.record = chosen.record;
    await a.send();
    received(await b.receive());
    expect(b.work.text(EP1)).toBe("A が直した文");
    // B の作者が元に戻した（偶然、選びで退けた中身と同じになる）。A はまだ送り直していない
    b.work.write(EP1, "B が直した文");
    const again = received(await b.receive());
    countConflicts("使った選択が手元の偶然の一致で効かない", again, []);
    expect(again.written).toEqual([]);
    expect(b.work.text(EP1)).toBe("B が直した文");
  });

  test("「右（もう1台）を残す」は向こうの中身を書き、送り返しても訊かない", async () => {
    const { a, b } = await diverged();
    const atA = received(await a.receive());
    const chosen = await applyDriveConflictChoice({ report: atA.conflicts[0], choice: "remote", record: a.record, writer: a.work.writer });
    if (!chosen.ok) throw new Error(chosen.reason);
    a.record = chosen.record;
    expect(a.work.text(EP1)).toBe("B が直した文");
    await a.send();
    const atB = received(await b.receive());
    countConflicts("右を残した", atB, []);
    expect(atB.written).toEqual([]);
  });

  test("「両方とも残す」は向こうの中身を別の名前で置き、B にもその別の名前が届く", async () => {
    const { a, b } = await diverged();
    const atA = received(await a.receive());
    const side = "本文/第1話（ノートPC）.txt";
    const chosen = await applyDriveConflictChoice({ report: atA.conflicts[0], choice: "both", record: a.record, writer: a.work.writer, sidePath: side });
    if (!chosen.ok) throw new Error(chosen.reason);
    a.record = chosen.record;
    expect(a.work.text(side)).toBe("B が直した文");
    await a.send();
    const atB = received(await b.receive());
    countConflicts("両方とも残した", atB, []);
    expect(b.work.text(EP1)).toBe("A が直した文");
    expect(b.work.text(side)).toBe("B が直した文");
    // 別の名前が無ければ選ばない
    expect(
      await applyDriveConflictChoice({ report: atA.conflicts[0], choice: "both", record: a.record, writer: a.work.writer })
    ).toMatchObject({ ok: false });
  });

  test("設定資料は decideSettingsConflict が項目ごとに合わせる（作者の項目がぶつからなければ訊かない）", async () => {
    const drive = createFakeDrive();
    const FILE = "設定/人物/char_001.json";
    const base = { id: "char_001", name: "ミナ", summary: "旅の剣士", authorNotes: "", updatedAt: "2026-11-01T00:00:00.000Z" };
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [FILE]: json(base) });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    received(await b.receive());
    await b.send();
    received(await a.receive());
    a.work.write(FILE, json({ ...base, summary: "旅の剣士。左利き", updatedAt: "2026-11-02T00:00:00.000Z" }));
    b.work.write(FILE, json({ ...base, authorNotes: "作者のメモ", updatedAt: "2026-11-03T00:00:00.000Z" }));
    await b.send();
    const atA = received(await a.receive());
    countConflicts("設定資料の重ならない変更", atA, []);
    expect(atA.settingsDecided).toMatchObject([{ path: FILE, side: "merged" }]);
    const merged = JSON.parse(a.work.text(FILE) ?? "{}") as Record<string, unknown>;
    expect(merged).toMatchObject({ summary: "旅の剣士。左利き", authorNotes: "作者のメモ" });
    // 合わせた中身を送ると、B は訊かれずに受け取る
    await a.send();
    const atB = received(await b.receive());
    countConflicts("合わせた設定資料が届く", atB, []);
    expect(JSON.parse(b.work.text(FILE) ?? "{}")).toEqual(merged);
  });

  test("設定資料でも作者の項目が両方で違えば訊く", async () => {
    const drive = createFakeDrive();
    const FILE = "設定/人物/char_001.json";
    const base = { id: "char_001", name: "ミナ", authorNotes: "", updatedAt: "2026-11-01T00:00:00.000Z" };
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [FILE]: json(base) });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    received(await b.receive());
    await b.send();
    received(await a.receive());
    a.work.write(FILE, json({ ...base, authorNotes: "A のメモ" }));
    b.work.write(FILE, json({ ...base, authorNotes: "B のメモ" }));
    await b.send();
    const atA = received(await a.receive());
    countConflicts("設定資料の作者の項目がぶつかった", atA, [FILE]);
    expect(atA.conflicts[0].settingsReason).toContain("authorNotes");
  });
});

describe("届ききっていない・ネットの失敗", () => {
  test("送る途中で止まると目録を書かない。受け取る側は「まだ届ききっていません」で何も書かない", async () => {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一", [EP2]: "二" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    received(await b.receive());
    a.work.write(EP1, "一の書き直し");
    a.work.write(EP2, "二の書き直し");
    // 1つ目を書き換えたところでネットが切れる
    let updates = 0;
    drive.setFault((request) => (request.op === "update" && updates++ >= 1 ? "network" : undefined));
    const before = a.record;
    const sent = await a.send();
    expect(sent).toMatchObject({ kind: "failed", uploaded: [EP1] });
    expect(sent.kind === "failed" && sent.error.kind).toBe("network");
    expect(a.record).toBe(before);
    drive.clearFault();

    const atB = await b.receive();
    expect(atB).toMatchObject({ kind: "not_arrived", mismatched: [EP1] });
    expect(b.work.text(EP1)).toBe("一");

    // つながってから送り直せば届く
    await a.send();
    const later = received(await b.receive());
    countConflicts("送り直したら届いた", later, []);
    expect(b.work.text(EP1)).toBe("一の書き直し");
    expect(b.work.text(EP2)).toBe("二の書き直し");
  });

  test("受け取る前にネットが切れれば何も書かず、控えも変えない", async () => {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    drive.setFault((request) => (request.op === "read" ? "network" : undefined));
    const before = b.record;
    const result = await b.receive();
    expect(result).toMatchObject({ kind: "failed" });
    expect(result.kind === "failed" && result.error.kind).toBe("network");
    expect(b.work.disk.size).toBe(0);
    expect(b.record).toBe(before);
  });

  test("書く途中でネットが切れたら、書けた分の印だけ残して止める", async () => {
    // ドライブが申告するハッシュで届いたかを確かめ、中身は書く直前に読む形にする
    const drive = createFakeDrive({ reportsSha256: true });
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一", [EP2]: "二" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    let reads = 0;
    drive.setFault((request) => (request.op === "read" && request.url.pathname.includes("id-") && reads++ >= 2 ? "network" : undefined));
    const result = received(await b.receive());
    expect(result.stoppedBy?.kind).toBe("network");
    expect(result.written).toEqual([EP1]);
    expect(result.record.marks.has(EP1)).toBe(true);
    expect(result.record.marks.has(EP2)).toBe(false);
    drive.clearFault();
    const later = received(await b.receive());
    expect(later.written).toEqual([EP2]);
  });

  test("向こうの目録が壊れていれば直さずに止める", async () => {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    const manifest = drive.find("統合小説執筆環境", "作品-0001", "desk-a1b2", "manifest.json");
    if (!manifest) throw new Error("目録がありません");
    manifest.bytes = new TextEncoder().encode("{ 壊れた");
    expect(await b.receive()).toMatchObject({ kind: "unreadable", peerDeviceId: "desk-a1b2" });
    expect(b.work.disk.size).toBe(0);
    // 自分の目録が壊れていれば、送るのも止める（上書きして直さない）
    expect(await a.send()).toMatchObject({ kind: "own_manifest_unreadable" });
  });

  test("まだ誰も送っていない・向こうが2台以上なら何もしない", async () => {
    const drive = createFakeDrive();
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    expect(await b.receive()).toEqual({ kind: "nothing_yet" });
    await makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一" }).send();
    await makeDevice(drive, "tab-e5f6", "タブレット", { [EP1]: "一" }).send();
    expect(await b.receive()).toEqual({ kind: "several_peers", deviceIds: ["desk-a1b2", "tab-e5f6"] });
    expect(b.work.disk.size).toBe(0);
  });
});

describe("手元の原稿を守る", () => {
  test("書く口が断った話（未保存・校閲中）は書かず印も進めない。ほかの話は書く", async () => {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一", [EP2]: "二" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    received(await b.receive());
    a.work.write(EP1, "一の続き");
    a.work.write(EP2, "二の続き");
    await a.send();
    b.work.refuse.add(EP1);
    const atB = received(await b.receive());
    expect(atB.written).toEqual([EP2]);
    expect(atB.failures).toMatchObject([{ path: EP1 }]);
    expect(b.work.text(EP1)).toBe("一");
    // 断った理由が解けたら、次の受け取りで書く（食い違いにはならない）
    b.work.refuse.clear();
    const later = received(await b.receive());
    countConflicts("断った話をあとで受け取る", later, []);
    expect(b.work.text(EP1)).toBe("一の続き");
  });

  test("書く口が改行を変えたら、印を進めず失敗に数える（2台で永久に往復させない）", async () => {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一行目\r\n二行目\r\n" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    b.work.setNormalizeEol(true);
    const atB = received(await b.receive());
    expect(atB.failures).toMatchObject([{ path: EP1, reason: expect.stringContaining("バイト") }]);
    expect(atB.record.marks.has(EP1)).toBe(false);
  });

  test("向こうで消えた話は手元で消さず、知らせるだけ", async () => {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一", [EP2]: "二" });
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    await a.send();
    received(await b.receive());
    a.work.remove(EP2);
    await a.send();
    const atB = received(await b.receive());
    expect(atB.remoteDeleted).toEqual([{ path: EP2, localChanged: false }]);
    expect(b.work.text(EP2)).toBe("二");
  });

  test("端末ごとのファイル：自分のものは受け取らず、相手のものは受け取り、印の置き場は送らない", async () => {
    const drive = createFakeDrive();
    const a = makeDevice(drive, "desk-a1b2", "母艦", {
      [EP1]: "一",
      ".aiwriter/stats/desk-a1b2.json": "{\"a\":1}",
      ".aiwriter/drive-sync/desk-a1b2.json": "{}",
      ".aiwriter/cache/x.json": "{}",
    });
    const b = makeDevice(drive, "note-c3d4", "ノートPC", { ".aiwriter/stats/note-c3d4.json": "{\"b\":1}" });
    const sent = await a.send();
    expect(sent.kind === "sent" && sent.uploaded).toEqual([".aiwriter/stats/desk-a1b2.json", EP1]);
    received(await b.receive());
    expect(b.work.text(".aiwriter/stats/desk-a1b2.json")).toBe("{\"a\":1}");
    b.work.write(".aiwriter/stats/note-c3d4.json", "{\"b\":2}");
    const sentB = await b.send();
    // B は受け取った A の統計を送り返さない
    expect(sentB.kind === "sent" && [...sentB.manifest.files.keys()].sort()).toEqual([
      ".aiwriter/stats/note-c3d4.json",
      EP1,
    ]);
    // A の統計は A が書き進めていても、B の写しのせいで食い違いにならない
    a.work.write(".aiwriter/stats/desk-a1b2.json", "{\"a\":2}");
    const atA = received(await a.receive());
    countConflicts("端末ごとのファイル", atA, []);
    expect(a.work.text(".aiwriter/stats/note-c3d4.json")).toBe("{\"b\":2}");
    expect(a.work.text(".aiwriter/stats/desk-a1b2.json")).toBe("{\"a\":2}");
  });
});

describe("見逃しと誤検出を数える（往復の場面をまとめて）", () => {
  test("場面ごとの正解の食い違いと、実際に訊いたものが全部一致する", () => {
    let missed = 0;
    let falsePositive = 0;
    let expectedTotal = 0;
    for (const { expected, actual } of tally) {
      expectedTotal += expected.length;
      missed += expected.filter((entry) => !actual.includes(entry)).length;
      falsePositive += actual.filter((entry) => !expected.includes(entry)).length;
    }
    expect({ missed, falsePositive }).toEqual({ missed: 0, falsePositive: 0 });
    // 場面が減って「全部通った」にならないよう、数も押さえる
    expect(tally.length).toBeGreaterThanOrEqual(18);
    // 訊くべき食い違いが0件だと見逃しは測れない
    expect(expectedTotal).toBeGreaterThanOrEqual(2);
  });
});

describe("モバイル版へそのまま持っていける（vscode・node:・paths を読まない）", () => {
  test("driveSyncEngine.ts から静的にたどれる先に、vscode・node: ・core/paths.ts が無い", () => {
    const reach = walkStaticImports([path.join(SRC, "core", "driveSyncEngine.ts")]);
    const bare = reach.bare.map((item) => `${relativeName(item.file)} → ${item.spec}`);
    expect(bare.filter((line) => /→ (vscode|node:)/.test(line))).toEqual([]);
    const paths = path.join(SRC, "core", "paths.ts");
    expect(reach.files.has(paths) ? chainTo(reach, paths) : "").toBe("");
  });
});
