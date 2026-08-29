import * as path from "./paths";
import type { EpisodeFile } from "../models/types";
import { formatChapterLabel, stripChapterLabel } from "./episodeLabel";
import type { WorkFormatKey } from "./workFormat";
import {
  ACTIVITY_REPORT_MAX_CHARS,
  AFTERWORD_MAX_CHARS,
  ANNOUNCE_INSTRUCTION_MARKS,
  X_POST_MAX_CHARS,
  type AnnounceResult,
} from "../prompts/announce";

/**
 * 更新告知文（P-30）の組み立てと検査。**純粋関数だけを置く。**
 *
 * 画面も保存も呼ばないので、Xの数え方も検査も単体テストで確かめられる。
 * 文言の検査を機能側（`features/generateAnnouncement.ts`）に書くと、
 * 画面を出さないと確かめられなくなる。
 *
 * （場所の扱いは `core/paths` を通す。`path` を直接使うとブラウザ版で壊れる）
 */

/**
 * Xの数え方（重み付き文字数）。
 *
 * **Xは「文字数」ではなく重みで数える。** 半角英数字などは1、
 * 日本語や絵文字は2で、上限は280——つまり日本語だけなら140字である。
 * 素の `String.length` で140字に収めると、実際には280を超えて弾かれる。
 *
 * 重み1になるのは次の範囲だけで、それ以外はすべて2（Xの公開仕様）。
 */
export const X_WEIGHTED_LIMIT = 280;

/**
 * URLは長さに関わらずこの重みで数えられる（Xが短縮するため）。
 *
 * **実際の文字数で数えると、長いURLを貼っただけで「超えている」と
 * 注意が出る。** 作品ページのURLは投稿サイトによってかなり長い。
 */
export const X_URL_WEIGHT = 23;

/** URLが決まっていないときに置く目印。作者が貼るときに差し替える */
export const URL_PLACEHOLDER = "{URL}";

/** 重み1で数える範囲。これ以外は2 */
function isSingleWeight(code: number): boolean {
  return (
    code <= 0x10ff ||
    (code >= 0x2000 && code <= 0x200d) ||
    (code >= 0x2010 && code <= 0x201f) ||
    (code >= 0x2032 && code <= 0x2037)
  );
}

function weighFragment(fragment: string): number {
  let total = 0;
  // **コードポイントで回す。** `for (let i = 0; ...)` だと絵文字が
  // 2つの半端な値に割れ、1文字を2回数えることになる
  for (const character of fragment) {
    total += isSingleWeight(character.codePointAt(0) ?? 0) ? 1 : 2;
  }
  return total;
}

export function xWeightedLength(text: string): number {
  // **毎回作り直す。** モジュールの外に `g` 付きの正規表現を置くと
  // `lastIndex` が呼び出しをまたいで残り、2回目から結果が変わる。
  //
  // **URLの目印も同じ重みで数える。** 目印のままだと5文字ぶんにしかならず、
  // URLを設定していない作品だけ判定が18甘くなる。作者がURLへ貼り替えた
  // 瞬間に280を超えるので、目印のうちからURLの重みで見ておく
  const pattern = /https?:\/\/\S+|\{URL\}/g;
  let total = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    total += weighFragment(text.slice(cursor, match.index));
    total += X_URL_WEIGHT;
    cursor = match.index + match[0].length;
  }
  return total + weighFragment(text.slice(cursor));
}

/**
 * 見出しを作るのに要るぶんだけの話。
 *
 * `EpisodeBody` をそのまま受けると、試験のたびに本文とハッシュまで
 * 組み立てることになる。見出しに使う欄だけを求める。
 */
export interface AnnounceEpisodeRef {
  /** 話数。合本の中の話は、ファイルではなくその話の番号 */
  chapter: number | null;
  /** サブタイトル。無ければ null */
  title: string | null;
  file: Pick<EpisodeFile, "kind" | "fileName" | "date" | "dateSeq">;
}

/**
 * 「第3話「灯を継ぐ」」の形にする。
 *
 * **`stripChapterLabel` を必ず通す。** 投稿サイトからDLした本文の題は
 * 「第1話 気がついたら幽霊に」のように話数を含んでおり、通さないと
 * 「第1話「第1話 気がついたら幽霊に」」になる。
 *
 * **ファイル名で代える場合は拡張子を落とす。** 話数もサブタイトルも
 * 読めない本文があり、そのまま使うと「設定メモ.txt 更新しました」と
 * 投稿されて、拡張子が読者の目に触れる。
 */
