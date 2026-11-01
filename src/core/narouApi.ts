import {
  readReaderStatsTags,
  repeatsRanking,
  repeatsReaderStats,
  withRanking,
  withReaderStats,
  withSiteFacts,
  type PostingLedger,
  type PostingRankingRecord,
  type ReaderStatsMetrics,
  type ReaderStatsRecord,
  type WorkCompletion,
} from "../models/posting";

/**
 * なろう小説API・なろう殿堂入りAPIから、**その作品自身の**数と順位を取る（作者の指示 2026-11-02）。
 *
 * ## 作者がなろうの運営へ約束した使い方（docs/手順書/なろうデベロッパー利用状況アンケートの回答案.md）
 *
 * 1. 利用者本人が作品に登録した Nコード**1つだけ**を渡す。他人の作品を集めない。
 *    だからランキングAPI（その日の上位300作品の一覧）は使わない——殿堂入りAPIは
 *    Nコードを1つ渡すと、その作品が入った順位の履歴だけが返る
 * 2. 利用者がボタンを押したときだけ取る。自動で繰り返さない。上限はコードで守る
 *    （`narouApiGate.ts`）
 * 3. 取った数は作品フォルダーの投稿の記録にだけ書く。外へ送らない
 * 4. **取った数は AI に渡さない**（記録に `source: "narou-api"` の印を付け、AI の材料を
 *    作る所が `readerStatsForAi` で除く）
 * 5. 取った数を出す画面に出典を書く（`NAROU_API_ATTRIBUTION`）
 *
 * ここは**組み立てと読み取りだけ**で、通信もファイルも触らない（VS Code API にも依存しない）。
 * 通信は `features/narouApiFetch.ts` が、差し替えられる `fetch` で行う。
 */

/** なろうデベロッパー利用ガイドライン。**変えたら、開いた記録は無効になる**（`narouApiGate.ts`） */
export const NAROU_GUIDELINE_URL = "https://dev.syosetu.com/site/guideline/";

export const NAROU_NOVEL_API_URL = "https://api.syosetu.com/novelapi/api/";
export const NAROU_RANKIN_API_URL = "https://api.syosetu.com/rank/rankin/";

/** 取った数を出す所に書く出典（作者がアンケートで約束した書き方に、殿堂入りAPIを足したもの） */
export const NAROU_API_ATTRIBUTION =
  "出典：なろうデベロッパー（なろう小説API・なろう殿堂入りAPI）";

/**
 * なろう小説APIの `of`（要る欄だけを頼む。転送量を減らすよう仕様が勧めている）。
 *
 * n=ncode（取り違えの確かめ）・gp=global_point（総合ポイント）・f=fav_novel_cnt（ブックマーク）・
 * a=all_point（評価ポイント）・ah=all_hyoka_cnt（評価者数）・r=review_cnt（レビュー）・
 * imp=impression_cnt（感想）・ga=general_all_no（総話数）・gl=general_lastup（最終掲載日）・
 * e=end（連載状態）・nt=noveltype（連載か短編か）・k=keyword（タグ）
 */
export const NAROU_NOVEL_API_FIELDS = "n-gp-f-a-ah-r-imp-ga-gl-e-nt-k";

/**
 * API の欄 → 台帳の指標。**ヘルパーが Narou.fun から読むときと同じ当てはめ**
 * （novel-post-helper の statsSites.js：総合ポイント→points／ブクマ→bookmarks／
 * 感想→comments／レビュー→reviews／評価ポイント→narou_ratingPoints／評価者数→narou_raters）。
 *
 * 評価平均（`narou_ratingAverage`）は API に無い。**割って作らない**——作れば、どこにも
 * 書かれていない数を「API の数」として台帳に置くことになる。
 */
export const NAROU_NOVEL_API_METRICS: readonly { field: string; metric: string }[] = [
  { field: "global_point", metric: "points" },
  { field: "fav_novel_cnt", metric: "bookmarks" },
  { field: "impression_cnt", metric: "comments" },
  { field: "review_cnt", metric: "reviews" },
  { field: "all_point", metric: "narou_ratingPoints" },
  { field: "all_hyoka_cnt", metric: "narou_raters" },
];

