import * as vscode from "vscode";
import { logStep, showLog } from "../core/logger";
import { isRememberable, rememberedAnswer, withRemembered } from "../core/confirmMemory";
import {
  readConfirmMemory,
  saveConfirmMemory,
} from "../core/confirmMemoryStore";

/**
 * 知らせの出し方をそろえる入口（作者の裁定 2026-09-06）。
 *
 * **「確認はモーダル、完了はステータスバー」。**
 *
 * きっかけは、1回の検知で「完了しました」「AIを設定しました」
 * 「解消を確認しました」「中止しました」が通知センターへ積み上がり、
 * **押したい確認カード（「実行」）が下へ押し出された**こと。
 * 通知は出た順に積まれるので、**読み捨ててよい報告が、返事を待っている
 * 問いかけを隠してしまう。**
 *
 * そこで、行き先を4つに分ける。
 *
 * 1. **実行してよいかの確認** → モーダル（`confirmRun`）。
 *    ほかの通知に埋もれないし、答えるまで先へ進まない。
 *    モーダルは `Esc` で閉じられるので「中止」ボタンは置かない
 *    （VS Codeがモーダルへ「キャンセル」を必ず付けるので、
 *    出口が無くなることもない）。
 *    **取り消しにくい操作は `kind: "warning"` で警告の顔にする**
 * 2. **その場限りの完了** → ステータスバー＋操作ログ（`notifyDone`）。
 *    「コピーした」「設定した」「中止した」「解消を確認した」「切り替えた」
 *    「登録した」のように、**件数・理由・保存先を伴わない**もの。
 *    見えたら用が済むので、数秒で消えてよい
 * 3. **あとで読み返す価値のあるもの** → 通知のまま。
 *    件数（「3件を…しました」）・失敗の理由・保存先・
 *    ボタンで次の操作へ進むもの。消えると困る
 * 4. **エラー・警告** → 通知のまま（`warnWithLog` / `errorWithLog`）。
 *    作者が気づかないと困るし、ログへの入口も要る
 *
 * **文言は変えないこと。** 行き先を変えるだけでも作者は戸惑うので、
 * 覚えている言葉まで一緒に変えない。
 */

/**
 * ステータスバーに完了を出しておく長さ（ミリ秒）。
 *
 * 目を離していても拾える程度に長く、次の操作の邪魔にならない程度に短く。
 */
export const DONE_MESSAGE_TIMEOUT_MS = 6000;

/**
 * その場限りの完了を知らせる。
 *
 * ステータスバーは数秒で消えるので、**同じ文言を操作ログにも残す。**
 * 「さっき何をしたか」をあとから追えるようにするため（`showLog`）。
 */
export function notifyDone(text: string): void {
  vscode.window.setStatusBarMessage(`$(check) ${text}`, DONE_MESSAGE_TIMEOUT_MS);
  logStep(text);
}

/**
 * 確認カードの顔つき。
 *
 * **取り消しにくい操作を、情報の顔で訊かない。** 人物をまとめる・
 * GitHubへ送信する・履歴に記録するは、押したあとで戻すのが難しい。
 * もともと `showWarningMessage` で出していたものが、0.35.3 で
 * `confirmRun` へ移った拍子に情報アイコンになっていた（0.35.4で戻す）。
 */
export type ConfirmKind = "info" | "warning";

export interface ConfirmOptions {
  /** 既定は `"info"`。取り消しにくい操作だけ `"warning"` にする */
  kind?: ConfirmKind;
  /**
   * モーダルの小さい字で出す補足（VS Codeの `detail`）。
   *
   * 処理量の見積もりのように**長くて読み飛ばされたくないもの**をここへ。
   * 渡さなければ今までどおり本文だけが出る。
   */
  detail?: string;
  /**
   * 「以降は訊かない」を出すときの覚え書きの id（`core/confirmMemory.ts`）。
   *
   * **渡さないかぎり、訊き方は1文字も変わらない。** 危ない操作には
   * 渡さないこと（一覧に無い id は覚えないので、渡しても固定はされない）。
   */
  remember?: { id: string };
}

/** 「以降は訊かない」を選ぶボタンの言い方。**実行の言葉に足す形にする** */
export function rememberLabel(runLabel: string): string {
  return `${runLabel}（以降は訊かない）`;
}

