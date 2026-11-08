import { countEpisodeChars } from "./episodeCharCount";
import { episodeReadableRanges, type TextRange } from "./metadataParser";
import { decodeBytes, hasConflictMarkers } from "./textDecode";
import { fromSiteNotation, toSiteNotation } from "./ruby";

/**
 * 原稿エディターの［入力］→「テキストファイルから」「Word から」で、外のファイルを
 * 開いている話へ取り込むときの判断（作者の決定 2026-11-08。設計書6.25.13）。
 *
 * 作者の言葉：「入力が空ならその話のファイルとして取り込む。入っていれば次の話か
 * 上書きか聞く」「聞くときに最後に加えるを選択肢として提示」。
 *
 * ## ここは決めるだけ
 *
 * ファイルを選ぶ・読む・書くのは `features/manuscriptImport.ts`。ここは
 * **vscode にもファイルにも触らない**ので、空かどうか・何を訊くか・本文の
 * どこを差し替えるかを単体テストで固められる（`latestEpisode.ts` と同じ置き方）。
 */

/** 取り込みの入口。画面のボタン（`#importText`・`#importWord`）と1対1 */
export type ImportSource = "text" | "word";

/** 1話ぶんとして受け取る大きさの上限。これを超えるものは、話1つではないと見る */
export const IMPORT_MAX_BYTES = 16 * 1024 * 1024;

/** テキストファイルを読んだ結果 */
export type DecodedImport =
  | {
      readonly ok: true;
      /** 改行を LF にそろえた本文 */
      readonly text: string;
      /** 作者に見せる文字コードの名前 */
      readonly encodingLabel: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * 取り込むテキストファイルを読む。**読めない（化ける）ものは取り込まない。**
 *
 * 文字コードの読み分けは原稿と同じ `decodeBytes`（UTF-8・BOM付き UTF-8・Shift_JIS）を
 * 通す——写しを作ると、同じファイルが原稿としては読めて取り込みでは読めない、が起きる。
 * そのうえで次のものは断る。
 *
 * - **置き換え文字（U+FFFD）が出た**：どの文字コードでも読めなかった。化けたまま
 *   入れると、作者の原稿に読めない字が残る。厳密な UTF-8 で読めたときだけは、
 *   作者が自分で書いた字かもしれないので断らない
 * - **NUL が入っている**：文章のファイルではない（画像や Word の文書を .txt と
 *   名付けたもの）
 * - **競合の印（`<<<<<<<`）が残っている**：同期の途中のファイル。原稿へ入れると、
 *   その話が AI の処理から外れる
 *
 * Windows のメモ帳の「Unicode」（UTF-16、BOM 付き）も読む。新しく書くときは
 * 手元の原稿の文字コードへ寄せるので、原稿が UTF-16 になることはない。
 */
export function decodeImportedText(bytes: Uint8Array): DecodedImport {
  const utf16 = decodeUtf16WithBom(bytes);
  let text: string;
  let encodingLabel: string;
  if (utf16 !== undefined) {
    if (utf16 === null) return { ok: false, reason: UNREADABLE_REASON };
    text = utf16.replace(/\r\n?/g, "\n");
    encodingLabel = "UTF-16";
  } else {
    const decoded = decodeBytes(bytes);
    text = decoded.text;
    encodingLabel =
      decoded.encoding === "utf8-bom"
        ? "UTF-8（BOM付き）"
        : decoded.encoding === "shift_jis"
          ? "Shift_JIS"
          : "UTF-8";
    if (text.includes("�") && !isStrictUtf8(bytes)) {
      return { ok: false, reason: UNREADABLE_REASON };
    }
  }
  if (text.includes("\u0000")) {
    return {
      ok: false,
      reason: "文章のファイルではないようです（文字でないものが入っています）。",
    };
  }
  if (hasConflictMarkers(text)) {
    return {
      ok: false,
      reason:
        "取り込むファイルに、同期の競合の印（<<<<<<< など）が残っています。先に競合を解決してください。",
    };
  }
  return { ok: true, text, encodingLabel };
}

const UNREADABLE_REASON =
  "文字コードを読み分けられませんでした（UTF-8 でも Shift_JIS でもないようです）。" +
  "メモ帳などで開き、文字コードを UTF-8 にして保存し直してから取り込んでください。";

/** BOM 付きの UTF-16 なら読む。BOM が無ければ undefined、読めなければ null */
function decodeUtf16WithBom(bytes: Uint8Array): string | null | undefined {
  if (bytes.length < 2) return undefined;
  const label =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : undefined;
  if (!label) return undefined;
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes.subarray(2));
  } catch {
    return null;
  }
}

