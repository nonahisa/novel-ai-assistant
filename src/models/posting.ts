/**
 * 投稿状態の台帳（設計書6.68.2）。
 *
 * **自動投稿はしない**（6.68.1）。4サイトとも投稿用の公式APIが無く、
 * 画面の自動操作は規約違反でアカウント凍結の危険がある。ここが持つのは
 *
 *   - どの話を、どのサイトへ、いつ出したか（`posts`）
 *   - 作者が貼った「新規エピソード投稿ページ」のURL（`sites`）
 *
 * の2つだけで、**サイトへ触りにいく処理は1つも無い。**
 *
 * 話の指し方は**作品フォルダからの相対パス**（章立て・挿絵・年表と同じ）。
 * 話数は並べ替えや改題で動くが、パスはその話そのものを指し続ける。
 *
 * VS Code API には依存しない（`models` の約束）。
 */

import { normalizeEpisodePath } from "./chapter";
import {
  invalid,
  objectValue,
  optionalBoolean,
  optionalNullableNumber,
  optionalObjectArray,
  optionalString,
  requireNonEmptyString,
} from "./jsonValidation";

/*
  この台帳は**サイトごとの作品情報とランキングも持つ**（設計書6.68.5）。
  どちらも**作者が手で入れた値だけ**である——サイトを読みにいく処理は
  1行も無い（6.68.1と同じ線）。
*/

/** 保存先のファイル名。`設定/` の直下に置く（Gitで同期する） */
export const POSTING_FILE = "投稿状態.json";

export const POSTING_SCHEMA_VERSION = "1";

export type PostingSiteId = "narou" | "kakuyomu" | "alphapolis" | "note";

export interface PostingSiteInfo {
  id: PostingSiteId;
  /** 作者に見せる名前。IDのままでは何のことか分からない */
  label: string;
  /**
   * 投稿ページのURLとして受け付けるドメイン。
   *
   * **確かめるのは「そのサイトか」だけ**（6.68.1）。作品IDやパスの形は
   * サイト側の都合で変わるうえ、確かめるにはページを読みにいくことになる。
   * 読みにいかないのがこの機能の前提なので、ドメインで止める。
   */
  domain: string;
  /** 入力欄に出す例。どこのURLを貼ればよいのかを言葉より早く伝える */
  urlExample: string;
  /**
   * 作品IDの入力欄に出す例（設計書6.68.5）。
   *
   * **サイトごとに形が違う。** なろうはNコード（`n1234ab`）、カクヨムは
   * 作品ページURLの数字、**アルファポリスは「作者番号＋作品番号」の
   * 2部構成**である。全部に `n1234ab` を出していたころは、なろう以外の
   * サイトで何を入れればよいのか分からず、作者番号だけを入れた作品IDが
   * 台帳に残った——貼り込み係の照合はその形を当てにできない
   * （URLを合成しない理由は `core/snsShare.ts` に書いてある）。
   *
   * noteには「作品」の単位が無いので、空のままでよいと言い切る。
   */
  workIdExample: string;
  /**
   * ルビの出し方（`core/ruby.ts` の `RubyStyle["id"]` と同じ値）。
   *
   * **値を書き写しているのは、`models` が `core` に依存しないため**
   * （依存の向きは views/features → core → models）。取り違えると
   * 貼り付けた先で記号が並ぶので、`test/unit/models/posting.test.ts` が見張る。
   */
  notation: "site" | "paren";
  /**
   * 傍点の出し方（`core/ruby.ts` の `EmphasisSite` と同じ値）。
   *
   * **ルビの記法があるサイトでだけ効く。** noteは括弧書き（`paren`）へ
   * 落とすので、ここに何を書いても結果は変わらない。
   */
  emphasis: "kakuyomu" | "narou";
}

/**
 * 対象にできるサイト（作者の依頼、2026-09-04）。
 *
 * **並びは作者が投稿する順**（なろう→カクヨム→アルファポリス→note）に
 * してある。キットはこの順にサイトを回る。
 */
export const POSTING_SITES: readonly PostingSiteInfo[] = [
  {
    id: "narou",
    label: "小説家になろう",
    domain: "syosetu.com",
    urlExample:
      "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n0000aa/",
    workIdExample: "n1234ab（Nコード）",
    notation: "site",
    // なろうには傍点の記法が無く、ルビで代用する（6.12.4）
    emphasis: "narou",
  },
  {
    id: "kakuyomu",
    label: "カクヨム",
    domain: "kakuyomu.jp",
    urlExample: "https://kakuyomu.jp/my/works/0000000000/episodes/new",
    workIdExample: "16816927859（作品ページURLの数字）",
    notation: "site",
    emphasis: "kakuyomu",
  },
  {
    id: "alphapolis",
    label: "アルファポリス",
    domain: "alphapolis.co.jp",
    /*
      **作者用のページは /mypage/ の下**（2026-11-01 作者の Chrome で確かめた）。
      新しい話は /mypage/novel/save_episode/{作品ID}、作品IDは数字9桁。
      0.116.1 までは /novel/manage/… の例と「作者番号／作品番号」の作品IDを出していたが、
      どちらも実在しない形で、ヘルパー 0.14.2 の照合（9桁の作品ID）では取り違えとして止まる
    */
    urlExample: "https://www.alphapolis.co.jp/mypage/novel/save_episode/000000000",
    workIdExample: "000000000（作品IDの数字9桁。投稿画面のURLの末尾の数字）",
    notation: "site",
    // アルファポリスもなろうと同じくルビで代用する
    emphasis: "narou",
  },
  {
    id: "note",
    label: "note",
    domain: "note.com",
    urlExample: "https://note.com/notes/new",
    // noteには「作品」の単位が無い（記事とマガジン）。空のままでよい
    workIdExample: "空のままで構いません（noteでは使いません）",
    // **noteにはルビの記法が無い**ので括弧書きへ落とす（6.68.3）
    notation: "paren",
    emphasis: "kakuyomu",
  },
];

export function postingSiteInfo(id: PostingSiteId): PostingSiteInfo {
  const found = POSTING_SITES.find((site) => site.id === id);
  // 一覧に無いIDは読み込みで弾いている。ここへ来るのは書き間違えのとき
  if (!found) invalid(`site（${id}）`);
  return found;
}

/** サイトの名前を並べる（「小説家になろう・note」） */
export function postingSiteLabels(ids: readonly PostingSiteId[]): string {
  // **並びは `POSTING_SITES` の順に揃える。** 呼ぶ場所ごとに順番が違うと、
  // 一覧の印とキットの案内で「どのサイトが遅れているか」の並びが食い違う
  return POSTING_SITES.filter((site) => ids.includes(site.id))
    .map((site) => site.label)
    .join("・");
}

/**
 * そのサイトでの、この作品の情報（設計書6.68.5）。
 *
 * **すべて任意で、すべて作者の手入力である。** サイトから取ってこない
 * ので、空のまま使い続けられることが仕様の一部になる（訊かれて答えられ
 * ない項目を必須にしない）。
 */
export interface PostingSiteProfile {
  /** サイト内の作品ID（なろうのNコードなど） */
  workId?: string;
  /** 作品ページのURL。**そのサイトのドメインだけ**受ける */
  workUrl?: string;
  /** サイトのジャンル。呼び方はサイトごとに違うので自由入力 */
  genre?: string;
  /** 作者のメモ。こちらからは書き換えない */
  note?: string;
}

/**
 * 台帳直下に持つ、サイトごとの作品情報（設計書6.68.5）。
 *
 * **投稿先の登録（`sites`）とは別の配列である。** 0.32.0 までは
 * `sites[].profile` に入れていたが、投稿サイトの設定でチェックを外すと
 * `sites` の置き換えに巻き込まれて**作者が書いたメモごと消えていた**。
 * 順位（`rankings`）と同じく、登録とは独立して残す。
 */
export type PostingSiteProfileEntry = { site: PostingSiteId } & PostingSiteProfile;

export interface PostingSiteEntry {
  site: PostingSiteId;
  /** 作者が貼った新規エピソード投稿ページのURL（作品IDを含む） */
  newEpisodeUrl: string;
}

/**
 * 作者が画面で見た順位の記録（設計書6.68.5）。
 *
 * **ランキングのページを機械で読まない。** ページを読むのは6.68.1で断った線の内側にある。
 * ここに入るのは、作者が見て打った値と、**作者が同意して押したときだけ**なろう殿堂入りAPI
 * から取った、その作品自身の順位（`source: "narou-api"`。作者の指示 2026-11-02）だけである。
 */
export interface PostingRankingRecord {
  site: PostingSiteId;
  /**
   * 記録した日時（ISO8601）。手入力は順位が出た日時ではなく、書き留めた日時。
   * **API から取った順位（`source: "narou-api"`）だけは、順位が出た日**（殿堂入りの
   * `rtype` の日付の 0:00、日本時間）——取った時刻にすると、何年ぶんの履歴が
   * 1つの日時に潰れてグラフにならない
   */
  recordedAt: string;
  /** 種別。日間・週間・月間・ジャンル名など、**サイトの呼び方のまま** */
  board: string;
  /** 順位。1以上の整数 */
  rank: number;
  /** 作者のメモ（任意） */
  note?: string;
  /**
   * 出どころ。**手入力には付けない**（欄が無い＝作者が打った）。
   * `"narou-api"` はなろう殿堂入りAPIから取った順位で、**AI へ渡す材料に入れない**
   * （作者が運営へ約束した使い方。2026-11-02）。
   * `"helper"` はヘルパーが作者の開いたランキングの画面で読んだ順位（2026-11-02。
   * 束の `rankings`）。このときの `board` は**区分の鍵**（ヘルパーが付ける機械向けの名前）で、
   * 画面に出すのは `boardLabel`
   */
  source?: PostingRankingSource;
  /**
   * 画面の見出しのまま（ヘルパーの順位だけ）。グラフの線・表の種別に出す。
   * 無ければ `board` を出す（手入力は `board` がそのまま作者の言葉）
   */
  boardLabel?: string;
  /** 期間（ヘルパーの順位だけ。`POSTING_RANKING_SPANS`） */
  span?: PostingRankingSpan;
  /** ジャンル（ヘルパーの順位だけ。画面の書き方のまま） */
  genre?: string;
}

/** 順位の出どころ（手入力は欄そのものを持たない） */
export type PostingRankingSource = "narou-api" | "helper";

/** ヘルパーの順位の期間（ヘルパーとの取り決め 2026-11-02） */
export const POSTING_RANKING_SPANS = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "total",
  "24h",
  "other",
] as const;

export type PostingRankingSpan = (typeof POSTING_RANKING_SPANS)[number];

export function isPostingRankingSpan(value: unknown): value is PostingRankingSpan {
  return typeof value === "string" && (POSTING_RANKING_SPANS as readonly string[]).includes(value);
}

/** 画面に出す種別の名前（ヘルパーの順位は見出し、手入力・API は `board` のまま） */
export function rankingBoardLabel(record: Pick<PostingRankingRecord, "board" | "boardLabel">): string {
  return record.boardLabel ?? record.board;
}

/**
 * **サイトをまたいで比べられる軸**（設計書6.79.7）。
 *
 * カクヨムのPVとなろうのPVは、呼び方が違っても同じものを数えている。
 * ここに載るのは**どのサイトでも意味が同じ**と言い切れるものだけである。
 */
export type ReaderStatsCommonMetric =
  | "pv"
  | "unique"
  | "bookmarks"
  | "points"
  | "likes"
  | "comments"
  | "reviews";

/**
 * 読者の反応の数値（設計書6.79.7）。
 *
 * **読めた欄だけを持つ。** 「読めなかった」を0で埋めると、次に読んだときに
 * 減ったように見える——PVが0の日と、PVを読めなかった日は別のことである。
 *
 * **共通の7つに加えて、サイト固有の欄も入る**（0.69.9。作者の裁定：
 * 「投稿サイトごとに持ってください」）。固有の欄の名前は
 * `SITE_READER_STATS_METRICS` が決め、**サイトIDで始まる**ので共通の欄と
 * ぶつからない（`narou_raters` など）。
 *
 * 添字の型が `number | undefined` なのは、**小数を受ける欄があるため**
 * （なろうの評価平均）。整数しか受けない欄との線引きは
 * `ReaderStatsMetricInfo.fractionDigits` が持つ——型では分けられない。
 */
export interface ReaderStatsMetrics
  extends Partial<Record<ReaderStatsCommonMetric, number>> {
  [key: string]: number | undefined;
}

export interface ReaderStatsMetricInfo {
  /**
   * 台帳に書く欄の名前。
   *
   * **サイト固有のものは、必ずサイトIDで始める**（`narou_raters`）。
   * 共通の7つとぶつかると、別のサイトの数字が同じ軸に乗ってしまう。
   */
  key: string;
  /** 画面と入力欄に出す名前。**そのサイトの呼び方のまま** */
  label: string;
  /** 数のあとに付ける単位（評価の「pt」）。無ければ付けない */
  unit?: string;
  /** 入力欄に出す例 */
  example: string;
  /**
   * 小数を受ける欄なら、画面に出す小数の桁数。
   *
   * **無い欄は整数しか受けない**（既定）。PVやブックマークに小数が
   * 入ることは無く、そこを緩めると打ち間違いが黙って台帳へ入る。
   * なろうの「評価平均」だけが小数になるので、欄ごとに分ける。
   */
  fractionDigits?: number;
  /**
   * **日別の行では、その日の増減として負も受ける欄**（残課題 B11 の続き、
   * 作者の裁定 2026-09-23）。
   *
   * Narou.fun の日ごとの表は累計で、貼り込み係が前の日との差を取って日別の
   * 行にする。ブックマークは外されることがあるので、**減った日は負になる**
   * ——作者の裁定は「マイナスとして残す」。
   *
   * **負を受けるのは、この印のある欄の、日別（`period: "day"`）の行だけ。**
   * その時点の値・月別・年別・累計はこれまでどおり0以上。PVのように減りようの
   * ない欄にも付けない（負が入れば、それは読み違いである）。整数だけなのも同じ。
   * 手入力（`validateReaderStatsValue`）は緩めない——打ち間違いの「-」を黙って
   * 入れないため。
   */
  dailyChange?: true;
  /**
   * **小さいほど良い数**（順位。アルファポリスの累計・24時間の順位。作者の指示 2026-11-01）。
   *
   * ほかの欄は「増えたら良い」なので、グラフや増減の色をこの欄に当てると、
   * 1位へ上がった（数が減った）のが悪くなったように見える。**この印のある欄は
   * 増減のグラフ（`dailyChange`）に載せない**し、増減の色を付ける処理を足すときは
   * ここを見て向きを逆にすること。表の数のほか、**順位の推移のグラフ**（`core/rankSeries.ts`。
   * 縦の軸を上下逆にした折れ線。2026-11-02）に、この印のある欄がすべて載る。
   */
  lowerIsBetter?: true;
}

/**
 * サイトをまたいで比べられる指標と、その並び（設計書6.79.7）。
 *
 * **共通の一覧はここ1つだけが持つ。** 手入力の訊く順・封筒の読み取り・
 * 画面の並びが同じ順になるようにする（写しを作ると、片方だけ増えて欄が消える）。
 *
 * サイト固有のものは `SITE_READER_STATS_METRICS` にある。**両方を順に
 * 並べたものが欲しいときは `readerStatsMetricsFor(site)` を呼ぶ**——
 * 呼ぶ側で連結すると、並びがそのつど変わる。
 */
export const READER_STATS_METRICS: readonly (ReaderStatsMetricInfo & {
  // 共通の欄は**打ち間違えたらビルドで止まる**ようにしておく
  key: ReaderStatsCommonMetric;
})[] = [
  { key: "pv", label: "PV", example: "1234" },
  { key: "unique", label: "ユニーク", example: "567" },
  // 日別の行では増減（外された日は負。Narou.fun の日ごとの表から）
  { key: "bookmarks", label: "ブックマーク", example: "89", dailyChange: true },
  { key: "points", label: "評価", unit: "pt", example: "780" },
  { key: "likes", label: "いいね", example: "42" },
  { key: "comments", label: "コメント", example: "3" },
  { key: "reviews", label: "レビュー", example: "1" },
];

/**
 * **サイト固有の指標**（0.69.9。設計書6.79.7／6.99）。
 *
 * ## ここが唯一の置き場である
 *
 * 次のサイトの指標を足す人は、**この表に1行足すだけで済む**ようにしてある。
 * 手入力の訊く順（`features/readerStats.ts`）・封筒の読み取り
 * （`core/readerStatsEnvelope.ts`）・画面の並び
 * （`core/postingSiteRecords.ts`）は、どれもこの表を見る。
 *
 * ## 共通の7つに混ぜない理由
 *
 * なろうの「評価者数」は人数、「評価ポイント」は素点、「評価平均」は平均で、
 * **どれも共通の欄とは意味が一致しない。** 無理に `points` や `bookmarks`
 * へ当てはめると、あとから見た人には区別が付かない——カクヨムの数字と
 * 並べたときに、同じ軸に乗っていないものが同じ軸に見える。
 *
 * ## 決まりごと
 *
 * 1. **`key` はサイトIDで始める**（共通の欄・別のサイトの欄とぶつからない）
 * 2. **`label` はサイトの呼び方のまま**（管理画面と見比べられるように）
 * 3. 小数になる欄には `fractionDigits` を付ける（付けない欄は整数だけ）
 *
 * ## 古い版が読むとどうなるか
 *
 * `設定/` はGitで同期するので、**この表を知らない版がこの台帳を読む**。
 * 古い版は知らない欄を落として書き戻すので、**共通の欄も一緒に入っている
 * 行では、固有の欄だけが静かに消える**（固有の欄しか無い行は、行ごと
 * 生のまま持ち回されるので消えない）。0.69.9 以降の版どうしでは起きない。
 * **この限界は消せない**——古い版はもう配ってあり、直せない。
 */
