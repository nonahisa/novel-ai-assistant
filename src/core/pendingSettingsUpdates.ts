import * as vscode from "vscode";
import * as path from "./paths";
import { AIWRITER_DIR, type WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import type { PendingUpdateSource } from "./pendingUpdateFormat";
import type { Location } from "../models/location";
import {
  TRAVEL_DISTANCE_DISMISSED_FILE,
  mergeTravelDistanceDismissed,
  parseTravelDistanceDismissed,
  travelDistanceDismissKeysOf,
} from "./travelCues";
import {
  PENDING_SETTINGS_DIR,
  buildPendingSettingsPayload,
  combinePendingSettingsPayloads,
  parsePendingSettingsPayload,
  pendingSettingsFileName,
  type PendingSettingsKind,
  type PendingSettingsPayload,
  type PendingSettingsRecord,
} from "./pendingSettingsMerge";
// **1件の読み方と並べ方は `pendingReview.ts` が持つ**（0.85.1。MCP の
// `pending.list` も同じものを通る）
import {
  comparePendingSettingsUpdates,
  readPendingSettingsFile,
  type PendingSettingsUpdate,
} from "./pendingReview";

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

/** 1件の形。定義は `pendingReview.ts`（`vscode` を持たない側） */
export type { PendingSettingsUpdate } from "./pendingReview";

export class PendingSettingsUpdateStore {
  constructor(private readonly work: WorkEntry) {}

  private get directory(): string {
    return path.join(this.work.folderPath, AIWRITER_DIR, PENDING_SETTINGS_DIR);
  }

  /**
   * 更新案を積む。**同じレコードの案がもうあれば、差し替えずに合わせる**
   * （`combinePendingSettingsPayloads`。設計書6.88.13）。同じ場所の案が2つ並んでも
   * 作者が困るだけなので1つのファイルにまとめるが、作者がまだ見ていない先の案の
   * 中身は消さない。
   *
   * 先の案が壊れていて読めなければ、**直さず・上書きせずに投げる**（CLAUDE.md 規則2）。
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
      const incoming = buildPendingSettingsPayload(recordKind, record, options);
      const existing = await this.readExisting(target);
      const payload = existing
        ? combinePendingSettingsPayloads(existing, incoming)
        : incoming;
      await atomicWriteFile(
        target,
        new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
      );
    }
  }

  /** 同じ名前の案。無ければ undefined。壊れていたら投げる（読み直して直さない） */
  private async readExisting(
    filePath: string
  ): Promise<PendingSettingsPayload | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(path.toUri(filePath));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return undefined;
      }
      throw error;
    }
    try {
      return parsePendingSettingsPayload(
        JSON.parse(new TextDecoder().decode(bytes))
      );
    } catch (error) {
      throw new Error(
        `承認待ちの案（${path.basename(filePath)}）が読めないため、上書きせずに止めました: ` +
          (error instanceof Error ? error.message : String(error))
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
        updates.push(
          readPendingSettingsFile(
            JSON.parse(new TextDecoder().decode(bytes)),
            filePath
          )
        );
      } catch (error) {
        errors.push({
          file: name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    updates.sort(comparePendingSettingsUpdates);
    return { updates, errors };
  }

  /**
   * 作者が「見送る」を押した案を片付ける。**場所の案なら、含まれる距離を先に覚える**
   * （作者の裁定 2026-10-26「見送ったものはもう出さない」。設計書6.88.13）。
   *
   * 覚えられなかったら投げて、案は残す——覚えないまま消すと、次の事実の照合で
   * 同じ距離がまた提案される（移す案の見送り `dismissPendingNarratorMove` と同じ順）。
   * 古くなった案の片付けはここを通さない（作者が見送ったのではない）。
   */
  async dismiss(update: PendingSettingsUpdate): Promise<void> {
    if (update.recordKind === "location") {
      await new TravelDistanceDismissedHistory(this.work).add(
        travelDistanceDismissKeysOf(update.record as Location)
      );
    }
    await this.discard(update.filePath);
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

/**
 * 見送った距離の控え（`.aiwriter/cache/travel_distance_dismissed.json`）。
 * 形と鍵は `travelCues.ts`（MCP は同じ関数で Node の `fs` から読む）。
 * 作者の原稿でも設定資料でもないので、①の経路（一時ファイル → 置き換え）で書く。
 */
export class TravelDistanceDismissedHistory {
  constructor(private readonly work: WorkEntry) {}

  private filePath(): string {
    return path.join(this.work.folderPath, AIWRITER_DIR, "cache", TRAVEL_DISTANCE_DISMISSED_FILE);
  }

  /** 読めなければ空（覚えていないのと同じ。見送った距離がまた提案されるだけ） */
  async load(): Promise<Set<string>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(path.toUri(this.filePath()));
      return parseTravelDistanceDismissed(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      return new Set();
    }
  }

  /** 鍵を足す。**失敗したら投げる**（呼ぶ側は覚えられたときだけ案を片付ける） */
  async add(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const merged = mergeTravelDistanceDismissed(await this.load(), keys);
    const target = this.filePath();
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    await atomicWriteFile(
      target,
      new TextEncoder().encode(`${JSON.stringify(merged, null, 2)}\n`)
    );
  }
}
