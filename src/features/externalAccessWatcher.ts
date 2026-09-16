import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "../core/workRegistry";
import {
  EXTERNAL_ACCESS_DIRECTORY,
  EXTERNAL_ACCESS_FILE,
  parseExternalAccessLog,
  pendingExternalAccessKnocks,
  type ExternalAccessKnock,
  type ExternalAccessEntry,
} from "../core/externalAccessLog";
import { askAboutKnock } from "./externalAccessPermission";

/**
 * 外部AIのノックを見つけて、その場で作者に尋ねる（設計書6.87.14）。
 *
 * **作者の指示（2026-09-16）**：「MCP承認を検知した場合は、拡張機能の
 * 画面上にポップアップさせてください」。
 *
 * ## なぜ見張る形なのか
 *
 * **MCPサーバーは別プロセスで、VS Code が起動していなくても動く**（6.87.8）。
 * だからサーバーの側から画面を出すことはできない。サーバーは断って記録へ
 * 1行書き、**拡張機能がその記録を見張って知らせる。**
 *
 * **閉じている間のノックも取りこぼさない。** 起動したときに一度読むので、
 * VS Code を開いていなかった間に来たものも、次に開いたときに出る。
 *
 * ## 知らせるのは「断った回」だけ
 *
 * 許可済みの呼び出しまでポップアップにすると、作者は**画面を閉じることを
 * 覚えてしまう**——そして本当に知らせたい回まで閉じられる。許可済みの
 * 記録は編集履歴の画面で見られるので、そちらに任せる。
 *
 * ## 同じノックで何度も呼ばない
 *
 * 外部AIは同じ道具を続けて呼ぶ（チャンクごとに1回）。全部に出すと
 * **数十回のポップアップ**になるので、**接続元と道具の組ごとに1回**へ畳む。
 * どこまで知らせたかは `globalState`（VS Code の持ち物。同期しない）に持つ
 * ——**この機械で知らせたかどうか**の話なので、作品と一緒に持ち運ばない。
 */

/** どこまで知らせたかの覚え。作品の場所ごとに、最後に見た時刻を持つ */
const SEEN_KEY = "novelai.externalAccess.lastKnockAt";

export class ExternalAccessWatcher {
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  /** いま尋ねている最中か。**重ねて出さない**（モーダルが積み上がる） */
  private asking = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly works: () => readonly WorkEntry[],
    private readonly onChanged: () => void
  ) {}

  /**
   * 見張りを始める。
   *
   * **作品が増減したら呼び直す**（`refresh`）。台帳に無い作品の記録は
   * 見に行かない——どの作品か分からないものは、作者にも知らせようがない。
   */
  refresh(): void {
    this.dispose();
    for (const work of this.works()) {
      const pattern = new vscode.RelativePattern(
        path.toUri(
          path.join(workPaths(work).aiwriter, EXTERNAL_ACCESS_DIRECTORY)
        ),
        EXTERNAL_ACCESS_FILE
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const check = (): void => void this.check(work);
      watcher.onDidCreate(check);
      watcher.onDidChange(check);
      this.watchers.push(watcher);
      // **起動したときに一度読む。** 閉じている間のノックを取りこぼさない
      void this.check(work);
    }
  }

  dispose(): void {
    for (const watcher of this.watchers.splice(0)) watcher.dispose();
  }

  private async check(work: WorkEntry): Promise<void> {
    if (this.asking) return;
    const knocks = await this.unseenKnocks(work);
    if (knocks.length === 0) return;

    this.asking = true;
    try {
      /*
        **いちばん新しいものを1件出す。** 続けて呼ばれたぶんは、
        接続元と道具が同じなら同じ判断になるので、まとめて1回尋ねる。
      */
      const latest = knocks[0];
      const others = knocks.length - 1;
      const decided = await askAboutKnock(work, latest);
      if (others > 0) {
        void vscode.window.setStatusBarMessage(
          `$(shield) ほかに ${others} 件のノックがありました（編集履歴で見られます）`,
          8_000
        );
      }
      // **決めても決めなくても、見たことは覚える。** 覚えないと、
      // ファイルが変わるたびに同じノックで尋ね続けることになる
      await this.remember(work, knocks[0].at);
      if (decided) this.onChanged();
    } finally {
      this.asking = false;
    }
  }

  /** まだ知らせていないノックを、新しい順に返す（絞り方は core に置いた） */
  private async unseenKnocks(work: WorkEntry): Promise<ExternalAccessKnock[]> {
    return pendingExternalAccessKnocks(
      await this.readLog(work),
      this.seenAt(work)
    );
  }

  private async readLog(work: WorkEntry): Promise<ExternalAccessEntry[]> {
    const target = path.join(
      workPaths(work).aiwriter,
      EXTERNAL_ACCESS_DIRECTORY,
      EXTERNAL_ACCESS_FILE
    );
    try {
      const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
      return parseExternalAccessLog(new TextDecoder().decode(bytes));
    } catch {
      // 記録がまだ無い（＝ノックされていない）
      return [];
    }
  }

  private seenAt(work: WorkEntry): string {
    const seen = this.context.globalState.get<Record<string, string>>(SEEN_KEY);
    return seen?.[work.folderPath] ?? "";
  }

  private async remember(work: WorkEntry, at: string): Promise<void> {
    const seen =
      this.context.globalState.get<Record<string, string>>(SEEN_KEY) ?? {};
    await this.context.globalState.update(SEEN_KEY, { ...seen, [work.folderPath]: at });
  }
}
