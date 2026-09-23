import {
  repeatsReaderStats,
  siteProfile,
  type PostingLedger,
} from "../models/posting";
import { hashText } from "./hash";
import {
  matchReaderStatsEnvelope,
  readerStatsRecordsFromEnvelope,
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
 *
 * VS Code API には依存しない。
 */

/** 取り込みの合図のパス（ヘルパーとの約束） */
export const READER_STATS_IMPORT_URI_PATH = "/import-reader-stats";

/** URI のパスが何の合図か。知らないパスは undefined（何もしない） */
export function readerStatsUriAction(uriPath: string): "import" | undefined {
  // 末尾の `/` だけは許す（ブラウザやOSが付け足すことがある）。
  // 大文字小文字は区別する——約束は1つの綴りで、似た綴りを拾う理由が無い
  const trimmed = uriPath.replace(/\/+$/u, "");
  return trimmed === READER_STATS_IMPORT_URI_PATH ? "import" : undefined;
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
