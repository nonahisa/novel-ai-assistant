import {
  ALL_READER_STATS_METRICS,
  hasReaderStatsMetrics,
  isReaderStatsValue,
  isKnownPostingSite,
  isReaderStatsPeriodKey,
  isReaderStatsUpdatedAt,
  postingSiteInfo,
  POSTING_SITES,
  READER_STATS_PERIODS,
  repeatsReaderStats,
  siteProfile,
  withReaderStats,
  type PostingLedger,
  type PostingSiteId,
  type ReaderStatsMetrics,
  type ReaderStatsPeriod,
  type ReaderStatsRecord,
  type ReaderStatsScope,
} from "../models/posting";
import { supportsPasteHelper } from "./postingEnvelope";
import { narouNcode } from "./postingSiteRecords";
import { deriveSiteProfile } from "./postingSiteUrls";

/**
 * 読者の反応の封筒（設計書6.79.7の3）。**向きが逆の封筒である。**
 *
 * ## 何のためのものか
 *
 * 貼り込みの封筒（`postingEnvelope.ts` の `novelai-post`）は母艦→ブラウザで、
 * こちらはブラウザ→母艦である。作者が**自分で開いた自分の管理画面**を
 * 貼り込み係が1回読み、その結果をクリップボードへ置く。母艦はそれを受ける
 * だけで、**サイトへHTTPを発しないのは従来どおり**（6.68.1）。
 *
 * ## なぜ受け取る側でここまで確かめるか
 *
 * 中身は**別プロジェクト（ブラウザ拡張）が作った文字列**である。形が変われば
 * 黙って数字が化ける——ここは母艦の台帳へ入る最後の門なので、
 *
 *   - 版数が一致すること（欄の意味が変わったものを読まない）
 *   - **読み取りに対応すると決めたサイトであること**（6.79.7の判定）
 *   - 数値が数値であること（"1,234" のような文字列を数として書かない）
 *
 * を確かめる。**直して受け取らない**（直し方はこちらには分からない）。
 *
 * VS Code API には依存しない。
 */

/** 封筒の形式版数。読む側はこの数値と一致するときだけ受け取る */
export const READER_STATS_ENVELOPE_VERSION = 1;

/** 封筒の目印になる欄の名前（ただのJSONを封筒と読み違えないため） */
const MARKER = "novelai-stats";

export interface ReaderStatsEnvelopeEntry {
  scope: ReaderStatsScope;
  episode?: number;
  period?: ReaderStatsPeriod;
  periodKey?: string;
  metrics: ReaderStatsMetrics;
  /**
   * その話のサイト上の最終更新（ISO 8601、時差つき）。話ごとの行にだけ入る。
   *
   * **省いてよい欄**なので封筒の版数は上げない（約束 v1b、2026-09-23）。
   * これを知らない古い母艦は、この欄を読み飛ばして残りを受け取る
   * （`parseEntry` は知っている欄だけを拾う作り）。
   */
  updatedAt?: string;
}

/**
 * 封筒の出どころ（残課題 B11、2026-09-23）。**欄が無ければ、そのサイトの
 * 管理画面そのもの**（カクヨムの作品管理など。これまでの封筒はすべてこれ）。
 *
 * ## なぜ出どころを分けるのか
 *
 * なろうの封筒は「規約の判断により」断っている（6.79.7）。**その判断は、
 * なろう本体（syosetu.com）を機械で読むことについて**である。作者が自分で
 * 開いた分析サイト Narou.fun の頁は別のサイトで、そこから読んだ封筒まで
 * 同じ理由で断る筋は無い——サイト（どの作品の数か）と出どころ（どこで
 * 読んだか）は別の問いなので、欄を分ける。
 *
 * **一覧はここ1つだけが持つ。** 知らない出どころは推測で読まずに断る
 * （版数と同じ流儀——意味の分からない欄を読むと、数字が化ける）。
 */
export const READER_STATS_ENVELOPE_SOURCES = {
  "narou.fun": {
    /** 画面に出す名前（サイトの呼び方のまま） */
    label: "Narou.fun",
    /** この出どころが持ってこられるのは、このサイトの数だけ */
    site: "narou",
  },
} as const satisfies Record<string, { label: string; site: PostingSiteId }>;

export type ReaderStatsEnvelopeSource = keyof typeof READER_STATS_ENVELOPE_SOURCES;