function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * 話の本文の範囲（改行を LF にそろえた字の位置）。
 *
 * **題・冒頭の欄（公開状態・日時・文字数）・前書き・後書きを除いた本文**——読み上げが
 * 読む範囲（`episodeReadableRanges`）の最後のものと同じ。切り方を写さない。
 * 頭の欄の無い原稿では全文が本文である。
 */
export function episodeBodyRange(lfText: string): TextRange {
  const ranges = episodeReadableRanges(lfText);
  if (!ranges || ranges.length === 0) return { start: 0, end: lfText.length };
  return ranges[ranges.length - 1];
}

/**
 * 本文が空か。**題・冒頭の欄・前書き・後書きを除いて、空白と改行だけなら空**とみなす
 * （作者の決定「入力が空ならその話のファイルとして取り込む」。冒頭の欄だけのカクヨム形式の話も空）。
 */
export function isEpisodeBodyEmpty(lfText: string): boolean {
  const range = episodeBodyRange(lfText);
  return lfText.slice(range.start, range.end).trim() === "";
}

/**
 * 本文の所だけを、取り込んだ文に差し替える。**題・冒頭の欄・後書きは1文字も変えない。**
 *
 * 取り込んだ文の頭の空行と末尾の空白は落とす（ファイルの書き方の都合で付いた
 * ものなので、本文の一部ではない）。行頭の字下げは残す。本文の欄の後ろに
 * 後書きなどが続くなら、元の本文の末尾にあった空行の数をそのまま残す
 * （欄どうしの間合いを変えない）。
 */
export function replaceEpisodeBody(currentLf: string, importedLf: string): string {
  const range = episodeBodyRange(currentLf);
  const body = trimImported(importedLf);
  let before = currentLf.slice(0, range.start);
  // 【本文】の見出しで字が終わっている（改行が無い）とき、同じ行へ続けない
  if (before.length > 0 && !before.endsWith("\n")) before += "\n";
  if (range.end >= currentLf.length) {
    // 末尾の改行の有無は元の原稿に合わせる（書き戻しでも末尾の改行を勝手に足さない）
    const trailing = currentLf.length === 0 || currentLf.endsWith("\n") ? "\n" : "";
    return before + body + trailing;
  }
  const old = currentLf.slice(range.start, range.end);
  const oldTrailing = /\s*$/.exec(old)?.[0] ?? "";
  return before + body + oldTrailing + currentLf.slice(range.end);
}

/** 取り込んだ文の、頭の空行と末尾の空白を落とす（行頭の字下げは残す） */
export function trimImported(importedLf: string): string {
  return importedLf.replace(/^(?:[ \t　]*\n)+/, "").replace(/\s+$/, "");
}

/**
 * 上書きで消える字数。**原稿エディターの下の欄と同じ数え方**（空白と改行を除いた
 * 純文字数、`countEpisodeChars`）。別の数え方にすると、画面で見ている数と窓の数が合わない。
 */
export function erasedCharCount(currentLf: string, ext: string): number {
  return countEpisodeChars(currentLf, { ext, excludeRuby: false }).net;
}

/**
 * 取り込む文の書き方を、入れる先の話のファイルの種類へ寄せる。
 *
 * ルビと傍点の書き方はファイルの種類で決まる（作者の裁定、2026-09-15。`rubyNotationFor`）。
 *
 * - `.txt` の話へ、Markdown（Word の変換・`.md` のファイル）を入れる：`{漢字|かんじ}` を
 *   `｜漢字《かんじ》` へ、`{{強調}}` を `《《強調》》` へ（`toSiteNotation` の既定）。
 *   見出しの `#` も落とす——`.txt` では見出しにならず、投稿サイトへ貼ると `#` が出る
 * - `.md` の話へ、`.txt` を入れる：投稿サイトの記法を `{漢字|かんじ}` へ
 *   （`.txt` を `.md` にするときと同じ `fromSiteNotation`。設計書6.12.4）
 * - 同じ種類どうしはそのまま
 *
 * **字そのものは変えない。** 変わるのはルビ・傍点・見出しの印だけである。
 */
