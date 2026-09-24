import { matchBackupToWorks } from "./backupMatch";
import { decodeUriEscapes, isPathInside } from "./pathText";
import { checkBackupEncoding } from "./backupEncoding";
import { docxToMarkdown, type DocxConversion } from "./docxToMarkdown";
import { countEpisodeChars } from "./episodeCharCount";
import { checkEpisodeNumbers } from "./episodeNumberCheck";
import { sanitizeWorkFolderName, type WorkZipInspection } from "./workZip";

/**
 * 相談パネルへ落とされた Word 原稿（.docx）を読み、どの作品の続きかを照らす
 * （作者の裁定、2026-09-23「相談パネルドロップにも対応してください。相談パネルが
 * 既存作の続きでも、わかれば対応できるようにしてください」。設計書6.99.7）。
 *
 * ## 読むのは既存の Word 変換の部品
 *
 * 「Word 原稿の変換」（設計書6.85、`docxToMarkdown`）をそのまま通す——ルビは
 * `{漢字|かんじ}`、傍点は `{{強調}}`、見出しは `#`。**写しを作らない。**
 * 部品は `fflate` と自前の XML 走査だけなので、ブラウザ版でも動く。
 *
 * ## 照らす手掛かり（確かなものだけ）
 *
 * 1. **書き出しが既にある話と同じ** → その話はもう手元にある（新しい話として
 *    足すと重複する）。見出しを除いた本文の頭 `HEAD_LENGTH` 字を、ルビと空白を
 *    そろえてから各話の本文に探す。短すぎる書き出しでは照らさない
 * 2. **作品フォルダーの中から落とされた**（エクスプローラーから落としたときだけ
 *    場所が分かる）→ その作品
 * 3. **題**：見出し・ファイル名を、バックアップと同じ決まり（`backupMatch.ts`）で
 *    作品の題と照らす。部分一致は必ず選ばせる
 *
 * **当たっても決めつけない。** 呼ぶ側が必ず確認画面で見せる。
 *
 * VS Code API には依存しない。
 */

/** 読んだ Word 原稿 */
export interface WordManuscript {
  /** 変換した Markdown（段落が1行。末尾に改行1つ） */
  readonly markdown: string;
  /** 最初の見出し（`#`）の文字。無ければ null */
  readonly heading: string | null;
  /** ファイル名から拡張子とダウンロードの印（`(2)`）を落としたもの */
  readonly baseName: string;
  readonly rubyCount: number;
  readonly emphasisCount: number;
  /** 変換で入らなかったもの（画像・表など）。作者に見せる言葉 */
  readonly skipped: readonly string[];
  /** 本文の純文字数 */
  readonly charCount: number;
}

/**
 * .docx を読む。**読めなければ例外**（呼ぶ側が理由を出す。空の話を作らない）。
 */
