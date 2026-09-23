import * as vscode from "vscode";
import * as path from "./paths";
import { AIWRITER_DIR, type WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import type { PendingUpdateSource } from "./pendingUpdateFormat";
import {
  PENDING_SETTINGS_DIR,
  buildPendingSettingsPayload,
  parsePendingSettingsPayload,
  pendingSettingsFileName,
  type PendingSettingsKind,
  type PendingSettingsRecord,
} from "./pendingSettingsMerge";

/**
 * 人物以外（能力・組織・場所・世界観）の承認待ちの置き場
 * （`.aiwriter/pending-settings/`。作者の裁定、2026-09-23 問11 B）。
 *
 * 人物の `PendingUpdateStore` と同じ考え方——AIの読みを黙って台帳へ入れず、
 * 作者が「更新分を反映」で中身を見て採ったものだけを入れる。
 * 形と取り込みの規則は `pendingSettingsMerge.ts` が持つ。
 *
 * **積む道は、いまは外部AIの提案（MCP `novel.propose`、0.83.10）だけ。**
 * MCP の束は `vscode` を持てないので、この `stage` は通らず、Node の `fs` で
 * 同じ形（`buildPendingSettingsPayload`）を書く（`mcp/tools/proposeRecord.ts`）。
 * 抽出は人物以外をこれまでどおりマージして直接保存する（`extractSettings.ts`）。
 * 相談からの反映（6.72）は人物だけ（P-32 が人物しか拾わない。設計書の
 * 「人物以外の承認待ちも」の節）。
 */

export interface PendingSettingsUpdate {
  recordKind: PendingSettingsKind;
  /** 更新案。既存レコードと同じID */
  record: PendingSettingsRecord;
  /** 保留ファイルのパス。反映後に片付ける */
  filePath: string;
  source?: PendingUpdateSource;
  reason?: string;
}

export class PendingSettingsUpdateStore {
  constructor(private readonly work: WorkEntry) {}

  private get directory(): string {
    return path.join(this.work.folderPath, AIWRITER_DIR, PENDING_SETTINGS_DIR);
  }

  /**
   * 更新案を積む。同じレコードの案は差し替える（承認待ちは作者の原稿では
   * ないので上書きしてよい。同じ場所の案が2つ並んでも作者が困るだけ）。
   */
  async stage(
    recordKind: PendingSettingsKind,
    records: PendingSettingsRecord[],
    options: { source?: PendingUpdateSource; reason?: string } = {}
  ): Promise<void> {
    if (records.length === 0) return;
    await vscode.workspace.fs.createDirectory(path.toUri(this.directory));
    for (const record of records) {
      const target = path.join(this.directory, pendingSettingsFileName(record));
      const payload = buildPendingSettingsPayload(recordKind, record, options);
      await atomicWriteFile(
        target,
        new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
      );
    }
  }

  /** 保留中の案を読む。**壊れたものは読み飛ばして報告し、消さない** */
  async loadAll(): Promise<{
    updates: PendingSettingsUpdate[];
    errors: Array<{ file: string; message: string }>;
  }> {
    const updates: PendingSettingsUpdate[] = [];
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
        const bytes = await vscode.workspace.fs.readFile(path.toUri(filePath));
        const payload = parsePendingSettingsPayload(
          JSON.parse(new TextDecoder().decode(bytes))
        );
        updates.push({ ...payload, filePath });
      } catch (error) {
        errors.push({
          file: name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    updates.sort((a, b) => a.record.id.localeCompare(b.record.id));
    return { updates, errors };
  }

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

  /** 種類ごとの件数。0件の種類は持たない */
  async countByKind(): Promise<Partial<Record<PendingSettingsKind, number>>> {
    const counts: Partial<Record<PendingSettingsKind, number>> = {};
    for (const update of (await this.loadAll()).updates) {
      counts[update.recordKind] = (counts[update.recordKind] ?? 0) + 1;
    }
    return counts;
  }
}