/**
 * 封筒の記録の日時（`readAt`）が何の日時か（残課題 B11 の続き、作者の裁定 2026-09-23）。
 *
 * - `fetched`：**出どころのサイトが数を取ってきた日時**（Narou.fun の「最終取得日時」）
 * - `clicked`：作者が貼り込み係のボタンを押した時刻（最終取得日時を読めなかったとき）
 *
 * **欄が無ければ「押した時刻」**（これまでの封筒はすべてこれ）。省いてよい欄なので
 * 封筒の版数は上げない——知らない母艦は読み飛ばし、`readAt` を押した時刻として扱う
 * （これまでと同じ）。**知らない値は推測で読まずに断る**（出どころと同じ流儀）。
 */
export const READER_STATS_READ_AT_BASES = ["fetched", "clicked"] as const;

export type ReaderStatsReadAtBasis = (typeof READER_STATS_READ_AT_BASES)[number];

function isReaderStatsReadAtBasis(
  value: unknown
): value is ReaderStatsReadAtBasis {
  return (
    typeof value === "string" &&
    (READER_STATS_READ_AT_BASES as readonly string[]).includes(value)
  );
}

function isReaderStatsEnvelopeSource(
  value: unknown
): value is ReaderStatsEnvelopeSource {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(READER_STATS_ENVELOPE_SOURCES, value)
  );
}

/** 出どころの表示名（「Narou.fun」）。出どころの無い封筒は undefined */
export function readerStatsSourceLabel(
  source: ReaderStatsEnvelopeSource | undefined
): string | undefined {
  return source === undefined
    ? undefined
    : READER_STATS_ENVELOPE_SOURCES[source].label;
}

export interface ReaderStatsEnvelope {
  [MARKER]: typeof READER_STATS_ENVELOPE_VERSION;
  site: PostingSiteId;
  /**
   * どこで読んだか（`READER_STATS_ENVELOPE_SOURCES`）。**無ければそのサイトの
   * 管理画面そのもの**。省いてよい欄なので封筒の版数は上げない——ただし
   * これを知らない古い母艦は、`site: "narou"` を見てなろうとして断る
   * （受けるのはこの欄を知っている版だけ。断る向きに倒れるので安全）。
   */
  source?: ReaderStatsEnvelopeSource;
  /**
   * 管理画面のURLから読めた作品ID。**入っていれば照合する**（6.79.6の2）。
   *
   * 入れられないこともあるので任意。**空文字は入れない**——「IDが空の作品」
   * として照合してしまう。
   */
  workId?: string;
  /**
   * 読み取った日時（ISO8601）。出どころのある封筒では、**出どころのサイトが
   * 数を取ってきた日時**のことがある（`readAtBasis`）
   */
  readAt: string;
  /** `readAt` が何の日時か。無ければ押した時刻（これまでの封筒） */
  readAtBasis?: ReaderStatsReadAtBasis;
  /** 1回の読み取りで拾えた行。**1件も無い封筒は受け取らない** */
  entries: ReaderStatsEnvelopeEntry[];
}

/**
 * 封筒を読んだ結果。
 *
 * **断るときは理由を返す。** 貼り込みの封筒（`parsePostingEnvelope`）は
 * 「読めなければ静かに `null`」でよかったが、こちらは**作者が「取り込む」を
 * 押した直後**である。何も言わずに終わると、押したのに何も起きないのと
 * 区別が付かない——とくに「なろうの封筒は受け取らない」は仕様であって
 * 故障ではないので、そう言わなければ伝わらない。
 */
export type ReaderStatsEnvelopeResult =
  | { readonly ok: true; readonly envelope: ReaderStatsEnvelope }
  | {
      readonly ok: false;
      readonly reason: string;
      /**
       * **そもそも封筒が入っていなかったのか**を見分ける印。
       *
       * ここだけは「作者がまだコピーしていない」だけのことが多いので、
       * 呼ぶ側が管理画面を開く道を添えられる（設計書6.79.7）。ほかの断り
       * （版違い・対応していないサイト）は、管理画面を開いても直らない。
       */
      readonly kind?: "notEnvelope";
    };

function reject(
  reason: string,
  kind?: "notEnvelope"
): ReaderStatsEnvelopeResult {
  return { ok: false, reason, ...(kind ? { kind } : {}) };
}

/**
 * 読み取りの封筒を受け取れるサイト（設計書6.79.7の判定）。
 *
 * **貼り込みと同じ一覧を引く**（`postingEnvelope.ts` の `pasteHelperSites`）。
 * カクヨム・アルファポリスだけが対象で、なろう・pixiv・ハーメルン・noteは
 * 規約の判断から**読み取り対応をしない**（手入力の口だけを残す）。
 *
 * **写しを作らない。** ここに別の一覧を置くと、貼り込みだけ解禁したときに
 * 読み取りが取り残される（あるいはその逆）。解禁はヘルパー側と同時に行う。
 *
 * **出どころがあれば、出どころの表が決める**（残課題 B11）。Narou.fun は
 * なろうの数を持ってくるが、なろう本体の管理画面を読むわけではない。
 * 出どころを渡さなければ（これまでの呼び方）、答えは変わらない。
 */
