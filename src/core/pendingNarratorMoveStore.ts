import * as vscode from "vscode";
import * as path from "./paths";
import { AIWRITER_DIR, type WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { workPaths } from "./workRegistry";
import {
  MAX_NARRATOR_MOVE_DISMISSED,
  NARRATOR_MOVE_DISMISSED_FILE,
  PENDING_MOVES_DIR,
  pendingNarratorMoveFileName,
  readPendingNarratorMoveFile,
  type PendingNarratorMove,
  type PendingNarratorMovePayload,
} from "./pendingNarratorMoves";

/**
 * 移す案の承認待ち（`.aiwriter/pending-moves/`）の読み書き（0.102.3。設計書6.5.12）。
 *
 * 形と組み立ては `pendingNarratorMoves.ts`（`vscode` を持たない）。ここは
 * ファイルの出し入れだけ。承認待ちは作者の原稿ではないので、人物の承認待ち
 * （`PendingUpdateStore`）と同じく①の経路（一時ファイル → 置き換え）で書く。
 */
export class PendingNarratorMoveStore {
  constructor(private readonly work: WorkEntry) {}

  private get directory(): string {
    return path.join(this.work.folderPath, AIWRITER_DIR, PENDING_MOVES_DIR);
  }

  /** 積む。同じ鍵のファイルは同じ名前になるので、二重には並ばない */
  async stage(payloads: readonly PendingNarratorMovePayload[]): Promise<void> {
    if (payloads.length === 0) return;
    await vscode.workspace.fs.createDirectory(path.toUri(this.directory));
    for (const payload of payloads) {
      const target = path.join(
        this.directory,
        pendingNarratorMoveFileName(payload.sourceId, payload.key)
      );
      await atomicWriteFile(
        target,
        new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
      );
    }
  }

  /** 読む。**壊れたものは直さず、読み飛ばして報告する** */
  async loadAll(): Promise<{
    moves: PendingNarratorMove[];
    errors: Array<{ file: string; message: string }>;
  }> {
    const moves: PendingNarratorMove[] = [];
    const errors: Array<{ file: string; message: string }> = [];
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(path.toUri(this.directory));
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        return { moves, errors };
      }
      throw error;
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
      const filePath = path.join(this.directory, name);
      try {
        const bytes = await vscode.workspace.fs.readFile(path.toUri(filePath));
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        moves.push(readPendingNarratorMoveFile(parsed, filePath));
      } catch (error) {
        errors.push({
          file: name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 画面と同じ順（主人公ごと、積んだ順）に並べる
    moves.sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        left.stagedAt.localeCompare(right.stagedAt) ||
        left.key.localeCompare(right.key)
    );
    return { moves, errors };
  }

  /** 反映済み・見送った案を片付ける */
  async discard(filePath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(path.toUri(filePath));
    } catch {
      // 消せなくても実害はない。次回の一覧で古い案として片付く
    }
  }

  async count(): Promise<number> {
    return (await this.loadAll()).moves.length;
  }
}

/**
 * 見送った移す案の鍵（`.aiwriter/cache/narrator_move_dismissed.json`）。
 *
 * **誤字脱字の「無視」（`TypoDismissedHistory`）と同じ作り**——鍵の配列・
 * 上限つき・読めなければ空。ファイルは分ける（混ぜると誤字脱字の「無視」の
 * 数え上げに移す案が入る）。
 */
export class NarratorMoveDismissedHistory {
  constructor(private readonly work: WorkEntry) {}

  private filePath(): string {
    return path.join(workPaths(this.work).aiwriter, "cache", NARRATOR_MOVE_DISMISSED_FILE);
  }

  /** 読めなければ空。記録が無くても積むことはできる（見送った案がまた出るだけ） */
  async load(): Promise<Set<string>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(path.toUri(this.filePath()));
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((item): item is string => typeof item === "string"));
    } catch {
      return new Set();
    }
  }

  /**
   * 鍵を足す。**失敗したら例外を投げる**——誤字脱字の「無視」と違い、
   * 覚えられないまま承認待ちを消すと、次の抽出で同じ案がまた積まれる。
   * 呼ぶ側は、覚えられたときだけ承認待ちを片付ける。
   */
  async add(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const existing = await this.load();
    const merged = [...new Set([...existing, ...keys])].slice(-MAX_NARRATOR_MOVE_DISMISSED);
    const target = this.filePath();
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    await atomicWriteFile(
      target,
      new TextEncoder().encode(`${JSON.stringify(merged, null, 2)}\n`)
    );
  }
}
