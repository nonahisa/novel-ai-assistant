import * as vscode from "vscode";
import { cancelItem, isCancelItem } from "./dialogs";
import {
  describeDuration,
  describeRunTimeEstimate,
  estimateRemainingMs,
  estimateRunMs,
} from "../core/etaEstimate";
import { modelTuning } from "../core/modelTuning";
import {
  MIN_FEATURE_OUTPUT_SAMPLES,
  featureOutputTuning,
} from "../core/featureOutputTokens";

/**
 * 進捗表示。
 *
 * VSCodeは通知（ProgressLocation.Notification）に出した進捗へ、
 * 必ず「ソース: 小説AI執筆補助」という行を添える。
 * 拡張機能側から消す手段は用意されていないため、通知ではなく
 * ステータスバー（ProgressLocation.Window）に出す。
 *
 * ただしステータスバーの進捗には中止ボタンが付かない。
 * 長時間かかる処理では中止できないと困るので、
 * withCancellableProgress では中止ボタンを自前で並べる。
 */

/** 実行中の処理を中止するコマンド。ステータスバーのボタンから呼ぶ */
export const CANCEL_TASK_COMMAND = "novelai.cancelRunningTask";

/** いま中止できる処理の1件 */
interface CancellableTask {
  /** 作者へ見せる題（`withCancellableProgress` に渡ったもの） */
  readonly title: string;
  readonly source: vscode.CancellationTokenSource;
}

/**
 * いま中止できる処理。**始めた順に並ぶ。**
 *
 * 以前は1本しか覚えておらず、後から始めたものが前のものを押しのけていた
 * （「入れ子は内側が優先」）。キュー（設計書6.76）を入れてから、一括処理は
 * **順番待ちのまま進捗を出す**ようになったので、この形では
 * 「動いているほうを止めたい」と思って押した中止が、**待っているだけの
 * ほうに当たる。** 2度押せば届くが、どちらが止まるかは画面のどこにも
 * 出ていない——作者には「押したのに止まらない」としか見えない。
 */
const activeTasks: CancellableTask[] = [];

/** QuickPickの1行。選ばれたら、その処理を止める */
interface CancelPick extends vscode.QuickPickItem {
  readonly task: CancellableTask;
}

/**
 * 中止ボタンから呼ばれる本体。**2件以上あるときだけ選ばせる。**
 *
 * 1件のときに問いを挟むと、ほとんどの場面でただの手間になる。
 * 選ばずに閉じたら（Esc）何も止めない——選ばなかったのだから、
 * こちらで勝手に決めると「押していないのに消えた」ことになる。
 */
export async function cancelRunningTask(): Promise<void> {
  if (activeTasks.length === 0) return;
  if (activeTasks.length === 1) {
    activeTasks[0].source.cancel();
    return;
  }

  const picks: CancelPick[] = activeTasks.map((task, index) => ({
    label: task.title,
    // **同じ題が並ぶことがある**（同じ機能を2つ動かした場合）ので、
    // 始めた順を添えて見分けられるようにする
    description: `${index + 1}番目に始めました`,
    task,
  }));

  const picked = await vscode.window.showQuickPick(
    // 出口を目に見える形で置く（設計書6.17.2）。ここでは「どれも止めない」
    [...picks, cancelItem("どれも中止しない")],
    {
      placeHolder: "どの処理を中止しますか？",
      // 選んでいる途中で別の窓へ目を移しても閉じない。そのぶん出口を置く
      ignoreFocusOut: true,
    }
  );
  // 選ばなかった（Esc）・取りやめたときは、**何も止めない。**
  // こちらで既定を決めて片方を止めると「押していないのに消えた」ことになる
  if (!picked || isCancelItem(picked)) return;
  if ("task" in picked) picked.task.source.cancel();
}

/** activate から一度だけ呼び、戻り値を subscriptions に入れる */
export function registerProgressCancelCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    CANCEL_TASK_COMMAND,
    () => void cancelRunningTask()
  );
}

type ProgressReporter = vscode.Progress<{
  message?: string;
  increment?: number;
}>;

/**
 * 進み具合を、ステータスバーの外へも伝える口（作者の報告、2026-08-29）。
 *
 * 「下に動いているときのチャンク数がでないですね」——検知の結果は下段の
 * 提案パネルへ出るのに、進み具合はステータスバーにしか出ていなかった。
 * **作者が見ているのは、結果が出る場所である。**
 *
 * 検知の各機能はこれを**省略可能**で受け取り、`progress.report` を出す
 * ところで一緒に呼ぶ。**ステータスバーの表示は今までどおり残す**——
 * 片方へ寄せると、パネルを閉じている人が進み具合を見られなくなる。
 *
 * @param done これまでに**AIへ送り終えた**数
 * @param total これから**AIへ送る**数。**キャッシュ済みは含めない**
 *   （作者の指摘、2026-09-06）。「7チャンク中1件を処理します」と断った
 *   直後に「1/7」と出て、実際に動くのは1件なので3分間ずっと数字が
 *   変わらず、**止まったように見えていた**
 * @param skipped 処理済みで飛ばした数。0のときは何も添えない
 * @param remaining 残り時間の見当（「およそ4時間30分」）。まだ言えない
 *   ときは空文字。**作れないときに当てずっぽうを入れない**（設計書6.8.19）
 */
export type CheckProgress = (
  done: number,
  total: number,
  skipped?: number,
  remaining?: string
) => void;

