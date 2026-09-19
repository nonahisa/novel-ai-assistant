import { parseCollectedFile, type CollectedEpisode } from "./collectedFile";
import { parseLabeledBlocks } from "./workInfoParse";
import {
  parseReaderStatsValue,
  readerStatsMetricInfo,
  type ReaderStatsMetricInfo,
  type ReaderStatsMetrics,
} from "../models/posting";

/**
 * 小説家になろうのバックアップ（投稿済み作品テキストダウンロード）の頭を読む。
 *
 * ## カクヨムのバックアップとは形が違う
 *
 * カクヨムは `about.txt` ＋ `episode_*.txt` に分かれているが、なろうは
 * **Nコードの名前の .txt が1つ**で、頭に作品情報、続けて全話が並ぶ（合本。
 * 話へ割るのは `collectedFile.ts`）。ここが読むのは**最初の区切り行より前**
 * だけで、本文には触らない。
 *
 * ## なろうの数字を読むのは、規約の線の内側である
 *
 * 設計書6.79.7には「なろうは手入力のみ（封筒を受け取らない）」とあるが、
 * **あれはサイトを機械で読むこと（スクレイピング）についての判断**である。
 * ここで読むのは**作者が自分でダウンロードした自分の作品のファイル**で、
 * サイトへは1本もHTTPを発しない。作者の裁定（2026-09-19）：
 * 「ここから取得できるものはカクヨム同様に扱ってよいです」。
 *
 * **この区別を消さないこと。** 「なろうは読んではいけない」と読み違えて
 * ここを外すと、作者がダウンロードした数字まで手で打ち直すことになる。
 *
 * ## 収益情報は読まない
 *
 * 【収益情報】（チアスコア・なろうリワード）は**読者の反応ではない**。
 * 作者の収入の記録を、頼まれてもいないのに作らない（作者の裁定）。
 *
 * VS Code API には依存しない。
 */

/** 話の始まりの区切り行。ここから先は本文なので、頭の読み取りは手前で止める */
const EPISODE_SEPARATOR = /^-{3,}\s*エピソード\s*\d*\s*開始\s*-{3,}$/;

/** なろうの作品ID（Nコード）。**N＋4桁＋英字2文字** */
const NCODE = /^[Nn]\d{4}[A-Za-z]{2}$/;

/**
 * 【評価】の中の行と、台帳の欄の対応。
 *
 * **意味が一致するものだけを共通の欄（`READER_STATS_METRICS`）へ入れる。**
 * 「総合評価ポイント」は評価ptそのもの、「お気に入り登録」はブックマークで、
 * どちらもカクヨムの同じ軸と並べて読める。
 *
 * **残り3つは、なろう固有の欄（`SITE_READER_STATS_METRICS.narou`）へ入れる**
 * （0.69.9。作者の裁定「投稿サイトごとに持ってください」）。人数・素点・平均は
 * カクヨムのどの数字とも同じ軸に乗らないので、**共通の欄へ当てはめない**——
 * 当てはめた先の数字は、あとから見た人には区別が付かない。以前は名前だけを
 * `unmappedRatings` に残して数字を捨てていたが、**捨てる理由はもう無い。**
 */
const RATING_KEYS: ReadonlyArray<{
  /** 【評価】の行の頭にある名前（そのまま） */
  readonly name: string;
  readonly key: string;
}> = [
  { name: "総合評価ポイント", key: "points" },
  { name: "お気に入り登録", key: "bookmarks" },
  { name: "評価者数", key: "narou_raters" },
  { name: "評価ポイント", key: "narou_ratingPoints" },
  { name: "評価平均", key: "narou_ratingAverage" },
];

export interface NarouBackupHeader {
  /** Nコード。**小文字で返す**（URLと封筒の作品IDが小文字のため） */
  readonly ncode: string;
  /** 作品ページのURL（合成したもの）。読みにはいかない */
  readonly workUrl: string;
  /** 【ジャンル】。無ければ null */
  readonly genre: string | null;
  /** 【評価】から読めた数値。読めなければ空 */
  readonly metrics: ReaderStatsMetrics;
  /**
   * 【評価】にあったが、台帳のどの欄にも入れられなかった行の名前。
   *
   * **捨てたことを見えるようにしておく。** 黙って落とすと、次に読む人は
   * 「そもそも入っていない」と思って探しにいく。
   *
   * なろうの評価者数・評価ポイント・評価平均は、0.69.9 で**なろう固有の
   * 欄として台帳へ入るようになった**ので、もうここへは落ちない。ここに
   * 残るのは、なろうが新しく足した見覚えのない行だけである。
   */
  readonly unmappedRatings: readonly string[];
}

