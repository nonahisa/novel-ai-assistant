import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "../core/workRegistry";
import { logStep, useLogFile } from "../core/logger";
import {
  SPOTLIGHT_REQUEST_DIRECTORY,
  SPOTLIGHT_REQUEST_FILE,
  latestSpotlightRequest,
  parseSpotlightRequestLog,
  type SpotlightRequestEntry,
} from "../core/spotlightRequest";
import { findMenuCommandByLabel } from "../core/menuMentions";
import { findAction, menuEntries } from "../views/actionList";
import type { ActionSpotlight } from "./actionSpotlight";

/**
 * 外部AIからの「この項目を光らせて」を拾って、画面を光らせる
 * （設計書6.104。0.75.6）。
 *
 * **作者の指示（2026-09-22）**：「内部と外部のAIからメニュー操作して
 * 2回点滅を出せるようにしてください」。
 *
 * ## `ExternalAccessWatcher` と同じ形にしてある
 *
 * MCPサーバーは別プロセスで、拡張機能へ直接は届かない（6.87.8）。
 * サーバーが `.aiwriter/history/spotlight.jsonl` へ1行書き、こちらが
 * `FileSystemWatcher` で見張る。**起動したときにも一度読む**ので、
 * VS Code を閉じていた間の依頼も、次に開いたときに光る。
 *
 * ## 命令は実行しない
 *
 * **光らせるだけ**である（作者が承認した例外の範囲）。`spotlight.show` は
 * ツリーの項目を選んで瞬かせるだけで、コマンドは1つも起こさない。
 * 押すかどうかは作者が決める。
 *
 * ## 溜まっていても1件だけ
 *
 * 光るのは画面の1か所なので、5件まとめて捌いても最後の1つしか見えない。
 * **いちばん新しい依頼を1つだけ**指して、どこまで捌いたかを
 * `globalState` に覚える（この機械の画面の話なので、作品と一緒に運ばない）。
 */

/** どこまで捌いたかの覚え。作品の場所ごとに、最後に光らせた時刻を持つ */
const HANDLED_KEY = "novelai.spotlight.lastHandledAt";

/** ステータスバーの一言が消えるまで */
const STATUS_MS = 5_000;

export class SpotlightRequestWatcher {
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  /** いま光らせている最中か。**重ねて呼ばない**（瞬きが混ざる） */
  private busy = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly works: () => readonly WorkEntry[],
    private readonly spotlight: ActionSpotlight
  ) {}

  /** 見張りを始める。**作品が増減したら呼び直す**（`refresh`） */
  refresh(): void {
    this.dispose();
    for (const work of this.works()) {
      const pattern = new vscode.RelativePattern(
        path.toUri(
          path.join(workPaths(work).aiwriter, SPOTLIGHT_REQUEST_DIRECTORY)
        ),
        SPOTLIGHT_REQUEST_FILE
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const check = (): void => void this.check(work);
      watcher.onDidCreate(check);
      watcher.onDidChange(check);
      this.watchers.push(watcher);
      // **起動したときに一度読む。** 閉じている間の依頼を取りこぼさない
      void this.check(work);
    }
  }

  dispose(): void {
    for (const watcher of this.watchers.splice(0)) watcher.dispose();
  }

  /** 1作品ぶんを見る。**テストから直に呼べるように公開してある** */
  async check(work: WorkEntry): Promise<void> {
    if (this.busy) return;
    const entries = parseSpotlightRequestLog(await this.readLog(work));
    const wanted = latestSpotlightRequest(entries, this.handledAt(work));
    if (!wanted) return;

    this.busy = true;
    /*
      **記録は、その作品のログファイルへ向けてから書く**（`logFileRouting`）。
      出力チャンネルにしか出ないと、VS Code を閉じた時点で消える——
      「外部AIが知らない項目を指してきた」は、あとから追う手がかりになる。
    */
    useLogFile(work.folderPath);
    try {
      /*
        **見たことは、光らせられてもられなくても覚える。** 覚えないと、
        ファイルが変わるたびに同じ依頼で光り続ける（知らない項目を
        指してきたときに、際限なくログが並ぶ）。
      */
      await this.remember(work, wanted.at);
      const command = this.resolve(wanted);
      if (!command) return;

      const result = await this.spotlight.show(command);
      if (!result.shown) {
        logStep(
          `外部AIの指し先を光らせられませんでした（${command}。どちらのメニューにも無い）`
        );
        return;
      }
      const item = findAction(command);
      const who = wanted.client || "名乗りなし";
      void vscode.window.setStatusBarMessage(
        `$(chevron-right) 外部AI（${who}）が「${item?.label ?? command}」を指しました`,
        STATUS_MS
      );
    } finally {
      this.busy = false;
    }
  }

  /**
   * 依頼をコマンドIDへ解く。
   *
   * **知らない指し先は静かに飛ばす**（ログには残す）。外部AIが古い名前や
   * 思いつきの名前を寄こすことはあり、そのたびに作者へ知らせると、
   * **作者にはどうしようもない知らせ**が画面に並ぶ。
   */
  private resolve(entry: SpotlightRequestEntry): string | undefined {
    if (entry.command) {
      if (findAction(entry.command)) return entry.command;
      logStep(`外部AIが知らない操作を指しました（${entry.command}）`);
      return undefined;
    }
    /*
      **ラベルはここで解く。** 対応表（`ACTION_TREE`）を持っているのは
      この側だけで、MCP の束からは読めない（`vscode` を引き込むため）。
      写しを作らずに済ませる代わりに、解けなかったことをログへ残す。
    */
    const found = findMenuCommandByLabel(entry.label, menuEntries());
    if (!found) {
      logStep(`外部AIが指した項目が見つかりません（${entry.label}）`);
    }
    return found;
  }

  private async readLog(work: WorkEntry): Promise<string> {
    const target = path.join(
      workPaths(work).aiwriter,
      SPOTLIGHT_REQUEST_DIRECTORY,
      SPOTLIGHT_REQUEST_FILE
    );
    try {
      const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
      return new TextDecoder().decode(bytes);
    } catch {
      // 依頼がまだ無い（＝一度も指されていない）
      return "";
    }
  }

  private handledAt(work: WorkEntry): string {
    const handled =
      this.context.globalState.get<Record<string, string>>(HANDLED_KEY);
    return handled?.[work.folderPath] ?? "";
  }

  private async remember(work: WorkEntry, at: string): Promise<void> {
    const handled =
      this.context.globalState.get<Record<string, string>>(HANDLED_KEY) ?? {};
    await this.context.globalState.update(HANDLED_KEY, {
      ...handled,
      [work.folderPath]: at,
    });
  }
}
