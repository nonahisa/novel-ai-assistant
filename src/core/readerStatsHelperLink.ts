import {
  hasHelperRankingOn,
  postingSiteInfo,
  repeatsReaderStats,
  siteProfile,
  validateNewEpisodeUrl,
  type PostingLedger,
  type PostingSiteEntry,
  type PostingSiteId,
} from "../models/posting";
import { narouNcode } from "./postingSiteRecords";
import { READER_SITE_TABS_HINT } from "./readerSiteTabNames";
import { newEpisodeUrlFromWorkId } from "./postingSiteUrls";
import { hashText } from "./hash";
import { canRunProcesses } from "./runtime";
import { SETUP_URI_PATH } from "./setupRequest";
import { RUN_URI_PATH } from "./runRequest";
import {
  matchReaderStatsEnvelope,
  READER_STATS_ENVELOPE_VERSION,
  rankingRecordFromHelper,
  readerStatsFactsWouldChange,
  readerStatsRecordsFromEnvelope,
  readerStatsSourceLabel,
  type ReaderStatsBundle,
  type ReaderStatsEnvelope,
  type ReaderStatsRanking,
} from "./readerStatsEnvelope";

/**
 * ヘルパー（Chrome 拡張「統合小説執筆環境ヘルパー」）からの呼び出しの判断
 * （設計書6.79.7「ヘルパーからの受け口」）。**画面を出さずに確かめられる部分**だけをここに置く。
 *
 * ## データはリンクに載らない
 *
 * ヘルパーは読者の反応をクリップボードへ置いてから
 * `vscode://nonahisa.novel-ai-assistant/import-reader-stats` を開く。
 * リンクは「VS Code を前に出して、取り込みを始めて」という合図でしかない。
 *
 * **URI のパスとクエリは信用しない。** URI は誰でも作れる（ウェブページの
 * リンク1つで開かせられる）。知らないパスは何もせず、クエリに何が
 * 書いてあっても読まない——読むのはクリップボードだけで、そこから先は
 * 作者が「読者反応自動取込」を押したときと同じ関所を通る。
 * （例外は Claude Code からのセットアップの依頼 `/setup` だけで、そこでは
 * クエリを白名簿で確かめ、作者の確認を経てから呼ぶ。設計書6.87.18）
 *
 * VS Code API には依存しない。
 */

/** 取り込みの合図のパス（ヘルパーとの約束） */
export const READER_STATS_IMPORT_URI_PATH = "/import-reader-stats";

/**
 * 公募の一覧の取り込みの合図のパス（ヘルパー 0.12.0 との約束。設計書6.3.6.1）。
 * **VS Code の受け口は拡張機能に1つしか持てない**ので、読者の反応と同じ受け口で
 * パスを見分ける。データは同じくクリップボードで渡る（リンクには載らない）。
 */
export const CONTESTS_IMPORT_URI_PATH = "/import-contests";

/**
 * 章立ての取り込みの合図のパス（ヘルパー 0.13.0 との約束。残課題 B7、設計書6.66.6）。
 * カクヨムの作品管理の画面の大見出しを、ヘルパーがクリップボードで渡す（`chapterEnvelope.ts`）。
 */
export const CHAPTERS_IMPORT_URI_PATH = "/import-chapters";

/**
 * 投稿した話の番号の合図のパス（ヘルパー 0.20.0 との約束。設計書6.68.8）。
 * 番号はクリップボードの `novelai-posted` で渡る（`postedEnvelope.ts`）。
 */
export const POSTED_IMPORT_URI_PATH = "/import-posted";

/** URI のパスが何の合図か。知らないパスは undefined（何もしない） */
export function readerStatsUriAction(
  uriPath: string
): "import" | "contests" | "chapters" | "posted" | "setup" | "run" | undefined {
  // 末尾の `/` だけは許す（ブラウザやOSが付け足すことがある）。
  // 大文字小文字は区別する——約束は1つの綴りで、似た綴りを拾う理由が無い
  const trimmed = uriPath.replace(/\/+$/u, "");
  if (trimmed === READER_STATS_IMPORT_URI_PATH) return "import";
  if (trimmed === CONTESTS_IMPORT_URI_PATH) return "contests";
  if (trimmed === CHAPTERS_IMPORT_URI_PATH) return "chapters";
  if (trimmed === POSTED_IMPORT_URI_PATH) return "posted";
  /*
    **Claude Code からのセットアップの依頼**（設計書6.87.18）。受け口は1つしか
    持てないので同じ口で見分ける。**クエリを読むのはこのパスだけ**で、
    白名簿で確かめてから（`core/setupRequest.ts`）、作者の確認を経て呼ぶ。
  */
  if (trimmed === SETUP_URI_PATH) return "setup";
  /*
    **外部AIから頼まれた実行**（設計書6.87.22）。クエリは依頼番号と合言葉だけで、
    札（保管庫）と突き合わせてから作者の確認を出す（`core/runRequest.ts`）。
  */
  if (trimmed === RUN_URI_PATH) return "run";
  return undefined;
}

