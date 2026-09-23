import * as vscode from "vscode";
import * as paths from "../core/paths";
import { isDirectChildWithExtension } from "../core/folderWatchMatch";
import { FolderWatchHub } from "./folderWatchHub";

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
 * - **見張りそのものは `FolderWatchHub` が持つ**（残課題 C2、0.84.4）。置き場の
 *   1つ上は作品フォルダーの中なので、作品フォルダーの見張り（本文・同期・
 *   設定資料が分け合う1本）があれば、新しく張らずにそこから受け取る。
 *   以前の glob「置き場の名前／*.md」と同じ条件（直下の .md）を `accepts` で見る
 */
export class EpisodePlotFolderWatcher implements vscode.Disposable {
  private subscription: vscode.Disposable | undefined;
  private watchedKey = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly hub: FolderWatchHub;
  private readonly ownsHub: boolean;

  /**
   * @param hub 作品フォルダーの見張りを分け合う先。製品ではプロットモードの
   *   パネルが共有の1つ（`sharedFolderWatchHub()`）を渡す。省くと自前の1つ（試験用）
   */
  constructor(
    private readonly onChanged: () => void,
    hub?: FolderWatchHub
  ) {
    this.ownsHub = !hub;
    this.hub = hub ?? new FolderWatchHub();
  }

  /**
   * その置き場を見張る。**同じ置き場なら張り直さない**（一覧を作り直す
   * たびに呼ばれるため）。置き場が変わったら古い見張りを捨てる。
   */
  watch(episodePlotsDir: string): void {
    // **捨てたあとは張らない。** パネルを閉じた時点で読み込みが走っていると、
    // その読み込みの終わりにここが呼ばれ、誰も捨てない見張りが残る
    if (this.disposed) return;
    const key = paths.normalizeForComparison(episodePlotsDir);
    if (key === this.watchedKey && this.subscription) return;
    this.stop();
    this.watchedKey = key;
    const schedule = (): void => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.onChanged();
      }, SETTLE_MS);
    };
    // 見張りを張れない環境（古い VS Code・試験の代役）では、ハブが何も
    // 配らない。これまでどおり保存のときだけ作り直す
    this.subscription = this.hub.subscribe({
      root: paths.dirname(episodePlotsDir),
      accepts: (filePath) =>
        isDirectChildWithExtension(episodePlotsDir, filePath, ["md"]),
      onEvent: schedule,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.watchedKey = "";
    if (this.ownsHub) this.hub.dispose();
  }

  private stop(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    // 捨てたあとに作り直しが走ると、閉じたパネルへ書きに行く
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
