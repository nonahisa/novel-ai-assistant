import { describe, expect, test } from "vitest";
import * as path from "node:path";
import {
  cloneDriveSyncRecord,
  driveSyncRecordPath,
  emptyDriveSyncRecord,
  parseDriveSyncRecord,
  serializeDriveSyncRecord,
} from "../../../src/core/driveSyncRecord";
import { isIgnoredSyncPath } from "../../../src/core/driveSyncPlan";
import { hashText } from "../../../src/core/hash";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

const H0 = hashText("前回そろえた中身");
const H1 = hashText("このパソコンで書いた中身");

function filled() {
  const record = emptyDriveSyncRecord("desk-a1b2");
  record.marks.set("本文/第1話.txt", H0);
  record.settingsBases.set("設定/人物/char_001.json", "{\n  \"id\": \"char_001\"\n}\n");
  record.sentSinceMark.set("本文/第1話.txt", [H1]);
  record.consumedResolutions.set("note-c3d4", new Map([["本文/第2話.txt", 3]]));
  record.pendingResolutions.set("本文/第3話.txt", H1);
  record.lastRound = 4;
  return record;
}

describe("端末別の控え（印）", () => {
  test("置き場は .aiwriter/drive-sync/<端末ID>.json で、ドライブへは送らない", () => {
    expect(driveSyncRecordPath("desk-a1b2")).toBe(".aiwriter/drive-sync/desk-a1b2.json");
    expect(isIgnoredSyncPath(driveSyncRecordPath("desk-a1b2"), [])).toBe(true);
  });

  test("文字にして読み直すと同じ中身。同じ中身なら同じ文字", () => {
    const record = filled();
    const text = serializeDriveSyncRecord(record);
    const read = parseDriveSyncRecord(text, "desk-a1b2");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record).toEqual(record);
    expect(serializeDriveSyncRecord(read.record)).toBe(text);
  });

  test("写しを変えても元の控えは変わらない", () => {
    const record = filled();
    const copy = cloneDriveSyncRecord(record);
    copy.marks.clear();
    copy.sentSinceMark.get("本文/第1話.txt")?.push(H0);
    copy.consumedResolutions.get("note-c3d4")?.clear();
    expect(record.marks.size).toBe(1);
    expect(record.sentSinceMark.get("本文/第1話.txt")).toEqual([H1]);
    expect(record.consumedResolutions.get("note-c3d4")?.size).toBe(1);
  });

  const good = JSON.parse(serializeDriveSyncRecord(filled())) as Record<string, unknown>;
  const broken: [string, string][] = [
    ["JSONでない", "{"],
    ["版が違う", JSON.stringify({ ...good, formatVersion: 2 })],
    ["ほかの端末の控え", JSON.stringify({ ...good, deviceId: "note-c3d4" })],
    ["回の番号が負", JSON.stringify({ ...good, lastRound: -1 })],
    ["印のハッシュが壊れている", JSON.stringify({ ...good, marks: { "本文/第1話.txt": "abc" } })],
    ["印の道が作品の外", JSON.stringify({ ...good, marks: { "../外.txt": H0 } })],
    ["送った中身が配列でない", JSON.stringify({ ...good, sentSinceMark: { "本文/第1話.txt": H1 } })],
    ["使った選択の端末IDが壊れている", JSON.stringify({ ...good, consumedResolutions: { "端末": {} } })],
    ["使った選択の回が0", JSON.stringify({ ...good, consumedResolutions: { "note-c3d4": { "a.txt": 0 } } })],
    ["送っていない選択が無い", JSON.stringify({ ...good, pendingResolutions: undefined })],
  ];

  test.each(broken)("%s → 読めない（直さない）", (_label, text) => {
    const read = parseDriveSyncRecord(text, "desk-a1b2");
    expect(read.ok).toBe(false);
  });
});

describe("モバイル版へそのまま持っていける（vscode・node:・paths を読まない）", () => {
  test("driveSyncRecord.ts から静的にたどれる先に、vscode・node: ・core/paths.ts が無い", () => {
    const reach = walkStaticImports([path.join(SRC, "core", "driveSyncRecord.ts")]);
    const bare = reach.bare.map((item) => `${relativeName(item.file)} → ${item.spec}`);
    expect(bare.filter((line) => /→ (vscode|node:)/.test(line))).toEqual([]);
    const paths = path.join(SRC, "core", "paths.ts");
    expect(reach.files.has(paths) ? chainTo(reach, paths) : "").toBe("");
  });
});
