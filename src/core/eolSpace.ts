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
 * **これをせずに差分を取ると、差分の範囲内の改行が全部LFへ変わる。**
 * 混在ファイル（CRLFの文書にLFの行が混ざる）では、差分が触れた範囲の
 * LF行がCRLFへ揃う——以前は逆に全体がLFへ流れていたので、保存の向きが
 * 文書の宣言（`document.eol`）と揃う分だけ良くなる。混在をそのまま
 * 保つことは差分方式では原理的にできない（どの行がどちらだったかは
 * LF空間に残らない）。
 */
export function fromLfText(lfText: string, useCrlf: boolean): string {
  if (!useCrlf) return lfText;
  return toLf(lfText).replace(/\n/g, "\r\n");
}
