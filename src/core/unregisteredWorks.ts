import * as path from "./pathText";
import { findLibraries, type WorkLocation } from "./libraryHome";
import { countEpisodeFiles, scanCollection } from "./workCollection";

/**
 * 書庫にあるのに登録されていない作品を拾う（設計書6.97.4）。
 *
 * 作者の指示（2026-09-19）：「これも自動化できるようにしてください」。
 *
 * ## なぜ要るか
 *
 * なろうのバックアップから作品を書庫へ置いたあと、登録する道は
 * 「フォルダから追加」しかなく、**OSのフォルダー選びが開く。** 目的の
 * フォルダーへ辿り着くのに6回潜ることになった（2026-09-19、実機）。
 *
 * **今日だけの話ではない。** 別の機械で作品を足して `git pull` したときも、
 * **ファイルはあるのに、その機械では登録されていない**状態になる。
 *
 * **0.69.5 で入れたもの（登録されているのにフォルダが無い）の、ちょうど
 * 裏返しである。** あちらは作り直さずに知らせる。こちらは拾えるようにする。
 *
 * ## 書庫の場所は覚えない
 *
 * 登録済み作品の親フォルダーから、そのつど割り出す。**覚えると、作者が
 * フォルダーを動かしたときに食い違う**（`syncTarget.ts`・`libraryHome.ts`
 * と同じ理由）。数え上げは `libraryHome.ts` の `findLibraries` に任せる
 * ——書庫を数える道を2本にしない。
 *
 * ## ここに画面を持ち込まない
 *
 * 探す判断だけを置き、選ばせる画面と登録は
 * `features/collectUnregisteredWorks.ts` が受け持つ。**画面を押さずに
 * 単体で測れる**ようにしておくための線引きである（`libraryHome.ts` と同じ）。
 */

/** 書庫で見つかった、まだ登録していない作品 */
export interface FoundWork {
  /** フォルダーの場所 */
  readonly folderPath: string;
  /** 既定の作品名（フォルダー名） */
  readonly title: string;
  /** `.aiwriter/config.json` があるか。あればこの拡張機能で作った作品 */
  readonly hasConfig: boolean;
  /** 本文のファイル数。どれくらいの分量かを見せるためだけの目安 */
  readonly episodeCount: number;
}

/**
 * gitの根を教えてもらう口。
 *
 * **`core/git.ts` を直に指さない。** あちらは `node:child_process` を静的に
 * import しているので、指した瞬間にブラウザ版の束へ混ざる（規則7）。
 * 呼び出し側（`features`）が、外部プロセスを起動できる環境でだけ渡す。
 */
export type RepoRootResolver = (
  folderPath: string
) => Promise<string | undefined>;

/**
 * どこを書庫として探すか。
 *
 * **軸は「登録済み作品の親フォルダー」である。** 書庫は「作品を並べただけ」の
 * 浅い形と決めてあるので（5.7）、隣に並んでいるものを見れば足りる。
 *
 * gitの根も足せるようにしてあるが、**足すのは作品フォルダーより上にある
 * ときだけ。** 作品そのものが根（作品ごとにリポジトリを分けている形）なら、
 * その上は親フォルダーが受け持つ。
 *
 * **作品フォルダーそのものは根にしない。** 根にすると、その直下の「本文」が
 * 話数ファイルを持っているせいで作品に見えてしまう。
 */
export async function libraryRootsOf(
  works: readonly WorkLocation[],
  repoRootOf?: RepoRootResolver
): Promise<string[]> {
  const roots = new Map<string, string>();
  const add = (folderPath: string): void => {
    const key = path.normalizeForComparison(folderPath);
    if (!roots.has(key)) roots.set(key, folderPath);
  };

  for (const library of findLibraries(works)) add(library.folderPath);

  if (repoRootOf) {
    for (const work of works) {
      const root = await repoRootOf(work.folderPath);
      if (!root) continue;
      if (!isProperAncestor(root, work.folderPath)) continue;
      add(root);
    }
  }

  return [...roots.values()];
}

