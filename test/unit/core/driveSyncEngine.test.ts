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
import { DRIVE_LINEAGE_LIMIT } from "../../../src/core/driveSyncPlan";
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
      if (result.kind === "received") device.record = result.record;
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
    // 2台とも同じ中身・同じ系譜になった。A が送り直しても B は何も書かず、訊かない
    const next = await a.send();
    expect(next).toMatchObject({ kind: "sent", uploaded: [] });
    const settled = received(await b.receive());
    countConflicts("選んだ結果がそろったあと", settled, []);
    expect(settled.written).toEqual([]);
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
    expect(result.record.lineage.has(EP1)).toBe(true);
    expect(result.record.lineage.has(EP2)).toBe(false);
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

  test("まだ誰も送っていなければ何もしない。相手が2台以上でも全部と比べて受け取る（0.133.0）", async () => {
    const drive = createFakeDrive();
    const b = makeDevice(drive, "note-c3d4", "ノートPC");
    expect(await b.receive()).toEqual({ kind: "nothing_yet" });
    await makeDevice(drive, "desk-a1b2", "母艦", { [EP1]: "一" }).send();
    await makeDevice(drive, "tab-e5f6", "タブレット", { [EP1]: "一" }).send();
    const atB = received(await b.receive());
    countConflicts("はじめての2台が同じ中身", atB, []);
    expect(atB.peers.map((peer) => peer.deviceId)).toEqual(["desk-a1b2", "tab-e5f6"]);
    expect(b.work.text(EP1)).toBe("一");
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
    expect(atB.record.lineage.has(EP1)).toBe(false);
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
    expect(atB.remoteDeleted).toEqual([{ path: EP2, localChanged: false, from: ["desk-a1b2"] }]);
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

/** 端末をそろえる：順に「受け取って送る」を2周。食い違いは出ない前提の下ごしらえ */
async function syncAll(devices: Device[]) {
  for (let lap = 0; lap < 2; lap++) {
    for (const device of devices) {
      const result = await device.receive();
      if (result.kind === "received") expect(result.conflicts).toEqual([]);
      await device.send();
    }
  }
}

/** 食い違いを選ぶ（相手は端末IDで指す。相手が1つなら省ける） */
async function choose(
  device: Device,
  report: DriveReceiveResultConflict,
  choice: "local" | "remote" | "both",
  peerDeviceId?: string
) {
  const chosen = await applyDriveConflictChoice({
    report,
    choice,
    record: device.record,
    writer: device.work.writer,
    peerDeviceId,
  });
  if (!chosen.ok) throw new Error(chosen.reason);
  device.record = chosen.record;
}
type DriveReceiveResultConflict = Extract<DriveReceiveResult, { kind: "received" }>["conflicts"][number];

const IDS = ["desk-a1b2", "note-c3d4", "tab-e5f6", "mac-g7h8"] as const;

function devicesOn(drive: FakeDrive, count: number, initial: Record<string, string>) {
  return IDS.slice(0, count).map((id, i) => makeDevice(drive, id, `端末${i + 1}`, i === 0 ? initial : {}));
}

describe("3台・4台でそろえる（中身の系譜。0.133.0）", () => {
  test("A→B→C の順送り：C は B の中身を1回で受け取り、A も B の中身を受け取る", async () => {
    const drive = createFakeDrive();
    const [a, b, c] = devicesOn(drive, 3, { [EP1]: "一" });
    await a.send();
    received(await b.receive());
    b.work.write(EP1, "一。B が書き足した");
    await b.send();
    const atC = received(await c.receive());
    countConflicts("3台：順送りの先", atC, []);
    expect(atC.written).toEqual([EP1]);
    expect(c.work.text(EP1)).toBe("一。B が書き足した");
    const atA = received(await a.receive());
    countConflicts("3台：順送りの元", atA, []);
    expect(a.work.text(EP1)).toBe("一。B が書き足した");
    // C が送り返しても、A は何も書かない
    await c.send();
    const back = received(await a.receive());
    countConflicts("3台：順送りが戻る", back, []);
    expect(back.written).toEqual([]);
  });

  test("4台の順送り：A→B→C→D と書き足していくと、D と A は最後の中身を1回で受け取る", async () => {
    const drive = createFakeDrive();
    const [a, b, c, d] = devicesOn(drive, 4, { [EP1]: "一" });
    await a.send();
    for (const [device, text] of [[b, "一二"], [c, "一二三"]] as const) {
      received(await device.receive());
      device.work.write(EP1, text);
      await device.send();
    }
    const atD = received(await d.receive());
    countConflicts("4台：順送りの先", atD, []);
    expect(atD.written).toEqual([EP1]);
    expect(d.work.text(EP1)).toBe("一二三");
    const atA = received(await a.receive());
    countConflicts("4台：順送りの元", atA, []);
    expect(a.work.text(EP1)).toBe("一二三");
  });

  test("2台が同時に直す：直した2台は訊かれ、直していない台も訊かれる。選んだ結果が届くと誰も訊き直さない", async () => {
    const drive = createFakeDrive();
    const [a, b, c] = devicesOn(drive, 3, { [EP1]: "元の文", [EP2]: "第2話" });
    await syncAll([a, b, c]);
    a.work.write(EP1, "A が直した文");
    b.work.write(EP1, "B が直した文");
    await a.send();
    await b.send();

    // C は直していないが、A と B の中身はどちらも C より新しく、互いに食い違う
    const atC = received(await c.receive());
    countConflicts("3台：2台が同時に直したのを3台目が見る", atC, [EP1]);
    expect(atC.conflicts[0].remotes.map((side) => side.devices[0].deviceId)).toEqual(["desk-a1b2", "note-c3d4"]);
    expect(atC.conflicts[0].decision.localIsAncestor).toBe(true);
    expect(c.work.text(EP1)).toBe("元の文");

    const atA = received(await a.receive());
    countConflicts("3台：2台が同時に直した（直した側）", atA, [EP1]);
    // C は元の文のまま（A の祖先）なので、相手の一覧には B だけが出る
    expect(atA.conflicts[0].remotes.map((side) => side.devices[0].deviceId)).toEqual(["note-c3d4"]);
    await choose(a, atA.conflicts[0], "local");
    await a.send();

    const cAgain = received(await c.receive());
    countConflicts("3台：選んだ結果が3台目に届く", cAgain, []);
    expect(c.work.text(EP1)).toBe("A が直した文");
    const atB = received(await b.receive());
    countConflicts("3台：選んだ結果がもう1台に届く", atB, []);
    expect(b.work.text(EP1)).toBe("A が直した文");

    await b.send();
    await c.send();
    for (const device of [a, b, c]) {
      const settled = received(await device.receive());
      countConflicts(`3台：そろったあと（${device.id}）`, settled, []);
      expect(settled.written).toEqual([]);
    }
  });

  test("3台が同時に直す：1つずつ選ぶ（選ぶ→受け取り直す→選ぶ）。選び終えたらほかの2台は訊かれない", async () => {
    const drive = createFakeDrive();
    const [a, b, c] = devicesOn(drive, 3, { [EP1]: "元の文" });
    await syncAll([a, b, c]);
    a.work.write(EP1, "A の文");
    b.work.write(EP1, "B の文");
    c.work.write(EP1, "C の文");
    await a.send();
    await b.send();
    await c.send();

    const first = received(await a.receive());
    countConflicts("3台：3台が同時に直した（1回目）", first, [EP1]);
    const report = first.conflicts[0];
    expect(report.remotes.map((side) => side.devices[0].deviceId)).toEqual(["note-c3d4", "tab-e5f6"]);
    // 相手が2つのときは、どちらと比べたかを言わないと選ばない
    expect(
      await applyDriveConflictChoice({ report, choice: "local", record: a.record, writer: a.work.writer })
    ).toMatchObject({ ok: false });
    await choose(a, report, "local", "note-c3d4");
    // 同じ報告でもう一度選ぼうとすると断る（受け取り直してから）
    expect(
      await applyDriveConflictChoice({
        report,
        choice: "local",
        record: a.record,
        writer: a.work.writer,
        peerDeviceId: "tab-e5f6",
      })
    ).toMatchObject({ ok: false });

    const second = received(await a.receive());
    countConflicts("3台：3台が同時に直した（2回目は残りの1台だけ）", second, [EP1]);
    expect(second.conflicts[0].remotes.map((side) => side.devices[0].deviceId)).toEqual(["tab-e5f6"]);
    await choose(a, second.conflicts[0], "remote");
    expect(a.work.text(EP1)).toBe("C の文");

    const third = received(await a.receive());
    countConflicts("3台：3台が同時に直した（選び終えた）", third, []);
    await a.send();
    for (const device of [b, c]) {
      const atPeer = received(await device.receive());
      countConflicts(`3台：3台の食い違いの結果が届く（${device.id}）`, atPeer, []);
      expect(device.work.text(EP1)).toBe("C の文");
    }
  });

  test("4台：選んだ結果が届けば、まだ受け取っていなかった2台も訊かれない", async () => {
    const drive = createFakeDrive();
    const [a, b, c, d] = devicesOn(drive, 4, { [EP1]: "元の文" });
    await syncAll([a, b, c, d]);
    a.work.write(EP1, "A の文");
    b.work.write(EP1, "B の文");
    await b.send();
    const atA = received(await a.receive());
    countConflicts("4台：直した2台の片方", atA, [EP1]);
    await choose(a, atA.conflicts[0], "remote");
    await a.send();
    for (const device of [c, d, b]) {
      const atPeer = received(await device.receive());
      countConflicts(`4台：選んだ結果が届く（${device.id}）`, atPeer, []);
      expect(device.work.text(EP1)).toBe("B の文");
    }
  });

  test("2台が同じ食い違いを別々に選んだ：もう一度訊く。片方で選び直せば、もう片方は訊かれずにそろう", async () => {
    const drive = createFakeDrive();
    const [a, b] = devicesOn(drive, 2, { [EP1]: "元の文" });
    await syncAll([a, b]);
    a.work.write(EP1, "A の文");
    b.work.write(EP1, "B の文");
    await a.send();
    await b.send();
    // 2台とも相手の送りを見てから、それぞれ「手元を残す」を選んだ
    const atA = received(await a.receive());
    const atB = received(await b.receive());
    countConflicts("別々に選ぶ前（A）", atA, [EP1]);
    countConflicts("別々に選ぶ前（B）", atB, [EP1]);
    await choose(a, atA.conflicts[0], "local");
    await choose(b, atB.conflicts[0], "local");
    await a.send();
    await b.send();
    // 作者の選びが2台で食い違ったので、機械は決めずにもう一度訊く
    const again = received(await a.receive());
    countConflicts("別々に選んだあと（A）", again, [EP1]);
    await choose(a, again.conflicts[0], "local");
    await a.send();
    const atB2 = received(await b.receive());
    countConflicts("選び直した結果が届く（B）", atB2, []);
    expect(b.work.text(EP1)).toBe("A の文");
    const settled = received(await a.receive());
    countConflicts("選び直したあと（A）", settled, []);
  });

  test("書いてから元に戻した中身は、新しい中身として受け取る（食い違いにしない）", async () => {
    const drive = createFakeDrive();
    const [a, b, c] = devicesOn(drive, 3, { [EP1]: "元の文" });
    await syncAll([a, b, c]);
    a.work.write(EP1, "書き直した文");
    await a.send();
    received(await b.receive());
    expect(b.work.text(EP1)).toBe("書き直した文");
    await b.send();
    a.work.write(EP1, "元の文");
    await a.send();
    const atB = received(await b.receive());
    countConflicts("元に戻した（受け取っていた台）", atB, []);
    expect(b.work.text(EP1)).toBe("元の文");
    const atC = received(await c.receive());
    countConflicts("元に戻した（書き直しを知らない台）", atC, []);
    expect(c.work.text(EP1)).toBe("元の文");
  });
});

describe("祖先の上限（DRIVE_LINEAGE_LIMIT）を越えたら食い違いにする", () => {
  async function editedTimes(times: number) {
    const drive = createFakeDrive();
    const [a, b, c] = devicesOn(drive, 3, { [EP1]: "第0版" });
    await syncAll([a, b, c]);
    for (let i = 1; i <= times; i++) {
      a.work.write(EP1, `第${i}版`);
      await a.send();
    }
    return { a, b, c };
  }

  test(`${DRIVE_LINEAGE_LIMIT}回までなら、待っていた台は受け取る`, async () => {
    const { c } = await editedTimes(DRIVE_LINEAGE_LIMIT);
    const atC = received(await c.receive());
    countConflicts("祖先の上限ちょうど", atC, []);
    expect(c.work.text(EP1)).toBe(`第${DRIVE_LINEAGE_LIMIT}版`);
  });

  test(`${DRIVE_LINEAGE_LIMIT + 1}回を越えると、比べられないので食い違いにする（黙って上書きしない）`, async () => {
    const { b, c } = await editedTimes(DRIVE_LINEAGE_LIMIT + 1);
    const atC = received(await c.receive());
    countConflicts("祖先の上限を越えた", atC, [EP1]);
    expect(c.work.text(EP1)).toBe("第0版");
    // 相手の一覧は越えた1つだけ（B は C と同じ第0版）
    expect(atC.conflicts[0].remotes.map((side) => side.devices[0].deviceId)).toEqual(["desk-a1b2"]);
    expect(b.work.text(EP1)).toBe("第0版");
  });
});

describe("消したファイル（3台）", () => {
  async function deletedAtA() {
    const drive = createFakeDrive();
    const [a, b, c] = devicesOn(drive, 3, { [EP1]: "一", [EP2]: "二" });
    await syncAll([a, b, c]);
    a.work.remove(EP2);
    await a.send();
    return { a, b, c };
  }

  test("消した台の知らせは、ほかの台で消さずに知らせるだけ。送り返されても消した台に戻ってこない", async () => {
    const { a, b, c } = await deletedAtA();
    for (const device of [b, c]) {
      const atPeer = received(await device.receive());
      countConflicts(`消した知らせ（${device.id}）`, atPeer, []);
      expect(atPeer.remoteDeleted).toMatchObject([{ path: EP2, localChanged: false }]);
      expect(device.work.text(EP2)).toBe("二");
      await device.send();
    }
    const atA = received(await a.receive());
    countConflicts("消したあとで送り返された", atA, []);
    expect(a.work.text(EP2)).toBeUndefined();
  });

  test("消した台と、書き足した台が分かれた：消した台では食い違い、もう1台は書き足しを受け取る", async () => {
    const { a, b, c } = await deletedAtA();
    b.work.write(EP2, "二。B が書き足した");
    await b.send();
    const atA = received(await a.receive());
    countConflicts("消した×書き足した（消した台）", atA, [EP2]);
    expect(atA.conflicts[0].decision.localHash).toBeNull();
    expect(a.work.text(EP2)).toBeUndefined();
    const atC = received(await c.receive());
    countConflicts("消した×書き足した（3台目）", atC, []);
    expect(c.work.text(EP2)).toBe("二。B が書き足した");
    // 消した台で「相手を残す」を選ぶと、書き足しが戻り、ほかの台は訊かれない
    await choose(a, atA.conflicts[0], "remote");
    expect(a.work.text(EP2)).toBe("二。B が書き足した");
    await a.send();
    for (const device of [b, c]) {
      const atPeer = received(await device.receive());
      countConflicts(`書き足しを戻した結果が届く（${device.id}）`, atPeer, []);
    }
  });

  test("2台で消した：残りの1台に知らせ、消した2台どうしでは何も訊かない", async () => {
    const { a, b, c } = await deletedAtA();
    b.work.remove(EP2);
    await b.send();
    const atB = received(await b.receive());
    countConflicts("2台で消した（B）", atB, []);
    const atA = received(await a.receive());
    countConflicts("2台で消した（A）", atA, []);
    const atC = received(await c.receive());
    countConflicts("2台で消した（3台目）", atC, []);
    expect(atC.remoteDeleted).toMatchObject([{ path: EP2, localChanged: false }]);
    expect(c.work.text(EP2)).toBe("二");
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
    // 場面が減って「全部通った」にならないよう、数も押さえる（0.133.0 で 3台・4台を足して60場面）
    expect(tally.length).toBeGreaterThanOrEqual(60);
    // 訊くべき食い違いが0件だと見逃しは測れない（0.133.0 で12件）
    expect(expectedTotal).toBeGreaterThanOrEqual(12);
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
