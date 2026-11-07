import type { WorkEntry } from "../models/types";
import * as paths from "../core/paths";
import { editorLockOf, onLockLedgerWritten } from "../core/fileLockStore";
import { reviewLockBannerText, reviewLockDetail } from "../core/reviewLockMessages";
import type { FileLock } from "../models/fileLock";
import { readSite } from "./editingSite";

/**
 * 原稿エディターの画面へ「校閲中か」を知らせる（設計書6.25.12。作者の裁定 2026-11-07）。
 *
 * 画面は、届いた知らせで帯・赤い枠・読むだけを切り替える（`manuscriptEditorHtml.ts` の
 * `takeReviewLock`）。**打った字を文書へ入れない関所（`applyScreenEdit`）は別に残す**——
 * 画面の側の止め方には抜け道（変換の字・右クリックの品書きの一部）があるので、最後の守りが要る。
 */

export type ReviewLockMessage =
  | { type: "reviewLock"; locked: true; text: string }
  | { type: "reviewLock"; locked: false };

const NOT_LOCKED: ReviewLockMessage = { type: "reviewLock", locked: false };

/**
 * いまの知らせ。作者モードで、編集者の鍵があれば帯の文を組む。
 *
 * 名前は `.aiwriter/editing.json` の GitHub 名（解除したあとは前の編集者の名前）。
 * **鍵の holder（git の名前）は出さない**（作者が招いた名前と違うことがある。0.138.0）。
 * 鍵が読めないときは「校閲中でない」（作者の原稿を触れなくする側へ倒さない）。
 */
export async function reviewLockMessageFor(
  work: WorkEntry | undefined,
  filePath: string,
  editorMode: boolean
): Promise<ReviewLockMessage> {
  if (editorMode || !work) return NOT_LOCKED;
  let lock;
  try {
    lock = await editorLockOf(work, filePath);
  } catch {
    return NOT_LOCKED;
  }
  if (!lock) return NOT_LOCKED;
  return {
    type: "reviewLock",
    locked: true,
    text: reviewLockBannerText({
      editorLogin: await reviewLockEditorLogin(work),
      since: lock.since,
    }),
  };
}

/**
 * 校閲中の知らせに出す編集者の名前（帯・右下の知らせ・素のエディターの警告で同じ。0.140.1）。
 * `.aiwriter/editing.json` の GitHub 名、解除したあとは前の編集者の名前。
 * **鍵の holder（git の名前）は使わない。** 読めなければ undefined（「編集者」とだけ出る）
 */
export async function reviewLockEditorLogin(work: WorkEntry): Promise<string | undefined> {
  try {
    const site = await readSite(work);
    return site.editorLogin ?? site.formerEditorLogin;
  } catch {
    return undefined;
  }
}

/** 「編集者 kmizu・11月7日 18:30 から」。右下の知らせ・警告・書き込みの断りの括弧の中 */
export async function reviewLockDetailFor(work: WorkEntry, lock: FileLock): Promise<string> {
  return reviewLockDetail({ editorLogin: await reviewLockEditorLogin(work), since: lock.since });
}

export interface ReviewLockWatch {
  /** この原稿の作品（開いている間に登録し直されることがあるので、毎回引く） */
  work(): WorkEntry | undefined;
  filePath: string;
  /** 画面へ送る（閉じた画面へ送って投げても止めない） */
  post(message: ReviewLockMessage): void | Thenable<unknown>;
  editorMode(): boolean;
}

/**
 * 開いたときに1回送り、その作品の鍵の台帳が書かれるたびに確かめ直す。
 * **変わったときだけ送る**（ほかの話の鍵が動いても、同じ知らせを送り直さない）。
 *
 * 確かめ直しは順に1つずつ（台帳を読んでいる間に次の書き込みが来ても、古い結果で
 * 新しい結果を上書きしない）。
 */
export function watchReviewLock(watch: ReviewLockWatch): { dispose(): void } {
  let last: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  const check = (): void => {
    chain = chain
      .then(async () => {
        if (disposed) return;
        const message = await reviewLockMessageFor(watch.work(), watch.filePath, watch.editorMode());
        const key = JSON.stringify(message);
        if (disposed || key === last) return;
        last = key;
        await watch.post(message);
      })
      .catch(() => undefined);
  };
  const listening = onLockLedgerWritten((written) => {
    const work = watch.work();
    if (!work) return;
    if (paths.normalizeForComparison(written.folderPath) !== paths.normalizeForComparison(work.folderPath)) {
      return;
    }
    check();
  });
  check();
  return {
    dispose: () => {
      disposed = true;
      listening.dispose();
    },
  };
}