/**
 * 知らないパスを記録に残すときの形。
 *
 * **誰が作ったか分からない文字列**なので、制御文字を落として短く切る
 * （ログの行を壊させない・長い文字列を流し込ませない）。クエリは渡さない
 * ——データが載っていても読まない、の線は記録にも引く。
 */
export function uriPathForLog(uriPath: string): string {
  // 制御文字は `\u0000`〜`\u001f` と `\u007f`（生のまま書かない。sourceHygiene）
  const clean = uriPath.replace(/[\u0000-\u001f\u007f]/gu, "");
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}

/**
 * クリップボードの中身の指紋（「同じデータで二度訊かない」ための鍵）。
 *
 * **読者の反応のデータと確かめたものにだけ使う。** クリップボードは作者の
 * 私物で、ほかのものは指紋すら覚えない。前後の空白は指紋に含めない
 * （コピーのしかたで改行が付くことがある）。
 */
export function readerStatsClipboardFingerprint(text: string): string {
  return hashText(text.trim());
}

/** 覚えておく指紋の数。**古いものから忘れる**（設定の保管庫を太らせない） */
export const MAX_REMEMBERED_FINGERPRINTS = 20;

/** 指紋を覚えた一覧を返す（新しいものを末尾へ。同じものは1つにまとめる） */
export function rememberFingerprint(
  remembered: readonly string[],
  fingerprint: string,
  max: number = MAX_REMEMBERED_FINGERPRINTS
): string[] {
  const next = remembered.filter((entry) => entry !== fingerprint);
  next.push(fingerprint);
  return next.slice(Math.max(0, next.length - max));
}

/** 取り込む先の候補（作品の登録ID と、その作品の投稿状態） */
export interface ReaderStatsWorkCandidate {
  id: string;
  ledger: PostingLedger;
}

/**
 * どの作品へ取り込むか。
 *
 * - `one`：1つに決まった（作者に選ばせない）
 * - `choose`：候補が複数ある（作者に選んでもらう。**推し量って決めない**）
 * - `none`：どの作品とも照合できない
 */
export type ReaderStatsWorkPick =
  | { readonly kind: "one"; readonly id: string }
  | { readonly kind: "choose"; readonly ids: readonly string[] }
  | { readonly kind: "none" };

/**
 * 作品を絞る（設計書6.79.7「ヘルパーからの受け口」）。**照合は取り込みと同じ関所**
 * （`matchReaderStatsEnvelope`）で、ここで緩めも締めもしない。
 *
 * 関所は「台帳に作品IDが無ければ通す」作りなので、カクヨムに載った作品が
 * 2つあると両方通ることがある。そこで**作品IDまで一致した作品**を先に見る
 * ——1つなら決まり。一致した作品が無ければ、関所を通った作品が1つのとき
 * だけ決める。**2つ以上なら作者に選んでもらう**（数字が別の作品に混ざると、
 * あとから分けられない）。
 */
export function pickReaderStatsWork(
  envelope: ReaderStatsEnvelope,
  candidates: readonly ReaderStatsWorkCandidate[]
): ReaderStatsWorkPick {
  const passed = candidates.filter(
    (candidate) => matchReaderStatsEnvelope(envelope, candidate.ledger) === null
  );
  const exact = passed.filter((candidate) =>
    workIdMatches(envelope, candidate.ledger)
  );
  if (exact.length === 1) return { kind: "one", id: exact[0].id };
  if (exact.length > 1) {
    return { kind: "choose", ids: exact.map((candidate) => candidate.id) };
  }
  if (passed.length === 1) return { kind: "one", id: passed[0].id };
  if (passed.length > 1) {
    return { kind: "choose", ids: passed.map((candidate) => candidate.id) };
  }
  return { kind: "none" };
}

/**
 * 作品IDまで一致したか。**出どころのある封筒（Narou.fun）は、関所を
 * 通った時点で一致している**（作品IDが無ければ関所が通さない）。
 */