export function supportsReaderStatsHelper(
  site: PostingSiteId,
  source?: ReaderStatsEnvelopeSource
): boolean {
  if (source !== undefined) {
    return READER_STATS_ENVELOPE_SOURCES[source].site === site;
  }
  return supportsPasteHelper(site);
}

/**
 * 封筒を組み立てる（返すのはクリップボードへ入れる文字列）。
 *
 * **母艦では使わない**——作るのはブラウザ拡張の側である。ここに置くのは、
 * **形を1か所で決めて往復のテストで固定する**ためで、貼り込みの封筒
 * （`buildPostingEnvelope`）と同じ考え方である。
 */
export function buildReaderStatsEnvelope(input: {
  site: PostingSiteId;
  source?: ReaderStatsEnvelopeSource;
  workId?: string | null;
  readAt: string;
  readAtBasis?: ReaderStatsReadAtBasis;
  entries: readonly ReaderStatsEnvelopeEntry[];
}): string {
  const workId = (input.workId ?? "").trim();
  return JSON.stringify({
    [MARKER]: READER_STATS_ENVELOPE_VERSION,
    site: input.site,
    ...(input.source ? { source: input.source } : {}),
    ...(workId ? { workId } : {}),
    readAt: input.readAt,
    ...(input.readAtBasis ? { readAtBasis: input.readAtBasis } : {}),
    entries: input.entries,
  });
}

/** 封筒が入っていなかったときの断り（1件の封筒と束で同じ文言を使う） */
const NOT_ENVELOPE_REASON =
  "クリップボードに、読者の反応の封筒が入っていませんでした。" +
  "管理画面で統合小説執筆環境ヘルパーの「読者の反応をコピー」を押してから、もう一度お試しください。";

/**
 * クリップボードの文字列をJSONとして読む。**オブジェクトでなければ undefined**
 * （封筒でも束でもない。呼ぶ側が「入っていませんでした」と言う）。
 */
