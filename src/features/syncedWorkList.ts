import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import {
  mergeLocalWorks,
  readSyncedWorkList,
  removeSyncedWork,
  toStoredList,
  worksMissingHere,
  type LocalWorkRemote,
  type SyncedWork,
} from "../core/syncedWorkList";
// ログの書き先：作品が定まらない
// 作品の一覧（設定の同期）は全作品にまたがる1つの台帳で、どの作品のログにも属さない。
// 記録は出力チャンネルだけに出す
import { logFailure } from "../core/logger";

/**
 * 作品の一覧を VS Code の設定の同期で別の機械へ運ぶ（設計書5.5.11.1）。
 *
 * globalState の1つの鍵に置き、`setKeysForSync` で同期の対象にする。
 * 同期の中身を決めるのは `core/syncedWorkList.ts`（名前と URL だけ・和集合）。
 *
 * **このファイルは git を静的に読み込まない。** `core/git.ts` は `node:child_process` を
 * 読むので、静的に引くとブラウザ版の束が起動した瞬間に落ちる（実装ルール7）。
 * origin の URL は、使うときに動的 import で読む。そもそも `extension.ts` は
 * 手元の VS Code（`canRunProcesses()`）のときだけこのファイルを読む。
 */

/** globalState の鍵 */
export const SYNCED_WORKS_KEY = "novelai.syncedWorks";

/**
 * 設定の同期で運ぶ globalState の鍵の全部。
 *
 * **`setKeysForSync` は呼ぶたびに丸ごと差し替える**ので、運ぶ鍵を増やすときは
 * ここへ足す（別の所で呼ぶと、先に渡した鍵が同期から外れる）
 */
export const GLOBAL_STATE_SYNC_KEYS: readonly string[] = [SYNCED_WORKS_KEY];

/** 起動のあと、作品一覧の走査と重ならないよう待つ時間 */
export const STARTUP_REFRESH_DELAY_MS = 20_000;

/** 登録・名前の変更が続いたときにまとめて読む待ち時間 */
export const CHANGE_REFRESH_DELAY_MS = 2_000;

/** origin を読む上限。ローカルだけで終わる問い合わせ */
const ORIGIN_TIMEOUT_MS = 15_000;

/** 読み書きに使う保管庫（`VerifiedState` の一部。試験から作り物を渡す） */
export interface SyncedWorkState {
  get<T>(key: string): T | undefined;
  patch<T>(key: string, defaultValue: T, change: (current: T) => T): Promise<T>;
}

export interface SyncedWorkListOptions {
  state: SyncedWorkState;
  /** この機械に登録した作品 */
  works: () => readonly WorkEntry[];
  /**
   * 読み書きしてよいか。ブラウザ版（外部プロセスを起こせない）と編集者モードでは false
   * （編集者の機械の作品を作者の一覧へ混ぜない。並べもしない）
   */
  enabled: () => boolean;
  /** 作品フォルダーの origin の URL。無ければ undefined（試験から差し替える） */
  readOrigin?: (folderPath: string) => Promise<string | undefined>;
  now?: () => string;
  /** 一覧が読めなかったとき（既定はログへ） */
  onUnreadable?: (reason: string) => void;
}

