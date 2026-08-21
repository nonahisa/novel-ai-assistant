import * as vscode from "vscode";
import * as path from "./paths";
import { AIWRITER_DIR, WorkEntry } from "../models/types";
import { parseCharacter, type Character } from "../models/character";
import { atomicWriteFile } from "./atomicWrite";

/**
 * 抽出で作られた「既存人物の更新案」の置き場。
 *
 * このプロジェクトは既存ファイルを上書きしない（`atomicWrite` を参照）。
 * そのため抽出しても既存人物には反映されず、以前は毎回失敗として
 * 回復ディレクトリに提案ファイルが溜まるだけだった。
 *
 * 更新案をここへ貯めておき、作者が内容を見て承認したときにだけ反映する。
 * 新規人物の承認制と同じ考え方で、AIの判断を黙って原稿へ入れない。
 *
 * `.aiwriter` の下に置くのは、作者が読む「設定」フォルダーを
 * 未確定のファイルで散らかさないため。
 */

const PENDING_DIR = "pending-characters";

export interface PendingUpdate {
  /** 更新案。既存レコードと同じID */
  character: Character;
  /** 保留ファイルのパス。反映後に片付ける */
  filePath: string;
}

export class PendingUpdateStore {
  constructor(private readonly work: WorkEntry) {}

  private get directory(): string {
    return path.join(this.work.folderPath, AIWRITER_DIR, PENDING_DIR);
  }

  async stage(characters: Character[]): Promise<void> {
    if (characters.length === 0) return;
    await vscode.workspace.fs.createDirectory(
      path.toUri(this.directory)
    );

    for (const character of characters) {
      const target = path.join(this.directory, `${character.id}.json`);
      const body = `${JSON.stringify(character, null, 2)}\n`;
      // 保留ファイルは作者の原稿ではないので、上書きしてよい。
      // 同じ人物の更新案が2つ並んでも作者が困るだけ
      await atomicWriteFile(target, new TextEncoder().encode(body));
    }
  }

  /** 保留中の更新案を読む。壊れたものは読み飛ばして報告する */
  async loadAll(): Promise<{
    updates: PendingUpdate[];
    errors: Array<{ file: string; message: string }>;
  }> {
    const updates: PendingUpdate[] = [];
    const errors: Array<{ file: string; message: string }> = [];

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        path.toUri(this.directory)
      );
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return { updates, errors };
      }
      throw error;
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
      const filePath = path.join(this.directory, name);
      try {
        const bytes = await vscode.workspace.fs.readFile(
          path.toUri(filePath)
        );
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        updates.push({ character: parseCharacter(parsed), filePath });
      } catch (error) {
        errors.push({
          file: name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    updates.sort((a, b) => a.character.id.localeCompare(b.character.id));
    return { updates, errors };
  }

  /** 反映済み・破棄した更新案を片付ける */
  async discard(filePath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(path.toUri(filePath));
    } catch {
      // 消せなくても実害はない。次回の一覧に残るだけ
    }
  }

  async count(): Promise<number> {
    return (await this.loadAll()).updates.length;
  }
}
