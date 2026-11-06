import { describe, expect, test } from "vitest";
import * as path from "node:path";
import {
  cloneDriveSyncRecord,
  driveSyncRecordPath,
  emptyDriveSyncRecord,
  parseDriveSyncRecord,
  serializeDriveSyncRecord,
} from "../../../src/core/driveSyncRecord";
import { DRIVE_DELETED, DRIVE_LINEAGE_LIMIT, isIgnoredSyncPath } from "../../../src/core/driveSyncPlan";
import { hashText } from "../../../src/core/hash";
import { SRC, chainTo, relativeName, walkStaticImports } from "../support/importGraph";

const H0 = hashText("前回そろえた中身");
const H1 = hashText("このパソコンで書いた中身");

function filled() {
  const record = emptyDriveSyncRecord("desk-a1b2");
  record.lineage.set("本文/第1話.txt", { hash: H1, gen: 1, ancestors: [H0] });
  record.lineage.set("本文/第2話.txt", { hash: DRIVE_DELETED, gen: 2, ancestors: [H1, H0] });
  record.settingsBases.set("設定/人物/char_001.json", "{\n  \"id\": \"char_001\"\n}\n");
  record.lastRound = 4;
  return record;
}

describe("端末別の控え（系譜。0.133.0）", () => {
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
    copy.lineage.clear();
    copy.settingsBases.clear();
    expect(record.lineage.size).toBe(2);
    expect(record.settingsBases.size).toBe(1);
  });

  const good = JSON.parse(serializeDriveSyncRecord(filled())) as Record<string, unknown>;
  const lineageOf = (value: unknown) => JSON.stringify({ ...good, lineage: { "本文/第1話.txt": value } });
  const tooLong = Array.from({ length: DRIVE_LINEAGE_LIMIT + 1 }, (_, i) => hashText(String(i)));
  const broken: [string, string][] = [
    ["JSONでない", "{"],
    ["版が違う", JSON.stringify({ ...good, formatVersion: 3 })],
    // 版1（印・送った中身・使った選択）は配っていないので読まない
    ["版1", JSON.stringify({ ...good, formatVersion: 1 })],
    ["ほかの端末の控え", JSON.stringify({ ...good, deviceId: "note-c3d4" })],
    ["回の番号が負", JSON.stringify({ ...good, lastRound: -1 })],
    ["系譜が無い", JSON.stringify({ ...good, lineage: undefined })],
    ["系譜の道が作品の外", JSON.stringify({ ...good, lineage: { "../外.txt": { hash: H0, gen: 0, ancestors: [] } } })],
    ["中身のハッシュが壊れている", lineageOf({ hash: "abc", gen: 0, ancestors: [] })],
    ["祖先のハッシュが壊れている", lineageOf({ hash: H1, gen: 1, ancestors: ["x"] })],
    ["回の数が負", lineageOf({ hash: H1, gen: -1, ancestors: [] })],
    ["祖先が配列でない", lineageOf({ hash: H1, gen: 1, ancestors: H0 })],
    ["祖先が上限より長い", lineageOf({ hash: H1, gen: 1, ancestors: tooLong })],
    ["設定資料の控えが文字でない", JSON.stringify({ ...good, settingsBases: { "設定/a.json": 1 } })],
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
