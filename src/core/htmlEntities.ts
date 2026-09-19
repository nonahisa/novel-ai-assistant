/**
 * HTMLの文字参照をほどく（設計書6.99、0.69.10）。
 *
 * アルファポリスのバックアップは、本文の中に文字参照を残したまま書き出す
 * ——実物に152件あった（`&#x2014;`＝—、`&#x2049;`＝⁉、`&#x2022;`＝•、
 * `&#xFE0E;`、`&#x2661;`＝♡）。**UTF-8版にも同じだけ入っている**ので
 * 文字コードの問題ではなく、書き出しの仕様である。
 *
 * **ほどかないと、`&#x2014;` がそのまま原稿に残る。**
 *
 * ## 名前付きは、HTMLの仕様の全部は引かない
 *
 * 引くのは `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&nbsp;` の6つだけである。
 * 2,000以上ある名前の表を持ち込むと、**本文に出てくる「&copy」のような
 * 文字列まで書き換える**（HTMLの仕様は末尾の `;` が無くても引くと決めて
 * いるが、ここは本文であってHTMLではない）。
 *
 * ## 1度しかほどかない
 *
 * `&amp;#x2014;` は `&#x2014;` になるのが正しく、`—` になってはいけない。
 * **1回の走査で全部の形をまとめて置き換える**ので、ほどいた結果を
 * もう一度ほどくことがない（順番に replace を重ねると、ここを間違える）。
 *
 * VS Code API には依存しない。
 */

/** 引く名前付き参照。**増やすときは「本文に出うるか」を先に考える** */
const NAMED: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  // **通常の空白にしない。** 作者が置いた空きかもしれないので、
  // 見た目の変わらない同じ幅の空白（U+00A0）のまま残す
  ["nbsp", " "],
]);

/** `&#x2014;`（16進）・`&#8212;`（10進）・`&amp;`（名前）をまとめて拾う */
const REFERENCE = /&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-zA-Z]+));/g;

/**
 * 文字参照をほどく。**読めない参照はそのまま残す。**
 *
 * 残すのは、勝手に消すと作者の本文が1文字減るためである——読めない形は
 * 「ほどけなかった」と分かるほうが、黙って消えるより直しようがある。
 */
export function decodeCharacterReferences(text: string): string {
  return text.replace(REFERENCE, (whole, hex, dec, name) => {
    if (typeof name === "string") return NAMED.get(name.toLowerCase()) ?? whole;

    const code = parseInt(hex ?? dec, hex ? 16 : 10);
    // サロゲート領域と範囲外は文字にならない（`fromCodePoint` が投げる）
    if (!Number.isSafeInteger(code)) return whole;
    if (code === 0 || code > 0x10ffff) return whole;
    if (code >= 0xd800 && code <= 0xdfff) return whole;
    return String.fromCodePoint(code);
  });
}