function parseObject(raw: string): Record<string, unknown> | undefined {
  // クリップボード経由なので、前後に改行や空白が付くことがある
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/** 封筒を読む。**直さずに、受けるか断るかだけを決める** */
export function parseReaderStatsEnvelope(
  raw: string
): ReaderStatsEnvelopeResult {
  const value = parseObject(raw);
  if (!value) return reject(NOT_ENVELOPE_REASON, "notEnvelope");
  return readEnvelopeValue(value);
}

/**
 * JSONとして読めた値を、封筒として確かめる。
 *
 * **1件の封筒と、束の中の1件が同じ関所を通る**（束の受け取り、2026-09-23）。
 * 束の中身はヘルパー 0.8.0 までクリップボードへ置いていた封筒と同じ形なので、
 * ここに別の確かめ方を置くと、片方だけ緩むか締まる。
 */
function readEnvelopeValue(value: Record<string, unknown>): ReaderStatsEnvelopeResult {
  if (value[MARKER] === undefined) return reject(NOT_ENVELOPE_REASON, "notEnvelope");
  // **知らない版数は読まない。** 欄の意味が変わったものを読むと、数字が化ける
  if (value[MARKER] !== READER_STATS_ENVELOPE_VERSION) {
    return reject(
      "読者の反応の封筒の形式が違います（ヘルパーと拡張機能の版が" +
        "食い違っています）。どちらかを更新してからお試しください。"
    );
  }

  const site = value.site;
  const known =
    typeof site === "string"
      ? POSTING_SITES.find((info) => info.id === site)
      : undefined;
  if (!known) return reject("封筒に書かれたサイトが分かりませんでした。");

  /*
    出どころ（残課題 B11）。**`null` は「欄なし」**（ほかの欄と同じ扱い）。
    書いてあるのに知らない出どころなら、推測せずに断る——サイトの判定より
    先に見るのは、知らない出どころの封筒を「なろうだから」で断ると、
    貼り込み係が新しいのに母艦が古い、という本当の理由が伝わらないため。
  */
  const rawSource = absent(value.source) ? undefined : value.source;
  if (rawSource !== undefined && !isReaderStatsEnvelopeSource(rawSource)) {
    return reject(
      "封筒に書かれた読み取り元が分かりませんでした（ヘルパーと拡張機能の版が" +
        "食い違っているかもしれません）。どちらかを更新してからお試しください。"
    );
  }
  const source = rawSource;
  if (source !== undefined && !supportsReaderStatsHelper(known.id, source)) {
    // Narou.fun の封筒が「カクヨム」を名乗っている、のような食い違い。直し方はこちらに分からない
    return reject(
      `${READER_STATS_ENVELOPE_SOURCES[source].label}から読んだ封筒に、` +
        `${known.label}の数が入っていました。取り込みを中止しました。`
    );
  }
  if (source === undefined && !supportsReaderStatsHelper(known.id)) {
    // **仕様として断る**（6.79.7）。故障と読まれないよう、道があることまで言う
    return reject(
      `${known.label}の読者の反応は、貼り付けでは取り込みません` +
        "（規約の判断により、読み取りに対応していません）。" +
        "「読者の反応を手入力」からご記入ください。"
    );
  }

  const { readAt, entries } = value;
  // **`null` は「欄なし」と同じ**（0.33.9）。読めなかった欄を `null` で書くのは
  // 素直な書き方で、そこで断ると数字が正しい封筒まで丸ごと落ちる
  const workId = absent(value.workId) ? undefined : value.workId;
  if (workId !== undefined && typeof workId !== "string") {
    return reject("封筒の作品IDを読めませんでした。");
  }
  if (typeof readAt !== "string" || !readAt.trim()) {
    return reject("封筒に読み取った日時が入っていませんでした。");
  }
  // 記録の日時の印（残課題 B11 の続き）。`null` は「欄なし」＝押した時刻
  const readAtBasis = absent(value.readAtBasis) ? undefined : value.readAtBasis;
  if (readAtBasis !== undefined && !isReaderStatsReadAtBasis(readAtBasis)) {
    return reject(
      "封筒の読み取った日時の種類が分かりませんでした（ヘルパーと拡張機能の版が" +
        "食い違っているかもしれません）。どちらかを更新してからお試しください。"
    );
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return reject("封筒に読者の反応が1件も入っていませんでした。");
  }

  const parsedEntries: ReaderStatsEnvelopeEntry[] = [];
  for (const raw of entries) {
    const entry = parseEntry(raw);
    // **1行でも読めなければ封筒ごと断る。** 読めた行だけ取り込むと、
    // 作者には「取り込んだ」としか見えないまま、抜けた行に気づけない
    if (!entry) {
      return reject(
        "封筒の中に、数として読めない値がありました（取り込みを中止しました）。"
      );
    }
    parsedEntries.push(entry);
  }

  const trimmedWorkId = (workId ?? "").trim();
  /*
    **出どころのある封筒は、作品IDが無ければ受けない**（残課題 B11）。
    Narou.fun は**誰の作品の頁でも開ける**ので、作者の作品かどうかは
    作品ID（Nコード）でしか確かめられない。管理画面の封筒は「作品IDが無くても
    通す」が、それは管理画面が作者本人にしか開けないからである。
  */
  if (source !== undefined && !trimmedWorkId) {
    return reject(
      `${READER_STATS_ENVELOPE_SOURCES[source].label}から読んだ封筒に、` +
        "作品ID（Nコード）が入っていませんでした。どの作品の数か確かめられないため、" +
        "取り込みません。"
    );
  }
  return {
    ok: true,
    envelope: {
      [MARKER]: READER_STATS_ENVELOPE_VERSION,
      site: known.id,
      ...(source !== undefined ? { source } : {}),
      ...(trimmedWorkId ? { workId: trimmedWorkId } : {}),
      readAt: readAt.trim(),
      ...(readAtBasis !== undefined ? { readAtBasis } : {}),
      entries: parsedEntries,
    },
  };
}

/**
 * 読者の反応の束（作者の依頼 2026-09-23。ヘルパー 0.9.0 の「まとめて渡す」）。
 *
 * ## 何のためのものか
 *
 * ヘルパーは開いた画面ごとに読者の反応を溜め、「まとめて渡す」で1回に渡す。
 * 束の中の1件は**これまでの封筒そのもの**（`novelai-stats` v1。形を変えない）で、
 * 溜めた順（古いものが先）に並ぶ。1件は1つの作品の1つの画面なので、
 * **束には複数の作品が混ざりうる**（振り分けは `readerStatsHelperLink.ts`）。
 *
 * 形（ヘルパーの README「溜めた分をまとめたデータ」・`common/stash.js` の `makeBundle`）：
 *
 *   { "kind": "novelai-stats-bundle", "version": 1, "handedAt": ISO 8601, "items": [ 封筒, … ] }
 */
export const READER_STATS_BUNDLE_KIND = "novelai-stats-bundle";

/** 束の形式版数。**これと一致するときだけ読む**（ヘルパーとの取り決め） */
export const READER_STATS_BUNDLE_VERSION = 1;

/**
 * 束の中の1件。**読めなかった件も、理由を持ったまま並びに残す**——1件が
 * 読めないからといって束ごと断ると、読めた画面まで取り込めない（束は
 * 別々の画面を溜めたもので、1件ずつ独立している）。
 */
export interface ReaderStatsBundleItem {
  /** 束の中で何件目か（1から。取り込めなかったものを知らせるときに使う） */
  readonly position: number;
  readonly result: ReaderStatsEnvelopeResult;
}

export interface ReaderStatsBundle {
  /** まとめて渡した時刻（ヘルパーが書く。記録には使わない——記録の日時は各封筒の readAt） */
  readonly handedAt?: string;
  /** 溜めた順（古いものが先）。**空の束は受け取らない** */
  readonly items: readonly ReaderStatsBundleItem[];
}

/**
 * クリップボードを読んだ結果。**1件の封筒か、束か**を見分けて返す。
 *
 * 断るとき（`ok: false`）の形は `ReaderStatsEnvelopeResult` と同じ——
 * 「封筒が入っていなかった」（`notEnvelope`）の見分けも同じに使える。
 */
export type ReaderStatsPasteResult =
  | { readonly ok: true; readonly kind: "envelope"; readonly envelope: ReaderStatsEnvelope }
  | { readonly ok: true; readonly kind: "bundle"; readonly bundle: ReaderStatsBundle }
  | Extract<ReaderStatsEnvelopeResult, { ok: false }>;

/**
 * 版の食い違いの断り（束）。**どちらが古いかはこちらに分からない**——
 * 統合小説執筆環境が古くて新しい束を読めないのか、ヘルパーが古いのか。
 * 両方を新しくすれば、どちらの場合も直る。
 */
export const READER_STATS_BUNDLE_VERSION_MISMATCH =
  "ヘルパーと統合小説執筆環境の片方が古いようです。両方を新しくしてください。";

/**
 * クリップボードの中身を読む（1件の封筒か束か）。**直さずに、受けるか断るかだけを決める。**
 *
 * - 束の目印（`kind`）があれば束として読む。版が違えば**束ごと取り込まない**
 *   （欄の意味が変わったものを読むと、数字が化ける）
 * - 束の中の1件ずつは `parseReaderStatsEnvelope` と**同じ関所**を通す。
 *   読めない件は理由を持たせて残し、残りは止めない
 * - 束の目印が無ければ、これまでどおり1件の封筒として読む
 */
export function parseReaderStatsPaste(raw: string): ReaderStatsPasteResult {
  const value = parseObject(raw);
  if (!value) return notEnvelopeResult();
  if (value.kind !== READER_STATS_BUNDLE_KIND) {
    const single = readEnvelopeValue(value);
    return single.ok ? { ok: true, kind: "envelope", envelope: single.envelope } : single;
  }

  if (value.version !== READER_STATS_BUNDLE_VERSION) {
    return { ok: false, reason: READER_STATS_BUNDLE_VERSION_MISMATCH };
  }
  if (!Array.isArray(value.items)) {
    // 版は合うのに並びが無い——作り手の不具合。直し方はこちらに分からない
    return {
      ok: false,
      reason: `まとめて渡された読者の反応を読めませんでした。${READER_STATS_BUNDLE_VERSION_MISMATCH}`,
    };
  }
  if (value.items.length === 0) {
    // ヘルパーは空の束を作らない取り決め。来たら何も書かずに言う
    return { ok: false, reason: "まとめて渡された読者の反応が、1件も入っていませんでした。" };
  }

  const items = value.items.map((item, index): ReaderStatsBundleItem => {
    const position = index + 1;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { position, result: reject(BUNDLE_ITEM_NOT_ENVELOPE) };
    }
    const result = readEnvelopeValue(item as Record<string, unknown>);
    // 束の中で「封筒が入っていない」は、クリップボードの話ではない（文言を束の言い方にする）
    return {
      position,
      result: !result.ok && result.kind === "notEnvelope" ? reject(BUNDLE_ITEM_NOT_ENVELOPE) : result,
    };
  });
  const handedAt =
    typeof value.handedAt === "string" && value.handedAt.trim()
      ? value.handedAt.trim()
      : undefined;
  return {
    ok: true,
    kind: "bundle",
    bundle: { ...(handedAt ? { handedAt } : {}), items },
  };
}

