import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { GitSyncStatus } from "../core/git";

/**
 * 受け取るだけの結果（`GitSyncMonitorLike.receive`）。
 *
 * - `received`：早送りで取り込んだ
 * - `nothing`：受け取るものが無かった（取り寄せたうえで遅れていない）
 * - `skipped`：受け取らなかった。理由は作者に見せる1文
 * - `conflicted`：取り込んだが、退避した書きかけを戻すときに食い違った（残す文を選ぶ要がある）
 * - `failed`：受け取れなかった。理由は作者に見せる1文（詳しくはログ）
 */
export type ReceiveOutcome =
  | { kind: "received"; behind: number }
  | { kind: "nothing" }
  | { kind: "skipped"; reason: string }
  | { kind: "conflicted" }
  | { kind: "failed"; reason: string };

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
  /**
   * その作品と同じ置き場の作品をみな数え直す。開いたときの点検が、動いた置き場だけを
   * 作り直すのに使う。**代役は持たない**（ブラウザ版には git が無い）
   */
  refreshRoot?(
    work: WorkEntry,
    options: { fetch: boolean; notify: boolean }
  ): Promise<GitSyncStatus>;
  pull(work: WorkEntry): Promise<boolean>;
  /**
   * 受け取るだけ（取り寄せて、遅れていれば早送りで取り込む）。**問いも知らせも出さない**
   * ——結果を返し、何と言うかは呼び出し側が1つにまとめて決める（2026-11-01）。
   * 記録も送信もしない。**代役は持たない**（ブラウザ版には git が無い）
   */
  receive?(work: WorkEntry): Promise<ReceiveOutcome>;
  push(work: WorkEntry): Promise<boolean>;
  /**
   * 取り込みのあいだ、設定資料の見張りを止める仕掛けを渡す（設計書5.5.18）。
   *
   * **代役は持たない。** ブラウザ版にはgitの書き込み自体が無いので、
   * 黙らせる相手がいない
   */
  setSettingsPause?(
    pause: ((work?: WorkEntry) => () => void) | undefined
  ): void;
  /** ファイル更新の知らせを、終わるまでためる（設計書5.5.18） */
  beginBatchedFileNotices?(): () => Promise<void>;
  /**
   * 取り込み・送信が走っているか（自動の送り直しを控えるのに使う。
   * 設計書6.15.1）。**代役は持たない**——ブラウザ版には git が無い
   */
  isOperating?(): boolean;
  /**
   * 取り込み・送信の前に待つもの（自動の送り直しの試行）を渡す。
   * **代役は持たない**（同じ理由）
   */
  setBeforeOperation?(wait: (() => Promise<unknown>) | undefined): void;
  /**
   * 置き場の中身が git で入れ替わったかもしれないことを知らせる（2026-10-30）。
   * 取り込み・全作品同期・開いたときの点検・同期のあとの編集部の取り込みが済んだ所で呼ぶ。
   * 届いた承認待ちや設定資料はファイルの見張りに乗らないことがあるので、
   * `extension.ts` はこれを受けてメニューの印を全部数え直す
   */
  notifyRepositoryChanged?(): void;
  /** `notifyRepositoryChanged` の受け口 */
  readonly onDidChangeRepositoryContents?: vscode.Event<void>;
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
  // git が無いので置き場の中身は入れ替わらない。受け口だけ持つ（発しない）
  private readonly repositoryChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeRepositoryContents = this.repositoryChanged.event;

  dispose(): void {
    this.changed.dispose();
    this.filesChanged.dispose();
    this.repositoryChanged.dispose();
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
