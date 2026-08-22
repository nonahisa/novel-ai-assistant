import * as path from "./paths";
import type { WorkEntry } from "../models/types";

/**
 * 同期する置き場（設計書5.7.9）。
 *
 * **1つのリポジトリに複数の作品が入っている形を、既定とする**（作者の判断、
 * 2026-08-22）。作品ごとにリポジトリを分けると、別の環境へ移るたびに作品の
 * 数だけ取り寄せることになり、GitHub側の管理も作品の数だけ増える。
 *
 * ## それでも、分けたいときはある
 *
 * - すでに作品ごとに分けて管理していた
 * - 編集部へ渡す作品だけを切り出す（5.7.5。招待の範囲がリポジトリ単位なので、
 *   まとめたままでは全作品が読めてしまう）
 *
 * だから**選べるようにする。ただし既定はまとめる側に置く**——画面の言葉も、
 * まとめてある前提で書く。
 *
 * ## 「どの作品が同じ置き場にいるか」は、覚えない
 *
 * 登録簿には作品の場所しか無いが、**それで足りる。** 同じリポジトリかどうかは
 * `git rev-parse --show-toplevel` が教えてくれるし、まだリポジトリでなければ
 * フォルダーの前後関係で分かる。**覚えると、作者がフォルダーを動かしたときに
 * 食い違う。**
 *
 * VS Code APIに依存しない。
 */

export interface SyncTarget {
  /** gitを動かす場所。リポジトリの根になる（または、すでになっている） */
  folderPath: string;
  /** 画面に出す名前。フォルダー名か、作品が1つならその作品名 */
  label: string;
  /** この置き場に入っている、登録済みの作品 */
  works: WorkEntry[];
}

/** そのフォルダー自身か、その中にある登録済みの作品 */
export function worksInside(
  works: readonly WorkEntry[],
  folderPath: string
): WorkEntry[] {
  const parent = path.normalizeForComparison(folderPath);
  return works.filter((work) => {
    const candidate = path.normalizeForComparison(work.folderPath);
    if (candidate === parent) return true;
    const relative = path.relative(parent, candidate);
    return relative.length > 0 && !path.goesOutside(parent, relative);
  });
}

/**
 * 置き場を作る。
 *
 * **作品が1つだけなら、その作品名を出す。** フォルダー名と作品名が違うことが
 * あり、フォルダー名だけを出されても作者にはどれのことか分からない。
 */
export function buildSyncTarget(
  folderPath: string,
  works: readonly WorkEntry[]
): SyncTarget {
  const inside = worksInside(works, folderPath);
  const folderName = path.basename(folderPath);
  return {
    folderPath,
    label:
      inside.length === 1 &&
      path.normalizeForComparison(inside[0].folderPath) ===
        path.normalizeForComparison(folderPath)
        ? inside[0].title
        : folderName,
    works: inside,
  };
}

/** 「HisasNovels（3作品）」のような短い言い方 */
export function describeSyncTarget(target: SyncTarget): string {
  if (target.works.length <= 1) return target.label;
  return `${target.label}（${target.works.length}作品）`;
}

/**
 * **一緒に送られる作品を、名前で挙げる。**
 *
 * 1つのリポジトリに複数の作品が入っていると、1作品を選んで同期しても
 * **他の作品の変更も一緒に出ていく。** これはこの形の狙いどおりだが、
 * 画面に作品名が1つしか出ていないと、そうは読めない。
 *
 * 一緒に出るものが無ければ `undefined`（余計な行を足さない）。
 */
export function describeCompanions(
  target: SyncTarget,
  current: WorkEntry
): string | undefined {
  const others = target.works.filter((work) => work.id !== current.id);
  if (others.length === 0) return undefined;
  return `同じ置き場の「${others
    .map((work) => work.title)
    .join("」「")}」も一緒に扱われます。`;
}

/**
 * まとめる先の候補（まだリポジトリになっていないとき）。
 *
 * **作品フォルダーの1つ上を見る。** 作品集は「作品を並べただけ」の浅い形と
 * 決めてある（5.7）ので、まとめる先はそこである。
 *
 * 上が見つからない（作品フォルダーが根に近い）ときは `undefined`。
 */
export function parentFolderOf(folderPath: string): string | undefined {
  const parent = path.dirname(folderPath);
  if (
    path.normalizeForComparison(parent) ===
    path.normalizeForComparison(folderPath)
  ) {
    return undefined;
  }
  return parent;
}
