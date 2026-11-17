import * as nodePath from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { Uri, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import { hashBytes } from "../../../src/core/hash";
import { emptyDriveSyncRecord } from "../../../src/core/driveSyncRecord";
import { readRecord, workFiles, writeRecord } from "../../../src/features/driveSync";

/**
 * 手元の作品のフォルダーの読み書きの口（設計書5.10.9。実装ルール1）。受け取りで手元の原稿を
 * 書くのはここだけなので、本物の `workspace.fs` の形（記憶の中）で守りを確かめる。
 *
 * - 受け取ったバイトをそのまま書く（CRLF・Shift_JIS・BOM を手元の形へ直さない）
 * - 書く前の中身を回復先（`.novelai-recovery`）へ控える
 * - 期待ハッシュが合わない・未保存の文書がある・競合マーカーのある中身 は書かない
 * - 既にあるファイルへ `create` しない
 * - 送らないフォルダー（.git・回復先・キャッシュ・この端末の控え）は一覧に出さない
 */

const ROOT = Uri.file(nodePath.resolve("/作品/ds3")).fsPath;
const at = (...parts: string[]) => nodePath.join(ROOT, ...parts);
const work = { id: "w1", title: "試しの作品", folderPath: ROOT } as unknown as WorkEntry;
const DEVICE = "desk-a1b2";
const enc = (text: string) => new TextEncoder().encode(text);

let disk: Map<string, Uint8Array>;
beforeEach(() => {
  disk = new Map();
  workspace.fs = memoryFs(disk, {
    methods: ["createDirectory", "readFile", "writeFile", "rename", "delete", "stat", "readDirectory"],
    readDirectory: "nested",
    folderStat: { type: 2, ctime: 0, mtime: 0, size: 0 },
  });
  workspace.textDocuments.length = 0;
  disk.set(at("本文", "第1話.txt"), enc("一行目\n二行目\n"));
  disk.set(at(".git", "HEAD"), enc("ref: refs/heads/main"));
  disk.set(at(".novelai-recovery", "x.bak"), enc("古い控え"));
  disk.set(at(".aiwriter", "cache", "c.json"), enc("{}"));
  disk.set(at(".aiwriter", "drive-sync", `${DEVICE}.json`), enc("{}"));
  disk.set(at(".aiwriter", "config.json"), enc('{"title":"試しの作品"}'));
});

describe("一覧", () => {
  test("送らないフォルダーの中は一覧に出さない", async () => {
    const list = (await workFiles(work, DEVICE).local.list()).sort();
    expect(list).toEqual([".aiwriter/config.json", "本文/第1話.txt"]);
  });
});

describe("既にあるファイルを受け取った中身へ（replace）", () => {
  test("CRLF・Shift_JIS のバイトをそのまま書き、書く前の中身を回復先へ控える", async () => {
    const { writer } = workFiles(work, DEVICE);
    const before = disk.get(at("本文", "第1話.txt")) as Uint8Array;
    // 「あ」の Shift_JIS（0x82 0xA0）と CRLF。手元の形（UTF-8・LF）へ直さずに書く
    const received = new Uint8Array([0x82, 0xa0, 0x0d, 0x0a]);
    const outcome = await writer.replace("本文/第1話.txt", received, hashBytes(before));
    expect(outcome).toEqual({ ok: true, writtenHash: hashBytes(received) });
    expect([...(disk.get(at("本文", "第1話.txt")) as Uint8Array)]).toEqual([...received]);
    const backups = [...disk.entries()].filter(([key]) => key.includes(".novelai-recovery") && !key.endsWith("x.bak"));
    expect(backups.map(([, bytes]) => new TextDecoder().decode(bytes))).toContain("一行目\n二行目\n");
  });

  test("読んだあとで変わっていたら書かない（期待ハッシュ）", async () => {
    const outcome = await workFiles(work, DEVICE).writer.replace("本文/第1話.txt", enc("向こう"), hashBytes(enc("別の中身")));
    expect(outcome.ok).toBe(false);
    expect(new TextDecoder().decode(disk.get(at("本文", "第1話.txt")))).toBe("一行目\n二行目\n");
  });

  test("未保存の文書が開いていれば書かない", async () => {
    workspace.textDocuments.push({ uri: { fsPath: at("本文", "第1話.txt") }, isDirty: true, getText: () => "書きかけ" });
    const before = disk.get(at("本文", "第1話.txt")) as Uint8Array;
    const outcome = await workFiles(work, DEVICE).writer.replace("本文/第1話.txt", enc("向こう"), hashBytes(before));
    expect(outcome).toMatchObject({ ok: false, reason: "保存していない文書が開いています" });
  });

  test("競合マーカーのある中身は書かない", async () => {
    const before = disk.get(at("本文", "第1話.txt")) as Uint8Array;
    const marked = enc("<<<<<<< HEAD\nこちら\n=======\nあちら\n>>>>>>> main\n");
    const outcome = await workFiles(work, DEVICE).writer.replace("本文/第1話.txt", marked, hashBytes(before));
    expect(outcome).toMatchObject({ ok: false, reason: "競合マーカーがあります" });
  });
});

describe("無いファイルを置く（create）と元の文の置き場", () => {
  test("新しく置く。既にあれば置かない", async () => {
    const { writer } = workFiles(work, DEVICE);
    expect(await writer.create("本文/第2話.txt", enc("第2話"))).toEqual({ ok: true, writtenHash: hashBytes(enc("第2話")) });
    expect((await writer.create("本文/第2話.txt", enc("上書き"))).ok).toBe(false);
    expect(new TextDecoder().decode(disk.get(at("本文", "第2話.txt")))).toBe("第2話");
  });

  test("置き場は名前が中身のハッシュ。消すのは置き場の中だけ（ハッシュの形でない名前は消さない）", async () => {
    const { writer, local } = workFiles(work, DEVICE);
    const bytes = enc("元の文");
    const hash = hashBytes(bytes);
    expect((await writer.writeBase(hash, bytes)).ok).toBe(true);
    expect(await local.listBases()).toEqual([hash]);
    expect(new TextDecoder().decode(await local.readBase(hash))).toBe("元の文");
    await writer.removeBase("../../本文/第1話.txt");
    expect(disk.has(at("本文", "第1話.txt"))).toBe(true);
    await writer.removeBase(hash);
    expect(await local.listBases()).toEqual([]);
  });
});

describe("この端末の控え", () => {
  test("書いて読み戻すと同じ。壊れていれば直さず止める", async () => {
    const record = emptyDriveSyncRecord(DEVICE);
    record.lineage.set("本文/第1話.txt", { hash: "a".repeat(64), ancestors: [], gen: 1 });
    record.lastRound = 3;
    await writeRecord(work, DEVICE, record);
    const read = await readRecord(work, DEVICE);
    expect(read).toMatchObject({ ok: true, record: { lastRound: 3 } });
    disk.set(at(".aiwriter", "drive-sync", `${DEVICE}.json`), enc("{ 壊れた"));
    const broken = await readRecord(work, DEVICE);
    expect(broken.ok).toBe(false);
    // 壊れた控えはそのまま（直さない）
    expect(new TextDecoder().decode(disk.get(at(".aiwriter", "drive-sync", `${DEVICE}.json`)))).toBe("{ 壊れた");
  });
});
