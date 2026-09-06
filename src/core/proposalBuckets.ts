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
 * 「同じ指摘かどうか」を内容で見分けるための項目（設計書6.8）。
 *
 * **印（id）では見分けられない。** 誤字脱字の印は
 * `チャンクのハッシュ:行:並び順` で作られており、同じ誤字でも本文の
 * 並び順が揺れれば変わる。中身が同じかどうかは中身で見る。
 *
 * 矛盾や設定資料の更新のように、置き換える文字列を持たないものもある。
 * **持っていないものには鍵を作らない**（`undefined` を返す）。
 */
export interface ProposalContent {
  filePath?: string;
  line?: number;
  target?: string;
  suggestion?: string;
}

/**
 * 同じ指摘を見分ける鍵。ファイル・行・置き換える文字列・直し方が
 * すべて同じなら、同じ指摘とみなす。
 *
 * @returns 鍵を作れないもの（矛盾・設定資料の更新）は `undefined`
 */
export function contentKeyOf(
  item: ProposalLike & ProposalContent
): string | undefined {
  if (!item.filePath || item.target === undefined) return undefined;
  // **区切り文字でつながない。** `target` には本文がそのまま入るので、
  // どんな区切りを選んでも中身に現れうる（「A|B」と「A」＋「B」が同じ鍵に
  // なる）。JSONにすれば境目が中身と混ざらない
  return JSON.stringify([
    item.filePath,
    item.line ?? null,
    item.target,
    item.suggestion ?? "",
  ]);
}

/**
 * 同じ分類の中へ、新しい結果を足す。
 *
 * ## 解消済みは、同じ指摘がまた届いたら未処理へ戻す
 *
 * 再チェックで本文から引用が消えていると `resolved`（作者が書き直して
 * 片付いた）にする。ところが作者が本文を元へ戻して検知し直すと、**同じ
 * 指摘がまた届くのに解消済みのままで、一覧に出なかった**（2026-09-06、
 * 作者の裁定）。誤字が見えないまま残るので、届いたこと自体を
 * 「本文が元へ戻った証拠」と読んで未処理へ戻す。
 *
 * **`applied`・`dismissed` は戻さない。** 適用も「今後直さない」も
 * 作者が決めたことで、本文がどう動いても覆す筋合いがない。
 *
 * @param existing いま持っているもの（作者の判断が入っている）
 * @param incoming 今回の検知結果
 */
export function mergeProposals<T extends ProposalLike & ProposalContent>(
  existing: readonly T[],
  incoming: readonly T[]
): T[] {
  const merged = [...existing];
  const positionById = new Map(merged.map((item, index) => [item.id, index]));
  // 解消済みだけを鍵で引けるようにする。作者が決めたもの（適用済み・
  // 見送り済み）は戻さないので、はじめから入れない
  const resolvedByKey = new Map<string, number>();
  merged.forEach((item, index) => {
    if (item.status !== "resolved") return;
    const key = contentKeyOf(item);
    if (key === undefined || resolvedByKey.has(key)) return;
    resolvedByKey.set(key, index);
  });

  /** 戻した先の印も入れ替える。古い印のままだと適用の当て先を見失う */
  const revive = (at: number, item: T): void => {
    merged[at] = item;
    positionById.set(item.id, at);
  };

  for (const item of incoming) {
    const at = positionById.get(item.id);
    const key = contentKeyOf(item);
    if (at !== undefined) {
      // **作者が決めたものは触らない。** 適用済みを `pending` へ戻すと、
      // 同じ直しをもう一度当てにいくことになる
      if (merged[at].status === "pending") {
        merged[at] = item;
      } else if (merged[at].status === "resolved" && key !== undefined) {
        // **鍵を作れるものだけ戻す。** 矛盾のように置き換える文字列を
        // 持たないものは、届いたことが「本文が元へ戻った」証拠にならない
        revive(at, item);
        resolvedByKey.delete(key);
      }
      continue;
    }

    // 印が変わっていても、同じ中身の解消済みがあれば、それが戻ってきたと読む。
    // **1件につき1件だけ戻す**——届いた1件が2件へ増えないようにする
    const resolvedAt = key === undefined ? undefined : resolvedByKey.get(key);
    if (resolvedAt !== undefined && key !== undefined) {
      revive(resolvedAt, item);
      resolvedByKey.delete(key);
      continue;
    }

    positionById.set(item.id, merged.length);
    merged.push(item);
  }
  return merged;
}

/** 今回届いた結果が、一覧でどう扱われたか */
export interface IncomingCount {
  /** 一覧に残った（まだ作者の手が要る）件数 */
  remaining: number;
  /** 既に適用・見送り・解消済みで、一覧に出ない件数 */
  handled: number;
}

/**
 * 今回届いた結果のうち、何件が一覧に残ったかを数える（設計書6.8）。
 *
 * **完了通知の「指摘 N件」は、ここが返す `remaining` を言う。**
 * 検知が返した件数をそのまま言うと、前に適用済み・解消済みだったものまで
 * 数えてしまい、パネルの見出し（`remainingIn`）と食い違う。実機で
 * 「指摘 1件」と通知が出たのに一覧が空だった（2026-09-06、作者の報告）。
 *
 * **前の回の残りは数えない。** 見たいのは「今回の結果がどうなったか」で
 * あって、パネル全体の残数ではない。
 *
 * @param merged `mergeProposals` を通したあとの、その分類の全件
 * @param incoming 今回の検知が返したもの
 */
export function countIncoming(
  merged: readonly ProposalLike[],
  incoming: readonly ProposalLike[]
): IncomingCount {
  const statusById = new Map(merged.map((item) => [item.id, item.status]));
  const seen = new Set<string>();
  let remaining = 0;
  let handled = 0;
  for (const item of incoming) {
    // 同じ印が二度届いても、一覧には1件しか並ばない
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const status = statusById.get(item.id);
    // 見つからないのは足し込む前の呼び方をされたとき。**残りとして数える**
    // （数え落として「0件」と言うより、多めに言うほうが害が小さい）
    if (status === undefined || isRemaining({ id: item.id, status })) {
      remaining++;
    } else {
      handled++;
    }
  }
  return { remaining, handled };
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
 * 作品の切り替え口に並べるもの（設計書6.11.3）。
 *
 * **検知は2つの作品で同時に走らせられる。** 後から届いた結果で画面を
 * 奪わない代わりに、どの作品に何件あるかを出して、選んで移れるようにする。
 */
export interface WorkSummary {
  id: string;
  title: string;
  /** その作品全体で、まだ手を付けていない件数（分類をまたいで合計する） */
  remaining: number;
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
