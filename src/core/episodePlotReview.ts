import type { PraiseItem } from "./praise";

/**
 * 単話プロットの検査（P-27）の講評の紙（プロンプト設計書1.9）。
 *
 * 作者の方針（2026-09-24）：「作品が高い水準でバランスをとっているとき、
 * 無理に助言を言わなくてもいいです。あと、ほめることができる場所は、
 * 省略せずきちんとほめてください。」
 *
 * ## なぜ提案パネルとは別の紙にするのか
 *
 * 指摘は提案パネルに並ぶ（行へ飛べる・見送れる）。だがパネルは**指摘を
 * 処理するための一覧**で、良いところを同じ一覧へ混ぜると、ほめ言葉にまで
 * 「見送る」の口が付き、しかも指摘の記録（設計書6.96）として三日残る。
 * そこで良いところは、冒頭診断（P-24）と同じく**読み物の紙**として開く。
 * 紙の中では良いところを先に置き、直すべき所の有無を明記する。
 *
 * **画面（通知）に出す一言はここに置かない**（`episodePlotDoc.ts` の
 * `episodePlotReviewTail`）。このファイルは Markdown の記号を許す一覧に
 * 載っているので、同じファイルに置くと通知の文言だけが見張りから外れる。
 *
 * VS Code API に依存しない（単体テストの対象）。
 */

/** 生成文書の種類（ファイル名の前置き。設計書6.17.7） */
export const EPISODE_PLOT_REVIEW_KIND = "単話プロットの講評";

export interface EpisodePlotReviewInput {
  /** 「第3話」 */
  chapterLabel: string;
  /** 照合済みの良いところ（`quote` は実在の行そのもの） */
  strengths: readonly PraiseItem[];
  /** 箇条書きに無い行をほめていたので落とした数 */
  strengthsDropped: number;
  /** 提案パネルへ並べた指摘の数 */
  findingCount: number;
}

export function renderEpisodePlotReview(input: EpisodePlotReviewInput): string {
  const lines = [
    `# ${EPISODE_PLOT_REVIEW_KIND}：${input.chapterLabel}`,
    "",
    // **良いところを先に**（1.9の4）。折りたたまず、件数で切らない
    "## 効いている展開",
    "",
  ];
  if (input.strengths.length === 0) {
    lines.push("箇条書きから引いて示せる、効いている展開は返りませんでした。");
  } else {
    for (const item of input.strengths) {
      lines.push(`- 「${item.quote}」——${item.why}`);
    }
  }
  if (input.strengthsDropped > 0) {
    lines.push(
      "",
      `箇条書きに無い行をほめていた ${input.strengthsDropped}件は外しました。`
    );
  }

  lines.push("", "## 直すべき所", "");
  lines.push(
    input.findingCount === 0
      ? "直すべき所は見当たりません。"
      : `気になるところが ${input.findingCount}件あります。提案パネルに並べました。`
  );

  lines.push(
    "",
    "---",
    "",
    "プロットは書き換えていません。判断するのは作者です。",
    ""
  );
  return lines.join("\n");
}