function workIdMatches(
  envelope: ReaderStatsEnvelope,
  ledger: PostingLedger
): boolean {
  if (envelope.source !== undefined) return true;
  const known = siteProfile(ledger, envelope.site)?.workId?.trim();
  return Boolean(known && envelope.workId && known === envelope.workId);
}

/**
 * まとめて渡された読者の反応（束）の1件を、どの作品へ入れるか。
 *
 * - `work`：作品が決まった
 * - `none`：決まらない（取り込まずに理由を返す）
 */
export type ReaderStatsBundleRoute =
  | { readonly kind: "work"; readonly id: string }
  | {
      readonly kind: "none";
      readonly reason: string;
      /**
       * **作品IDを作品に登録すれば直る**か（作者の裁定 2026-10-11）。作品IDが届いていて、
       * それを登録した作品が1つも無いときだけ立つ。立っていれば、その場で登録する道を出す
       */
      readonly registrable?: true;
    };

/**
 * 束の1件の行き先を決める（作者の依頼 2026-09-23。ヘルパー 0.9.0 の「まとめて渡す」）。
 *
 * **1件のときより厳しい。台帳の作品IDで1つに決まるものだけを取り込む。**
 *
 * 1件の封筒（`pickReaderStatsWork`）は、作品IDが合わなくても関所を通った
 * 作品が1つならそこへ入れ、2つ以上なら作者に選ばせる。束ではどちらもしない：
 *
 *   - **束には複数の作品が混ざる。** ヘルパーは覚えた作品の画面をすべて溜めるので、
 *     統合小説執筆環境に登録していない作品や、カクヨムの登録が無い作品の画面も
 *     入りうる。「関所を通った作品が1つだから」で決めると、その画面の数が
 *     別の作品へ混ざる——いちど混ざると、あとから分けられない
 *   - **画面ごとに作品を選ばせると、まとめて渡した意味が無くなる**（10画面なら10回訊く）
 *
 * 照合そのものは取り込みと同じ関所（`matchReaderStatsEnvelope`）で、緩めない。
 * Narou.fun の封筒は関所を通った時点でNコードが一致している。
 */
export function routeReaderStatsBundleItem(
  envelope: ReaderStatsEnvelope,
  candidates: readonly ReaderStatsWorkCandidate[]
): ReaderStatsBundleRoute {
  const exact = candidates.filter(
    (candidate) =>
      matchReaderStatsEnvelope(envelope, candidate.ledger) === null &&
      workIdMatches(envelope, candidate.ledger)
  );
  if (exact.length === 1) return { kind: "work", id: exact[0].id };
  if (exact.length > 1) {
    return {
      kind: "none",
      reason: `この作品IDを登録した作品が${exact.length}つあり、どれに入れるか決められませんでした。`,
    };
  }
  if (!envelope.workId) {
    return {
      kind: "none",
      reason: "作品IDが入っていないため、どの作品のものか決められませんでした。",
    };
  }
  // その場で登録できるのは、自分の作品しか開けない管理画面から届いたもの（source が無い封筒）だけ。
  // Narou.fun などは他人の作品のページも開けるので、よその作品の番号を登録する道を開かない
  // （作者の裁定 2026-10-11「管理画面からのものだけ」）
  return envelope.source === undefined
    ? {
        kind: "none",
        reason: "この作品IDを登録した作品が見つかりませんでした。",
        registrable: true,
      }
    : { kind: "none", reason: "この作品IDを登録した作品が見つかりませんでした。" };
}

/**
 * 束の順位の1件の行き先を決める（2026-11-02。ヘルパー 0.19.0）。
 *
 * **読者の反応の画面と同じ関所を通す**——順位には封筒が無いので、サイト・出どころ・作品IDだけの
 * 封筒の形に包んで `routeReaderStatsBundleItem` へ渡す。照合に使うのはその3つだけで
 * （行の中身・日時は見ない）、写しの関所を置くと片方だけ緩む。
 */
export function routeReaderStatsRanking(
  ranking: ReaderStatsRanking,
  candidates: readonly ReaderStatsWorkCandidate[]
): ReaderStatsBundleRoute {
  return routeReaderStatsBundleItem(rankingAsEnvelope(ranking), candidates);
}

