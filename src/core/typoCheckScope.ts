/**
 * 誤字脱字を「前回から書いた分だけ」に絞る（設計書6.8.7）。
 *
 * ## なぜ要るか
 *
 * チャンクのキャッシュがあるので、**作品全体を選んでもAIは呼び直さない。**
 * それでも絞りたい理由が2つある。
 *
 * 1. **一覧が長い。** 219話の作品で全体を見ると、**前に読んで直さないと
 *    決めた箇所まで毎回並ぶ**（「無視」を押したものは消えるが、
 *    押さずに残したものは戻ってくる）
 * 2. **全話の読み込みと分割に時間がかかる。** AIを呼ばなくても、
 *    ファイルを読んでハッシュを取る手間は話数ぶんかかる
 *
 * ## gitではなく更新時刻で見る
 *
 * 「差分」と言えばgitだが、**Gitを使わずに書いている作品がある。**
 * そちらでは絞り込みが一切できなくなる。
 *
 * 更新時刻なら、**どの作品でも同じように働く。** 抽出の未処理数を
 * 数えるのと同じ考えである（6.21.1）。
 *
 * ## 外れる方向
 *
 * **取りこぼすより、余分に見るほうへ倒す。** 時刻が読めないファイルは
 * 対象に含める。見落として誤字が残るより、1話ぶん余計に見るほうがよい。
 *
 * VS Code APIに依存しない。
 */

export interface ScopeCandidate {
  filePath: string;
  /** 更新時刻（ミリ秒）。取れなければ undefined */
  modifiedAt: number | undefined;
}

export type ScopeKind = "all" | "changed";

export interface ScopeChoice {
  kind: ScopeKind;
  /** `changed` のときの対象。`all` なら undefined（絞らない） */
  filePaths?: string[];
}

/**
 * 前回の検知より後に書かれたファイルを選ぶ。
 *
 * @param lastCheckedAt 前回の検知の時刻。一度も検知していなければ undefined
 */
export function changedSince(
  candidates: readonly ScopeCandidate[],
  lastCheckedAt: number | undefined
): string[] {
  if (lastCheckedAt === undefined) {
    // 一度も検知していないなら「差分」は決められない。全部が対象
    return candidates.map((candidate) => candidate.filePath);
  }
  return candidates
    .filter(
      (candidate) =>
        // **時刻が読めないものは含める**（取りこぼすより余分に見る）
        candidate.modifiedAt === undefined ||
        candidate.modifiedAt > lastCheckedAt
    )
    .map((candidate) => candidate.filePath);
}

/**
 * 絞り込みを作者に聞くべきか。
 *
 * **聞く意味があるときだけ聞く。**
 *
 * - 一度も検知していない → 聞かない（差分が決められない）
 * - 全部が対象になる → 聞かない（選んでも変わらない）
 * - 1件も無い → 聞かない（呼び出し側が「新しく書いた話はありません」と伝える）
 */
export function shouldAskScope(
  total: number,
  changed: number,
  lastCheckedAt: number | undefined
): boolean {
  if (lastCheckedAt === undefined) return false;
  if (changed === 0) return false;
  return changed < total;
}

/** 作者に見せる説明。**どれだけ減るのかを数で示す** */
export function describeScope(total: number, changed: number): string {
  return (
    `前回の検知のあとに書いた話は ${changed} 話です` +
    `（作品全体では ${total} 話）。`
  );
}
