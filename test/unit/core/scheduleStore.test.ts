import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { ScheduleStore, ScheduleStoreError } from "../../../src/core/scheduleStore";
import { emptyScheduleFile } from "../../../src/models/schedule";
import type { WorkEntry } from "../../../src/models/types";
import { createSchedule } from "../../../src/core/scheduleTemplates";
import { FileSystemError, Uri, workspace } from "../support/vscodeStub";

/**
 * `設定/スケジュール.json` の読み書き（設計書6.111.8）。
 *
 * Git で同期するので、開いたまま別の機器で書かれることが現実に起きる。
 * **外で変わっていたら上書きせずに止める。** 壊れたJSONは直さない。改行は元のまま。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const filePath = Uri.file(path.join(work.folderPath, "設定", "スケジュール.json")).fsPath;

function sampleFile() {
  let seq = 0;
  return {
    schemaVersion: "1",
    schedules: [
      createSchedule({ kind: "publisher", name: "新刊", milestone: "2027-03-01", now: "t" }, (prefix) => `${prefix}_${++seq}`),
    ],
  };
}

describe("スケジュールの読み書き", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename: async (from: { fsPath: string }, to: { fsPath: string }, options?: { overwrite?: boolean }) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) throw new FileSystemError("exists", "FileExists");
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) throw new FileSystemError("missing", "FileNotFound");
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;
  });

  test("まだ無ければ空として読み、作らない", async () => {
    expect(await new ScheduleStore(work).load()).toEqual(emptyScheduleFile());
    expect(disk.size).toBe(0);
  });

  test("保存したものはそのまま読み直せる", async () => {
    const store = new ScheduleStore(work);
    await store.load();
    await store.save(sampleFile());
    expect(await new ScheduleStore(work).load()).toEqual(sampleFile());
  });

  test("壊れたJSONは直さずに止め、保存もさせない", async () => {
    const broken = new TextEncoder().encode('{"schemaVersion":"1","schedules":[{"id":"x"');
    disk.set(filePath, broken);
    const store = new ScheduleStore(work);
    await expect(store.load()).rejects.toMatchObject({ kind: "invalid_json" });
    await expect(store.save(sampleFile())).rejects.toMatchObject({ kind: "not_loaded" });
    expect(disk.get(filePath)).toBe(broken);
  });

  test("競合マーカーの入ったファイルも、壊れたJSONとして止める", async () => {
    disk.set(filePath, new TextEncoder().encode('<<<<<<< HEAD\n{"schemaVersion":"1","schedules":[]}\n=======\n'));
    await expect(new ScheduleStore(work).load()).rejects.toBeInstanceOf(ScheduleStoreError);
  });

  test("読み込んだあとに外で書き換わったら、上書きしない", async () => {
    const store = new ScheduleStore(work);
    await store.load();
    await store.save(sampleFile());
    const outside = new TextEncoder().encode(JSON.stringify({ schemaVersion: "1", schedules: [] }));
    disk.set(filePath, outside);
    await expect(store.save(sampleFile())).rejects.toMatchObject({ kind: "modified_externally" });
    expect(disk.get(filePath)).toBe(outside);
  });

  test("読み込んだときに無かったのに外で作られていたら、上書きしない", async () => {
    const store = new ScheduleStore(work);
    await store.load();
    disk.set(filePath, new TextEncoder().encode(JSON.stringify(emptyScheduleFile())));
    await expect(store.save(sampleFile())).rejects.toMatchObject({ kind: "modified_externally" });
  });

  test("CRLF のファイルは CRLF のまま書く（1項目の変更で全行が差分にならない）", async () => {
    const crlf = (JSON.stringify(sampleFile(), null, 2) + "\n").replace(/\n/g, "\r\n");
    disk.set(filePath, new TextEncoder().encode(crlf));
    const store = new ScheduleStore(work);
    const file = await store.load();
    await store.save({ ...file, schedules: [{ ...file.schedules[0], note: "メモ" }] });
    const written = new TextDecoder().decode(disk.get(filePath));
    expect(written.includes("\r\n")).toBe(true);
    expect(/[^\r]\n/.test(written)).toBe(false);
  });

  test("新しく作るファイルは LF で末尾に改行", async () => {
    const store = new ScheduleStore(work);
    await store.load();
    await store.save(sampleFile());
    const written = new TextDecoder().decode(disk.get(filePath));
    expect(written.endsWith("}\n")).toBe(true);
    expect(written.includes("\r")).toBe(false);
  });

  test("エディタで未保存のまま開いていれば書かない", async () => {
    const store = new ScheduleStore(work);
    await store.load();
    workspace.textDocuments = [{ isDirty: true, uri: Uri.file(filePath) }] as unknown as typeof workspace.textDocuments;
    await expect(store.save(sampleFile())).rejects.toMatchObject({ kind: "unsaved_changes" });
  });
});
