import * as vscode from "vscode";
import * as paths from "../core/paths";

/** 続けて変わったときに、まとめて1回にする待ち時間 */
const SETTLE_MS = 300;

/**
 * 単話プロットの置き場を見張り、**外で**作られた・変わった・消えたら知らせる
 * （2026-09-23、ノートPCの実機確認）。
 *
 * プロットモードの一覧は、VS Code での保存（`onDidSaveTextDocument`）でしか
 * 作り直していなかった。別のエディタ・同期・Git の復元で単話プロットが
 * 変わっても、パネルを開き直すまで古いままだった。作品一覧の字数で踏んだ
 * のと同じ形（`workFolderWatch.ts`）。
 *
 * - **置き場の1つ上から見る。** 単話プロットを1つも作っていない作品には
 *   置き場のフォルダーが無く、無いフォルダーを基点にすると、あとで作られても
 *   知らせが来ない
 * - 続けて変わったら**少し待って1回だけ**知らせる（同期で何話ぶんも一度に
 *   変わる。そのたびに作品を走査しない）
 * - 見張るのはパネルが開いているあいだだけ。閉じたら `dispose` で捨てる
 */
export class EpisodePlotFolderWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private watchedKey = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly onChanged: () => void) {}

  /**
   * その置き場を見張る。**同じ置き場なら張り直さない**（一覧を作り直す
   * たびに呼ばれるため）。置き場が変わったら古い見張りを捨てる。
   */
  watch(episodePlotsDir: string): void {
    // **捨てたあとは張らない。** パネルを閉じた時点で読み込みが走っていると、
    // その読み込みの終わりにここが呼ばれ、誰も捨てない見張りが残る
    if (this.disposed) return;
    const key = paths.normalizeForComparison(episodePlotsDir);
    if (key === this.watchedKey && this.watcher) return;
    this.stop();
    this.watchedKey = key;
    try {
      this.watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          paths.toUri(paths.dirname(episodePlotsDir)),
          `${paths.basename(episodePlotsDir)}/*.md`
        )
      );
    } catch {
      // 見張りを張れない環境（古い VS Code・試験の代役）では、
      // これまでどおり保存のときだけ作り直す
      this.watcher = undefined;
      return;
    }
    const schedule = (): void => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.onChanged();
      }, SETTLE_MS);
    };
    this.watcher.onDidCreate(schedule);
    this.watcher.onDidChange(schedule);
    this.watcher.onDidDelete(schedule);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.watchedKey = "";
  }

  private stop(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    // 捨てたあとに作り直しが走ると、閉じたパネルへ書きに行く
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