const BUNDLE_ITEM_NOT_ENVELOPE = "読者の反応のデータとして読めませんでした。";

function notEnvelopeResult(): Extract<ReaderStatsEnvelopeResult, { ok: false }> {
  return { ok: false, reason: NOT_ENVELOPE_REASON, kind: "notEnvelope" };
}

/**
 * 書かれていない欄か。**`null` も「欄なし」として扱う**（0.33.9）。
 *
 * 封筒を作るのは別プロジェクト（ブラウザ拡張）で、読めなかった欄を `null` で
 * 書くのは素直な書き方である。断ると、数字は正しいのに書き方の流儀だけで
 * 封筒ごと落ちる——**1行でも読めなければ封筒ごと断る**作りなので、影響が大きい。
 */
function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

/** 1行を読む。読めなければ undefined（呼ぶ側が封筒ごと断る） */
function parseEntry(raw: unknown): ReaderStatsEnvelopeEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;

  const scope = value.scope;
  if (scope !== "work" && scope !== "episode") return undefined;

  const episode = absent(value.episode) ? undefined : value.episode;
  if (episode !== undefined) {
    // 作品全体の行に話数は付かない（どちらが本当かこちらには決められない）
    if (scope !== "episode") return undefined;
    if (!Number.isSafeInteger(episode) || (episode as number) < 1) {
      return undefined;
    }
  }

  const period = absent(value.period) ? undefined : value.period;
  if (
    period !== undefined &&
    (typeof period !== "string" ||
      !READER_STATS_PERIODS.includes(period as ReaderStatsPeriod))
  ) {
    return undefined;
  }
  const rawPeriodKey = absent(value.periodKey) ? undefined : value.periodKey;
  if (rawPeriodKey !== undefined && typeof rawPeriodKey !== "string") {
    return undefined;
  }
  // **空文字も「欄なし」。** 期間を読めなかった行が、粒度だけの行として
  // 断られてしまう（`"" ` は日付でも月でもない）
  const periodKey =
    rawPeriodKey !== undefined && rawPeriodKey.trim() === ""
      ? undefined
      : rawPeriodKey;
  /*
    **粒度と期間は対で意味を持つ**（台帳の `assertReaderStatsRecord` と
    同じ基準）。「日別」だけあっても、いつの日か読めない——ここで通すと、
    台帳へ書き込む段で例外になり、作者には理由の分からない失敗になる。
  */
  if (period === undefined) {
    if (periodKey !== undefined) return undefined;
  } else if (
    !isReaderStatsPeriodKey(
      period as ReaderStatsPeriod,
      periodKey === undefined ? undefined : (periodKey as string).trim()
    )
  ) {
    return undefined;
  }

  // 負を受けるかは粒度で決まる（日別の増減の欄だけ。台帳と同じ線）
  const metrics = parseMetrics(value.metrics, period);
  if (!metrics) return undefined;

  /*
    最終更新（約束 v1b）。**null と空文字は「欄なし」**（期間の見出しと同じ
    扱い）——読めなかった日時を空で書くのは素直な書き方で、そこで断ると
    数字の正しい封筒まで丸ごと落ちる。

    **書いてあるのに日時として読めなければ、封筒ごと断る。** 直し方は
    こちらには分からないし、読めない日時で「基準の話」を選ぶと率が化ける。
    作品全体の行に付いていたら、どの話の日時か決められないので同じく断る。
  */
  const rawUpdatedAt = absent(value.updatedAt) ? undefined : value.updatedAt;
  if (rawUpdatedAt !== undefined && typeof rawUpdatedAt !== "string") {
    return undefined;
  }
  const updatedAt =
    rawUpdatedAt === undefined || rawUpdatedAt.trim() === ""
      ? undefined
      : rawUpdatedAt.trim();
  if (updatedAt !== undefined) {
    if (scope !== "episode") return undefined;
    if (!isReaderStatsUpdatedAt(updatedAt)) return undefined;
  }

  return {
    scope,
    ...(episode === undefined ? {} : { episode: episode as number }),
    ...(period === undefined ? {} : { period: period as ReaderStatsPeriod }),
    ...(periodKey === undefined
      ? {}
      : { periodKey: (periodKey as string).trim() }),
    metrics,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

/**
 * 数値を読む。**知らない欄は捨て、数でない値は封筒ごと断る。**
 *
 * 「指示の言葉が答えの中身として返ってくる」のと同じことが、封筒でも起きうる
 * ——`"pv": "1,234"` のような文字列を数として書き込むと、台帳が壊れる。
 */
function parseMetrics(
  raw: unknown,
  period: unknown
): ReaderStatsMetrics | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const metrics: ReaderStatsMetrics = {};
  // **サイト固有の欄も受ける**（0.69.9）。並び・名前は台帳と同じ表を見る
  for (const info of ALL_READER_STATS_METRICS) {
    const entry = value[info.key];
    if (entry === undefined) continue;
    /*
      **台帳と同じ関所を通す**（`isReaderStatsValue`）。小数を受けるのは小数の欄
      だけ、負を受けるのは日別の増減の欄（ブックマーク・評価ポイント）の日別の行
      だけ（残課題 B11 の続き）。ここで別の線を引くと、封筒は通ったのに台帳へ
      書く段で例外になる（作者には理由の分からない失敗になる）。
    */
    if (!isReaderStatsValue(entry, info, period)) return undefined;
    metrics[info.key] = entry;
  }
  // 中身の無い行は受け取らない（台帳の側と同じ基準）
  return hasReaderStatsMetrics(metrics) ? metrics : undefined;
}

