/**
 * 検知の完了通知で「指摘は何件か」をどう数えるか（設計書6.8）。
 *
 * **通知とパネルの見出しが食い違っていた。** 実機で通知は
 * 「指摘 1件 / 除外 1件」なのに、提案パネルの見出しは「誤字脱字 0件」
 * だった（2026-09-06、作者の報告）。前に適用した指摘・解消済みにした指摘は、
 * パネルでは「残り」に数えない（`proposalBuckets.ts` の `isRemaining`）のに、
 * 通知は検知が返した件数をそのまま言っていたためである。
 * 作者には「1件見つかったのに一覧が空」に見える。
 *
 * **数え方はパネルに合わせる。** 「指摘」はパネルに残る件数だけを言い、
 * 落としたぶんは黙らずに別立てで言う——黙って消すと、こんどは
 * 「返ってきたはずのものが消えた」ことに気づけなくなる。
 *
 * VS Code APIに依存しない。
 */

/** 完了通知に出す件数の内訳 */
export interface CheckRunCounts {
  /**
   * 提案パネルに残った件数（まだ作者の手が要るもの）。
   * **これが「指摘 N件」の N である。**
   */
  shown: number;
  /**
   * 今回の結果のうち、前に適用済み・解消済みだったため一覧に出ないもの。
   *
   * 誤字脱字では、本文へ当てる前に落とすぶん（`appliedFixKeys`）と、
   * パネルで既に判断が付いていたぶんの両方がここへ入る。
   */
  alreadyHandled: number;
  /**
   * 本文と合わない・行を元のファイルへ戻せないなどで捨てたもの。
   * 理由の内訳は操作ログにある（通知へ並べても作者の判断材料にならない）。
   */
  rejected: number;
}

/**
 * 完了通知の前半（件数のくだり）を組み立てる。
 *
 * 返すのは `notifyRunCompletion` の `parts` へそのまま渡せる配列。
 * 失敗チャンクなど、機能ごとに違うものは呼び出し側が足す。
 */
export function describeCheckRunCounts(counts: CheckRunCounts): string[] {
  const parts = [
    counts.alreadyHandled > 0
      ? `指摘 ${counts.shown}件（前回適用・解消済み ${counts.alreadyHandled}件）`
      : `指摘 ${counts.shown}件`,
  ];
  if (counts.rejected > 0) {
    // **理由は通知へ出さない。** 種別の名前が並んでも作者は決められない。
    // 追いたい人のために、どこを見ればよいかだけ言う
    parts.push(`除外 ${counts.rejected}件（理由は操作ログ）`);
  }
  return parts;
}

/**
 * 落とした理由を「多い順に、種別ごとの件数」で1行にまとめる（操作ログ用）。
 *
 * **総数だけでは、消しすぎなのか本当に無いのかが分からない。**
 * 誤字脱字は実データで64件中62件が素通りしたことがあり、「何件除外した」
 * だけを見ていても、検証のせいなのかAIのせいなのか切り分けられない。
 *
 * @param labelOf 種別を作者が読める言葉にする。省くと種別の名前をそのまま出す
 */
export function summarizeReasons(
  reasons: readonly string[],
  labelOf: (reason: string) => string = (reason) => reason
): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${labelOf(reason)} ${count}件`)
    .join(" / ");
}
