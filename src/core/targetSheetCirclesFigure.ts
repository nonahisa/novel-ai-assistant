/**
 * ターゲットシートの「3つの輪」の節に置く図（設計書6.108.6。作者の依頼 2026-10-26）。
 *
 * 作者が会話で見て「本番の結果に置けますか」と言った図をそのまま置く。
 * **毎回同じ図**で、材料（輪が揃っているか）によって変えない——薄くする
 * などは頼まれていない。図の下に説明の一文も置かない（作者「下の一文は不要です」）。
 *
 * ## なぜ Markdown の画像（data URI）にしたか
 *
 * シートは `vscode.open` で作者の既定のエディターに開く。作者は `*.md` を
 * **新しい Markdown 編集画面（hybrid）**に割り当てている（引継ぎ書）。
 *
 * - `<svg>` を直に書く形は、あの画面では絵にならない（生の HTML を組まない。
 *   設計書6.25 の調べ）。標準のプレビューでしか見えない
 * - 別ファイル（`設定/3つの輪.svg`）は、作品の `設定/` に作者の書いていない
 *   ファイルを1つ増やし、同期と GitHub にも載る
 * - **画像の行（`![…](data:…)`）は、hybrid の画面も標準のプレビューも絵にする。**
 *   hybrid は `<img src>` へそのまま渡し（`javascript:` だけを断る）、どちらの
 *   画面も `img-src … data:` を許している（VS Code 1.141.0 の dist で確かめた）
 *
 * ただし**参照形式（`![図][輪]` と末尾の定義）は使わない。** 素のテキストで
 * 長い行を末尾へ逃がせるが、hybrid の画面は参照先を引かず、絵が出ない。
 *
 * ## なぜ base64 でなく、%XX の形にしたか
 *
 * 素のテキストで開いたときに、長い1行が並ぶのは避けられない。せめて
 * **日本語の見出し語がそのまま読める**ように、ASCII の記号だけを %XX にし、
 * 日本語は生のまま残す（base64 だと何の行か分からない）。
 *
 * - 標準のプレビューは `^data:image\/.*?;` に合う URL しか画像にしない。
 *   `;charset=utf-8` を付けて、セミコロンを必ず入れる
 * - Markdown の行先として壊れる字（空白・丸括弧・山括弧）を残さない
 *
 * ## 色
 *
 * 画像の中には VS Code の色の変数が届かない。**図そのものに淡い地を敷き、
 * 字は濃い色に固定する**——明るい・暗いどちらのテーマでも、字は地の上で
 * 読める（暗いテーマでは明るい札が1枚浮く形になる）。輪の3色は彩度を
 * 落とした別々の色で、半透明にして重なりを見せる。
 *
 * VS Code API にも AI にも依存しない。
 */

/** 画像の代わりに出る名前。素のテキストで開いたときに、何の行かが分かる */
export const CIRCLES_FIGURE_ALT = "3つの輪の図";

/** 字の書体。日本語の書体を先に並べ、どの機械でも豆腐にならないようにする */
const FONT = "Yu Gothic UI, Hiragino Sans, Noto Sans JP, Meiryo, sans-serif";

/** 字の色（淡い地の上で読める濃さ） */
const INK = "#2b2b2b";
const SUB_INK = "#555555";

interface Circle {
  readonly cx: number;
  readonly cy: number;
  readonly fill: string;
  readonly title: string;
  readonly sub: string;
  /** 見出し語を置く位置（重なりを避けて、輪の外寄り） */
  readonly tx: number;
  readonly ty: number;
}

const RADIUS = 95;

/** 左上・右上・下。作者が見た並びのまま */
const CIRCLES: readonly Circle[] = [
  {
    cx: 160,
    cy: 125,
    fill: "#5b8db8",
    title: "すでに書けたもの",
    sub: "実績・本文の実像",
    tx: 120,
    ty: 96,
  },
  {
    cx: 280,
    cy: 125,
    fill: "#c9825b",
    title: "書きたいもの",
    sub: "読者としてのあなた",
    tx: 322,
    ty: 96,
  },
  {
    cx: 220,
    cy: 222,
    fill: "#6fa37a",
    title: "読者が読みたいもの",
    sub: "狙った読者・届いた反応",
    tx: 220,
    ty: 268,
  },
];

/** 図の SVG（1行。改行を持たない） */
export function circlesFigureSvg(): string {
  const parts: string[] = [
    "<svg xmlns='http://www.w3.org/2000/svg' width='440' height='340' viewBox='0 0 440 340'>",
    "<rect x='1' y='1' width='438' height='338' rx='14' fill='#faf8f3' stroke='#d9d4c7'/>",
    ...CIRCLES.map(
      (c) =>
        `<circle cx='${c.cx}' cy='${c.cy}' r='${RADIUS}' fill='${c.fill}' ` +
        `fill-opacity='0.38' stroke='${c.fill}' stroke-width='2'/>`
    ),
    `<g font-family='${FONT}' text-anchor='middle'>`,
    ...CIRCLES.flatMap((c) => [
      `<text x='${c.tx}' y='${c.ty}' font-size='15' font-weight='bold' fill='${INK}'>${c.title}</text>`,
      `<text x='${c.tx}' y='${c.ty + 18}' font-size='11' fill='${SUB_INK}'>${c.sub}</text>`,
    ]),
    `<text x='220' y='160' font-size='15' font-weight='bold' fill='${INK}'>狙い目</text>`,
    `<text x='220' y='176' font-size='10' fill='${SUB_INK}'>3つが重なる所</text>`,
    "</g>",
    "</svg>",
  ];
  return parts.join("");
}

/** 図を置く Markdown の1行 */
export function circlesFigureMarkdown(): string {
  return `![${CIRCLES_FIGURE_ALT}](data:image/svg+xml;charset=utf-8,${encodeForDataUri(circlesFigureSvg())})`;
}

/**
 * ASCII の記号だけを %XX にする。英数字と、行先で意味を持たない記号は残し、
 * 日本語（ASCII の外）は生のまま残す（素のテキストで読めるように）。
 */
function encodeForDataUri(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7f || /[A-Za-z0-9\-_.~'\/:=,!*;]/.test(char)) {
      out += char;
    } else {
      out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}
