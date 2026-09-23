import {
  POSTING_SITES,
  readerStatsForSite,
  type PostingLedger,
} from "../models/posting";
import { formatReaderStatsMetrics } from "./postingSiteRecords";

/**
 * ターゲットシートの「書けたものの実績」（設計書6.108.6）。
 *
 * 0.82.2 まで在った単独の3つの輪の紙（6.101）の「すでに書けたもの」と
 * 「届いている反応」を、2026-09-23 の統合で紙ごと取り除いたため、
 * どこにも出なくなっていた。作者の裁定（2026-09-23）で**シートへ移した**。
 * 数え方・言い方は前の紙と同じにしてある（同じ作品で、前と違う数字を
 * 出さないため）。
 *
 * 材料を集めるのは `features/targetSheetWritten.ts` の仕事で、ここは
 * **渡されたものを行に並べるだけ**である。行にMarkdownの記号は混ぜない
 * ——見出しと箇条書きの印は紙の側（`targetSheetDoc.ts`）で付ける。
 *
 * ## 「書けるもの」とは書かない（作者の裁定、2026-09-19）
 *
 * 実績から「あなたに書けるのはここまで」と読まれうる。**実績の記述に
 * 留め、限界の宣告にしない。** 節の頭で「ここに無いものが書けない、
 * という意味ではない」と断るのも前の紙と同じである。
 *
 * ## 材料の無い行は出さない
 *
 * 推測で埋めない。0話・0字・空の表を並べると、でっち上げの数字に見える。
 * 1行も無いときは「まだ記録がありません」と断る（紙の側）。
 *
 * VS Code API にも AI にも依存しない。
 */

/** すでに書けたもの（実績から数えられるものだけ） */
export interface TargetSheetWritten {
  /** 書き切った話数（合本は中の話を数える）。**0なら行ごと出さない** */
  episodes?: number;
  /** 合計字数 */
  chars?: number;
  /** 1話の長さの癖。合本は母集団から外したうえで渡す */
  length?: {
    /** ふだんの長さ（中央値） */
    typical: number;
    shortest: number;
    longest: number;
  };
  /** 書いた日数と、いま続いている日数 */
  days?: { active: number; streak: number };
  /** 設定資料の厚み。**0件の種類は呼び出し側で落とす** */
  settings?: readonly { label: string; count: number }[];
  /** `plot.md` の人称。書かれていなければ空 */
  narrativePerson?: string;
  /** 地の文から数えた語り手の一人称。決められなければ空 */
  firstPerson?: string;
  /** 文語体で書かれているとみられるか */
  archaic?: boolean;
}

/** 届いている反応1件（サイトごとの最新） */
export interface TargetSheetReaction {
  /** サイトの呼び名（「小説家になろう」） */
  site: string;
  /** 「PV 1,234／ブックマーク 89」。**呼び名は台帳の定義から作る** */
  metrics: string;
  /** 読み取った日（`YYYY-MM-DD`） */
  readAt: string;
}

/** シートの「書けたものの実績」の材料 */
export interface TargetSheetWrittenRecord {
  readonly facts: TargetSheetWritten;
  /**
   * 届いている反応。**台帳を読めなかったら `undefined`**。
   *
   * 空の配列（記録がまだ無い）と区別する——読めなかったのに
   * 「まだ記録がありません」と書くと、控えた数字が消えたように見える。
   */
  readonly reactions?: readonly TargetSheetReaction[];
}

/**
 * 投稿の台帳から、**サイトごとに最新の1件**を選ぶ（設計書6.79.7）。
 *
 * **見るのは `scope: "work"`（作品全体）の行だけである。** 話ごとの数字を
 * 混ぜると、「この作品はどれくらい読まれているか」に1話ぶんの数字が出て、
 * 作品の勢いを読み違える。並びは `readerStatsForSite` が新しい順に揃えて
 * いるので、**最初に見つかった作品全体の行**が最新である。
 *
 * **数字の言い方は `formatReaderStatsMetrics` に任せる**——サイトごとの
 * 呼び名（なろうの「評価者数」など）を、ここで言い換えない。
 *
 * **欄が1つも読めなかった行は落とす。** 「（サイト名）：」だけの行を
 * 出しても何も伝わらない。
 */
export function collectReactions(
  ledger: PostingLedger
): TargetSheetReaction[] {
  const reactions: TargetSheetReaction[] = [];
  for (const info of POSTING_SITES) {
    const latest = readerStatsForSite(ledger, info.id).find(
      (record) => record.scope === "work"
    );
    if (!latest) continue;
    const metrics = formatReaderStatsMetrics(latest.metrics);
    if (!metrics) continue;
    reactions.push({
      site: info.label,
      metrics,
      readAt: latest.readAt.slice(0, 10),
    });
  }
  return reactions;
}

/**
 * 実績の行（1行1文）。**材料の無い行は返さない**——全部無ければ空配列で、
 * そのときの断りは紙の側が書く。
 */
export function writtenRows(written: TargetSheetWritten): string[] {
  const rows: string[] = [];

  if (written.episodes !== undefined && written.episodes > 0) {
    const chars =
      written.chars === undefined || written.chars <= 0
        ? ""
        : `、合計${written.chars.toLocaleString("ja-JP")}字`;
    rows.push(
      `書き切ったのは${written.episodes.toLocaleString("ja-JP")}話${chars}。`
    );
  }

  if (written.length) {
    const { typical, shortest, longest } = written.length;
    rows.push(
      `1話の長さは、ふだん${typical.toLocaleString("ja-JP")}字ほど` +
        `（いちばん短い話が${shortest.toLocaleString("ja-JP")}字、` +
        `いちばん長い話が${longest.toLocaleString("ja-JP")}字）。`
    );
  }

  if (written.days && written.days.active > 0) {
    const streak =
      written.days.streak > 0
        ? `いまは${written.days.streak}日続いています。`
        : "";
    rows.push(`書いた日は${written.days.active}日。${streak}`.trim());
  }

  const settings = (written.settings ?? []).filter((entry) => entry.count > 0);
  if (settings.length > 0) {
    rows.push(
      "設定資料は、" +
        settings.map((entry) => `${entry.label}${entry.count}件`).join("・") +
        "。"
    );
  }

  const style = styleRow(written);
  if (style) rows.push(style);

  return rows;
}

/** 届いている反応の行。**読み取った日を必ず添える**（古い数字を今の数字と読ませない） */
export function reactionRows(
  reactions: readonly TargetSheetReaction[]
): string[] {
  return reactions.map(
    (reaction) =>
      `${reaction.site}：${reaction.metrics}（${reaction.readAt} 時点）`
  );
}

/** 人称と文体。**分かっているものだけ**をつなぐ */
function styleRow(written: TargetSheetWritten): string {
  const parts: string[] = [];
  if (written.narrativePerson?.trim()) {
    parts.push(`人称は「${written.narrativePerson.trim()}」`);
  }
  if (written.firstPerson?.trim()) {
    parts.push(`地の文の一人称は「${written.firstPerson.trim()}」`);
  }
  if (written.archaic) parts.push("文語体・旧字旧かなで書かれています");
  return parts.length === 0 ? "" : `${parts.join("、")}。`;
}