/** 照合のためだけの封筒の形（台帳へは書かない） */
function rankingAsEnvelope(ranking: ReaderStatsRanking): ReaderStatsEnvelope {
  return {
    "novelai-stats": READER_STATS_ENVELOPE_VERSION,
    site: ranking.site,
    ...(ranking.source !== undefined ? { source: ranking.source } : {}),
    workId: ranking.workId,
    readAt: ranking.readAt,
    ...(ranking.title !== undefined ? { title: ranking.title } : {}),
    entries: [],
  };
}

/** 取り込めなかった順位の1件を、作者が見分けられる名前で言う（記録に残す） */
export function readerStatsRankingLabel(ranking: ReaderStatsRanking): string {
  const site = postingSiteInfo(ranking.site).label;
  return (
    `${site} 作品ID ${ranking.workId}` +
    (ranking.title ? `「${ranking.title}」` : "") +
    `の${ranking.boardLabel}（${ranking.date}・${ranking.rank}位）`
  );
}

/**
 * 取り込めなかった1件を、作者が見分けられる名前で言う（「カクヨム 作品ID 1177…」）。
 * **作品名は言えない**——決まらなかったから取り込めなかったのである。
 */
export function readerStatsBundleItemLabel(envelope: ReaderStatsEnvelope): string {
  const site = postingSiteInfo(envelope.site).label;
  const source = readerStatsSourceLabel(envelope.source);
  return (
    site +
    (source ? `（${source}）` : "") +
    (envelope.workId ? ` 作品ID ${envelope.workId}` : "")
  );
}

/**
 * 窓に戻ったとき、束のうち**まだ取り込んでいない画面**が作品ごとに何画面あるか。
 *
 * 取り込めない画面（作品が決まらない）は数えない——1件のときに「照合できる
 * 作品が無ければ訊かない」のと同じで、窓を行き来するたびに断りを出さない。
 * 取り込み済みの見分けは1件のときと同じ（`readerStatsAlreadyImported`）。
 *
 * @returns 作品ごとの画面の数（束に最初に出てきた順）。空なら訊かない
 */
export function readerStatsBundlePending(
  bundle: ReaderStatsBundle,
  candidates: readonly ReaderStatsWorkCandidate[]
): { id: string; screens: number; ranks: number }[] {
  const pending = new Map<string, { screens: number; ranks: number }>();
  const entry = (id: string): { screens: number; ranks: number } => {
    const held = pending.get(id) ?? { screens: 0, ranks: 0 };
    pending.set(id, held);
    return held;
  };
  for (const item of bundle.items) {
    if (!item.result.ok) continue;
    const envelope = item.result.envelope;
    const route = routeReaderStatsBundleItem(envelope, candidates);
    if (route.kind !== "work") continue;
    const ledger = candidates.find((candidate) => candidate.id === route.id)?.ledger;
    if (!ledger || readerStatsAlreadyImported(envelope, ledger)) continue;
    entry(route.id).screens++;
  }
  /*
    順位（2026-11-02）。**順位だけの束も訊く**——画面の数だけ見ていると、items が空の束は
    「まだ取り込んでいないもの無し」で黙って捨てられる。台帳に同じ鍵が無い順位だけを数える
  */
  for (const item of bundle.rankings ?? []) {
    if (!item.result.ok) continue;
    const ranking = item.result.ranking;
    const route = routeReaderStatsRanking(ranking, candidates);
    if (route.kind !== "work") continue;
    const ledger = candidates.find((candidate) => candidate.id === route.id)?.ledger;
    if (!ledger || hasHelperRankingOn(ledger, rankingRecordFromHelper(ranking))) continue;
    entry(route.id).ranks++;
  }
  return [...pending].map(([id, counts]) => ({ id, ...counts }));
}

/** 束を取り込んだ結果のうち、1つの作品へ入った分 */
export interface ReaderStatsBundleWorkOutcome {
  readonly title: string;
  /** その作品へ入れた画面の数（全部が取り込み済みの数と同じだった画面も数える） */
  readonly screens: number;
  readonly added: number;
  readonly repeated: number;
  /** タグ・連載の状態を書き換えたか（2026-11-01。数が同じでも保存した印） */
  readonly factsChanged?: boolean;
  /** 積んだ順位の数（2026-11-02。束の rankings） */
  readonly ranks?: number;
  /** 同じ鍵がもうあって積まなかった順位の数 */
  readonly ranksRepeated?: number;
}

