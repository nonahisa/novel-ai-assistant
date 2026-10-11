import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, FileType, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";
import {
  applyRenameToRecords,
  type PendingRename,
} from "../../../src/features/nameRename";
import { buildRenameMapping } from "../../../src/core/nameRename";
import { CharacterStore } from "../../../src/core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../../../src/core/abilityStore";
import { createForeshadowStore } from "../../../src/core/foreshadowStore";
import { SynopsisStore } from "../../../src/core/synopsisStore";
import { emptyCharacter } from "../../../src/models/character";
import { emptyAbility } from "../../../src/models/ability";
import { emptyLocation } from "../../../src/models/location";
import { emptyOrganization } from "../../../src/models/organization";
import { emptyWorldItem } from "../../../src/models/world";
import { emptyForeshadow } from "../../../src/models/foreshadow";
import { emptySynopsisSet } from "../../../src/models/synopsis";

/**
 * 「名前の付け替えを資料にも反映」が、人物以外の資料まで届くか
 * （実機確認リスト F-41。2026-10-11 作者の指示「機械でできる実機確認」）。
 *
 * 人物の記録・plot.md・synopsis.md は画面の自動テスト
 * （`e2e/nameRenameFlow.test.ts`）が見ている。そちらは見本を置いていない
 * **能力・場所・組織・世界観・各話あらすじ・伏線台帳**を、ここで
 * 製品と同じ口（`applyRenameToRecords` → 各ストア）を通して確かめる。
 *
 * 作者が書いたもの（`authorNotes`）は、どの資料でも書き換えない（実装ルール2）。
 * ファイルの居場所（各話あらすじの `fileName`）も名前ではないので変えない。
 */

const work: WorkEntry = {
  id: "work_rename_records",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "rename-records"),
  registeredAt: "2026-10-11T00:00:00.000Z",
};

// 一括の既定から外れないよう、3字以上の名前にする（2字以下は既定で当てない）
const OLD = "真田幸村";
const NEW = "源義経";
const NOTE = `作者のメモ：${OLD}の扱いは後で決める`;

function pending(characterId: string): PendingRename {
  return {
    characterId,
    oldName: OLD,
    newName: NEW,
    newReading: null,
    mapping: buildRenameMapping({ name: OLD }, NEW, null),
    createdAt: "2026-10-11T00:00:00.000Z",
  };
}

