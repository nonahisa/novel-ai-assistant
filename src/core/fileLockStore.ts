import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { runSerialized } from "./ledgerQueue";
import { mergeProposalJsonl } from "./editingRepo";
import { workPaths } from "./workRegistry";
import {
  lockOf,
  normalizeFile,
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

  /** 台帳の絶対パス（編集用フォルダーとの突き合わせに使う） */
  get ledgerPath(): string {
    return this.filePath;
  }

  /**
   * 編集部から届いた台帳の行を混ぜる（中身を見ない汎用の JSONL の混ぜ方）。
   * **書き込みの鎖に通す**（`append` と同じ鎖。取り込みと同時でも行が消えない）。
   * 足した行数を返す。
   */
  async mergeIncoming(incoming: string): Promise<number> {
    const target = this.filePath;
    return runSerialized(target, async () => {
      const uri = path.toUri(target);
      let existing = "";
      try {
        existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        // まだ無い
      }
      const merged = mergeProposalJsonl(existing, incoming);
      if (merged.text.length === 0) return 0;
      if (merged.added === 0 && merged.text === existing) return 0;
      await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(merged.text));
      return merged.added;
    });
  }

  private append(events: LockEvent[]): Promise<void> {
    return runSerialized(this.filePath, () => this.appendNow(events));
  }

  private async appendNow(events: LockEvent[]): Promise<void> {
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

/**
 * 作者の側から見て、そのファイルに**編集部の鍵**がかかっているか。
 *
 * 作者の書き込みを断る共通の入口と、原稿エディターが使う。鍵が読めなければ
 * 「かかっていない」（作者の原稿を触れなくする側へは倒さない）。
 */
export async function editorLockOf(
  work: WorkEntry,
  filePath: string
): Promise<FileLock | undefined> {
  const relative = normalizeFile(path.relative(work.folderPath, filePath));
  const lock = await new FileLockStore(work).lockFor(relative);
  return lock && lock.holderKind === "editor" ? lock : undefined;
}