/**
 * 封筒から、台帳へ書く記録を組む（設計書6.79.7）。
 *
 * **組み方を1か所に置く。** 取り込み（`features/readerStats.ts`）と、
 * 「もう取り込んだデータか」の見分け（`readerStatsHelperLink.ts`。VS Code に
 * 戻ったときの自動取り込み）が同じ記録を見ないと、取り込み済みのものを
 * 何度も訊くことになる——片方だけメモの書き方を変えると、そこで食い違う。
 */
export function readerStatsRecordsFromEnvelope(
  envelope: ReaderStatsEnvelope
): ReaderStatsRecord[] {
  const sourceLabel = readerStatsSourceLabel(envelope.source);
  /*
    **どこで読んだかをメモに残す**（残課題 B11）。台帳の出どころ（`source`）は
    「貼り付け」のままにする——一覧を増やすと、それを知らない古い版が台帳ごと
    読めなくなる（`READER_STATS_SOURCES` の注記）。だが Narou.fun の数は
    なろう本体の画面より遅れて集計されることがあり、あとから見た作者が
    「なろうの管理画面の数」と取り違えないよう、履歴の表のメモ列で見えるようにする。
  */
  const note = sourceLabel
    ? `${sourceLabel}から読み取り${readAtNote(sourceLabel, envelope.readAtBasis)}`
    : undefined;
  return envelope.entries.map((entry) => ({
    site: envelope.site,
    // **封筒の読み取り時刻を使う。** いま取り込んだ時刻ではない。
    // Narou.fun の封筒は「最終取得日時」（readAtBasis が fetched のとき）
    readAt: envelope.readAt,
    ...entry,
    source: "helper" as const,
    ...(note ? { note } : {}),
  }));
}