/**
 * 進み具合に添える、残り時間の見当（設計書6.8.19）。
 *
 * **この口を1つだけ置く。** 検知は7つあり、それぞれが自前で残り時間を
 * 数え始めると、丸め方も言い回しも7通りに散る（`core/termColors.ts` を
 * 1か所へ寄せたのと同じ理由）。
 */
export interface EtaStep {
  /**
   * 数字のうしろへ足す文字列。`チャンク（残りおよそ4時間30分）`。
   *
   * **単位だけは必ず付く。** 見当が言えないうちも「42/210チャンク」に
   * なるので、いまの表示より短くなることはない。
   */
  readonly suffix: string;
  /** 見当だけ（`およそ4時間30分`）。まだ言えないときは空文字 */
  readonly remaining: string;
}

/** 1回の実行ぶんの時計。**輪に入る直前に作る** */
export interface RunEta {
  step(done: number, total: number): EtaStep;
}

/**
 * 残り時間の見当を数え始める。
 *
 * 見ているのは**実時間**である。AI1回ぶんの所要時間（`GenerateResult`
 * の `elapsedMs`。記録は `ai/meteredProvider.ts` が取っている）を足し
 * 上げる手もあるが、作者が待っているのは順番待ち・本文の読み込み・
 * 検証まで含めた全部なので、**壁の時計のほうが実感に合う。**
 *
 * @param unit 数えているもの。話ごとに送る検知は「話」になる
 * @param now 時計。試験で止められるように差し替えられる
 */
export function startRunEta(
  unit = "チャンク",
  now: () => number = Date.now
): RunEta {
  const startedAt = now();
  return {
    step(done: number, total: number): EtaStep {
      const ms = estimateRemainingMs(done, total, now() - startedAt);
      if (ms === undefined) return { suffix: unit, remaining: "" };
      const remaining = describeDuration(ms);
      return { suffix: `${unit}（残り${remaining}）`, remaining };
    },
  };
}

/**
 * 押す前に「およそどれだけかかるか」を言う（設計書6.8.19）。
 *
 * **見当が付かないときは、正直にそう言う。** ここで既定値を置くと、
 * 一度も測っていないモデルにも数字が出て、当てずっぽうが実測の顔をして
 * 並ぶ。台帳（`core/modelTuning.ts` の `outputTokensPerSecond`）は作者
 * 自身の呼び出しからしか入らないので、無いということは本当に「この機械で
 * このモデルを動かしたことがない」である。
 *
 * **`speedMeasuredAt` はここでは見ない。** 古い測定でも、いまある唯一の
 * 実測である——粒度は「およそ5時間」なので、多少古くても判断は変わらない。
 * 黙って捨てると、代わりに出せるものが何も無くなる。
 */
export function estimateRunTimeText(params: {
  /** AIのプロバイダID（速さの台帳の鍵） */
  readonly providerId: string;
  /** モデル名（同上） */
  readonly model: string;
  /** 出力量の実測を引く機能名（`meta.feature` と同じもの） */
  readonly feature: string;
  /** これからAIへ送る件数 */
  readonly count: number;
  /** 数えているもの。話ごとに送る検知は「話」 */
  readonly unit?: string;
}): string {
  const unit = params.unit ?? "チャンク";
  const speed = modelTuning(params.providerId, params.model)
    ?.outputTokensPerSecond;
  const output = featureOutputTuning(params.feature);
  // **件数が足りない実測は使わない**（`core/featureOutputTokens.ts` の
  // しきい値と同じ線を引く）。1回ぶんでは、たまたま短かった回と区別が付かない
  const perCall =
    (output?.outputTokenSamples ?? 0) >= MIN_FEATURE_OUTPUT_SAMPLES
      ? output?.outputTokens
      : undefined;

  const ms = estimateRunMs(params.count, speed, perCall);
  // **出どころを渡す。** 同梱の値は「実測の最大」なので、この機械の実測と
  // 同じ顔をさせると、作者は多めの数字を真に受ける（2026-09-21 に実機で外した）
  return describeRunTimeEstimate({
    count: params.count,
    unit,
    ms,
    bundled: output?.bundled === true,
  });
}

/**
 * ステータスバーに進捗を出す。中止ボタンは付かない。
 * すぐ終わる処理（疎通確認・モデル取得など）に使う。
 */
export function withProgress<T>(
  title: string,
  task: (progress: ProgressReporter) => Thenable<T>
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title },
    (progress) => task(progress)
  );
}

/**
 * ステータスバーに進捗を出し、隣に中止ボタンを並べる。
 * AI呼び出しのように分単位でかかる処理に使う。
 */
export async function withCancellableProgress<T>(
  title: string,
  task: (
    progress: ProgressReporter,
    token: vscode.CancellationToken
  ) => Thenable<T>
): Promise<T> {
  const source = new vscode.CancellationTokenSource();
  const entry: CancellableTask = { title, source };
  activeTasks.push(entry);

  // 文字数表示（優先度100）より右端に置き、進捗のすぐ隣に見えるようにする
  const button = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1000
  );
  button.text = "$(stop-circle) 中止";
  button.tooltip = `${title}（クリックで中止）`;
  button.command = CANCEL_TASK_COMMAND;
  button.show();

  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title },
      (progress) => task(progress, source.token)
    );
  } finally {
    button.dispose();
    source.dispose();
    // **自分の分だけを抜く。** 終わる順は始めた順とは限らない
    // （順番待ちのほうが先に中止されることがある）ので、末尾を落とさない
    const at = activeTasks.indexOf(entry);
    if (at >= 0) activeTasks.splice(at, 1);
  }
}
