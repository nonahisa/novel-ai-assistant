import { parseLabeledBlocks } from "./workInfoParse";
import type { PostingSiteId } from "../models/posting";

/**
 * バックアップZIPが、どの投稿サイトから降りてきたものかを見分ける（設計書6.99）。
 *
 * ## 何のために見分けるのか
 *
 * 取り込んだ作品は、**すでにどこかのサイトに載っている。** そのことを
 * `設定/投稿状態.json` に書き留めておくと、あとで読者の反応（6.79.7）を
 * 記録するときに「どのサイトの数字ですか」から始められる。取り込みの
 * 途中で作者に訊かずに済ませるための下ごしらえである（打鍵ゼロ）。
 *
 * ## 決め打ちしない
 *
 * **見分けられなければ、何も書かない。** カクヨムと決め打ちして書くと、
 * なろうの作品の台帳にカクヨムの記録が入る——いちど混ざると、どちらの
 * 数字だったかはあとから分けられない（読者の反応の封筒を突き合わせる
 * `matchReaderStatsEnvelope` が、取り違えを止めるのと同じ理由）。
 *
 * **数字は読み取らない。** 紹介文に「10万PV達成記念」と書いてあっても、
 * そこから数字を拾って台帳へ入れない——作者が書いた**文章**であって、
 * いまのPVではない。台帳に入る数字は、作者が打ったものか、作者が自分で
 * 開いた管理画面から貼り込み係が読んだものだけである（6.68.1）。
 *
 * **サイトへは触りにいかない。** ここが見るのはZIPの中身と名前だけで、
 * HTTPは1回も発しない。
 *
 * VS Code API には依存しない。
 */

/**
 * カクヨムにしか無い欄。**1つでもあればカクヨムと読む。**
 *
 * どちらもカクヨム独自の仕組みである（自己申告のレーティングと、作品ページの
 * 色）。【キャッチコピー】【タグ】は他のサイトの書き出しにも出うるので、
 * 手がかりに使わない——**迷う手がかりを足すほど、決め打ちに近づく。**
 */
const KAKUYOMU_ONLY_LABELS = ["セルフレイティング", "イメージカラー"];

/** なろうの作品IDが書かれる欄（書き出しツールによって大文字小文字が揺れる） */
const NAROU_LABELS = ["Nコード", "ｎコード", "ncode", "NCODE", "Ncode"];

/**
 * なろうの作品ID（Nコード）の形。**N＋4桁＋英字2文字**と決まっている。
 *
 * なろうからの書き出しは、ZIPの名前がNコードそのものになる（`N1111IR.zip`）。
 * 桁を緩めると「N700系のぞみ」のような題まで拾うので、形は厳密に見る。
 */
const NCODE = /^[Nn]\d{4}[A-Za-z]{2}$/;

export interface BackupSiteClues {
  /** ZIPのファイル名（拡張子つき） */
  readonly zipFileName: string;
  /** 作品情報（`about.txt`）の中身。入っていなければ null */
  readonly workInfoText: string | null;
  /**
   * なろうのバックアップの頭（【Nコード】）を読めたか（`narouBackup.ts`）。
   *
   * なろうは `about.txt` を持たず、**Nコードの名前の .txt が1つ**なので、
   * 作品情報の欄だけを見ていると見分けられない。
   */
  readonly narouHeader?: boolean;
}

/**
 * 出どころを見分ける。**分からなければ null**（何も書かないための値）。
 */
export function detectBackupSite(
  clues: BackupSiteClues
): PostingSiteId | null {
  const labels = clues.workInfoText
    ? parseLabeledBlocks(clues.workInfoText).map((block) => block.label)
    : [];

  const kakuyomu = labels.some((label) =>
    KAKUYOMU_ONLY_LABELS.includes(label)
  );
  const narou =
    clues.narouHeader === true ||
    labels.some((label) => NAROU_LABELS.includes(label)) ||
    NCODE.test(zipBaseName(clues.zipFileName));

  // **両方の手がかりが出たら、どちらとも言わない。** 片方を優先する決まりを
  // 置くと、そちらが常に勝つ——混ざった台帳はあとから分けられない
  if (kakuyomu === narou) return null;
  return kakuyomu ? "kakuyomu" : "narou";
}

/**
 * ZIPの名前から、題にあたる部分だけを取り出す。
 *
 * 落とし方は `workZip.ts` の `workTitleFromZipFileName` と同じ
 * （拡張子・フォルダー・末尾の日付）。**呼び合わせない**のは、あちらが
 * ZIPを解く道具（fflate）を連れてくるためで、見分けだけを使いたい側に
 * 解凍器まで背負わせない。
 */
function zipBaseName(fileName: string): string {
  return fileName
    .replace(/\.zip$/i, "")
    .replace(/^.*[/\\]/, "")
    .replace(/[_-]\d{8}$/, "")
    .trim();
}