export const SITE_READER_STATS_METRICS: Readonly<
  Record<PostingSiteId, readonly ReaderStatsMetricInfo[]>
> = {
  narou: [
    { key: "narou_raters", label: "評価者数", unit: "人", example: "12" },
    // 日別の行では増減（Narou.fun の日ごとの表の「評価」＝評価P。評価の取り消しで減りうる）
    {
      key: "narou_ratingPoints",
      label: "評価ポイント",
      unit: "pt",
      example: "120",
      dailyChange: true,
    },
    {
      key: "narou_ratingAverage",
      label: "評価平均",
      unit: "pt",
      example: "4.50",
      // 「0pt」とも「4.50pt」とも書かれる（実データ、2026-09-19）
      fractionDigits: 2,
    },
    /*
      Narou.fun の作品頁にある「週間読者」（残課題 B11、2026-09-23）。
      **直近1週間の窓の人数**で、累計のユニーク（共通の `unique`）とは別物
      ——共通の欄へ当てはめると、カクヨムの累計と同じ軸に見えてしまう。
      母艦の粒度に週は無い（day／month／year／total）ので、期間ではなく
      **その時点の値**として持ち、窓の長さは名前が言う。
    */
    { key: "narou_weeklyReaders", label: "週間読者", unit: "人", example: "111" },
  ],
  kakuyomu: [],
  /*
    アルファポリスの管理画面の数（ヘルパー 0.17.0。作者の指示 2026-11-01）。
    共通の名前で来るもの（累計ポイント→points・お気に入り→bookmarks・いいね→likes）の
    ほかに、意味の合わない数をここに置く。並びはヘルパーの取り決めの順のまま。

    - **順位は小さいほど良い**（`lowerIsBetter`）。増減のグラフには載せない
    - しおり（`alphapolis_bookmarks`）は共通の `bookmarks`（お気に入り＝人数）と別物。
      話ごとに数える「しおりを挟んだ数」なので、同じ軸に乗せない
    - ハートは何を数えるかが未確認（作者の画面の一覧の数）。名前は画面の呼び方のまま
  */
  alphapolis: [
    { key: "alphapolis_points24h", label: "24時間ポイント", unit: "pt", example: "300" },
    {
      key: "alphapolis_rankTotal",
      label: "累計ランキング",
      unit: "位",
      example: "1234",
      lowerIsBetter: true,
    },
    {
      key: "alphapolis_rank24h",
      label: "24時間ランキング",
      unit: "位",
      example: "56",
      lowerIsBetter: true,
    },
    { key: "alphapolis_hearts", label: "ハート", unit: "個", example: "7" },
    { key: "alphapolis_bookmarks", label: "しおり", unit: "個", example: "12" },
    { key: "alphapolis_yells", label: "エール", unit: "回", example: "3" },
    { key: "alphapolis_typoReports", label: "誤字報告", unit: "回", example: "1" },
  ],
  note: [],
};

/**
 * そのサイトで扱う指標を、訊く順・並べる順で返す。
 *
 * **共通が先、固有があと。** サイトをまたいで比べる軸を先に見せたい
 * （固有のものは、そのサイトを知っている人にしか意味が分からない）。
 */
export function readerStatsMetricsFor(
  site: PostingSiteId
): readonly ReaderStatsMetricInfo[] {
  return [...READER_STATS_METRICS, ...SITE_READER_STATS_METRICS[site]];
}

/**
 * 台帳に現れうる指標の全部（共通＋全サイトの固有）。
 *
 * **読み書きはサイトで絞らない。** 絞ると、作者がサイトを選び直したり
 * 台帳を手で直したりしたときに、**書いてある数字が読めなくなって消える**
 * ——読むときは寛容に、訊くときだけサイトで絞る。
 */
export const ALL_READER_STATS_METRICS: readonly ReaderStatsMetricInfo[] = [
  ...READER_STATS_METRICS,
  ...POSTING_SITES.flatMap((info) => SITE_READER_STATS_METRICS[info.id]),
];

/** 欄の名前から定義を引く。知らない欄は `undefined`（呼ぶ側が飛ばす） */
export function readerStatsMetricInfo(
  key: string
): ReaderStatsMetricInfo | undefined {
  return ALL_READER_STATS_METRICS.find((info) => info.key === key);
}

/** 作品全体の数字か、1話ぶんの数字か */
export type ReaderStatsScope = "work" | "episode";

/**
 * 解析の粒度。**無ければ「その時点の値」**（累計の表示をそのまま写したもの）。
 */
export type ReaderStatsPeriod = "day" | "month" | "year" | "total";

export const READER_STATS_PERIODS: readonly ReaderStatsPeriod[] = [
  "day",
  "month",
  "year",
  "total",
];

/**
 * その数字がどこから来たか。
 *
 * - `manual`：作者が打った
 * - `helper`：作者が開いた管理画面を、貼り込み係が読んだ封筒（6.79.7）
 * - `backup`：**作者がダウンロードしたバックアップに入っていた**（6.99）
 *
 * **`backup` を `helper` や `manual` に紛れ込ませない。** 出どころが違えば
 * 「いつの数字か」の意味も違う（バックアップの数字は、作者がダウンロード
 * した時点のもので、取り込んだ日のものではない）。あとから見た人が
 * 区別できなくなる畳み方はしない。
 *
 * - `narou-api`：**作者が同意して押したときだけ、なろう小説APIから取った**その作品自身の数
 *   （作者の指示 2026-11-02）。**AI へ渡す材料に入れない**（`isApiDerivedReaderStats`。
 *   作者がなろうの運営へ約束した使い方）。ヘルパーの数と混ぜないのも同じ理由
 */
export type ReaderStatsSource = "helper" | "manual" | "backup" | "narou-api";

/**
 * 受け付ける出どころの一覧。**一覧はここ1つだけが持つ**（指標と同じ流儀）。
 *
 * **古い版はこの一覧を知らない。** `設定/` はGitで同期するので、`backup` を
 * 知らない版が読むと、**台帳ごと読めなくなる**（行を飛ばす仕組みは指標に
 * しか無い）。増やすときは、その影響を承知のうえで増やすこと。
 *
 * `narou-api`（2026-11-02）を足したときの影響：0.69.9 以降の版は知らない出どころの行を
 * **生のまま控えて書き戻す**（`skippedReaderStatsRows`）ので、数も印も消えない。
 * 0.67.1 以前の版は、API で取った行のある台帳を読めなくなる（直せない。承知のうえで足した）。
 */
export const READER_STATS_SOURCES: readonly ReaderStatsSource[] = [
  "helper",
  "manual",
  "backup",
  "narou-api",
];

/**
 * API から取った記録か（作者の指示 2026-11-02）。**AI へ渡す材料を作る所は、必ずこれで除く。**
 *
 * なろう小説API・なろう殿堂入りAPIの数は、作者が運営へ「AI に渡さない」と約束して
 * 使っている。読者の反応の助言・相談・MCP の道具が同じ材料（`buildReaderAdviceMaterials`）
 * を通るので、そこで除けば3つの道が一度に閉じる。
 */
export function isApiDerivedReaderStats(record: { source?: string }): boolean {
  return record.source === "narou-api";
}

/** AI へ渡してよい記録だけを残す（`isApiDerivedReaderStats` の逆。並びは保つ） */
export function readerStatsForAi<T extends { source?: string }>(
  records: readonly T[]
): T[] {
  return records.filter((record) => !isApiDerivedReaderStats(record));
}

/**
 * 読者の反応の記録（設計書6.79.7）。
 *
 * **追記だけで、畳まない**（順位と同じ流儀）。同じ日に2回読めば2件になる
 * ——これは「いま何件か」の台帳ではなく、「いつ何件だったか」の履歴である。
 *
 * **ページを読みにいく処理は無い**（6.68.1の線はそのまま）。入るのは作者が打った値か、
 * 作者が自分で開いた管理画面から貼り込み係が作った封筒、それと**作者が同意して押した
 * ときだけ**なろう小説APIから取ったその作品自身の数（`source: "narou-api"`。設計書6.79.7.4）だけである。
 */
export interface ReaderStatsRecord {
  site: PostingSiteId;
  /** 読み取った日時（ISO8601）。サイトが集計した時刻ではない */
  readAt: string;
  scope: ReaderStatsScope;
  /** 話数。`scope` が `"episode"` のときだけ入る（読めないこともある） */
  episode?: number;
  period?: ReaderStatsPeriod;
  /** 期間の見出し（"2026-09-05"／"2026-09"／"2026"）。粒度と対で持つ */
  periodKey?: string;
  metrics: ReaderStatsMetrics;
  source: ReaderStatsSource;
  /** 作者のメモ（任意） */
  note?: string;
  /**
   * その話の**サイト上の最終更新の日時**（ISO 8601。時差つき）。
   * 話ごとの記録（`scope: "episode"`）にだけ入りうる。
   *
   * 離脱率・ブックマーク率・評価率の「基準の話」を選ぶのに使う
   * （`core/readerRates.ts`）。更新した直後の話はまだ読まれ切っていないので、
   * 読み取りの72時間以上前に更新された話だけを基準にする。
   *
   * **読めなければ欄ごと持たない**（空文字にしない）。
   */
  updatedAt?: string;
}

export interface PostingRecord {
  /** 作品フォルダからの相対パス（区切りは `/`） */
  episodePath: string;
  site: PostingSiteId;
  /** 投稿したと作者が答えた日時（ISO8601） */
  postedAt: string;
  /**
   * **導入時にまとめて入れた記録**（基準線）。実際の投稿には付けない。
   *
   * この機能を使い始めるまでに出した話は、こちらが日時を知らない
   * （`postedAt` は導入した時刻でしかない）。**「投稿しました」と答えた
   * 記録と混ぜない**ようにしておかないと、あとから台帳を読んだときに
   * 実際の更新日時として読まれてしまう。
   *
   * 省略できる（既にある台帳を読めなくしないため。無い＝実投稿）。
   */
  importedBaseline?: boolean;
  /**
   * 合本（1ファイルに複数話）の中の**1話だけ**を指す記録のときの話数。
   *
   * **ファイルまるごとの記録には入らない**（合本でないファイル、基準線、
   * そしてこの欄ができる前の記録）。欄が無い記録は「そのファイルの全話を
   * 投稿済み」と読む——以前は合本でも全話ぶんの本文をコピーしていたので、
   * その読みが当時の事実と合う。
   */
  chapter?: number;
  /**
   * 話数が読めない話（「プロローグ」など）の代用。ファイル内の並び順
   * （1始まり。`CollectedEpisode.order`）で、`chapter` が無いときだけ入る。
   *
   * **並び順を話数の欄に入れない。** プロローグのある合本では1つずれるので、
   * 「3番目」と「第3話」が同じ記録になってはいけない。
   */
  order?: number;
  /**
   * 投稿したときの本文の印（設計書6.68.7。作者の裁定 2026-11-03 昼）。
   * `core/postingBodyHash.ts` の `postingTextHash` で取った値。
   *
   * 形は3つある（`isNotationTextHash`・`isTitledTextHash`）。0.126.4 からはルビ・傍点の書き方を
   * 寄せてから取った題と本文の印で、頭に `v3:` が付く（`postingNotationTextHash`）。
   * 0.124.1〜0.126.3 は**話の題と本文の両方**の印で、頭に `v2:` が付く。
   * 0.124.0 の印は本文だけの16進64字（頭に何も付かない）。
   *
   * **これから投稿する分からしか入らない。** 無い記録（それより前の投稿・基準線）は、
   * 投稿のあとに直したかどうかが「分からない」——出し直しが要るとは言わない。
   */
  bodyHash?: string;
  /**
   * 投稿したときの題（サブタイトル）だけの印（設計書6.68.7。0.125.2 から。省略できる）。
   * `core/postingBodyHash.ts` の `postingTitleHash` で取った16進64字。
   *
   * **`bodyHash` と別に持つのは、出し直しの案内で「題も貼り替えてください」を添えるため**
   * （作者の裁定 2026-11-03 夜）。`bodyHash` は題と本文を繋いだ1つの印なので、違っても
   * 題を直したのか本文を直したのかを切り分けられない。**題の文字列ではなく印で持つ**——
   * 本文の印と同じ形の決まりで読めて（崩れた値を止めやすい）、台帳に題の写しを増やさない
   * （題の正は原稿の側にあり、写しは原稿の題を直したときに古いまま残る）。
   *
   * 無い記録（0.125.1 までの投稿・基準線）は、題を直したかが「分からない」——案内に添えない。
   */
  titleHash?: string;
  /**
   * サイトが振った話の番号（任意。設計書6.68.7）。あれば出し直しで話の編集画面を直に開く。
   *
   * 台帳はサイトを読みにいかない（6.68.1）ので、ここへ入るのはヘルパーが投稿のあとに
   * 送り返した値だけ（`withSiteEpisodeId`）。**作者の投稿日時を塗り替えないよう、
   * 投稿の記録の欄として足した**（別の配列にすると、どの投稿のIDかを結び直すことになる）。
   */
  siteEpisodeId?: string;
  /**
   * ヘルパーへ渡した貼り込みの札（任意。設計書6.68.8）。封筒（`novelai-post`）でコピーして
   * 投稿した話にだけ入る。ヘルパーが投稿のあとに送り返す封筒（`novelai-posted`）の札と照らして、
   * どの話の番号かを決める。
   *
   * **投稿の記録の欄にしたのは、札が指すのが「その投稿」だから**（別の配列にすると、
   * 貼り込んだのに投稿しなかった札まで溜まり、片づける決まりが要る）。
   */
  postRef?: string;
}

/**
 * 修正版を出し直した記録（設計書6.68.7。作者の依頼 2026-11-03「修正後再投稿に対応してください」）。
 *
 * **投稿の記録（`posts`）とは別の配列に持つ。** 出し直しは新しい話を出したことにならないので、
 * `posts` に混ぜると未投稿の数や「投稿した日時」が狂う。`posts` に欄を足す形にしなかったのは、
 * 投稿した日時（読者が初めて読めた日）を出し直しの日時で塗り替えないため。
 *
 * **履歴で持つ**（同じ話・同じサイトでも足していく。作者の裁定 2026-11-03 昼「履歴は見れなくするか、
 * 折り畳んでください」）。0.123.0 の台帳は同じ話・サイトを1件に保っていたが、同じ配列の形なので
 * そのまま読める。画面に出すのは最新の1件だけ（`revisionFor`）。
 * 話の指し方は `PostingRecord` と同じ（合本の1話は `chapter` か `order`）。
 */
export interface PostingRevisionRecord {
  /** 作品フォルダからの相対パス（区切りは `/`） */
  episodePath: string;
  site: PostingSiteId;
  /** 作者が「出し直しました」と答えた日時（ISO8601） */
  revisedAt: string;
  chapter?: number;
  order?: number;
  /** 出し直したときの本文の印（`PostingRecord.bodyHash` と同じ形。0.124.0 から） */
  bodyHash?: string;
  /** 出し直したときの題だけの印（`PostingRecord.titleHash` と同じ形。0.125.2 から） */
  titleHash?: string;
}

/**
 * 投稿の記録が指す先（設計書6.68.2）。**ファイルか、合本の中の1話か。**
 *
 * 合本でないファイルは、これまでどおり相対パスの文字列だけで指せる
 * （`PostingEpisodeTargetLike`）。既にある台帳の記録と同じ鍵になる。
 */
export interface PostingEpisodeTarget {
  /** 作品フォルダからの相対パス */
  episodePath: string;
  /**
   * 合本の中の話数。**読めなければ `null`** にして `order` で代用する
   * （並び順を話数として名乗らせない）。省略＝ファイルまるごと。
   */
  chapter?: number | null;
  /** 合本の中の並び順（1始まり）。`chapter` が `null` のときに使う */
  order?: number;
}

/** 文字列は「ファイルまるごと」を指す（合本でないファイルの呼び方） */
export type PostingEpisodeTargetLike = string | PostingEpisodeTarget;

