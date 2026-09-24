import * as path from "path";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, Uri, workspace } from "../support/vscodeStub";
import { TimelineStore } from "../../../src/core/timelineStore";
import {
  addTimepoint,
  assignEpisode,
  toTimelineEpisodePath,
} from "../../../src/core/timelineEdit";
import { emptyTimeline } from "../../../src/models/timeline";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 時期を作って話へ結んだものが `設定/timeline.json` に残り、**開き直しても
 * 同じに読める**か（設計書6.39。実機確認リスト F-44 の代わり）。
 *
 * 「時期・系統を編集」は、選んだ結果を `timelineEdit.ts` で組み立て、
 * `TimelineStore.save` で書く（`features/chronicleEdit.ts`）。ここでは
 * 画面の問いを飛ばして、**同じ組み立てと同じ保存の口**を通す。
 * 開き直しは、新しい `TimelineStore` で読み直すことで写す（保存した側の
 * 控えを持たない）。2回目の保存は既存ファイルがある道（退避 → 新規作成）を通る。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const timelinePath = Uri.file(
  path.join(work.folderPath, "設定", "timeline.json")
).fsPath;

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
    rename: async (
      from: { fsPath: string },
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (!options?.overwrite && disk.has(to.fsPath)) {
        throw new FileSystemError("exists", "FileExists");
      }
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
    readDirectory: async () => [],
  } as unknown as typeof workspace.fs;
});

const episode3 = path.join(work.folderPath, "本文", "003.txt");

describe("時期を作り、話へ結んで保存する", () => {
  test("まだ無ければ、系統なしとして読める（ファイルは作らない）", async () => {
    expect(await new TimelineStore(work).load()).toEqual(emptyTimeline());
    expect(disk.has(timelinePath)).toBe(false);
  });

  test("保存すると timeline.json ができ、開き直しても時期と結びつきが残る", async () => {
    const store = new TimelineStore(work);
    const made = addTimepoint(await store.load(), {
      label: "十年前",
      absolute: "王暦302年",
    });
    const assigned = assignEpisode(
      made.timeline,
      toTimelineEpisodePath(work.folderPath, episode3),
      made.timepoint.id
    );
    await store.save(assigned);

    expect(disk.has(timelinePath)).toBe(true);

    const reopened = await new TimelineStore(work).load();
    expect(reopened.timepoints.map((point) => point.label)).toEqual(["十年前"]);
    expect(reopened.timepoints[0].absolute).toBe("王暦302年");
    // 本編は、最初の時期を足したときに黙って1本だけ作られる
    expect(reopened.lines.map((line) => line.kind)).toEqual(["main"]);
    expect(reopened.episodes).toEqual([
      { filePath: "本文/003.txt", timepointId: made.timepoint.id, note: "" },
    ]);
  });

  test("2回目の保存（既にファイルがある）でも、足したものが読み直せる", async () => {
    const first = new TimelineStore(work);
    const one = addTimepoint(await first.load(), { label: "十年前" });
    await first.save(one.timeline);

    // 開き直してから、2つ目の時期を足して結び直す
    const second = new TimelineStore(work);
    const two = addTimepoint(await second.load(), { label: "本編開始" });
    await second.save(
      assignEpisode(
        two.timeline,
        toTimelineEpisodePath(work.folderPath, episode3),
        two.timepoint.id
      )
    );

    const reopened = await new TimelineStore(work).load();
    expect(reopened.timepoints.map((point) => point.label)).toEqual([
      "十年前",
      "本編開始",
    ]);
    expect(reopened.episodes[0]?.timepointId).toBe(two.timepoint.id);
    // 前の版は消さずに回復先へ退避している（上書きの道を使わない）
    const backups = [...disk.keys()].filter((key) => key.endsWith(".bak"));
    expect(backups).toHaveLength(1);
  });

  test("「時期・系統を編集」は、この保存の口だけで書く", () => {
    // 画面の問いから組み立てた結果を、上の試験と同じ口へ渡していること
    const source = readFileSync("src/features/chronicleEdit.ts", "utf8");
    expect(source).toContain("new TimelineStore(work)");
    expect(source).toContain("await context.store.save(validated);");
    expect(source).not.toMatch(/atomicWriteFile|workspace\.fs\.writeFile/);
  });
});