export function readWordManuscript(bytes: Uint8Array, fileName: string): WordManuscript {
  const converted: DocxConversion = docxToMarkdown(bytes);
  const headingLine = converted.markdown
    .split("\n")
    .find((line) => /^#{1,6}\s/.test(line));
  return {
    markdown: converted.markdown,
    heading: headingLine ? headingLine.replace(/^#{1,6}\s+/, "").trim() || null : null,
    baseName: wordBaseName(fileName),
    rubyCount: converted.rubyCount,
    emphasisCount: converted.emphasisCount,
    skipped: converted.skipped,
    charCount: countEpisodeChars(converted.markdown, { ext: ".md", excludeRuby: false }).net,
  };
}

/** ファイル名から拡張子と、ダウンロードの印（半角の `(2)`）を落とす */
function wordBaseName(fileName: string): string {
  return fileName
    .replace(/^.*[/\\]/, "")
    .replace(/\.docx$/i, "")
    .replace(/\s*\(\d{1,3}\)$/, "")
    .trim();
}

/** 書き出しとして照らす長さ（そろえたあとの字数） */
const HEAD_LENGTH = 32;
/**
 * これより短い書き出しでは照らさない。短い書き出し（「はい。」）は
 * どの作品のどこにでも現れうるので、手掛かりにならない
 */
const HEAD_MIN_LENGTH = 16;

/**
 * 本文を比べるための形にそろえる（**比べるためだけ**。書かない・見せない）。
 *
 * - ルビ：`{漢字|かんじ}`・`|漢字《かんじ》`・`漢字《かんじ》` は親文字だけに
 * - 傍点：`{{強調}}` は中の文字だけに
 * - 空白（全角も）と改行をすべて落とす（字下げの有無で外さない）
 * - NFKC で全角英数をそろえる
 */
export function bodyFingerprint(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\{\{([^{}]*)\}\}/g, "$1")
    .replace(/\{([^{}|]+)\|[^{}]*\}/g, "$1")
    .replace(/《[^》]*》/g, "")
    .replace(/[|｜]/g, "")
    .replace(/\s+/g, "");
}

/**
 * Word 原稿の書き出し（見出しを除いた本文の頭）。短すぎれば null。
 */
export function wordBodyHead(doc: Pick<WordManuscript, "markdown">): string | null {
  const body = doc.markdown
    .split("\n")
    .filter((line) => !/^#{1,6}\s/.test(line))
    .join("\n");
  const head = bodyFingerprint(body).slice(0, HEAD_LENGTH);
  return head.length >= HEAD_MIN_LENGTH ? head : null;
}

/** 照らす相手の作品1つ */
export interface WordMatchWork {
  readonly id: string;
  readonly title: string;
  readonly folderName: string;
  /** 作品フォルダー（落とされた場所がこの中かを見る） */
  readonly folderPath: string;
  /** 各話の本文を `bodyFingerprint` でそろえたもの */
  readonly episodes: readonly { readonly relPath: string; readonly fingerprint: string }[];
}

export type WordMatch =
  /** 書き出しが既にある話と同じ。**新しい話として足さない** */
  | { readonly kind: "already"; readonly workId: string; readonly relPath: string }
  /** 1つに決まった。**それでも確認画面で見せる** */
  | { readonly kind: "matched"; readonly workId: string; readonly by: "folder" | "title" }
  /** 候補が2つ以上、または題の一部しか合わない。選ばせる */
  | {
      readonly kind: "ambiguous";
      readonly workIds: readonly string[];
      readonly by: "title" | "partial";
    }
  | { readonly kind: "none" };

/**
 * どの作品の続きかを決める。**書かない・訊かない**（純粋な判断だけ）。
 *
 * @param titles 題の候補（見出し・ファイル名）。先にあるほうを先に照らす
 * @param head 書き出し（`wordBodyHead`）。短すぎれば null
 * @param sourcePath 落とされたファイルの場所。分からなければ null
 */
export function matchWordToWorks(input: {
  titles: readonly (string | null)[];
  head: string | null;
  sourcePath: string | null;
  works: readonly WordMatchWork[];
}): WordMatch {
  // 1. 書き出しが既にある話と同じ（いちばん確か。続きではなく「在る」）。
  //    短い書き出しはどこにでも現れうるので、手掛かりにしない
  if (input.head && input.head.length >= HEAD_MIN_LENGTH) {
    for (const work of input.works) {
      const found = work.episodes.find((episode) =>
        episode.fingerprint.includes(input.head as string)
      );
      if (found) return { kind: "already", workId: work.id, relPath: found.relPath };
    }
  }

  // 2. 作品フォルダーの中から落とされた
  if (input.sourcePath) {
    const source = input.sourcePath;
    // 中にあるかは `isPathInside` の1か所に任せる（2026-09-24）。自前の
    // 比べ方では、ブラウザ版で符号化された日本語の場所を別の作品と見ていた
    const inside = input.works.filter((work) => isPathInside(work.folderPath, source));
    // 入れ子の作品フォルダー（書庫の中の作品）では、いちばん深いものを採る。
    // 深さは符号を解いた長さで比べる（符号化された側だけ長く見えないように）
    const depth = (work: WordMatchWork): number => decodeUriEscapes(work.folderPath).length;
    inside.sort((a, b) => depth(b) - depth(a));
    if (inside.length > 0) return { kind: "matched", workId: inside[0].id, by: "folder" };
  }

  // 3. 題（バックアップと同じ決まりで照らす。写しを作らない）
  const candidates = input.works.map((work) => ({
    id: work.id,
    title: work.title,
    folderName: work.folderName,
    siteIds: [],
  }));
  const ambiguous = new Set<string>();
  let ambiguousBy: "title" | "partial" = "partial";
  for (const title of input.titles) {
    if (!title || title.trim() === "") continue;
    const match = matchBackupToWorks({ site: null, workId: null, title }, candidates);
    if (match.kind === "matched") {
      return { kind: "matched", workId: match.workId, by: "title" };
    }
    if (match.kind === "ambiguous") {
      for (const id of match.workIds) ambiguous.add(id);
      if (match.by === "title") ambiguousBy = "title";
    }
  }
  if (ambiguous.size > 0) {
    return { kind: "ambiguous", workIds: [...ambiguous], by: ambiguousBy };
  }
  return { kind: "none" };
}


/**
 * 新しい作品として取り込むときの形（6.99 の取り込みへ渡す）。
 *
 * **取り込みの道（置き場・題・登録）は写さない。** `importWorkFromZip` は
 * `WorkZipInspection` しか見ないので、Word 原稿1つを「.md が1つ入った
 * バックアップ」の形にして渡す。題はファイル名から（次の画面で直せる）。
 */
export function inspectionFromWord(doc: WordManuscript): WorkZipInspection {
  const title = sanitizeWorkFolderName(doc.baseName) || "取り込んだ作品";
  return {
    files: [
      {
        name: `${title}.md`,
        bytes: new TextEncoder().encode(doc.markdown),
        encoding: "utf8",
        isWorkInfo: false,
        charCount: doc.charCount,
      },
    ],
    episodeCount: 1,
    collected: false,
    totalChars: doc.charCount,
    skipped: [],
    info: null,
    narou: null,
    site: null,
    title,
    titleSource: "fileName",
    episodeNumbers: checkEpisodeNumbers([]),
    encodingNotice: checkBackupEncoding([]),
    dropped: [],
    // Word 原稿には章の見出しの約束が無い（見出しの段は作者の書き方しだい）。章は作らない
    outline: [],
  };
}
