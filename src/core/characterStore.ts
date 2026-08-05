import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import {
  Character,
  characterFileName,
  normalizeCharacter,
} from "../models/character";

/**
 * 登場人物の保存先。
 *
 * 1人1ファイルに分割している。大きな characters.json ひとつだと、
 * 別環境で別々の人物を追記しただけで競合するため。
 * ファイル名に人名を含めるのは、GitHubの差分画面で
 * 何の変更か判別できるようにするため。
 */
export class CharacterStore {
  constructor(private readonly work: WorkEntry) {}

  private async dir(): Promise<string> {
    const config = await readWorkConfig(this.work);
    return path.join(workPaths(this.work, config).settings, "characters");
  }

  async ensureDir(): Promise<string> {
    const d = await this.dir();
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(d));
    return d;
  }

  /** 全人物を読み込む。壊れたJSONは読み飛ばし、エラーとして返す */
  async loadAll(): Promise<{
    characters: Character[];
    errors: Array<{ file: string; message: string }>;
  }> {
    const d = await this.dir();
    const characters: Character[] = [];
    const errors: Array<{ file: string; message: string }> = [];

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(d));
    } catch {
      return { characters, errors };
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      if (!name.endsWith(".json")) continue;
      if (name.startsWith("_")) continue; // _index.json など

      const full = path.join(d, name);
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.file(full)
        );
        const parsed = JSON.parse(
          new TextDecoder().decode(bytes)
        ) as Character;
        characters.push(normalizeCharacter(parsed));
      } catch (e) {
        // 作者が手で編集して壊れた可能性がある。
        // 勝手に修復・上書きせず、エラーとして報告する。
        errors.push({
          file: name,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    characters.sort((a, b) => a.id.localeCompare(b.id));
    return { characters, errors };
  }

  async save(character: Character): Promise<void> {
    const d = await this.ensureDir();
    const fileName = characterFileName(character);

    // 名前が変わった場合、古いファイルが残らないよう削除する
    const existing = await this.findFileById(character.id);
    if (existing && path.basename(existing) !== fileName) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(existing));
      } catch {
        // 消せなくても新規保存は続行する
      }
    }

    const body = JSON.stringify(
      { ...character, updatedAt: new Date().toISOString() },
      null,
      2
    );
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(d, fileName)),
      new TextEncoder().encode(body + "\n")
    );
  }

  async saveAll(characters: Character[]): Promise<void> {
    for (const c of characters) {
      await this.save(c);
    }
  }

  private async findFileById(id: string): Promise<string | undefined> {
    const d = await this.dir();
    try {
      const entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(d)
      );
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
        if (name.startsWith(`${id}_`) || name === `${id}.json`) {
          return path.join(d, name);
        }
      }
    } catch {
      // ディレクトリが無い場合は該当なし
    }
    return undefined;
  }
}

