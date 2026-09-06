import { PostingStore } from "../core/postingStore";
import { logFailure } from "../core/logger";
import type { PostingSiteId } from "../models/posting";
import type { WorkEntry } from "../models/types";

/**
 * その作品に登録してある投稿先（設計書6.68.2）。
 *
 * 「投稿サイト用に変換してコピー」の**貼り付け先の並びを決めるためだけ**に
 * 使う（`core/postingCopyTargets.ts`）。
 *
 * **入口は3つあるが、台帳を読む処理は1つにする。** 普通のエディタ
 * （`features/ruby.ts`）・作品一覧の右クリック（`features/episodeCopy.ts`）・
 * 原稿エディタ（`features/manuscriptEditor.ts`）が同じものを呼ぶ。写しを作ると、
 * 失敗したときの扱いが入口ごとに食い違う日が来る。
 */
export async function registeredPostingSites(
  /** 作品が引けないことはある（作品の外のファイルを開いているとき） */
  work: WorkEntry | undefined
): Promise<readonly PostingSiteId[]> {
  if (!work) return [];

  try {
    const ledger = await new PostingStore(work).load();
    return ledger.sites.map((entry) => entry.site);
  } catch (error) {
    // **読めなくても止めない。** ここで要るのは並びを決める手がかりだけで、
    // 無くてもコピーはできる。台帳が壊れているときに「投稿サイト用に
    // コピー」まで使えなくなるほうが困る
    logFailure("投稿サイト用のコピー：投稿状態の台帳の読み込み", {
      work: work.title,
      error,
    });
    return [];
  }
}
