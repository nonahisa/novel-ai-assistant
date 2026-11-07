/**
 * 話を開いたときに、編集者の鍵の台帳を取りに行くか（設計書5.7.5.2。作者の裁定 2026-11-07）。
 *
 * 作者の手元の鍵の台帳は、同期（保存・同期か開き直し）のときにしか編集用の置き場から
 * 取り込まれなかった。編集者が範囲を選んだ直後に作者が話を開くと、鍵がまだ届いておらず、
 * 校閲中の話に字が入った（2026-11-07 の作者の実機）。開くたびに鍵だけを取りに行く。
 *
 * 判断だけをここに置く（VS Code に依らない。単体テストでそのまま確かめる）。
 */

/** 同じ作品へ取りに行く間（5分）。開くたびに GitHub へ行くと、話を行き来するだけで待たされる */
export const LOCK_REFRESH_INTERVAL_MS = 5 * 60_000;

export interface LockRefreshCondition {
  /** 作品の `.aiwriter/editing.json` の編集者の GitHub 名（渡していない・解除したなら無い） */
  readonly editorLogin: string | undefined;
  /** 編集者モードの環境か（鍵を掛ける側なので取りに行かない） */
  readonly editorMode: boolean;
  /** git を動かせるか（ブラウザ版では動かせない） */
  readonly canRunProcesses: boolean;
  /** この作品へ最後に取りに行った時刻（ミリ秒）。まだなら undefined */
  readonly lastAttemptAt: number | undefined;
  readonly now: number;
}

export type LockRefreshDecision =
  | { readonly go: true }
  | {
      readonly go: false;
      readonly reason: "editorMode" | "browser" | "notShared" | "tooSoon";
    };

/**
 * 取りに行くか。
 *
 * **間は「試した時刻」から数える**（通ったときだけでなく）。回線が無いと毎回失敗するので、
 * 通ったときだけ数えると、話を開くたびに git が回線の待ちで止まる。
 */
export function decideLockRefresh(condition: LockRefreshCondition): LockRefreshDecision {
  if (condition.editorMode) return { go: false, reason: "editorMode" };
  if (!condition.canRunProcesses) return { go: false, reason: "browser" };
  if (!condition.editorLogin) return { go: false, reason: "notShared" };
  if (
    condition.lastAttemptAt !== undefined &&
    condition.now - condition.lastAttemptAt < LOCK_REFRESH_INTERVAL_MS
  ) {
    return { go: false, reason: "tooSoon" };
  }
  return { go: true };
}