/** 封筒を台帳へ積んだ結果 */
export interface ReaderStatsApplied {
  /** 積んだあとの台帳（元の台帳は書き換えない） */
  readonly ledger: PostingLedger;
  /** 積んだ行の数 */
  readonly added: number;
  /** 取り込み済みの数と同じだったので積まなかった行の数 */
  readonly repeated: number;
}

/**
 * 封筒の記録を台帳へ積む。**同じ数の繰り返しは積まない**（`repeatsReaderStats`）。
 *
 * **1件の取り込みと束の取り込みが、この1か所を通る**（写しを作らない）。
 * 束では同じ作品の画面を**順に、同じ台帳へ**積むので、作品管理とアクセス数の
 * ように日ごとの数が重なる2画面を続けて入れても、あとの画面の重なった行は
 * 前の画面の行を見て止まる。
 *
 * 照合（`matchReaderStatsEnvelope`）は呼ぶ側が先に済ませる。記録が台帳の関所で
 * 断られたときは例外がそのまま出る（封筒の検証を通っていれば来ない）。
 */
export function applyReaderStatsEnvelope(
  ledger: PostingLedger,
  envelope: ReaderStatsEnvelope
): ReaderStatsApplied {
  let next = ledger;
  let added = 0;
  let repeated = 0;
  for (const record of readerStatsRecordsFromEnvelope(envelope)) {
    if (repeatsReaderStats(next, record)) {
      repeated++;
      continue;
    }
    next = withReaderStats(next, record);
    added++;
  }
  return { ledger: next, added, repeated };
}

/**
 * メモに添える「記録の日時は何の日時か」（残課題 B11 の続き、作者の裁定 2026-09-23）。
 *
 * 出どころのある封筒（Narou.fun）の記録の日時は、ふつう**そのサイトが数を取って
 * きた日時**（最終取得日時）である。読めなかった封筒は押した時刻へ落ちている
 * ——履歴の表では同じ日時の列に並ぶので、**どちらなのかをメモで見分けられる**
 * ようにする（印が無い封筒は、ヘルパー 0.6.0 までの「押した時刻」）。
 */
