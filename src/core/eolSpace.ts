import { computeMinimalEdit } from "./textEdit";

/**
 * 改行コードの「空間」の変換（設計書6.34.5の既知の穴の根本修正）。
 *
 * 原稿エディタの画面（webview）は textarea の値を使うため、**本文は常に
 * LF区切りの空間**で持つ。一方 `document.getText()` はファイルのまま
 * （CRLFならCRLF）を返す。この差を放置していたため、CRLFの原稿では
 *
 * - 用語の位置（termSpans）が1行につき1文字ずつ後ろへずれる
 * - ルビ・傍点が「本文が変わった」と誤断されて振れない
 * - 最初の1打鍵で、差分の範囲内の改行コードがLFへ書き換わる
 *   （「改行コードを保持して書き戻す」への違反）
 *
 * が同じ根から起きていた。**変換は境界（送るとき・当てるとき・位置を
 * 受け渡すとき）だけで行い、画面側は何も知らなくてよい**ようにする。
 *
 * 単独のCR（旧Mac形式）は対象外——この拡張機能が扱う原稿には現れない
 * 前提で、現れた場合も位置の対応は崩れない（CRを1文字として数える）。
 */

/** CRLF を LF へ。画面（webview）へ渡す本文はこの形に揃える */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * LF空間の位置を、元のテキスト（CRLFを含みうる）の位置へ。
 *
 * 表引きではなく歩いて数える。**CRLFとLFが混ざったファイルでも
 * 正確に対応が取れる**（正規表現で行数を数える方式は、混在で崩れる）。
 */
export function fromLfOffset(original: string, lfOffset: number): number {
  let docIndex = 0;
  let logical = 0;
  while (logical < lfOffset && docIndex < original.length) {
    if (
      original.charCodeAt(docIndex) === 13 &&
      original.charCodeAt(docIndex + 1) === 10
    ) {
      docIndex += 2;
    } else {
      docIndex += 1;
    }
    logical += 1;
  }
  return docIndex;
}

/** 元のテキストの位置を、LF空間の位置へ（`fromLfOffset` の逆） */
export function toLfOffset(original: string, docOffset: number): number {
  let docIndex = 0;
  let logical = 0;
  while (docIndex < docOffset && docIndex < original.length) {
    if (
      original.charCodeAt(docIndex) === 13 &&
      original.charCodeAt(docIndex + 1) === 10
    ) {
      docIndex += 2;
    } else {
      docIndex += 1;
    }
    logical += 1;
  }
  return logical;
}

/**
 * LF空間の本文を、書き戻し先の改行コードへ合わせる。
 *
 * **入れる文字列にだけ使う。** 文書ぜんたいをこれで揃えてから差分を取ると、
 * 混在ファイル（CRLFの文書にLFの行が混ざる）では**触っていない行の改行まで
 * 書き換わる**（`computeDocumentEdit` の説明）。
 */
export function fromLfText(lfText: string, useCrlf: boolean): string {
  if (!useCrlf) return lfText;
  return toLf(lfText).replace(/\n/g, "\r\n");
}

/** 文書へ当てる1か所（位置は文書の空間、文字列は文書の改行コード） */
export interface DocumentEdit {
  start: number;
  end: number;
  insert: string;
}

/**
 * 画面の本文（LF空間）を文書へ返すとき、**変わった1か所だけ**を出す。
 *
 * ## なぜ差分をLF空間で取るのか
 *
 * 以前は文書ぜんたいを `fromLfText(next, CRLF)` でCRLFへ揃えてから
 * `computeMinimalEdit` に掛けていた。**CRLFの文書にLFだけの行が混ざって
 * いると**（マージや貼り付けの名残でふつうに起きる）、揃えた側と文書側は
 * その行から食い違う。前方一致はそこで止まるので、
 *
 *   3行目（LFのまま）から、いま打った200行目まで
 *
 * が丸ごと「差分」になり、**触っていない3〜5行目の改行がCRLFへ書き換わる。**
 * 1文字打っただけで、である（実装ルール1「改行コードを保持して書き戻す」に
 * 反する）。
 *
 * そこで**差分はLF空間で取り、位置だけを文書の空間へ戻す。** LF空間では
 * CRLFもLFも1文字の `\n` なので、混在していても食い違いは打った場所だけに
 * なる。入れる文字列は文書の改行コードへ合わせる（新しく作る改行は
 * 文書の宣言に従う。既にある行には触らないので、混在はそのまま残る）。
 *
 * @param documentText 文書の本文（CRLFを含みうる）
 * @param nextLfText 画面から届いた本文（LF空間）
 * @param useCrlf 文書の改行コード（`document.eol === CRLF`）
 * @returns 変わっていなければ undefined
 */
export function computeDocumentEdit(
  documentText: string,
  nextLfText: string,
  useCrlf: boolean
): DocumentEdit | undefined {
  const edit = computeMinimalEdit(toLf(documentText), toLf(nextLfText));
  if (!edit) return undefined;
  return {
    start: fromLfOffset(documentText, edit.start),
    end: fromLfOffset(documentText, edit.end),
    insert: fromLfText(edit.insert, useCrlf),
  };
}
