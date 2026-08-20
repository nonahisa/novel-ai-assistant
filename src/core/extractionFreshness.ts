/**
 * まだ設定資料へ取り込んでいない話を数える（設計書6.21.1）。
 *
 * AIの独り言が「空き時間に資料抽出やっておきましょうか？」と申し出るための
 * 材料である。**これまでは数えられず `undefined` を渡して黙らせていた**
 * （0を渡すと「抽出済み」と言い切ることになる）。
 *
 * ## 中身ではなく更新時刻で比べる
 *
 * 中身で比べるなら、全話をチャンクへ割ってキャッシュを引くことになる。
 * **キャッシュの鍵はモデル名と一緒に畳まれているので、内容ハッシュだけでは
 * 引けない。** モデルを変えると全話が「未抽出」になり、
 * 「200話ぶん抽出しませんか」と言い出す。
 *
 * 知りたいのは「**抽出したあとに書いた話があるか**」だけである。
 * それなら**更新時刻の比較で足りる**（IME辞書の古さと同じ考え。6.13）。
 *
 * ## 外れる方向を選ぶ
 *
 * - **一度も抽出していない作品では、数を出さない。** 登録した直後に
 *   「19話ぶん抽出しませんか」と言うのは、申し出ではなく催促である
 * - **取りこぼしはある**（本文を直して元へ戻した場合など）。出るのは
 *   申し出だけなので、**言い過ぎるより言わないほうへ外す**
 *
 * VS Code APIに依存しない（時刻の取得は呼び出し側が渡す）。
 */

export interface EpisodeTimestamp {
  filePath: string;
  /** 更新時刻（ミリ秒）。取れなければ undefined */
  modifiedAt: number | undefined;
}

export interface ExtractionFreshness {
  /** 一度でも抽出したことがあるか */
  extracted: boolean;
  /**
   * 抽出したあとに書かれた話の数。
   *
   * **一度も抽出していなければ undefined。** 「0話」でも「全話」でもない。
   * 分からないものを数で言わない。
   */
  unextracted: number | undefined;
}

/**
 * 数える。
 *
 * @param settingsModifiedAt 設定資料がいちばん新しく書かれた時刻。
 *   一度も抽出していなければ undefined
 */
export function countUnextracted(
  episodes: readonly EpisodeTimestamp[],
  settingsModifiedAt: number | undefined
): ExtractionFreshness {
  if (settingsModifiedAt === undefined) {
    return { extracted: false, unextracted: undefined };
  }
  // **時刻の取れなかった話は数えない。** 分からないものを「未抽出」に
  // 寄せると、読めないファイルがあるだけで催促が始まる
  const newer = episodes.filter(
    (episode) =>
      episode.modifiedAt !== undefined && episode.modifiedAt > settingsModifiedAt
  );
  return { extracted: true, unextracted: newer.length };
}

/**
 * 申し出てよいか。
 *
 * **1話だけでは申し出ない。** 書いた直後に毎回言われると、
 * 独り言ではなく催促になる。
 */
export const OFFER_THRESHOLD = 2;

export function shouldOfferExtraction(
  freshness: ExtractionFreshness
): boolean {
  return (
    freshness.unextracted !== undefined &&
    freshness.unextracted >= OFFER_THRESHOLD
  );
}
