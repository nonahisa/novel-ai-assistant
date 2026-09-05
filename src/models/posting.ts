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
 * 読者の反応の数値（設計書6.79.7）。
 *
 * **読めた欄だけを持つ。** 「読めなかった」を0で埋めると、次に読んだときに
 * 減ったように見える——PVが0の日と、PVを読めなかった日は別のことである。
 */
export interface ReaderStatsMetrics {
  /** 閲覧数（PV） */
  pv?: number;
  /** ユニークの閲覧者数 */
  unique?: number;
  /** ブックマーク・フォロー・お気に入りの数（サイトによって呼び方が違う） */
  bookmarks?: number;
  /** 評価ポイント */
  points?: number;
  /** いいね・星の数 */
  likes?: number;
  comments?: number;
  reviews?: number;
}

export interface ReaderStatsMetricInfo {
  key: keyof ReaderStatsMetrics;
  /** 画面と入力欄に出す名前 */
  label: string;
  /** 数のあとに付ける単位（評価の「pt」）。無ければ付けない */
  unit?: string;
  /** 入力欄に出す例 */
  example: string;
}

/**
 * 扱う数値と、その並び（設計書6.79.7）。
 *
 * **一覧はここ1つだけが持つ。** 手入力の訊く順・封筒の読み取り・画面の
 * 並びが同じ順になるようにする（写しを作ると、片方だけ増えて欄が消える）。
 *
 * **サイトごとに出し分けない。** カクヨムに「レビュー」、アルファポリスに
 * 「ブックマーク」が無いとしても、空欄で飛ばせる以上、サイトごとの表を
 * 持つ理由が無い——表を持てば、サイトが仕様を変えるたびに直す羽目になる。
 */
export const READER_STATS_METRICS: readonly ReaderStatsMetricInfo[] = [
  { key: "pv", label: "PV", example: "1234" },
  { key: "unique", label: "ユニーク", example: "567" },
  { key: "bookmarks", label: "ブックマーク", example: "89" },
  { key: "points", label: "評価", unit: "pt", example: "780" },
  { key: "likes", label: "いいね", example: "42" },
  { key: "comments", label: "コメント", example: "3" },
  { key: "reviews", label: "レビュー", example: "1" },
];

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

/** 手で打ったのか、貼り込み係の封筒から来たのか */
export type ReaderStatsSource = "helper" | "manual";

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
}

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
 * 作者が手で編集したJSONを読む。**壊れていたら例外を投げる。**
 *
 * 勝手に直して上書きすると、作者が貼ったURLや投稿の記録が黙って消える
 * （章立て・本の設計図と同じ約束）。
 */
export function parsePostingLedger(raw: unknown): PostingLedger {
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
      return {
        episodePath: normalizeEpisodePath(entry.episodePath as string),
        site,
        postedAt: (entry.postedAt as string).trim(),
        // **無い印は書き足さない。** `false` を入れると、既存の台帳を
        // 読んで書き戻すだけで中身が増える
        ...(entry.importedBaseline === true ? { importedBaseline: true } : {}),
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
  const readerStats =
    optionalObjectArray(value.readerStats, "readerStats", (entry, entryPath) => {
      const site = requireSiteId(entry.site, `${entryPath}.site`);
      requireNonEmptyString(entry.readAt, `${entryPath}.readAt`);
      optionalString(entry.periodKey, `${entryPath}.periodKey`);
      optionalString(entry.note, `${entryPath}.note`);
      const note = ((entry.note as string | undefined) ?? "").trim();
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
        metrics: parseReaderStatsMetrics(entry.metrics, `${entryPath}.metrics`),
        source: entry.source as ReaderStatsSource,
        ...(note ? { note } : {}),
      };
      assertReaderStatsRecord(record, entryPath);
      return record;
    }) ?? [];

  return {
    schemaVersion:
      (value.schemaVersion as string | undefined) ?? POSTING_SCHEMA_VERSION,
    sites,
    siteProfiles,
    posts,
    rankings,
    readerStats,
  };
}

