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
   * 貼り付けた先で記号が並ぶので、`test/unit/posting.test.ts` が見張る。
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
    urlExample: "https://www.alphapolis.co.jp/novel/manage/000000/0000",
    // **2つの番号を「/」で繋げて入れてもらう。** 片方だけでは作品を指せない
    workIdExample: "123456/7890123（作者番号／作品番号）",
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
 * **サイトから取りに行かない。** ランキングのページを機械で読むのは
 * 6.68.1で断った線の内側にある。ここに入るのは、作者が見て打った値だけ。
 */
export interface PostingRankingRecord {
  site: PostingSiteId;
  /** 記録した日時（ISO8601）。順位が出た日時ではなく、書き留めた日時 */
  recordedAt: string;
  /** 種別。日間・週間・月間・ジャンル名など、**サイトの呼び方のまま** */
  board: string;
  /** 順位。1以上の整数 */
  rank: number;
  /** 作者のメモ（任意） */
  note?: string;
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
  alphapolis: [],
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
 */
export type ReaderStatsSource = "helper" | "manual" | "backup";

/**
 * 受け付ける出どころの一覧。**一覧はここ1つだけが持つ**（指標と同じ流儀）。
 *
 * **古い版はこの一覧を知らない。** `設定/` はGitで同期するので、`backup` を
 * 知らない版が読むと、**台帳ごと読めなくなる**（行を飛ばす仕組みは指標に
 * しか無い）。増やすときは、その影響を承知のうえで増やすこと。
 */
export const READER_STATS_SOURCES: readonly ReaderStatsSource[] = [
  "helper",
  "manual",
  "backup",
];

/**
 * 読者の反応の記録（設計書6.79.7）。
 *
 * **追記だけで、畳まない**（順位と同じ流儀）。同じ日に2回読めば2件になる
 * ——これは「いま何件か」の台帳ではなく、「いつ何件だったか」の履歴である。
 *
 * **こちらからサイトを読みにいく処理は無い**（6.68.1の線はそのまま）。
 * 入るのは作者が打った値か、作者が自分で開いた管理画面から貼り込み係が
 * 作った封筒だけである。
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
}

/**
 * 作者が手で編集したJSONを読む。**壊れていたら例外を投げる。**
 *
 * 勝手に直して上書きすると、作者が貼ったURLや投稿の記録が黙って消える
 * （章立て・本の設計図と同じ約束）。
 */
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
      };
    }) ?? [];

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

  return {
    ledger: {
      schemaVersion:
        (value.schemaVersion as string | undefined) ?? POSTING_SCHEMA_VERSION,
      sites,
      siteProfiles,
      posts,
      rankings,
      readerStats,
    },
    skippedReaderStats: skippedReaderStatsRows.length,
    skippedReaderStatsRows,
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
  postedAt: string
): PostingLedger {
  const wanted = toTarget(target);
  const key = postingEpisodeKey(wanted);
  /*
    **同じ鍵の記録だけを置き換える。** 合本の第3話を出し直しても、
    第4話の記録や、ファイルまるごとの古い記録には触らない。
  */
  const kept = ledger.posts.filter(
    (post) => !(post.site === site && postingEpisodeKey(post) === key)
  );
  return {
    ...ledger,
    posts: [
      ...kept,
      {
        episodePath: normalizeEpisodePath(wanted.episodePath),
        site,
        postedAt,
        ...episodeRefFields(wanted),
      },
    ],
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
      },
    ],
  };
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
  const newestFirst = [...ledger.rankings].sort(compareRecordedAtDesc);
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
 * 台帳は追記だけで畳まない（`withReaderStats`）。ただし、次の2つは
 * 「いつ何件だったか」の履歴に何も足さないので積まない：
 *
 * 1. **まったく同じ記録**（読み取り日時・範囲・粒度・期間・数・出どころが同じ）。
 *    Narou.fun の封筒は記録の日時が「最終取得日時」なので、同じページを2度
 *    押すと、作品全体の数まで同じ日時・同じ数で届く
 * 2. **日別の増減の行で、その日の数がいま見えている数と同じ**もの。日ごとの表は
 *    直近30日なので、毎日取り込むと29日ぶんが重なる——読み取り日時が違っても、
 *    締まった日の増減は同じ数のまま届く。比べる相手は、グラフが採る記録
 *    （その日の、読み取り日時がいちばん新しい記録）。**数が違えば積む**
 *    （サイトが数え直した。グラフは新しいほうを採る＝日付で上書きに見える）
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

  const isDailyChange =
    record.scope === "work" &&
    record.period === "day" &&
    Object.keys(record.metrics).some(
      (key) => readerStatsMetricInfo(key)?.dailyChange === true
    );
  if (!isDailyChange) return false;
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
  return (ledger.readerStats ?? [])
    .filter((entry) => entry.site === site)
    .sort((left, right) => compareReadAtDesc(left, right));
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