/** 束のうち、取り込めなかったもの */
export interface ReaderStatsBundleFailure {
  /** 何の画面か（`readerStatsBundleItemLabel`、読めなかったものは「3件目」） */
  readonly label: string;
  readonly reason: string;
  /**
   * 作品IDの登録で直るか。直るものが1つでもあれば、直し方を添える
   * （版の食い違いや保存の失敗は、作品IDを登録しても直らない）
   */
  readonly fixByWorkId: boolean;
}

export interface ReaderStatsBundleOutcome {
  readonly works: readonly ReaderStatsBundleWorkOutcome[];
  readonly failures: readonly ReaderStatsBundleFailure[];
  /**
   * 作者が「登録しない」と決めた作品IDの画面（`readerStatsBundleItemLabel`）。
   * 取り込めなかったものには数えず、ボタンも出さない（作者の裁定 2026-10-11）
   */
  readonly declined?: readonly string[];
  /**
   * `declined` の画面がどれも本人しか開けない画面で読んだもので、「未登録の自分の作品」の
   * 枠に載せたとき、その作品（作品名。無ければ「作品ID …」。2026-11-01）。断りの文を
   * 「次に何をすればよいか」の文に替える。1画面でも枠に載らないものが混じれば渡さない
   */
  readonly framed?: readonly string[];
  /** 知らせに［作品に登録する］を付けるか（直し方の文を変える） */
  readonly registerOffered?: boolean;
  /** 知らせの頭に置く1文（その場で登録したあとの取り込みで「登録しました」を添える） */
  readonly lead?: string;
  /** 束に読者の反応の画面が無く、順位だけだったか（取り込めなかったときの言い方を変える） */
  readonly rankingsOnly?: boolean;
  /**
   * 作品が決まらず、控えにも入れなかった順位の数（記録には全部を残す）。
   * 控えに入れた順位は数えない（登録したら取り込む）
   */
  readonly ranksUnrouted?: number;
  /** 未登録の自分の作品の順位として控えた数（登録したら取り込む） */
  readonly ranksHeld?: number;
}

/**
 * 順位が絡んだ取り込みの1文（2026-11-02）。「読者の反応 N画面と順位 M件を取り込みました」。
 * 画面の無い作品は順位だけ、順位の無い作品は画面だけを言う
 */
function rankedSummary(
  works: readonly ReaderStatsBundleWorkOutcome[],
  factsChanged: boolean
): string {
  const sum = (pick: (work: ReaderStatsBundleWorkOutcome) => number): number =>
    works.reduce((total, work) => total + pick(work), 0);
  const screens = sum((work) => work.screens);
  const added = sum((work) => work.added);
  const repeated = sum((work) => work.repeated);
  const ranks = sum((work) => work.ranks ?? 0);
  const ranksRepeated = sum((work) => work.ranksRepeated ?? 0);
  const perWork = works
    .map((work) => {
      const bits: string[] = [];
      if (work.screens > 0) bits.push(`${work.screens}画面`);
      if ((work.ranks ?? 0) + (work.ranksRepeated ?? 0) > 0) {
        bits.push(`順位${(work.ranks ?? 0) + (work.ranksRepeated ?? 0)}件`);
      }
      return `「${work.title}」${bits.join("・")}`;
    })
    .join("・");
  const subject = [screens > 0 ? "読者の反応" : "", "順位"].filter(Boolean).join("と");
  if (added === 0 && ranks === 0) {
    return (
      `${subject}は、すでに取り込んだものと同じでした：${perWork}（${repeated + ranksRepeated}件）。` +
      (factsChanged ? "タグ・連載の状態の変化を記録しました。" : "記録は変えていません。")
    );
  }
  const counted =
    (screens > 0 ? `読者の反応 ${screens}画面と` : "") + `順位 ${ranks}件を取り込みました`;
  const skipped = repeated + ranksRepeated;
  return (
    `${counted}：${perWork}` +
    (skipped > 0 ? `（すでに取り込んだもので積まなかったもの ${skipped}件）` : "") +
    (factsChanged ? "（タグ・連載の状態も記録しました）" : "") +
    "。"
  );
}

/** 知らせに並べる「取り込めなかったもの」の数。**残りは件数で言い、全部は記録に残す** */
export const BUNDLE_FAILURES_SHOWN = 3;

/**
 * 束を取り込んだ結果を、**1つの知らせ**にする。
 *
 * 画面ごとに知らせを出すと、10画面で10個の通知が重なる。作品ごとの画面の数・
 * 積まなかった数・取り込めなかったもの（と直し方）を1つにまとめる。
 * **取り込めなかったものがあれば注意**の知らせにする（見落とされないように）。
 */
