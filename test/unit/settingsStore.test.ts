import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SettingsStoreError } from "../../src/core/settingsStore";
import {
  createAbilityStore,
  createLocationStore,
} from "../../src/core/abilityStore";
import {
  abilityFileName,
  emptyAbility,
  type Ability,
} from "../../src/models/ability";
import { emptyLocation, type Location } from "../../src/models/location";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, FileType, Uri, workspace } from "./support/vscodeStub";

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-08-08T00:00:00.000Z",
};

const abilityDir = Uri.file(
  path.join(work.folderPath, "設定", "abilities")
).fsPath;
const locationDir = Uri.file(
  path.join(work.folderPath, "設定", "locations")
).fsPath;

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesFor(record: unknown): Uint8Array {
  return utf8(`${JSON.stringify(record, null, 2)}\n`);
}

function fixedAbility(id: string, name: string): Ability {
  return { ...emptyAbility(id, name), updatedAt: "2026-08-08T00:00:00.000Z" };
}

function fixedLocation(id: string, name: string): Location {
  return { ...emptyLocation(id, name), updatedAt: "2026-08-08T00:00:00.000Z" };
}

describe("能力・場所の保存", () => {
  const disk = new Map<string, Uint8Array>();
  const directories = new Set<string>();

  beforeEach(() => {
    disk.clear();
    directories.clear();
    directories.add(abilityDir);
    directories.add(locationDir);
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
  });

  test("読み込み後に外部で変更された能力を上書きしない", async () => {
    // AI応答には時間がかかり、その間に作者が編集しうる
    const original = fixedAbility("abil_001", "灯火");
    const file = path.join(abilityDir, abilityFileName(original));
    disk.set(file, bytesFor(original));

    const store = createAbilityStore(work);
    const loaded = await store.loadAll();
    expect(loaded.records).toHaveLength(1);

    // 作者が同じファイルを書き換えた
    const edited = { ...original, authorNotes: "作者が書いたメモ" };
    disk.set(file, bytesFor(edited));

    await expect(
      store.saveAll([{ ...loaded.records[0], description: "AIの説明" }])
    ).rejects.toMatchObject({ kind: "modified_externally" });

    // 作者の変更が残っていること
    expect(new TextDecoder().decode(disk.get(file)!)).toContain(
      "作者が書いたメモ"
    );
  });

  test("未保存の変更があれば書き込まない", async () => {
    const original = fixedAbility("abil_001", "灯火");
    const file = path.join(abilityDir, abilityFileName(original));
    disk.set(file, bytesFor(original));

    const store = createAbilityStore(work);
    await store.loadAll();

    workspace.textDocuments = [
      { uri: { fsPath: file }, isDirty: true, getText: () => "" },
    ];

    await expect(store.saveAll([original])).rejects.toMatchObject({
      kind: "unsaved_changes",
    });
  });

  test("壊れたJSONは読み飛ばしてエラーとして返す", async () => {
    disk.set(path.join(abilityDir, "abil_001_壊れ.json"), utf8("{ not json"));
    disk.set(
      path.join(abilityDir, "abil_002_灯火.json"),
      bytesFor(fixedAbility("abil_002", "灯火"))
    );

    const store = createAbilityStore(work);
    const loaded = await store.loadAll();

    // 勝手に修復・上書きせず、読めたものだけ返す
    expect(loaded.records.map((r) => r.id)).toEqual(["abil_002"]);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0].file).toBe("abil_001_壊れ.json");
  });

  test("ファイル名とIDが食い違うファイルをエラーにする", async () => {
    disk.set(
      path.join(abilityDir, "abil_999_別名.json"),
      bytesFor(fixedAbility("abil_001", "灯火"))
    );

    const loaded = await createAbilityStore(work).loadAll();

    expect(loaded.records).toEqual([]);
    expect(loaded.errors[0].message).toContain("一致しません");
  });

  test("IDが重複するファイルをエラーにする", async () => {
    disk.set(
      path.join(abilityDir, "abil_001_灯火.json"),
      bytesFor(fixedAbility("abil_001", "灯火"))
    );
    disk.set(
      path.join(abilityDir, "abil_001_別.json"),
      bytesFor(fixedAbility("abil_001", "別"))
    );

    const loaded = await createAbilityStore(work).loadAll();

    expect(loaded.errors.some((e) => e.message.includes("重複"))).toBe(true);
  });

  test("保存対象内でIDが重複していれば書き込む前に止める", async () => {
    const store = createAbilityStore(work);

    await expect(
      store.saveAll([
        fixedAbility("abil_001", "灯火"),
        fixedAbility("abil_001", "別"),
      ])
    ).rejects.toBeInstanceOf(SettingsStoreError);
    expect(disk.size).toBe(0);
  });

  test("名前が変わったら古いファイルを残さない", async () => {
    const original = fixedAbility("abil_001", "灯火");
    const oldFile = path.join(abilityDir, abilityFileName(original));
    disk.set(oldFile, bytesFor(original));

    const store = createAbilityStore(work);
    const loaded = await store.loadAll();

    const renamed = { ...loaded.records[0], name: "大灯火" };
    await store.saveAll([renamed]);

    expect(disk.has(oldFile)).toBe(false);
    expect(disk.has(path.join(abilityDir, abilityFileName(renamed)))).toBe(true);
  });

  test("大文字小文字だけを変えた改名で、その資料を消さない", async () => {
    // Windowsのファイルシステムは大文字小文字を区別しない。
    // `abil_001_Fire.json` へ書いたあと `abil_001_fire.json` を消すと、
    // **同じ1つのファイルなので、今書いたものが消える**（資料が丸ごと失われる）。
    // 人物側は `samePath` で判定していたが、設定資料側は文字列比較のままだった。
    const caseInsensitive = process.platform === "win32";
    const findKey = (filePath: string): string | undefined =>
      caseInsensitive
        ? [...disk.keys()].find(
            (key) => key.toLowerCase() === filePath.toLowerCase()
          )
        : disk.has(filePath)
          ? filePath
          : undefined;
    // 実際のプラットフォームに合わせた読み書きにする
    const base = workspace.fs;
    workspace.fs = {
      ...base,
      readFile: async (uri: { fsPath: string }) => {
        const key = findKey(uri.fsPath);
        if (!key) throw new FileSystemError("missing", "FileNotFound");
        return disk.get(key) as Uint8Array;
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        const fromKey = findKey(from.fsPath);
        if (!fromKey) throw new FileSystemError("missing", "FileNotFound");
        const toKey = findKey(to.fsPath);
        if (!options?.overwrite && toKey) {
          throw new FileSystemError("exists", "FileExists");
        }
        const bytes = disk.get(fromKey) as Uint8Array;
        if (toKey) disk.delete(toKey);
        disk.delete(fromKey);
        disk.set(to.fsPath, bytes);
      },
      delete: async (uri: { fsPath: string }) => {
        const key = findKey(uri.fsPath);
        if (!key) throw new FileSystemError("missing", "FileNotFound");
        disk.delete(key);
      },
    };

    const original = fixedAbility("abil_001", "Fire");
    disk.set(path.join(abilityDir, abilityFileName(original)), bytesFor(original));

    const store = createAbilityStore(work);
    const loaded = await store.loadAll();
    await store.saveAll([{ ...loaded.records[0], name: "fire" }]);

    // 読み直して1件あること。消えていたら0件になる
    const after = await createAbilityStore(work).loadAll();
    expect(after.errors).toEqual([]);
    expect(after.records.map((record) => record.name)).toEqual(["fire"]);
  });

  test("ディレクトリが無くても空として読み込める", async () => {
    directories.delete(abilityDir);

    const loaded = await createAbilityStore(work).loadAll();

    expect(loaded).toEqual({ records: [], errors: [] });
  });

  test("場所も同じ保護で保存できる", async () => {
    const original = fixedLocation("loc_001", "図書塔");
    const file = path.join(locationDir, "loc_001_図書塔.json");
    disk.set(file, bytesFor(original));

    const store = createLocationStore(work);
    const loaded = await store.loadAll();
    expect(loaded.records).toHaveLength(1);

    disk.set(file, bytesFor({ ...original, authorNotes: "作者メモ" }));

    await expect(store.saveAll(loaded.records)).rejects.toMatchObject({
      kind: "modified_externally",
    });
  });
});
