import {
  hasReaderStatsMetrics,
  isReaderStatsPeriodKey,
  postingSiteInfo,
  POSTING_SITES,
  READER_STATS_METRICS,
  READER_STATS_PERIODS,
  siteProfile,
  type PostingLedger,
  type PostingSiteId,
  type ReaderStatsMetrics,
  type ReaderStatsPeriod,
  type ReaderStatsScope,
} from "../models/posting";
import { supportsPasteHelper } from "./postingEnvelope";

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
}

export interface ReaderStatsEnvelope {
  [MARKER]: typeof READER_STATS_ENVELOPE_VERSION;
  site: PostingSiteId;
  /**
   * 管理画面のURLから読めた作品ID。**入っていれば照合する**（6.79.6の2）。
   *
   * 入れられないこともあるので任意。**空文字は入れない**——「IDが空の作品」
   * として照合してしまう。
   */
  workId?: string;
  /** 読み取った日時（ISO8601） */
  readAt: string;
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
  | { readonly ok: false; readonly reason: string };

function reject(reason: string): ReaderStatsEnvelopeResult {
  return { ok: false, reason };
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
 */
export function supportsReaderStatsHelper(site: PostingSiteId): boolean {
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
  workId?: string | null;
  readAt: string;
  entries: readonly ReaderStatsEnvelopeEntry[];
}): string {
  const workId = (input.workId ?? "").trim();
  return JSON.stringify({
    [MARKER]: READER_STATS_ENVELOPE_VERSION,
    site: input.site,
    ...(workId ? { workId } : {}),
    readAt: input.readAt,
    entries: input.entries,
  });
}

/** 封筒を読む。**直さずに、受けるか断るかだけを決める** */
export function parseReaderStatsEnvelope(
  raw: string
): ReaderStatsEnvelopeResult {
  // クリップボード経由なので、前後に改行や空白が付くことがある
  const trimmed = raw.trim();
  const notEnvelope =
    "クリップボードに、読者の反応の封筒が入っていませんでした。" +
    "管理画面で貼り込み係の「読者の反応をコピー」を押してから、もう一度お試しください。";
  if (!trimmed) return reject(notEnvelope);

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return reject(notEnvelope);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return reject(notEnvelope);
  }

  const value = parsed as Record<string, unknown>;
  if (value[MARKER] === undefined) return reject(notEnvelope);
  // **知らない版数は読まない。** 欄の意味が変わったものを読むと、数字が化ける
  if (value[MARKER] !== READER_STATS_ENVELOPE_VERSION) {
    return reject(
      "読者の反応の封筒の形式が違います（貼り込み係と拡張機能の版が" +
        "食い違っています）。どちらかを更新してからお試しください。"
    );
  }

  const site = value.site;
  const known =
    typeof site === "string"
      ? POSTING_SITES.find((info) => info.id === site)
      : undefined;
  if (!known) return reject("封筒に書かれたサイトが分かりませんでした。");
  if (!supportsReaderStatsHelper(known.id)) {
    // **仕様として断る**（6.79.7）。故障と読まれないよう、道があることまで言う
    return reject(
      `${known.label}の読者の反応は、貼り付けでは取り込みません` +
        "（規約の判断により、読み取りに対応していません）。" +
        "「読者の反応を手入力する」からご記入ください。"
    );
  }

  const { workId, readAt, entries } = value;
  if (workId !== undefined && typeof workId !== "string") {
    return reject("封筒の作品IDを読めませんでした。");
  }
  if (typeof readAt !== "string" || !readAt.trim()) {
    return reject("封筒に読み取った日時が入っていませんでした。");
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
  return {
    ok: true,
    envelope: {
      [MARKER]: READER_STATS_ENVELOPE_VERSION,
      site: known.id,
      ...(trimmedWorkId ? { workId: trimmedWorkId } : {}),
      readAt: readAt.trim(),
      entries: parsedEntries,
    },
  };
}

/** 1行を読む。読めなければ undefined（呼ぶ側が封筒ごと断る） */
function parseEntry(raw: unknown): ReaderStatsEnvelopeEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;

  const scope = value.scope;
  if (scope !== "work" && scope !== "episode") return undefined;

  const episode = value.episode;
  if (episode !== undefined) {
    // 作品全体の行に話数は付かない（どちらが本当かこちらには決められない）
    if (scope !== "episode") return undefined;
    if (!Number.isSafeInteger(episode) || (episode as number) < 1) {
      return undefined;
    }
  }

  const period = value.period;
  if (
    period !== undefined &&
    (typeof period !== "string" ||
      !READER_STATS_PERIODS.includes(period as ReaderStatsPeriod))
  ) {
    return undefined;
  }
  const periodKey = value.periodKey;
  if (periodKey !== undefined && typeof periodKey !== "string") {
    return undefined;
  }
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

  const metrics = parseMetrics(value.metrics);
  if (!metrics) return undefined;

  return {
    scope,
    ...(episode === undefined ? {} : { episode: episode as number }),
    ...(period === undefined ? {} : { period: period as ReaderStatsPeriod }),
    ...(periodKey === undefined
      ? {}
      : { periodKey: (periodKey as string).trim() }),
    metrics,
  };
}

/**
 * 数値を読む。**知らない欄は捨て、数でない値は封筒ごと断る。**
 *
 * 「指示の言葉が答えの中身として返ってくる」のと同じことが、封筒でも起きうる
 * ——`"pv": "1,234"` のような文字列を数として書き込むと、台帳が壊れる。
 */
function parseMetrics(raw: unknown): ReaderStatsMetrics | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const metrics: ReaderStatsMetrics = {};
  for (const info of READER_STATS_METRICS) {
    const entry = value[info.key];
    if (entry === undefined) continue;
    if (!Number.isSafeInteger(entry) || (entry as number) < 0) return undefined;
    metrics[info.key] = entry as number;
  }
  // 中身の無い行は受け取らない（台帳の側と同じ基準）
  return hasReaderStatsMetrics(metrics) ? metrics : undefined;
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

  // **登録してあるサイトだけを受ける。** 出していない作品の台帳へ
  // 数字が入ると、どの作品のものか台帳からは分からなくなる
  if (!ledger.sites.some((entry) => entry.site === envelope.site)) {
    return (
      `この作品には${info.label}が投稿先として登録されていません。` +
      "「投稿サイトの設定」で登録してから取り込んでください。"
    );
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