export function readerStatsBundleNotice(outcome: ReaderStatsBundleOutcome): {
  level: "info" | "warning";
  message: string;
} {
  const added = outcome.works.reduce((sum, work) => sum + work.added, 0);
  const repeated = outcome.works.reduce((sum, work) => sum + work.repeated, 0);
  const factsChanged = outcome.works.some((work) => work.factsChanged === true);
  const perWork = outcome.works
    .map((work) => `「${work.title}」${work.screens}画面`)
    .join("・");
  // 順位が絡むとき（2026-11-02）だけ言い方を変える。絡まなければこれまでの文のまま
  const involvesRanks = outcome.works.some(
    (work) => (work.ranks ?? 0) + (work.ranksRepeated ?? 0) > 0
  );
  const ranksAdded = outcome.works.reduce((sum, work) => sum + (work.ranks ?? 0), 0);

  const declined = outcome.declined ?? [];
  const framed = outcome.framed ?? [];
  const parts: string[] = outcome.lead ? [outcome.lead] : [];
  if (
    outcome.works.length === 0 &&
    outcome.failures.length === 0 &&
    declined.length > 0 &&
    framed.length > 0
  ) {
    /*
      **登録しないと決めた作品IDの分だけで、どれも枠に載せた**（2026-11-01）。
      管理画面で読んだ自分の作品なので、断りではなく次の一手を言う。数は控えてあり、
      登録したら取り込む（`core/ownWorkPendingStats.ts`）
    */
    parts.push(ownWorkFramedNotice(framed));
    return { level: "info", message: parts.join("") };
  }
  if (outcome.works.length === 0 && outcome.failures.length === 0 && declined.length > 0) {
    /*
      **登録しないと決めた作品IDの分だけだった。** 押したのに何も起きない、に
      しないよう1文で言う（ボタンは出さない）。取り消し方もここで言う——
      ほかに覚えを外す画面を持たない
    */
    parts.push(
      "読者の反応を取り込みませんでした。届いたのは、登録しないことにした作品ID" +
        `（${declined.slice(0, BUNDLE_FAILURES_SHOWN).join(" ／ ")}）の分だけでした。` +
        DECLINED_UNDO_HINT
    );
    return { level: "info", message: parts.join("") };
  }
  if (outcome.works.length === 0) {
    // 順位だけの束（2026-11-02）なら「読者の反応」と言わない
    if (!outcome.rankingsOnly) {
      parts.push("読者の反応を取り込めませんでした。");
    } else if ((outcome.ranksHeld ?? 0) === 0 || outcome.failures.length > 0) {
      // 控えただけなら断りの文にしない（下で「控えました」と言う）
      parts.push("順位を取り込めませんでした。");
    }
  } else if (involvesRanks) {
    parts.push(rankedSummary(outcome.works, factsChanged));
  } else if (added === 0 && !factsChanged) {
    // 何も書いていない（保存もしていない）。押したのに何も起きない、にならないよう理由を言う
    parts.push(
      `読者の反応は、すでに取り込んだ数と同じでした：${perWork}（${repeated}件）。記録は変えていません。`
    );
  } else if (added === 0) {
    // 数は同じで、タグか連載の状態だけが変わった（2026-11-01。黙って書き換えない）
    parts.push(
      `読者の反応は、すでに取り込んだ数と同じでした：${perWork}（${repeated}件）。` +
        "タグ・連載の状態の変化を記録しました。"
    );
  } else {
    parts.push(
      `読者の反応を取り込みました：${perWork}` +
        (repeated > 0 ? `（同じ数で積まなかったもの ${repeated}件）` : "") +
        (factsChanged ? "（タグ・連載の状態も記録しました）" : "") +
        "。"
    );
  }

  if (outcome.failures.length > 0) {
    const shown = outcome.failures
      .slice(0, BUNDLE_FAILURES_SHOWN)
      .map((failure) => `${failure.label}：${failure.reason}`);
    const rest = outcome.failures.length - shown.length;
    parts.push(
      `取り込めなかったもの（${outcome.failures.length}画面）：${shown.join(" ／ ")}` +
        (rest > 0 ? ` ／ ほか${rest}画面（出力パネルに記録しました）` : "")
    );
    if (outcome.registerOffered) {
      parts.push(
        "［作品に登録する］で作品を選ぶと、その場で登録して取り込みます" +
          "（「投稿サイト設定」で作品IDを登録してから、ヘルパーの「もう一度渡す」で渡し直しても取り込めます）。"
      );
    } else if (outcome.failures.some((failure) => failure.fixByWorkId)) {
      parts.push(
        "取り込みたい作品の「投稿サイト設定」で作品IDを登録してから、" +
          "ヘルパーの「もう一度渡す」で渡し直すと取り込めます（取り込み済みの数は二重に積みません）。"
      );
    }
  }
  if (declined.length > 0) {
    parts.push(`登録しないことにした作品IDの分（${declined.length}画面）は取り込んでいません。`);
  }
  if ((outcome.ranksHeld ?? 0) > 0) {
    parts.push(
      `作品一覧の「未登録の自分の作品」の順位（${outcome.ranksHeld}件）は控えました（作品を登録したら取り込みます）。`
    );
  }
  if ((outcome.ranksUnrouted ?? 0) > 0) {
    parts.push(
      `どの作品のものか決まらなかった順位（${outcome.ranksUnrouted}件）は取り込んでいません（出力パネルに記録しました）。`
    );
  }
  if (added > 0 || ranksAdded > 0) {
    parts.push(`${READER_SITE_TABS_HINT}で履歴を見られます。`);
  }
  return {
    level: outcome.failures.length > 0 ? "warning" : "info",
    message: parts.join(""),
  };
}

