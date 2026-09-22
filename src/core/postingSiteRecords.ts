import {
  ALL_READER_STATS_METRICS,
  POSTING_SITES,
  postingSiteInfo,
  rankingsForSite,
  readerStatsForSite,
  siteProfile,
  type PostingLedger,
  type PostingRankingRecord,
  type PostingSiteId,
  type ReaderStatsMetrics,
  type ReaderStatsRecord,
  type ReaderStatsSource,
} from "../models/posting";
import { buildReaderAdvice, type ReaderAdvice } from "./readerAdvice";
import { computeReaderRates, type ReaderRates } from "./readerRates";
import { buildReaderCharts, type ReaderCharts } from "./readerStatsCharts";

/**
 * 執筆量パネルに出す「サイトの記録」（設計書6.68.5）。
 *
 * **台帳を読むだけで、サイトへは触りにいかない**（6.68.1と同じ線）。
 * ここが組み立てるのは、作者が「投稿サイトの設定」で入れた作品情報と、
 * 「ランキングを記録する」で書き足した順位の一覧である。
 *
 * VS Code API には依存しない（画面と切り離して確かめられるようにする）。
 */

export interface PostingRankingRow {
  recordedAt: string;
  board: string;
  rank: number;
  /** メモは**無いときも欄を作る**（画面の列がずれないように） */
  note: string | null;
}

export interface PostingSiteRecord {
  site: PostingSiteId;
  label: string;
  workId: string | null;
  workUrl: string | null;
  genre: string | null;
  note: string | null;
  /**
   * いま投稿先として登録してあるか。
   *
   * **外したサイトの記録も残す**（6.68.4の8）ので、`false` の行がありうる。
   */
  registered: boolean;
  /**
   * 分析サイト（Narou.fun）のURL（設計書6.79.7）。**なろうの行だけ**入る。
   *
   * なろうは規約で「API以外の自動化されたデータ収集」を禁じているため、
   * 読者の反応をこちらから読みにいく道は作らない。代わりに、公認データの
   * 第三者分析サイトへ**作者が自分で飛べる**ようにする。
   */
  analysisUrl: string | null;
  latest: PostingRankingRow | null;
  /** 新しい順 */
  history: PostingRankingRow[];
  /**
   * 最新の取り込み1回ぶん（設計書6.79.7）。1件も無ければ null。
   *
   * **表の外で大きく見せるため**に別に持つ。表の1行目と同じ中身だが、
   * 画面はラベルを小さく薄く・数字を通常の大きさで並べたいので、
   * 組み上げた1本の文字列だけでは足りない。
   */
  readerLatest: GroupedReaderStatsRow | null;
  /**
   * 作品全体の反応。**1回の取り込み＝1行**で、新しい順。
   *
   * 出すのは `READER_STATS_HISTORY_LIMIT` 回ぶんまで。1件も無ければ null。
   */
  readerWork: ReaderStatsTable | null;
  /**
   * 話ごとの反応。**最新の取り込み1回ぶんだけ**を、話の番号順に並べる。
   * 1件も無ければ null（節ごと出さない）。
   */
  readerEpisodes: ReaderStatsTable | null;
  /**
   * 離脱率・ブックマーク率・評価率（作者の依頼、2026-09-23）。
   *
   * **3つとも第1話のPVを分母にする**ので、話ごとの記録が1件も無ければ
   * null（節ごと出さない）。出せない率は、中で理由を持つ。
   */
  readerRates: ReaderRates | null;
  /**
   * 率とPVから、記事の目安に沿った助言（残課題 B9。設計書6.79.7.3）。
   * 率と同じく、話ごとの記録が1件も無ければ null（節ごと出さない）。
   */
  readerAdvice: ReaderAdvice | null;
  /** PVのグラフ（各話・日・月・年・合計）。材料の無いグラフは null */
  readerCharts: ReaderCharts;
}

