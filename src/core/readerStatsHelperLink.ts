import {
  postingSiteInfo,
  repeatsReaderStats,
  siteProfile,
  type PostingLedger,
} from "../models/posting";
import { hashText } from "./hash";
import { SETUP_URI_PATH } from "./setupRequest";
import {
  matchReaderStatsEnvelope,
  readerStatsRecordsFromEnvelope,
  readerStatsSourceLabel,
  type ReaderStatsBundle,
  type ReaderStatsEnvelope,
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
 * 作者が「読者の反応を貼り付けて取り込む」を押したときと同じ関所を通る。
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

/** URI のパスが何の合図か。知らないパスは undefined（何もしない） */
export function readerStatsUriAction(
  uriPath: string
): "import" | "contests" | "setup" | undefined {
  // 末尾の `/` だけは許す（ブラウザやOSが付け足すことがある）。
  // 大文字小文字は区別する——約束は1つの綴りで、似た綴りを拾う理由が無い
  const trimmed = uriPath.replace(/\/+$/u, "");
  if (trimmed === READER_STATS_IMPORT_URI_PATH) return "import";
  if (trimmed === CONTESTS_IMPORT_URI_PATH) return "contests";
  /*
    **Claude Code からのセットアップの依頼**（設計書6.87.18）。受け口は1つしか
    持てないので同じ口で見分ける。**クエリを読むのはこのパスだけ**で、
    白名簿で確かめてから（`core/setupRequest.ts`）、作者の確認を経て呼ぶ。
  */
  if (trimmed === SETUP_URI_PATH) return "setup";
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
  | { readonly kind: "none"; readonly reason: string };

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
  return { kind: "none", reason: "この作品IDを登録した作品が見つかりませんでした。" };
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
): { id: string; screens: number }[] {
  const pending = new Map<string, number>();
  for (const item of bundle.items) {
    if (!item.result.ok) continue;
    const envelope = item.result.envelope;
    const route = routeReaderStatsBundleItem(envelope, candidates);
    if (route.kind !== "work") continue;
    const ledger = candidates.find((candidate) => candidate.id === route.id)?.ledger;
    if (!ledger || readerStatsAlreadyImported(envelope, ledger)) continue;
    pending.set(route.id, (pending.get(route.id) ?? 0) + 1);
  }
  return [...pending].map(([id, screens]) => ({ id, screens }));
}

/** 束を取り込んだ結果のうち、1つの作品へ入った分 */
export interface ReaderStatsBundleWorkOutcome {
  readonly title: string;
  /** その作品へ入れた画面の数（全部が取り込み済みの数と同じだった画面も数える） */
  readonly screens: number;
  readonly added: number;
  readonly repeated: number;
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
  const perWork = outcome.works
    .map((work) => `「${work.title}」${work.screens}画面`)
    .join("・");

  const parts: string[] = [];
  if (outcome.works.length === 0) {
    parts.push("読者の反応を取り込めませんでした。");
  } else if (added === 0) {
    // 何も書いていない（保存もしていない）。押したのに何も起きない、にならないよう理由を言う
    parts.push(
      `読者の反応は、すでに取り込んだ数と同じでした：${perWork}（${repeated}件）。記録は変えていません。`
    );
  } else {
    parts.push(
      `読者の反応を取り込みました：${perWork}` +
        (repeated > 0 ? `（同じ数で積まなかったもの ${repeated}件）` : "") +
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
    if (outcome.failures.some((failure) => failure.fixByWorkId)) {
      parts.push(
        "取り込みたい作品の「投稿サイト設定」で作品IDを登録してから、" +
          "ヘルパーの「もう一度渡す」で渡し直すと取り込めます（取り込み済みの数は二重に積みません）。"
      );
    }
  }
  if (added > 0) {
    parts.push("執筆量パネルの「サイトの記録」で履歴を見られます。");
  }
  return {
    level: outcome.failures.length > 0 ? "warning" : "info",
    message: parts.join(""),
  };
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
  return readerStatsRecordsFromEnvelope(envelope).every((record) =>
    repeatsReaderStats(ledger, record)
  );
}