/** `candidate` は `root` の中にあるか（同じ場所は「中」に数えない） */
function isProperAncestor(root: string, candidate: string): boolean {
  const base = path.normalizeForComparison(root);
  const inside = path.normalizeForComparison(candidate);
  if (base === inside) return false;
  const relative = path.relative(base, inside);
  return relative.length > 0 && !path.goesOutside(base, relative);
}

/**
 * 書庫の中の、まだ登録していない作品を集める。
 *
 * **登録済みの作品が1つも無ければ、探しようがない**——書庫の場所は
 * 登録済み作品から割り出しているので、手がかりが無い。空を返す
 * （呼び出し側が「まず1作品を登録してください」と案内する）。
 */
export async function findUnregisteredWorks(
  works: readonly WorkLocation[],
  options: { readonly repoRootOf?: RepoRootResolver } = {}
): Promise<FoundWork[]> {
  if (works.length === 0) return [];

  const registered = new Set(
    works.map((work) => path.normalizeForComparison(work.folderPath))
  );
  const roots = await libraryRootsOf(works, options.repoRootOf);

  const found = new Map<string, FoundWork>();
  for (const root of roots) {
    const scan = await scanCollection(root, (folder) =>
      registered.has(path.normalizeForComparison(folder))
    );
    // 作品そのもの・作品が無い・読めない、はどれも「拾うものが無い」。
    // 読めないことをここで騒いでも、作者に打つ手が無い
    if (scan.kind !== "collection" && scan.kind !== "work_with_children") {
      continue;
    }
    for (const candidate of scan.works) {
      if (candidate.alreadyRegistered) continue;
      const key = path.normalizeForComparison(candidate.folderPath);
      // 書庫の根が複数あると、同じ作品が2度出てくることがある
      if (registered.has(key) || found.has(key)) continue;
      found.set(key, {
        folderPath: candidate.folderPath,
        title: candidate.title,
        hasConfig: candidate.hasConfig,
        episodeCount: await countEpisodeFiles(candidate.folderPath),
      });
    }
  }

  // 作品名の順。登録簿の並びと揃えて、見つけやすくする
  return [...found.values()].sort((a, b) => a.title.localeCompare(b.title, "ja"));
}

/**
 * まだ知らせていないもの。
 *
 * **起動のたびに同じことを言わない。** 一度知らせたものを覚えておき、
 * **新しく増えたときだけ**もう一度知らせる（`externalAccessWatcher.ts` の
 * 「同じノックで何度も呼ばない」と同じ考え方）。**押さなければ何も起きない**
 * ので、黙らせても作者は何も失わない。
 */
export function unnotifiedFolders(
  found: readonly FoundWork[],
  notified: readonly string[]
): FoundWork[] {
  const seen = new Set(notified);
  return found.filter(
    (work) => !seen.has(path.normalizeForComparison(work.folderPath))
  );
}

/**
 * 次に覚えておく分。
 *
 * **いま見つかっているものだけを残す。** 登録された作品・消えた作品を
 * 覚えたままにすると、覚えが際限なく増える。外れたものが将来また
 * 未登録で現れたら、そのときは新顔として知らせてよい。
 */
export function foldNotified(found: readonly FoundWork[]): string[] {
  return found.map((work) => path.normalizeForComparison(work.folderPath));
}

/** 題を並べきる上限。これを超えたら「ほかN件」へ畳む */
const TITLES_IN_MESSAGE = 3;

/**
 * 起動したときに出す、1行の知らせ。
 *
 * **勝手に登録しない**ので、ここで言うのは「あります」までである。
 * 書庫に置いてあるだけで作品として扱ってよいとは限らない（下書き置き場、
 * 参考資料、別の道具のフォルダーかもしれない）。
 */
export function describeUnregistered(found: readonly FoundWork[]): string {
  const titles = found.slice(0, TITLES_IN_MESSAGE).map((work) => work.title);
  const rest = found.length - titles.length;
  const names = rest > 0 ? [...titles, `ほか${rest}件`] : titles;
  return (
    `書庫に、まだ登録していない作品が${found.length}件あります` +
    `（${names.join("・")}）。`
  );
}