/** 話ごとのリアクション1件ぶん */
export interface NarouEpisodeReaction {
  /** 話数（区切り行の「エピソードN開始」のN） */
  readonly episode: number;
  readonly metrics: ReaderStatsMetrics;
}

export interface NarouBackup {
  readonly header: NarouBackupHeader;
  /**
   * 最初の区切り行より前の文字列。
   *
   * 作品情報（題・作者名・ジャンル・あらすじ・キーワード）を読むのに使う
   * ——**本文は1行も入らない**ので、そのまま `parseWorkInfo` へ渡せる。
   * 【ユーザ情報】【評価】【収益情報】は `parseWorkInfo` が見ない欄なので、
   * 作品情報の側へは流れ込まない（評価は台帳へ行くもの、収益は取らない）。
   */
  readonly head: string;
  /**
   * 合本に入っていた話の数（区切り行の数）。
   *
   * **`episodes` の件数とは別物である。** あちらはリアクションを読めた話
   * だけなので、リアクションの無い作品では0件になる。作者に「何話を
   * 取り込みます」と伝えるのはこちらで、**ファイルの数ではない**——
   * なろうの合本は全話で1ファイルなので、ファイルを数えると常に「1話」に
   * なる（2026-09-19、4話の作品で「1話を取り込みました」と出た）。
   */
  readonly episodeCount: number;
  readonly episodes: readonly NarouEpisodeReaction[];
}

/**
 * なろうのバックアップを丸ごと読む。**なろうのものでなければ null。**
 *
 * 頭だけを見たいとき（見分け）は `parseNarouBackupHeader` を使う——
 * 合本は大きいので、なろうのものだと分かってから丸ごと読む。
 */
export function parseNarouBackup(rawText: string): NarouBackup | null {
  const head = headOf(rawText);
  const header = parseNarouBackupHeader(head);
  if (!header) return null;
  // **話へ割るのは1回だけ**（合本は大きい。数と反応を同じ結果から採る）
  const episodes = parseCollectedFile(rawText) ?? [];
  return {
    header,
    head,
    episodeCount: episodes.length,
    episodes: narouEpisodeReactions(episodes),
  };
}

/**
 * なろうのバックアップの頭を読む。**なろうのものでなければ null。**
 *
 * 見分けるのは【Nコード】が読めることだけである——この欄はなろうの
 * ダウンロードにしか無く、形（N＋4桁＋英字2文字）まで決まっている。
 */
export function parseNarouBackupHeader(
  rawText: string
): NarouBackupHeader | null {
  const blocks = parseLabeledBlocks(headOf(rawText));
  const find = (label: string): string | null => {
    const found = blocks.find((block) => block.label === label);
    if (!found) return null;
    const value = found.value.trim();
    return value === "" ? null : value;
  };

  const raw = firstLine(find("Nコード"));
  if (!raw || !NCODE.test(raw)) return null;
  const ncode = raw.toLowerCase();

  const rating = parseRatings(find("評価"));

  return {
    ncode,
    // **合成してよい**のは、Nコードから一意に決まる形だからである
    // （作者の裁定。ドメインの検証は台帳の `validateWorkPageUrl` が行う）
    workUrl: `https://ncode.syosetu.com/${ncode}/`,
    genre: firstLine(find("ジャンル")),
    metrics: rating.metrics,
    unmappedRatings: rating.unmapped,
  };
}

/** 最初の区切り行より前。**本文は1行も見ない** */
function headOf(rawText: string): string {
  const lines = rawText.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((line) => EPISODE_SEPARATOR.test(line.trim()));
  return (at < 0 ? lines : lines.slice(0, at)).join("\n");
}

/**
 * 【評価】の中身を読む。
 *
 *   総合評価ポイント: 2pt
 *   評価者数: 0人
 *   お気に入り登録: 1件
 *   評価ポイント: 0pt
 *   評価平均: 0pt
 *
 * **単位は落として読む**（`2pt` → 2）。読めない行は数として入れない。
 *
 * **評価平均は小数になる**（`4.50pt`）。台帳の欄ごとに小数を受けるか
 * 決まっているので（`fractionDigits`）、読み取りも欄の定義に合わせる
 * ——切り捨てて入れると、元と違う値が残る。
 */