describe("名前の付け替えを、人物以外の資料にも当てる", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
    // 記憶の中のファイル。書き方（一時ファイル → 置き換え）は本物と同じ経路を通す
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      readDirectory: async (uri: { fsPath: string }) =>
        [...disk.keys()]
          .filter((filePath) => path.dirname(filePath) === uri.fsPath)
          .map(
            (filePath) =>
              [path.basename(filePath), FileType.File] as [string, FileType]
          ),
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
        return { type: FileType.File, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;
  });

  test("能力・場所・組織・世界観の旧名が新しくなり、作者メモは無傷", async () => {
    const person = emptyCharacter("char_001", OLD);
    await new CharacterStore(work).save(person);

    const ability = emptyAbility("abil_001", "六文銭の守り");
    ability.description = `${OLD}が戦の前に唱える守り`;
    ability.userNames = [OLD];
    ability.authorNotes = NOTE;
    await createAbilityStore(work).saveAll([ability]);

    const location = emptyLocation("loc_001", "上田の城");
    location.description = `${OLD}が籠もった城`;
    location.authorNotes = NOTE;
    await createLocationStore(work).saveAll([location]);

    const organization = emptyOrganization("org_001", "赤備え");
    organization.description = `${OLD}の率いる隊`;
    organization.authorNotes = NOTE;
    await createOrganizationStore(work).saveAll([organization]);

    const world = emptyWorldItem("world_001", "戦の作法");
    world.description = `${OLD}の家では、名乗りを先にする`;
    world.authorNotes = NOTE;
    await createWorldStore(work).saveAll([world]);

    const result = await applyRenameToRecords(work, pending(person.id));

    expect(result.failures).toEqual([]);
    expect(result.characterUpdated).toBe(true);
    // 能力・場所・組織・世界観の4件（人物の本人は数に入らない）
    expect(result.settingsUpdated).toBe(4);

    const [abilityAfter] = (await createAbilityStore(work).loadAll()).records;
    expect(abilityAfter.description).toBe(`${NEW}が戦の前に唱える守り`);
    expect(abilityAfter.userNames).toEqual([NEW]);
    expect(abilityAfter.authorNotes).toBe(NOTE);

    const [locationAfter] = (await createLocationStore(work).loadAll()).records;
    expect(locationAfter.description).toBe(`${NEW}が籠もった城`);
    expect(locationAfter.authorNotes).toBe(NOTE);

    const [organizationAfter] = (await createOrganizationStore(work).loadAll())
      .records;
    expect(organizationAfter.description).toBe(`${NEW}の率いる隊`);
    expect(organizationAfter.authorNotes).toBe(NOTE);

    const [worldAfter] = (await createWorldStore(work).loadAll()).records;
    expect(worldAfter.description).toBe(`${NEW}の家では、名乗りを先にする`);
    expect(worldAfter.authorNotes).toBe(NOTE);
  });

  test("各話あらすじの旧名が新しくなり、ファイル名と作者メモは変えない", async () => {
    const person = emptyCharacter("char_001", OLD);
    await new CharacterStore(work).save(person);

    const synopses = new SynopsisStore(work);
    await synopses.save({
      ...emptySynopsisSet(),
      episodes: [
        {
          chapter: 3,
          // 人物名を含むファイル名。**居場所なので当てない**（当てると本文との対応が切れる）
          fileName: `003_${OLD}の初陣.txt`,
          title: `${OLD}の初陣`,
          synopsis: `${OLD}が初めて槍を取る。`,
          sourceHash: "hash",
          model: null,
          promptVersion: null,
          autoGenerated: true,
          authorNotes: NOTE,
          emotion: null,
          updatedAt: null,
        },
      ],
    });

    const result = await applyRenameToRecords(work, pending(person.id));

    expect(result.failures).toEqual([]);
    expect(result.chapterSynopsesUpdated).toBe(1);
    const [episode] = (await new SynopsisStore(work).load()).episodes;
    expect(episode.synopsis).toBe(`${NEW}が初めて槍を取る。`);
    expect(episode.title).toBe(`${NEW}の初陣`);
    expect(episode.fileName).toBe(`003_${OLD}の初陣.txt`);
    expect(episode.authorNotes).toBe(NOTE);
  });

  test("伏線台帳の名・中身・引用の旧名が新しくなり、作者メモは無傷", async () => {
    const person = emptyCharacter("char_001", OLD);
    await new CharacterStore(work).save(person);

    const foreshadow = emptyForeshadow("foreshadow_1", `${OLD}の六文銭`);
    foreshadow.note = `${OLD}が最期に手放すもの`;
    foreshadow.plantedChapter = 2;
    foreshadow.plantedQuote = `${OLD}は銭を握りしめた。`;
    foreshadow.authorNotes = NOTE;
    await createForeshadowStore(work).saveAll([foreshadow]);

    const result = await applyRenameToRecords(work, pending(person.id));

    expect(result.failures).toEqual([]);
    expect(result.foreshadowsUpdated).toBe(1);
    const [after] = (await createForeshadowStore(work).loadAll()).records;
    expect(after.label).toBe(`${NEW}の六文銭`);
    expect(after.note).toBe(`${NEW}が最期に手放すもの`);
    // 引用は本文と逐語で一致させる（本文も付け替わるので、回収の照合が当たり続ける）
    expect(after.plantedQuote).toBe(`${NEW}は銭を握りしめた。`);
    expect(after.authorNotes).toBe(NOTE);
  });
});
