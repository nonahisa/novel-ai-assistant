import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import {
  lockOf,
  parseLockEvents,
  resolveLocks,
  type FileLock,
  type LockEvent,
  type LockHolderKind,
} from "../models/fileLock";

/**
 * 校閲ロックの置き場（設計書5.6）。
 *
 * `.aiwriter/locks/locks.jsonl`。**同期される**
 * （外れているのは `cache/` と `logs/` だけ）。
 *
 * **追記だけ。** 提案・編集履歴と同じ理由である。
 */

const LOCK_DIRECTORY = "locks";
const LOCK_FILE = "locks.jsonl";

export class FileLockStore {
  constructor(private readonly work: WorkEntry) {}

  private get filePath(): string {
    return path.join(workPaths(this.work).aiwriter, LOCK_DIRECTORY, LOCK_FILE);
  }

  /** いまかかっているロック */
  async load(): Promise<Map<string, FileLock>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        path.toUri(this.filePath)
      );
      return resolveLocks(parseLockEvents(new TextDecoder().decode(bytes)));
    } catch {
      return new Map();
    }
  }

  /** そのファイルのロック（無ければ undefined） */
  async lockFor(relativePath: string): Promise<FileLock | undefined> {
    return lockOf(await this.load(), relativePath);
  }

  async acquire(
    files: string[],
    holder: string,
    holderKind: LockHolderKind,
    note: string
  ): Promise<void> {
    await this.append(
      files.map((file) => ({
        kind: "acquire" as const,
        file,
        holder,
        holderKind,
        time: new Date().toISOString(),
        note,
      }))
    );
  }

  /**
   * 外す。
   *
   * **誰でも外せる。** 作者が自分の原稿を触れなくなることだけは
   * 起きてはならない（編集部が外し忘れて連絡が付かない場合がある）。
   * 誰が外したかは記録に残るので、勝手に外したことは後から分かる。
   */
  async release(
    files: string[],
    holder: string,
    holderKind: LockHolderKind,
    note = ""
  ): Promise<void> {
    await this.append(
      files.map((file) => ({
        kind: "release" as const,
        file,
        holder,
        holderKind,
        time: new Date().toISOString(),
        note,
      }))
    );
  }

  private async append(events: LockEvent[]): Promise<void> {
    if (events.length === 0) return;
    const target = this.filePath;
    const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(target))
    );
    const uri = path.toUri(target);
    let existing: Uint8Array;
    try {
      existing = await vscode.workspace.fs.readFile(uri);
    } catch {
      existing = new Uint8Array();
    }
    const added = new TextEncoder().encode(text);
    const merged = new Uint8Array(existing.byteLength + added.byteLength);
    merged.set(existing, 0);
    merged.set(added, existing.byteLength);
    await vscode.workspace.fs.writeFile(uri, merged);
  }
}

/*
  行の読み方（`parseLockEvents`）は `models/fileLock.ts` に在る（2026-10-03）。
  MCP の取り込み（出先の原稿箱 6.115）が校閲中かを確かめるため、`vscode` に
  触らない側へ移した。これまでどおりここからも使える
*/
export { parseLockEvents };
