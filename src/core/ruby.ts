/**
 * ルビ（振り仮名）の記法変換（設計書6.12）。
 *
 * **拡張機能の中では `{漢字|かんじ}` で書く。** Markdownの拡張として
 * 広く使われている形で、投稿サイトごとの記法に引きずられずに済む。
 *
 * **投稿サイトへは `｜漢字《かんじ》` で出す。** 2026-08-19に調べたところ、
 * **なろう・カクヨム・アルファポリスのいずれでも通る**。1つの記法で
 * 3サイトを賄えるので、サイトごとに出し分ける必要がない。
 *
 * アルファポリスにはもう1つ `#漢字__かんじ__#` があるので、そちらも
 * 読み書きできるようにしてある（他所から持ち込んだ原稿を取り込めるように）。
 *
 * **ネオページの記法は確かめていない。** 分からないものを推測で入れると、
 * 作者が貼り付けた先で崩れる。分かってから足す。
 *
 * VS Code APIに依存しない。
 */

/** 拡張機能の中で使う記法 `{漢字|かんじ}` */
const INTERNAL = /\{([^{}|\r\n]+)\|([^{}|\r\n]*)\}/g;

/**
 * 投稿サイトの記法 `｜漢字《かんじ》`。
 *
 * 縦線は半角 `|` でも全角 `｜` でもよい（どのサイトも両方を受ける）。
 */
const SITE_BAR = /[|｜]([^|｜《》\r\n]+)《([^《》\r\n]*)》/g;

/**
 * 縦線を省いた `漢字《かんじ》`。
 *
 * **漢字が続くところだけを拾う。** なろうとカクヨムは、漢字の直後に
 * 《》が来た場合にかぎり縦線を省ける。ひらがなや記号まで拾うと、
 * 会話の中の二重山括弧（`《《強調》》` など）を巻き込む。
 */
const SITE_BARE = /([\u4E00-\u9FFF\u3005々]+)《([^《》\r\n]*)》/g;

/** アルファポリスのもう1つの記法 `#漢字__かんじ__#` */
const SITE_HASH = /#([^#\r\n]+?)__([^#\r\n]*?)__#/g;

export interface RubyStyle {
  id: "site" | "alphapolis-hash" | "html";
  label: string;
  detail: string;
}

/**
 * 出せる記法。
 *
 * **1つ目で足りることを、作者に伝わる言葉で書く。**
 * 選択肢が並ぶと「どれを選べばいいのか」で手が止まる。
 */
export const RUBY_STYLES: RubyStyle[] = [
  {
    id: "site",
    label: "投稿サイト用（｜漢字《かんじ》）",
    detail:
      "なろう・カクヨム・アルファポリスのいずれでも、そのまま貼り付けられます",
  },
  {
    id: "alphapolis-hash",
    label: "アルファポリスの別記法（#漢字__かんじ__#）",
    detail: "上の記法で不都合があったときだけ使ってください",
  },
  {
    id: "html",
    label: "HTML（<ruby>）",
    detail: "自分のサイトやEPUBへ持っていく場合",
  },
];

/** ルビの中身を1件ずつ取り出す */
export function findRuby(text: string): Array<{ base: string; reading: string }> {
  const found: Array<{ base: string; reading: string }> = [];
  for (const match of text.matchAll(INTERNAL)) {
    found.push({ base: match[1], reading: match[2] });
  }
  return found;
}

/** `{漢字|かんじ}` を投稿サイトの記法へ */
export function toSiteNotation(
  text: string,
  style: RubyStyle["id"] = "site"
): string {
  switch (style) {
    case "site":
      return text.replace(INTERNAL, (_, base, reading) =>
        reading ? `｜${base}《${reading}》` : base
      );
    case "alphapolis-hash":
      return text.replace(INTERNAL, (_, base, reading) =>
        reading ? `#${base}__${reading}__#` : base
      );
    case "html":
      return text.replace(INTERNAL, (_, base, reading) =>
        reading
          ? `<ruby>${escapeHtml(base)}<rt>${escapeHtml(reading)}</rt></ruby>`
          : escapeHtml(base)
      );
  }
}

/**
 * 投稿サイトの記法を `{漢字|かんじ}` へ戻す。
 *
 * **すでに投稿した原稿を取り込むときに使う。** 縦線ありを先に処理する。
 * 先に縦線なしを当てると、`｜漢字《かんじ》` の縦線が置いてけぼりになる。
 */
export function fromSiteNotation(text: string): string {
  return text
    .replace(SITE_BAR, (_, base, reading) => `{${base}|${reading}}`)
    .replace(SITE_HASH, (_, base, reading) => `{${base}|${reading}}`)
    .replace(SITE_BARE, (_, base, reading) => `{${base}|${reading}}`);
}

/** プレビュー用のHTML。ルビ以外はそのまま返す（呼ぶ側で escape 済みを想定しない） */
export function rubyToHtml(text: string): string {
  return toSiteNotation(text, "html");
}

/**
 * ルビを取り除いて、本文だけにする。
 *
 * **投稿サイトは読み仮名を字数に数えない**ので、文字数の計測でも使う。
 */
export function stripRuby(text: string): string {
  return text.replace(INTERNAL, "$1");
}

/**
 * ルビとして正しい形か。理由が分かる文字列を返す（問題なければ null）。
 */
export function validateRuby(base: string, reading: string): string | null {
  if (!base.trim()) return "ルビを振る文字がありません。";
  if (!reading.trim()) return "読み仮名がありません。";
  if (/[{}|｜《》#\r\n]/u.test(base) || /[{}|｜《》#\r\n]/u.test(reading)) {
    return "ルビに使えない記号（{ } | ｜ 《 》 #）が入っています。";
  }
  if (base.length > 30) return "ルビを振る文字が長すぎます（30文字まで）。";
  if (reading.length > 30) return "読み仮名が長すぎます（30文字まで）。";
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