/** 殿堂入りの種別 → 順位の記録の種別（手で記録するときの呼び方に揃える） */
export const NAROU_RANKIN_BOARDS: Readonly<Record<"d" | "w" | "m" | "q", string>> = {
  d: "日間",
  w: "週間",
  m: "月間",
  q: "四半期",
};

/** Nコードの形（`postingSiteRecords.ts` と同じ。小文字に揃えてから渡す） */
const NCODE = /^n[0-9]{4}[a-z]{1,2}$/;

export function narouNovelApiUrl(ncode: string): string {
  const params = new URLSearchParams({
    out: "json",
    ncode: ncode.toLowerCase(),
    of: NAROU_NOVEL_API_FIELDS,
  });
  return `${NAROU_NOVEL_API_URL}?${params.toString()}`;
}

export function narouRankinApiUrl(ncode: string): string {
  const params = new URLSearchParams({ out: "json", ncode: ncode.toLowerCase() });
  return `${NAROU_RANKIN_API_URL}?${params.toString()}`;
}

/** Nコードとして通るか（API へ渡す前の関所。小文字で比べる） */
export function isNarouNcode(value: string): boolean {
  return NCODE.test(value.trim().toLowerCase());
}

/**
 * 失敗の種類（作者の指示：分けて1文で知らせ、次の一手を1つ示す）。
 *
 * - `network`：通信できなかった（`fetch` が投げた）
 * - `http`：API が返さなかった（200 番台でない）
 * - `not_found`：該当する作品が無い（削除・非公開・Nコード違い）
 * - `shape`：返事の形が思っていたものと違う
 */
export type NarouApiFailureKind = "network" | "http" | "not_found" | "shape";

export class NarouApiError extends Error {
  constructor(
    readonly kind: NarouApiFailureKind,
    message: string,
    /** 返事の本文（ログに残す。通知には出さない） */
    readonly body?: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "NarouApiError";
  }
}

/**
 * 作者に見せる1文と、次の一手（種類ごとに1つ）。**返事の本文から原因を当てにいかない**
 * （実装ルール5。分けるのは、こちらで確かに分かる違いだけ）。
 *
 * @param api どちらの API か（「なろう小説API」「なろう殿堂入りAPI」）
 */
export function describeNarouApiFailure(
  kind: NarouApiFailureKind,
  api: string,
  detail: { ncode: string; status?: number }
): string {
  switch (kind) {
    case "network":
      return (
        `${api}につながりませんでした。` +
        "インターネットにつながっているか確かめてから、もう一度押してください。"
      );
    case "http":
      return (
        `${api}が返事を返しませんでした（HTTP ${detail.status ?? "不明"}）。` +
        "なろう側が混み合っているか止まっている可能性があります。時間をおいてもう一度押してください。"
      );
    case "not_found":
      return (
        `${api}に、Nコード「${detail.ncode}」の作品が見つかりませんでした` +
        "（作品の削除・非公開、または Nコードの違いが考えられます）。" +
        "「投稿サイト設定」で Nコードを確かめてください。"
      );
    case "shape":
      return (
        `${api}の返事が、思っていた形と違いました（APIの仕様が変わった可能性があります）。` +
        "拡張機能を最新の版にしてから、もう一度押してください。"
      );
  }
}

