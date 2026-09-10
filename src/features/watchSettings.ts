import * as vscode from "vscode";
import { fromUri } from "../core/paths";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import {
  SelfWriteTracker,
  isWatchedSettingsFile,
  kindOfSettingsFile,
} from "../core/externalChanges";
import { logStep } from "../core/logger";

/**
 * 設定資料が外部で書き換えられたことに気づく。
 *
 * 作者は別のプラグインのAI（Copilot・Claude Code など）に更新を頼むことがある。
 * それらは `設定/` のJSONを直接書くので、これまで拡張機能は気づかなかった。
 * パネルは古い内容のまま、本文のハイライトも増えないままになる。
 *
 * **書き換え自体は止められない。** ファイルが正本であり、
 * 書き戻すのは「作者の書いたデータを上書きしない」という約束に反する。
 * できるのは、気づいて作者へ知らせ、確認の場へ案内することである。
 *
 * 通知は**まとめて1回**にする。AIは何十件も続けて書くので、
 * 1件ごとに出すと通知で画面が埋まる。
 */

/** 書き込みが落ち着くまで待つ時間。AIは連続して何件も書く */
const SETTLE_MS = 1500;

/**
 * 見張りを再開したあと、まだ捨て続ける時間（設計書5.5.18）。
 *
 * **ファイル監視の知らせは、書き込みより遅れて届く。** 取り込みが終わった
 * 直後に再開すると、gitが書いたぶんの知らせがそのあと届いて「外部で
 * 変更されました」になる。`SETTLE_MS` に余裕を足した長さだけ捨てる。
 */
const IGNORE_AFTER_RESUME_MS = 3000;

/** 作品を問わず止めるときの鍵 */
const ALL_WORKS = "*";

export class SettingsWatcher implements vscode.Disposable {
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly changed = new Set<string>();
  private settleTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly registry: WorkRegistry,
    /** 拡張機能自身の書き込みを除くための記録 */
    readonly selfWrites: SelfWriteTracker,
    /** 外部の変更を見つけたときに呼ぶ */
    private readonly onExternalChange: (
      work: WorkEntry,
      files: string[]
    ) => void
  ) {
    this.disposables.push(
      registry.onDidChange(() => void this.sync())
    );
    void this.sync();
  }

  /** 登録されている作品ぶんの監視を張り直す */
  private async sync(): Promise<void> {
    const works = this.registry.list();
    const wanted = new Set(works.map((work) => work.id));

    for (const [id, watcher] of this.watchers) {
      if (wanted.has(id)) continue;
      watcher.dispose();
      this.watchers.delete(id);
    }

    for (const work of works) {
      if (this.watchers.has(work.id)) continue;
      const watcher = await this.createWatcher(work);
      if (watcher) this.watchers.set(work.id, watcher);
    }
  }

  private async createWatcher(
    work: WorkEntry
  ): Promise<vscode.FileSystemWatcher | undefined> {
    let settingsDir: string;
    try {
      const config = await readWorkConfig(work);
      settingsDir = workPaths(work, config).settings;
    } catch {
      // 設定を読めない作品は監視しない。抽出のときに改めて知らせる
      return undefined;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(settingsDir, "**/*.json")
    );
    const handle = (uri: vscode.Uri) => this.record(work, fromUri(uri));
    watcher.onDidChange(handle);
    watcher.onDidCreate(handle);
    // 削除は扱わない。消えたファイルの中身は比べようがなく、
    // 復元するとAIの意図した削除を巻き戻すことになる
    return watcher;
  }

  /**
   * 見張りを止める（設計書5.5.18）。返ってきた関数を呼ぶと再開する。
   *
   * 作者の指摘（2026-09-10）：「同期時、設定資料の変更で再読み込みを
   * ポップアップさせていませんか？」。
   *
   * **gitが書いたファイルは、拡張機能自身の書き込みとして除けない**
   * （`SelfWriteTracker` は書き込み口を通ったものしか知らない）。
   * 取り込んでいる間だけ黙らせるのが、いちばん確かである。
   *
   * **止めている間に来た変更は捨てる。** 溜めて後から出しても、
   * 作者にとっては同じ「同期のあとに出てくる問い」になる。
   *
   * @param work 省略すると全作品を止める（置き場ぜんぶを取り込むとき）
   */
  pause(work?: WorkEntry): () => void {
    const key = work?.id ?? ALL_WORKS;
    this.pauseDepth.set(key, (this.pauseDepth.get(key) ?? 0) + 1);

    let released = false;
    return () => {
      // 二度呼ばれても、止めた回数を余計に減らさない
      if (released) return;
      released = true;
      const left = (this.pauseDepth.get(key) ?? 1) - 1;
      if (left > 0) {
        this.pauseDepth.set(key, left);
        return;
      }
      this.pauseDepth.delete(key);
      this.ignoreUntil.set(key, Date.now() + IGNORE_AFTER_RESUME_MS);
    };
  }

  /** 止めている回数（入れ子で呼ばれうる） */
  private readonly pauseDepth = new Map<string, number>();
  /** 再開したあと、まだ捨て続ける期限 */
  private readonly ignoreUntil = new Map<string, number>();

  /** いま黙っているか */
  private isMuted(work: WorkEntry): boolean {
    for (const key of [work.id, ALL_WORKS]) {
      if ((this.pauseDepth.get(key) ?? 0) > 0) return true;
      const until = this.ignoreUntil.get(key);
      if (until !== undefined) {
        if (Date.now() < until) return true;
        this.ignoreUntil.delete(key);
      }
    }
    return false;
  }

  private record(work: WorkEntry, filePath: string): void {
    if (!isWatchedSettingsFile(filePath)) return;
    if (!kindOfSettingsFile(filePath)) return;
    // 拡張機能自身の保存で鳴っただけなら何もしない
    if (this.selfWrites.isSelfWrite(filePath)) return;
    // 同期の取り込みの最中は、gitの書き込みなので知らせない（設計書5.5.18）
    if (this.isMuted(work)) return;

    this.changed.add(filePath);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.flush(work), SETTLE_MS);
  }

  private flush(work: WorkEntry): void {
    const files = [...this.changed];
    this.changed.clear();
    this.selfWrites.prune();
    if (files.length === 0) return;
    // 止める前に予約された分が、止めている最中に鳴ることがある
    if (this.isMuted(work)) return;

    logStep(
      `設定資料が外部で変更された: ${work.title} / ${files.length}件 ` +
        `（${files.map((file) => path.basename(file)).join("、")}）`
    );
    this.onExternalChange(work, files);
  }

  dispose(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    for (const watcher of this.watchers.values()) watcher.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** 外部変更の知らせに添える操作 */
export interface ExternalChangeActions {
  review: () => Promise<void>;
  reload: () => void;
  /**
   * この変更を「人が確定させたもの」として守る。
   *
   * **編集部はGitHub経由で直すので、拡張機能の画面を通らない。**
   * 印を付けないと、次の抽出でAIが上書きしてしまう（設計書5.5）。
   */
  protect: () => Promise<void>;
}

interface PendingNotice {
  work: WorkEntry;
  files: string[];
  actions: ExternalChangeActions;
}

/**
 * 待っている知らせ。
 *
 * **1件ずつ順に出す**（設計書5.5.18）。同時に複数の作品で変更が起きると、
 * VS Code は通知を積み上げる。読まずに閉じる癖がつくうえ、
 * **返事を待っている問いが下へ押し出される**（`views/notify.ts` と同じ問題）。
 */
const queue: PendingNotice[] = [];
let showing = false;

/**
 * 外部の変更を作者へ知らせる。
 *
 * **勝手に取り込まない。** 何が変わったのかを見てから決められるよう、
 * 差分の確認へ案内する。
 */
export async function notifyExternalChange(
  work: WorkEntry,
  files: string[],
  actions: ExternalChangeActions
): Promise<void> {
  queue.push({ work, files, actions });
  if (showing) return;

  showing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const dismissAll = await showOneNotice(next, queue.length > 0);
      if (!dismissAll) continue;
      // **「すべてあとで」は、待ち行列ごと片づける**（作者の指示、2026-09-10）。
      // ただし読み直しだけは各作品ぶん行う——画面が古いままだと、
      // 作者は「あとで」を押しただけで見えているものが嘘になる
      for (const rest of queue.splice(0)) rest.actions.reload();
      next.actions.reload();
    }
  } finally {
    showing = false;
  }
}

