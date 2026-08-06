import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import {
  Character,
  characterFileName,
  parseCharacter,
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
    const loadedIds = new Set<string>();

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(d));
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        return { characters, errors };
      }
      throw error;
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
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const character = parseCharacter(parsed);
        if (name !== `${character.id}.json` && !name.startsWith(`${character.id}_`)) {
          throw new Error(`ファイル名と人物ID「${character.id}」が一致しません。`);
        }
        if (loadedIds.has(character.id)) {
          throw new Error(`人物ID「${character.id}」が重複しています。`);
        }
        loadedIds.add(character.id);
        characters.push(character);
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
    const validated = parseCharacter(character);
    const d = await this.ensureDir();
    const fileName = characterFileName(validated);

    // 新しい保存が失敗しても既存データを失わないよう、先に新ファイルを書く。
    const existing = await this.findFileById(validated.id);
    const body = JSON.stringify(
      { ...validated, updatedAt: new Date().toISOString() },
      null,
      2
    );
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(d, fileName)),
      new TextEncoder().encode(body + "\n")
    );

    // 名前変更で旧ファイルが残ると同じIDを二重読込するため、
    // 新ファイルの保存成功後に削除し、失敗は呼び出し側へ通知する。
    if (existing && path.basename(existing) !== fileName) {
      await vscode.workspace.fs.delete(vscode.Uri.file(existing));
    }
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
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") {
        throw error;
      }
      // ディレクトリが無い場合は該当なし
    }
    return undefined;
  }
}