export interface PostingLedger {
  schemaVersion: string;
  /** この作品を出すサイトと、その投稿ページ。空なら投稿キットは未設定 */
  sites: PostingSiteEntry[];
  /**
   * サイトごとの作品情報（6.68.5）。**`sites` とは独立して残る。**
   *
   * 投稿先から外したサイトの作品情報も、ここに残り続ける（順位と同じ）。
   * この欄が無い台帳（旧形式）は、`sites[].profile` から持ち上げて読む。
   */
  siteProfiles: PostingSiteProfileEntry[];
  posts: PostingRecord[];
  /**
   * 修正版を出し直した記録（6.68.7）。**未投稿の数には効かない**（`posts` だけを見る）。
   *
   * この欄が無い台帳（これより前のもの）は、出し直しが1件も無いとして読む。
   */
  revisions?: PostingRevisionRecord[];
  /**
   * 順位の記録（6.68.5）。**追記だけ**で、古い記録は書き換えない。
   *
   * この欄が無い台帳（この機能より前のもの）は空として読む。
   */
  rankings: PostingRankingRecord[];
  /**
   * 読者の反応の記録（6.79.7）。**順位と同じく追記だけ。**
   *
   * この欄が無い台帳（この機能より前のもの）は空として読む。
   */
  readerStats: ReaderStatsRecord[];
  /**
   * サイトごとの今のタグ・連載の状態・覚えた理由（作者の指示 2026-11-01）。
   * **サイトごとに1件**で、届いた封筒の `readAt` が新しいときだけ書き換える。
   *
   * 任意の欄にしてあるのは、この欄を知らない台帳（これより前のもの）を
   * そのまま読めるようにするため。無ければ空として扱う。
   */
  siteFacts?: PostingSiteFacts[];
  /**
   * タグの付け替えの記録（作者の指示 2026-11-01「付け替えた日を残す」）。
   * **追記だけ**で、古い記録は書き換えない（順位・読者の反応と同じ流儀）。
   */
  tagChanges?: PostingTagChange[];
  /**
   * 作品としての「連載中／完結」（作者の選択「両方」2026-11-01）。
   *
   * **作者が決めた値だけが入る。** サイトから届いた印は `siteFacts` にしか書かず、
   * ここへ写す処理は無い（作者が決めた値が勝つ。実装ルール2）。まだ決めていない
   * 作品では欄ごと無く、画面はサイトの印を「初めの値の提案」として出す。
   */
  completion?: PostingWorkCompletion;
}

/**
 * 連載の状態（ヘルパーの封筒の `completion` と同じ値）。
 *
 * **休載（`hiatus`）は作者の判断で足した**（2026-11-01）。ヘルパーはいま連載中と完結しか
 * 送らない（0.16.0）。休載に当たる値を送るようになったら、この名前で受ける約束にする。
 *
 * 並びは選ぶ画面の並びそのまま。**知らない値を台帳で読んだら、その欄だけ読まずに
 * 生のまま持ち回る**（`readPostingLedger`）——ここへ値を足した新しい版の台帳を、
 * 古い版が開いても投稿の記録ごと止まらないように。
 */
export const WORK_COMPLETIONS = ["ongoing", "completed", "hiatus"] as const;

export type WorkCompletion = (typeof WORK_COMPLETIONS)[number];

export function isWorkCompletion(value: unknown): value is WorkCompletion {
  return (
    typeof value === "string" &&
    (WORK_COMPLETIONS as readonly string[]).includes(value)
  );
}

/** 画面に出す呼び方 */
export function workCompletionLabel(value: WorkCompletion): string {
  return WORK_COMPLETION_LABELS[value];
}

/** 呼び方の表。値を足したら、ここで型が足りないと言われる（二択の分岐を書かない） */
const WORK_COMPLETION_LABELS: Readonly<Record<WorkCompletion, string>> = {
  ongoing: "連載中",
  completed: "完結",
  hiatus: "休載",
};

/**
 * その作品を覚えた理由（ヘルパー 0.16.0 の封筒の `ownedVia`）。
 *
 * - `owner-page`：本人しか開けない画面（カクヨムの作品管理など）で読んだ
 * - `approved`：作者が［覚える］と答えた
 *
 * いまは**受け取って残すだけ**（使い道は別の担当の仕事。2026-11-01）。
 */
export const READER_STATS_OWNED_VIA = ["owner-page", "approved"] as const;

export type ReaderStatsOwnedVia = (typeof READER_STATS_OWNED_VIA)[number];

export function isReaderStatsOwnedVia(value: unknown): value is ReaderStatsOwnedVia {
  return (
    typeof value === "string" &&
    (READER_STATS_OWNED_VIA as readonly string[]).includes(value)
  );
}

/** 作品の連載の状態（作者が決めた値と、決めた日時） */
export interface PostingWorkCompletion {
  value: WorkCompletion;
  /** 作者が切り替えた日時（ISO8601） */
  setAt: string;
}

/**
 * 1つのサイトの、いまの事柄（ヘルパーから届いたもの）。
 *
 * **欄ごとに日時を持つ**——タグはカクヨムの作品管理の画面にしか無く、アクセス数の
 * 画面の封筒には入らない。欄ごとに「いつ読めた値か」を持たないと、タグの無い
 * 新しい封筒がタグの日時だけを進めてしまう。
 */
export interface PostingSiteFacts {
  site: PostingSiteId;
  /** 画面の並びのまま。`[]` は「タグが0個と分かった」 */
  tags?: string[];
  tagsAt?: string;
  completion?: WorkCompletion;
  completionAt?: string;
  ownedVia?: ReaderStatsOwnedVia;
  ownedViaAt?: string;
  /**
   * サイトの中の数字の作品番号（設計書6.68.7。いまはなろうの「小説番号」だけ）。`siteWorkNumberAt` は入れた日時。
   *
   * なろうの作者用の画面（作品の管理・話の編集）は、Nコード（`siteProfiles.workId`）ではなく
   * この番号で作品を指す。台帳はサイトを読みにいかない（6.68.1）ので、入るのはヘルパーが
   * 送り返した値だけ（`withSiteWorkNumber`）。**作者の手入力の欄（`siteProfiles`）には入れない**
   * ——作品情報の画面で欄を組み直すと消える恐れがあり、作者が打つ値でもない。
   */
  siteWorkNumber?: string;
  siteWorkNumberAt?: string;
}

/** サイトの中の数字の作品番号の形（URL のパスへ入るので、数字だけ） */
const SITE_WORK_NUMBER_PATTERN = /^\d{1,20}$/;

/** そのサイトの、サイトの中の数字の作品番号（`PostingSiteFacts.siteWorkNumber`） */
export function siteWorkNumberFor(
  ledger: PostingLedger,
  site: PostingSiteId
): string | undefined {
  return siteFactsFor(ledger, site)?.siteWorkNumber;
}

/**
 * サイトの中の数字の作品番号を入れる（6.68.7。**元の台帳は書き換えない**）。
 *
 * ヘルパーが話IDと一緒に送り返す番号を受ける口（`novelai-posted` の `novelNo`。受け手は
 * `features/importPosted.ts`。6.68.8）。同じ番号なら台帳をそのまま返す（保存を増やさない）。
 *
 * @returns 入れた台帳。番号の形が違えば undefined（呼ぶ側が黙って捨てないように）
 */
export function withSiteWorkNumber(
  ledger: PostingLedger,
  site: PostingSiteId,
  siteWorkNumber: string,
  recordedAt: string
): PostingLedger | undefined {
  const number = siteWorkNumber.trim();
  if (!SITE_WORK_NUMBER_PATTERN.test(number)) return undefined;
  const current = siteFactsFor(ledger, site);
  if (current?.siteWorkNumber === number) return ledger;
  const next: PostingSiteFacts = {
    ...(current ?? { site }),
    siteWorkNumber: number,
    siteWorkNumberAt: recordedAt,
  };
  const facts = ledger.siteFacts ?? [];
  return {
    ...ledger,
    siteFacts: current
      ? facts.map((entry) => (entry.site === site ? next : entry))
      : [...facts, next],
  };
}

/** タグの付け替え1回ぶん */
export interface PostingTagChange {
  site: PostingSiteId;
  /** 付け替えに気づいた封筒の `readAt`（サイトで付け替えた正確な時刻ではない） */
  changedAt: string;
  before: string[];
  after: string[];
}

/** タグ1つの長さの上限（ヘルパーとの取り決め。これを超えるものはタグとして読まない） */
export const READER_STATS_TAG_MAX_LENGTH = 60;

/** タグの数の上限（ヘルパーとの取り決め） */
export const READER_STATS_TAGS_MAX = 50;

/**
 * タグの並びを読む。**読めなければ undefined**（欄ごと捨てる）。
 *
 * 前後の空白・空・重複はヘルパーでも落としてあるが、受ける側でも落とす（同じ整え方）。
 * 文字列でない要素・長すぎるタグ・多すぎる数は、**直さずに欄ごと捨てる**
 * ——一部だけ拾うと、作者には「タグを外した」ように見える。
 */
export function readReaderStatsTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return undefined;
    const tag = entry.trim();
    if (!tag || tags.includes(tag)) continue;
    if (tag.length > READER_STATS_TAG_MAX_LENGTH) return undefined;
    tags.push(tag);
  }
  return tags.length > READER_STATS_TAGS_MAX ? undefined : tags;
}

/** そのサイトの今の事柄。無ければ undefined */
export function siteFactsFor(
  ledger: PostingLedger,
  site: PostingSiteId
): PostingSiteFacts | undefined {
  return (ledger.siteFacts ?? []).find((entry) => entry.site === site);
}

/** 届いた事柄（封筒1件ぶん） */
export interface SiteFactsInput {
  site: PostingSiteId;
  readAt: string;
  tags?: readonly string[];
  completion?: WorkCompletion;
  ownedVia?: ReaderStatsOwnedVia;
}

/**
 * 届いた事柄を台帳へ写す（作者の指示 2026-11-01）。
 *
 * - **`readAt` が手元の値より新しいか同じときだけ**書き換える。束は溜めた順に並ぶが、
 *   作者が古い画面を後から溜め直すこともあるので、並び順ではなく日時で決める
 *   （ヘルパーの `history.js` と同じ決め方）。同じ日時なら、あとから来た方を採る
 * - タグが前の値と違えば、**付け替えの記録を1件足す**。前の値が無い初回は足さない
 *   （「付け替えた」のではなく、初めて分かっただけ）。比べるのは**並びも含めて**
 *   （サイトの画面の並びが変わったのも、作者が並べ直した跡なので残す）
 * - **作品の印（`completion`）には触らない**（作者が決めた値が勝つ）
 *
 * @returns 写したあとの台帳と、何か変わったか
 */
export function withSiteFacts(
  ledger: PostingLedger,
  input: SiteFactsInput
): { ledger: PostingLedger; changed: boolean } {
  const current = siteFactsFor(ledger, input.site);
  const next: PostingSiteFacts = { ...(current ?? { site: input.site }) };
  /*
    `changed` は**値が変わったときだけ**真にする。値が同じで日時だけ新しいときは、
    日時を進めた台帳を返すが `changed` は偽のまま——数の保存に相乗りさせる
    （日時だけのために保存したり、自動取り込みで「まだ取り込んでいない」と訊き直したり
    しない）。日時を進めないと、あとから届いた**その間の古い画面**が勝ってしまう
  */
  let changed = false;
  let touched = false;
  let tagChange: PostingTagChange | undefined;

  if (input.tags !== undefined && isNotOlder(input.readAt, next.tagsAt)) {
    const tags = [...input.tags];
    const before = next.tags;
    if (before === undefined || !sameTags(before, tags)) {
      if (before !== undefined) {
        tagChange = { site: input.site, changedAt: input.readAt, before: [...before], after: tags };
      }
      next.tags = tags;
      changed = true;
    }
    if (next.tagsAt !== input.readAt) touched = true;
    next.tagsAt = input.readAt;
  }
  if (input.completion !== undefined && isNotOlder(input.readAt, next.completionAt)) {
    if (next.completion !== input.completion) {
      next.completion = input.completion;
      changed = true;
    }
    if (next.completionAt !== input.readAt) touched = true;
    next.completionAt = input.readAt;
  }
  if (input.ownedVia !== undefined && isNotOlder(input.readAt, next.ownedViaAt)) {
    if (next.ownedVia !== input.ownedVia) {
      next.ownedVia = input.ownedVia;
      changed = true;
    }
    if (next.ownedViaAt !== input.readAt) touched = true;
    next.ownedViaAt = input.readAt;
  }
  if (!changed && !touched) return { ledger, changed: false };

  const facts = ledger.siteFacts ?? [];
  return {
    changed,
    ledger: {
      ...ledger,
      siteFacts: current
        ? facts.map((entry) => (entry.site === input.site ? next : entry))
        : [...facts, next],
      ...(tagChange ? { tagChanges: [...(ledger.tagChanges ?? []), tagChange] } : {}),
    },
  };
}

/**
 * 届いた事柄で、台帳が変わるか（自動取り込みの「もう取り込んだか」の見分けに使う）。
 * 書き換えの判断を写さないよう、`withSiteFacts` を当てて確かめる
 */
export function siteFactsWouldChange(ledger: PostingLedger, input: SiteFactsInput): boolean {
  return withSiteFacts(ledger, input).changed;
}

/**
 * 作者が作品の連載の状態を決める（`null` は「決めない」に戻す）。
 * **作者の操作からだけ呼ぶ**——サイトの印から呼ぶ経路を作らない
 */
export function withWorkCompletion(
  ledger: PostingLedger,
  value: WorkCompletion | null,
  setAt: string
): PostingLedger {
  if (value === null) {
    const next = { ...ledger };
    delete next.completion;
    return next;
  }
  return { ...ledger, completion: { value, setAt } };
}

/** タグの並びが同じか（並びも含めて比べる。`withSiteFacts` の注記） */
function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

/**
 * 届いた日時が、手元の値より古くないか。手元に無ければ新しい扱い。
 * **日時として読めないものは比べずに新しい扱い**——台帳の日時は作者が手で直すこともあり、
 * 読めないからといって以後ずっと書き換えられないのは困る
 */
function isNotOlder(incoming: string, held: string | undefined): boolean {
  if (held === undefined) return true;
  const a = Date.parse(incoming);
  const b = Date.parse(held);
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  return a >= b;
}

export function emptyPostingLedger(): PostingLedger {
  return {
    schemaVersion: POSTING_SCHEMA_VERSION,
    sites: [],
    siteProfiles: [],
    posts: [],
    rankings: [],
    readerStats: [],
  };
}

/**
 * 投稿ページのURLとして受けられるか。理由が分かる文字列を返す（問題なければ null）。
 *
 * **中身は見ない**（6.68.1）。確かめるのは
 *
 *   1. `http`／`https` のURLであること（`javascript:` などを開かせない）
 *   2. そのサイトのドメインであること（カクヨムの欄になろうのURLを貼らない）
 *
 * の2つだけである。ページを読みにいくことは一切しない。
 */
export function validateNewEpisodeUrl(
  site: PostingSiteId,
  value: string
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "投稿ページのURLを入力してください。";
  return validateSiteUrl(site, trimmed);
}

/**
 * 作品ページのURLとして受けられるか（設計書6.68.5）。
 *
 * **空でもよい。** 投稿ページのURLと違い、これは無くても機能が成り立つ
 * 任意の情報である（無ければリンクを出さないだけ）。入っているときは、
 * 投稿ページと同じくドメインだけを確かめる。
 */
export function validateWorkPageUrl(
  site: PostingSiteId,
  value: string
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return validateSiteUrl(site, trimmed);
}

/**
 * 作者が入れた作品IDの形を確かめる（作者の判断 2026-11-01）。空は通す（任意の欄）。
 *
 * **確かめるのはアルファポリスだけ。** 作品IDは数字9桁（投稿画面の URL
 * `/mypage/novel/save_episode/{作品ID}` の末尾）で、ヘルパーはこの9桁で貼り込み先を
 * 照合する。0.116.1 までの例に従って「作者番号／作品番号」を入れた作品は、あとで
 * 取り違えとして止まるので、入れたその場で**どこを写すか**まで言う。
 * ほかのサイトは形を確かめていない（なろうのNコードは照合の側で読む）ので、今までどおり問わない。
 *
 * 全角の数字は通さない（ヘルパーの照合は半角の9桁。直して受けると、作者の打った字と
 * 台帳の字が食い違う）。
 *
 * @returns 断る理由。通すなら null
 */
export function validateSiteWorkIdInput(site: PostingSiteId, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || site !== "alphapolis") return null;
  if (/^[0-9]{9}$/.test(trimmed)) return null;
  return (
    "アルファポリスの作品IDは数字9桁です。" +
    "投稿画面の URL の末尾の9桁の数字を入れてください" +
    "（例：https://www.alphapolis.co.jp/mypage/novel/save_episode/123456789 なら 123456789）。"
  );
}

function validateSiteUrl(site: PostingSiteId, trimmed: string): string | null {
  const info = postingSiteInfo(site);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return `URLとして読めません。http:// か https:// から始まるURLを貼ってください（例：${info.urlExample}）。`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "http:// か https:// から始まるURLを貼ってください。";
  }

  const host = url.hostname.toLowerCase();
  if (host !== info.domain && !host.endsWith(`.${info.domain}`)) {
    return `${info.label}のURL（${info.domain}）を貼ってください（例：${info.urlExample}）。`;
  }
  return null;
}

/**
 * 台帳を読んだ結果（設計書6.79.7）。
 *
 * **読み飛ばした件数を、台帳と一緒に返す。** 黙って減らすと、あとから
 * 「記録したはずの行が無い」ことにしか気づけない。記録へ残すのは呼ぶ側
 * （`core/postingStore.ts`）の仕事である——`models` はログを持たない。
 */