/** 待っている知らせを捨てる（試験の後片づけ用） */
export function clearExternalChangeQueue(): void {
  queue.length = 0;
  showing = false;
}

/** 知らせの文面。**画面から切り離して試験できるようにする** */
export function describeExternalChange(
  work: WorkEntry,
  files: readonly string[]
): string {
  const names = files
    .slice(0, 3)
    .map((file) => path.basename(file))
    .join("、");
  const rest = files.length > 3 ? ` ほか${files.length - 3}件` : "";
  return (
    `「${work.title}」の設定資料が拡張機能の外で変更されました（${names}${rest}）。` +
    "内容を確認しますか？（「この変更を守る」を押すと、今後AIで上書きしません）"
  );
}

/**
 * 知らせに並べるボタン。
 *
 * **待っているものがあるときだけ「すべてあとで」を足す。**
 * 1件しか無いときに出しても意味が違って読める。
 */
export function externalChangeButtons(hasMore: boolean): string[] {
  const buttons = ["変更を確認", "この変更を守る", "読み込み直すだけ", "閉じる"];
  return hasMore ? [...buttons, "すべてあとで"] : buttons;
}

/** 1件ぶん出す。**「すべてあとで」が押されたら true** */
async function showOneNotice(
  notice: PendingNotice,
  hasMore: boolean
): Promise<boolean> {
  const answer = await vscode.window.showInformationMessage(
    describeExternalChange(notice.work, notice.files),
    ...externalChangeButtons(hasMore)
  );

  if (answer === "変更を確認") {
    await notice.actions.review();
    return false;
  }
  if (answer === "この変更を守る") {
    await notice.actions.protect();
    return false;
  }
  if (answer === "読み込み直すだけ") {
    notice.actions.reload();
    return false;
  }
  return answer === "すべてあとで";
}
