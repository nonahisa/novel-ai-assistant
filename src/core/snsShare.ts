import type { PostingSiteId, PostingSiteProfile } from "../models/posting";
import { isOpenableWorkUrl, narouNcode } from "./postingSiteRecords";

/**
 * SNSへの告知貼り付け（設計書6.79.8）。**純粋関数だけを置く。**
 *
 * ## 何をして、何をしないか
 *
 * ここが作るのは**文字列だけ**である——投稿画面のURLと、そこへ載せる
 * 作品ページのURL。**SNSへHTTPを発することはしないし、投稿もしない**
 * （開くのは `openExternal`、投稿ボタンを押すのは作者。6.79.2の一線）。
 *
 * Xには公式の貼り付け口（Web Intent）があるので、投稿画面のDOMを触る
 * 必要が無い。**貼り付け先を増やすときは、この表へ行を足す**——画面側に
 * 文言やURLの組み立てを書くと、SNSごとに散る。
 *
 * VS Code API には依存しない（画面を出さずに確かめられるようにする）。
 */

/** Xの公式の貼り付け口。投稿画面を開くだけで、投稿はしない */
const X_INTENT_ENDPOINT = "https://x.com/intent/post";

/**
 * 結果画面に出す文言。**画面に出す名前はここだけが持つ。**
 *
 * Blueskyなど同型のIntentを持つSNSを足すときは、ここへ並べる。
 */
export const X_SHARE_LABEL = "Xへ貼り付ける（投稿画面を開く）";

/**
 * Xの投稿画面のURLを組む。
 *
 * **載せるのは `text` だけ**（設計書6.79.8）。`url` や `hashtags` の引数も
 * あるが、告知文の中に既に入っているものを重ねて渡すと、投稿欄で二重に
 * 並ぶ。`encodeURIComponent` を通すのは、「#」「&」を素で置くと**そこから
 * 先が捨てられる**（断片・別の引数として読まれる）ためである。
 */
export function xIntentUrl(text: string): string {
  return `${X_INTENT_ENDPOINT}?text=${encodeURIComponent(text.trim())}`;
}

/**
 * 作品の**各話一覧**（＝作品ページ）のURL（設計書6.79.8）。
 *
 * **各話への直接リンクにしない**（作者の指定）。告知から来た読者が続きを
 * 追えるのは、目次のあるページだからである。
 *
 * 決め方は3段——①台帳の作品ページURL ②作品IDから合成できるサイトだけ合成
 * ③どちらも無ければ `undefined`（呼ぶ側は手入力へ落とす）。
 *
 * **合成は、形を確かめてからにする。** 作品IDの欄は自由入力で、作品名や
 * URLの断片が入っていることがある。それを埋めると、押した先が存在しない
 * ページになる——リンクが無いほうが、まだ親切である
 * （`narouAnalysisUrl` と同じ考え方で、Nコードの検証も同じものを使う）。
 */
export function workListUrl(
  site: PostingSiteId,
  profile: PostingSiteProfile | undefined
): string | undefined {
  // **作者が入れたURLが最優先。** 合成より確かで、短縮URLや別ドメインの
  // 作品ページ（アルファポリスなど）もそのまま使える。
  // **開く直前にも protocol を確かめる**——台帳は作者が手で直せる
  const workUrl = (profile?.workUrl ?? "").trim();
  if (workUrl && isOpenableWorkUrl(workUrl)) return workUrl;

  const workId = (profile?.workId ?? "").trim();
  if (!workId) return undefined;

  switch (site) {
    case "narou": {
      // 作品トップ（＝目次）。Nコードの検証・正規化は分析リンクと同じもの
      const ncode = narouNcode(workId);
      return ncode ? `https://ncode.syosetu.com/${ncode}/` : undefined;
    }
    case "kakuyomu":
      // カクヨムの作品IDは数字だけの長い列。ほかの形は合成しない
      return /^\d+$/.test(workId)
        ? `https://kakuyomu.jp/works/${workId}`
        : undefined;
    case "alphapolis":
    case "note":
      /*
        **合成しない。** アルファポリスの作品は「作者番号＋作品番号」の
        2部構成で、作品IDの欄だけではURLを組めない。noteには「作品」の
        単位が無い（記事とマガジン）。どちらも台帳の作品ページURLに頼る。
      */
      return undefined;
  }
}