export function adaptImportedNotation(
  text: string,
  from: "markdown" | "plain",
  targetFileName: string
): string {
  const targetIsMarkdown = targetFileName.toLowerCase().endsWith(".md");
  if (targetIsMarkdown && from === "plain") return fromSiteNotation(text);
  if (!targetIsMarkdown && from === "markdown") {
    return toSiteNotation(text.replace(/^#{1,6}[ \t　]+/gm, ""), "site");
  }
  return text;
}

/** 取り込むファイルの書き方。Word は Markdown に変換して受け取る */
export function importedNotationOf(
  source: ImportSource,
  fileName: string
): "markdown" | "plain" {
  if (source === "word") return "markdown";
  return fileName.toLowerCase().endsWith(".md") ? "markdown" : "plain";
}

/** 本文が入っている話へ取り込むときの選び方 */
export type ImportChoice = "next" | "last" | "overwrite";

export type ImportPlan =
  /** 本文が空。訊かずにその話へ入れる */
  | { readonly kind: "fill" }
  /** 本文が入っている。この並びで訊く */
  | { readonly kind: "ask"; readonly choices: readonly ImportChoice[] };

/**
 * 訊くか、どれを並べるかを決める。
 *
 * - **本文が空**なら訊かない（合本は空にならない）
 * - ［次の話として足す］は、**あとの話の番号をずらす話が1つ以上あるとき**だけ並べる。
 *   最後の話（`isLatest`）や、そのフォルダーで後ろに話の無い話では、
 *   ［最後に加える］と同じことになるので1つにする（作者の決定）。
 *   話数を持たない話（プロローグ・日付名）からは、ずらす基準が決まらないので並べない
 * - **合本**（1ファイルに何話も入っている）では［上書きする］も［次の話として足す］も
 *   並べない。上書きは全話を消し、番号ずらしは中の話数と食い違う（`insertEpisode.ts` と同じ理由）
 */
export function planEpisodeImport(input: {
  readonly bodyEmpty: boolean;
  readonly collected: boolean;
  /** 開いている話が話数を1つだけ持つか（`episodeNumberOf` が数を返すか） */
  readonly numbered: boolean;
  /** 開いている話が作品のいちばん新しい話か */
  readonly isLatest: boolean;
  /** ［次の話として足す］で名前の変わる話の数（`planInsertion` の付け替えの件数） */
  readonly shiftCount: number;
}): ImportPlan {
  if (input.bodyEmpty && !input.collected) return { kind: "fill" };
  const choices: ImportChoice[] = [];
  if (!input.collected && input.numbered && !input.isLatest && input.shiftCount > 0) {
    choices.push("next");
  }
  choices.push("last");
  if (!input.collected) choices.push("overwrite");
  return { kind: "ask", choices };
}

/** ボタンの言葉。**作者の言い方のまま**（「最後に加える」は作者の言葉） */
export const IMPORT_CHOICE_LABELS: Readonly<Record<ImportChoice, string>> = {
  next: "次の話として足す",
  last: "最後に加える",
  overwrite: "上書きする",
};

/** 取りやめのボタン */
export const IMPORT_CANCEL_LABEL = "やめる";

/**
 * 訊く窓の説明（1行に1つ）。並べたボタンのぶんだけ書く。
 */
export function describeImportChoices(input: {
  readonly choices: readonly ImportChoice[];
  readonly sourceName: string;
  /** 取り込む文の純文字数 */
  readonly importedChars: number;
  /** ［次の話として足す］で作る話の番号と名前 */
  readonly next?: { readonly number: number; readonly fileName: string };
  /** ［次の話として足す］で名前の変わる話の数 */
  readonly shiftCount: number;
  /** ［最後に加える］で作る話の名前 */
  readonly lastFileName?: string;
  /** ［上書きする］で消える字数 */
  readonly erasedChars: number;
}): string[] {
  const lines = [`取り込む元：${input.sourceName}（${input.importedChars}字）`];
  for (const choice of input.choices) {
    if (choice === "next") {
      const named = input.next
        ? `第${input.next.number}話「${input.next.fileName}」として足します。`
        : "すぐ次の話として足します。";
      lines.push(
        `［${IMPORT_CHOICE_LABELS.next}］${named}あとの話のファイル名が変わります（${input.shiftCount}話）。`
      );
    } else if (choice === "last") {
      const named = input.lastFileName ? `「${input.lastFileName}」として` : "";
      lines.push(
        `［${IMPORT_CHOICE_LABELS.last}］最後の話のあとに${named}足します。ほかの話は変えません。`
      );
    } else {
      lines.push(
        `［${IMPORT_CHOICE_LABELS.overwrite}］いまの本文 ${input.erasedChars}字が消え、取り込んだ文に置き換わります` +
          "（題・冒頭の欄・後書きはそのまま。書き換える前の本文は控え〈.novelai-recovery〉に残します）。"
      );
    }
  }
  return lines;
}