/** なろう小説APIから読めた1作品ぶん */
export interface NarouNovelInfo {
  ncode: string;
  /** 読めた指標だけ（読めなかった欄を0で埋めない） */
  metrics: ReaderStatsMetrics;
  /** 総話数（短編は1）。読めなければ undefined */
  episodes?: number;
  /** 最終掲載日（「YYYY-MM-DD HH:MM:SS」のまま）。読めなければ undefined */
  lastPostedAt?: string;
  /** タグ（キーワード）。読めなければ undefined */
  tags?: string[];
  /** 連載の状態。**短編は決めない**（連載中とも完結とも言えない） */
  completion?: WorkCompletion;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * なろう小説APIの返事（`out=json`）を読む。
 *
 * 形は「先頭が `{ allcount }`、2つ目からが作品」の配列。`allcount` が0なら該当作品なし。
 * **返ってきた作品の Nコードが頼んだものと違えば、形が違う扱い**（他人の作品の数を
 * 台帳へ入れない）。
 *
 * @throws NarouApiError（`not_found` か `shape`）
 */
export function parseNarouNovelApi(text: string, ncode: string): NarouNovelInfo {
  const wanted = ncode.toLowerCase();
  const shape = (why: string): NarouApiError =>
    new NarouApiError("shape", `なろう小説APIの返事を読めませんでした（${why}）。`, text);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw shape("JSONではありません");
  }
  if (!Array.isArray(raw) || raw.length === 0) throw shape("配列ではありません");
  const head = raw[0] as { allcount?: unknown } | null;
  if (typeof head !== "object" || head === null || !isCount(head.allcount)) {
    throw shape("allcount がありません");
  }
  if (head.allcount === 0 || raw.length < 2) {
    throw new NarouApiError("not_found", "該当する作品がありません。", text);
  }
  const work = raw[1] as Record<string, unknown> | null;
  if (typeof work !== "object" || work === null) throw shape("作品の欄がありません");
  if (typeof work.ncode !== "string" || work.ncode.toLowerCase() !== wanted) {
    throw shape("頼んだ Nコードと違う作品が返りました");
  }

  const metrics: ReaderStatsMetrics = {};
  for (const { field, metric } of NAROU_NOVEL_API_METRICS) {
    const value = work[field];
    if (value === undefined || value === null) continue;
    if (!isCount(value)) throw shape(`${field} が数ではありません`);
    metrics[metric] = value;
  }
  if (Object.keys(metrics).length === 0) throw shape("数の欄が1つもありません");

  const info: NarouNovelInfo = { ncode: wanted, metrics };
  if (isCount(work.general_all_no)) info.episodes = work.general_all_no;
  if (typeof work.general_lastup === "string" && work.general_lastup.trim()) {
    info.lastPostedAt = work.general_lastup.trim();
  }
  if (typeof work.keyword === "string") {
    /*
      区切りは仕様に書かれていない（実物は半角の空白）。**全角の空白でも割る**——タグの中に
      空白は入らない。読めない形（長すぎる・多すぎる）は欄ごと捨てる（ヘルパーと同じ関所）
    */
    const tags = readReaderStatsTags(work.keyword.split(/[\s　]+/));
    if (tags) info.tags = tags;
  }
  /*
    end：0＝短編または完結済み、1＝連載中。noveltype：1＝連載、2＝短編。
    **短編は決めない**——連載の状態の印は連載の作品のためのもので、短編を「完結」と
    書けば、作者が決めた作品の印と食い違って見える
  */
  if (work.end === 1) info.completion = "ongoing";
  else if (work.end === 0 && work.noveltype === 1) info.completion = "completed";
  return info;
}

/** 殿堂入りの1件（順位の記録に積む形へ直したもの） */
export interface NarouRankinEntry {
  board: string;
  /** 順位が出た日の 0:00（日本時間。ISO8601） */
  recordedAt: string;
  rank: number;
  /** その時のポイント（メモに添える） */
  points?: number;
}

/**
 * なろう殿堂入りAPIの返事（`out=json`）を読む。
 *
 * 形は `[{ rtype: "20130501-d", pt, rank }, ...]`。**空の配列は「ランキングに入ったことが
 * 無い」**で、失敗ではない。Nコードが無い・読めないときは素の文字列「Error: Novel not found.」
 * が返る（仕様）。**1件でも形の違う行があれば全体を断る**——半分だけ積むと、どこまで
 * 取れたのか作者に分からない。
 *
 * @throws NarouApiError（`not_found` か `shape`）
 */
