import { beforeEach, describe, expect, test } from "vitest";
import { saveAndSyncAll } from "../../../src/features/handoffSync";
import { syncAllWorks } from "../../../src/features/syncAllWorks";
import type { GitCommandRunner } from "../../../src/core/git";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { GitSyncMonitorLike } from "../../../src/features/gitSyncStub";
import type { WorkEntry } from "../../../src/models/types";
import { FileType, window, workspace } from "../support/vscodeStub";
import { setFallbackLogRoot, useLogFile } from "../../../src/core/logger";

/**
 * 送り先が Google ドライブの作品は、git の同期に入れない（設計書5.10.9。1つの作品で併用しない）。
 * 渡さなければ今までどおり（Google ドライブを使わない人の［保存・同期］を巻き込まない）。
 */

const driveWork = { id: "d1", title: "ドライブの作品", folderPath: "C:/作品/ドライブ" } as WorkEntry;
const gitWork = { id: "g1", title: "GitHub の作品", folderPath: "C:/作品/ギット" } as WorkEntry;

let works: WorkEntry[] = [];
const registry = { list: () => works } as unknown as WorkRegistry;
const monitor = { refreshAll: async () => undefined, statusFor: () => undefined } as unknown as GitSyncMonitorLike;
const values = new Map<string, unknown>();
const storage = {
  get: <T>(key: string) => values.get(key) as T | undefined,
  update: async (key: string, value: unknown) => {
    values.set(key, value);
  },
};

let cwds: string[] = [];
const run: GitCommandRunner = async (args, cwd) => {
  cwds.push(cwd);
  if (args[0] === "--version") return { code: 0, stdout: "git version 2.51", stderr: "" };
  return { code: 128, stdout: "", stderr: "not a git repository" };
};
let shown: string[] = [];
const isDrive = (work: WorkEntry) => work.id === driveWork.id;

beforeEach(() => {
  cwds = [];
  shown = [];
  values.clear();
  setFallbackLogRoot("");
  useLogFile(undefined);
  Object.assign(workspace, {
    fs: {
      stat: async () => ({ type: FileType.Directory, size: 0, mtime: 0, ctime: 0 }),
      createDirectory: async () => undefined,
      readFile: async () => {
        throw Object.assign(new Error("無い"), { code: "FileNotFound" });
      },
      writeFile: async () => undefined,
    },
  });
  Object.assign(window, {
    withProgress: (
      _options: unknown,
      task: (progress: { report(): void }, token: { isCancellationRequested: boolean }) => unknown
    ) => Promise.resolve(task({ report: () => undefined }, { isCancellationRequested: false })),
    showInformationMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
  });
});

describe("git の同期から外す", () => {
  test("全部がドライブの作品なら、保存・同期は Google ドライブの分だけを走らせ、git を起こさず、git の窓も出さない", async () => {
    works = [driveWork];
    let driveRuns = 0;
    await saveAndSyncAll({
      registry,
      monitor,
      storage,
      run,
      skipWork: isDrive,
      driveSync: async () => {
        driveRuns += 1;
      },
    });
    expect(driveRuns).toBe(1);
    expect(cwds).toEqual([]);
    expect(shown).toEqual([]);
  });

  test("混ざっていれば、git はドライブの作品のフォルダーでは起こさない", async () => {
    works = [driveWork, gitWork];
    await syncAllWorks({ registry, monitor, run, skipWork: isDrive });
    expect(cwds.length).toBeGreaterThan(0);
    expect(cwds.some((cwd) => cwd.includes("ドライブ"))).toBe(false);
  });

  test("渡さなければ今までどおり（全作品で git を起こす）", async () => {
    works = [driveWork, gitWork];
    await syncAllWorks({ registry, monitor, run });
    expect(cwds.some((cwd) => cwd.includes("ドライブ"))).toBe(true);
    expect(cwds.some((cwd) => cwd.includes("ギット"))).toBe(true);
  });
});