/**
 * 実行してよいかを確かめる。**モーダルで出す。**
 *
 * 戻りは「押したかどうか」。`Esc` で閉じられたときは false になるので、
 * 呼び出し側に「中止」ボタンを足す必要はない。VS Codeはモーダルへ
 * 「キャンセル」を必ず付けるため、押して閉じる道も残っている。
 *
 * `options.remember` を渡すと、ボタンが2つになる（「実行」と
 * 「実行（以降は訊かない）」）。**覚えるのは実行を選んだときだけで、
 * 中止は覚えない**——中止を固定すると、その機能は押しても何も起きない
 * まま戻せなくなる（作者には壊れたようにしか見えない）。
 */
export async function confirmRun(
  message: string,
  runLabel = "実行",
  options: ConfirmOptions = {}
): Promise<boolean> {
  const rememberId = options.remember?.id;

  // 覚えた答えが**いまのボタンの文言と同じ**ときだけ素通りさせる。
  // 文言を変えた確認は、古い答えで勝手に走らせない
  if (rememberId && isRememberable(rememberId)) {
    if (rememberedAnswer(readConfirmMemory(), rememberId) === runLabel) {
      logStep(`確認を省略（以降は訊かない）: ${rememberId} / ${runLabel}`);
      return true;
    }
  }

  const buttons =
    rememberId && isRememberable(rememberId)
      ? [runLabel, rememberLabel(runLabel)]
      : [runLabel];

  // 顔つきが違うだけで、訊き方（モーダル）は同じにする。
  // 揃えておかないと、警告のときだけ操作の手順が変わって見える。
  // **関数を変数へ取り出さずに呼ぶ**——`vscode.window` から外すと
  // 受け手（this）が外れる実装があり得るため
  const modal = { modal: true, detail: options.detail };
  const answer =
    options.kind === "warning"
      ? await vscode.window.showWarningMessage(message, modal, ...buttons)
      : await vscode.window.showInformationMessage(message, modal, ...buttons);

  if (answer === runLabel) return true;
  if (rememberId && answer === rememberLabel(runLabel)) {
    await rememberConfirmAnswer(rememberId, runLabel);
    return true;
  }
  return false;
}

/**
 * 答えを覚える。**覚え損ねても操作は続ける。**
 *
 * 設定への書き込みが失敗したときに実行まで巻き添えにすると、
 * 作者は「実行を押したのに走らない」と受け取る。
 */
