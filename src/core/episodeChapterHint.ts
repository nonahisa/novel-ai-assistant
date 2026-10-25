// `paths` ではなく、`vscode` の要らない部分を直に指す（`episodeParser.ts` と
// 同じ理由。MCP の束からも呼べるようにしておく）
import * as path from "./pathText";
import { parseEpisodeFileName, toHalfWidthDigits } from "./episodeParser";
import { toChapterNumber } from "./chapterCitations";
import type { ChapterHintNote } from "../models/types";
import type { WorkFormatKey } from "./workFormat";

/**
 * ファイル名の規則（`parseEpisodeFileName`）で話数が読めなかった原稿に、
 * **話数と読める要素があれば補う**（作者の裁定、2026-10-25「話数を判定する
 * 要素がある場合は補い、それ以外の場合は不明として扱うのが良い」）。
 *
 * ## AIは使わない
 *
 * 決まった形だけを読む。AIに話数を当てさせると、並び順から想像した番号を
 * 「読んだ」ように返してくる（`collectedFile.ts` が「話数が分からないことは、
 * 間違った話数より害が小さい」と書いているのと同じ判断）。
 *
 * ## 見る要素
 *
 * 1. **ファイル名の別の形**——規則（先頭が番号）に合わない名前のうち、
 *    `再会（第三話）`・`【第3話】再会`・`第3話「再会」`・`題_3話`・`#3_題`・
 *    `題_ep3`・`エピソード32` のように、話数の印が付いたもの
 * 2. **頭書きの題**——投稿サイトのダウンロードやバックアップの
 *    【タイトル】【エピソードタイトル】（`１話　転生`・`第12話 再会`）
 * 3. **本文の最初の見出し**——本文（頭書きを除いた部分）の最初の空でない行が
 *    `第三話　旅立ち`・`## 第3話`・`【第3話】` のような見出しのとき
 *
 * ## 誤って補わないことを優先する
 *
 * - **既存の規則で読めているものには触らない。** 種別が「不明」のときだけ
 *   見る。日付の名前・プロローグ・幕間・番号の名前は1つも動かない
 * - **要素が2つ以上あって食い違えば補わない**（どちらが正しいか決められない）
 * - **話数の印の無い数字は読まない。** 日付・年・巻数のような数字だけでは
 *   補わない。「第」の無い漢数字（`一話完結`）も、話数でない言い回しと
 *   見分けられないので読まない（`chapterCitations.ts` と同じ線引き）
 * - **「話」の直後が区切りでなければ読まない。** `第3話の構想`・`3話目`・
 *   `1話完結` は話数の名乗りではない
 * - **範囲（`第3〜4話`）は補わない。** どの話として扱うか決めきれない
 *
 * VS Code API に依存しない。
 */

/** 補えたとき／食い違って補わなかったときの結果。何も無ければ null */
export type ChapterHintResult =
  | {
      readonly status: "inferred";
      readonly chapter: number;
      /** 作者に見せる、どこから読んだかの説明 */
      readonly evidence: string;
      /**
       * ファイル名から話数の印を落とした残り（題として使える）。
       * 落とすと空になるなら null
       */
      readonly subtitle: string | null;
    }
  | {
      readonly status: "conflict";
      /** 作者に見せる、何と何が食い違ったかの説明 */
      readonly evidence: string;
    };

/** 話数に使う文字（算用数字・全角・漢数字）。`chapterCitations.ts` と同じ範囲 */
const NUMBER = "[0-9０-９〇零一二三四五六七八九十百]+";

/**
 * 「話」のあとに来てよい文字。**ここに無い文字が続けば話数の名乗りではない**
 * （`第3話の構想`・`3話目`・`1話完結`）。題の始まりの括弧と、閉じ括弧を許す
 */
const AFTER_WA = "(?=$|[\\s　_.．・\\-「」『』【】（）()［］\\[\\]〈〉《》:：、,，])";

/**
 * 話数の前に来てはいけない文字。範囲・列挙（`3〜4話`・`2・3話`）の後ろ側を
 * 単独の話数として拾わないため
 */
