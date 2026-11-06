import { beforeEach, describe, expect, test, vi } from "vitest";
import * as nodePath from "path";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 校閲のロックをかけた／外した記録の `file` は、**作品フォルダーからの相対パス**
 * （`core/editHistoryFormat.ts` の定義）。
 *
 * ファイル名だけ（`basename`）を書いていたので、章のフォルダーごとに同じ名前の話
 * （`第1章/episode_0001.md`）があると、タイムラインの欄でほかの章の話にも出ていた。
 */

const stub = vi.hoisted(() => {
  class FakeTabInputText {
    constructor(readonly uri: { fsPath: string }) {}
  }
  return {
    FakeTabInputText,
    activeTabInput: undefined as unknown,
    /** 押さえられているファイル（作品からの相対・正規化済み） */
    locked: new Set<string>(),
    edits: [] as Array<{ action: string; file: string }>,
  };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TabInputText: stub.FakeTabInputText,
    window: {
      ...(actual.window as Record<string, unknown>),
      activeTextEditor: undefined,
      // ロックを外す問いには「外す」と答える
      showWarningMessage: async () => "外す",
      showInformationMessage: async () => undefined,
      showQuickPick: async (items: Array<{ label: string }>) => items[0],
      get tabGroups() {
        return {
          activeTabGroup: { activeTab: { input: stub.activeTabInput } },
        };
      },
    },
  };
});

vi.mock("../../../src/core/fileLockStore", () => ({
  FileLockStore: class {
    async lockFor(file: string) {
      return stub.locked.has(file)
        ? { file, holder: "作者", holderKind: "author", since: "", note: "" }
        : undefined;
    }
    async acquire(files: string[]) {
      for (const file of files) stub.locked.add(file);
    }
    async release(files: string[]) {
      for (const file of files) stub.locked.delete(file);
    }
  },
}));

vi.mock("../../../src/core/actorContext", () => ({
  isEditorMode: () => false,
  recordEdit: vi.fn(async (_work: unknown, entry: { action: string; file: string }) => {
    stub.edits.push(entry);
  }),
}));

vi.mock("../../../src/core/gitAttribution", () => ({
  tryGitUserName: vi.fn(async () => "作者"),
}));

vi.mock("../../../src/views/notify", () => ({
  notifyDone: vi.fn(),
}));

import { toggleReviewLock } from "../../../src/features/reviewProposals";

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work"),
  registeredAt: "2026-11-06T00:00:00.000Z",
};

const episode = {
  fsPath: nodePath.join(work.folderPath, "本文", "第1章", "episode_0001.md"),
};

beforeEach(() => {
  stub.activeTabInput = new stub.FakeTabInputText(episode);
  stub.locked.clear();
  stub.edits = [];
});

describe("校閲のロックの編集履歴は、作品からの相対パスで残す", () => {
  test("かけた記録と外した記録", async () => {
    await toggleReviewLock(work);
    await toggleReviewLock(work);

    expect(stub.edits.map((entry) => entry.action)).toEqual([
      "校閲のロックをかけた",
      "校閲のロックを外した",
    ]);
    expect(stub.edits.map((entry) => entry.file)).toEqual([
      "本文/第1章/episode_0001.md",
      "本文/第1章/episode_0001.md",
    ]);
  });
});
