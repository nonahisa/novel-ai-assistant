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

/**
 * 告知を作る話の並び（設計書6.41）。
 *
 * **新しい話が上。** 告知を作るのはたいてい今しがた公開した話なので、
 * 先頭（＝話数が最大のもの）が既定の選択になるように並べる。
 * **話数が読めないものは末尾へ回す**——前後を決められないので、
 * 上へ混ぜると既定の話がそちらへ入れ替わる。
 *
 * 元の配列は壊さない。
 */
export function orderAnnounceEpisodes<T extends { chapter: number | null }>(
  episodes: readonly T[]
): T[] {
  return [...episodes].sort((left, right) => {
    if (left.chapter === null && right.chapter === null) return 0;
    if (left.chapter === null) return 1;
    if (right.chapter === null) return -1;
    return right.chapter - left.chapter;
  });
}

/**
 * 競合中で一覧に出せない話の断り（設計書5.5.3）。
 *
 * **黙って消さない。** 競合中のファイルは一覧に出ないので、いま公開した
 * 話が競合していると、作者が気づかないまま1つ前の話が既定として選ばれる
 * （告知したい話と、告知される話が食い違う）。
 *
 * 名前は3件まで。無ければ `undefined`。
 */
export function describeConflictedEpisodes(
  fileNames: readonly string[]
): string | undefined {
  if (fileNames.length === 0) return undefined;
  const names = fileNames.slice(0, 3).join("、");
  return (
    `未解決の競合があるため、${fileNames.length}件の話は一覧に出ません` +
    `（${names}${fileNames.length > 3 ? " ほか" : ""}）。` +
    "競合を解決してから実行してください。"
  );
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
 * 本文を文ごとの行に分ける（作者の要望、2026-09-06「改行があったほうが
 * 読みやすいです」）。
 *
 * 句点・感嘆符・疑問符のあとで改行する。**閉じ括弧や引用符が続くときは
 * 切らない**（「…。」の中で切ると、鉤括弧が行頭に来る）。
 */
export function splitXBodyLines(body: string): string[] {
  const lines: string[] = [];
  let current = "";
  const characters = [...body.replace(/\r\n?/g, "\n")];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === "\n") {
      if (current.trim()) lines.push(current.trim());
      current = "";
      continue;
    }
    current += character;
    if (!"。！？!?".includes(character)) continue;
    const next = characters[index + 1];
    if (next === undefined) continue;
    if ("。！？!?」』）】〕〉》\"’\n".includes(next)) continue;
    lines.push(current.trim());
    current = "";
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

/** 空行の置き方（上限に近いとき、読みやすさが残る順に減らす） */
export type XPostSpacing = {
  /** 題の次に空行を置く */
  afterTitle: boolean;
  /** 本文を文ごとに改行する */
  perSentence: boolean;
  /** ハッシュタグ・URLの前に空行を置く */
  beforeUrl: boolean;
};

const FULL_SPACING: XPostSpacing = {
  afterTitle: true,
  perSentence: true,
  beforeUrl: true,
};

/**
 * 上限に収まるまで空行を減らす順。**読みやすさが残る順に落とす**
 * （作者の要望、2026-09-06。「{URL} の前 → 題の次 → 文ごと」）。
 */
const SPACING_FALLBACKS: readonly XPostSpacing[] = [
  FULL_SPACING,
  { ...FULL_SPACING, beforeUrl: false },
  { ...FULL_SPACING, beforeUrl: false, afterTitle: false },
  { afterTitle: false, perSentence: false, beforeUrl: false },
];

function composeXPostWith(parts: XPostParts, spacing: XPostSpacing): string {
  const lines = [`${parts.episodeLabel} 更新しました`];
  if (spacing.afterTitle) lines.push("");
  const body = parts.body.replace(/\r\n?/g, "\n").trim();
  lines.push(...(spacing.perSentence ? splitXBodyLines(body) : [body]));
  if (spacing.beforeUrl) lines.push("");
  // ハッシュタグを設定していない作者の投稿に、空行を残さない
  if (parts.hashtags.length > 0) lines.push(parts.hashtags.join(" "));
  lines.push(parts.workUrl || URL_PLACEHOLDER);
  return lines.join("\n");
}

/**
 * X用の投稿を組み立てる。
 *
 * **定型句・ハッシュタグ・URLはコード側で付ける。** AIに書かせると
 * 話数を取り違えたり、存在しないURLを作ったりする。
 *
 * **改行を入れる**（作者の要望、2026-09-06「改行があったほうが読みやすい」）。
 * 題の次に空行、本文は文ごとに改行、ハッシュタグ・URLの前に空行。
 * 改行も1字として数えるので、**上限を超えるときは空行から順に減らす**
 * （`SPACING_FALLBACKS`）。全部落としても超えるなら、そのまま返して
 * 検査（`validateAnnouncement`）の注意に任せる——切り詰めはしない。
 */
export function composeXPost(parts: XPostParts): string {
  let composed = "";
  for (const spacing of SPACING_FALLBACKS) {
    composed = composeXPostWith(parts, spacing);
    if (xWeightedLength(composed) <= X_WEIGHTED_LIMIT) break;
  }
  return composed;
}

/**
 * 貼り付ける直前に、決まったURLを告知文へ入れる（設計書6.79.8）。
 *
 * 告知文の末尾には、作者が設定したURLか目印（`{URL}`）が入っている
 * （`composeXPost`）。SNSへ貼るときには**そのURLが決まっている**ので、
 * 目印を差し替える。
 *
 * **末尾へ足すだけにしない。** 目印が残ったまま投稿されるか、URLが2つ
 * 並ぶかのどちらかになる。**URLが決まらなければ目印の行ごと落とす**
 * ——「{URL}」という文字列が読者の目に触れるほうが、URLが無いことより悪い。
 *
 * **ここでは字数を数え直さない**（設計書6.79.8）。Xの重み付き字数の検査は
 * `validateAnnouncement` が既に済ませており、貼り付けの経路で数え方を
 * もう1つ作ると、同じ投稿に2つの基準ができる。
 *
 * @param url 決まったURL。空文字は「URL無しで文だけ貼る」という答え
 */
export function xPostWithUrl(composedX: string, url: string): string {
  const link = url.trim();
  if (composedX.includes(URL_PLACEHOLDER)) {
    if (!link) {
      // 目印だけの行を落とす（本文の中に混ざっている目印は差し替えに任せる）
      return composedX
        .split("\n")
        .filter((line) => line.trim() !== URL_PLACEHOLDER)
        .join("\n")
        .replace(/\n+$/u, "");
    }
    return composedX.split(URL_PLACEHOLDER).join(link);
  }
  // 目印が無い＝作者が設定したURLが既に入っている。重ねて足さない
  return composedX;
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
  // **引用（>）で置く**（作者の要望、2026-09-06「表示も折り返してね」）。
  // 0.40.2 まではコード柵で囲んでいたが、Markdown のプレビューでは
  // 折り返さず横スクロールになり、画面の幅を超えた分が読めなかった。
  // 引用なら折り返し、空行も「>」だけの行で保てる。ハッシュタグの
  // 「#創作」は「#」の直後に空白が無いので見出しにはならない。
  // コピーは通知の「X用をコピー」が composedX をそのまま渡す
  for (const line of input.composedX.split("\n")) {
    // **行末の半角空白2つで、プレビューでも改行を見せる**（0.40.7）。Markdown は
    // 引用の中の続く行を1段落にまとめるので、無いと3行が1行につながって出る。
    // 空白を足すのはこの書き出しだけで、composedX（X用をコピーの中身）には
    // 足さない——X の280字に数えられてしまう
    lines.push(line ? `> ${line}  ` : ">");
  }
  lines.push("");

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