export interface PostingLedgerReadResult {
  ledger: PostingLedger;
  /**
   * 読み飛ばした、読者の反応の行数。
   *
   * 知らない指標しか無かった行（0.33.9）と、**この版が読めなかった行**
   * （0.69.9。知らない出どころ・知らないサイト・壊れた値）の合計である。
   */
  skippedReaderStats: number;
  /**
   * 読み飛ばした行そのもの（**JSONそのままの形**）。
   *
   * **保存で消さないために返す**（0.33.9）。読み飛ばした行を持たずに
   * 書き戻すと、**新しい版の機械が書いた行を、古い版の機械が黙って消す**
   * ——台帳は `設定/` に置いてGitで同期するので、これは現実に起きる。
   *
   * **`PostingLedger` には載せない。** あの型が表すのは「読めた行」だけで
   * あり、読めなかったものを混ぜると、台帳を読む側が中身を当てにできなく
   * なる。持ち回すのは書き戻す口（`core/postingStore.ts`）の仕事である。
   */
  skippedReaderStatsRows: unknown[];
  /**
   * 作品の連載の状態のうち、**この版が知らない値**だったもの（JSONそのままの形。2026-11-01）。
   *
   * 読み飛ばした行と同じく**保存で消さないために返す**。新しい版が足した状態
   * （休載を足したのと同じように）を、古い版が保存で消してはいけない。
   * 知っている値なら undefined。
   */
  skippedCompletion?: Record<string, unknown>;
  /** サイトごとの連載の状態のうち、この版が知らない値だったもの（生のまま） */
  skippedSiteCompletions: SkippedSiteCompletion[];
  /** 読まなかった値の説明（作者へ一度知らせる文の材料）。無ければ空 */
  unknownValues: string[];
}

/** サイトの事柄から外した、知らない連載の状態（`completion` と `completionAt` の対） */
export interface SkippedSiteCompletion {
  site: PostingSiteId;
  completion: string;
  completionAt: string;
}

/**
 * 作者が手で編集したJSONを読む。**壊れていたら例外を投げる。**
 *
 * 勝手に直して上書きすると、作者が貼ったURLや投稿の記録が黙って消える
 * （章立て・本の設計図と同じ約束）。
 */
/**
 * 本文の印の形（SHA-256 の16進64字。`core/hash.ts` の `hashText` が返す形）。
 * 頭の `v2:` は題も含めた印（0.124.1 から。`TITLED_TEXT_HASH_PREFIX`）、無ければ本文だけの印（0.124.0）。
 * `v3:` はルビ・傍点の書き方を寄せてから取った印（0.126.4 から。`NOTATION_TEXT_HASH_PREFIX`）
 */
const BODY_HASH_PATTERN = /^(?:v[23]:)?[0-9a-f]{64}$/;

/**
 * 題と本文の両方で取った印の頭（0.124.1。作者の答え 2026-11-03 昼「題だけ直した話も促す」）。
 *
 * **印の取り方を変えたので、どちらの取り方の印かを値に持たせる。** 0.124.0 の印（本文だけ）を
 * 今の取り方と比べると、直していない話まで全部「直した」になる。頭の印で見分け、古い印は
 * 本文だけの印どうしで比べる（`revisionNeed`）。
 */
export const TITLED_TEXT_HASH_PREFIX = "v2:";

/** 題と本文の両方で取った印か（`TITLED_TEXT_HASH_PREFIX`） */
export function isTitledTextHash(hash: string): boolean {
  return hash.startsWith(TITLED_TEXT_HASH_PREFIX);
}

/**
 * ルビ・傍点の書き方を寄せてから取った、題と本文の印の頭（0.126.4）。
 *
 * **本文の .md 化（設計書6.12.4）が `｜漢字《かんじ》` を `{漢字|かんじ}` へ直すので、
 * `v2:` の取り方では .md にしただけの話まで「投稿のあとに直した」になっていた。** 取り方を
 * 変えたので頭の印を替え、台帳に残っている `v2:`・無印の記録は書き換えずに、それぞれの
 * 取り方で比べる（`revisionNeed`）。
 */
export const NOTATION_TEXT_HASH_PREFIX = "v3:";

/** ルビ・傍点の書き方を寄せてから取った印か（`NOTATION_TEXT_HASH_PREFIX`） */
export function isNotationTextHash(hash: string): boolean {
  return hash.startsWith(NOTATION_TEXT_HASH_PREFIX);
}

/**
 * 今の話の印（`core/postingBodyHash.ts` の `postingTextHashes` が作る）。
 * 古い記録とも比べられるよう、3つの取り方のそれぞれで持つ。
 */
export interface PostingTextHashes {
  /** ルビ・傍点の書き方を寄せた、題と本文の印（`v3:` 付き）。記録にはこちらを残す */
  notation: string;
  /** 題と本文の両方の印（`v2:` 付き。0.124.1〜0.126.3 の取り方）。古い記録と比べるときだけ使う */
  titled: string;
  /** 本文だけの印（0.124.0 の取り方）。古い記録と比べるときだけ使う */
  bodyOnly: string;
  /**
   * 今の話を投稿サイトの書き方（`｜漢字《かんじ》`）へ戻した写しの、`v2:` の取り方の印。
   * .md 化しただけの話を、古い記録との比べで「直した」と言わないため。一致すれば、
   * 投稿した本文は写しそのもの（書き方の違いしか無い）と分かる
   */
  titledCopies: readonly string[];
  /** 同じ写しの、本文だけの取り方の印（0.124.0 の記録と比べるときだけ使う） */
  bodyOnlyCopies: readonly string[];
}

/**
 * サイトの話の番号として受け付ける形。**URL のパスへそのまま入る**ので、
 * `/`・`?`・`#`・`..` が入りうる形を通さない（別のページを開かせない）。
 * サイトごとの細かい形（カクヨム・アルファポリスは数字）は URL を作る側が確かめる。
 */
const SITE_EPISODE_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

/**
 * 本文の印を読む（6.68.7）。**形が違えば直さずに止める**（`chapter` と同じ厳しさ）——
 * 崩れた印を「違う本文」と読むと、直していない話まで出し直しを促す。
 * 空文字は欄ごと無いものとして読む。
 */
function readBodyHash(value: unknown, path: string): string | undefined {
  optionalString(value, path);
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  if (!BODY_HASH_PATTERN.test(text)) invalid(path);
  return text;
}

/** 題だけの印の形（16進64字。`v2:` のような頭は付かない——取り方は1つだけ） */
const TITLE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** 題だけの印を読む（6.68.7。0.125.2）。形が違えば止める（`readBodyHash` と同じ厳しさ） */
function readTitleHash(value: unknown, path: string): string | undefined {
  optionalString(value, path);
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  if (!TITLE_HASH_PATTERN.test(text)) invalid(path);
  return text;
}

/** サイトの話の番号を読む（6.68.7）。形が違えば止める（理由は `SITE_EPISODE_ID_PATTERN`） */
function readSiteEpisodeId(value: unknown, path: string): string | undefined {
  optionalString(value, path);
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  if (!SITE_EPISODE_ID_PATTERN.test(text)) invalid(path);
  return text;
}

export function parsePostingLedger(raw: unknown): PostingLedger {
  return readPostingLedger(raw).ledger;
}

/**
 * 台帳を読み、**読み飛ばした行の件数も返す**（設計書6.79.7）。
 *
 * 件数まで要らない呼び出し側は `parsePostingLedger` を使う。
 */
export function readPostingLedger(raw: unknown): PostingLedgerReadResult {
  const value = objectValue(raw, `設定/${POSTING_FILE}`);
  optionalString(value.schemaVersion, "schemaVersion");

  /*
    **旧形式（`sites[].profile`）は、読みながら持ち上げる**（設計書6.68.5）。
    ここで拾っておかないと、書き戻したときに作者が入れた作品情報が消える。
  */
  const legacyProfiles: PostingSiteProfileEntry[] = [];

  const sites =
    optionalObjectArray(value.sites, "sites", (entry, entryPath) => {
      const site = requireSiteId(entry.site, `${entryPath}.site`);
      requireNonEmptyString(entry.newEpisodeUrl, `${entryPath}.newEpisodeUrl`);
      const url = (entry.newEpisodeUrl as string).trim();
      // **別のサイトのURLは直さずに止める。** 直したところで正しいURLは
      // こちらには分からず、黙って別のページを開くほうが危ない
      if (validateNewEpisodeUrl(site, url)) {
        invalid(`${entryPath}.newEpisodeUrl`);
      }
      const profile = parseSiteProfile(entry.profile, site, `${entryPath}.profile`);
      if (profile) legacyProfiles.push({ site, ...profile });
      return { site, newEpisodeUrl: url };
    }) ?? [];

  assertUniqueSites(sites);

  const explicitProfiles =
    optionalObjectArray(
      value.siteProfiles,
      "siteProfiles",
      (entry, entryPath) => {
        const site = requireSiteId(entry.site, `${entryPath}.site`);
        const profile = parseSiteProfile(entry, site, entryPath);
        return { site, ...(profile ?? {}) };
      }
    ) ?? [];

  assertUniqueSiteProfiles(explicitProfiles);

  /*
    **明示的な `siteProfiles` が勝つ。** 両方に同じサイトが書いてあるのは、
    新形式で書いたあと古い版で開いた台帳などである。どちらか片方しか
    採れないので、新しいほうを採る。
  */
  const siteProfiles = [
    // 全欄が空のものは持ち歩かない（読んで書き戻すだけで中身が増えない）
    ...explicitProfiles.filter((entry) => hasSiteProfile(entry)),
    ...legacyProfiles.filter(
      (entry) => !explicitProfiles.some((kept) => kept.site === entry.site)
    ),
  ];

  const posts =
    optionalObjectArray(value.posts, "posts", (entry, entryPath) => {
      requireNonEmptyString(entry.episodePath, `${entryPath}.episodePath`);
      const site = requireSiteId(entry.site, `${entryPath}.site`);
      requireNonEmptyString(entry.postedAt, `${entryPath}.postedAt`);
      optionalBoolean(entry.importedBaseline, `${entryPath}.importedBaseline`);
      /*
        合本の中の1話を指す記録（設計書6.68.2）。**壊れた値は直さずに
        止める**——3.5話や -1話が入ると、引く鍵が静かにずれる。
        欄が無い記録は「そのファイルの全話を投稿済み」と読む（`isPosted`）。
      */
      optionalNullableNumber(entry.chapter, `${entryPath}.chapter`);
      optionalNullableNumber(entry.order, `${entryPath}.order`);
      const chapter = typeof entry.chapter === "number" ? entry.chapter : null;
      const order = typeof entry.order === "number" ? entry.order : null;
      const bodyHash = readBodyHash(entry.bodyHash, `${entryPath}.bodyHash`);
      const titleHash = readTitleHash(entry.titleHash, `${entryPath}.titleHash`);
      const siteEpisodeId = readSiteEpisodeId(
        entry.siteEpisodeId,
        `${entryPath}.siteEpisodeId`
      );
      // 札は話の番号と同じ形の決まり（英数字と - _）。崩れていれば直さずに止める
      const postRef = readSiteEpisodeId(entry.postRef, `${entryPath}.postRef`);
      return {
        episodePath: normalizeEpisodePath(entry.episodePath as string),
        site,
        postedAt: (entry.postedAt as string).trim(),
        // **無い印は書き足さない。** `false` を入れると、既存の台帳を
        // 読んで書き戻すだけで中身が増える
        ...(entry.importedBaseline === true ? { importedBaseline: true } : {}),
        // 話数と並び順も同じ。**話数が読めた記録に並び順は持ち歩かない**
        ...(chapter !== null
          ? { chapter }
          : order !== null
            ? { order }
            : {}),
        // 本文の印と話の番号（6.68.7）。無い記録には欄を足さない（上と同じ理由）
        ...(bodyHash ? { bodyHash } : {}),
        ...(titleHash ? { titleHash } : {}),
        ...(siteEpisodeId ? { siteEpisodeId } : {}),
        ...(postRef ? { postRef } : {}),
      };
    }) ?? [];

  /*
    修正版の出し直し（6.68.7）。**欄が無ければ無いまま**（これより前の台帳を読めなくしない）。
    中身は `posts` と同じ厳しさで読み、壊れていれば直さずに止める——話数の欄が崩れると、
    どの話を直したかが静かにずれる。
  */
  const revisions = optionalObjectArray(value.revisions, "revisions", (entry, entryPath) => {
    requireNonEmptyString(entry.episodePath, `${entryPath}.episodePath`);
    const site = requireSiteId(entry.site, `${entryPath}.site`);
    requireNonEmptyString(entry.revisedAt, `${entryPath}.revisedAt`);
    optionalNullableNumber(entry.chapter, `${entryPath}.chapter`);
    optionalNullableNumber(entry.order, `${entryPath}.order`);
    const chapter = typeof entry.chapter === "number" ? entry.chapter : null;
    const order = typeof entry.order === "number" ? entry.order : null;
    const bodyHash = readBodyHash(entry.bodyHash, `${entryPath}.bodyHash`);
    const titleHash = readTitleHash(entry.titleHash, `${entryPath}.titleHash`);
    return {
      episodePath: normalizeEpisodePath(entry.episodePath as string),
      site,
      revisedAt: (entry.revisedAt as string).trim(),
      ...(chapter !== null ? { chapter } : order !== null ? { order } : {}),
      ...(bodyHash ? { bodyHash } : {}),
      ...(titleHash ? { titleHash } : {}),
    };
  });

  const rankings =
    optionalObjectArray(value.rankings, "rankings", (entry, entryPath) => {
      const site = requireSiteId(entry.site, `${entryPath}.site`);
      requireNonEmptyString(entry.recordedAt, `${entryPath}.recordedAt`);
      requireNonEmptyString(entry.board, `${entryPath}.board`);
      // **順位は直さずに止める。** 0位や1.5位は打ち間違いだが、
      // どう直すのが正しいかはこちらには分からない
      if (!isRank(entry.rank)) invalid(`${entryPath}.rank`);
      optionalString(entry.note, `${entryPath}.note`);
      const note = ((entry.note as string | undefined) ?? "").trim();
      return {
        site,
        recordedAt: (entry.recordedAt as string).trim(),
        board: (entry.board as string).trim(),
        rank: entry.rank as number,
        ...(note ? { note } : {}),
        /*
          **出どころの印を読み落とさない**（2026-11-02）。ここで落とすと、読んで書き戻す
          だけで API の順位が手入力の顔になり、AI へ渡さない約束の目印が消える。
          知らない値は印ごと読まない（いまある値は1つだけ）
        */
        ...(entry.source === "narou-api" || entry.source === "helper"
          ? { source: entry.source as PostingRankingSource }
          : {}),
        /*
          ヘルパーの順位の添え物（2026-11-02）。**形が違えば欄ごと読まない**（台帳は止めない
          ——順位そのものは読めている。作者が手で直した台帳で、ここが崩れることはありうる）
        */
        ...readRankingExtras(entry),
      };
    }) ?? [];

  /*
    読者の反応（6.79.7）。**欄が無ければ空**——この機能より前の台帳を
    読めなくしない。中身は `assertReaderStatsRecord` が1か所で確かめる
    （読み込みと書き込みで基準がずれると、片方が抜け道になる）。
  */
  // 読み飛ばした行は、**生のまま**覚えておく（書き戻す側が持ち回る）
  const skippedReaderStatsRows: unknown[] = [];

  const parsedReaderStats =
    optionalObjectArray<ReaderStatsRecord | null>(
      value.readerStats,
      "readerStats",
      (entry, entryPath) => {
        /*
          **1行が読めなくても、台帳ごと死なせない**（0.69.9。作者の裁定
          「読みを寛容にする」）。

          この台帳は `設定/` に置いてGitで同期する。**書いた版より古い版が
          読むことがある**ので、知らない出どころ（`source: "backup"`）や
          知らないサイトが書いてあるだけで例外を投げると、投稿系の機能が
          丸ごと止まり、執筆量パネルの「サイトの記録」が無言で消える。
          知らない指標を飛ばすのと同じ扱いを、**行ごとにも広げる。**

          **飛ばした行は生のまま控えて、保存でそのまま書き戻す**ので、
          数字は1つも消えない（`skippedReaderStatsRows`）。

          **これは古い版を直すものではない。** すでに配ってある版
          （0.67.1 以前）は行ごとの寛容さを持たないので、`backup` の行が
          入った台帳を開くと、これまでどおり台帳ぜんぶが読めなくなる。
          直せるのは、これ以降の版が読むときだけである。

          寛容にするのは**行の中身まで**で、入れ物の形（`readerStats` が
          配列か、要素がオブジェクトか）は従来どおり止める——そこまで
          黙って通すと「読めた」と「読めなかった」の区別が消える。
        */
        try {
          return readReaderStatsRow(entry, entryPath);
        } catch {
          skippedReaderStatsRows.push(entry);
          return null;
        }
      }
    ) ?? [];

  /**
   * 1行ぶんを読む。**読めなければ例外**（呼ぶ側がその行だけを飛ばす）。
   *
   * `null` は「読めたが、控えて飛ばすと決めた行」——知らない指標しか
   * 無かった行（0.33.9）である。例外と分けているのは、控える処理を
   * ここで済ませているためで、意味はどちらも「その行は台帳に載せない」。
   */
  function readReaderStatsRow(
    entry: Record<string, unknown>,
    entryPath: string
  ): ReaderStatsRecord | null {
        const site = requireSiteId(entry.site, `${entryPath}.site`);
        requireNonEmptyString(entry.readAt, `${entryPath}.readAt`);
        optionalString(entry.periodKey, `${entryPath}.periodKey`);
        optionalString(entry.note, `${entryPath}.note`);
        optionalString(entry.updatedAt, `${entryPath}.updatedAt`);
        const note = ((entry.note as string | undefined) ?? "").trim();
        // 空文字は「欄なし」と同じ（空の欄は持たせない）
        const updatedAt = (
          (entry.updatedAt as string | undefined) ?? ""
        ).trim();
        const read = parseReaderStatsMetrics(
          entry.metrics,
          `${entryPath}.metrics`,
          // 負を受けるかは粒度で決まる（日別の増減の欄だけ）
          entry.period
        );
        /*
          **知らない指標しか無い行は、この行だけを読み飛ばす**（0.33.9）。

          台帳は `設定/` に置いてGitで同期するので、**新しい版が足した指標を
          古い版の機械が読む**ことが現実に起きる。ここで例外を投げると台帳
          ぜんぶが読めなくなり、投稿系の機能が丸ごと止まって、執筆量パネルの
          「サイトの記録」が無言で消える。読める行と台帳は読めるようにする。

          **知っている欄が1つでもあれば、その行は残す**（知らない欄だけ捨てる
          のは従来どおり）。欄がひとつも書かれていない行は、指標を手で消した
          跡なので、これまでどおり直さずに止める。

          **飛ばした行は、読んだ形のまま控える。** 整えてから控えると、
          整えた形が「こちらが作った行」になる——読めなかったものは、
          読めなかったなりに、そのまま書き戻すのが唯一の安全な扱いである。
        */
        if (!hasReaderStatsMetrics(read.metrics) && read.sawUnknown) {
          skippedReaderStatsRows.push(entry);
          return null;
        }
        const record: ReaderStatsRecord = {
          site,
          readAt: (entry.readAt as string).trim(),
          scope: entry.scope as ReaderStatsScope,
          ...(entry.episode === undefined
            ? {}
            : { episode: entry.episode as number }),
          ...(entry.period === undefined
            ? {}
            : { period: entry.period as ReaderStatsPeriod }),
          ...(entry.periodKey === undefined
            ? {}
            : { periodKey: (entry.periodKey as string).trim() }),
          metrics: read.metrics,
          source: entry.source as ReaderStatsSource,
          ...(note ? { note } : {}),
          ...(updatedAt ? { updatedAt } : {}),
        };
        assertReaderStatsRecord(record, entryPath);
        return record;
  }

  const readerStats = parsedReaderStats.filter(
    (record): record is ReaderStatsRecord => record !== null
  );

  /*
    サイトごとの今の事柄・タグの付け替え・作品の連載の状態（作者の指示 2026-11-01）。
    **欄が無ければ無いまま**（これより前の台帳を読めなくしない）。壊れていれば
    **直さずに止める**——とくに `completion` は作者が決めた値で、推測で読み替えると
    作者の決定を書き換えたことになる（実装ルール2）。

    **ただし「知らない連載の状態」だけは止めない**（作者の判断 2026-11-01「休載を足す」）。
    文字列ではあるがこの版の一覧に無い値は、新しい版が足した状態である見込みが高い。
    そこで台帳ごと止めると、投稿キットも執筆統計も、その作品だけ使えなくなる。
    その欄だけを読まずに生のまま返し（保存で書き戻すのは `PostingStore`）、作者へは
    一度知らせる。**型の違い・日時の欠けは壊れたJSONとして今までどおり止める。**
  */
  const unknownValues: string[] = [];
  const skippedSiteCompletions: SkippedSiteCompletion[] = [];
  const siteFacts = optionalObjectArray(value.siteFacts, "siteFacts", (entry, entryPath) =>
    readSiteFactsRow(entry, entryPath, (skipped) => {
      skippedSiteCompletions.push(skipped);
      unknownValues.push(
        `${postingSiteInfo(skipped.site).label}の連載の状態「${skipped.completion}」`
      );
    })
  );
  if (siteFacts) {
    const seen = new Set<PostingSiteId>();
    siteFacts.forEach((entry, index) => {
      // 同じサイトが2件あると、どちらが今の値か決められない
      if (seen.has(entry.site)) invalid(`siteFacts[${index}].site`);
      seen.add(entry.site);
    });
  }
  const tagChanges = optionalObjectArray(value.tagChanges, "tagChanges", (entry, entryPath) => {
    const site = requireSiteId(entry.site, `${entryPath}.site`);
    requireNonEmptyString(entry.changedAt, `${entryPath}.changedAt`);
    const before = readReaderStatsTags(entry.before) ?? invalid(`${entryPath}.before`);
    const after = readReaderStatsTags(entry.after) ?? invalid(`${entryPath}.after`);
    return { site, changedAt: (entry.changedAt as string).trim(), before, after };
  });
  let completion: PostingWorkCompletion | undefined;
  let skippedCompletion: Record<string, unknown> | undefined;
  if (value.completion !== undefined) {
    const raw = objectValue(value.completion, "completion");
    requireNonEmptyString(raw.value, "completion.value");
    requireNonEmptyString(raw.setAt, "completion.setAt");
    if (isWorkCompletion(raw.value)) {
      completion = { value: raw.value, setAt: (raw.setAt as string).trim() };
    } else {
      // 知らない状態。**写しを整えずにそのまま持つ**（整えると、整えた形がこちらの作り物になる）
      skippedCompletion = raw;
      unknownValues.push(`作品の連載の状態「${String(raw.value)}」`);
    }
  }

  return {
    ledger: {
      schemaVersion:
        (value.schemaVersion as string | undefined) ?? POSTING_SCHEMA_VERSION,
      sites,
      siteProfiles,
      posts,
      // 空の入れ物は持ち歩かない（下の3つと同じ）
      ...(revisions?.length ? { revisions } : {}),
      rankings,
      readerStats,
      // 空の入れ物は持ち歩かない（読んで書き戻すだけで中身が増えないように）
      ...(siteFacts?.length ? { siteFacts } : {}),
      ...(tagChanges?.length ? { tagChanges } : {}),
      ...(completion ? { completion } : {}),
    },
    skippedReaderStats: skippedReaderStatsRows.length,
    skippedReaderStatsRows,
    ...(skippedCompletion ? { skippedCompletion } : {}),
    skippedSiteCompletions,
    unknownValues,
  };
}

