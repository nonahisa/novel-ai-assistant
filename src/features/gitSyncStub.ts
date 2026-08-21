import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { GitSyncStatus } from "../core/git";

/**
 * `GitSyncMonitor` の形。実物とブラウザ版の代役の両方が持つ。
 *
 * **`import type` で持つ。** 型だけなら消えるので、`core/git.ts`
 * （先頭で `node:child_process` を読む）を実際に読み込むことはない。
 */
export interface GitSyncMonitorLike extends vscode.Disposable {
  readonly onDidChange: vscode.Event<void>;
  readonly onDidChangeFiles: vscode.Event<{
    work: WorkEntry;
    files: string[];
  }>;
  statusFor(workId: string): GitSyncStatus | undefined;
  refreshAll(options: { fetch: boolean }): Promise<void>;
  refresh(
    work: WorkEntry,
    options: { fetch: boolean; notify: boolean }
  ): Promise<GitSyncStatus>;
  pull(work: WorkEntry): Promise<boolean>;
  push(work: WorkEntry): Promise<boolean>;
}

/**
 * ブラウザ版の代役（設計書5.8.5）。
 *
 * **`GitSyncMonitor`（`features/gitSync.ts`）は使えない。** 先頭で
 * `core/git.ts` を読み、そこは `node:child_process` を静的importしている。
 * ブラウザには外部プロセスという概念自体が無いので、importするだけで
 * 起動時に落ちる。`canRunProcesses()` が偽のときはこちらを使う。
 *
 * **何もしない。** 状態は常に「gitが無い」を返し、取り込み・送信は
 * 何も起きずに `false` を返す。呼び出し側（ツリーのバッジ描画など）は
 * `GitSyncMonitorLike` の形だけを見ているので、本物と入れ替えても壊れない。
 */
export class NullGitSyncMonitor implements GitSyncMonitorLike {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly filesChanged = new vscode.EventEmitter<{
    work: WorkEntry;
    files: string[];
  }>();

  readonly onDidChange = this.changed.event;
  readonly onDidChangeFiles = this.filesChanged.event;

  dispose(): void {
    this.changed.dispose();
    this.filesChanged.dispose();
  }

  statusFor(): GitSyncStatus | undefined {
    return { kind: "git_missing" };
  }

  async refreshAll(): Promise<void> {
    // 見に行く先（gitコマンド）が無いので何もしない
  }

  async refresh(): Promise<GitSyncStatus> {
    return { kind: "git_missing" };
  }

  async pull(): Promise<boolean> {
    return false;
  }

  async push(): Promise<boolean> {
    return false;
  }
}