async function rememberConfirmAnswer(
  id: string,
  answer: string
): Promise<void> {
  try {
    await saveConfirmMemory(withRemembered(readConfirmMemory(), id, answer));
    logStep(`以降は訊かないことにしました: ${id} / ${answer}`);
  } catch (error) {
    logStep(
      `「以降は訊かない」を覚えられませんでした: ${id} / ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * 通知の形で「するか／見送るか」を訊く。
 *
 * **モーダルにしない。** 原稿の画面から横に出す案内（`.md` にしますか、
 * 改行コードを揃えますかなど）と、**処理の途中で出る断り**（競合した
 * ファイルを外して続けますか）に使う。どちらも既にこの形で出ており、
 * **訊き方は変えない**——「以降は訊かない」を足すだけにする。
 *
 * 戻りは3つに分ける。`"later"`（見送るほうを押した）と
 * `"dismissed"`（黙って消えた）は意味が違う——前者だけ「もう勧めない」
 * を覚えている呼び出し側がある。
 */
export async function suggestAction(params: {
  message: string;
  /** 進めるほうのボタン */
  runLabel: string;
  /** 見送るほうのボタン */
  laterLabel: string;
  /** 既定は `"info"`。処理を止めうる断りは `"warning"` */
  kind?: ConfirmKind;
  remember?: { id: string };
}): Promise<"run" | "later" | "dismissed"> {
  const rememberId = params.remember?.id;

  if (rememberId && isRememberable(rememberId)) {
    if (rememberedAnswer(readConfirmMemory(), rememberId) === params.runLabel) {
      logStep(`案内を省略（以降は訊かない）: ${rememberId} / ${params.runLabel}`);
      return "run";
    }
  }

  const buttons =
    rememberId && isRememberable(rememberId)
      ? [params.runLabel, rememberLabel(params.runLabel), params.laterLabel]
      : [params.runLabel, params.laterLabel];

  const picked =
    params.kind === "warning"
      ? await vscode.window.showWarningMessage(params.message, ...buttons)
      : await vscode.window.showInformationMessage(params.message, ...buttons);
  if (picked === params.runLabel) return "run";
  if (rememberId && picked === rememberLabel(params.runLabel)) {
    await rememberConfirmAnswer(rememberId, params.runLabel);
    return "run";
  }
  if (picked === params.laterLabel) return "later";
  return "dismissed";
}

/** `pickWithMemory` に並べる項目。`value` を持たないものは中止の項目 */
export type MemorablePick<T extends string> = vscode.QuickPickItem & {
  value?: T;
};

/**
 * 選択肢が2つ以上あるものを訊き、**選んだ内容ごと覚えられる**ようにする。
 *
 * 「以降はこの選択で進む」は、**項目としては並べない。** 選択肢を2倍に
 * すると、どれを押せばよいかが読み取れなくなる（「前回から書いた分だけ」と
 * 「前回から書いた分だけ（以降は訊かない）」が並ぶ）。代わりに右上の
 * ピンのボタンで入り切りし、**入れたまま項目を選ぶと覚える**形にした。
 *
 * 選んだあとにもう1枚確認を出す形は採らない。訊く回数を減らすための
 * 仕組みで訊く回数が増えては、本末転倒になる。
 */
export async function pickWithMemory<T extends string>(params: {
  items: readonly MemorablePick<T>[];
  title: string;
  placeHolder?: string;
  remember?: { id: string };
}): Promise<T | undefined> {
  const rememberId = params.remember?.id;

  if (rememberId && isRememberable(rememberId)) {
    const answer = rememberedAnswer(readConfirmMemory(), rememberId);
    // **いまも選べる値のときだけ**素通りさせる。選択肢が変わったら訊き直す
    const known = params.items.find((item) => item.value === answer);
    if (known?.value !== undefined) {
      logStep(`確認を省略（以降は訊かない）: ${rememberId} / ${known.value}`);
      return known.value;
    }
  }

  const canRemember = Boolean(rememberId && isRememberable(rememberId));
  const quickPick = vscode.window.createQuickPick<MemorablePick<T>>();
  quickPick.title = params.title;
  // QuickPickOptions は `placeHolder`、QuickPick 本体は `placeholder`。
  // 綴りが違うので、片方を写すときに落ちやすい
  quickPick.placeholder = params.placeHolder;
  quickPick.ignoreFocusOut = true;
  quickPick.items = [...params.items];

  const pinTooltip = "以降はこの選択で進む";
  const offButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("pin"),
    tooltip: pinTooltip,
  };
  const onButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("pinned"),
    tooltip: `${pinTooltip}（入）`,
  };
  let pinned = false;
  if (canRemember) quickPick.buttons = [offButton];

  try {
    const picked = await new Promise<MemorablePick<T> | undefined>(
      (resolve) => {
        quickPick.onDidTriggerButton(() => {
          pinned = !pinned;
          // 押したことが分かるように、アイコンと題を入れ替える。
          // 押しても何も変わらないと、効いたかどうかが分からない
          quickPick.buttons = [pinned ? onButton : offButton];
          quickPick.title = pinned
            ? `${params.title} — 選んだものを以降も使います`
            : params.title;
        });
        quickPick.onDidAccept(() => {
          resolve(quickPick.selectedItems[0]);
          quickPick.hide();
        });
        quickPick.onDidHide(() => resolve(undefined));
        quickPick.show();
      }
    );

    const value = picked?.value;
    if (value === undefined) return undefined;
    if (canRemember && pinned && rememberId) {
      await rememberConfirmAnswer(rememberId, value);
    }
    return value;
  } finally {
    quickPick.dispose();
  }
}

/**
 * 警告と、ログへの入口をまとめて出す。
 *
 * **ボタンの名前は呼び出し側が渡す。** 既存の文言が「ログを見る」と
 * 「ログを表示」に割れており、そろえると作者が覚えている言葉が変わる。
 */
export async function warnWithLog(
  message: string,
  logLabel = "ログを見る"
): Promise<void> {
  const answer = await vscode.window.showWarningMessage(message, logLabel);
  if (answer === logLabel) showLog();
}

/** `warnWithLog` のエラー版。出す先が違うだけで扱いは同じ */
export async function errorWithLog(
  message: string,
  logLabel = "ログを見る"
): Promise<void> {
  const answer = await vscode.window.showErrorMessage(message, logLabel);
  if (answer === logLabel) showLog();
}