/**
 * 読者の反応の数値を読む。**知らない欄は持ち歩かない。**
 *
 * 手で書き足された欄をそのまま残すと、書き戻したときに「こちらが作った
 * 欄」に見える。読めるものだけを写す（数として読めない値はここで止める）。
 *
 * **知らない欄を見たかどうかも返す**（0.33.9）。知らない欄しか無い行は、
 * 呼ぶ側がその行だけを読み飛ばす——`{}` になったのが「未来の版の指標」
 * なのか「欄を消した跡」なのかは、ここでしか見分けられない。
 */
function parseReaderStatsMetrics(
  raw: unknown,
  path: string,
  period?: unknown
): { metrics: ReaderStatsMetrics; sawUnknown: boolean } {
  const value = objectValue(raw, path);
  const metrics: ReaderStatsMetrics = {};
  // **サイトで絞らない**（`ALL_READER_STATS_METRICS` の理由そのまま）
  for (const info of ALL_READER_STATS_METRICS) {
    const entry = value[info.key];
    if (entry === undefined) continue;
    if (!isReaderStatsValue(entry, info, period)) invalid(`${path}.${info.key}`);
    metrics[info.key] = entry;
  }
  const known = new Set<string>(
    ALL_READER_STATS_METRICS.map((info) => info.key)
  );
  const sawUnknown = Object.keys(value).some((key) => !known.has(key));
  return { metrics, sawUnknown };
}

/**
 * サイトごとの今の事柄を1件読む（作者の指示 2026-11-01）。**壊れていれば例外**。
 *
 * 値と日時は対で持つ（`PostingSiteFacts` の注記）。片方だけの欄は、いつの値か
 * 分からないので直さずに止める。
 */
function readSiteFactsRow(
  entry: Record<string, unknown>,
  entryPath: string,
  onUnknownCompletion: (skipped: SkippedSiteCompletion) => void
): PostingSiteFacts {
  const site = requireSiteId(entry.site, `${entryPath}.site`);
  const facts: PostingSiteFacts = { site };
  const pairs = [
    ["tags", "tagsAt"],
    ["completion", "completionAt"],
    ["ownedVia", "ownedViaAt"],
    ["siteWorkNumber", "siteWorkNumberAt"],
  ] as const;
  for (const [key, atKey] of pairs) {
    if (entry[key] === undefined && entry[atKey] === undefined) continue;
    requireNonEmptyString(entry[atKey], `${entryPath}.${atKey}`);
    const at = (entry[atKey] as string).trim();
    if (key === "tags") {
      facts.tags = readReaderStatsTags(entry.tags) ?? invalid(`${entryPath}.tags`);
      facts.tagsAt = at;
    } else if (key === "completion") {
      /*
        知らない状態の文字列は、この欄の対だけを外す（`readPostingLedger` の注記）。
        タグ・覚えた理由は読めるので残す。文字列でなければ壊れた形として止める
      */
      requireNonEmptyString(entry.completion, `${entryPath}.completion`);
      if (isWorkCompletion(entry.completion)) {
        facts.completion = entry.completion;
        facts.completionAt = at;
      } else {
        onUnknownCompletion({ site, completion: entry.completion as string, completionAt: at });
      }
    } else if (key === "ownedVia") {
      if (!isReaderStatsOwnedVia(entry.ownedVia)) invalid(`${entryPath}.ownedVia`);
      facts.ownedVia = entry.ownedVia;
      facts.ownedViaAt = at;
    } else {
      // 作品番号（6.68.7）。URL のパスへ入るので、数字でなければ直さずに止める
      if (
        typeof entry.siteWorkNumber !== "string" ||
        !SITE_WORK_NUMBER_PATTERN.test(entry.siteWorkNumber.trim())
      ) {
        invalid(`${entryPath}.siteWorkNumber`);
      }
      facts.siteWorkNumber = (entry.siteWorkNumber as string).trim();
      facts.siteWorkNumberAt = at;
    }
  }
  return facts;
}

/**
 * サイトごとの作品情報を読む（6.68.5）。
 *
 * **新形式（`siteProfiles[]`）と旧形式（`sites[].profile`）の両方が通る。**
 * 検証を1か所に置いておかないと、片方だけ緩くなって抜け道になる。
 *
 * **空の入れ物は作らない。** 全部の欄が空なら `undefined` を返し、
 * 台帳には項目ごと書かない（読んで書き戻すだけで中身が増えないように）。
 */
function parseSiteProfile(
  raw: unknown,
  site: PostingSiteId,
  path: string
): PostingSiteProfile | undefined {
  if (raw === undefined) return undefined;
  const value = objectValue(raw, path);
  for (const key of ["workId", "workUrl", "genre", "note"] as const) {
    optionalString(value[key], `${path}.${key}`);
  }
  const workUrl = ((value.workUrl as string | undefined) ?? "").trim();
  // **別のサイトのURLは直さずに止める**（投稿ページのURLと同じ扱い）
  if (workUrl && validateWorkPageUrl(site, workUrl)) invalid(`${path}.workUrl`);
  return normalizeSiteProfile({
    workId: value.workId as string | undefined,
    workUrl,
    genre: value.genre as string | undefined,
    note: value.note as string | undefined,
  });
}

/**
 * 作品情報を整える。前後の空白を落とし、**空の欄は持たない。**
 *
 * すべて空なら `undefined`（＝作品情報を入れていない）。
 */
