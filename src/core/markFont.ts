/**
 * ダッシュ「――」と三点リーダ「……」だけに当てる書体を決める（設計書6.34）。
 *
 * ## なぜ本文の書体と分けるのか
 *
 * 0.64.4 から `#compose .dash` / `#compose .ellipsis` は**作者の書体を先頭に
 * 置いている**。名指しで和文明朝に固定すると、別の明朝（BIZ UD明朝など）を
 * 選んだ作者の本文の中で**そこだけ書体が変わって見える**ためである。
 *
 * ところが作者が実機で書体を替えて「――」を見たところ（2026-09-21）、
 *
 * - 繋がる……既定・ヒラギノ明朝・Noto Serif JP・Noto Sans JP・
 *   BIZ UD明朝・BIZ UDゴシック・メイリオ
 * - 隙間が出る……**游明朝・ＭＳ 明朝・游ゴシック**
 * - 「…」の見え方が変……**VS Code の編集用フォント（等幅）**
 *
 * と分かれた。游・ＭＳ のダッシュは**字送りより線が短い**ので、2本並べても
 * 1本に繋がらない。CSSの引き当ては「その字を持っていれば使う」だけなので、
 * **字を持っているのに形が合わない**この場合は後ろへ落ちてくれない。
 *
 * ## だから、印の書体だけを差し替える
 *
 * 隙間の出る書体を選んでいるときに限り、印（`.dash` / `.ellipsis`）にだけ
 * **同系の繋がる書体の列**を当てる。明朝を選んでいれば明朝の列、ゴシック・
 * 等幅なら ゴシックの列で、字面の系統は変えない。それ以外の書体では
 * **作者の書体をそのまま返す**（0.64.4 の形のまま）。
 *
 * ## 「既定」も判定にかける（作者の裁定、2026-09-22）
 *
 * 作者が書体を選んでいない（設定が空の）ときは、これまで空文字を返して
 * 既定にまかせていた。ところが**作者のノートの既定は切れる書体だった**
 * ので、選んでいないときだけ隙間が出ていた。そこで、VS Code の
 * `editor.fontFamily` の先頭の書体名を**実効の書体**として受け取り、
 * 同じ判定を通す。倒す必要が無ければ、これまでどおり空文字を返す
 * ——実効の書体名を返すと、本文（既定）と印だけ別の書体になる。
 *
 * ## ここに `vscode` を持ち込まない
 *
 * 判定は設定の文字列だけで決まる。画面にも設定にも触らないので、
 * `core` に置いて単体テストで測れる形にしてある。
 */

/**
 * 同じ書体を指す綴りの揺れを畳む。
 *
 * 引用符・空白を落として小文字に揃えるだけ。`Yu Mincho` と `YuMincho`、
 * `ＭＳ 明朝` と `ＭＳ明朝` を同じものとして見るためである。
 */
function normalizeFamily(name: string): string {
  return name.replace(/["']/g, "").replace(/\s+/g, "").toLowerCase();
}

/**
 * CSSの並びの**先頭**の書体名。
 *
 * 実際に描かれるのは先頭の1つである（後ろは同じ書体の別名か逃げ先）。
 * 設定の値は `"Yu Mincho", "YuMincho", serif` のような形で入っている。
 */
function firstFamily(fontFamily: string): string {
  const head = fontFamily.split(",")[0] ?? "";
  return normalizeFamily(head);
}

/** ダッシュが繋がらない明朝。同系の明朝へ倒す */
const GAPPED_MINCHO = new Set(
  ["Yu Mincho", "YuMincho", "MS Mincho", "ＭＳ 明朝"].map(normalizeFamily)
);

/**
 * ダッシュが繋がらないゴシックと、字形の合わない等幅。
 *
 * 等幅をここへ入れているのは、作者の実機で **VS Code の編集用フォント
 * （`var(--vscode-editor-font-family)`）のとき「…」の見え方が変**だった
 * ためである。等幅は欧文書体なので、和文の印を任せられない。
 * `Consolas` などを設定へ手で書いた場合も同じ扱いにする。
 */
const GAPPED_GOTHIC = new Set(
  [
    "Yu Gothic",
    "YuGothic",
    "MS Gothic",
    "ＭＳ ゴシック",
    "var(--vscode-editor-font-family)",
    "Consolas",
    "Courier New",
    "Courier",
  ].map(normalizeFamily)
);

/** 等幅の書体名にありがちな語。名前で見分ける（一覧に無い綴りも拾う） */
const MONOSPACE_HINTS = ["cascadia", "consolas", "courier", "monospace"];

/** 明朝を選んでいたときに当てる、ダッシュの繋がる明朝の列 */
export const MARK_FONT_MINCHO =
  '"BIZ UDMincho", "Noto Serif JP", "Noto Serif CJK JP", "Hiragino Mincho ProN", serif';

/** ゴシック・等幅を選んでいたときに当てる、ダッシュの繋がるゴシックの列 */
export const MARK_FONT_GOTHIC =
  '"BIZ UDGothic", "Noto Sans JP", "Noto Sans CJK JP", "Meiryo", sans-serif';

/**
 * 隙間の出る書体なら、倒し先の列を返す。困らない書体なら `undefined`。
 *
 * 作者の書体のときも、既定にまかせたときの実効の書体のときも、
 * **同じ判定を通す**ための取り出し。
 */
function gappedReplacement(fontFamily: string): string | undefined {
  const head = firstFamily(fontFamily);
  if (GAPPED_MINCHO.has(head)) return MARK_FONT_MINCHO;
  if (GAPPED_GOTHIC.has(head)) return MARK_FONT_GOTHIC;
  // 一覧に無い等幅（作者が設定へ手で書いたもの）も、名前で拾ってゴシックへ。
  // 和文の印を欧文の等幅に任せると、「…」も「―」も字形が合わない
  if (MONOSPACE_HINTS.some((hint) => head.includes(hint))) {
    return MARK_FONT_GOTHIC;
  }
  return undefined;
}

/**
 * 作者の書体から、印（ダッシュ・三点リーダ）に当てる書体を決める。
 *
 * @param authorFont 設定 `novelai.manuscriptEditor.fontFamily` の値。
 *   空文字は「既定にまかせる」なので、`effectiveFont` のほうで判定する
 * @param effectiveFont 作者が書体を選んでいないときに、**実際に描かれる**
 *   書体（VS Code の `editor.fontFamily`）。作者の裁定、2026-09-22
 *   ——ノートの既定が切れる書体（等幅）だったため、選んでいないときだけ
 *   隙間が出ていた。取れなければ空文字でよい
 * @returns 印に当てる font-family。**倒す必要が無ければ**、作者が選んで
 *   いるときは受け取った値をそのまま、選んでいないときは空文字を返す
 */
export function markFontFor(
  authorFont: string,
  effectiveFont = ""
): string {
  const trimmed = authorFont.trim();
  if (trimmed !== "") return gappedReplacement(trimmed) ?? trimmed;

  // ここから先は「作者が書体を選んでいない」場合。
  // **倒す必要が無ければ空文字のまま返す。** 実効の書体名を返してしまうと、
  // 本文（既定にまかせたまま）と印だけ別の書体になり、0.64.4 で直した
  // 「そこだけ書体が変わって見える」が戻る
  const effective = effectiveFont.trim();
  if (effective === "") return "";
  return gappedReplacement(effective) ?? "";
}
