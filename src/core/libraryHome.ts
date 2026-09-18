import * as path from "./pathText";

/**
 * 新しい作品の行き先を決める（設計書6.97）。
 *
 * 作者の指示（2026-09-19）：「新規に登録する場合は、書庫管理を標準として
 * ください。既存資産がない場合は、ローカルでも書庫フォルダ作成を案内する
 * ようにしましょう」。
 *
 * ## 「書庫を作りますか」と訊かない
 *
 * 初めて使う人は、書庫が何の役に立つのかをまだ知らない。**作品を作る前に
 * 書庫を作るかどうかを決めさせるのは、理解できない二段階の判断である。**
 * そこで訊かずに書庫の形で作り、説明は一行だけ添える（6.97.2）。
 *
 * ## 機械が判断できることを人に聞かない
 *
 * すでに作品を置いてあるフォルダーが1つしかなければ、それが書庫である。
 * 訊かずにそこへ入れる。**分かれているときだけ訊く**——同期の置き場を
 * 決める `resolveSyncTarget.ts` と同じ考え方（5.7.3）。
 *
 * ## ここに `vscode` を持ち込まない
 *
 * 画面（フォルダー選択・選択画面）は `features/newWorkHome.ts` が受け持つ。
 * 判断だけを外へ出しておくと、**画面を押さずに単体で測れる。**
 * 場所の文字列も、`vscode` を連れてこない `pathText.ts` を直に指す。
 */

/**
 * 書庫がまだ無いときに作るフォルダーの名前。
 *
 * **作者が読んで意味の分かる日本語にする。** `Novels` のような英語だと、
 * エクスプローラーで見たときに何のフォルダーか分からない。
 */
export const DEFAULT_LIBRARY_NAME = "小説";

/** 行き先を決めるのに要る、作品の最小限 */
export interface WorkLocation {
  readonly folderPath: string;
}

/** 書庫らしいフォルダー1つ */
export interface LibraryCandidate {
  /** 書庫のフォルダー（作品フォルダーの1つ上） */
  readonly folderPath: string;
  /** そこに入っている登録済み作品の数 */
  readonly workCount: number;
}

/** 新しい作品をどこへ作るか */
export type NewWorkHome =
  /** すでにある書庫。訊かずにここへ入れる */
  | { readonly kind: "library"; readonly folderPath: string }
  /** 書庫が分かれている。ここだけは作者に選んでもらう */
  | { readonly kind: "choose"; readonly candidates: readonly LibraryCandidate[] }
  /** 書庫がまだ無い。場所を選んでもらって、その中に書庫を作る */
  | { readonly kind: "create" };

/**
 * 登録済みの作品から、書庫らしいフォルダーを数え上げる。
 *
 * **覚えない。** どのフォルダーが書庫かを登録簿に持つと、作者が
 * フォルダーを動かしたときに食い違う（`syncTarget.ts` と同じ理由）。
 * 作品の置き場所から、そのつど数える。
 */
export function findLibraries(
  works: readonly WorkLocation[]
): LibraryCandidate[] {
  const counted = new Map<string, { folderPath: string; workCount: number }>();
  for (const work of works) {
    const parent = path.dirname(path.normalize(work.folderPath));
    // 作品フォルダーが根そのもの（`C:/` など）なら、上は無い
    if (!parent || parent === path.normalize(work.folderPath)) continue;
    const key = path.normalizeForComparison(parent);
    const found = counted.get(key);
    if (found) {
      found.workCount += 1;
    } else {
      counted.set(key, { folderPath: parent, workCount: 1 });
    }
  }

  // 作品の多い順。同数なら場所の名前順（同じ並びが毎回出るように）
  return [...counted.values()].sort(
    (a, b) =>
      b.workCount - a.workCount || a.folderPath.localeCompare(b.folderPath)
  );
}

/**
 * 新しい作品の行き先を決める。
 *
 * **訊くのは「書庫が分かれているとき」だけ。** 1つしか無ければ、そこが
 * 書庫だと機械に分かる。1つも無ければ、これが1作目なので作る。
 */
export function decideNewWorkHome(works: readonly WorkLocation[]): NewWorkHome {
  const libraries = findLibraries(works);
  if (libraries.length === 0) return { kind: "create" };
  if (libraries.length === 1) {
    return { kind: "library", folderPath: libraries[0].folderPath };
  }
  return { kind: "choose", candidates: libraries };
}

/**
 * 行き先に添える一行の説明（6.97.2）。
 *
 * **「書庫」という言葉を前に出さない。** 初めての人には通じない言葉なので、
 * 何が起きるか（ここに作る・あとでまとめて置ける）だけを書く。
 */
export function describeNewWorkHome(libraryPath: string): string {
  return (
    `作品は「${path.basename(libraryPath)}」の中に作ります。` +
    "あとで作品が増えても、ここにまとめて置けます。"
  );
}

/**
 * 2作目を書庫の外に登録したときだけ、1度だけ、まとめるかを訊く（6.97.3）。
 *
 * **1作目では勧めない。** 作品が1つしかないうちは、まとめる利点
 * （同期が1回で済む）が見えないので、言われても意味が分からない。
 *
 * **毎回は言わない。** 2作目の一度きりにする。断った作者に3作目・4作目で
 * また言えば小言になる（6.89「以降は訊かない」と同じ筋）。
 *
 * @param works 登録し終えたあとの、すべての作品
 * @param added いま登録した作品
 * @param alreadyOffered 前に一度勧めたか
 */
export function shouldOfferLibraryMerge(input: {
  readonly works: readonly WorkLocation[];
  readonly added: WorkLocation;
  readonly alreadyOffered: boolean;
}): boolean {
  if (input.alreadyOffered) return false;
  // ちょうど2作目のときだけ。3作目以降は、もう勧める機会を過ぎている
  if (input.works.length !== 2) return false;

  const added = path.normalizeForComparison(input.added.folderPath);
  const others = input.works.filter(
    (work) => path.normalizeForComparison(work.folderPath) !== added
  );
  if (others.length !== 1) return false;

  // **同じ親の下に並んでいれば、もう書庫の中である。** 勧める理由が無い
  const addedParent = path.normalizeForComparison(
    path.dirname(path.normalize(input.added.folderPath))
  );
  const otherParent = path.normalizeForComparison(
    path.dirname(path.normalize(others[0].folderPath))
  );
  return addedParent !== otherParent;
}
