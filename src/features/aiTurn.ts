import type * as vscode from "vscode";
import {
  AiQueueAbortError,
  acquireRun,
  currentRunLabel,
} from "../core/aiSequence";
import { withCancellableProgress } from "../views/progress";

/**
 * まとまった一括処理の「実行の札」を取る口（設計書6.76）。
 *
 * ## 何のために要るか
 *
 * `MeteredProvider` のリクエストの関所（同時1件）だけでは、誤字脱字と
 * 矛盾検知を同時に押したときに A1,B1,A2,B2… と**交互に流れる**。
 * Ollamaでは機能ごとに `num_ctx` もモデルも違うので、そのたびに
 * 読み込み直しが往復して、両方とも極端に遅くなる。
 * チャンクや話を繰り返す機能は、**開始から終了まで丸ごと**札を持つ。
 *
 * ## 札を取らないもの（あえて取らせない）
 *
 * 相談（`workChatPanel`）・相談からの反映（`chatSettingsSync`）・
 * 表記ゆれの1問（`notationAdvice`）・独り言（`chatterComment`）・
 * 再チェック（`recheckProposal`）・単発の生成（紹介文・キャッチコピー・
 * 章立て・名前・告知・プロット対話など、1〜数回で終わるもの）。
 *
 * **これらはリクエストの関所だけを通り、一括処理のチャンクの合間へ
 * 滑り込める。** 札を取らせると、誤字脱字を回している10分のあいだ
 * 相談が1言も返せなくなる——それは道具として使えない。滑り込みで増える
 * 読み込み直しは高々1回で、キューを入れる前と同じである。
 *
 * ## デッドロックの禁止則
 *
 * **札を持ったまま関所を待つ（この向きだけ）。** 逆向きは作らない。
 * ここが唯一の札の入口なので、この決まりはここを読めば分かる。
 */

/** 進捗の報告先。`views/progress` が渡してくる形と同じ */
type ProgressReporter = vscode.Progress<{
  message?: string;
  increment?: number;
}>;

export interface AiTurnOptions {
  /** 作者へ見せる機能名（「誤字脱字検知」など）。待ち表示に使う */
  readonly label: string;
  /**
   * 順番待ちの最中に中止されたときに呼ぶ。
   *
   * **中止されたら処理そのものを呼ばない**ので、機能側が
   * `token.onCancellationRequested` で立てている「中止された」の印は
   * 立たない。ここで立ててもらわないと、機能側は「0件で正常に終わった」
   * と読んで完了の知らせを出してしまう。
   */
  readonly onCancelled?: () => void;
}

/**
 * 待ち行列に並ぶ。中止されたら `undefined` を返す。
 *
 * 待ち文言は `report` へ渡す。**空いているときは何も出さない**——
 * 一瞬だけ「待っています」が見えると、かえって不安になる。
 */
async function takeTurn(
  label: string,
  signal: AbortSignal,
  report: (message: string) => void
): Promise<(() => void) | undefined> {
  const holder = currentRunLabel();
  if (holder !== undefined) report(`「${holder}」の完了を待っています…`);
  try {
    return await acquireRun(label, signal);
  } catch (error) {
    if (error instanceof AiQueueAbortError) return undefined;
    throw error;
  }
}

/** 中止の合図（`CancellationToken`）を `AbortSignal` へ橋渡しする */
function signalOf(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

/**
 * 進捗を出しながら一括処理を行う。**`withCancellableProgress` の代わりに
 * 呼ぶ**——題と機能名を渡すだけで、札の取得・待ち表示・解放が付いてくる。
 *
 * 待っている間の中止ボタンは、進捗に元から付いているものがそのまま効く。
 */
export async function withAiTurnProgress(
  title: string,
  options: AiTurnOptions,
  task: (
    progress: ProgressReporter,
    token: vscode.CancellationToken
  ) => Promise<void>
): Promise<void> {
  await withCancellableProgress(title, async (progress, token) => {
    const release = await takeTurn(options.label, signalOf(token), (message) =>
      progress.report({ message })
    );
    if (!release) {
      options.onCancelled?.();
      return;
    }
    try {
      await task(progress, token);
    } finally {
      release();
    }
  });
}

/**
 * 進捗のまとまりを**またいで**札を持つ形。
 *
 * 矛盾検知のように、題の違う進捗を2つ続けて出す機能で使う（検出と検証は
 * ひと続きの仕事なので、あいだに他機能を入れると読み込み直しが挟まる）。
 *
 * **待つときだけ、中止ボタン付きの進捗を出す。** 空いていれば何も出さず、
 * すぐ `run` へ入る。中止されたときは `run` を呼ばずに `undefined` を返す。
 */
export async function withAiTurn<T>(
  options: AiTurnOptions,
  run: () => Promise<T>
): Promise<T | undefined> {
  const holder = currentRunLabel();
  const release =
    holder === undefined
      ? // 空いている。`acquireRun` は同期で札を渡すので、割り込まれない
        await acquireRun(options.label)
      : await withCancellableProgress(
          `「${holder}」の完了を待っています`,
          (_progress, token) =>
            takeTurn(options.label, signalOf(token), () => undefined)
        );

  if (!release) {
    options.onCancelled?.();
    return undefined;
  }
  try {
    return await run();
  } finally {
    release();
  }
}
