import {
  POSTING_SITES,
  postingSiteInfo,
  rankingsForSite,
  siteProfile,
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
}

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
    // 出すのは「作品情報がある」か「順位がある」ときだけ。登録しただけの
    // サイトは、まだ見せるものが無い（空の行を増やさない）
    if (!profile && history.length === 0) continue;

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
  return ncode ? `https://db.narou.fun/works/${ncode}` : undefined;
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
