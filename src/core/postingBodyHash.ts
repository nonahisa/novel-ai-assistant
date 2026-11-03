import { parseCollectedFile } from "./collectedFile";
import { extractEpisodeParts } from "./episodeCopy";
import { isCollectedFile } from "./episodeLabel";
import { hashText } from "./hash";
import { toLf } from "./eolSpace";
import { stripMemoLines } from "./sceneMemo";
import { TITLED_TEXT_HASH_PREFIX, type PostingTextHashes } from "../models/posting";

/**
 * 投稿したときの本文の印（設計書6.68.7。作者の裁定 2026-11-03 昼「出し直しが要る話を示す」）。
 *
 * 台帳の投稿・出し直しの記録に持たせ、今の本文の印と比べて「投稿のあとに直した話」を見つける。
 * 比べる関数（`revisionNeed`）は `models/posting.ts` にあり、ここは印を取るだけ。
 *
 * ## 何を同じ本文とみなすか
 *
 * **読者が読む本文が変わらない編集では、印も変えない。** 変えると、直していない話にまで
 * 「出し直しますか」と出て、促しが当てにならなくなる。投稿用の変換（`convertForPosting`）が
 * 落とすもの・揃えるものを、ここでも同じ考えで落とす：
 *
 * - **改行コード（CRLF／LF）**：投稿欄へ貼ると区別が消える。Git の設定で別の機械では
 *   CRLF になることもあり、それだけで「直した」としない（`eolSpace.ts` の `toLf`）
 * - **シーンメモの行**：投稿用の変換が落とす行（`stripMemoLines`。設計書6.40.2）
 * - **行末の空白（半角・全角・タブ）**：画面に見えず、作者が意図して打つものではない。
 *   **行頭の全角空白は残す**——字下げで、読者に見える
 * - **前後の空行**：1話まるごとを貼るときは落とす（`convertForPosting` の `trimEdges` と同じ）
 *
 * **サイトごとの記法の変換は通さない。** ルビの書き方はサイトで違うが、印はサイトに依らない値に
 * する——同じ話を4サイトへ出したとき、どのサイトの記録とも同じ物差しで比べられるように。
 * 変換の作りを直す（版を上げる）たびに全話が「直した」になることも避けられる。
 *
 * **話の題（サブタイトル）も印に入れる**（0.124.1。`postingTextHash`）。題も投稿欄へ貼るので、
 * 題だけ直した話も出し直しを促す。0.124.0 の印は本文だけ（`postingBodyHash`）。
 *
 * VS Code API に依存しない（ブラウザ版でも同じ値になる。`hash.ts` は自前の SHA-256）。
 */
export function normalizePostingBody(body: string): string {
  return stripMemoLines(toLf(body).replace(/^\uFEFF/, ""))
    .split("\n")
    .map((line) => line.replace(/[ \t\u3000]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * 本文だけの印（`normalizePostingBody` を通した本文の SHA-256。16進64字）。
 *
 * **0.124.0 の記録に残っている取り方。** いま記録に残すのは題も含めた `postingTextHash` で、
 * こちらは古い記録と比べるときだけ使う（`models/posting.ts` の `revisionNeed`）。
 */
export function postingBodyHash(body: string): string {
  return hashText(normalizePostingBody(body));
}

/**
 * 話の題を、印を取る前に整える。前後の空白（全角を含む）だけを落とす。
 * 題が無い話（`null`）と空の題は同じに扱う——どちらも投稿欄には何も入らない。
 */
function normalizePostingSubtitle(subtitle: string | null | undefined): string {
  return (subtitle ?? "").trim();
}

/**
 * 題と本文の両方の印（0.124.1。作者の答え 2026-11-03 昼「題だけ直した話も出し直しを促す」）。
 *
 * 投稿欄には題も貼るので、題だけ直した話も「直した」に数える。題と本文の間に `\u0000`
 * （題にも本文にも現れない字）を挟み、「題の末尾を本文の頭へ移した」直しも別の印にする。
 * 頭に `v2:`（`TITLED_TEXT_HASH_PREFIX`）を付け、0.124.0 の本文だけの印と見分ける。
 */
export function postingTextHash(subtitle: string | null | undefined, body: string): string {
  return (
    TITLED_TEXT_HASH_PREFIX +
    hashText(`${normalizePostingSubtitle(subtitle)}\u0000${normalizePostingBody(body)}`)
  );
}

/** 今の話の印を、古い記録とも比べられる形で作る（`revisionNeed` へ渡す） */
export function postingTextHashes(
  subtitle: string | null | undefined,
  body: string
): PostingTextHashes {
  return { titled: postingTextHash(subtitle, body), bodyOnly: postingBodyHash(body) };
}

/** 1つのファイルから投稿する単位（ふつうの話は1つ、合本は話の数だけ） */
export interface PostingUnit {
  subtitle: string | null;
  body: string;
  /** 合本の中の1話の指し方。ふつうの話には入らない（＝ファイルまるごと） */
  collected?: { chapter: number | null; order: number };
}

/**
 * ファイルの本文を、投稿する単位に分ける（6.68.7）。
 *
 * **投稿の道（`postingKit.ts` の `readEpisode`）と出し直しの判定の道が、同じ切り出しを
 * 通すための口。** 片方だけ切り出し方が変わると、投稿したときの印と今の印が別の範囲を
 * 指し、直していない話まで「直した」になる。合本の1話は、その話の本文だけで印を取る。
 *
 * @returns 合本なら話の数だけ、そうでなければ1つ（`collected` なし）
 */
export function postingUnitsOf(
  rawText: string,
  fileNameSubtitle: string | null
): { units: PostingUnit[]; collected: boolean } {
  const parts = extractEpisodeParts(rawText, fileNameSubtitle);
  const episodes = parseCollectedFile(rawText);
  // 1話ぶんに区切り行が付いているだけのファイルは合本ではない（`pickCollectedEpisode` と同じ門）
  if (!episodes || !isCollectedFile(episodes.length)) {
    return { units: [parts], collected: false };
  }
  return {
    units: episodes.map((episode) => ({
      subtitle: episode.title ?? parts.subtitle,
      body: episode.body,
      collected: { chapter: episode.chapter, order: episode.order },
    })),
    collected: true,
  };
}
