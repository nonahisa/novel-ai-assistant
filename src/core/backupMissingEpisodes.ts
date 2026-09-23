import { parseCollectedFile } from "./collectedFile";
import { planSplit } from "./splitCollected";
import { decodeBytes } from "./textDecode";
import type { WorkZipInspection } from "./workZip";

/**
 * バックアップにあって手元に無い話を、新しい話のファイルとして足す材料
 * （作者の裁定、2026-09-23：「確認画面に話の題を並べ、押したら新しい話の
 * ファイルとして足す。既存の話には触らない」。設計書6.99.7）。
 *
 * ## 中身は、既にある道と同じ形で作る（写しを作らない）
 *
 * - **話ごとのファイル**（カクヨム）：バックアップの中のそのファイルを
 *   **同じ名前で**置く。6.99 の新規取り込み（`importWorkFromZip`）が本文
 *   フォルダーへ置くのと同じで、次にバックアップを落としたときも同じ名前で
 *   照らせる（`backupMerge.ts` の `findLocal`）
 * - **合本の中の話**（なろう）：「合本を話ごとに分ける」（`splitCollected.ts`）
 *   と同じ切り方で、**区切り行から次の区切り行の手前まで**をそのまま使う。
 *   区切り行（「エピソードN開始」）が残るので、次にバックアップを落としたときも
 *   番号で照らせる。前書き・後書き・リアクションも落とさない
 *
 * ファイルの名前は、手元の話の名前の流儀に合わせて呼ぶ側が決める
 * （`defaultFileName` は流儀が読めないときの既定）。書き込みも呼ぶ側
 * （`mode: "create"` だけ。既存のファイルは上書きしない）。
 *
 * VS Code API には依存しない。
 */

/** 手元に見当たらなかったバックアップの話（`backupMerge.ts` の計画が持つ） */
export interface MissingBackupEpisode {
  /** 並び順（合本は区切り行の番号、話ごとのファイルはファイル名順の何番目か） */
  readonly order: number;
  /** 作者に見せる見出し（「32話　再会」） */
  readonly label: string;
  /** この話の直前の章の見出し（【第N章】の値）。無ければ null */
  readonly part: string | null;
  /** 話ごとのファイルなら、バックアップの中の名前。合本の話は null */
  readonly fileName: string | null;
}

/** 足す1話ぶん */
export interface MissingEpisodeFile {
  readonly order: number;
  readonly label: string;
  readonly part: string | null;
  /**
   * 話の番号（題から読めた話数、読めなければ並び順）。名前を手元の流儀で
   * 作るときに使う
   */
  readonly number: number;
  /**
   * 手元の流儀が読めないときの名前（本文フォルダーからの相対。`/` 区切り）。
   * 話ごとのファイルはバックアップの中の名前で、**これは変えない**
   * （次のバックアップと名前で照らすため）
   */
  readonly defaultFileName: string;
  /** 名前を手元の流儀へ変えてよいか（合本から切り出した話だけ） */
  readonly renamable: boolean;
  /**
   * 書く中身。合本から切り出した話は文字列（改行はLF。文字コードは呼ぶ側が
   * 手元の原稿に合わせる）、話ごとのファイルはバックアップのバイト列そのもの
   */
  readonly content:
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "bytes"; readonly bytes: Uint8Array };
}

/**
 * 手元に無い話の中身を用意する。**まだ何も書かない。**
 *
 * @returns 用意できた話と、用意できなかった話（理由つき。黙って落とさない）
 */
export function missingEpisodeFiles(
  inspection: WorkZipInspection,
  missing: readonly MissingBackupEpisode[]
): {
  files: MissingEpisodeFile[];
  skipped: { label: string; reason: string }[];
} {
  const files: MissingEpisodeFile[] = [];
  const skipped: { label: string; reason: string }[] = [];
  if (missing.length === 0) return { files, skipped };

  const episodeFiles = inspection.files.filter((file) => !file.isWorkInfo);
  // 合本の話は、合本を「分ける」と同じ切り方で切り出す（中身には触らない）
  const parts = new Map<number, { text: string; chapter: number | null; fileName: string }>();
  for (const file of episodeFiles) {
    const text = decodeBytes(file.bytes).text;
    if (!parseCollectedFile(text)) continue;
    const plan = planSplit(text, { extension: ".txt" });
    if (!plan || !plan.lossless) continue;
    for (const part of plan.parts) {
      if (!parts.has(part.order)) {
        parts.set(part.order, {
          text: part.text,
          chapter: part.chapter,
          fileName: part.fileName,
        });
      }
    }
  }

  for (const episode of missing) {
    if (episode.fileName !== null) {
      const file = episodeFiles.find((entry) => entry.name === episode.fileName);
      if (!file) {
        skipped.push({ label: episode.label, reason: "バックアップの中にファイルが見当たりません" });
        continue;
      }
      files.push({
        order: episode.order,
        label: episode.label,
        part: episode.part,
        number: episode.order,
        defaultFileName: episode.fileName,
        renamable: false,
        content: { kind: "bytes", bytes: file.bytes },
      });
      continue;
    }
    const part = parts.get(episode.order);
    if (!part) {
      skipped.push({
        label: episode.label,
        reason: "合本からこの話だけを切り出せませんでした",
      });
      continue;
    }
    files.push({
      order: episode.order,
      label: episode.label,
      part: episode.part,
      number: part.chapter ?? episode.order,
      defaultFileName: part.fileName,
      renamable: true,
      content: { kind: "text", text: part.text },
    });
  }
  return { files, skipped };
}

/** 確認画面に並べる題の数。多いときは残りを数で言う */
const LISTED_TITLES = 10;

/**
 * 確認画面の一覧（作者の裁定：題を並べる）。
 *
 * **既存の話には触らないことを、必ず言う。**
 */
export function describeMissingEpisodes(
  missing: readonly { readonly label: string }[]
): string[] {
  if (missing.length === 0) return [];
  const listed = missing.slice(0, LISTED_TITLES).map((episode) => `　・${episode.label}`);
  const rest = missing.length - LISTED_TITLES;
  return [
    `・手元に無い話：${missing.length}話。新しい話のファイルとして足します（既存の話には触りません）`,
    ...listed,
    ...(rest > 0 ? [`　ほか${rest}話`] : []),
  ];
}
