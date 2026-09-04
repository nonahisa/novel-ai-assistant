import {
  POSTING_SITES,
  postingSiteInfo,
  rankingsForSite,
  type PostingLedger,
  type PostingRankingRecord,
  type PostingSiteId,
} from "../models/posting";

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
  latest: PostingRankingRow | null;
  /** 新しい順 */
  history: PostingRankingRow[];
}

/**
 * サイトごとの記録を組み立てる。
 *
 * **見せるものが無いサイトは並べない。** 投稿ページのURLを登録しただけの
 * サイトは、ここに出しても空の行が増えるだけである（作品情報も順位も
 * 1つも無ければ、呼ぶ側は節ごと出さない）。
 */
export function buildPostingSiteRecords(
  ledger: PostingLedger
): PostingSiteRecord[] {
  const records: PostingSiteRecord[] = [];

  // 並びは `POSTING_SITES` に揃える（画面ごとに順番が変わらないように）
  for (const info of POSTING_SITES) {
    const entry = ledger.sites.find((site) => site.site === info.id);
    const profile = entry?.profile;
    const history = rankingsForSite(ledger, info.id).map(toRow);
    const hasProfile = Boolean(
      profile?.workId || profile?.workUrl || profile?.genre || profile?.note
    );
    if (!hasProfile && history.length === 0) continue;

    records.push({
      site: info.id,
      label: postingSiteInfo(info.id).label,
      workId: profile?.workId ?? null,
      workUrl: profile?.workUrl ?? null,
      genre: profile?.genre ?? null,
      note: profile?.note ?? null,
      registered: Boolean(entry),
      latest: history[0] ?? null,
      history,
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
