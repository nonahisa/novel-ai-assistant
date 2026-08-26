import { sha1Text } from "./hash";

/**
 * どの話を設定資料へ取り込んだかを、**中身で**覚えておく（設計書6.21.3）。
 *
 * 作者の指摘（2026-08-24）：「GitHubと同期する際、勝手に設定資料の
 * 再抽出が起きる」。
 *
 * ## 更新時刻では、同期と両立しない
 *
 * これまでは**更新時刻**で「抽出したあとに書いた話」を数えていた
 * （6.21.1）。同じ端末で書いている限りは合っている。
 *
 * **だが git は更新時刻を保存しない。** 取り込み（pull）で書き直された
 * ファイルの時刻は「取り込んだ今」になる。中身が1文字も変わっていなくても
 * そうなる。すると、
 *
 * - 本文だけが取り込まれる → 本文の時刻 > 設定資料の時刻
 * - → **全話が「まだ取り込んでいない」**と数えられる
 * - → 独り言が「◯話ぶん抽出しませんか？」と申し出る
 *
 * 別の環境から取り寄せた直後（clone）はもっとはっきり出る。全ファイルが
 * 同じ「今」になるので、書かれた順しだいで全話が未抽出になる。
 *
 * ## 中身のハッシュで覚える
 *
 * 抽出したときに、**その話の中身のハッシュ**を書き留めておく。次に数える
 * ときは、いまの中身のハッシュと突き合わせる。
 *
 * - 取り込んで時刻が変わっても、**中身が同じなら抽出済みのまま**
 * - 別の環境で書かれた新しい話だけが「未抽出」になる
 * - **この記録も同期される。** 別の環境で抽出したなら、こちらでも
 *   抽出済みとして扱えるのが正しい
 *
 * ## キャッシュの鍵は使えない
 *
 * 処理済みチャンクのキャッシュ（`chunkCache.ts`）も中身のハッシュを持つが、
 * **鍵にモデル名とプロンプトの版が畳み込まれている。** モデルを変えた
 * だけで全話が「未抽出」になり、「200話ぶん抽出しませんか」と言い出す。
 * 知りたいのは「取り込んだかどうか」だけなので、別に持つ。
 *
 * VS Code APIに依存しない（読み書きは呼び出し側が行う）。
 */

/** いまの記録の形。将来変えたときに読み分けるために持つ */
export const EXTRACTED_INDEX_VERSION = 1;

export interface ExtractedIndex {
  version: number;
  /** 作品フォルダーからの相対パス → 取り込んだときの中身のハッシュ */
  files: Record<string, string>;
}

export interface EpisodeContent {
  /** 作品フォルダーからの相対パス */
  relativePath: string;
  /** いまの中身。読めなければ undefined */
  text: string | undefined;
}

export function emptyExtractedIndex(): ExtractedIndex {
  return { version: EXTRACTED_INDEX_VERSION, files: {} };
}

/** 話の中身から、記録に使うハッシュを作る */
export function hashEpisode(text: string): string {
  return sha1Text(text);
}

/**
 * 読み込んだ記録を検める。
 *
 * **壊れていたら空として扱う。** 同期対象なので競合マーカーが混ざったり、
 * 手で編集されたりしうる。ここで例外を投げると、独り言が出せなくなる
 * だけでなく、**抽出そのものの完了処理が止まる**。
 */
export function parseExtractedIndex(raw: unknown): ExtractedIndex {
  if (typeof raw !== "object" || raw === null) return emptyExtractedIndex();
  const record = raw as { version?: unknown; files?: unknown };
  if (typeof record.files !== "object" || record.files === null) {
    return emptyExtractedIndex();
  }
  const files: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    record.files as Record<string, unknown>
  )) {
    // 形の合わないものだけを落とす。**全部捨てない**
    if (typeof key === "string" && typeof value === "string" && value) {
      files[key] = value;
    }
  }
  const version =
    typeof record.version === "number" ? record.version : EXTRACTED_INDEX_VERSION;
  return { version, files };
}

/**
 * 抽出したことを記録に反映する。
 *
 * **読めなかった話は書き留めない。** 読めていないものを「取り込んだ」と
 * 記録すると、読めるようになったあとも黙ってしまう。
 *
 * **前の記録は消さない。** 話を減らした（ファイルを消した）だけで、
 * 残りの話の記録まで失うのは筋が悪い。
 */
export function recordExtracted(
  index: ExtractedIndex,
  episodes: readonly EpisodeContent[]
): ExtractedIndex {
  const files = { ...index.files };
  for (const episode of episodes) {
    if (episode.text === undefined) continue;
    files[episode.relativePath] = hashEpisode(episode.text);
  }
  return { version: EXTRACTED_INDEX_VERSION, files };
}

export interface ExtractionFreshness {
  /** 一度でも抽出したことがあるか */
  extracted: boolean;
  /**
   * まだ取り込んでいない話の数。
   *
   * **一度も抽出していなければ undefined。** 「0話」でも「全話」でもない。
   * 分からないものを数で言わない。
   */
  unextracted: number | undefined;
}

/**
 * まだ取り込んでいない話を数える。
 *
 * **読めなかった話は数えない。** 分からないものを「未抽出」に寄せると、
 * 読めないファイルが1つあるだけで催促が始まる。
 */
export function countUnextracted(
  episodes: readonly EpisodeContent[],
  index: ExtractedIndex | undefined
): ExtractionFreshness {
  // 記録が無い＝一度も抽出していない。登録した直後に
  // 「19話ぶん抽出しませんか」は、申し出ではなく催促である
  if (!index || Object.keys(index.files).length === 0) {
    return { extracted: false, unextracted: undefined };
  }

  let unextracted = 0;
  for (const episode of episodes) {
    if (episode.text === undefined) continue;
    const known = index.files[episode.relativePath];
    if (known === undefined || known !== hashEpisode(episode.text)) {
      unextracted++;
    }
  }
  return { extracted: true, unextracted };
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
