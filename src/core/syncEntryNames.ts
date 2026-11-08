import { findAction } from "./actionTree";
import { keysForHost } from "./keyLabels";

/**
 * 同期まわりの案内の文で名指す、メニューの項目の名前（作者の判断 2026-11-01）。
 *
 * **名前は詳細メニューの定義（`ACTION_TREE`）から引く。** 案内の文に書き写すと、
 * メニューの名前を変えたときに文だけが古くなる（「GitHubと同期」の「GitHub の
 * 書き換えを受け取る」を押して、と言うのに、その項目がもう無い——が実際に起きた）。
 * `nameRename.ts` の `findAction(...).label` と同じ形。
 *
 * 木から引けなかったとき（名前の付け替えの途中など）の控えの名前も持つ。
 * `processAvailability.ts` は `actionTree.ts` から読まれる側なので、ここを読まない
 * （互いに読み合う形にしない）。あちらの文は単体テストが名前と突き合わせる。
 */

export const SAVE_AND_SYNC_COMMAND = "novelai.saveAndSync";
export const SETUP_GITHUB_COMMAND = "novelai.setupGithub";
export const FINISH_REVIEW_COMMAND = "novelai.finishReviewAndReturn";

/** 同期の入口（「保存・同期」） */
export function saveAndSyncLabel(): string {
  return findAction(SAVE_AND_SYNC_COMMAND)?.label ?? "保存・同期";
}

/** 送り先を決める入口（「GitHub初期設定」） */
export function setupGithubLabel(): string {
  return findAction(SETUP_GITHUB_COMMAND)?.label ?? "GitHub初期設定";
}

/** 編集者が作者へ送る唯一の入口（「校閲を終えて返す」） */
export function finishReviewLabel(): string {
  return findAction(FINISH_REVIEW_COMMAND)?.label ?? "校閲を終えて返す";
}

/**
 * 記録する人の名前（git の user.name／email）が無いときの案内。
 *
 * 以前は「『GitHubと同期』から一度設定してください」だったが、その項目は詳細
 * メニューから外した（作者の判断 2026-11-01）。名前を訊く画面は、作品一覧の
 * 右クリックの「GitHubと同期」→「いまの原稿を履歴に残す」に残っている
 * （`gitOnboarding.ts` の `recordChanges` が訊く）。「保存・同期」はまとめて
 * 進める流れなので、途中で入力欄を出さない。
 */
export const IDENTITY_MISSING_HINT =
  keysForHost("記録する人の名前が未設定です。作品一覧で作品を右クリックし、") +
  "「GitHubと同期」→「いまの原稿を履歴に残す」を押すと、名前を設定して記録できます。";

/**
 * 原稿に「どちらの文を残すか決まっていない」所があるときの直し方（1文）。
 *
 * 「『競合解決』で直して」と言っていたが、その項目は詳細メニューから外した
 * （作者の判断 2026-11-01）。手元では「保存・同期」を押せば、残す文を選ぶ画面へ
 * ボタンで進める。**ブラウザ版では残す文を選ぶ画面が使えない**（git を起動できない）
 * ので、VS Code のソース管理へ案内する（設計書5.8.9）。
 */
export function conflictFixHint(canRunProcesses: boolean): string {
  if (!canRunProcesses) {
    return (
      "VS Code のソース管理（左の枝分かれの印）で、どちらの文を残すか選んで直してください。"
    );
  }
  return `「${saveAndSyncLabel()}」を押すと、残す文を選ぶ画面へ進めます。`;
}
