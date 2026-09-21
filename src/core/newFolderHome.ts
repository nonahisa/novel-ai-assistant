import { findLibraries, type WorkLocation } from "./libraryHome";
import { isNestedLocation } from "./locationCompare";
import * as path from "./pathText";

/**
 * 「新しい置き場を作る」とき、フォルダー選択の窓を最初にどこで開くか
 * （設計書6.97.6）。
 *
 * ## なぜ要るか
 *
 * `showOpenDialog` に `defaultUri` を渡さないと、VS Code は**最後に使った
 * 場所**を開く。直前に原稿を触っていれば、**作者の作品フォルダーの中**が
 * 開いた状態で立ち上がる。そのまま押せば、原稿の中に書庫や編集用フォルダー
 * ができる（2026-09-21、ノートPCの実機で「GitHubから作品を追加」が
 * `…\novels\novels\初恋相手の王女…` を開いた）。
 *
 * **気づかなければ原稿の中に別のリポジトリが入る。** 気づいてから移すのは、
 * Gitの履歴を巻き込むので簡単ではない。窓が開く場所で防ぐ。
 *
 * ## どこを既定にするか
 *
 * **いちばん作品の多い書庫の「親」**である。書庫そのものではない。
 *
 * - 作品フォルダーの中は論外（今回の不具合そのもの）
 * - **書庫の中も避ける。** 書庫は1つのリポジトリなので（5.7）、その中へ
 *   取り寄せた書庫や編集用フォルダーを置くと、リポジトリの入れ子になる。
 *   `shareWithEditor` が「書庫の外を勧めます」と見出しに書いているのと
 *   同じ理由
 * - 書庫の親なら、作者がふだん小説を置いている階層で、かつ何のリポジトリ
 *   でもない。作者の見慣れた場所へ、横に並べる形になる
 *
 * 書庫が分かれていれば作品の多い順に見て、どれも使えなければ**いま開いて
 * いるフォルダー**（ワークスペース）へ落ちる。それも無ければ**既定を出さない**
 * ——当てずっぽうの場所を出すくらいなら、これまでどおりVS Codeに任せる
 * （少なくとも作者が最後に居た場所ではある）。
 *
 * ## ここに `vscode` を持ち込まない
 *
 * 窓を出すのは `features/pickFolder.ts` の仕事で、ここは場所を決めるだけ。
 * `libraryHome.ts` と同じ形にしてある——**画面を押さずに単体で測れる。**
 */

export interface NewFolderHomeInput {
  /** 登録済みの作品。**この中は絶対に既定にしない** */
  readonly works: readonly WorkLocation[];
  /** いま開いているフォルダー（ワークスペース）。書庫が無いときの受け皿 */
  readonly workspaceFolders?: readonly string[];
}

/**
 * 既定にしてよい場所を、良い順に並べて返す。
 *
 * **実際にあるかどうかは見ない**（`vscode` が要るため）。呼び出し側が
 * 先頭から順に確かめる。
 */
export function newFolderHomeCandidates(input: NewFolderHomeInput): string[] {
  const ordered: string[] = [];

  // 書庫（＝作品フォルダーの1つ上）の、さらに1つ上。作品の多い順に並ぶ
  for (const library of findLibraries(input.works)) {
    const parent = parentOf(library.folderPath);
    if (parent) ordered.push(parent);
  }

  ordered.push(...(input.workspaceFolders ?? []));

  const seen = new Set<string>();
  const usable: string[] = [];
  for (const candidate of ordered) {
    // 同じ親を持つ書庫が複数あると、同じ場所が何度も出てくる
    const key = path.normalizeForComparison(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isInsideAnyWork(candidate, input.works)) continue;
    usable.push(candidate);
  }
  return usable;
}

/**
 * その場所が、登録済みの作品フォルダーの中（またはそれ自身）か。
 *
 * **判定は `isNestedLocation` に任せる。** 大文字小文字の違いを自前で
 * 比べ直すと、綴りだけが違う道がすり抜ける（`shareWithEditor` で
 * 実際に踏んだ）。
 */
export function isInsideAnyWork(
  location: string,
  works: readonly WorkLocation[]
): boolean {
  return works.some((work) => isNestedLocation(location, work.folderPath));
}

/**
 * 1つ上のフォルダー。
 *
 * **根（`C:\` や `/`）は返さない。** 上が無い場合はもちろん、上が根そのもの
 * になる場合も既定にしない——ドライブの直下を開いて見せられても、作者は
 * どこへ置けばよいのか分からない。そのときは次の候補へ譲る。
 */
function parentOf(location: string): string | undefined {
  const here = path.normalize(location);
  const parent = path.dirname(here);
  if (!parent || parent === here) return undefined;
  if (path.dirname(parent) === parent) return undefined;
  return parent;
}