/**
 * 「未登録の自分の作品」の枠に載せたことを言う1文（2026-11-01）。
 * 作者が次にすること（［バックアップを取る］）と、そのあと起きること（自動で登録し、
 * 控えた読者の反応も取り込む）を言う。束の知らせとヘルパーからの1件の知らせで同じ言い方にする
 */
export function ownWorkFramedNotice(labels: readonly string[]): string {
  const shown = labels.slice(0, BUNDLE_FAILURES_SHOWN).map((label) => `「${label}」`).join("");
  const rest = labels.length - Math.min(labels.length, BUNDLE_FAILURES_SHOWN);
  return (
    `${shown}${rest > 0 ? `ほか${rest}作品` : ""}を作品一覧の「未登録の自分の作品」に載せました。` +
    // ブラウザ版では［バックアップを取る］を隠している（ダウンロードのフォルダーを見られない）
    (canRunProcesses()
      ? "右クリックの［バックアップを取る］でバックアップを落とすと、自動で登録します"
      : "サイトから落としたバックアップを、右クリックの［ファイルから取り込む］で選ぶと登録します") +
    "（読者の反応も控えてあり、登録したら取り込みます）。"
  );
}

/**
 * このデータは、もうこの作品へ取り込んであるか。
 *
 * **取り込みと同じ見分け**（`repeatsReaderStats`）を、同じ組み方の記録
 * （`readerStatsRecordsFromEnvelope`）へ当てる。1行でも新しければ false
 * ——取り込めば1行でも増えるので、訊く値打ちがある。
 */
export function readerStatsAlreadyImported(
  envelope: ReaderStatsEnvelope,
  ledger: PostingLedger
): boolean {
  return (
    readerStatsRecordsFromEnvelope(envelope).every((record) =>
      repeatsReaderStats(ledger, record)
    ) &&
    // 数が同じでもタグや連載の状態が変わっていれば、取り込めば台帳が変わる（2026-11-01）
    !readerStatsFactsWouldChange(ledger, envelope)
  );
}

/**
 * 「登録しない」の覚えを取り消す道（作者の裁定 2026-10-11「取り消す道も1つ用意する」）。
 * 知らせと選ぶ画面の両方で同じ言い方をする
 */
export const DECLINED_UNDO_HINT =
  "登録したくなったら、「読者反応自動取込」で同じデータを取り込むと、また選べます。";

/**
 * 「登録しない」と決めた作品IDを覚えるときの鍵（サイトごとにIDの形が違うので、サイトを前に付ける）。
 * Nコードは大文字・小文字を問わないので小文字にそろえる
 */
export function readerStatsDeclineKey(site: PostingSiteId, workId: string): string {
  const id = workId.trim();
  return `${site}:${site === "narou" ? id.toLowerCase() : id}`;
}

/**
 * 届いた作品IDの、読者が見る作品ページのURL。選ぶ画面で「どの作品か」を確かめる手がかり。
 * 形を確かめられるサイト（カクヨム・なろう）だけ組み、ほかは undefined（IDだけを出す）
 */