/**
 * 読者の反応の数値を読む。**知らない欄は持ち歩かない。**
 *
 * 手で書き足された欄をそのまま残すと、書き戻したときに「こちらが作った
 * 欄」に見える。読めるものだけを写す（数として読めない値はここで止める）。
 */
function parseReaderStatsMetrics(
  raw: unknown,
  path: string
): ReaderStatsMetrics {
  const value = objectValue(raw, path);
  const metrics: ReaderStatsMetrics = {};
  for (const info of READER_STATS_METRICS) {
    const entry = value[info.key];
    if (entry === undefined) continue;
    if (!isReaderStatsCount(entry)) invalid(`${path}.${info.key}`);
    metrics[info.key] = entry;
  }
  return metrics;
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

export function isPosted(
  ledger: PostingLedger,
  episodePath: string,
  site: PostingSiteId
): boolean {
  const wanted = normalizeEpisodePath(episodePath);
  return ledger.posts.some(
    (post) => post.site === site && post.episodePath === wanted
  );
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
  episodePath: string,
  site: PostingSiteId,
  postedAt: string
): PostingLedger {
  const wanted = normalizeEpisodePath(episodePath);
  const kept = ledger.posts.filter(
    (post) => !(post.site === site && post.episodePath === wanted)
  );
  return {
    ...ledger,
    posts: [...kept, { episodePath: wanted, site, postedAt }],
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
  episodePath: string
): PostingSiteId[] {
  return ledger.sites
    .map((entry) => entry.site)
    .filter((site) => !isPosted(ledger, episodePath, site))
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

/** 読者の反応の数として受けられる値か。**0以上の整数だけ** */
function isReaderStatsCount(value: unknown): value is number {
  // 0は「読んだが0だった」という意味を持つので受ける（順位の1以上とは違う）
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** 数値が1つでも入っているか */
export function hasReaderStatsMetrics(metrics: ReaderStatsMetrics): boolean {
  return READER_STATS_METRICS.some(
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

/** 期間の入力を断るときの言い方。問題なければ null */
export function validateReaderStatsPeriodKey(
  period: Exclude<ReaderStatsPeriod, "total">,
  value: string
): string | null {
  const trimmed = value.trim();
  const info = READER_STATS_PERIOD_KEY[period];
  if (!trimmed) return `期間を入力してください（例：${info.example}）。`;
  return info.pattern.test(trimmed)
    ? null
    : `期間は ${info.example} の形で入力してください。`;
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
  for (const info of READER_STATS_METRICS) {
    const value = record.metrics[info.key];
    if (value !== undefined && !isReaderStatsCount(value)) {
      invalid(`${path}.metrics.${info.key}`);
    }
  }
  // **中身の無い記録は残さない。** 「読んだ」という事実だけの行が並んでも、
  // あとから見て何も分からない
  if (!hasReaderStatsMetrics(record.metrics)) invalid(`${path}.metrics`);
  if (record.source !== "helper" && record.source !== "manual") {
    invalid(`${path}.source`);
  }
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
  const metrics: ReaderStatsMetrics = {};
  for (const info of READER_STATS_METRICS) {
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
  };
  assertReaderStatsRecord(next);

  return {
    ...ledger,
    readerStats: [...(ledger.readerStats ?? []), next],
  };
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

/** 新しい順に並べるための比較（順位の `compareRecordedAtDesc` と同じ考え方） */
function compareReadAtDesc(
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
  return isReaderStatsCount(count) ? count : null;
}

/** 数の入力を断るときの言い方。**空欄は飛ばせる**ので、空は断らない */
export function validateReaderStatsCount(value: string): string | null {
  if (!value.trim()) return null;
  return parseReaderStatsCount(value) === null
    ? "0以上の整数で入力してください（読めなければ空のままで構いません）。"
    : null;
}
