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
  // 同じ場所かは登録簿の重複の見方と同じ鍵で見る（末尾の区切り・前後の
  // 空白の違いを同じとみなす。2026-09-24）
  const parent = path.folderKeyForComparison(folderPath);
  return works.filter((work) => {
    const candidate = path.folderKeyForComparison(work.folderPath);
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
      inside.length === 1 && path.isSameFolder(inside[0].folderPath, folderPath)
        ? inside[0].title
        : folderName,
    works: inside,
  };
}

/**
 * はじめての送信の確認に添える「入っている作品」の行。
 *
 * **何作品ぶんが出ていくのかを、送る前に言う。** 1つの置き場に複数の作品が
 * 入っているのが既定の形なので（設計書5.7.9）、作品名を1つだけ出すと
 * 「これだけが送られる」と読めてしまう。
 *
 * 1作品しか入っていなければ `undefined`——余計な行を足さない。
 */
export function describeIncludedWorks(target: SyncTarget): string | undefined {
  if (target.works.length <= 1) return undefined;
  return `入っている作品: ${target.works
    .map((entry) => entry.title)
    .join("・")}`;
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
 * 同期の記録（動作のログ）をどこへ書くか（設計書5.7.9「書庫のログ」）。
 *
 * **同期の相手は置き場（リポジトリ）であって作品ではない。** 以前は置き場の
 * 先頭の作品（`works[0]`）のログへ書いており、書庫の同期の記録が、触っても
 * いない作品のログに紛れていた（作者の裁定「書庫のログを1つ作る」、2026-10-03）。
 *
 * - **置き場そのものが登録済みの作品**（作品ごとにリポジトリを分けた形）→
 *   その作品のログ。`library: false`
 * - **それ以外**（書庫）→ 置き場の直下のログ。`library: true`。書庫に作品が
 *   1つしか登録されていない間も同じ場所にする——作品を足したとたんに
 *   置き場所が変わると、前の記録を探せなくなる
 * - **作品が1つも登録されていない置き場**（設定の途中）→ `undefined`。
 *   書き先を向けない（出力チャンネルにだけ出る。これまでどおり）
 *
 * VS Code APIに依存しない。
 */
export function syncLogPlace(
  root: string,
  works: readonly WorkEntry[]
): { folder: string; library: boolean } | undefined {
  if (works.length === 0) return undefined;
  const self = works.find((work) => path.isSameFolder(work.folderPath, root));
  if (self) return { folder: self.folderPath, library: false };
  return { folder: root, library: true };
}

/**
 * 書庫のログを置いているかもしれない場所（ログの掃除に使う。設計書8.3）。
 *
 * **作品フォルダーの1つ上**を、重ねずに並べる。書庫は「作品を並べただけ」の
 * 浅い形と決めてある（5.7）ので、書庫の直下は作品の親である。登録済みの作品
 * そのものは外す（その下のログは作品のログとして掃除される）。
 *
 * 深く入れ子にした置き場（作品の2つ以上上がリポジトリの根）は拾えない。
 * 掃除されないだけで、ログの上限（1ファイル1MB）は効く。
 */
export function libraryLogCandidates(works: readonly WorkEntry[]): string[] {
  const workKeys = new Set(
    works.map((work) => path.folderKeyForComparison(work.folderPath))
  );
  const seen = new Set<string>();
  const result: string[] = [];
  for (const work of works) {
    const parent = parentFolderOf(work.folderPath);
    if (!parent) continue;
    const key = path.folderKeyForComparison(parent);
    if (workKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(parent);
  }
  return result;
}

/**
 * まとめる先の候補（まだリポジトリになっていないとき）。
 *
 * **作品フォルダーの1つ上を見る。** 書庫は「作品を並べただけ」の浅い形と
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
