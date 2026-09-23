import { formatCount } from "./charCount";
import { formatDayTime } from "./timestampedFileName";

/**
 * 取り込みの記録を組む（設計書6.99）。
 *
 * ## なぜ紙にするのか
 *
 * 作者の実機報告（2026-09-19）：アルファポリスの Shift_JIS 版（188話）を
 * 取り込んだとき、完了のお知らせが**280字あまりの1行**になった。重複した
 * 話番号・欠番・文字コードの助言・読者の反応が、ぜんぶ繋がって出たためである。
 * **VS Code の通知は行を分けられない**ので、長い説明はそこに置けない。
 *
 * だからといって通知から落とすと、**閉じた瞬間に二度と見られなくなる。**
 * 取り込みは一度きりの操作で、やり直しもきかない。そこで、詳しい話は
 * `.aiwriter/generated/` の読み物として書き出し、通知にはその見出しと
 * 「開く」ボタンだけを出す（`features/importWorkFromZip.ts`）。
 *
 * ## 何も問題が無くても書く
 *
 * 何話入ったか・どのファイルから入れたかは、あとから「この作品はどこから
 * 来たのか」を辿るときに効く。**問題があったときだけ書く形にすると、
 * 「記録が無い」が2つの意味（問題が無かった／書けなかった）を持ってしまう。**
 *
 * VS Code API には依存しない（文面だけを組む）。
 */

/** 記録の種類名。ファイル名の前置き・見出し・通知のボタンに使う */
export const IMPORT_RECORD_KIND = "取り込みの記録";

export interface ImportRecordInput {
  /** 作品名（登録した題） */
  readonly title: string;
  /** 取り込んだ元のファイル名（道ではなく名前だけ） */
  readonly sourceName: string;
  /** 取り込んだ話数。**ファイルの数ではない**（合本は1ファイルに全話） */
  readonly episodeCount: number;
  /** 合本だったか */
  readonly collected: boolean;
  readonly totalChars: number;
  /** 作品情報から下書きとして置いたものの名前 */
  readonly placed: readonly string[];
  /** 原稿ではないので入れなかったファイルの名前 */
  readonly skipped: readonly string[];
  /** 話番号の点検の文面。**1行ずつが別の話題**なので、箇条書きに分ける */
  readonly episodeNotes: readonly string[];
  /** 文字コードの助言。**数行で1つの話**なので、繋げて1件として出す */
  readonly encodingNotes: readonly string[];
  /** 読者の反応について何をしたか。出どころが分からなければ無い */
  readonly noted?: string;
  /** 章立てをどうしたか（残課題 B7）。章の見出しが無ければ無い */
  readonly chapters?: string;
}

/** 一覧に並べるファイル名の上限。超えたら「ほか」 */
const LISTED_SKIPPED = 10;

export function buildImportRecord(
  input: ImportRecordInput,
  at: Date = new Date()
): string {
  const lines = [
    `# ${IMPORT_RECORD_KIND}`,
    "",
    `- 取り込んだ日時：${formatDayTime(at)}`,
    `- 取り込んだ元：${input.sourceName}`,
    `- 作品名：${input.title}`,
    `- 取り込んだ話：${input.episodeCount}話` +
      (input.collected ? "（1つのファイルに全話が入っていました）" : ""),
    `- 合計の文字数：${formatCount(input.totalChars)}字`,
    "",
  ];

  const concerns = [
    ...input.episodeNotes,
    ...(input.encodingNotes.length > 0 ? [input.encodingNotes.join("")] : []),
  ];
  if (concerns.length > 0) {
    // **いちばん上に置く。** 置いたものより先に目に入る必要がある
    lines.push("## 気をつけたいこと", "");
    for (const concern of concerns) lines.push(`- ${concern}`);
    lines.push("");
  }

  lines.push("## 取り込んだもの", "");
  lines.push(
    input.placed.length > 0
      ? `- 作品情報から ${input.placed.join(
          "・"
        )} を下書きとして置きました（設定フォルダーにあります）。`
      : "- 作品情報からの下書きはありません。"
  );
  if (input.chapters) lines.push(`- ${input.chapters}`);
  if (input.skipped.length > 0) {
    lines.push(
      `- 原稿ではないファイル${input.skipped.length}件は入れていません` +
        `（${input.skipped.slice(0, LISTED_SKIPPED).join("・")}${
          input.skipped.length > LISTED_SKIPPED ? " ほか" : ""
        }）。`
    );
  }
  lines.push("");

  if (input.noted) lines.push("## 読者の反応", "", input.noted, "");

  return lines.join("\n");
}
