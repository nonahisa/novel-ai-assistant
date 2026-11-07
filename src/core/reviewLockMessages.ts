import { MENU_SECTION_NAMES } from "./menuPath";
import { editorStepLabel } from "./stepDefs";

/**
 * 校閲中（校閲のロック）の知らせの文（作者の裁定 2026-11-07 未明。文はこのとおりに）。
 *
 * **「押さえる」と言わない。** 作者に通じなかったので「校閲中」で言う。
 * 見張りは `test/unit/cross/reviewLockWording.test.ts`。
 *
 * **作者へ届ける手順は、編集者メニューの名前で名指す。** 名前は定義
 * （`EDITOR_STEP_DEFS`）と区画の名前（`MENU_SECTION_NAMES`）から組むので、
 * 手順の名前や番号を変えても文がついてくる。
 *
 * VS Code に依らない（単体テストで文をそのまま確かめる）。
 */

/** 「編集者メニューの「6. 校閲を終えて作者へ返す」」 */
function returnStepPlace(): string {
  return `${MENU_SECTION_NAMES.editorMenu}の「${editorStepLabel("return")}」`;
}

/** 範囲を決めたときの知らせ。見出し（下の帯）と、続き（右下の知らせ） */
export interface ReviewRangeStartedMessage {
  readonly headline: string;
  readonly note: string;
}

/**
 * 編集者が校閲する範囲を決めたとき。
 *
 * **2つに分けて返す。** 下の帯（`notifyDone`）は1行しか見えず、右に別の項目が並ぶので
 * 長い文は切れる（2026-09-16 の作者の実機報告）。いちばん伝えたい「6. を押すと届く」が
 * 切れないよう、続きは右下の知らせへ回す。つなげると裁定の文そのものになる
 */
export function reviewRangeStartedMessage(range: string): ReviewRangeStartedMessage {
  return {
    headline: `${range}を校閲中にしました。`,
    note: `直し終えたら、${returnStepPlace()}を押すと、提案が作者へ届きます。`,
  };
}

/** 範囲を作者へすぐ知らせられなかったとき（送るのに失敗した。校閲は始められている） */
export function reviewRangeNotifyFailedMessage(): string {
  return (
    "校閲中の範囲を、作者へ知らせられませんでした（ネットにつながっていないなど）。" +
    `範囲は、${returnStepPlace()}を押したときに、提案と一緒に作者へ届きます。`
  );
}

/** 開いているファイルが、すでに校閲中のとき（外すかの問い） */
export function reviewLockHeldMessage(fileName: string): string {
  return `${fileName} は校閲中です。`;
}

/** 開いているファイルを校閲中にしたとき（続きの文は呼ぶ側が足す） */
export function reviewLockTakenMessage(fileName: string): string {
  return `${fileName} を校閲中にしました。`;
}

/** ほかの人が校閲中にしていたものを外したとき（編集履歴の詳細） */
export function reviewLockReleasedOthersDetail(holder: string): string {
  return `${holder} が校閲中にしていたものを外しました`;
}

/** 原稿エディターの帯に出す、鍵の持ち主と時刻 */
export interface ReviewLockBannerInput {
  /**
   * 編集者の GitHub 名（`.aiwriter/editing.json` の `editorLogin`、無ければ `formerEditorLogin`）。
   * **鍵の holder（git の名前）は渡さない**——作者が招いたときの名前と違うことがある（0.138.0）
   */
  readonly editorLogin?: string;
  /** 鍵の time（ISO8601） */
  readonly since: string;
}

/**
 * 「11月7日 18:30」。**この端末の時刻で書く**（作者が読む時計）。年は今年でなければ足す。
 * 読めない時刻なら undefined（時刻を言わない）
 */
export function formatLockSince(since: string, now: Date = new Date()): string | undefined {
  const parsed = new Date(since);
  if (since.length === 0 || Number.isNaN(parsed.getTime())) return undefined;
  const year = parsed.getFullYear() === now.getFullYear() ? "" : `${parsed.getFullYear()}年`;
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  return `${year}${parsed.getMonth() + 1}月${parsed.getDate()}日 ${parsed.getHours()}:${minutes}`;
}

/**
 * 原稿エディターの、校閲中の帯の文（作者の裁定 2026-11-07。文はこのとおりに）。
 *
 * 「この話は校閲中です（編集者 kmizu・11月7日 18:30 から）。編集者が返すと書けます。」
 * 名前が分からなければ「編集者」とだけ、時刻が読めなければ時刻を言わない。
 */
export function reviewLockBannerText(input: ReviewLockBannerInput, now: Date = new Date()): string {
  return `この話は校閲中です（${reviewLockDetail(input, now)}）。編集者が返すと書けます。`;
}

/**
 * 校閲中の知らせに出す「誰が」。名前が分からなければ「編集者」とだけ。
 * **帯も右下の知らせも、素のエディターの警告も、これで組む**（0.140.1。git の名前を出さない）
 */
export function reviewLockWho(editorLogin: string | undefined): string {
  return editorLogin ? `編集者 ${editorLogin}` : "編集者";
}

/**
 * 「編集者 kmizu・11月7日 18:30 から」（帯の括弧の中と同じ形）。時刻が読めなければ名前だけ。
 * 右下の知らせ・素のエディターの警告・書き込みの断りの括弧の中に使う（0.140.1）
 */
export function reviewLockDetail(input: ReviewLockBannerInput, now: Date = new Date()): string {
  const who = reviewLockWho(input.editorLogin);
  const since = formatLockSince(input.since, now);
  return since ? `${who}・${since} から` : who;
}