const NOT_RANGE_TAIL = "(?<![0-9０-９〇零一二三四五六七八九十百〜～~\\-－ー―・、,，])";

/** ファイル名の中の「第N話」（漢数字も読む） */
const NAME_WITH_DAI = new RegExp(`第\\s*(${NUMBER})\\s*話${AFTER_WA}`, "gu");
/** ファイル名の中の「N話」（**算用数字だけ**。「第」の無い漢数字は読まない） */
const NAME_WITHOUT_DAI = new RegExp(
  `${NOT_RANGE_TAIL}(?<!第\\s*)([0-9]+)\\s*話${AFTER_WA}`,
  "gu"
);
/** ファイル名の中の「#3」「＃3」 */
const NAME_HASH = /(?<![0-9A-Za-z])[#＃]\s*([0-9]+)(?![0-9])/gu;
/**
 * ファイル名の途中の「ep3」「episode3」。先頭にあれば規則（パターン6）が
 * 既に読んでいるので、ここに来るのは途中にあるものだけ
 */
const NAME_EP = /(?<![A-Za-z])(?:ep|episode)\.?\s*[_-]?\s*([0-9]+)(?![0-9])/giu;
/**
 * ファイル名の「エピソード32」「エピソード 32」（全角数字は先に半角へ揃えてある）。
 * 作者の作品（コールドスリープ）が `エピソード32.txt` の形で名付けており、
 * 英語の ep と同じく話数の名乗りとして読む（母艦の実データの確認、2026-10-25）。
 *
 * **後ろは「話」と同じ線引き**（`エピソード3の構想` を読まない）。範囲
 * （`エピソード3〜4`）も、後ろに区切りでない字が続くので読まない
 */
const NAME_EPISODE_KANA = new RegExp(
  `エピソード[\\s_\\-]*([0-9]+)${AFTER_WA}`,
  "gu"
);

/**
 * 1行の見出しの先頭にある話数。`第三話　旅立ち`・`## 第3話`・`【第3話】再会`・
 * `１話　転生`。**行の先頭だけを見る**——本文の途中の「第三話で」を拾わない
 */
const HEADING = new RegExp(
  `^[#＃\\s　]*[【［\\[（(「『]?\\s*(?:第\\s*(${NUMBER})|([0-9]+))\\s*話${AFTER_WA}`,
  "u"
);

/** 見出しとして見る行の長さの上限。長い行は本文の地の文とみなす */
const HEADING_MAX_CHARS = 40;

interface Candidate {
  readonly chapter: number;
  /** 作者に見せる出どころ（「ファイル名の「第三話」」など） */
  readonly label: string;
}

/**
 * 話数を補えるかを見る。
 *
 * - `fileName`：原稿のファイル名（拡張子つきでよい）
 * - `metaTitle`：頭書きの題（`parseEpisodeMetadata` の `title`）
 * - `body`：頭書きを除いた本文（`parseEpisodeMetadata` の `body`）
 *
 * **合本は渡さない**（中の各話の題から読む道が別にある。`collectedFile.ts`）。
 */
export function inferChapterHint(input: {
  readonly fileName: string;
  readonly metaTitle?: string | null;
  readonly body?: string | null;
  /** 作品の形式（プロットの `## 形式`）。分からなければ省く */
  readonly format?: WorkFormatKey;
}): ChapterHintResult | null {
  /*
    **創作メモ集には補いを掛けない**（母艦の裁定、2026-10-25）。メモは話では
    ないので、`第三話 構想メモ.md` から「メモ3」を作ると、話でないものに
    話数を付けることになる。番号の無いメモが普通の形式でもある（設計書6.70）
  */
  if (input.format === "memo") return null;
  // 既存の規則で読めたもの（日付・番号・プロローグなど）は1つも変えない
  if (parseEpisodeFileName(input.fileName).kind !== "不明") return null;

  const base = toHalfWidthDigits(
    path.basename(input.fileName, path.extname(input.fileName)).trim()
  );
  const fromName = fileNameCandidates(base);
  const candidates: Candidate[] = [...fromName.candidates];

  const title = input.metaTitle?.trim();
  if (title) {
    const chapter = headingChapter(title);
    if (chapter !== null) {
      candidates.push({ chapter, label: `頭書きの題「${shorten(title)}」` });
    }
  }

  const firstLine = firstNonEmptyLine(input.body ?? "");
  if (firstLine !== null && firstLine.length <= HEADING_MAX_CHARS) {
    const chapter = headingChapter(firstLine);
    if (chapter !== null) {
      candidates.push({
        chapter,
        label: `本文の最初の見出し「${shorten(firstLine)}」`,
      });
    }
  }

  if (candidates.length === 0) return null;

  const distinct = [...new Set(candidates.map((candidate) => candidate.chapter))];
  if (distinct.length > 1) {
    return {
      status: "conflict",
      evidence: candidates.map((candidate) => candidate.label).join("と、") +
        "が食い違う",
    };
  }

  // 同じ出どころの同じ話数（ファイル名に「第3話」と「#3」）は1回だけ言う
  const labels = [...new Set(candidates.map((candidate) => candidate.label))];
  return {
    status: "inferred",
    chapter: distinct[0],
    evidence: labels.join("・"),
    subtitle: fromName.rest,
  };
}

/**
 * 一覧のホバーに出す1行（設計書6.2）。補いも食い違いも無ければ null。
 *
 * **食い違って補わなかったことも出す。** 「判定不能」とだけ出ると、作者は
 * ファイル名のどこが悪いのかを探すことになる。何と何が食い違ったかが
 * 分かれば、直すのはどちらか1つで済む。
 */
export function describeChapterHint(note: ChapterHintNote | undefined): string | null {
  if (!note) return null;
  if (note.status === "inferred") {
    return `- 補った話数です（${note.evidence}から。ファイル名の規則では読めませんでした）`;
  }
  return `- 話数を補っていません（${note.evidence}ため）`;
}

/** 走査の結果へ載せる形（`EpisodeFile.chapterHint`）にする */
export function toChapterHintNote(result: ChapterHintResult): ChapterHintNote {
  return { status: result.status, evidence: result.evidence };
}

/**
 * ファイル名の中の話数の印を全部拾う。**同じ名前に2つの話数があれば、
 * 両方を候補にする**（食い違いとして補わない側へ回す）。
 *
 * `rest` は印を落とした残り（題として使う）。印が無ければ名前そのもの。
 */
function fileNameCandidates(base: string): {
  candidates: Candidate[];
  rest: string | null;
} {
  const candidates: Candidate[] = [];
  let rest = base;
  for (const pattern of [
    NAME_WITH_DAI,
    NAME_WITHOUT_DAI,
    NAME_HASH,
    NAME_EP,
    NAME_EPISODE_KANA,
  ]) {
    for (const match of base.matchAll(pattern)) {
      const chapter = positiveChapter(match[1]);
      if (chapter === null) continue;
      candidates.push({ chapter, label: `ファイル名の「${match[0].trim()}」` });
      rest = rest.replace(match[0], " ");
    }
  }
  const cleaned = rest
    // 中身の無くなった括弧（`【第3話】` → `【】`）を落とす
    .replace(/【\s*】|［\s*］|\[\s*\]|（\s*）|\(\s*\)|「\s*」|『\s*』/gu, " ")
    .replace(/^[\s　_.．・\-:：、,，]+|[\s　_.．・\-:：、,，]+$/gu, "")
    .trim();
  return { candidates, rest: cleaned.length > 0 ? cleaned : null };
}

/** 見出しの先頭の話数。読めなければ null */
function headingChapter(line: string): number | null {
  // 頭書きの題は全角数字（`１話　転生`）で来るので、半角へ揃えてから見る
  const matched = HEADING.exec(toHalfWidthDigits(line.trim()));
  if (!matched) return null;
  return positiveChapter(matched[1] ?? matched[2]);
}

function positiveChapter(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = toChapterNumber(raw);
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r\n?|\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** 説明に引く文字は短くする（ホバーの1行に収める） */
function shorten(text: string): string {
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}