/** 作品一覧（ツリー）へ渡す口。`views/workTree.ts` の `OtherMachineWorksSource` と同じ形 */
export class SyncedWorkList implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  /**
   * この機械の作品の origin の URL。**まだ読んでいない間は undefined**——読む前に
   * 「無い作品」を並べると、この機械にある作品まで一度「ほかの機械の作品」に出てしまう
   */
  private localRemotes: string[] | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private disposed = false;

  constructor(private readonly options: SyncedWorkListOptions) {}

  /** この機械に無い作品（ツリーに並べる行） */
  list(): readonly SyncedWork[] {
    if (!this.options.enabled() || !this.localRemotes) return [];
    const read = readSyncedWorkList(this.options.state.get<unknown>(SYNCED_WORKS_KEY));
    // 壊れていれば並べない（理由は読み直しのときにログへ出している）
    if (!read.ok) return [];
    return worksMissingHere(read.works, this.localRemotes);
  }

  /** 少し待ってから読み直す。続けて呼ばれたら最後の1回にまとめる */
  scheduleRefresh(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch((error) => {
        logFailure("作品の一覧（設定の同期）の読み直し", {
          詳細: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
  }

  /**
   * この機械の作品の origin を読み、一覧へ足す。
   *
   * 走っている最中に呼ばれたら、終わってからもう1回だけ走らせる
   * （その間に登録された作品を取りこぼさない）
   */
  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.refreshOnce();
        } while (this.again && !this.disposed);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async refreshOnce(): Promise<void> {
    if (!this.options.enabled()) return;
    const local = await this.readLocalRemotes();
    this.localRemotes = local.map((work) => work.remoteUrl);
    await this.write((current) => mergeLocalWorks(current, local, this.now()));
    this.changed.fire();
  }

  /** ［一覧から外す］ */
  async forget(work: SyncedWork): Promise<void> {
    if (!this.options.enabled()) return;
    await this.write((current) => removeSyncedWork(current, work.remoteUrl));
    this.changed.fire();
  }

  /**
   * 今の中身へ変更を当てて書く。
   *
   * **読めない中身は上書きしない**（実装ルール2）。ログに残して何もしない。
   * 変わらなければ書かない（同期の往復を増やさない）。`patch` の中でも読み直して
   * 確かめる——書き直しのあいだに同期で壊れた中身が届くこともある
   */
  private async write(change: (current: readonly SyncedWork[]) => SyncedWork[]): Promise<void> {
    const before = this.options.state.get<unknown>(SYNCED_WORKS_KEY);
    const read = readSyncedWorkList(before);
    if (!read.ok) {
      this.reportUnreadable(read.reason);
      return;
    }
    const next = change(read.works);
    if (before === undefined ? next.length === 0 : sameJson(toStoredList(next), before)) return;
    await this.options.state.patch<unknown>(SYNCED_WORKS_KEY, undefined, (current) => {
      const again = readSyncedWorkList(current);
      if (!again.ok) return current;
      return toStoredList(change(again.works));
    });
  }

  private reportUnreadable(reason: string): void {
    if (this.options.onUnreadable) {
      this.options.onUnreadable(reason);
      return;
    }
    logFailure("作品の一覧（設定の同期）を読めませんでした。書き戻さずに止めています", {
      鍵: SYNCED_WORKS_KEY,
      理由: reason,
    });
  }

  /** 各作品の origin を読む。git が無い・リモートが無い作品は飛ばす */
  private async readLocalRemotes(): Promise<LocalWorkRemote[]> {
    const readOrigin = this.options.readOrigin ?? readOriginWithGit;
    const works = this.options
      .works()
      // 編集者として参加した作品は作者の作品ではない（作者の一覧へ混ぜない）
      .filter((work) => !work.joinedAsEditor);
    const results = await Promise.all(
      works.map(async (work) => {
        const url = await readOrigin(work.folderPath).catch(() => undefined);
        return url ? { title: work.title, remoteUrl: url } : undefined;
      })
    );
    return results.filter((item): item is LocalWorkRemote => item !== undefined);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.changed.dispose();
  }
}

/** git で origin の URL を読む（手元の VS Code だけ。動的 import の理由は冒頭） */
async function readOriginWithGit(folderPath: string): Promise<string | undefined> {
  const { runGit } = await import("../core/git.js");
  const result = await runGit(["remote", "get-url", "origin"], folderPath, ORIGIN_TIMEOUT_MS);
  if (result.code !== 0) return undefined;
  const url = result.stdout.trim();
  return url.length > 0 ? url : undefined;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 手元の VS Code での起動の配線（`extension.ts` から、`canRunProcesses()` のときだけ呼ぶ）。
 *
 * 同期の鍵を渡し、起動のあと少し待ってから読み、作品の登録・名前の変更・解除のたびに
 * まとめて読み直す。
 */
export function activateSyncedWorkList(
  /** 素の `context.globalState.setKeysForSync`（`VerifiedState` の包みには口が無い） */
  setKeysForSync: (keys: readonly string[]) => void,
  list: SyncedWorkList,
  registryChanged: vscode.Event<void>
): vscode.Disposable {
  setKeysForSync(GLOBAL_STATE_SYNC_KEYS);
  list.scheduleRefresh(STARTUP_REFRESH_DELAY_MS);
  return registryChanged(() => list.scheduleRefresh(CHANGE_REFRESH_DELAY_MS));
}
