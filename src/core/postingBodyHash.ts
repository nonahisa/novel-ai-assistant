import { parseCollectedFile } from "./collectedFile";
import { extractEpisodeParts } from "./episodeCopy";
import { isCollectedFile } from "./episodeLabel";
import { hashText } from "./hash";
import { toLf } from "./eolSpace";
import { fromSiteNotation, toSiteNotation } from "./ruby";
import { stripMemoLines } from "./sceneMemo";
import {
  NOTATION_TEXT_HASH_PREFIX,
  TITLED_TEXT_HASH_PREFIX,
  type PostingTextHashes,
} from "../models/posting";

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
 * **ただし、ルビ・傍点の書き方の違いは同じ本文とみなす**（0.127.0。`v3:` の印。
 * `postingNotationTextHash`）。本文の .md 化（設計書6.12.4）は `｜漢字《かんじ》` を `{漢字|かんじ}` へ
 * 直すので本文のバイトが変わるが、読者が読む本文は変わらない。印を取る前に、どの書き方も
 * この拡張機能の書き方（`{漢字|かんじ}`・`{{強調}}`）へ寄せる——投稿用の変換と逆向きに、
 * 1つの形へ集める。**寄せ方は .md 化の取り込み（`ruby.ts` の `fromSiteNotation`）と同じ規則を
 * 使う。** 別の規則で寄せると、.md 化で変わった所を印が拾い損ねる。**`fromSiteNotation` の
 * 規則を変えたら、印の版（頭の `v3:`）も上げる**——上げないと、直していない話まで「直した」になる。
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

/**
 * 題（サブタイトル）だけの印（0.125.2。作者の裁定 2026-11-03 夜「題を直した話の出し直しでは、
 * 題の貼り替えも案内する」）。整えた題の SHA-256（16進64字。頭に何も付けない）。
 *
 * **題と本文の印（`postingTextHash`）とは別に取る。** あちらは題と本文を繋いだ1つの値なので、
 * 違っても「題か本文のどちらかを直した」までしか分からない。題の整え方は同じ
 * （`normalizePostingSubtitle`。題が無い話と空の題は同じ印）。
 */
export function postingTitleHash(subtitle: string | null | undefined): string {
  return hashText(normalizePostingSubtitle(subtitle));
}

/** 上限。崩れた記法で寄せ終わらないときに回り続けない（ふつうは1回で変わらなくなる） */
const NOTATION_ROUNDS = 4;

/**
 * ルビ・傍点の書き方を、この拡張機能の書き方へ寄せる（`v3:` の印のため。0.127.0）。
 *
 * **変わらなくなるまで繰り返す。** .md 化は本文に1度だけ `fromSiteNotation` をかけるので、
 * 「変換前の本文を寄せたもの」と「変換後の本文を寄せたもの」が同じになるには、寄せた結果を
 * もう1度寄せても変わらない必要がある。ふつうの本文は1回で変わらなくなるが、崩れた記法
 * （閉じていない《》の並びなど）は1回目の置き換えで新しい記法の形が現れうる。
 */
export function canonicalPostingNotation(text: string): string {
  let current = text;
  for (let round = 0; round < NOTATION_ROUNDS; round++) {
    const next = fromSiteNotation(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * 題と本文の両方の印で、ルビ・傍点の書き方の違いを同じとみなすもの（0.127.0。記録にはこれを残す）。
 *
 * 本文の .md 化（設計書6.12.4）で書き方が変わっただけの話を、「投稿のあとに直した」と
 * 言わないため。題（中の【タイトル】）も .md 化で書き方が変わるので、同じく寄せる。
 * 頭に `v3:`（`NOTATION_TEXT_HASH_PREFIX`）を付け、0.124.1〜0.126.3 の印（`v2:`）と見分ける。
 */
export function postingNotationTextHash(
  subtitle: string | null | undefined,
  body: string
): string {
  const title = normalizePostingSubtitle(canonicalPostingNotation(subtitle ?? ""));
  const text = canonicalPostingNotation(normalizePostingBody(body));
  return NOTATION_TEXT_HASH_PREFIX + hashText(`${title}\u0000${text}`);
}

/**
 * 今の話を、投稿サイトの書き方へ戻した写し（古い印と比べるときだけ使う。0.127.0）。
 *
 * **0.126.3 までの印（`v2:`・無印）は、書き方の違いも「直した」に数える取り方で残っている。**
 * 記録を書き換えずに、.md 化しただけの話を「直した」と言わないため、今の本文を
 * `｜漢字《かんじ》` の形へ戻した写しでも、古い取り方の印を取って比べる。傍点は2通り
 * （カクヨムの `《《強調》》`・なろうのルビでの代用 `｜強調《・・》`）。
 *
 * **写しの印が一致すれば、投稿した本文はその写しそのもの**（書き方の違いしか無い）と分かるので、
 * 偽の「同じ」は出ない。縦線を省いた `漢字《かんじ》` やアルファポリスの `#漢字__かんじ__#` で
 * 書いてあった話は写しで戻せず、これまでどおり「直した」に数える（出し直せば `v3:` の印になる）。
 */
function siteNotationCopies(text: string): string[] {
  return [toSiteNotation(text, "site", "kakuyomu"), toSiteNotation(text, "site", "narou")];
}

/** 異なる値だけを残す（写しが元と同じなら、比べる値を増やさない） */
function distinctExcept(values: string[], except: string): string[] {
  return [...new Set(values)].filter((value) => value !== except);
}

/**
 * 今の題の印の候補（`titleChangedSinceSent` へ渡す。0.127.0）。
 *
 * 題だけの印（`postingTitleHash`）は版を持たない（頭に何も付かない形で記録してある）ので、
 * 取り方は変えない。.md 化で題のルビの書き方が変わっただけのときに「題も貼り替えて」と
 * 添えないよう、投稿サイトの書き方へ戻した写しの印も候補に入れる（本文と同じ考え）。
 */
export function postingTitleHashCandidates(subtitle: string | null | undefined): string[] {
  const raw = postingTitleHash(subtitle);
  const copies = siteNotationCopies(subtitle ?? "").map((copy) => postingTitleHash(copy));
  return [raw, ...distinctExcept(copies, raw)];
}

/** 今の話の印を、古い記録とも比べられる形で作る（`revisionNeed` へ渡す） */
export function postingTextHashes(
  subtitle: string | null | undefined,
  body: string
): PostingTextHashes {
  const titled = postingTextHash(subtitle, body);
  const bodyOnly = postingBodyHash(body);
  const subtitleCopies = siteNotationCopies(subtitle ?? "");
  const bodyCopies = siteNotationCopies(body);
  return {
    notation: postingNotationTextHash(subtitle, body),
    titled,
    bodyOnly,
    titledCopies: distinctExcept(
      bodyCopies.map((copy, index) => postingTextHash(subtitleCopies[index], copy)),
      titled
    ),
    bodyOnlyCopies: distinctExcept(
      bodyCopies.map((copy) => postingBodyHash(copy)),
      bodyOnly
    ),
  };
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