export function announceEpisodeLabel(
  episode: AnnounceEpisodeRef,
  format?: WorkFormatKey
): string {
  const chapterLabel = formatChapterLabel(
    {
      kind: episode.file.kind,
      chapterStart: episode.chapter,
      chapterEnd: episode.chapter,
      date: episode.file.date,
      dateSeq: episode.file.dateSeq,
    },
    format
  );
  const title = stripChapterLabel(episode.title, chapterLabel);
  const head =
    chapterLabel ||
    path.basename(episode.file.fileName, path.extname(episode.file.fileName));
  return title ? `${head}「${title}」` : head;
}

export interface XPostParts {
  /** AIが書いた本文（定型句・ハッシュタグ・URLを含まない） */
  body: string;
  /** 「第3話「灯を継ぐ」」のような話の見出し */
  episodeLabel: string;
  /** 作者が設定したハッシュタグ。空なら行ごと出さない */
  hashtags: string[];
  /** 作品ページのURL。空なら目印を置く */
  workUrl: string;
}

/**
 * X用の投稿を組み立てる。
 *
 * **定型句・ハッシュタグ・URLはコード側で付ける。** AIに書かせると
 * 話数を取り違えたり、存在しないURLを作ったりする。
 */
export function composeXPost(parts: XPostParts): string {
  const lines = [`${parts.episodeLabel} 更新しました`, parts.body];
  // ハッシュタグを設定していない作者の投稿に、空行を残さない
  if (parts.hashtags.length > 0) lines.push(parts.hashtags.join(" "));
  lines.push(parts.workUrl || URL_PLACEHOLDER);
  return lines.join("\n");
}

/**
 * 出来上がった告知文の気になる点を挙げる。
 *
 * **切り詰めない。** 読者に見せる文章に正解は無いので、機械が勝手に
 * 削ると作者の意図した山場ごと落ちる。注意として見せ、直すかどうかは
 * 作者が決める（P-06 の紹介文と同じ扱い）。
 *
 * @param composedX ハッシュタグとURLまで足したX用の投稿
 */
export function validateAnnouncement(
  result: AnnounceResult,
  composedX: string
): string[] {
  const warnings: string[] = [];

  const weighted = xWeightedLength(composedX);
  if (weighted > X_WEIGHTED_LIMIT) {
    warnings.push(
      `X用は、ハッシュタグとURLを足すと ${weighted}（上限 ${X_WEIGHTED_LIMIT}）です。` +
        "本文を短くするか、ハッシュタグを減らしてください。"
    );
  }
  // **字数の指定はコード側で数え直す**（AIの出力を信用しない）。
  // Xの重みだけを見ていると、半角英数字の多い本文は101字でも重み101に
  // しかならず、280に収まったまま指定の100字を素通りする
  if (result.xPost.length > X_POST_MAX_CHARS) {
    warnings.push(
      `X用の本文が ${result.xPost.length}字あります` +
        `（指定は ${X_POST_MAX_CHARS}字まで）。`
    );
  }
  if (result.activityReport.length > ACTIVITY_REPORT_MAX_CHARS) {
    warnings.push(
      `活動報告用が ${result.activityReport.length}字あります` +
        `（目安は ${ACTIVITY_REPORT_MAX_CHARS}字まで）。`
    );
  }
  if (result.afterword.length > AFTERWORD_MAX_CHARS) {
    warnings.push(
      `後書き用が ${result.afterword.length}字あります` +
        `（目安は ${AFTERWORD_MAX_CHARS}字まで）。`
    );
  }

  // **見るのは読者に出す3つだけ。** `spoilerCheck` は作者へ向けた説明で、
  // 伏せた要素を語るのに「#」や記号が入っていてもおかしくない
  const published: Array<[string, string]> = [
    ["X用", result.xPost],
    ["活動報告用", result.activityReport],
    ["後書き用", result.afterword],
  ];

  // URLはどれに書かれても困る。活動報告にも後書きにも、AIが作ったURLは要らない
  for (const [label, text] of published) {
    if (text.includes("http")) {
      warnings.push(`${label}にURLが書かれています。URLはこちらで付けます。`);
    }
  }

  // **ハッシュタグを見るのはX用だけ。** こちらでタグを付けるのはXの投稿だけで、
  // 活動報告用・後書き用に「こちらで付けます」と出すのは嘘になる。
  // そのうえ「## 見どころ」のような見出しにも当たっていた
  if (result.xPost.includes("#")) {
    warnings.push(
      "X用にハッシュタグが書かれています。ハッシュタグはこちらで付けます。"
    );
  }

  for (const [label, text] of published) {
    for (const mark of ANNOUNCE_INSTRUCTION_MARKS) {
      if (text.includes(mark)) {
        // **指示の言葉が、答えの中身として返ってくる**（CLAUDE.md の失敗3）。
        // 「（まだありません）」がそのまま投稿文に混ざったまま貼られると、
        // 読者の目に触れる
        warnings.push(
          `${label}に、こちらが材料として渡した言葉「${mark}」がそのまま入っています。`
        );
      }
    }
  }

  return warnings;
}