/**
 * 数字1つぶん。**ラベルと値を分けて渡す**（設計書6.79.7）。
 *
 * 表の外に大きく出すときは、ラベルを小さく薄く、数字を通常の大きさにしたい。
 * 「PV 1,053,339／ブックマーク 2,814／…」と1本の文字列で渡すと、画面の側で
 * 切り直すことになり、区切りの「／」が数字の一部に見える。
 */
export interface ReaderStatsValue {
  /** 「PV」「ブックマーク」 */
  label: string;
  /** 3桁区切りにした数字。**単位は含まない** */
  value: string;
  /** 「pt」など。無ければ空文字 */
  unit: string;
}

/**
 * 画面に出す1行ぶんの読者の反応（設計書6.79.7）。
 *
 * **1回の取り込みが1行**である（作者の言葉「サイトの記録が読みにくいです」、
 * 2026-09-22）。台帳は粒度ごとに1件ずつ書き足すので、ボタンを1回押しただけで
 * 「その時点」「日」「月」の3件が並ぶ——押したのは2回なのに6行あった。
 * 読む側が見たいのは「いつ押して、そのとき何件だったか」なので、**同じ日時・
 * 同じ範囲・同じ出どころの記録を1行に畳み、粒度は列にする。**
 *
 * **畳むのは見せ方だけで、台帳からは1件も捨てない**（`readerStats` は追記の
 * ままである）。畳んだ元の件数は `count` に残す。
 *
 * **数字は文字列に組んでから渡す。** 「あるものだけを並べる」のは、
 * どの欄が読めたかを知っている側（ここ）の仕事である——画面の側で
 * 組み立てると、同じ判断が2か所（執筆量パネルと将来の出力）に散る。
 */
export interface GroupedReaderStatsRow {
  /** 読み取った日時（ISO8601）。サイトが集計した時刻ではない */
  readAt: string;
  /** 「作品全体」「第3話」 */
  scope: string;
  /** 話ごとの行を番号順に並べるための値。作品全体なら null */
  episode: number | null;
  /** 話ごとの記録か。**作品全体の表と混ぜないための目印** */
  isEpisode: boolean;
  /** 「PV 1,234／ブックマーク 56」——粒度を持たない記録。無ければ空文字 */
  snapshot: string;
  /** 同じ中身を、ラベルと数字に分けたもの（表の外で大きく見せる用） */
  snapshotValues: ReaderStatsValue[];
  /** その日の値。日付がこの行の日時と違う日なら「PV 1（9/21）」と添える */
  day: string;
  /** その月の値。月が違えば「PV 667（2026/08）」と添える */
  month: string;
  /** 年・累計。上の3つに入らない粒度を、名前を付けて並べる */
  other: string;
  /** 「手入力」「貼り付け」「バックアップ」 */
  source: string;
  /** 作者のメモ。無ければ空文字 */
  note: string;
  /** 畳んだ元の件数。**台帳を1件も捨てていないことを数で言えるように** */
  count: number;
}

/**
 * 表に出す列（設計書6.79.7）。**中身が1種類しかない列は出さない。**
 *
 * 実物では「範囲」が全行「作品全体」、「出どころ」が全行「貼り付け」で、
 * どちらも幅が足りずに2行へ折り返していた。「メモ」は1件も入っていないのに
 * 幅を食い、見出しが「メ／モ」と縦に潰れていた。**消すのではなく、要るときだけ
 * 出す**——話ごとの記録やメモが入った日には、ちゃんと列が戻る。
 */
export interface ReaderStatsColumns {
  scope: boolean;
  snapshot: boolean;
  day: boolean;
  month: boolean;
  other: boolean;
  source: boolean;
  note: boolean;
  /**
   * 出どころが1種類しかないときの呼び名。**表の下へ1回だけ書く**ための値で、
   * 2種類以上あるときは null（そのときは列として出す）。
   */
  onlySource: string | null;
}

/** 表1つぶん。行と、その行に要る列 */
export interface ReaderStatsTable {
  rows: GroupedReaderStatsRow[];
  columns: ReaderStatsColumns;
}

