/**
 * RSS 2.0 の小さな読み手（設計書6.3.6.2）。
 *
 * ## なぜ自前で読むのか
 *
 * - 拡張機能の本体は Node で動き、**DOMParser が無い**。ブラウザ版には有るが、
 *   2つの道で読み方を分けると、片方を直した日に食い違う
 * - 読むのは RSS の `item` の決まった欄（title・link・guid・description・
 *   pubDate・atom:updated・category）だけで、XML の全部を解く必要は無い。
 *   **外部のライブラリを足さない**（配布前の監査の手間と、ブラウザ版の束の重さを増やさない）
 *
 * 読めるもの：CDATA、実体参照（名前の5つ・10進・16進）、説明の中の HTML
 * （実体参照で書かれたものも。RSS のよくある書き方）。
 *
 * **直して受け取らない**——RSS でない文（メンテナンス中の HTML のページなど）は、
 * 理由を言って止める。
 *
 * VS Code API には依存しない。
 */

export interface RssItem {
  readonly title: string;
  /** http・https のリンクだけ。それ以外は null */
  readonly link: string | null;
  readonly guid: string | null;
  /** 説明（HTML を文字にしたもの） */
  readonly description: string;
  readonly pubDate: string | null;
  /** `atom:updated` */
  readonly updated: string | null;
  readonly categories: readonly string[];
}

export type RssFeedResult =
  | {
      readonly ok: true;
      readonly channelTitle: string | null;
      /** 一覧のページ（channel の link。http・https だけ） */
      readonly channelLink: string | null;
      readonly items: readonly RssItem[];
      /** 題の無い item の数（公募として数えない） */
      readonly skipped: number;
    }
  | { readonly ok: false; readonly reason: string };

/** 1件の説明の上限（長い文を流し込ませない） */
const MAX_DESCRIPTION = 8000;
/** 1回に読む item の上限 */
export const MAX_RSS_ITEMS = 500;

export function parseRssFeed(xml: string): RssFeedResult {
  const text = xml.replace(/^﻿/u, "");
  // 注釈（<!-- -->）は先に落とす。中に <item> と書かれていても読まない
  const body = text.replace(/<!--[\s\S]*?-->/gu, "");
  if (!/<rss[\s>]/iu.test(body) || !/<channel[\s>]/iu.test(body)) {
    return {
      ok: false,
      reason:
        "届いた文が RSS の形ではありませんでした（サイトの作りが変わったか、一時的に別のページが返ったのかもしれません）。",
    };
  }

  const channelHead = body.split(/<item[\s>]/iu)[0];
  const channelTitle = elementText(channelHead, "title");

  const items: RssItem[] = [];
  let skipped = 0;
  const pattern = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (items.length >= MAX_RSS_ITEMS) break;
    const inner = match[1];
    const title = clean(elementText(inner, "title") ?? "");
    if (!title) {
      skipped++;
      continue;
    }
    const rawDescription = elementText(inner, "description") ?? "";
    items.push({
      title,
      link: safeLink(elementText(inner, "link")),
      guid: clean(elementText(inner, "guid") ?? "") || null,
      description: htmlToText(rawDescription).slice(0, MAX_DESCRIPTION),
      pubDate: clean(elementText(inner, "pubDate") ?? "") || null,
      updated: clean(elementText(inner, "atom:updated") ?? "") || null,
      categories: elementTexts(inner, "category").map(clean).filter(Boolean),
    });
  }
  return {
    ok: true,
    channelTitle: channelTitle ? clean(channelTitle) : null,
    // `<atom:link …/>` は名前が違うので拾わない（あちらはフィード自身の場所）
    channelLink: safeLink(elementText(channelHead, "link")),
    items,
    skipped,
  };
}

/** 名前の付いた要素の中身（最初の1つ）。無ければ null */
function elementText(xml: string, name: string): string | null {
  return elementTexts(xml, name)[0] ?? null;
}

function elementTexts(xml: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // 属性を持つ形（<guid isPermaLink="true">）と、空の形（<link/>）の両方を見る
  const pattern = new RegExp(
    `<${escaped}(?:\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${escaped}\\s*>)`,
    "giu"
  );
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    values.push(contentText(match[1] ?? ""));
  }
  return values;
}

/**
 * 要素の中身を文字にする。**CDATA の中はそのまま**、外は実体参照を戻す。
 * CDATA の中の「&amp;」は、書いた人がそう書いたものである。
 */
function contentText(raw: string): string {
  const parts: string[] = [];
  const pattern = /<!\[CDATA\[([\s\S]*?)\]\]>/gu;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    parts.push(decodeXmlEntities(raw.slice(last, match.index)));
    parts.push(match[1]);
    last = match.index + match[0].length;
  }
  parts.push(decodeXmlEntities(raw.slice(last)));
  return parts.join("");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // HTML で書かれた説明によく出るもの（XML の5つではないが、読めないと「&nbsp;」が残る）
  nbsp: " ",
};

/**
 * 実体参照を戻す。**知らない名前はそのまま残す**（文字を作らない）。
 * 範囲外の数値も残す。
 */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/giu, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
      // 制御文字（改行・タブ以外）は作らない
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * 説明の HTML を文字にする。段落・改行の要素は改行に、ほかの要素は落とす。
 * **script・style の中身は読まない。** 空行は詰める（公募の欄の読み取りは、
 * 空行を「別の段落」として切るため）。
 */
export function htmlToText(html: string): string {
  // RSS の説明は、HTML を実体参照で書くことが多い（&lt;p&gt;）。先に一度戻す
  const unescaped = /&lt;\/?[a-z]/iu.test(html) ? decodeXmlEntities(html) : html;
  const text = unescaped
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|dd|dt)\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, "");
  return decodeXmlEntities(text)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/gu, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

function clean(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function safeLink(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+$/u.test(trimmed) || trimmed.length > 2000) return null;
  return trimmed;
}
