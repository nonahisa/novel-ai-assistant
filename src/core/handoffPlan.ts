import type { GitSyncStatus } from "./git";

/**
 * 機械を行き来したときに、置き場ごとに何をするかを決める（設計書6.15.1）。
 *
 * 作者の指示（2026-09-21）——
 *
 * > 開くときと閉じたときで、動きがあれば同期、あとは保存ボタン
 * > （ファイル保存と同期）を作りましょう。
 * > あとは通信や電池が切れて版がズレた時等の対応もあると嬉しいです
 *
 * ## 「重なる」はファイル単位で見る
 *
 * 両方に動きがあっても、**触ったファイルが重なっていなければ**自動で
 * 揃えてよい。重なっていたら手を止めて作者に訊く。
 *
 * **行単位で見て自動で混ぜない。** gitは同じファイルの離れた行なら機械的に
 * 混ぜられるが、それをやると**どちらの文章が消えたか作者が気づけない**
 * （設計書6.15「自動での競合解決は行わない」と同じ理由）。
 *
 * ## 自動で動かすのは、作者が既に手を離したものだけ
 *
 * 自動の経路（開いたとき・閉じる前）では、
 *
 * - **未保存のエディタがあれば何もしない。** 書いている途中だからである
 * - **未記録（コミットしていない）の変更があるときは、取り込みも合流もしない。**
 *   取り込みは書きかけを別の環境の版で塗り替えうるし、合流は書きかけごと
 *   履歴に入れてしまう
 * - **送信（push）だけは、未記録があっても行う。** pushが外へ出すのは
 *   **既にコミット済みのもの**だけで、書きかけは1文字も出ていかない。
 *   作者が「記録」を押した時点で手は離れている
 *
 * VS Code APIに依存しない（状態は呼び出し側が読んで渡す）。
 */

/** 自動では進めなかった理由 */
export type HandoffBlock =
  /** 競合マーカーが残っている（設計書5.5.1の手順2） */
  | "unmerged"
  /** 保存していないエディタがある */
  | "unsaved"
  /** 記録（コミット）していない変更がある */
  | "dirty";

/** その置き場で、自動で何をするか */
export type HandoffAction =
  /** することがない */
  | { kind: "nothing" }
  /** できるが、自動ではやらない。理由を知らせる */
  | {
      kind: "blocked";
      reason: HandoffBlock;
      behind: number;
      ahead: number;
      dirty: number;
    }
  /** リモートだけ進んでいる。黙って取る */
  | { kind: "take"; behind: number; dirty: number }
  /** ローカルに溜まっている。送る */
  | { kind: "send"; ahead: number; dirty: number }
  /** 両方に動きがあり、ファイルが重ならない。黙って揃える */
  | { kind: "fold"; behind: number; ahead: number; dirty: number }
  /** 両方に動きがあり、同じファイルが変わっている。止めて訊く */
  | {
      kind: "ask";
      behind: number;
      ahead: number;
      dirty: number;
      overlap: string[];
    };

export interface HandoffInput {
  status: GitSyncStatus;
  /**
   * 両方に動きがあるときの、**ファイル単位で重なったもの**。
   *
   * 調べられなかったときは `undefined` ではなく、呼び出し側が
   * 「重なっている」側へ倒して渡すこと（安全な側へ倒す）。
   */
  overlap?: readonly string[];
  /** この置き場に、保存していないエディタがあるか */
  unsaved?: boolean;
}

/**
 * 置き場1つぶんの手順を決める。**純粋関数。**
 *
 * `tracked` 以外（gitを使っていない・リモートが無い・まだ一度も送っていない）は
 * `nothing` にする。**異常ではない**ので、起動のたびに知らせると
 * 消せない表示になる（設計書5.5.1と同じ扱い）。
 */
