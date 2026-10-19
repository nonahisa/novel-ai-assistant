import * as path from "./paths";
import type { WorkEntry } from "../models/types";

/**
 * 作品一覧を書庫ごとに分ける（設計書6.97.7）。
 *
 * **git を呼ばない。** 書庫は「1つの git リポジトリで、作品をその直下に並べた
 * 浅い形」（5.7）と決めてあるので、作品フォルダーの**1つ上**を見れば足りる。
 * 一覧が出るたびに `git rev-parse` を作品の数だけ走らせると、設計書6.107（控えから
 * 先に出す）の速さを食う。`.git` が在るかどうかだけを、呼び出し側が調べて渡す。
 *
 * **登録簿に書庫の場所を覚えない**（6.97）。覚えると、作者がフォルダーを動かした
 * ときに食い違う。毎回、登録簿の作品の場所から決め直す。
 *
 * VS Code APIに依存しない。
 */

/** 1つの書庫（作品の1つ上のフォルダー）と、そこに入っている作品 */
export interface LibraryGroup {
  /** 書庫のフォルダー（作品の1つ上） */
  folderPath: string;
  /** 見出しに出す名前（フォルダー名） */
  name: string;
  /** 登録簿の順のままの作品 */
  works: WorkEntry[];
}

export interface WorkLibraryLayout {
  /**
   * 書庫ごとの並び（名前順）。**書庫が2つに満たなければ空**——初めての人に
   * 「書庫」を見せない（6.97.2）。そのとき全作品は `standalone` に登録簿の順で入る。
   */
  libraries: LibraryGroup[];
  /** どの書庫にも入れない作品。書庫の段の後ろに、いまと同じ形で並べる */
  standalone: WorkEntry[];
}

/**
 * 書庫の候補になる、作品の1つ上のフォルダーを求める。
 * 作品フォルダー自身が git の根（作品ごとのリポジトリ）なら単独で、候補なし。
 */
function candidateParent(
  work: WorkEntry,
  hasGit: (key: string) => boolean
): string | undefined {
  if (hasGit(path.folderKeyForComparison(work.folderPath))) return undefined;
  const parent = path.dirname(work.folderPath);
  const parentKey = path.folderKeyForComparison(parent);
  if (!parentKey || parentKey === path.folderKeyForComparison(work.folderPath)) {
    return undefined;
  }
  return parent;
}

/**
 * `.git` の有無を調べる対象。作品フォルダーと、その1つ上のフォルダー。
 *
 * 比べる鍵（`folderKeyForComparison`）で重ねずに挙げるので、書庫に作品が
 * 何件入っていても `stat` は1フォルダーにつき1回で済む。鍵は
 * `groupWorksByLibrary` の `gitFolders` にそのまま使う。
 */
export function foldersToProbeForGit(
  works: readonly WorkEntry[]
): Array<{ key: string; folderPath: string }> {
  const found = new Map<string, string>();
  const add = (folderPath: string): void => {
    const key = path.folderKeyForComparison(folderPath);
    if (key && !found.has(key)) found.set(key, folderPath);
  };
  for (const work of works) {
    add(work.folderPath);
    add(path.dirname(work.folderPath));
  }
  return [...found].map(([key, folderPath]) => ({ key, folderPath }));
}

/**
 * 書庫ごとに分ける。
 *
 * @param gitFolders `.git` が在ったフォルダー（`folderKeyForComparison` の鍵）。
 *   `foldersToProbeForGit` で挙げたものを調べて渡す。調べられなかったものは入れない
 *   （書庫と見なさない側に倒す。作品が消えることはない）
 */
export function groupWorksByLibrary(
  works: readonly WorkEntry[],
  gitFolders: ReadonlySet<string>
): WorkLibraryLayout {
  const hasGit = (key: string): boolean => gitFolders.has(key);
  const parents = new Map<string, { folder: string; works: WorkEntry[] }>();
  const parentOf = new Map<string, string>();
  for (const work of works) {
    const parent = candidateParent(work, hasGit);
    if (parent === undefined) continue;
    const key = path.folderKeyForComparison(parent);
    parentOf.set(work.id, key);
    const entry = parents.get(key);
    if (entry) entry.works.push(work);
    else parents.set(key, { folder: parent, works: [work] });
  }

  // (a) 1つ上に .git が在る（リポジトリの根）か、(b) 直下に2作品以上
  const libraryKeys = new Set<string>();
  for (const [key, entry] of parents) {
    if (hasGit(key) || entry.works.length >= 2) libraryKeys.add(key);
  }

  // 書庫が2つに満たなければ見出しを出さない（6.97.2）
  if (libraryKeys.size < 2) return { libraries: [], standalone: [...works] };

  const libraries: LibraryGroup[] = [...libraryKeys].map((key) => {
    const entry = parents.get(key)!;
    return {
      folderPath: entry.folder,
      name: path.basename(entry.folder) || entry.folder,
      works: entry.works,
    };
  });
  libraries.sort(
    (a, b) =>
      a.name.localeCompare(b.name, "ja") ||
      path
        .folderKeyForComparison(a.folderPath)
        .localeCompare(path.folderKeyForComparison(b.folderPath))
  );
  const standalone = works.filter((work) => {
    const key = parentOf.get(work.id);
    return key === undefined || !libraryKeys.has(key);
  });
  return { libraries, standalone };
}
