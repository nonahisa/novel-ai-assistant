import { parseLabeledBlocks } from "./workInfoParse";

/**
 * 投稿サイトのバックアップに入っている「作品情報」のファイルを見分ける。
 *
 * カクヨムのバックアップは、作品フォルダーの直下へ `about.txt` を置く。
 * 中身は**作品そのものの情報**（題・作者名・キャッチコピー・紹介文・タグ・
 * 目次）であって、**物語の本文ではない。**
 *
 * これを1話として数えると、次の3つが同時に狂う。
 *
 * 1. 作品の総字数に、紹介文とタグが混ざる
 * 2. 話数の読めない話が1つ増える（一覧の末尾に「about」が並ぶ）
 * 3. **AIへ本文として渡る**——冒頭診断が作品説明を診断していた不具合
 *    （設計書6.87.10）は、並び順を直して「先頭に来ないように」しただけで、
 *    材料からは外れていなかった
 *
 * **見分けは「名前」と「中身」の両方で行う。** どちらか片方では足りない。
 *
 * - 名前だけで決めると、`about.txt` という題の掌編を本文から落とす
 * - 中身だけで決めると、本文中の【】を見出しと取り違えたときに
 *   本物の原稿を落とす（`metadataParser.ts` が「知っている見出しでしか
 *   切らない」としているのと同じ用心）
 *
 * **落とすほうへ倒れない。** 迷ったら「本文として扱う」——本文を1つ
 * 落とすのは作者の原稿が消えたように見えるが、作品情報を1つ余計に
 * 数えるのは字数が少しずれるだけである。
 */

/**
 * 作品情報が置かれるファイル名（小文字で比べる）。
 *
 * カクヨムのバックアップは `about.txt` の一択だが、作者が拡張子を
 * 変えて保存し直すことはある。
 */
const WORK_INFO_FILE_NAMES = ["about.txt", "about.md"];

/**
 * 作品情報にしか出てこない見出し。**1つでもあれば作品情報とみなす。**
 *
 * どれも「作品ぜんたい」についての項目で、1話の頭書き
 * （`metadataParser.ts` の【タイトル】【公開状態】【文字数】）には出てこない。
 */
const WORK_INFO_LABELS = [
  "キャッチコピー",
  "紹介文",
  "あらすじ",
  "タグ",
  "目次",
  "セルフレイティング",
  "連載状態",
  "作者名",
];

/** 本文の見出し（`metadataParser.ts` の `BODY_LABELS` と同じ意味） */
const BODY_LABELS = ["本文", "ほんぶん"];

/**
 * そのファイルは作品情報か。
 *
 * @param fileName 拡張子まで含むファイル名（パスではない）
 * @param text 中身（文字コードは復元済み）
 */
export function isWorkInfoFile(fileName: string, text: string): boolean {
  if (!WORK_INFO_FILE_NAMES.includes(fileName.toLowerCase())) return false;

  const labels = headerLabels(text);
  // 見出しが1つも無ければ、ただのテキストである（本文として扱う）
  if (labels.length === 0) return false;

  // **【本文】があるなら、それは1話である。** 作品情報には本文の欄が無い
  if (labels.some((label) => BODY_LABELS.includes(label))) return false;

  return labels.some((label) => WORK_INFO_LABELS.includes(label));
}

/**
 * 行頭に単独で置かれた【見出し】を拾う。
 *
 * **区切り方は `workInfoParse.ts` の1つを通す。** 見分ける側（ここ）と
 * 読み取る側で別の正規表現を持つと、見出しの書き方が増えたときに
 * 片方だけが古くなる——「作品情報だと分かっているのに中身が空」という、
 * 追いにくい噛み合わなさになる。
 */
function headerLabels(text: string): string[] {
  return parseLabeledBlocks(text).map((block) => block.label);
}