export function normalizeSiteProfile(
  profile: PostingSiteProfile | undefined
): PostingSiteProfile | undefined {
  if (!profile) return undefined;
  const next: PostingSiteProfile = {};
  for (const key of ["workId", "workUrl", "genre", "note"] as const) {
    const value = (profile[key] ?? "").trim();
    if (value) next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** 作品情報として中身があるか（欄が1つでも埋まっているか） */
function hasSiteProfile(profile: PostingSiteProfile): boolean {
  return Boolean(
    profile.workId || profile.workUrl || profile.genre || profile.note
  );
}

/**
 * **その作品が載っていると分かっているサイト**（0.69.9）。
 *
 * ## `sites` だけでは足りない
 *
 * `sites[]` が意味するのは「新規エピソード投稿ページのURLを貼ってある」
 * ことだけである。ZIPから取り込んだ作品は**すでにそのサイトに載っている**
 * のに、バックアップに投稿ページのURLが入っていないので `sites` を作れない
 * （設計書6.99）。**そこで口が塞がった**——作者の裁定（2026-09-19）：
 * 「siteProfiles も証拠と見る」。
 *
 * ## 何に使うか
 *
 * 読者の反応の口（貼り付け・手入力）が「どのサイトの数字を受けてよいか」を
 * 決めるのに使う。**取り違えを止める線は動かしていない**——載っていると
 * 分かっていないサイトの数字は、これまでどおり受けない。
 *
 * 並びは `POSTING_SITES` に揃える（画面ごとに順番が変わらないように）。
 */
export function knownPostingSites(ledger: PostingLedger): PostingSiteId[] {
  return POSTING_SITES.map((info) => info.id).filter((site) =>
    isKnownPostingSite(ledger, site)
  );
}

/** そのサイトに載っていると分かっているか（`knownPostingSites` の1件版） */
export function isKnownPostingSite(
  ledger: PostingLedger,
  site: PostingSiteId
): boolean {
  return (
    ledger.sites.some((entry) => entry.site === site) ||
    ledger.siteProfiles.some((entry) => entry.site === site)
  );
}

/**
 * そのサイトの作品情報（設計書6.68.5）。**読む側は必ずここを通す。**
 *
 * 投稿先として登録してあるかは見ない——外したサイトの作品情報も残るのが
 * この配列の狙いである。
 */
export function siteProfile(
  ledger: PostingLedger,
  site: PostingSiteId
): PostingSiteProfile | undefined {
  const found = ledger.siteProfiles.find((entry) => entry.site === site);
  if (!found) return undefined;
  const { site: _site, ...profile } = found;
  return hasSiteProfile(profile) ? profile : undefined;
}

/**
 * サイトごとの作品情報を差し替える。**元の台帳は書き換えない。**
 *
 * **1サイトずつ入れ替える。** 配列ごと置き換える形にすると、いま登録して
 * いないサイトの作品情報が、設定をやり直すたびに落ちる（`sites` を丸ごと
 * 置き換えて作品情報が消えていた不具合と同じ形になる）。
 *
 * 全欄が空になったら行ごと消す。並びは動かさない——書き換えのたびに末尾へ
 * 移すと、1文字直しただけでGitの差分が2行になる。
 */
export function withSiteProfile(
  ledger: PostingLedger,
  site: PostingSiteId,
  profile: PostingSiteProfile | undefined
): PostingLedger {
  const normalized = normalizeSiteProfile(profile);
  if (!normalized) {
    return {
      ...ledger,
      siteProfiles: ledger.siteProfiles.filter((entry) => entry.site !== site),
    };
  }

  const next: PostingSiteProfileEntry = { site, ...normalized };
  const found = ledger.siteProfiles.some((entry) => entry.site === site);
  return {
    ...ledger,
    siteProfiles: found
      ? ledger.siteProfiles.map((entry) => (entry.site === site ? next : entry))
      : [...ledger.siteProfiles, next],
  };
}

/** 順位の省いてよい欄（見出し・期間・ジャンル）を読む。形の違う欄は持たない */
function readRankingExtras(
  entry: Record<string, unknown>
): Pick<PostingRankingRecord, "boardLabel" | "span" | "genre"> {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  const boardLabel = text(entry.boardLabel);
  const genre = text(entry.genre);
  return {
    ...(boardLabel !== undefined ? { boardLabel } : {}),
    ...(isPostingRankingSpan(entry.span) ? { span: entry.span } : {}),
    ...(genre !== undefined ? { genre } : {}),
  };
}

/** 順位として受けられる値か。**1以上の整数だけ**（0位も-1位も無い） */
function isRank(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function requireSiteId(value: unknown, path: string): PostingSiteId {
  if (typeof value !== "string") invalid(path);
  const found = POSTING_SITES.find((site) => site.id === value);
  // **知らないサイトは読み飛ばさない。** 飛ばすと、そのサイトへ出した
  // 記録だけが消えて「まだ出していない」ことになる
  if (!found) invalid(path);
  return found.id;
}

/**
 * 同じサイトが2つ登録されていないことを確かめる。
 *
 * **後勝ちで畳まず、読めないと言って止める**（章立ての開始の重複と同じ）。
 * URLが2つあるとき、どちらが本当かは作者にしか分からない。
 */
export function assertUniqueSites(sites: readonly PostingSiteEntry[]): void {
  const seen = new Set<PostingSiteId>();
  for (const entry of sites) {
    if (seen.has(entry.site)) {
      invalid(`sites（${postingSiteInfo(entry.site).label}が2つあります）`);
    }
    seen.add(entry.site);
  }
}

/**
 * 同じサイトの作品情報が2つ書かれていないことを確かめる。
 *
 * **後勝ちで畳まない**（`assertUniqueSites` と同じ理由）。作品IDが2つ
 * あるとき、どちらが本当かは作者にしか分からない。
 */
export function assertUniqueSiteProfiles(
  profiles: readonly PostingSiteProfileEntry[]
): void {
  const seen = new Set<PostingSiteId>();
  for (const entry of profiles) {
    if (seen.has(entry.site)) {
      invalid(
        `siteProfiles（${postingSiteInfo(entry.site).label}が2つあります）`
      );
    }
    seen.add(entry.site);
  }
}

/**
 * 対象サイトを置き換える。**元の台帳は書き換えない**
 *
 * **作品情報（`siteProfiles`）には触らない**（設計書6.68.5）。ここが
 * 触っていたころは、投稿サイトの設定でチェックを外した拍子に、そのサイトの
 * 作品IDも作者が書いたメモも消えていた。順位と同じで、投稿先から外しても
 * 書いたものは残る。
 */
export function withSites(
  ledger: PostingLedger,
  sites: readonly PostingSiteEntry[]
): PostingLedger {
  const next = sites.map((entry) => ({
    site: entry.site,
    newEpisodeUrl: entry.newEpisodeUrl,
  }));
  assertUniqueSites(next);
  return { ...ledger, sites: next };
}

/**
 * 記録を引く鍵（設計書6.68.2）。**「投稿済みか」も「投稿済みにする」も
 * ここを通す**——判定と記録で鍵の作り方が分かれると、書いたのに引けない
 * 記録ができる。
 *
 * **ファイルまるごとの鍵は相対パスそのもの。** 合本でないファイルの鍵は
 * この機能より前と1文字も変わらないので、既にある台帳がそのまま引ける。
 *
 * 合本の中の1話は、話数（読めなければ並び順）を足した鍵になる。区切りに
 * 使う `\u0000` は、ファイル名にもパスにも現れない。
 */
export function postingEpisodeKey(target: PostingEpisodeTargetLike): string {
  const wanted = toTarget(target);
  const path = normalizeEpisodePath(wanted.episodePath);
  if (typeof wanted.chapter === "number") return `${path}\u0000話${wanted.chapter}`;
  if (typeof wanted.order === "number") return `${path}\u0000番目${wanted.order}`;
  return path;
}

/** 文字列で指されたら「ファイルまるごと」 */
function toTarget(target: PostingEpisodeTargetLike): PostingEpisodeTarget {
  return typeof target === "string" ? { episodePath: target } : target;
}

/**
 * 記録に残す話の指し方。**ファイルまるごとの記録には欄を足さない**
 * （`importedBaseline` と同じで、読んで書き戻すだけで中身が増えないように）。
 */
function episodeRefFields(
  target: PostingEpisodeTarget
): { chapter?: number } | { order?: number } {
  if (typeof target.chapter === "number") return { chapter: target.chapter };
  if (typeof target.order === "number") return { order: target.order };
  return {};
}

/**
 * その話を、そのサイトへ出したか。
 *
 * 見るのは2つ——**その話そのものの記録**と、**ファイルまるごとの記録**。
 * 後者はこの欄ができる前の記録（と基準線）で、そのころは合本でも全話ぶんの
 * 本文をコピーして投稿していたので「全話を投稿済み」と読む。
 *
 * 逆は成り立たない。合本の第3話だけ出した記録は、**ファイルまるごとを
 * 投稿済みにはしない**（まだ出していない話が残っている）。
 */
export function isPosted(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId
): boolean {
  const key = postingEpisodeKey(target);
  const filePath = normalizeEpisodePath(toTarget(target).episodePath);
  return ledger.posts.some((post) => {
    if (post.site !== site) return false;
    const postKey = postingEpisodeKey(post);
    return postKey === key || postKey === filePath;
  });
}

/**
 * 「投稿しました」を記録する。**元の台帳は書き換えない**——保存に失敗した
 * ときに、画面の中だけが進んだ状態を作らないため（章立てと同じ流儀）。
 *
 * 同じ話・同じサイトの記録は**1件に保つ**（日時は新しいほうで上書き）。
 * 2件あっても読みは変わらないが、出し直すたびに台帳が伸びていく。
 */
export function withPost(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId,
  postedAt: string,
  /** 投稿したときの本文の印（6.68.7。`postingBodyHash`）。渡さなければ欄を持たない */
  bodyHash?: string,
  /**
   * ヘルパーへ渡した貼り込みの札（6.68.8）。封筒でコピーしたときだけ渡す。
   * **前の投稿の札は引き継がない**——札はその貼り込みを指すもので、新しく貼り込めば別の札になる
   */
  postRef?: string,
  /** 投稿したときの題だけの印（6.68.7。`postingTitleHash`）。渡さなければ欄を持たない */
  titleHash?: string
): PostingLedger {
  const wanted = toTarget(target);
  const key = postingEpisodeKey(wanted);
  const sameKey = (post: PostingRecord) =>
    post.site === site && postingEpisodeKey(post) === key;
  /*
    **同じ鍵の記録だけを置き換える。** 合本の第3話を出し直しても、
    第4話の記録や、ファイルまるごとの古い記録には触らない。
  */
  const kept = ledger.posts.filter((post) => !sameKey(post));
  /*
    **サイトの話の番号は引き継ぐ**（6.68.7）。番号はヘルパーが送り返した値で、
    この関数を呼ぶ側は知らない——置き換えで消すと、編集画面を直に開けなくなる。
  */
  const siteEpisodeId = ledger.posts.find(sameKey)?.siteEpisodeId;
  return {
    ...ledger,
    posts: [
      ...kept,
      {
        episodePath: normalizeEpisodePath(wanted.episodePath),
        site,
        postedAt,
        ...episodeRefFields(wanted),
        ...(bodyHash ? { bodyHash } : {}),
        ...(titleHash ? { titleHash } : {}),
        ...(siteEpisodeId ? { siteEpisodeId } : {}),
        ...(postRef ? { postRef } : {}),
      },
    ],
  };
}

/**
 * 札で投稿の記録を引く（6.68.8）。**そのサイトの記録だけを見る**（札は1つの貼り込み＝
 * 1つのサイトへの投稿を指す）。無ければ undefined。
 */
export function postRecordForPostRef(
  ledger: PostingLedger,
  site: PostingSiteId,
  postRef: string
): PostingRecord | undefined {
  const ref = postRef.trim();
  if (!ref) return undefined;
  return ledger.posts.find((post) => post.site === site && post.postRef === ref);
}

/** 投稿の記録が指す話（`PostingEpisodeTarget` の形。合本の1話なら話数か並び順を持つ） */
export function postingTargetOfRecord(record: PostingRecord): PostingEpisodeTarget {
  return {
    episodePath: record.episodePath,
    ...(typeof record.chapter === "number"
      ? { chapter: record.chapter }
      : typeof record.order === "number"
        ? { chapter: null, order: record.order }
        : {}),
  };
}

/**
 * 投稿済みの基準線を引く（設計書6.68.2）。
 *
 * **導入前に出した話まで「未投稿」と数えないため**の記録である。19話まで
 * 書いてからこの機能を使い始めた作品で、全話に「未投稿2」の印が並んでも
 * 誰の役にも立たない。初回に「どの話まで出しましたか」を1度だけ訊く。
 *
 * **既にある記録は1つも書き換えない。** 実際に投稿した記録（日時つき）を、
 * あとから引いた基準線で塗り替えてはいけない。
 *
 * @param episodePaths 投稿済みとみなす話。空なら1件も入れない（「最初から」）
 * @param postedAt 導入した時刻。**本当の投稿日時ではない**ので、
 *   `importedBaseline` の印を付けて見分けられるようにする
 */
export function withBaselinePosts(
  ledger: PostingLedger,
  episodePaths: readonly string[],
  sites: readonly PostingSiteId[],
  postedAt: string
): PostingLedger {
  const added: PostingRecord[] = [];
  for (const episodePath of episodePaths) {
    const wanted = normalizeEpisodePath(episodePath);
    for (const site of sites) {
      if (isPosted(ledger, wanted, site)) continue;
      added.push({
        episodePath: wanted,
        site,
        postedAt,
        importedBaseline: true,
      });
    }
  }
  if (added.length === 0) return { ...ledger, posts: [...ledger.posts] };
  return { ...ledger, posts: [...ledger.posts, ...added] };
}

/**
 * その話で、まだ出していないサイト。
 *
 * **登録したサイトの中だけを見る。** noteに出していない作品で note を
 * 「未投稿」と数えると、いつまでも印が消えない（6.68.3の3）。
 */
export function unpostedSites(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike
): PostingSiteId[] {
  return ledger.sites
    .map((entry) => entry.site)
    .filter((site) => !isPosted(ledger, target, site))
    // 画面に出す順を `POSTING_SITES` に揃える（`postingSiteLabels` と同じ理由）
    .sort(
      (left, right) =>
        POSTING_SITES.findIndex((site) => site.id === left) -
        POSTING_SITES.findIndex((site) => site.id === right)
    );
}

/**
 * その話を、もう出したサイト（6.68.7。修正版を出し直す先の候補）。
 *
 * **登録したサイトの中だけを見る**（`unpostedSites` と対）。外したサイトへ出した記録は
 * 残っているが、外している間はそのサイトを案内しない（未投稿の数と同じ線）。
 * 基準線（導入前に出した話）も「出した」に入れる——出したことは事実で、直すなら貼り替える。
 */
export function postedSites(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike
): PostingSiteId[] {
  const unposted = new Set(unpostedSites(ledger, target));
  return ledger.sites
    .map((entry) => entry.site)
    .filter((site) => !unposted.has(site))
    .sort(
      (left, right) =>
        POSTING_SITES.findIndex((site) => site.id === left) -
        POSTING_SITES.findIndex((site) => site.id === right)
    );
}

/**
 * その話・そのサイトの投稿の記録（出し直しの画面に投稿日を添えるため）。
 *
 * その話そのものの記録を先に見て、無ければファイルまるごとの記録（`isPosted` と同じ読み）。
 */
export function postRecordFor(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId
): PostingRecord | undefined {
  const key = postingEpisodeKey(target);
  const filePath = normalizeEpisodePath(toTarget(target).episodePath);
  const onSite = ledger.posts.filter((post) => post.site === site);
  return (
    onSite.find((post) => postingEpisodeKey(post) === key) ??
    onSite.find((post) => postingEpisodeKey(post) === filePath)
  );
}

/**
 * その話・そのサイトの出し直しの履歴（6.68.7）。**新しい順。**
 *
 * 日時が同じ（または読めない）ものは、台帳の後ろにあるほうを新しいと読む——
 * `withRevision` は末尾へ足すので、後ろほど後から記録したものである。
 */
export function revisionsFor(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId
): PostingRevisionRecord[] {
  const key = postingEpisodeKey(target);
  return (ledger.revisions ?? [])
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.site === site && postingEpisodeKey(record) === key)
    .sort((left, right) => {
      const byTime = Date.parse(right.record.revisedAt) - Date.parse(left.record.revisedAt);
      return Number.isFinite(byTime) && byTime !== 0 ? byTime : right.index - left.index;
    })
    .map(({ record }) => record);
}

/** その話・そのサイトで、いちばん最近に修正版を出し直した記録 */
export function revisionFor(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId
): PostingRevisionRecord | undefined {
  return revisionsFor(ledger, target, site)[0];
}

/**
 * 「修正版を出し直しました」を記録する（6.68.7）。**元の台帳は書き換えない。**
 *
 * **`posts` には触らない**——出し直しは新しい話を出したことにならない。未投稿の数も、
 * 投稿した日時も変わらない。**履歴として末尾へ足す**（同じ話・同じサイトでも消さない。
 * 作者の裁定 2026-11-03 昼）。
 *
 * @param bodyHash 出し直したときの本文の印（`postingBodyHash`）。渡さなければ欄を持たない
 */
export function withRevision(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId,
  revisedAt: string,
  bodyHash?: string,
  /** 出し直したときの題だけの印（`postingTitleHash`）。渡さなければ欄を持たない */
  titleHash?: string
): PostingLedger {
  const wanted = toTarget(target);
  return {
    ...ledger,
    revisions: [
      ...(ledger.revisions ?? []),
      {
        episodePath: normalizeEpisodePath(wanted.episodePath),
        site,
        revisedAt,
        ...episodeRefFields(wanted),
        ...(bodyHash ? { bodyHash } : {}),
        ...(titleHash ? { titleHash } : {}),
      },
    ],
  };
}

/**
 * その話・そのサイトで、最後にサイトへ渡した記録（6.68.7）。**出し直しがあれば最新の出し直し、
 * 無ければ投稿。** 本文の印（`lastSentBodyHash`）も題の印（`lastSentTitleHash`）もここから引く——
 * 2つが別の記録を「最後」と読むと、本文と題の比べ先が食い違う。
 */
function lastSentRecord(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId
): { bodyHash?: string; titleHash?: string } | undefined {
  const revision = revisionFor(ledger, target, site);
  const post = postRecordFor(ledger, target, site);
  if (!revision) return post;
  /*
    ふつうは出し直しのほうが新しい。投稿の記録があとから書かれた（台帳を手で直した等）
    ときだけ投稿の記録を採る——日時が読めなければ出し直しを採る
  */
  if (post && Date.parse(post.postedAt) > Date.parse(revision.revisedAt)) return post;
  return revision;
}

/**
 * その話・そのサイトで、最後にサイトへ渡した本文の印（6.68.7）。
 *
 * 最後の記録（`lastSentRecord`）に印が無ければ undefined（＝分からない）を返し、
 * **古い記録の印へ遡らない**——印を持たない版で出し直した直後に、その前の投稿の印と比べて
 * 「直した」と言ってしまう。
 */
export function lastSentBodyHash(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId
): string | undefined {
  return lastSentRecord(ledger, target, site)?.bodyHash;
}

/**
 * その話・そのサイトで、最後にサイトへ渡した題だけの印（6.68.7。0.125.2）。
 * 遡らない決まりは `lastSentBodyHash` と同じ。
 */
export function lastSentTitleHash(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId
): string | undefined {
  return lastSentRecord(ledger, target, site)?.titleHash;
}

/**
 * 最後にそのサイトへ渡した題と、今の題が違うと**分かる**か（6.68.7。作者の裁定 2026-11-03 夜）。
 * 出し直しの案内に「題（サブタイトル）も貼り替えてください」を添えるかに使う。
 *
 * 最後の記録に題の印が無い（0.125.1 までの記録・基準線）ときは偽——分からないことを
 * 「直した」と言わない。題と本文の印（`v2:`）が違っても、題が違うとは言えない。
 *
 * @param currentTitleHash 今の題の印（`core/postingBodyHash.ts` の `postingTitleHash`）。
 *   候補の並び（`postingTitleHashCandidates`）も受ける——.md 化で題のルビの書き方だけが
 *   変わった話に「題も貼り替えて」と添えないため（0.126.4）。どれかと一致すれば「違う」と言わない
 */
export function titleChangedSinceSent(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId,
  currentTitleHash: string | readonly string[]
): boolean {
  const sent = lastSentTitleHash(ledger, target, site);
  if (sent === undefined) return false;
  const candidates = typeof currentTitleHash === "string" ? [currentTitleHash] : currentTitleHash;
  return !candidates.includes(sent);
}

/** 出し直しが要るか（`revisionNeed` の答え） */
export type RevisionNeed = "changed" | "same" | "unknown";

/**
 * 出し直しが要るか（6.68.7）。
 *
 * - `"changed"`：最後にサイトへ渡した本文と今の本文が違う（投稿のあとに直した）
 * - `"same"`：同じ
 * - `"unknown"`：印が無い（0.124.0 より前の記録・基準線）か、そのサイトへまだ出していない
 *
 * **0.124.0 の印（本文だけ。頭に `v2:` が無い）との比べ方**：本文だけの印どうしで比べ、違えば
 * `"changed"`（本文を直したことは確か）、同じなら `"unknown"`（題を直したかは、その印からは
 * 分からない）。同じを `"same"` にすると、題だけ直した話を「直していない」と言い切ることになる。
 * 今の取り方に揃えて比べると、直していない話まで全部「直した」になる（取り方が違うため）。
 *
 * **`v3:`（0.126.4 から記録する印）** はルビ・傍点の書き方の違いを同じとみなす（.md 化しただけの
 * 話を「直した」と言わない）。`v2:`・無印の記録は書き換えず、今の本文を投稿サイトの書き方へ
 * 戻した写しの印（`titledCopies`・`bodyOnlyCopies`）とも比べる——一致すれば投稿した本文は
 * その写しそのものなので、偽の「同じ」は出ない。
 *
 * @param current 今の話の印（`core/postingBodyHash.ts` の `postingTextHashes`）。
 *   **`models` は印を計算しない**（本文の正規化がメモ行の判定など `core` の部品を使うため）
 */
export function revisionNeed(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId,
  current: PostingTextHashes
): RevisionNeed {
  if (!isPosted(ledger, target, site)) return "unknown";
  const sent = lastSentBodyHash(ledger, target, site);
  if (!sent) return "unknown";
  if (isNotationTextHash(sent)) return sent === current.notation ? "same" : "changed";
  if (isTitledTextHash(sent)) {
    return sent === current.titled || current.titledCopies.includes(sent) ? "same" : "changed";
  }
  return sent === current.bodyOnly || current.bodyOnlyCopies.includes(sent)
    ? "unknown"
    : "changed";
}

/**
 * その話で、出し直しが要るサイト（登録したサイトのうち、投稿のあとに本文か題を直したもの）。
 * 並びは `POSTING_SITES` の順（`postedSites` と同じ）。
 */
export function sitesNeedingRevision(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  current: PostingTextHashes
): PostingSiteId[] {
  return postedSites(ledger, target).filter(
    (site) => revisionNeed(ledger, target, site, current) === "changed"
  );
}

/**
 * そのファイルに、本文の印つきの記録が1つでもあるか（6.68.7）。
 *
 * 作品から投稿を始めたときに「出し直しが要る話」を探すが、**印の無いファイルは読まない**
 * （200話の作品で、印を持たない話まで全部読ませない）。合本の1話の記録もファイルで拾う。
 */
export function hasBodyHashFor(ledger: PostingLedger, episodePath: string): boolean {
  const wanted = normalizeEpisodePath(episodePath);
  const hit = (record: { episodePath: string; bodyHash?: string }) =>
    Boolean(record.bodyHash) && normalizeEpisodePath(record.episodePath) === wanted;
  return ledger.posts.some(hit) || (ledger.revisions ?? []).some(hit);
}

/**
 * その話・そのサイトの、サイトの話の番号（6.68.7）。
 *
 * **その話そのものの記録だけを見る**（ファイルまるごとの記録へは落とさない。理由は
 * `withSiteEpisodeId`）。
 */
export function siteEpisodeIdFor(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId
): string | undefined {
  const key = postingEpisodeKey(target);
  return ledger.posts.find((post) => post.site === site && postingEpisodeKey(post) === key)
    ?.siteEpisodeId;
}

/**
 * サイトの話の番号を投稿の記録へ入れる（6.68.7）。**元の台帳は書き換えない。**
 *
 * ヘルパーが投稿のあとに送り返す番号を受ける口（`novelai-posted` と `novelai-chapters` の
 * `episodeId`。受け手は `features/importPosted.ts`。6.68.8）。
 *
 * **その話そのものの記録にだけ入れる。** `postRecordFor` のようにファイルまるごとの記録へ
 * 落とすと、合本の1話の番号がファイル全体の記録に付き、別の話の編集画面を開くことになる。
 *
 * @returns 入れた台帳。当てる記録が無い（まだ投稿の記録が無い）か、番号の形が違えば undefined
 *   （呼ぶ側が黙って捨てないように、入らなかったことを返す）
 */
export function withSiteEpisodeId(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId,
  siteEpisodeId: string
): PostingLedger | undefined {
  const id = siteEpisodeId.trim();
  if (!SITE_EPISODE_ID_PATTERN.test(id)) return undefined;
  const key = postingEpisodeKey(target);
  const index = ledger.posts.findIndex(
    (post) => post.site === site && postingEpisodeKey(post) === key
  );
  if (index < 0) return undefined;
  const posts = [...ledger.posts];
  posts[index] = { ...posts[index], siteEpisodeId: id };
  return { ...ledger, posts };
}

/**
 * まだ出しきっていない、いちばん古い話（6.68.3の1）。
 *
 * @param episodePaths 話の相対パス。**話数順に並んでいること**
 *   （走査の結果をそのまま渡す。ここでは並べ替えない——番号を持たない話や
 *   日付の話の順は、走査のほうが正しく知っている）
 */
export function firstUnpostedEpisodePath(
  ledger: PostingLedger,
  episodePaths: readonly string[]
): string | undefined {
  if (ledger.sites.length === 0) return undefined;
  return episodePaths.find((episodePath) => unpostedSites(ledger, episodePath).length > 0);
}

/**
 * 順位を書き足す（設計書6.68.5）。**元の台帳は書き換えない。**
 *
 * **追記だけで、既にある記録には触らない。** 順位は「そのとき何位だったか」
 * の記録なので、同じ種別の記録が2つあっても畳んではいけない
 * （投稿の記録が1件に保たれるのとは、ここが違う）。
 */
export function withRanking(
  ledger: PostingLedger,
  record: PostingRankingRecord
): PostingLedger {
  if (!isRank(record.rank)) invalid("rank");
  const board = record.board.trim();
  if (!board) invalid("board");
  const note = (record.note ?? "").trim();
  return {
    ...ledger,
    rankings: [
      ...ledger.rankings,
      {
        site: record.site,
        recordedAt: record.recordedAt,
        board,
        rank: record.rank,
        // **空のメモは持たせない**（台帳が中身の無い欄で膨らまないように）
        ...(note ? { note } : {}),
        // 出どころは API・ヘルパーのときだけ持つ（手入力は欄そのものが無い）
        ...(record.source === "narou-api" || record.source === "helper"
          ? { source: record.source }
          : {}),
        ...readRankingExtras({ ...record }),
      },
    ],
  };
}

/**
 * ヘルパーの順位が、**同じ鍵でもう台帳にある**か（2026-11-02。ヘルパーとの取り決め）。
 *
 * 鍵はサイト＋区分（`board`）＋日付（作品はこの台帳そのもの）。**順位が違っても積まない**
 * ——取り決めの「同じ鍵は積まない」のまま。同じ束が呼び出しと貼り付けで2度届く・ヘルパーの
 * 「もう一度渡す」で古い束が届くので、あとから届いた方が新しいとは限らない（積んだ方を残す）。
 * 見るのはヘルパーの順位どうしだけ（手入力・API の順位とは鍵の作りが違う）
 */
export function hasHelperRankingOn(
  ledger: PostingLedger,
  record: Pick<PostingRankingRecord, "site" | "board" | "recordedAt">
): boolean {
  const board = record.board.trim();
  return ledger.rankings.some(
    (entry) =>
      entry.source === "helper" &&
      entry.site === record.site &&
      entry.board === board &&
      entry.recordedAt === record.recordedAt
  );
}

/**
 * 積もうとしている順位が、**台帳にもうある順位の繰り返し**か（2026-11-02）。
 *
 * なろう殿堂入りAPIは、押すたびにその作品の**過去の順位をすべて**返す。そのまま積むと
 * 押した回数だけ同じ履歴が重なるので、**同じサイト・種別・日時・出どころで同じ順位**なら
 * 積まない。順位が違えば積む（サイトが数え直した。台帳は追記だけで、前の値は消さない）
 */
export function repeatsRanking(
  ledger: PostingLedger,
  record: PostingRankingRecord
): boolean {
  return ledger.rankings.some(
    (entry) =>
      entry.site === record.site &&
      entry.board === record.board.trim() &&
      entry.recordedAt === record.recordedAt &&
      entry.rank === record.rank &&
      entry.source === record.source
  );
}

/** そのサイトの記録を、新しい順で返す（画面はこの順に並べる） */
export function rankingsForSite(
  ledger: PostingLedger,
  site: PostingSiteId
): PostingRankingRecord[] {
  return ledger.rankings
    .filter((entry) => entry.site === site)
    .sort((left, right) => compareRecordedAtDesc(left, right));
}

/** そのサイトの最新の順位。1件も無ければ undefined */
export function latestRanking(
  ledger: PostingLedger,
  site: PostingSiteId
): PostingRankingRecord | undefined {
  return rankingsForSite(ledger, site)[0];
}

/**
 * 種別の候補（設計書6.68.5）。
 *
 * **こちらで一覧を決め打ちしない。** 「日間」「週間」の呼び方はサイトごとに
 * 違い、企画やジャンル別の名前は作品ごとに違う。作者が過去に使った言葉を
 * そのまま候補にする——そのサイトで使ったものを先に、次にほかのサイトのもの。
 */
export function rankingBoards(
  ledger: PostingLedger,
  site: PostingSiteId
): string[] {
  // ヘルパーの順位の `board` は機械向けの区分の鍵なので、作者の打つ候補に混ぜない（2026-11-02）
  const newestFirst = ledger.rankings
    .filter((entry) => entry.source !== "helper")
    .sort(compareRecordedAtDesc);
  const boards: string[] = [];
  for (const entry of newestFirst) {
    if (entry.site === site && !boards.includes(entry.board)) {
      boards.push(entry.board);
    }
  }
  for (const entry of newestFirst) {
    if (!boards.includes(entry.board)) boards.push(entry.board);
  }
  return boards;
}

/**
 * 新しい順に並べるための比較。
 *
 * ふつうはISO8601なので文字列のままでも並ぶが、作者が手で直した台帳には
 * 別の書き方が入りうる。日時として読めるならその値で、読めなければ
 * 文字列で比べる（並ばないより、崩れずに並ぶほうがよい）。
 */
function compareRecordedAtDesc(
  left: PostingRankingRecord,
  right: PostingRankingRecord
): number {
  const leftTime = Date.parse(left.recordedAt);
  const rightTime = Date.parse(right.recordedAt);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
    return rightTime - leftTime;
  }
  return right.recordedAt.localeCompare(left.recordedAt);
}

/**
 * 作者が打った順位を数として読む（設計書6.68.5）。
 *
 * **全角の数字も読む。** 日本語入力のまま打てば「１２」になるのが自然で、
 * それを断るのは作者に変換の仕方を疑わせるだけである。
 *
 * @returns 1以上の整数。読めなければ null
 */
export function parseRankInput(value: string): number | null {
  const normalized = value
    .trim()
    // 全角数字を半角へ（U+FF10〜U+FF19）
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0)
    );
  if (!/^\d+$/.test(normalized)) return null;
  const rank = Number(normalized);
  return isRank(rank) ? rank : null;
}

