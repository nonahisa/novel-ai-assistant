import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import {
  lockOf,
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
        vscode.Uri.file(this.filePath)
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
      vscode.Uri.file(path.dirname(target))
    );
    const uri = vscode.Uri.file(target);
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

/** 読めない行は捨てて、読める行は残す（競合で壊れた1行で全部を失わない） */
export function parseLockEvents(text: string): LockEvent[] {
  const events: LockEvent[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) continue;
    try {
      const event = toEvent(JSON.parse(line));
      if (event) events.push(event);
    } catch {
      // 壊れた行は捨てる
    }
  }
  return events;
}

function toEvent(value: unknown): LockEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const file = typeof record.file === "string" ? record.file : "";
  // **どのファイルの話か分からない記録は、使いようがない**
  if ((kind !== "acquire" && kind !== "release") || !file) return undefined;
  const holderKind = record.holderKind === "editor" ? "editor" : "author";
  return {
    kind,
    file,
    holder: typeof record.holder === "string" ? record.holder : "",
    holderKind,
    time: typeof record.time === "string" ? record.time : "",
    note: typeof record.note === "string" ? record.note : "",
  };
}
