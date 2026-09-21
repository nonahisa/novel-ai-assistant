/**
 * 作品フォルダーの整備を**いつ起こすか**を決める（設計書6.107）。
 *
 * 0.74.9 で、整備は「作品一覧の初回描画」の合図を受けてから起こすように
 * した。一覧の走査と整備が同じスレッドで取り合い、整備の `await` が
 * バラバラの位置で何秒も再開できずにいたためである。
 *
 * **ところが、合図が来ないことがある。** VS Code が作品一覧の
 * `getChildren` を呼ぶのは**ビューが見えたとき**なので、作者がサイドバーを
 * 一度も開かない起動では合図が来ない。そのセッションでは
 * `.gitignore` の移行も「作品フォルダーが見つかりません」の知らせも
 * 出ないことになる。**整備が永久に走らないのは、順番の問題ではなく
 * 抜け落ちである。**
 *
 * そこで**上限を置く**。合図を待つが、来なければ自分で起こす。
 *
 * **`vscode` に依存させない**（`views`/`features` → `core` → `models` の向き）。
 * `activate` は単体で動かせないので、「一度だけ」と「上限で起こす」の
 * 判断だけをここへ出し、試験で守れるようにする。
 */

/**
 * 合図を待つ上限（ミリ秒）。
 *
 * **60秒。** 作者のノートPC（16作品・573ファイル）で一覧が出るまで
 * 25.1秒だったので、遅い機械でもふつうは合図のほうが先に来る。
 * ここで起きるのは「サイドバーを開かないまま1分たった」ときである。
 */
export const MAINTENANCE_SIGNAL_WAIT_MS = 60_000;

/**
 * 上限で起こしたときに、印（「整備 開始」）へ添える注記。
 *
 * **印そのものは変えない。** 合図で起きたのか待ちきって起きたのかは、
 * あとから数字を読むときに要る（合図で起きたなら一覧は出ている）。
 */
export const MAINTENANCE_TIMEOUT_NOTE = "合図待ちの上限で起こした";

export interface MaintenanceTrigger {
  /**
   * 合図を待ち始める。**作品が1件以上あるときだけ呼ぶ。**
   *
   * 0件なら一覧の走査も描画も起きないので、待つ意味がない
   * （呼び手がその場で `signal()` する）。
   */
  arm(): void;
  /** 合図が来た（作品一覧の初回描画）。まだなら起こす */
  signal(): void;
  /** 見張りを片付ける（拡張機能が終わるとき） */
  dispose(): void;
  /** もう起こしたか */
  readonly started: boolean;
}

/**
 * @param start 起こす中身。引数は印へ添える注記（合図で起きたなら
 *   `undefined`）。**1回しか呼ばれない**
 * @param waitMs 合図を待つ上限。試験から短くするために引数にする
 */
export function createMaintenanceTrigger(
  start: (note?: string) => void,
  waitMs: number = MAINTENANCE_SIGNAL_WAIT_MS
): MaintenanceTrigger {
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  /**
   * 一度だけ起こす。
   *
   * **合図と上限は、どちらが先に来るか分からない。** 合図が来たあとに
   * タイマーが鳴っても、待ちきったあとに合図が来ても、整備が2回
   * 走ってはいけない（`.gitignore` の書き込みと知らせが二重になる）。
   */
  const run = (note?: string): void => {
    if (started) return;
    started = true;
    clear();
    start(note);
  };

  return {
    get started(): boolean {
      return started;
    },
    arm(): void {
      // 既に起きていれば待つ意味がない。二重に仕掛けもしない
      if (started || timer !== undefined) return;
      timer = setTimeout(() => run(MAINTENANCE_TIMEOUT_NOTE), waitMs);
    },
    signal(): void {
      run();
    },
    dispose(): void {
      clear();
    },
  };
}