/** コピーできる3種。値は「どの文章か」だけを表し、文言は下の表が持つ */
export type AnnouncementCopyKind = "x" | "activityReport" | "afterword";

/** ボタンの文言。**画面に出す名前はここだけが持つ** */
export const ANNOUNCEMENT_COPY_LABELS: Record<AnnouncementCopyKind, string> = {
  x: "X用をコピー",
  activityReport: "活動報告用をコピー",
  afterword: "後書き用をコピー",
};

/** 並べる順。X用がいちばん使うので先頭 */
const COPY_ORDER: AnnouncementCopyKind[] = ["x", "activityReport", "afterword"];

export interface AnnouncementCopyChoice {
  kind: AnnouncementCopyKind;
  label: string;
}

/**
 * まだコピーしていないものだけを、ボタンとして並べる。
 *
 * **通知は1回に1つしか選べない。** 3種を作っておきながら1つ選んだ時点で
 * 通知が消えると、残りは開いた文書から手で拾うことになる。作者はたいてい
 * X用と活動報告用の両方を貼るので、押すたびに残りだけを出し直す。
 *
 * **押したものは並べ直さない。** 同じボタンがまた出ると、押したのに
 * 効いていないように見える（通知は押した記録を持たない）。
 */
export function remainingCopyChoices(
  copied: ReadonlySet<AnnouncementCopyKind>
): AnnouncementCopyChoice[] {
  return COPY_ORDER.filter((kind) => !copied.has(kind)).map((kind) => ({
    kind,
    label: ANNOUNCEMENT_COPY_LABELS[kind],
  }));
}

export interface AnnouncementMarkdownInput {
  workTitle: string;
  episodeLabel: string;
  /** ハッシュタグとURLまで足したX用の投稿 */
  composedX: string;
  /** `composedX` のXの数え方での長さ */
  weightedLength: number;
  activityReport: string;
  afterword: string;
  spoilerCheck: string | null;
  warnings: string[];
}

export function buildAnnouncementMarkdown(
  input: AnnouncementMarkdownInput
): string {
  const lines: string[] = [
    "# 更新告知文",
    "",
    `${input.workTitle}　${input.episodeLabel}`,
    "",
  ];

  // **注意は冒頭に置く。** 末尾に置くと、上から読んでコピーした作者は
  // 気づかないまま貼ってしまう
  if (input.warnings.length > 0) {
    for (const warning of input.warnings) lines.push(`- ⚠ ${warning}`);
    lines.push("");
  }

  lines.push(
    `## X（旧Twitter）用（${input.weightedLength}/${X_WEIGHTED_LIMIT}）`,
    ""
  );
  // **ここだけコード柵で囲む。** ハッシュタグの行は「#創作」で始まるので、
  // 素で置くとMarkdownの見出しとして表示され、コピーした形と見た目が食い違う
  lines.push("```", input.composedX, "```", "");

  lines.push("## 活動報告・近況ノート用", "", input.activityReport, "");
  lines.push("## 後書き用", "", input.afterword, "");
  lines.push(
    "## 伏せたもの",
    "",
    input.spoilerCheck?.trim() || "（AIからの申告はありません）",
    ""
  );

  return lines.join("\n");
}