/**
 * 履歴に出す**取り込みの回数**の上限（畳んだあとの行数）。
 *
 * **執筆量を見にきた画面が、反応の履歴で埋まらないようにする。** 日ごとに
 * 読めば1か月で30回になる。台帳からは1件も消さない（消すのは表示だけ）。
 */
export const READER_STATS_HISTORY_LIMIT = 20;

/**
 * 表の頭に出す行数（設計書6.79.7）。**残りは畳む。**
 *
 * いつも見たいのは直前の何回かだけで、それより古い回は「あることが分かれば
 * よい」。3回にしてあるのは、いまと1つ前と、その前を並べれば増減の向きが
 * 分かるからである。
 */
export const READER_STATS_VISIBLE_ROWS = 3;

/**
 * サイトごとの記録を組み立てる。
 *
 * **見せるものが無いサイトは並べない。** 投稿ページのURLを登録しただけの
 * サイトは、ここに出しても空の行が増えるだけである（作品情報も順位も
 * 1つも無ければ、呼ぶ側は節ごと出さない）。
 *
 * **作品情報は登録から独立している**（設計書6.68.5）。台帳直下の
 * `siteProfiles` を見るので、**投稿先から外したサイトでも作品情報の行が
 * 出る**——順位を残しているのと同じ扱いである。
 */
export function buildPostingSiteRecords(
  ledger: PostingLedger
): PostingSiteRecord[] {
  const records: PostingSiteRecord[] = [];

  // 並びは `POSTING_SITES` に揃える（画面ごとに順番が変わらないように）
  for (const info of POSTING_SITES) {
    const registered = ledger.sites.some((site) => site.site === info.id);
    const profile = siteProfile(ledger, info.id);
    const history = rankingsForSite(ledger, info.id).map(toRow);
    // **畳んでから数える。** 台帳は1回の取り込みを粒度ごとに分けて書くので、
    // 生の件数は「押した回数」と一致しない
    const grouped = groupReaderStatsRows(readerStatsForSite(ledger, info.id));
    const readerWork = readerStatsTable(
      grouped
        .filter((row) => !row.isEpisode)
        // **古いほうから落とす**（新しい順に並んでいるので先頭を残す）
        .slice(0, READER_STATS_HISTORY_LIMIT)
    );
    const readerEpisodes = readerStatsTable(latestEpisodeRows(grouped));
    /*
      率とグラフは**台帳に書かれた順**で渡す（`readerStatsForSite` は新しい順に
      並べ替える）。同じ日時に同じ話が2件あるとき、あとから足したほうを
      採るには、足した順が要る。
    */
    const inLedgerOrder = (ledger.readerStats ?? []).filter(
      (entry) => entry.site === info.id
    );
    const rates = computeReaderRates(inLedgerOrder);
    // 出すのは「作品情報がある」か「順位がある」か「反応がある」ときだけ。
    // 登録しただけのサイトは、まだ見せるものが無い（空の行を増やさない）
    if (!profile && history.length === 0 && grouped.length === 0) {
      continue;
    }

    records.push({
      site: info.id,
      label: postingSiteInfo(info.id).label,
      workId: profile?.workId ?? null,
      workUrl: profile?.workUrl ?? null,
      genre: profile?.genre ?? null,
      note: profile?.note ?? null,
      registered,
      // **なろうにだけ添える**（6.79.7）。ほかのサイトは管理画面を読む道が
      // 開いているので、代わりの分析サイトを差し込む理由が無い
      analysisUrl:
        info.id === "narou"
          ? narouAnalysisUrl(profile?.workId, profile?.workUrl) ?? null
          : null,
      latest: history[0] ?? null,
      history,
      // **話ごとしか記録していない作品でも、最新の1回は大きく見せる**
      readerLatest: readerWork?.rows[0] ?? readerEpisodes?.rows[0] ?? null,
      readerWork,
      readerEpisodes,
      readerRates: rates.episodeReadAt === null ? null : rates,
      readerAdvice:
        rates.episodeReadAt === null
          ? null
          : buildReaderAdvice(rates, inLedgerOrder),
      readerCharts: buildReaderCharts(
        inLedgerOrder,
        rates.base?.episode ?? null
      ),
    });
  }

  return records;
}

