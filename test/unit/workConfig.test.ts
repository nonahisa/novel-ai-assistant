import { describe, expect, test } from "vitest";
import * as workRegistry from "../../src/core/workRegistry";
import type { WorkConfig, WorkEntry } from "../../src/models/types";
import { workspace } from "./support/vscodeStub";

const parseWorkConfig = (
  workRegistry as unknown as {
    parseWorkConfig: (raw: unknown) => WorkConfig;
  }
).parseWorkConfig;

const work: WorkEntry = {
  id: "work_test",
  title: "テスト作品",
  folderPath: "C:\\novels\\test-work",
  registeredAt: "2026-08-06T00:00:00.000Z",
};

const validConfig = {
  schemaVersion: "0.1",
  workTitle: "テスト作品",
  manuscriptDir: "本文",
  settingsDir: "設定",
  createdAt: "2026-08-06T00:00:00.000Z",
};

describe("作品設定", () => {
  test("必須項目を持つ設定だけを受理する", () => {
    expect(parseWorkConfig(validConfig)).toEqual(validConfig);
    expect(() => parseWorkConfig({ ...validConfig, workTitle: "" })).toThrow(
      "workTitle"
    );
    expect(() => parseWorkConfig({ ...validConfig, manuscriptDir: 123 })).toThrow(
      "manuscriptDir"
    );
  });

  test.each(["..\\outside", "C:\\outside", "本文\\..\\..\\outside"])(
    "作品ルート外へ出る本文パス %s を拒否する",
    (manuscriptDir) => {
      expect(() =>
        workRegistry.workPaths(work, { ...validConfig, manuscriptDir })
      ).toThrow("作品フォルダ内");
    }
  );

  test("正しい相対パスを作品ルート内の絶対パスへ解決する", () => {
    const paths = workRegistry.workPaths(work, validConfig);
    expect(paths.manuscript).toBe("C:\\novels\\test-work\\本文");
    expect(paths.settings).toBe("C:\\novels\\test-work\\設定");
  });

  test("不正な設定を持つ既存フォルダは登録状態を変更しない", async () => {
    const updates: unknown[] = [];
    const context = {
      globalState: {
        get: <T>(_key: string, defaultValue: T): T => defaultValue,
        update: async (_key: string, value: unknown) => updates.push(value),
      },
    };
    workspace.fs = {
      readFile: async () => new TextEncoder().encode('{"workTitle": 123}'),
    };
    const registry = new workRegistry.WorkRegistry(context as never);

    await expect(
      registry.addExisting("C:\\novels\\broken", "壊れた作品")
    ).rejects.toThrow("作品設定");
    expect(updates).toEqual([]);
  });
});