/** 順位の入力を断るときの言い方。問題なければ null */
export function validateRankInput(value: string): string | null {
  if (!value.trim()) return "順位を数字で入力してください。";
  return parseRankInput(value) === null
    ? "順位は1以上の整数で入力してください（1位なら 1）。"
    : null;
}

/*
  ここから下は読者の反応（設計書6.79.7）。

  **順位（`withRanking`）と同じ流儀で書いてある**——追記だけ、畳まない、
  読めない値は直さずに止める。違うのは、数値が1件に何個も入ることと、
  「作品全体か1話か」「どの期間か」を一緒に持つことだけである。
*/

/**
 * その欄の値として受けられるか。
 *
 * **小数を受けるのは、小数の欄だけ**（`fractionDigits` を持つ欄）。
 * PVやブックマークまで緩めると、打ち間違いの「1.234」が黙って入る。
 * 0は「読んだが0だった」という意味を持つので受ける（順位の1以上とは違う）。
 *
 * **負を受けるのは、日別の増減の欄だけ**（`ReaderStatsMetricInfo.dailyChange`
 * の欄の、`period: "day"` の行。作者の裁定 2026-09-23）。粒度を渡さない
 * 呼び方では、これまでどおり0以上だけを受ける。
 */
export function isReaderStatsValue(
  value: unknown,
  info: ReaderStatsMetricInfo,
  period?: unknown
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (value < 0 && !acceptsNegativeReaderStats(info, period)) return false;
  // 負の小数は、小数の欄でも受けない（増減の欄はどれも整数の欄）
  if (value < 0) return Number.isSafeInteger(value);
  if (info.fractionDigits === undefined) return Number.isSafeInteger(value);
  // 小数の欄でも、桁が溢れた値は「読めた」と言えない
  return value <= Number.MAX_SAFE_INTEGER;
}

/**
 * その欄が、その粒度の行で負を受けるか（日別の増減の欄だけ）。
 *
 * 粒度は**読んだまま**（台帳の生の値かもしれない）受け、`"day"` のときだけ
 * 認める——書き間違いの粒度で負が通る抜け道を作らない。
 */
export function acceptsNegativeReaderStats(
  info: ReaderStatsMetricInfo,
  period: unknown
): boolean {
  return info.dailyChange === true && period === "day";
}

/** 数値が1つでも入っているか（共通・サイト固有のどちらでもよい） */
export function hasReaderStatsMetrics(metrics: ReaderStatsMetrics): boolean {
  return ALL_READER_STATS_METRICS.some(
    (info) => metrics[info.key] !== undefined
  );
}

/**
 * 粒度ごとの期間の書き方。
 *
 * **形を決めておかないと、並べたときに揃わない。** 「2026-09-05」と
 * 「2026/9/5」が混ざった履歴は、機械にも人にも同じ日として読めない。
 */
const READER_STATS_PERIOD_KEY: Record<
  Exclude<ReaderStatsPeriod, "total">,
  { pattern: RegExp; example: string }
> = {
  day: { pattern: /^\d{4}-\d{2}-\d{2}$/, example: "2026-09-05" },
  month: { pattern: /^\d{4}-\d{2}$/, example: "2026-09" },
  year: { pattern: /^\d{4}$/, example: "2026" },
};

/** その粒度の期間として読める書き方か */
export function isReaderStatsPeriodKey(
  period: ReaderStatsPeriod,
  value: string | undefined
): boolean {
  // 累計（total）と「その時点」は期間を持たない
  if (period === "total") return value === undefined;
  return (
    value !== undefined && READER_STATS_PERIOD_KEY[period].pattern.test(value)
  );
}

/**
 * 期間の入力を断るときの言い方。問題なければ null。
 *
 * **入力のときだけ、実在する日付かまで確かめる**（0.33.9）。「2026-13」や
 * 「2026-02-30」は打ち間違いで、そのまま入れると並べたときに行方不明になる。
 *
 * **読み込み（`isReaderStatsPeriodKey`）は形だけを見る。** あちらまで
 * 厳しくすると、古い台帳に1つ打ち間違いがあるだけで台帳ぜんぶが読めなく
 * なる——直せるのは打つ瞬間だけで、読む瞬間ではない。
 */
export function validateReaderStatsPeriodKey(
  period: Exclude<ReaderStatsPeriod, "total">,
  value: string
): string | null {
  const trimmed = value.trim();
  const info = READER_STATS_PERIOD_KEY[period];
  if (!trimmed) return `期間を入力してください（例：${info.example}）。`;
  if (!info.pattern.test(trimmed)) {
    return `期間は ${info.example} の形で入力してください。`;
  }
  return isRealPeriodKey(period, trimmed)
    ? null
    : `${trimmed} という${period === "month" ? "月" : "日"}はありません。実在する日付を入力してください（例：${info.example}）。`;
}

/**
 * 形の合った期間キーが、実在する年月日を指しているか。
 *
 * 日は `Date` で往復させて確かめる——2月30日は3月2日として作られるので、
 * 作ったあとに元の値へ戻るかを見れば、実在しない日を見分けられる。
 */
function isRealPeriodKey(
  period: Exclude<ReaderStatsPeriod, "total">,
  value: string
): boolean {
  if (period === "year") return true;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) return false;
  if (period === "month") return true;
  const day = Number(value.slice(8, 10));
  // UTCで作る（手元の時計の時間帯で日付がずれないように）
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * 記録として受けられるかを確かめる。**読めなければ直さずに止める。**
 *
 * 読み込みと保存の両方がここを通る（片方だけ緩いと、そちらが抜け道になる）。
 */
export function assertReaderStatsRecord(
  record: ReaderStatsRecord,
  path = "readerStats"
): void {
  if (!POSTING_SITES.some((site) => site.id === record.site)) {
    invalid(`${path}.site`);
  }
  if (typeof record.readAt !== "string" || !record.readAt.trim()) {
    invalid(`${path}.readAt`);
  }
  if (record.scope !== "work" && record.scope !== "episode") {
    invalid(`${path}.scope`);
  }
  if (record.episode !== undefined) {
    // **作品全体の数字に話数は付かない。** 付いていたらどちらが本当か
    // こちらには決められない（畳まずに止める）
    if (record.scope !== "episode") invalid(`${path}.episode`);
    if (!Number.isSafeInteger(record.episode) || record.episode < 1) {
      invalid(`${path}.episode`);
    }
  }
  if (record.period !== undefined) {
    if (!READER_STATS_PERIODS.includes(record.period)) {
      invalid(`${path}.period`);
    }
    // 粒度と期間は対で意味を持つ。「日別」だけあっても、いつの日か読めない
    if (!isReaderStatsPeriodKey(record.period, record.periodKey)) {
      invalid(`${path}.periodKey`);
    }
  } else if (record.periodKey !== undefined) {
    invalid(`${path}.periodKey`);
  }
  for (const info of ALL_READER_STATS_METRICS) {
    const value = record.metrics[info.key];
    if (value !== undefined && !isReaderStatsValue(value, info, record.period)) {
      invalid(`${path}.metrics.${info.key}`);
    }
  }
  // **中身の無い記録は残さない。** 「読んだ」という事実だけの行が並んでも、
  // あとから見て何も分からない
  if (!hasReaderStatsMetrics(record.metrics)) invalid(`${path}.metrics`);
  if (!READER_STATS_SOURCES.includes(record.source)) {
    invalid(`${path}.source`);
  }
  if (record.updatedAt !== undefined) {
    // **最終更新は話にしか無い**（作品全体の行に付いていたら、どの話の
    // 日時なのか決められない。話数と同じ扱い）
    if (record.scope !== "episode") invalid(`${path}.updatedAt`);
    if (!isReaderStatsUpdatedAt(record.updatedAt)) {
      invalid(`${path}.updatedAt`);
    }
  }
}

