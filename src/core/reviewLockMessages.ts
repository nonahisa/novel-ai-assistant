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
