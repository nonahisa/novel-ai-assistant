import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import { atomicWriteFile, AtomicWriteFileError } from "./atomicWrite";
import { SettingsStore, SettingsStoreError } from "./settingsStore";
import {
  abilityFileName,
  emptyAbilitySystem,
  parseAbility,
  parseAbilitySystem,
  type Ability,
  type AbilitySystem,
} from "../models/ability";
import { locationFileName, parseLocation, type Location } from "../models/location";
import {
  organizationFileName,
  parseOrganization,
  type Organization,
} from "../models/organization";
import {
  parseWorldItem,
  worldItemFileName,
  type WorldItem,
} from "../models/world";

/** 能力の保存先。1件1ファイルにするのは人物と同じ理由（Gitの競合を避ける） */
export function createAbilityStore(work: WorkEntry): SettingsStore<Ability> {
  return new SettingsStore<Ability>(work, {
    directoryName: "abilities",
    idPrefix: "abil",
    parse: parseAbility,
    fileName: abilityFileName,
  });
}

/** 場所の保存先 */
export function createLocationStore(work: WorkEntry): SettingsStore<Location> {
  return new SettingsStore<Location>(work, {
    directoryName: "locations",
    idPrefix: "loc",
    parse: parseLocation,
    fileName: locationFileName,
  });
}

/** 世界観の保存先。1件1ファイルにするのは他と同じ理由 */
export function createWorldStore(work: WorkEntry): SettingsStore<WorldItem> {
  return new SettingsStore<WorldItem>(work, {
    directoryName: "world",
    idPrefix: "world",
    parse: parseWorldItem,
    fileName: worldItemFileName,
  });
}

/** 組織の保存先。人物の所属（affiliation）に対応する */
export function createOrganizationStore(
  work: WorkEntry
): SettingsStore<Organization> {
  return new SettingsStore<Organization>(work, {
    directoryName: "organizations",
    idPrefix: "org",
    parse: parseOrganization,
    fileName: organizationFileName,
  });
}

/**
 * 能力体系の設定（総称・規則）を読み書きする。
 *
 * 1件しかないので個別ファイルにせず、設定フォルダ直下に置く。
 */
export class AbilitySystemStore {
  constructor(private readonly work: WorkEntry) {}

  private async filePath(): Promise<string> {
    const config = await readWorkConfig(this.work);
    return path.join(
      workPaths(this.work, config).settings,
      "ability_system.json"
    );
  }

  /** 未作成なら既定値を返す。壊れていれば例外を投げて保存を止める */
  async load(): Promise<AbilitySystem> {
    const file = await this.filePath();
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return emptyAbilitySystem();
      }
      throw error;
    }
    return parseAbilitySystem(JSON.parse(new TextDecoder().decode(bytes)));
  }

  async save(system: AbilitySystem): Promise<void> {
    const file = await this.filePath();
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(file))
    );
    const body =
      JSON.stringify(
        { ...system, updatedAt: new Date().toISOString() },
        null,
        2
      ) + "\n";
    try {
      await atomicWriteFile(file, new TextEncoder().encode(body));
    } catch (error) {
      if (error instanceof AtomicWriteFileError) {
        throw new SettingsStoreError(
          `能力体系の設定を保存できませんでした。${error.message}`,
          "io_error",
          error.recoveryPaths ?? []
        );
      }
      throw error;
    }
  }
}
