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

  private record(work: WorkEntry, filePath: string): void {
    if (!isWatchedSettingsFile(filePath)) return;
    if (!kindOfSettingsFile(filePath)) return;
    // 拡張機能自身の保存で鳴っただけなら何もしない
    if (this.selfWrites.isSelfWrite(filePath)) return;

    this.changed.add(filePath);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.flush(work), SETTLE_MS);
  }

  private flush(work: WorkEntry): void {
    const files = [...this.changed];
    this.changed.clear();
    this.selfWrites.prune();
    if (files.length === 0) return;

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

/**
 * 外部の変更を作者へ知らせる。
 *
 * **勝手に取り込まない。** 何が変わったのかを見てから決められるよう、
 * 差分の確認へ案内する。
 */
export async function notifyExternalChange(
  work: WorkEntry,
  files: string[],
  actions: {
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
): Promise<void> {
  const names = files
    .slice(0, 3)
    .map((file) => path.basename(file))
    .join("、");
  const rest = files.length > 3 ? ` ほか${files.length - 3}件` : "";

  const answer = await vscode.window.showInformationMessage(
    `「${work.title}」の設定資料が拡張機能の外で変更されました（${names}${rest}）。` +
      "内容を確認しますか？（「この変更を守る」を押すと、今後AIで上書きしません）",
    "変更を確認",
    "この変更を守る",
    "読み込み直すだけ",
    "閉じる"
  );

  if (answer === "変更を確認") {
    await actions.review();
    return;
  }
  if (answer === "この変更を守る") {
    await actions.protect();
    return;
  }
  if (answer === "読み込み直すだけ") {
    actions.reload();
  }
}
