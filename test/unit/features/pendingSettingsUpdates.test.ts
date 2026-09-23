import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { applyPendingCharacterUpdates } from "../../../src/features/applyPendingUpdates";
import { PendingSettingsUpdateStore } from "../../../src/core/pendingSettingsUpdates";
import {
  emptyLocation,
  locationFileName,
  type Location,
} from "../../../src/models/location";
import type { WorkEntry } from "../../../src/models/types";
import {
  FileSystemError,
  FileType,
  Uri,
  window,
  workspace,
} from "../support/vscodeStub";

/**
 * 「更新分を反映」を人物以外の資料へ広げる（作者の裁定、2026-09-23 問11 B）。
 *
 * **台帳への書き込みは本物の `SettingsStore` を通す**——読み込み時のハッシュ
 * 照合（`assertSaveAllowed`）が効いていることを、代役ではなく実物で確かめる。
 * 承認待ちを積んでから作者が場所を書き換えていたら、古い写しで
 * 巻き戻してはいけない（CLAUDE.md 規則2）。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: ["C:", "novels", "work"].join(path.sep),
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const locationDir = Uri.file(
  path.join(work.folderPath, "設定", "locations")
).fsPath;
const pendingDir = Uri.file(
  path.join(work.folderPath, ".aiwriter", "pending-settings")
).fsPath;

const disk = new Map<string, Uint8Array>();
const directories = new Set<string>();

function bytesFor(record: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
}

function read(filePath: string): Record<string, unknown> {
  const bytes = disk.get(filePath);
  if (!bytes) throw new Error(`${filePath} が無い`);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function seedLocation(overrides: Partial<Location> = {}): {
  record: Location;
  file: string;
} {
  const record: Location = {
    ...emptyLocation("loc_001", "王都"),
    description: "城壁の都",
    authorNotes: "作者の覚え",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
  const file = path.join(locationDir, locationFileName(record));
  disk.set(file, bytesFor(record));
  return { record, file };
}

function fakePanel() {
  const captured = {
    items: [] as Array<{ id: string; name: string; source: string; changes: string[] }>,
    apply: undefined as
      | ((id: string) => Promise<{ ok: boolean; reason?: string }>)
      | undefined,
    dismiss: undefined as
      | ((id: string) => Promise<{ ok: boolean; reason?: string }>)
      | undefined,
  };
  const panel = {
    showRecordUpdates(
      _work: WorkEntry,
      items: typeof captured.items,
      apply: NonNullable<typeof captured.apply>,
      dismiss: NonNullable<typeof captured.dismiss>
    ) {
      captured.items = items;
      captured.apply = apply;
      captured.dismiss = dismiss;
    },
  };
  return { panel, captured };
}

let announced: string[] = [];

beforeEach(() => {
  disk.clear();
  directories.clear();
  directories.add(locationDir);
  announced = [];
  workspace.textDocuments = [];
  workspace.fs = {
    createDirectory: async (uri: { fsPath: string }) => {
      directories.add(uri.fsPath);
    },
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    readDirectory: async (uri: { fsPath: string }) => {
      if (!directories.has(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return [...disk.keys()]
        .filter((filePath) => path.dirname(filePath) === uri.fsPath)
        .map(
          (filePath) =>
            [path.basename(filePath), FileType.File] as [string, FileType]
        );
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
      if (!disk.delete(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
    },
  };
  for (const name of [
    "showInformationMessage",
    "showWarningMessage",
    "showErrorMessage",
  ] as const) {
    window[name] = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as never;
  }
});

describe("場所の更新案を「更新分を反映」で確かめる", () => {
  test("差分つきで提案パネルへ出て、反映すると台帳へ入る。作者メモは残る", async () => {
    const { record, file } = seedLocation();
    await new PendingSettingsUpdateStore(work).stage("location", [
      { ...record, description: "港の都", authorNotes: "AIの覚え" },
    ]);

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    expect(captured.items).toHaveLength(1);
    expect(captured.items[0].name).toBe("王都");
    expect(captured.items[0].source).toContain("場所");
    // 作者メモは取り込まないので、差分にも出ない
    expect(captured.items[0].changes.join("\n")).not.toContain("作者メモ");

    const outcome = await captured.apply!(captured.items[0].id);
    expect(outcome.ok).toBe(true);

    const saved = read(file);
    expect(saved.description).toBe("港の都");
    expect(saved.authorNotes).toBe("作者の覚え");
    // 片付いた
    expect([...disk.keys()].filter((key) => key.startsWith(pendingDir))).toEqual([]);
  });

  test("積んだあとに作者が場所を書き換えていたら、反映しない（承認待ちは残す）", async () => {
    const { record, file } = seedLocation();
    await new PendingSettingsUpdateStore(work).stage("location", [
      { ...record, description: "港の都" },
    ]);

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    // 確認のあいだに、作者が外で書き換えた
    disk.set(file, bytesFor({ ...record, description: "作者が直した説明" }));

    const outcome = await captured.apply!(captured.items[0].id);
    expect(outcome.ok).toBe(false);
    expect(read(file).description).toBe("作者が直した説明");
    expect(
      [...disk.keys()].filter((key) => key.startsWith(pendingDir))
    ).toHaveLength(1);
  });

  test("見送ると承認待ちだけを片付け、台帳には触らない", async () => {
    const { record, file } = seedLocation();
    await new PendingSettingsUpdateStore(work).stage("location", [
      { ...record, description: "港の都" },
    ]);

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);
    const outcome = await captured.dismiss!(captured.items[0].id);

    expect(outcome.ok).toBe(true);
    expect(read(file).description).toBe("城壁の都");
    expect([...disk.keys()].filter((key) => key.startsWith(pendingDir))).toEqual([]);
  });

  test("台帳に読めない場所があれば、その種類の案は出さず、消しもしない", async () => {
    const { record } = seedLocation();
    disk.set(path.join(locationDir, "loc_002_壊れた.json"), new TextEncoder().encode("{壊れ"));
    await new PendingSettingsUpdateStore(work).stage("location", [
      { ...record, description: "港の都" },
    ]);

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    expect(captured.items).toEqual([]);
    expect(
      [...disk.keys()].filter((key) => key.startsWith(pendingDir))
    ).toHaveLength(1);
    expect(announced.join("\n")).toContain("loc_002_壊れた.json");
  });

  test("台帳から消えた場所の案は、古いものとして片付ける", async () => {
    await new PendingSettingsUpdateStore(work).stage("location", [
      { ...emptyLocation("loc_009", "消えた町"), description: "説明" },
    ]);

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    expect(captured.items).toEqual([]);
    expect([...disk.keys()].filter((key) => key.startsWith(pendingDir))).toEqual([]);
  });
});

describe("件数", () => {
  test("種類ごとに数える", async () => {
    const store = new PendingSettingsUpdateStore(work);
    expect(await store.count()).toBe(0);
    await store.stage("location", [
      emptyLocation("loc_001", "王都"),
      emptyLocation("loc_002", "港"),
    ]);
    expect(await store.count()).toBe(2);
    expect(await store.countByKind()).toEqual({ location: 2 });
  });
});
