import { isBlankPlotSection, type PlotSections } from "./plotDoc";
import type { SynopsisDoc } from "./synopsisDoc";
import type { WorkInfo } from "./workInfoParse";

/**
 * 作品情報（`about.txt`）を、製品の置き場の下書きに直す（設計書6.99）。
 *
 * **作者がすでに書いたものを上書きしない**（実装ルール2）。ここは
 * 「どこへ、何を、置いてよいか」だけを決める——書くのは
 * `features/importWorkFromZip.ts` である。判断を `vscode` の要らない
 * ところに置いたのは、**空の欄にだけ入れる**という一番間違えやすい
 * 決まりを、そのまま試験にかけられるようにするためである。
 *
 * VS Code APIに依存しない。
 */

/** プロットへ置く下書き */
export interface PlotDraft {
  /** `writePlotSections` へそのまま渡せる形。空なら何も置かない */
  readonly updates: Partial<PlotSections>;
  /** 置いたものの呼び名（作者への報告に使う） */
  readonly labels: readonly string[];
}

/**
 * ジャンルとタグを、プロットの空いている節へ。
 *
 * **タグの行き先だけは、ぴたりと合う欄が製品に無い。** 更新告知の
 * ハッシュタグ（`.aiwriter/config.json` の `announce`）は形が近いが、
 * そこへ入れると**作者に一度も見せないままX用の投稿へ載る**
 * （`ensureAnnounceConfig` は設定済みなら訊かない）。プロットの
 * 「モチーフ」なら作者の目に入り、勝手に使われることもない。
 *
 * @param current いまのプロットの節（空のファイルなら `emptyPlotSections()`）
 */
export function plotDraftFromWorkInfo(
  info: WorkInfo,
  current: PlotSections
): PlotDraft {
  const candidates: Array<{
    key: keyof PlotSections;
    label: string;
    body: string;
  }> = [];

  if (info.genre) {
    candidates.push({
      key: "genre",
      label: "ジャンル",
      body: `- ${info.genre}`,
    });
  }
  if (info.tags.length > 0) {
    candidates.push({
      key: "motif",
      label: "モチーフ",
      body: info.tags.map((tag) => `- ${tag}`).join("\n"),
    });
  }

  const updates: Partial<PlotSections> = {};
  const labels: string[] = [];
  for (const candidate of candidates) {
    // **書かれている節には触れない。** 雛形が置いた案内と箇条書きの
    // 空欄は「まだ書かれていない」と読む（`isBlankPlotSection`）
    if (!isBlankPlotSection(current[candidate.key])) continue;
    updates[candidate.key] = candidate.body;
    labels.push(candidate.label);
  }

  return { updates, labels };
}

/** 紹介文の文書へ置く下書き */
export interface SynopsisDraft {
  readonly doc: SynopsisDoc;
  readonly labels: readonly string[];
}

/**
 * キャッチコピーと紹介文を、`設定/synopsis.md` の形へ。
 *
 * 行き先は `features/generateBlurb.ts` と同じ（AIが作った案の採用先）。
 * **すでに文書があるなら、何も返さない**——`existing` を渡された時点で
 * 作者の文章がそこにあるので、下書きで押し流してはいけない。
 *
 * @param existing いまの `synopsis.md` の中身。まだ無ければ null
 */
export function synopsisDraftFromWorkInfo(
  info: WorkInfo,
  existing: SynopsisDoc | null
): SynopsisDraft | null {
  if (existing !== null) return null;
  if (!info.catchphrase && !info.blurb) return null;

  const labels: string[] = [];
  if (info.catchphrase) labels.push("キャッチコピー");
  if (info.blurb) labels.push("紹介文");

  return {
    doc: { catchphrase: info.catchphrase, blurb: info.blurb ?? "" },
    labels,
  };
}
