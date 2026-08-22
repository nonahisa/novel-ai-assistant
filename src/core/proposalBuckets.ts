/**
 * 提案パネルの中身を、分類ごとに分けて持つ（設計書6.11.3）。
 *
 * **他の検知を走らせると、それまでの作業が消えていた。**
 * 誤字脱字を1件ずつ見ている途中で推敲を実行すると、パネルの中身が
 * 丸ごと入れ替わり、適用済み・見送り済みの判断も、まだ見ていない指摘も
 * すべて失われた（2026-08-22、作者の指摘）。
 *
 * ## 混ぜずに、分けて足す
 *
 * 1つの配列へ足していくと、**誤字脱字と推敲が入り混じる。** 見る観点が
 * 違うものが並ぶと、作者はどちらの目で読めばよいのか分からなくなる。
 * かといって入れ替えると作業が消える。だから**分類ごとに置き場を持ち、
 * 切り替えて見る。**
 *
 * ## 同じ分類をもう一度走らせたときは、判断を残す
 *
 * 話を絞って2回に分けて実行することがある。2回目で1回目の結果が消えては
 * 同じことになるので、**同じ印（id）のものは作者の判断を残し、
 * 新しいものだけを足す。**
 *
 * ただし**まだ手を付けていないもの（`pending`）は、新しい内容で置き換える。**
 * 作者は何も決めていないので、古い内容を抱え込む理由がない。
 *
 * VS Code APIに依存しない。
 */

/** 提案パネルに並ぶものが、最低限持っている形 */
export interface ProposalLike {
  id: string;
  status: string;
}

/**
 * まだ作者の手が要るもの。
 *
 * 適用したもの・見送ったものは判断が済んでいる。**失敗したものは残りに数える**
 * ——手は付けたが、片付いていない。
 */
export function isRemaining(item: ProposalLike): boolean {
  return item.status === "pending" || item.status === "failed";
}

/**
 * 同じ分類の中へ、新しい結果を足す。
 *
 * @param existing いま持っているもの（作者の判断が入っている）
 * @param incoming 今回の検知結果
 */
export function mergeProposals<T extends ProposalLike>(
  existing: readonly T[],
  incoming: readonly T[]
): T[] {
  const merged = [...existing];
  const positionById = new Map(merged.map((item, index) => [item.id, index]));

  for (const item of incoming) {
    const at = positionById.get(item.id);
    if (at === undefined) {
      positionById.set(item.id, merged.length);
      merged.push(item);
      continue;
    }
    // **作者が決めたものは触らない。** 適用済みを `pending` へ戻すと、
    // 同じ直しをもう一度当てにいくことになる
    if (merged[at].status !== "pending") continue;
    merged[at] = item;
  }
  return merged;
}

/** 分類の見出しに添える数（画面のタブに出す） */
export interface CategorySummary {
  name: string;
  /** まだ手を付けていない件数 */
  remaining: number;
  /** その分類に入っている総数（0件でもタブは残す） */
  total: number;
  active: boolean;
}

/**
 * タブに並べる順を決める。
 *
 * **走らせた順に並べる。** 分類の名前で並べ替えると、いま実行したものが
 * どこへ入ったのか目で追えない。`Map` は入れた順を保つので、そのまま使う。
 */
export function summarizeCategories(
  counts: ReadonlyMap<string, { remaining: number; total: number }>,
  active: string
): CategorySummary[] {
  return [...counts].map(([name, count]) => ({
    name,
    remaining: count.remaining,
    total: count.total,
    active: name === active,
  }));
}

/**
 * パネルのタブに出す印の説明。
 *
 * **分類ごとの内訳まで出す。** 合計だけだと、どれを見に行けばよいか
 * 分からない（提案パネルは下段にあり、開くまで中身が見えない）。
 */
export function describeBadgeTooltip(
  summaries: readonly CategorySummary[]
): string {
  const parts = summaries
    .filter((summary) => summary.remaining > 0)
    .map((summary) => `${summary.name} ${summary.remaining}件`);
  if (parts.length === 0) return "未処理はありません";
  return `未処理：${parts.join(" / ")}`;
}
