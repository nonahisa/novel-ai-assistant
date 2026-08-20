import { parseEpisodeTitle } from "./collectedFile";
import { formatChapterNumber, sanitizeFileName } from "./episodeParser";

/**
 * 1ファイルに全話が入ったファイルを、話ごとのファイルへ分ける（設計書6.2.2）。
 *
 * ## `parseCollectedFile` とは別に作る
 *
 * あちらは**本文だけ**を返す。前書き・後書き・リアクションを落とすのは、
 * AIへ渡すときに作者の書いた物語だけを送るためで、それは正しい。
 *
 * **しかし分割では、落としてはいけない。** 元のファイルを置き換える操作なので、
 * **後書きが消えれば作者の文章が失われる。** ここでは区切り行で切るだけにして、
 * **中身には一切触らない。**
 *
 * ## 書き込む前に検算する
 *
 * 切った断片を繋ぎ直したものが、元と1文字も違わないことを確かめる。
 * **合わなければ分割しない。** 原稿を相手にする以上、
 * 「たぶん大丈夫」で書き込んではいけない。
 *
 * VS Code APIに依存しない。
 */

/** 区切り行。`collectedFile.ts` と同じ形 */
const SEPARATOR = /^-{3,}\s*エピソード\s*(\d+)\s*開始\s*-{3,}$/;

export interface SplitPart {
  /** ファイル内での並び順（区切り行の番号） */
  order: number;
  /** タイトルから読み取った話数。読めなければ null */
  chapter: number | null;
  /** 話数を除いたサブタイトル */
  title: string | null;
  /**
   * その話の全文。**区切り行を含む。**
   *
   * 区切り行まで残すのは、分けたあとで元へ戻せるようにするためである。
   */
  text: string;
  /** 書き出すファイル名（拡張子込み） */
  fileName: string;
}

export interface SplitPlan {
  /** 最初の区切り行より前にあった部分。作品の紹介などが入る */
  preamble: string;
  parts: SplitPart[];
  /**
   * 繋ぎ直すと元に戻るか。
   *
   * **false なら分割しない。** 1文字でも合わなければ、
   * どこかを取りこぼしている。
   */
  lossless: boolean;
}

export interface SplitOptions {
  /** 書き出す拡張子（元のファイルに合わせる） */
  extension: string;
  /** 話数の桁数。既存のファイルに合わせる。既定4桁 */
  digits?: number;
  /** ファイル名の頭。既定 `episode_` */
  prefix?: string;
  /** 既にあるファイル名（重複を避けるために見る） */
  existing?: readonly string[];
}

/**
 * 分け方を組み立てる。**まだ何も書かない。**
 *
 * 区切り行が無ければ `null`（合本ではない）。
 */
export function planSplit(
  rawText: string,
  options: SplitOptions
): SplitPlan | null {
  // **改行コードを変えない。** 元のまま切って、元のまま書き戻す
  const eol = rawText.includes("\r\n") ? "\r\n" : "\n";
  const lines = rawText.split(/\r\n|\n/);

  const starts: Array<{ index: number; order: number }> = [];
  lines.forEach((line, index) => {
    const matched = SEPARATOR.exec(line.trim());
    if (matched) starts.push({ index, order: parseInt(matched[1], 10) });
  });
  if (starts.length === 0) return null;

  const preamble = lines.slice(0, starts[0].index).join(eol);

  const digits = options.digits ?? 4;
  const prefix = options.prefix ?? "episode_";
  const used = new Set((options.existing ?? []).map((name) => name.toLowerCase()));

  const parts: SplitPart[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : lines.length;
    const text = lines.slice(from, to).join(eol);

    const parsed = parseEpisodeTitle(titleIn(lines.slice(from, to)));
    // **話数が読めなければ並び順を使う。** ファイル名は付けねばならない。
    // 読めなかったことは呼び出し側が作者へ伝える
    const number = parsed.chapter ?? starts[i].order;
    const fileName = uniqueName(
      buildName(prefix, number, digits, parsed.title, options.extension),
      used
    );
    used.add(fileName.toLowerCase());

    parts.push({
      order: starts[i].order,
      chapter: parsed.chapter,
      title: parsed.title,
      text,
      fileName,
    });
  }

  return {
    preamble,
    parts,
    lossless: rebuild(preamble, parts, eol) === rawText,
  };
}

/**
 * 断片を繋ぎ直す。**検算のためだけに使う。**
 *
 * 元と1文字も違わないことを確かめられなければ、分割してはいけない。
 */
export function rebuild(
  preamble: string,
  parts: readonly SplitPart[],
  eol: string
): string {
  const pieces = parts.map((part) => part.text);
  return preamble ? [preamble, ...pieces].join(eol) : pieces.join(eol);
}

/** 話数が読めなかったものの数。作者へ伝えるのに使う */
export function unnumberedCount(plan: SplitPlan): number {
  return plan.parts.filter((part) => part.chapter === null).length;
}

/** 【エピソードタイトル】の次の行を拾う */
function titleIn(lines: readonly string[]): string | null {
  const at = lines.findIndex((line) =>
    /^【\s*エピソードタイトル\s*】/.test(line.trim())
  );
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("【")) break;
    if (line) return line;
  }
  return null;
}

function buildName(
  prefix: string,
  number: number,
  digits: number,
  title: string | null,
  extension: string
): string {
  const head = `${prefix}${formatChapterNumber(number, digits)}`;
  // **サブタイトルは付けない。** 記号や長さでファイル名が壊れるより、
  // 番号だけのほうが確実である（作者はあとから自由に変えられる）
  const safe = title ? sanitizeFileName(title) : "";
  const body = safe ? `${head}_${safe}` : head;
  return `${body}${extension}`;
}

/** 同じ名前があれば連番を足す。**既にある原稿を上書きしない** */
function uniqueName(name: string, used: ReadonlySet<string>): string {
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}${extension}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}_${Date.now()}${extension}`;
}