function toRow(record: PostingRankingRecord): PostingRankingRow {
  return {
    recordedAt: record.recordedAt,
    board: record.board,
    rank: record.rank,
    note: record.note ?? null,
  };
}

/**
 * 出どころの呼び名（設計書6.79.7／6.99）。
 *
 * **「バックアップ」を「手入力」と書かない。** 作者が打った数字と、
 * ダウンロードしたファイルに入っていた数字は、**いつの数字か**が違う
 * （バックアップはダウンロードした時点のもの）。
 */
const READER_SOURCE_LABELS: Record<ReaderStatsSource, string> = {
  helper: "貼り付け",
  manual: "手入力",
  backup: "バックアップ",
};

/**
 * 1回の取り込みを1行に畳む（設計書6.79.7）。
 *
 * **畳むのは見せ方だけで、台帳（`readerStats`）からは1件も捨てない。**
 * 受け取った並び（新しい順）はそのまま保つ。
 *
 * @param records そのサイトの反応の記録。**新しい順に並んでいること**
 */
export function groupReaderStatsRows(
  records: ReaderStatsRecord[]
): GroupedReaderStatsRow[] {
  const groups = new Map<string, ReaderStatsRecord[]>();
  for (const record of records) {
    /*
      **鍵に出どころを混ぜる。** 同じ時刻に見えても、作者が打った数字と
      バックアップに入っていた数字は「いつの数字か」の意味が違う
      （`models/posting.ts` の `ReaderStatsSource` の注記）。

      区切りにNULを使うのは、範囲にも出どころにも現れない字だからである
      （**文字列リテラルには生のまま置かない**——gitとgrepがこのファイルを
      バイナリ扱いする）。
    */
    const key = [
      record.readAt,
      record.scope,
      record.episode ?? "",
      record.source,
    ].join("\u0000");
    const found = groups.get(key);
    if (found) {
      found.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  // Map は入れた順を保つので、並べ替え直さなくても新しい順のままである
  return [...groups.values()].map(toGroupedRow);
}

function toGroupedRow(records: ReaderStatsRecord[]): GroupedReaderStatsRow {
  const head = records[0];
  const days: ReaderStatsRecord[] = [];
  const months: string[] = [];
  const others: string[] = [];
  const notes: string[] = [];
  // **同じ回の「その時点」は1つに寄せる**（欄が違えば両方を残す）。
  // 別々に組むと「PV 1,234／ブックマーク 56」が2本並ぶことになる
  let snapshot: ReaderStatsMetrics | null = null;

  for (const record of records) {
    const metrics = formatReaderStatsMetrics(record.metrics);
    switch (record.period) {
      case "day":
        // 1つに絞るのはあとで（`todayRecord`）。ここでは集めるだけ
        days.push(record);
        break;
      case "month":
        months.push(metrics + periodKeyHint(record));
        break;
      case undefined:
        snapshot = { ...(snapshot ?? {}), ...record.metrics };
        break;
      default:
        // 年・累計。**捨てない**——専用の列が無いだけで、値は画面にも残す
        others.push(`${readerPeriodLabel(record)} ${metrics}`.trim());
    }
    const note = (record.note ?? "").trim();
    // 同じメモが3件ぶん並ぶ（1回の取り込みで同じメモが3行へ入る）ので畳む
    if (note && !notes.includes(note)) notes.push(note);
  }

  return {
    readAt: head.readAt,
    scope: readerScopeLabel(head),
    episode: head.scope === "episode" ? head.episode ?? null : null,
    isEpisode: head.scope === "episode",
    snapshot: snapshot ? formatReaderStatsMetrics(snapshot) : "",
    snapshotValues: snapshot ? readerStatsValues(snapshot) : [],
    day: dayText(days),
    month: months.join("／"),
    other: others.join("／"),
    source: READER_SOURCE_LABELS[head.source] ?? "手入力",
    note: notes.join("／"),
    count: records.length,
  };
}

/**
 * 話ごとの記録は、**最新の取り込み1回ぶんだけ**を出す（設計書6.79.7）。
 *
 * アクセス数のページは1回で50話ぶん入る（219話なら5ページで250行）ので、
 * 押すたびに表が250行ずつ伸びる。見たいのは「いまどの話が読まれているか」
 * であって、押した回数ぶんの束ではない。**古い回は画面に出さないだけで、
 * 台帳には残っている。**
 */
function latestEpisodeRows(
  rows: GroupedReaderStatsRow[]
): GroupedReaderStatsRow[] {
  const episodes = rows.filter((row) => row.isEpisode);
  const newest = episodes[0]?.readAt;
  if (newest === undefined) return [];
  return episodes
    .filter((row) => row.readAt === newest)
    // 話の番号順。番号を読めなかった行は先頭へ寄せる（0として扱う）
    .sort((left, right) => (left.episode ?? 0) - (right.episode ?? 0));
}

/** 行が1つも無ければ表ごと出さない（空の見出しを残さない） */
function readerStatsTable(
  rows: GroupedReaderStatsRow[]
): ReaderStatsTable | null {
  return rows.length === 0 ? null : { rows, columns: readerStatsColumns(rows) };
}

/**
 * その行たちに要る列を決める（設計書6.79.7）。
 *
 * **中身が1種類しかない列は出さない。** 全行が「作品全体」「貼り付け」で
 * 埋まった列は、読む人に何も伝えないまま幅だけを食い、表を折り返させる。
 */
export function readerStatsColumns(
  rows: GroupedReaderStatsRow[]
): ReaderStatsColumns {
  const sources = new Set(rows.map((row) => row.source));
  return {
    // 話ごとの表では番号が行ごとに違うので、こちらは自然に出る
    scope: new Set(rows.map((row) => row.scope)).size > 1,
    snapshot: rows.some((row) => row.snapshot !== ""),
    day: rows.some((row) => row.day !== ""),
    month: rows.some((row) => row.month !== ""),
    other: rows.some((row) => row.other !== ""),
    source: sources.size > 1,
    note: rows.some((row) => row.note !== ""),
    onlySource: sources.size === 1 ? [...sources][0] : null,
  };
}

/**
 * 「今日」の欄に出す1件（2026-09-23）。
 *
 * **読み取った日の記録だけを出す。** 貼り込み係 0.5.0 は作品管理ページの
 * グラフから**日ごとのPVを30日ぶん**送ってくる。全部を並べると、今日の欄に
 * 30日ぶんが1行で並ぶ——ほかの日は「日ごとのPV」のグラフの材料であって、
 * 今日の欄の中身ではない（台帳には全部残っている）。
 *
 * **読み取った日の記録が無い回は、いちばん新しい日を1件だけ、日付を添えて
 * 出す**（「PV 5（9/21）」）。作者が前の日の数を手で打った回を、表から
 * 消さないため——その回に入っているのがその1件だけなら、消すと行が空になる。
 */
function dayText(records: readonly ReaderStatsRecord[]): string {
  const picked = todayRecord(records);
  return picked
    ? formatReaderStatsMetrics(picked.metrics) + periodKeyHint(picked)
    : "";
}

function todayRecord(
  records: readonly ReaderStatsRecord[]
): ReaderStatsRecord | undefined {
  let today: ReaderStatsRecord | undefined;
  let newest: ReaderStatsRecord | undefined;
  for (const record of records) {
    // 同じ日が2件あれば、あとにあるほう（台帳は追記なので新しい）
    if (record.periodKey !== undefined) {
      if (record.periodKey === localDateKey(record.readAt)) today = record;
      if (
        newest?.periodKey === undefined ||
        record.periodKey >= newest.periodKey
      ) {
        newest = record;
      }
    } else if (!newest) {
      newest = record;
    }
  }
  return today ?? newest;
}

/**
 * 期間の見出しが、その行の日時とずれているときだけ添える文字。
 *
 * **多くは同じ日・同じ月**なので、毎行「日 2026-09-22」と書くと同じ字を
 * 何度も読むことになる（実物では1回の取り込みごとに3回出ていた）。列の
 * 見出しを「今日」「今月」にして、**ずれているときだけ**日付を添える。
 */
function periodKeyHint(record: ReaderStatsRecord): string {
  const key = record.periodKey;
  if (!key) return "";
  // 日時が読めない（作者が手で書き換えた）ときは、ずれている扱いで添える
  const local = localDateKey(record.readAt);
  if (record.period === "day") {
    if (local === key) return "";
    const parts = key.split("-");
    return parts.length === 3
      ? `（${Number(parts[1])}/${Number(parts[2])}）`
      : `（${key}）`;
  }
  if (record.period === "month") {
    if (local !== null && local.slice(0, 7) === key) return "";
    return `（${key.replace("-", "/")}）`;
  }
  return "";
}

/**
 * その日時の「年-月-日」（手元の時計で）。読めなければ null。
 *
 * **手元の時計で見る。** 画面の日時（`formatWhen`）も手元の時計で出して
 * いるので、そちらと違う基準で「同じ日か」を決めると食い違う。
 */
function localDateKey(value: string): string | null {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  const pad = (number: number): string => String(number).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(
    when.getDate()
  )}`;
}

/** 「作品全体」「第3話」。話数を読めなかった行は、そう書く */
function readerScopeLabel(record: ReaderStatsRecord): string {
  if (record.scope === "work") return "作品全体";
  return record.episode === undefined ? "話（番号なし）" : `第${record.episode}話`;
}

/** 「その時点」「日 2026-09-05」「累計」 */
function readerPeriodLabel(record: ReaderStatsRecord): string {
  switch (record.period) {
    case "day":
      return `日 ${record.periodKey ?? ""}`.trim();
    case "month":
      return `月 ${record.periodKey ?? ""}`.trim();
    case "year":
      return `年 ${record.periodKey ?? ""}`.trim();
    case "total":
      return "累計";
    default:
      // 粒度を持たない記録は「画面に出ていた値をそのまま写した」もの
      return "その時点";
  }
}

/**
 * 数字を1行に組む（設計書6.79.7）。**読めた欄だけを、決まった順で並べる。**
 *
 * 並びは `READER_STATS_METRICS`＋`SITE_READER_STATS_METRICS` が唯一の置き場
 * である（手入力で訊く順・封筒の読み取り・ここが同じ順になる）。
 *
 * **サイトを受け取らない。** 1件の記録が持つのは自分のサイトの欄だけなので、
 * 全部の表を順に見れば、共通の7つのあとにそのサイト固有の欄が並ぶ。
 * サイトを渡す形にすると、渡し忘れた呼び出し先で欄が黙って消える。
 */
export function formatReaderStatsMetrics(metrics: ReaderStatsMetrics): string {
  return readerStatsValues(metrics)
    .map((entry) => `${entry.label} ${entry.value}${entry.unit}`)
    .join("／");
}

/**
 * 同じ数字を、**ラベルと値に分けて**返す（設計書6.79.7）。
 *
 * 表の外に大きく出す「最新の反応」は、ラベルを小さく薄く、数字を通常の
 * 大きさで並べる。1本の文字列を画面の側で切り直すと、区切りの「／」まで
 * 数字の一部に見えてしまう——**並びと桁の決まりは、ここ1つが持つ。**
 */
export function readerStatsValues(
  metrics: ReaderStatsMetrics
): ReaderStatsValue[] {
  return ALL_READER_STATS_METRICS.filter(
    (info) => metrics[info.key] !== undefined
  ).map((info) => {
    const value = metrics[info.key] as number;
    return {
      label: info.label,
      // 3桁区切りは、サイトの画面と同じ読み方に揃えるため。
      // 小数の欄（評価平均）は、桁を落とさずサイトの表記に揃える
      value: value.toLocaleString("ja-JP", {
        minimumFractionDigits: info.fractionDigits ?? 0,
        maximumFractionDigits: info.fractionDigits ?? 0,
      }),
      unit: info.unit ?? "",
    };
  });
}

/**
 * Nコードの形（`n` + 数字4桁 + 英字1〜2字）。大文字で書く人もいる。
 *
 * **形を確かめるのは、壊れたリンクを出さないため。** 作品IDの欄は自由入力で、
 * 作品名やURLの断片が入っていることがある。それをURLへ埋めると、押した先が
 * 存在しないページになる——リンクが無いほうが、まだ親切である。
 */
const NCODE = /^n\d{4}[a-z]{1,2}$/i;

/**
 * なろうの分析サイト（Narou.fun）のURLを合成する（設計書6.79.7）。
 *
 * **こちらからは1本もHTTPを発しない。** 作るのはURLの文字列だけで、
 * 読みにいくのはブラウザを開いた作者である（6.68の原則そのまま）。
 *
 * @param workId 台帳の作品ID（6.68.5）。**第一候補**
 * @param workUrl 作品ページのURL。作品IDが無い・Nコードの形でないときに、
 *   ここから拾う（`https://ncode.syosetu.com/n1234ab/` の形）
 * @returns Nコードを取れなければ `undefined`（リンクを出さない）
 */
export function narouAnalysisUrl(
  workId?: string | null,
  workUrl?: string | null
): string | undefined {
  const ncode = narouNcode(workId, workUrl);
  /*
    **Nコードは大文字で渡す**（作者の指摘、2026-09-20。ブラウザで確かめた）。

    小文字（`.../works/n2600go`）を開くと、**なろう本体
    （`ncode.syosetu.com`）へ飛ばされる**——分析ページが出ない。
    作者の言葉では「両方なろうのページに飛びます」。

    **なろう本体のURLは小文字のままでよい**ので、`narouNcode` の正規化
    （小文字に揃える）は変えない。**大文字が要るのはこのリンクだけ**である。
  */
  return ncode
    ? `https://db.narou.fun/works/${ncode.toUpperCase()}`
    : undefined;
}

/**
 * 台帳からNコードを取り出す（小文字に揃えて返す）。
 *
 * **検証と正規化の置き場をここ1つにする。** 分析リンク（6.79.7）と
 * SNSへの貼り付け（6.79.8）が同じNコードを使うので、片方で書き直すと
 * 「分析は開けるのに、告知のURLは作れない」のような食い違いが出る。
 *
 * @param workId 台帳の作品ID（6.68.5）。**第一候補**
 * @param workUrl 作品ページのURL。作品IDが無い・形が違うときに拾う
 */
export function narouNcode(
  workId?: string | null,
  workUrl?: string | null
): string | undefined {
  return ncodeFrom(workId) ?? ncodeFromUrl(workUrl);
}

/** Nコードとして読めれば小文字で返す（URLの中では小文字が使われる） */
function ncodeFrom(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return NCODE.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/**
 * 作品ページのURLからNコードを拾う。
 *
 * **見るのは最初のパスだけ**（`/n1234ab/13/` のような話のページでも作品を
 * 指せる）。ドメインは見ない——ここへ来るのはなろうの行だけで、URLの検証は
 * 台帳の読み込みで済んでいる。
 */
function ncodeFromUrl(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  try {
    const first = new URL(trimmed).pathname.split("/").find((part) => part);
    return ncodeFrom(first);
  } catch {
    return undefined;
  }
}

/**
 * 作品ページを開いてよいURLか。
 *
 * **開くのは `openExternal` だけ**で、中身は読まない（6.68.1）。台帳は
 * 作者が手で開いて直せるファイルなので、`javascript:` や `file:` が
 * 書かれていることがありうる——読み込みでも弾いているが、**開く直前にも
 * 確かめる**（この2つは通す経路が違う）。
 */
export function isOpenableWorkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
