/**
 * 検知の対象を絞る（設計書6.8.7）。
 *
 * **誤字脱字だけのものではない**（作者の指摘、2026-09-20）。もとは誤字脱字
 * のために書いたが、中身は最初から機能に依らない——矛盾・推敲・伏線・
 * プロット逸脱も同じ形で絞れる。呼ぶ側が「どの機能の前回か」を持つ
 * （`features/typoCheckScope.ts`）。
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

/**
 * 対象の決め方。
 *
 * - `all`……作品全体
 * - `changed`……前回の検知のあとに書いた話だけ
 * - `first`……**はじめの何話かだけ**（作者の依頼、2026-09-20）。
 *   「まず10話だけ試して、この設定でまともな指摘が出るか見る」ためにある。
 *   モデルを替えて比べたい時期に、比べるたび全話へ賭けるのでは試せない
 */
export type ScopeKind = "all" | "changed" | "first";

export interface ScopeChoice {
  kind: ScopeKind;
  /** `changed` / `first` のときの対象。`all` なら undefined（絞らない） */
  filePaths?: string[];
}

/**
 * 「試す」で見る話数の既定。
 *
 * 10話あれば、指摘の当たり外れの傾向は読める。これ以上増やすと
 * 「試す」と言いながら本番と変わらない待ち時間になる。
 */
export const TRIAL_EPISODE_COUNT = 10;

/**
 * はじめの何話かを選ぶ。
 *
 * **並び順は呼び出し側（`scanWork`）のものをそのまま使う。** あちらが
 * 話数の順に並べているので、ここで数え直すと合本や連番の解釈が2か所に散る。
 */
export function firstEpisodes(
  candidates: readonly ScopeCandidate[],
  count: number = TRIAL_EPISODE_COUNT
): string[] {
  return candidates.slice(0, Math.max(0, count)).map((c) => c.filePath);
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
 * 作者へ出す選択肢を決める。**`all` は必ず入る**（全体を選ぶ道は塞がない）。
 *
 * **出す意味があるものだけを出す。**
 *
 * - `changed`……前回の検知があり、対象が1件以上あり、全部ではないとき。
 *   一度も検知していなければ差分が決められず、全部が対象なら選んでも
 *   結果が変わらず、1件も無ければ呼び出し側が別の言い方で伝える
 * - `first`……話数が「試す話数」**より多い**とき。10話ちょうどの作品で
 *   「はじめの10話だけ」を出しても、それは全体そのものである
 */
export function scopeKinds(
  total: number,
  changed: number,
  lastCheckedAt: number | undefined,
  trial: number = TRIAL_EPISODE_COUNT
): ScopeKind[] {
  const kinds: ScopeKind[] = [];
  if (lastCheckedAt !== undefined && changed > 0 && changed < total) {
    kinds.push("changed");
  }
  if (total > trial) kinds.push("first");
  kinds.push("all");
  return kinds;
}

/**
 * 絞り込みを作者に聞くべきか。
 *
 * **聞く意味があるときだけ聞く**——選べるものが「全体」しか無いなら、
 * 問いを出すのはただの手間である。
 */
export function shouldAskScope(
  total: number,
  changed: number,
  lastCheckedAt: number | undefined,
  trial: number = TRIAL_EPISODE_COUNT
): boolean {
  return scopeKinds(total, changed, lastCheckedAt, trial).length > 1;
}

/** 作者に見せる説明。**どれだけ減るのかを数で示す** */
export function describeScope(total: number, changed: number): string {
  return (
    `前回の検知のあとに書いた話は ${changed} 話です` +
    `（作品全体では ${total} 話）。`
  );
}

/**
 * 前回の検知が無いときの説明。
 *
 * **「前回から」を持ち出さない。** 一度も検知していないのにその言葉を
 * 出すと、作者は「前に走らせたはずだが記録が消えたのか」と読む。
 */
export function describeScopeWithoutLastCheck(total: number): string {
  return `作品全体では ${total} 話です。`;
}
