import type { EpisodeFile } from "../models/types";

/**
 * 話の並べ方（走査の結果の順）。
 *
 * **`scanner.ts` から出した**（2026-10-16、MCP の読む口 `novel.read`）。
 * あちらは `vscode` を import しているので、外から呼ぶ束（MCP）が同じ並びを
 * 使えなかった。写しを作ると、片方だけ直ったときに年表や再開の1枚の
 * 並びが製品と食い違うので、並べ方そのものをここへ置いて両方から使う。
 */

/** 話数順に並べる。話数不明のものは末尾へ */
export function compareEpisodes(
  a: Pick<EpisodeFile, "kind" | "date" | "dateSeq" | "fileName" | "chapterStart">,
  b: Pick<EpisodeFile, "kind" | "date" | "dateSeq" | "fileName" | "chapterStart">
): number {
  const kindOrder: Record<string, number> = {
    プロローグ: 0,
    本編: 1,
    幕間: 1,
    エピローグ: 2,
    不明: 3,
  };
  const ka = kindOrder[a.kind] ?? 3;
  const kb = kindOrder[b.kind] ?? 3;
  if (ka !== kb) return ka - kb;

  // 日付で名付けられたファイルは、日付 → その日の中の並び で揃える。
  // **文字列の比較では足りない。** 「2026-08-16_10」は「_2」より
  // 前に来てしまう（辞書順では 1 < 2）
  if (a.date && b.date) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const sa = a.dateSeq ?? 0;
    const sb = b.dateSeq ?? 0;
    if (sa !== sb) return sa - sb;
    return a.fileName.localeCompare(b.fileName, "ja");
  }
  // 日付のものと話数のものが混じる作品では、日付を後ろへ置く。
  // 話数で書いていた作品に日付の下書きを足した場合、間へ割り込ませない
  if (a.date && !b.date) return 1;
  if (!a.date && b.date) return -1;

  const na = a.chapterStart;
  const nb = b.chapterStart;
  if (na === null && nb === null) {
    return a.fileName.localeCompare(b.fileName, "ja");
  }
  if (na === null) return 1;
  if (nb === null) return -1;
  if (na !== nb) return na - nb;
  return a.fileName.localeCompare(b.fileName, "ja");
}
