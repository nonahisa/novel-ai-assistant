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

/**
 * 台帳へ書いたあとに呼ぶ相手（設計書5.7.5.2。0.139.0）。
 *
 * 鍵が届く道は多い（開いたときの取りに行き・同期のあとの取り込み・手動の受け取り・
 * 作者の解除）。**どの道で届いても、開いている原稿エディターの帯と素のエディターの
 * 読み取り専用を描き直す**ため、書く所（この台帳）で知らせる。道ごとに知らせると、
 * 足した新しい道が知らせ忘れる。
 *
 * VS Code の仕組み（EventEmitter）を使わないのは、この層を VS Code の知らせの形に
 * 寄せないため（`core` は呼ぶ側を知らない）。
 */
type LockLedgerListener = (work: WorkEntry) => void;
const lockLedgerListeners = new Set<LockLedgerListener>();

export function onLockLedgerWritten(listener: LockLedgerListener): { dispose(): void } {
  lockLedgerListeners.add(listener);
  return { dispose: () => void lockLedgerListeners.delete(listener) };
}

function announceLockLedgerWritten(work: WorkEntry): void {
  for (const listener of [...lockLedgerListeners]) {
    try {
      listener(work);
    } catch {
      // 描き直しの失敗で台帳の書き込みを失敗にしない（書けたことは本当）
    }
  }
}

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
    /*
      **解除の時刻は `max(今, その鍵の since + 1ms)`。** いちばん新しい記録が勝つ作りなので、
      端末の時計が遅れていると、解除の行のほうが古いと読まれ、解除したのに鍵が残る
      （作者が書けないままになる）。鍵より必ず新しい時刻を付ける。
    */
    const held = await this.load();
    const now = Date.now();
    await this.append(
      files.map((file) => {
        const since = Date.parse(held.get(normalizeFile(file))?.since ?? "");
        const time = Number.isNaN(since) ? now : Math.max(now, since + 1);
        return {
          kind: "release" as const,
          file,
          holder,
          holderKind,
          time: new Date(time).toISOString(),
          note,
        };
      })
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
      announceLockLedgerWritten(this.work);
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
    announceLockLedgerWritten(this.work);
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