export function planHandoff(input: HandoffInput): HandoffAction {
  const status = input.status;
  if (status.kind !== "tracked") return { kind: "nothing" };

  const { behind, ahead, dirty, unmerged } = status;

  // **競合マーカーが残っているなら、何もしない**（設計書5.5.1の手順2）。
  // 記録すればマーカーごと履歴に入り、送信すれば別の環境へも広がる
  if (unmerged > 0) {
    return { kind: "blocked", reason: "unmerged", behind, ahead, dirty };
  }

  const pending = behind > 0 || ahead > 0 || dirty > 0;
  if (!pending) return { kind: "nothing" };

  // **書いている途中には触らない。** 保存していない中身はgitから見えないので、
  // このまま記録・送信すると「送った」はずのものが欠ける
  if (input.unsaved) {
    return { kind: "blocked", reason: "unsaved", behind, ahead, dirty };
  }

  // **未記録があるなら、取り込みも合流もしない。** どちらも書きかけを
  // 巻き込む（取り込みは塗り替え、合流は履歴へ入れる）
  if (behind > 0 && dirty > 0) {
    return { kind: "blocked", reason: "dirty", behind, ahead, dirty };
  }

  if (behind > 0 && ahead > 0) {
    const overlap = [...(input.overlap ?? [])];
    return overlap.length > 0
      ? { kind: "ask", behind, ahead, dirty, overlap }
      : { kind: "fold", behind, ahead, dirty };
  }

  if (behind > 0) return { kind: "take", behind, dirty };
  // **送信は未記録があっても行う。** 出ていくのはコミット済みのものだけで、
  // 書きかけは1文字も外へ出ない
  if (ahead > 0) return { kind: "send", ahead, dirty };

  return { kind: "blocked", reason: "dirty", behind, ahead, dirty };
}

/**
 * 2つの側で変わったファイルの、**重なり**を取る。
 *
 * 比較は大文字小文字を無視し、区切りは `/` に揃える。
 * **迷ったら「重なっている」側へ倒す**——重なりを見落とすと自動で混ぜて
 * しまうが、余分に拾っても「止めて訊く」が増えるだけである。
 */
export function overlappingChangedFiles(
  local: readonly string[],
  remote: readonly string[]
): string[] {
  const remoteKeys = new Set(remote.map(normalizeGitPath));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of local) {
    const key = normalizeGitPath(file);
    if (!remoteKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function normalizeGitPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

/**
 * 起動時に点検する置き場の数の上限。
 *
 * **書庫では1つの置き場に11作品が入る**ので、作品の数ではなく置き場の数で
 * 数える。それでも別々の場所に置いた作品が増えると、開いた瞬間に何十回も
 * ネットワークへ出ることになり、起動が目に見えて遅くなる。
 *
 * 漏れたぶんは**本文を開いたときの点検**（`GitSyncMonitor` の
 * `onDidChangeActiveTextEditor`）が今までどおり拾う。
 */
export const STARTUP_CHECK_LIMIT = 8;

/** 起動時の点検の並べ替えに要る、手元だけで分かること */
export interface StartupTarget {
  /** 置き場（リポジトリ）の場所。並べ替えの鍵 */
  root: string;
  /**
   * 手元に送っていないものがあるか（未送信のコミット・未記録の変更）。
   *
   * **ネットワークに出る前に分かる。** だからこれで順番を決められる
   */
  pending: boolean;
}

/**
 * 起動時に点検する順番と、間引きを決める。**純粋関数。**
 *
 * **手元に送っていないものがある置き場を先に見る。** 取りこぼしが起きるのは
 * 「書いたのに送っていない」置き場であって、きれいな置き場ではない。
 * 通信や電池が切れて版がズレる場面も、必ずこちら側に痕跡が残る。
 *
 * 同じ組の中では渡された順を崩さない（登録順＝作者が並べた順）。
 */
export function orderStartupTargets<T extends StartupTarget>(
  targets: readonly T[],
  limit: number = STARTUP_CHECK_LIMIT
): { checked: T[]; deferred: T[] } {
  const byRoot = new Map<string, T>();
  for (const target of targets) {
    const found = byRoot.get(target.root);
    // 同じ置き場が複数の作品から来る（書庫）。**取りに行くのは1回でよい**
    if (!found) byRoot.set(target.root, target);
    else if (target.pending && !found.pending) byRoot.set(target.root, target);
  }

  const unique = [...byRoot.values()];
  const ordered = [
    ...unique.filter((one) => one.pending),
    ...unique.filter((one) => !one.pending),
  ];
  const size = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  return { checked: ordered.slice(0, size), deferred: ordered.slice(size) };
}