/**
 * 最終更新の日時として読める書き方か（ISO 8601、**時差つき**）。
 *
 * **時差を必須にする。** 基準の話は「読み取りの72時間以上前に更新された話」
 * で選ぶので、時差の無い日時は手元の時計しだいで最大半日ずれ、境目の話の
 * 扱いが機械ごとに変わる。貼り込み係は `+09:00` を付けて書く約束である。
 *
 * 見るのは形と、日時として読めることだけ（期間の見出しと同じく、読む側を
 * 厳しくしすぎると、1行の打ち間違いで台帳ぜんぶが読めなくなる）。
 */
export function isReaderStatsUpdatedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(
      value
    )
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** 台帳ぜんぶの記録を確かめる（保存の関所が使う） */
export function assertReaderStatsRecords(
  records: readonly ReaderStatsRecord[]
): void {
  records.forEach((record, index) =>
    assertReaderStatsRecord(record, `readerStats[${index}]`)
  );
}

/**
 * 読者の反応を書き足す（設計書6.79.7）。**元の台帳は書き換えない。**
 *
 * **追記だけで、既にある記録には触らない**（`withRanking` と同じ理由）。
 * 同じ日に2回読めば2件になる——「そのとき何件だったか」の履歴だからである。
 */
export function withReaderStats(
  ledger: PostingLedger,
  record: ReaderStatsRecord
): PostingLedger {
  const note = (record.note ?? "").trim();
  const updatedAt = (record.updatedAt ?? "").trim();
  const metrics: ReaderStatsMetrics = {};
  // **知っている欄だけを写す**（呼ぶ側が足した見覚えのない欄は持ち歩かない）
  for (const info of ALL_READER_STATS_METRICS) {
    const value = record.metrics[info.key];
    if (value !== undefined) metrics[info.key] = value;
  }

  const next: ReaderStatsRecord = {
    site: record.site,
    readAt: record.readAt,
    scope: record.scope,
    // **空の欄は持たせない**（読んで書き戻すだけで中身が増えないように）
    ...(record.episode === undefined ? {} : { episode: record.episode }),
    ...(record.period === undefined ? {} : { period: record.period }),
    ...(record.periodKey === undefined ? {} : { periodKey: record.periodKey }),
    metrics,
    source: record.source,
    ...(note ? { note } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
  assertReaderStatsRecord(next);

  return {
    ...ledger,
    readerStats: [...(ledger.readerStats ?? []), next],
  };
}

/**
 * 取り込もうとしている記録が、**台帳に積んである数の繰り返し**か
 * （残課題 B11 の続き、作者の裁定 2026-09-23「同じ表を2度取り込んでも二重に積まない」）。
 *
 * 台帳は追記だけで畳まない（`withReaderStats`）。ただし、次の2つ（と、関数の中の3。
 * Narou.fun の同じ日の同じ数。2026-11-01）は
 * 「いつ何件だったか」の履歴に何も足さないので積まない：
 *
 * 1. **まったく同じ記録**（読み取り日時・範囲・粒度・期間・数・出どころが同じ）。
 *    Narou.fun の封筒は記録の日時がサイトの「データ取得」の日（2026-11-01 から。それまでは
 *    「最終取得日時」）なので、同じページを2度
 *    押すと、作品全体の数まで同じ日時・同じ数で届く
 * 2. **作品全体の日別の行で、その日の数がいま見えている数と同じ**もの。
 *    Narou.fun の日ごとの増減（ブックマーク・評価ポイント）も、カクヨムの日ごとの
 *    PV（ヘルパー 0.5.0 以降。作品管理ページのグラフ）も直近30日なので、毎日
 *    取り込むと29日ぶんが重なる——読み取り日時が違っても（カクヨムは押した時刻）、
 *    締まった日の数は同じまま届く。比べる相手は、グラフが採る記録
 *    （その日の、読み取り日時がいちばん新しい記録）。**数が違えば積む**
 *    （サイトが数え直した／今日の数が伸びた。グラフは新しいほうを採る＝日付で
 *    上書きに見える）
 *
 * **2はサイトでも欄でも分けない**（作者の裁定 2026-09-23「Narou.fun と同じく
 * 同じ数は積まない形にそろえる」）。日別の行の意味は「その日ぶんの数」で、
 * どのサイトのどの欄でも、同じ日の同じ数を2度持っても履歴は増えないため。
 * その時点の値・月別・年別・累計・話ごとは2を通さない——日時が違えば
 * 「その時に見た数」として積む（数が同じでも、その日時に同じだったという記録になる）。
 *
 * 比べるときにメモは見ない（メモは取り込みの側が付ける説明で、数ではない）。
 * バックアップの取り込み（`backupMerge.ts` の「直前と同じなら積まない」）と同じ考え方。
 */
export function repeatsReaderStats(
  ledger: PostingLedger,
  record: ReaderStatsRecord
): boolean {
  const rows = ledger.readerStats ?? [];
  const sameKey = (row: ReaderStatsRecord): boolean =>
    row.site === record.site &&
    row.scope === record.scope &&
    row.episode === record.episode &&
    row.period === record.period &&
    row.periodKey === record.periodKey &&
    row.source === record.source;

  if (
    rows.some(
      (row) =>
        sameKey(row) &&
        row.readAt === record.readAt &&
        (row.updatedAt ?? "") === (record.updatedAt ?? "") &&
        sameReaderStatsMetrics(row.metrics, record.metrics)
    )
  ) {
    return true;
  }

  /*
    3. **Narou.fun の同じ日の読み取りで、その日にいま見えている数と同じ**もの
       （作者の判断 2026-11-01）。読むときに同じ日はあとの方だけを見る
       （`collapseNarouFunSameDay`）ので、同じ数をもう1件積んでも見え方は変わらない。
       **数が違えば積む**——読むときにあとの方が勝つので、新しい数は消えない
  */
  const dayKey = narouFunDayKey(record);
  if (dayKey !== undefined) {
    const sameDay = collapseNarouFunSameDay(
      rows.filter((row) => row.source === record.source && narouFunDayKey(row) === dayKey)
    );
    const shownToday = sameDay[sameDay.length - 1];
    if (shownToday && sameReaderStatsMetrics(shownToday.metrics, record.metrics)) return true;
  }

  // 話ごとの日別は、いまどのサイトも送らず、グラフも描かない（比べる相手が無い）
  if (record.scope !== "work" || record.period !== "day") return false;
  let shown: { row: ReaderStatsRecord; time: number } | undefined;
  for (const row of rows) {
    if (!sameKey(row)) continue;
    const time = Date.parse(row.readAt);
    if (Number.isNaN(time)) continue;
    // 同じ日時ならあとから足したほう（グラフの `periodChart` と同じ拾い方）
    if (!shown || time >= shown.time) shown = { row, time };
  }
  return (
    shown !== undefined && sameReaderStatsMetrics(shown.row.metrics, record.metrics)
  );
}

/** 同じ欄に同じ数が入っているか（欄の有る無しも比べる） */
function sameReaderStatsMetrics(
  left: ReaderStatsMetrics,
  right: ReaderStatsMetrics
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/** そのサイトの反応を、新しい順で返す（画面はこの順に並べる） */
export function readerStatsForSite(
  ledger: PostingLedger,
  site: PostingSiteId
): ReaderStatsRecord[] {
  // 同じ日の Narou.fun の読み取りは、あとの方だけを見る（`collapseNarouFunSameDay`）
  return collapseNarouFunSameDay(readerStatsInLedgerOrder(ledger, site)).sort(
    (left, right) => compareReadAtDesc(left, right)
  );
}

/**
 * そのサイトの反応を、**台帳に書かれた順のまま**返す（率とグラフ用。同じ日時に2件あれば
 * あとから足したほうを採るには、足した順が要る）。同じ日の Narou.fun の読み取りは畳む
 */
export function readerStatsInLedgerOrder(
  ledger: PostingLedger,
  site: PostingSiteId
): ReaderStatsRecord[] {
  return collapseNarouFunSameDay(
    (ledger.readerStats ?? []).filter((entry) => entry.site === site)
  );
}

/**
 * なろうファンDB（Narou.fun）の、**同じ日の読み取りを1つに畳む**（作者の判断 2026-11-01）。
 * 同じ日に2回以上読んだら、**あとの方だけ**を残す。日ごとのグラフ・履歴の表が1日1つになる。
 *
 * - **台帳は書き換えない。** 読むときに畳むだけで、作者のファイルからは1件も消さない
 *   （直す前の版で重なって積まれた記録も、ここを通れば同じ扱いになる）
 * - **日の区切りは手元の暦日（0:00）。** Narou.fun の記録の日時は「データ取得の日の 0:00」
 *   （readAtBasis が fetched。2026-11-01 から）なので、執筆量の区切り（既定は朝4時。
 *   `stats.dayBoundaryHour`）で切ると前の日へ落ちる。履歴の表の「今日」の欄も手元の暦日で
 *   見ている（`postingSiteRecords.ts` の `localDateKey`）ので、そちらに揃えた
 * - **畳むのは「なろう × ヘルパー」の記録だけ。** なろうの数をヘルパーが読むのは
 *   Narou.fun だけ（なろう本体は機械で読まない）なので、この2つで Narou.fun の封筒と言える。
 *   カクヨムの同じ日の2回は、今までどおり「その時に見た数」として2回並べる
 * - 1回の読み取りは範囲・話・粒度・期間ごとに何件にも分かれて入るので、**その組ごと**に
 *   畳む（作品全体の数と、日別の30日ぶんを互いに消さない）
 * - 日時の読めない記録は畳まない（どちらが後か決められない。捨てもしない）
 *
 * @param records **台帳に書かれた順**。返すのも同じ順（落とした記録を抜いただけ）
 */
export function collapseNarouFunSameDay(
  records: readonly ReaderStatsRecord[]
): ReaderStatsRecord[] {
  const latest = new Map<string, { index: number; time: number }>();
  records.forEach((record, index) => {
    const key = narouFunDayKey(record);
    if (key === undefined) return;
    const time = Date.parse(record.readAt);
    const found = latest.get(key);
    // 同じ日時なら、台帳であとにある方（`>=`）
    if (!found || time >= found.time) latest.set(key, { index, time });
  });
  if (latest.size === 0) return [...records];
  return records.filter((record, index) => {
    const key = narouFunDayKey(record);
    return key === undefined || latest.get(key)?.index === index;
  });
}

/**
 * 畳む組の鍵。Narou.fun の記録でなければ undefined（畳まない）。
 * 区切りにNULを使うのは、どの欄にも現れない字だからである（生のままは置かない）
 */
function narouFunDayKey(record: ReaderStatsRecord): string | undefined {
  /*
    なろう小説APIから取った数（`narou-api`。2026-11-02）も**同じ日はあとの方だけ**を見る
    （作者の指示「同じ日に何度取っても積み重ねない」）。**出どころは鍵に入れる**——
    Narou.fun の数と API の数を、互いに畳んで消さない（集計の時機が違う別の数である）
  */
  if (record.site !== "narou") return undefined;
  if (record.source !== "helper" && record.source !== "narou-api") return undefined;
  const when = new Date(record.readAt);
  if (Number.isNaN(when.getTime())) return undefined;
  const day = `${when.getFullYear()}-${when.getMonth() + 1}-${when.getDate()}`;
  return [
    record.source,
    day,
    record.scope,
    record.episode ?? "",
    record.period ?? "",
    record.periodKey ?? "",
  ].join("\u0000");
}

/** そのサイトの最新の反応。1件も無ければ undefined */
export function latestReaderStats(
  ledger: PostingLedger,
  site: PostingSiteId
): ReaderStatsRecord | undefined {
  return readerStatsForSite(ledger, site)[0];
}

/**
 * 新しい順に並べるための比較（順位の `compareRecordedAtDesc` と同じ考え方）。
 *
 * **同じ日時のときの順も決めておく**（0.33.9）。貼り込み係の封筒は1回の
 * 読み取りで何行も入るので、`readAt` が同じ行が並ぶのが普通である。並びが
 * 決まっていないと、「最新の反応」に1話ぶんの数字や日別の数字が出て、
 * 作品の勢いを読み違える。
 *
 *   1. 作品全体（`work`）を先に——見出しに出したいのは作品の数字
 *   2. 累計・粒度なしを先に——「その時点の値」が作品の現在地に近い
 */
function compareReadAtDesc(
  left: ReaderStatsRecord,
  right: ReaderStatsRecord
): number {
  const byTime = compareReadAtOnly(left, right);
  if (byTime !== 0) return byTime;
  const byScope = readerScopeRank(left) - readerScopeRank(right);
  if (byScope !== 0) return byScope;
  return readerPeriodRank(left) - readerPeriodRank(right);
}

/** 日時だけで比べる。読めない書き方なら文字列で比べる（崩さずに並べる） */
function compareReadAtOnly(
  left: ReaderStatsRecord,
  right: ReaderStatsRecord
): number {
  const leftTime = Date.parse(left.readAt);
  const rightTime = Date.parse(right.readAt);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
    return rightTime - leftTime;
  }
  return right.readAt.localeCompare(left.readAt);
}

/** 作品全体が先（0）、1話ぶんが後（1） */
function readerScopeRank(record: ReaderStatsRecord): number {
  return record.scope === "work" ? 0 : 1;
}

/** 累計・粒度なしが先（0）、日別・月別・年別が後（1） */
function readerPeriodRank(record: ReaderStatsRecord): number {
  return record.period === undefined || record.period === "total" ? 0 : 1;
}

/**
 * 作者が打った数を読む（設計書6.79.7）。**全角の数字も読む。**
 *
 * 順位（`parseRankInput`）と違い、**0を受ける**——「いいねは0だった」は
 * 記録に値する事実である。
 *
 * @returns 0以上の整数。読めなければ null
 */
export function parseReaderStatsCount(value: string): number | null {
  const normalized = value
    .trim()
    // 全角数字を半角へ（U+FF10〜U+FF19）
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0)
    )
    // 「1,234」のように区切って打つ人がいる（画面からはその形で読める）
    .replace(/[,，]/g, "");
  if (!/^\d+$/.test(normalized)) return null;
  const count = Number(normalized);
  // 0以上の整数であること（欄を問わない共通の下限。桁溢れもここで落ちる）
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** 数の入力を断るときの言い方。**空欄は飛ばせる**ので、空は断らない */
export function validateReaderStatsCount(value: string): string | null {
  if (!value.trim()) return null;
  return parseReaderStatsCount(value) === null
    ? "0以上の整数で入力してください（読めなければ空のままで構いません）。"
    : null;
}

/**
 * 欄に合わせて数を読む（0.69.9）。**小数を受けるのは小数の欄だけ。**
 *
 * なろうの「評価平均」は 4.50 のような小数になる。整数しか受けない
 * ままだと、**読めた数字を捨てるか、切り捨てて別の値を残すか**しか
 * なくなる——どちらも台帳の流儀に反する。
 *
 * **文字列を数として書き込まない**（0.33.9の戒め）。「1,234」は区切りを
 * 落として `1234` という**数**にしてから返す。ここが `null` を返した値は、
 * 呼ぶ側が欄ごと持たない（0で埋めない）。
 *
 * @returns 読めた数。読めなければ null
 */
export function parseReaderStatsValue(
  value: string,
  info: ReaderStatsMetricInfo
): number | null {
  if (info.fractionDigits === undefined) return parseReaderStatsCount(value);

  const normalized = value
    .trim()
    // 全角数字・全角の小数点を半角へ
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0)
    )
    .replace(/．/g, ".")
    .replace(/[,，]/g, "");
  // 小数点は1つまで。符号も指数も受けない（打ち間違いを通さない）
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return isReaderStatsValue(parsed, info) ? parsed : null;
}

/** 欄に合わせた入力を断るときの言い方。**空欄は飛ばせる**ので、空は断らない */
export function validateReaderStatsValue(
  value: string,
  info: ReaderStatsMetricInfo
): string | null {
  if (!value.trim()) return null;
  if (info.fractionDigits === undefined) return validateReaderStatsCount(value);
  return parseReaderStatsValue(value, info) === null
    ? "0以上の数で入力してください（小数も入れられます。読めなければ空のままで構いません）。"
    : null;
}

/**
 * 作者が打った話番号を読む（設計書6.79.7）。**全角の数字は読む。**
 *
 * **数値（`parseReaderStatsCount`）とは別に持つ**（0.33.9）。あちらは
 * 「1,234」と打たれるので区切りを落とすが、**話番号で同じことをすると
 * 「1,2」が12話になる**——別の話の数字が台帳へ混ざり、あとから分けられない。
 *
 * @returns 1以上の整数。読めなければ null（0話も -1話も無い）
 */
export function parseReaderStatsEpisode(value: string): number | null {
  const normalized = value
    .trim()
    // 全角数字を半角へ（U+FF10〜U+FF19）
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0)
    );
  if (!/^\d+$/.test(normalized)) return null;
  const episode = Number(normalized);
  return Number.isSafeInteger(episode) && episode >= 1 ? episode : null;
}

/** 話番号の入力を断るときの言い方。問題なければ null */
export function validateReaderStatsEpisode(value: string): string | null {
  if (!value.trim()) return "話番号を入力してください。";
  return parseReaderStatsEpisode(value) === null
    ? "話番号は1以上の整数で入力してください（第3話なら 3）。"
    : null;
}
