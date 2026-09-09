import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";

/**
 * 作品フォルダーの本文（.txt/.md）を見張り、外で変わったら作品一覧を
 * 数え直す（実機確認 2026-09-07、A-10 の観測）。
 *
 * 作品一覧の字数は、VS Code で保存したとき（`onDidSaveTextDocument`）にしか
 * 数え直していなかった。**外から書き換えたぶん**（ルビの適用・別のエディタ・
 * Git の復元・同期）は、開き直すまで古いままだった——原稿エディタは
 * 0.40.2 で追いつくようになったのに、一覧だけ取り残されていた。
 *
 * 監視は**作品フォルダーごとに1本**。登録簿が変わるたびに `sync` で
 * 増減させる。知らせは 500ms まとめてから数え直す（同期で何十話も一度に
 * 変わることがある）。`.aiwriter` と退避フォルダーの中は本文ではないので飛ばす。
 */
export class WorkFolderWatchers implements vscode.Disposable {
  private readonly watchers = new Map<
    string,
    { watcher: vscode.FileSystemWatcher; timer?: ReturnType<typeof setTimeout> }
  >();

  constructor(private readonly onChanged: (work: WorkEntry) => void) {}

  /** 登録されている作品に合わせて、監視を増減させる */
  sync(works: readonly WorkEntry[]): void {
    const wanted = new Map(
      works.map((work) => [path.normalizeForComparison(work.folderPath), work])
    );
    for (const [key, entry] of this.watchers) {
      if (!wanted.has(key)) {
        entry.watcher.dispose();
        if (entry.timer) clearTimeout(entry.timer);
        this.watchers.delete(key);
      }
    }
    for (const [key, work] of wanted) {
      if (this.watchers.has(key)) continue;
      let watcher: vscode.FileSystemWatcher;
      try {
        watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(path.toUri(work.folderPath), "**/*.{txt,md}")
        );
      } catch {
        // 監視を張れない環境（古い VS Code・試験の代役）では、これまでどおり
        // 保存のときだけ数え直す
        continue;
      }
      const entry: { watcher: vscode.FileSystemWatcher; timer?: ReturnType<typeof setTimeout> } = { watcher };
      const schedule = (uri: vscode.Uri) => {
        if (!isManuscriptPath(fromUri(uri))) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          this.onChanged(work);
        }, 500);
      };
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      this.watchers.set(key, entry);
    }
  }

  dispose(): void {
    for (const entry of this.watchers.values()) {
      entry.watcher.dispose();
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.watchers.clear();
  }
}

/** 本文の場所か（拡張機能の作業フォルダーと退避の中は数えない） */
export function isManuscriptPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return !/\/(\.aiwriter|\.novelai-recovery|\.git)\//.test(normalized);
}