function readAtNote(
  sourceLabel: string,
  basis: ReaderStatsReadAtBasis | undefined
): string {
  return basis === "fetched"
    ? `（日時は${sourceLabel}の最終取得日時）`
    : `（日時は押した時刻。${sourceLabel}の最終取得日時は読めず）`;
}

/**
 * 封筒と台帳を突き合わせる（設計書6.79.7の4）。
 *
 * **取り違えを止めるのが仕事である。** 別の作品の管理画面を開いたまま
 * 押したときに、数字が混ざる——いちど混ざると、どれが誰の数字だったかは
 * あとから分けられない。
 *
 * @returns 取り込んでよければ null。断るなら、作者に見せる理由
 */
export function matchReaderStatsEnvelope(
  envelope: ReaderStatsEnvelope,
  ledger: PostingLedger
): string | null {
  const info = postingSiteInfo(envelope.site);

  /*
    **載っていると分かっているサイトだけを受ける。** 出していない作品の
    台帳へ数字が入ると、どの作品のものか台帳からは分からなくなる。

    証拠は**投稿先の登録（`sites`）だけではない**（0.69.9。作者の裁定
    「siteProfiles も証拠と見る」）。ZIPから取り込んだ作品は、すでに
    そのサイトに載っているのに、バックアップに投稿ページのURLが無くて
    `sites` を作れない——そこで口が塞がっていた（設計書6.99）。
  */
  if (!isKnownPostingSite(ledger, envelope.site)) {
    return (
      `この作品は${info.label}に載っていることが分かっていません。` +
      "「投稿サイトの設定」で登録してから取り込んでください。"
    );
  }

  if (envelope.source !== undefined) {
    return matchBySourceWorkId(envelope, ledger);
  }

  const known = siteProfile(ledger, envelope.site)?.workId?.trim();
  // **台帳に作品IDが無ければ通す。** 入れていない作品も多く、ここで
  // 断ると「登録するまで使えない」機能になる（照合できないとは言える）
  if (!known || !envelope.workId) return null;
  if (known !== envelope.workId) {
    return (
      `封筒の作品ID（${envelope.workId}）が、この作品に登録された` +
      `${info.label}の作品ID（${known}）と違います。` +
      "別の作品の管理画面を読んでいないかご確認ください。"
    );
  }
  return null;
}

/**
 * 出どころのある封筒（Narou.fun）の照合（残課題 B11）。
 *
 * **台帳に作品IDが無ければ通さない**——管理画面の封筒と逆である。Narou.fun は
 * 誰の作品の頁でも開けるので、貼り込み係には作者の作品かどうかが分からない。
 * 作品ID（Nコード）で照合できて初めて「作者の作品の数」と言える。
 *
 * 台帳のNコードは、作者が入れた作品ID → 作品ページのURL → 投稿ページのURL
 * の順に探す（`narouNcode` と `deriveSiteProfile`。分析リンクを組むときと
 * 同じ導き）。比べるときは**大文字・小文字を問わない**（Narou.fun のURLは
 * 大文字、なろうのURLとバックアップは小文字）。
 */
function matchBySourceWorkId(
  envelope: ReaderStatsEnvelope,
  ledger: PostingLedger
): string | null {
  const info = postingSiteInfo(envelope.site);
  const sourceLabel = readerStatsSourceLabel(envelope.source) ?? info.label;
  const profile = siteProfile(ledger, envelope.site);
  const postUrl = ledger.sites.find(
    (entry) => entry.site === envelope.site
  )?.newEpisodeUrl;
  // いまの出どころは Narou.fun（なろう）だけ。増えたら、ここでサイトごとの導きを足す
  const known =
    narouNcode(profile?.workId, profile?.workUrl) ??
    narouNcode(deriveSiteProfile(envelope.site, postUrl).workId);
  if (!known) {
    return (
      `この作品に、${info.label}の作品ID（Nコード）が登録されていません。` +
      `${sourceLabel}の頁はどの作品のものでも開けるため、作品IDと照合できないときは` +
      "取り込みません。「投稿サイトの設定」でNコードを登録してから取り込んでください。"
    );
  }
  const received = narouNcode(envelope.workId);
  if (received !== known) {
    return (
      `封筒の作品ID（${envelope.workId ?? ""}）が、この作品に登録された` +
      `${info.label}の作品ID（${known.toUpperCase()}）と違います。` +
      `${sourceLabel}でほかの作品の頁を読んでいないかご確認ください。`
    );
  }
  return null;
}