export function parseNarouRankinApi(text: string): NarouRankinEntry[] {
  if (/Novel not found/i.test(text)) {
    throw new NarouApiError("not_found", "該当する作品がありません。", text);
  }
  const shape = (why: string): NarouApiError =>
    new NarouApiError("shape", `なろう殿堂入りAPIの返事を読めませんでした（${why}）。`, text);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw shape("JSONではありません");
  }
  if (!Array.isArray(raw)) throw shape("配列ではありません");
  return raw.map((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null) throw shape(`${index + 1}件目が欄ではありません`);
    const row = entry as Record<string, unknown>;
    const found =
      typeof row.rtype === "string"
        ? /^(\d{4})(\d{2})(\d{2})-([dwmq])$/.exec(row.rtype.trim())
        : null;
    if (!found) throw shape(`${index + 1}件目の rtype が読めません`);
    if (!isCount(row.rank) || row.rank < 1) throw shape(`${index + 1}件目の rank が読めません`);
    const [, year, month, day, type] = found;
    const result: NarouRankinEntry = {
      board: NAROU_RANKIN_BOARDS[type as "d" | "w" | "m" | "q"],
      // なろうのランキングは日本時間で作られる。手元の時差で日付がずれないよう、時差を書く
      recordedAt: `${year}-${month}-${day}T00:00:00+09:00`,
      rank: row.rank,
    };
    if (isCount(row.pt)) result.points = row.pt;
    return result;
  });
}

/** 取れたものを台帳へ書いた結果 */
export interface NarouApiApplied {
  ledger: PostingLedger;
  /** 読者の反応を積んだか（同じ日の同じ数なら積まない） */
  statsAdded: boolean;
  /** 積んだ順位の数（台帳にもうある順位は積まない） */
  ranksAdded: number;
  /** 積まなかった順位の数 */
  ranksRepeated: number;
  /** タグ・連載の状態を書き換えたか */
  factsChanged: boolean;
  /** 新しく積んだ順位（お祝いを決めるのに使う） */
  newRanks: PostingRankingRecord[];
}

/**
 * 取れた数と順位を、台帳へ書く（元の台帳は書き換えない）。
 *
 * - 数は**読者の反応の記録の形**（作品全体・その時点の値）に、出どころ `narou-api` で積む。
 *   同じ日に何度取っても、いま見えている数と同じなら積まない（`repeatsReaderStats`。
 *   見るときも同じ日はあとの方だけ）
 * - 順位は**順位の記録**に、出どころ `narou-api` で積む。種別と日付ごとに1つで、
 *   同じ順位がもうあれば積まない（`repeatsRanking`）
 * - タグと連載の状態は、ヘルパーの封筒と同じ道（`withSiteFacts`）。食い違いの知らせも同じ
 *
 * @param readAt 取った時刻（ISO8601）
 */
export function applyNarouApiResult(
  ledger: PostingLedger,
  input: { readAt: string; novel: NarouNovelInfo; ranks: readonly NarouRankinEntry[] }
): NarouApiApplied {
  let next = ledger;
  const parts: string[] = [];
  if (input.novel.episodes !== undefined) parts.push(`総話数${input.novel.episodes}`);
  if (input.novel.lastPostedAt) parts.push(`最終掲載${input.novel.lastPostedAt}`);
  const record: ReaderStatsRecord = {
    site: "narou",
    readAt: input.readAt,
    scope: "work",
    metrics: { ...input.novel.metrics },
    source: "narou-api",
    note: `なろう小説APIから取得${parts.length > 0 ? `（${parts.join("・")}）` : ""}`,
  };
  let statsAdded = false;
  if (!repeatsReaderStats(next, record)) {
    next = withReaderStats(next, record);
    statsAdded = true;
  }

  let ranksAdded = 0;
  let ranksRepeated = 0;
  const newRanks: PostingRankingRecord[] = [];
  for (const entry of input.ranks) {
    const rank: PostingRankingRecord = {
      site: "narou",
      recordedAt: entry.recordedAt,
      board: entry.board,
      rank: entry.rank,
      note:
        entry.points !== undefined
          ? `なろう殿堂入りAPIから取得（${entry.points}pt）`
          : "なろう殿堂入りAPIから取得",
      source: "narou-api",
    };
    if (repeatsRanking(next, rank)) {
      ranksRepeated++;
      continue;
    }
    next = withRanking(next, rank);
    newRanks.push(rank);
    ranksAdded++;
  }

  const facts = withSiteFacts(next, {
    site: "narou",
    readAt: input.readAt,
    ...(input.novel.tags !== undefined ? { tags: input.novel.tags } : {}),
    ...(input.novel.completion !== undefined ? { completion: input.novel.completion } : {}),
  });
  return {
    ledger: facts.ledger,
    statsAdded,
    ranksAdded,
    ranksRepeated,
    factsChanged: facts.changed,
    newRanks,
  };
}