function parseRatings(block: string | null): {
  metrics: ReaderStatsMetrics;
  unmapped: string[];
} {
  const metrics: ReaderStatsMetrics = {};
  const unmapped: string[] = [];
  if (!block) return { metrics, unmapped };

  for (const line of block.split("\n")) {
    const matched = /^\s*([^:：]+)[:：]\s*(.+?)\s*$/.exec(line);
    if (!matched) continue;
    const name = matched[1].trim();
    const found = RATING_KEYS.find((entry) => entry.name === name);
    const info = found ? readerStatsMetricInfo(found.key) : undefined;
    // 対応表にあるのに台帳の欄が無いのは、こちらの取り違えである。
    // 黙って落とさず、捨てたことが見える側（`unmapped`）へ回す
    if (!info) {
      unmapped.push(name);
      continue;
    }
    const count = readValue(matched[2], info);
    // 読めなかった行は**欄ごと持たない**（0で埋めると、次に読んだとき減る）
    if (count === null) {
      unmapped.push(name);
      continue;
    }
    metrics[info.key] = count;
  }
  return { metrics, unmapped };
}

/**
 * 話ごとの【リアクション】を読む（設計書6.99）。
 *
 * **リアクションは各話での読者の反応である**（作者の確認、2026-09-19）。
 * 作品全体の【評価】とは別のもので、話ごとに1件ずつ記録できる。
 *
 * ## なぜ「いいね」の欄へ入れるのか
 *
 * なろうのバックアップは、リアクションを `いいね: 19件` と書くことがある
 * （`collectedFile.ts` に実データの例がある）。数だけの `0件` も同じ欄で、
 * **なろう自身が「いいね」と呼んでいる**ものなので、台帳の `likes`
 * （いいね・星の数）へ入れる。**欄を増やさない**のは、増やせば台帳の
 * 読み書き・手入力の訊く順・画面の並びのすべてに波及し、古い版では
 * その行が消えて見えるためである（判断はリーダーへ報告済み）。
 *
 * ## 話数は区切り行の番号を使う
 *
 * 【エピソードタイトル】から話数を読めないことがある（実物の「１　自殺の
 * 後始末」には「話」が無く、`parseEpisodeTitle` は null を返す）。区切り行の
 * 「エピソードN開始」のNは必ず入っていて、**なろうの掲載順そのもの**である。
 */
export function parseNarouEpisodeReactions(
  rawText: string
): NarouEpisodeReaction[] {
  return narouEpisodeReactions(parseCollectedFile(rawText) ?? []);
}

/** 割り終えた話から反応だけを拾う（合本を2度割らないための分け目） */
function narouEpisodeReactions(
  episodes: readonly CollectedEpisode[]
): NarouEpisodeReaction[] {
  const rows: NarouEpisodeReaction[] = [];
  for (const episode of episodes) {
    if (!episode.reaction) continue;
    const likes = readReaction(episode.reaction);
    // **読めなかったリアクションは記録しない**（0で埋めない）
    if (likes === null) continue;
    if (!Number.isSafeInteger(episode.order) || episode.order < 1) continue;
    rows.push({ episode: episode.order, metrics: { likes } });
  }
  return rows;
}

/** `0件`／`いいね: 19件` → 数。読めない形は null */
function readReaction(value: string): number | null {
  const labeled = /^\s*[^:：]+[:：]\s*(.+?)\s*$/.exec(value);
  const info = readerStatsMetricInfo("likes");
  // 台帳の欄が消えていたら読まない（ここで作り物の欄を足さない）
  return info ? readValue(labeled ? labeled[1] : value, info) : null;
}

/**
 * 「2pt」「1件」「1,234pt」「4.50pt」→ 数。読めない形は null。
 *
 * **小数を受けるかは欄が決める**（`ReaderStatsMetricInfo.fractionDigits`）。
 * ここで一律に受けると、PVに小数が入る道ができてしまう。
 */
function readValue(value: string, info: ReaderStatsMetricInfo): number | null {
  const matched = /^([\d,，０-９.．]+)\s*(pt|件|人|回)?$/.exec(value.trim());
  return matched ? parseReaderStatsValue(matched[1], info) : null;
}

function firstLine(value: string | null): string | null {
  if (value === null) return null;
  const line = value.split("\n")[0]?.trim() ?? "";
  return line === "" ? null : line;
}