export function readerStatsWorkPageUrl(
  site: PostingSiteId,
  workId: string
): string | undefined {
  const id = workId.trim();
  if (site === "kakuyomu") {
    return /^\d+$/u.test(id) ? `https://kakuyomu.jp/works/${id}` : undefined;
  }
  if (site === "narou") {
    const ncode = narouNcode(id);
    return ncode ? `https://ncode.syosetu.com/${ncode}/` : undefined;
  }
  return undefined;
}

/** 作品名を比べるときの形（全角・半角、大小、空白・かっこ・記号の違いを無視する） */
function titleKey(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * 届いた作品名に近い作品（作者の裁定 2026-10-11「タイトルが同じとは限らないので、入力も必要」）。
 *
 * **おすすめにするだけで、選んだことにはしない。** サイトの作品名と書庫の作品名は
 * 違うことがあり（副題・略称）、近いからといって同じ作品とは限らない。
 * 一致するか、どちらかがもう一方を含む（2文字以上）ものだけを近いと見る。
 *
 * @returns 近い作品の id（並びは渡した順）。作品名が無ければ空
 */
export function suggestWorksByTitle(
  works: readonly { id: string; title: string }[],
  title: string | undefined
): string[] {
  const wanted = titleKey(title ?? "");
  if (wanted.length < 2) return [];
  return works
    .filter((work) => {
      const key = titleKey(work.title);
      if (key.length < 2) return false;
      return key === wanted || key.includes(wanted) || wanted.includes(key);
    })
    .map((work) => work.id);
}

/**
 * 選んだ作品へ作品IDを登録するとき、何が起きるか。
 *
 * - `add`：そのサイトの作品IDがまだ無い（そのまま登録する）
 * - `same`：もう同じIDが入っている（書かない）
 * - `replace`：**別のIDが入っている。確かめずに上書きしない**（作者の書いた値）
 */
export type ReaderStatsSiteIdPlan =
  | { readonly kind: "add" }
  | { readonly kind: "same" }
  | { readonly kind: "replace"; readonly existing: string };

export function planReaderStatsSiteId(
  ledger: PostingLedger,
  site: PostingSiteId,
  workId: string
): ReaderStatsSiteIdPlan {
  const existing = siteProfile(ledger, site)?.workId?.trim();
  if (!existing) return { kind: "add" };
  if (readerStatsDeclineKey(site, existing) === readerStatsDeclineKey(site, workId)) {
    return { kind: "same" };
  }
  return { kind: "replace", existing };
}

/** 新話投稿の先にするための案内（組み立てられないサイトの登録の知らせに添える） */
export const POSTING_SITE_URL_HINT =
  "新話投稿の先にするには『投稿サイト設定』で投稿ページのURLを入れてください。";

/**
 * 作品IDを登録したとき、投稿先（`sites[]`）をどうするか（作者の依頼 2026-10-12
 * 「投稿先へは自動登録してください」）。
 *
 * - `add`：投稿先に無いので足す（投稿ページのURLは作品IDから組み立てた）
 * - `unbuildable`：投稿先に無いが、投稿ページのURLを作品IDから組み立てられない
 *   サイト（なろう・note。アルファポリスは9桁の作品IDでなければ）。足さずに `POSTING_SITE_URL_HINT` を添える
 * - `none`：何もしない
 *
 * ## 足さないとき
 *
 * - **作品IDが前から同じ（`same`）なら足さない。** 作者が投稿先から外したサイトを、
 *   読者の反応を取り込むたびに戻さないため（作者の判断を上書きしない。実装ルール2）
 * - **既に投稿先にあれば触らない。** 投稿ページのURLは作者が自分の画面から貼った値で、
 *   組み立てた値より確か
 */
export type ReaderStatsPostingSitePlan =
  | { readonly kind: "add"; readonly entry: PostingSiteEntry }
  | { readonly kind: "unbuildable" }
  | { readonly kind: "none" };

export function planReaderStatsPostingSite(
  ledger: PostingLedger,
  site: PostingSiteId,
  workId: string,
  idPlan: ReaderStatsSiteIdPlan
): ReaderStatsPostingSitePlan {
  if (idPlan.kind === "same") return { kind: "none" };
  if (ledger.sites.some((entry) => entry.site === site)) return { kind: "none" };
  const url = newEpisodeUrlFromWorkId(site, workId);
  // 組み立てた値も、作者が貼るときと同じ検査を通す（ドメイン違い・空を台帳へ入れない）
  if (!url || validateNewEpisodeUrl(site, url) !== null) return { kind: "unbuildable" };
  return { kind: "add", entry: { site, newEpisodeUrl: url } };
}
