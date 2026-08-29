import { parseEpisodeMetadata } from "./metadataParser";
import { toSiteNotation, type RubyStyle } from "./ruby";
import { stripMemoLines } from "./sceneMemo";
import { sanitizeFileName } from "./episodeParser";

/**
 * 話のサブタイトルと本文を取り出して、投稿に使える形で渡す（設計書6.2.3）。
 *
 * **投稿するときの手作業を減らす。** 投稿欄はサブタイトルと本文が別々の
 * 入力になっている。ファイルを開いて、ヘッダーを避けて本文だけを選んで、
 * ルビを書き換えて……を毎話やるのは、書く時間を削る。
 *
 * VS Code APIに依存しない。
 */

export interface EpisodeParts {
  /** サブタイトル。ファイルの中の【タイトル】が優先、無ければファイル名から */
  subtitle: string | null;
  /** 本文だけ。ヘッダー・前書き・後書き・リアクションは含まない */
  body: string;
}

/**
 * ファイルの中身から、サブタイトルと本文を取り出す。
 *
 * **サブタイトルはファイルの中を優先する。** ファイル名は作者が自由に
 * 変えられるが、中の【タイトル】は投稿したときの題そのものである。
 *
 * @param fileNameSubtitle ファイル名から読み取ったサブタイトル（`EpisodeFile.subtitle`）
 */
export function extractEpisodeParts(
  rawText: string,
  fileNameSubtitle: string | null
): EpisodeParts {
  const meta = parseEpisodeMetadata(rawText);
  return {
    subtitle: meta.title ?? fileNameSubtitle,
    // ヘッダーが無ければ全体が本文である
    body: meta.hasMetadata ? meta.body : rawText,
  };
}

/**
 * 本文を、投稿サイトへ貼れる形にする。
 *
 * いまのところ変換するのは**ルビだけ**。`{漢字|かんじ}` を
 * `｜漢字《かんじ》` などへ直す（6.12.1）。
 *
 * **前後の空行を落とす。** 投稿欄の先頭に空行が入ると、
 * サイトによっては1行目が空いた状態で公開される。
 *
 * **シーンメモは必ず落とす**（設計書6.40.2）。ここを抜かすと、
 * 作者の付箋がそのまま公開される。
 */
export function bodyForPosting(body: string, style: RubyStyle["id"]): string {
  return toSiteNotation(stripMemoLines(body), style)
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * サブタイトルを含んだファイル名を組み立てる。
 *
 * **話数の部分は変えない。** そこは並び順を決めており、
 * 変えると作品の順序が崩れる。**後ろにサブタイトルを足すだけ**にする。
 *
 * 既にサブタイトルが付いているなら、そのまま返す（付け直さない）。
 *
 * @returns 新しいファイル名。変える必要が無ければ undefined
 */
export function nameWithSubtitle(
  fileName: string,
  currentSubtitle: string | null,
  subtitle: string | null
): string | undefined {
  const trimmed = subtitle?.trim();
  if (!trimmed) return undefined;
  // 既に同じものが付いている
  if (currentSubtitle && currentSubtitle.trim() === trimmed) return undefined;

  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";

  // **既に付いているサブタイトルを剥がしてから足す。**
  // 重ねると `episode_0001_転生_転生.txt` になる
  const head = currentSubtitle
    ? stripSuffix(base, currentSubtitle)
    : base;

  const safe = sanitizeFileName(trimmed);
  if (!safe) return undefined;
  const next = `${head}_${safe}${extension}`;
  return next === fileName ? undefined : next;
}

/** 末尾に付いているサブタイトルと、その手前の区切りを落とす */
function stripSuffix(base: string, subtitle: string): string {
  const safe = sanitizeFileName(subtitle);
  if (safe && base.endsWith(safe)) {
    return base.slice(0, base.length - safe.length).replace(/[\s_.．・-]+$/u, "");
  }
  return base;
}
