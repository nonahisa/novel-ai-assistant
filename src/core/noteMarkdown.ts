import * as path from "./paths";
import { hasEmphasis, toSiteNotation } from "./ruby";
import { isMemoLine } from "./sceneMemo";

/**
 * note へ貼るための整え（設計書6.84）。
 *
 * ## なぜ「変換」ではなく「整え」なのか
 *
 * noteのエディタは、**Markdownのプレーンテキストを貼るだけで解釈する**
 * ——見出し（`## `＝大見出し・`### `＝小見出し）・太字・取り消し線・
 * リンク・区切り線・箇条書き・コードブロック・引用。だから投稿サイトの
 * ような記法の置き換えはほとんど要らない。要るのは
 *
 * - noteが持たない段（`#` の見出し、`####` 以降）を、持っている段へ丸める
 * - noteが**貼り付けでは受け取らないもの**（題名・画像・表）を、
 *   黙って消さずに位置と件数で知らせる
 * - 埋め込み（URL1つだけの段落）になる形へ並べ直す
 *
 * の3つである。
 *
 * ## 消したものを、必ず数える
 *
 * 貼ってから「画像が入っていない」「題名が二重になった」と気づくと、
 * 直す場所を探すところからやり直しになる。**落としたものは
 * `images`・`title`・`warnings` で必ず返す**——呼び出し側は、それを
 * 作者への知らせに使う。
 *
 * ## 字句解析はここが持ち、プレビューはHTMLへの出力だけを持つ
 *
 * 「noteに貼ったときの見た目」（`notePreview.ts`）と**同じ入力を同じ形に
 * 読む**。読み方を2か所に置くと、プレビューでは正しく見えるのに貼ると
 * 崩れる、という食い違いが必ず起きる（6.69で一度書いた線と同じ）。
 *
 * VS Code APIには依存しない（純粋関数）。
 */

/**
 * noteに無い記法・貼り付けでは入らないものと、その伝え方。
 * **言葉の定義はここだけ**（画面は受け取った文字列をそのまま出す）。
 *
 * 「出ません」だけでは、記号が残るのか消えるのかが分からない。
 * **貼ったあとどうなるか**まで書く。
 */
export const NOTE_UNSUPPORTED = {
  italic: "斜体はnoteでは出ません（印は外れます）",
  table:
    "表はコピペでは入りません（スプレッドシートからコピーして貼ってください）",
  emphasis: "傍点はnoteでは出ません（印は外れます）",
  inlineUrl:
    "文の中のURLは埋め込みになりません（URLだけの行にすると埋め込みカードになります）",
  /**
   * **これはプレビューの印のための文言である。**
   *
   * `toNoteMarkdown` の `warnings` には入れない——画像は件数と位置
   * （`images`）で返しており、コピーの知らせはそちらを使う。同じことを
   * 2つの言い方で出すと、作者は「別の話が2つある」と読む。
   */
  image: "画像は貼り付けでは入りません（この位置へアップロードしてください）",
} as const;

/** 表の行（`| 名前 | 役 |`）。区切りの行（`| --- |`）もここに入る */
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** 区切り線。3つ以上並んだときだけ（`--` は本文のダッシュのことがある） */
const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
/** コードの囲み。言語名は付いていなくてよい */
const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)\s*$/;
/**
 * 画像だけの行。
 *
 * **在り処に空白があっても読む。** `画像 001.png` や `My Pictures/…` は
 * Windowsではふつうに起きる。`[^()\s]*` で見ていたころは画像だと気づけず、
 * `![猫](画像 001.png)` の行がそのまま本文へ出て、**どこに何を入れる
 * つもりだったかが控え（`images`）にも残らなかった**。
 */
const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(([^)\n]*)\)\s*$/;
/** URLだけの行。**これが埋め込みになる唯一の形** */
const URL_LINE = /^\s*(https?:\/\/\S+)\s*$/;
const INLINE_IMAGE = /!\[([^\]\n]*)\]\(([^)\n]*)\)/g;
/** 行の中のリンク。**在り処の空白は画像と同じ扱い**（`IMAGE_LINE` の説明） */
const INLINE_LINK = /\[([^\]\n]*)\]\(([^)\n]*)\)/g;
const BARE_URL = /https?:\/\/\S+/;
/** 太字（`**`）を斜体と読み違えないための形 */
const ITALIC = /(^|[^*])\*([^*\n]+)\*(?!\*)/g;

/** 読み取ったかたまり1つ。プレビューと貼り付け用の両方がこれを読む */
export type NoteBlock =
  | { kind: "empty"; raw: string[] }
  | { kind: "heading"; level: number; text: string; raw: string[] }
  | { kind: "rule"; raw: string[] }
  | { kind: "quote"; lines: string[]; raw: string[] }
  | { kind: "list"; ordered: boolean; items: string[]; raw: string[] }
  | { kind: "code"; lang: string; lines: string[]; raw: string[] }
  | { kind: "image"; alt: string; src: string; raw: string[] }
  | { kind: "embed"; url: string; raw: string[] }
  | { kind: "table"; raw: string[] }
  | { kind: "text"; text: string; raw: string[] };

/** 本文に残した画像の目印1つ */
export interface NoteImageRef {
  /** `![ここ](…)` の説明。無いこともある */
  alt: string;
  /** 書いてあったままの在り処（相対パスのことが多い） */
  path: string;
  /** 整えたあとの本文で、目印が何行目にあるか（1始まり） */
  line: number;
}

export interface NoteMarkdownResult {
  /** noteの本文欄へ貼るもの */
  body: string;
  /** 題名欄へ手で入れるもの。先頭が `# ` のときだけ */
  title?: string;
  /** 貼り付けでは入らない画像と、その位置 */
  images: NoteImageRef[];
  /** 埋め込みになるURL（1行に1つだけ置いたもの） */
  embeds: string[];
  /** noteでは思ったとおりにならないもの。`NOTE_UNSUPPORTED` の文言 */
  warnings: string[];
}

export interface NoteMarkdownOptions {
  /**
   * 先頭の `# 見出し` を題名として本文から外すか（既定は外す）。
   *
   * **noteの題名はコピペでは入らない**ので、本文に残すと題名が二重に出る。
   * 記事の途中だけを選んでコピーするときのために、切れるようにしてある。
   */
  extractTitle?: boolean;
}

/**
 * noteの見出しの段（大見出し＝`##`・小見出し＝`###`）へ丸める。
 *
 * **noteの見出しは2段しかない。** `#` を貼ると見出しにならず、`####` は
 * ただの文字として出る。丸め方をここ1つに置いて、プレビューと貼り付けで
 * 同じ段になるようにする。
 */
export function noteHeadingLevel(level: number): 2 | 3 {
  return level <= 2 ? 2 : 3;
}

/**
 * 本文を、noteが読める形へ整える。
 *
 * @param text 作者のMarkdown風の本文（SNS記事タイプの `.md`）
 */
export function toNoteMarkdown(
  text: string,
  options: NoteMarkdownOptions = {}
): NoteMarkdownResult {
  const blocks = parseNoteBlocks(text);
  const warn = new Set<string>();
  const images: NoteImageRef[] = [];
  const embeds: string[] = [];
  const out: string[] = [];

  let title: string | undefined;
  let titleTaken = options.extractTitle === false;
  /** 直前が埋め込みだったか。**次のかたまりとの間に空行が要る** */
  let afterEmbed = false;

  /** 1行を積む。その行で見つかった画像に、行番号を付けて覚える */
  const push = (line: string, found: Array<{ alt: string; src: string }>) => {
    out.push(line);
    for (const image of found) {
      images.push({ alt: image.alt, path: image.src, line: out.length });
    }
  };
  const inline = (raw: string): { text: string; images: Array<{ alt: string; src: string }> } =>
    convertInline(raw, warn);

  for (const block of blocks) {
    // 埋め込みは前後を空行で挟まないと、noteがカードにしてくれない
    if (afterEmbed && block.kind !== "empty" && out.length > 0) out.push("");
    afterEmbed = false;

    switch (block.kind) {
      case "empty":
        out.push("");
        break;

      case "heading": {
        if (!titleTaken) {
          titleTaken = true;
          if (block.level === 1) {
            title = plainInline(block.text);
            break;
          }
        }
        const converted = inline(block.text);
        push(
          `${"#".repeat(noteHeadingLevel(block.level))} ${converted.text}`,
          converted.images
        );
        break;
      }

      case "rule":
        titleTaken = true;
        out.push("---");
        break;

      case "quote":
        titleTaken = true;
        for (const line of block.lines) {
          // **引用の中に空行は置けない**（そこで引用が切れる）。
          // 全角スペースの行で間隔だけを残す
          if (!line.trim()) {
            out.push("> 　");
            continue;
          }
          const converted = inline(line);
          push(`> ${converted.text}`, converted.images);
        }
        break;

      case "code":
        titleTaken = true;
        // **中身には触らない。** コードの `{a|b}` はルビではないし、
        // 行頭の `//` はシーンメモでもない
        out.push(`${fenceFor(block.lines)}${block.lang}`);
        for (const line of block.lines) out.push(line);
        out.push(fenceFor(block.lines));
        break;

      case "image": {
        titleTaken = true;
        // **画像は貼り付けでは入らない。** 消すと位置が分からなくなるので、
        // 目印の行を置いて、あとでそこへアップロードしてもらう
        push(imageLabel(block.alt, block.src), [
          { alt: block.alt, src: block.src },
        ]);
        break;
      }

      case "embed":
        titleTaken = true;
        if (out.length > 0 && out[out.length - 1] !== "") out.push("");
        out.push(block.url);
        embeds.push(block.url);
        afterEmbed = true;
        break;

      case "table":
        titleTaken = true;
        warn.add(NOTE_UNSUPPORTED.table);
        for (const line of block.raw) {
          const converted = inline(line);
          push(converted.text, converted.images);
        }
        break;

      case "list":
        titleTaken = true;
        // **字下げはそのまま。** noteは入れ子の箇条書きを読む
        for (const line of block.raw) {
          const converted = inline(line);
          push(converted.text, converted.images);
        }
        break;

      case "text": {
        titleTaken = true;
        const converted = inline(block.text);
        // 文の中のURLは埋め込みにならない（1行に1つだけ置いたときだけ）
        if (BARE_URL.test(converted.text.replace(INLINE_LINK, "$1"))) {
          warn.add(NOTE_UNSUPPORTED.inlineUrl);
        }
        push(converted.text, converted.images);
        break;
      }
    }
  }

  return {
    // 題名を外したぶんの空行が先頭に残る。貼る先は本文欄なので落とす
    body: out.join("\n").replace(/^\n+/, "").replace(/\n+$/, ""),
    title,
    images,
    embeds,
    warnings: [...warn],
  };
}

/**
 * 本文をかたまりへ読み分ける。**プレビューと貼り付けの共通の読み方。**
 *
 * シーンメモの行はここで落とす（設計書6.40.2）。**コードの中は落とさない**
 * ——`// 説明` はコードであって作者の付箋ではない。
 */
export function parseNoteBlocks(text: string): NoteBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: NoteBlock[] = [];

  let at = 0;
  while (at < lines.length) {
    const line = lines[at];

    // コードの囲みを先に見る。中の `#` や `>` を記法として読まないため
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      let cursor = at + 1;
      while (cursor < lines.length) {
        const close = FENCE.exec(lines[cursor]);
        // 同じ記号で、開いたときと同じ長さ以上なら閉じ
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
          cursor += 1;
          break;
        }
        body.push(lines[cursor]);
        cursor += 1;
      }
      blocks.push({
        kind: "code",
        lang: fence[2],
        lines: body,
        raw: lines.slice(at, cursor),
      });
      at = cursor;
      continue;
    }

    if (isMemoLine(line)) {
      at += 1;
      continue;
    }

    if (!line.trim()) {
      blocks.push({ kind: "empty", raw: [line] });
      at += 1;
      continue;
    }

    if (HORIZONTAL_RULE.test(line)) {
      blocks.push({ kind: "rule", raw: [line] });
      at += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2],
        raw: [line],
      });
      at += 1;
      continue;
    }

    if (TABLE_ROW.test(line)) {
      const raw: string[] = [];
      while (at < lines.length && TABLE_ROW.test(lines[at])) {
        raw.push(lines[at]);
        at += 1;
      }
      blocks.push({ kind: "table", raw });
      continue;
    }

    const image = IMAGE_LINE.exec(line);
    if (image) {
      blocks.push({ kind: "image", alt: image[1], src: image[2], raw: [line] });
      at += 1;
      continue;
    }

    const url = URL_LINE.exec(line);
    if (url) {
      blocks.push({ kind: "embed", url: url[1], raw: [line] });
      at += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const collected = quoteAt(lines, at);
      blocks.push(collected.block);
      at = collected.next;
      continue;
    }

    const list = listAt(lines, at);
    if (list) {
      blocks.push(list.block);
      at = list.next;
      continue;
    }

    blocks.push({ kind: "text", text: line, raw: [line] });
    at += 1;
  }

  return blocks;
}

/**
 * 続く引用行を1つのかたまりへ。
 *
 * **あいだの空行も引用の中として繋ぐ。** 作者は1つの引用のつもりで
 * 空けているのに、noteでは縦線が2本に割れる——繋いでおいて、
 * 貼るときに全角スペースの行へ置き換える。
 */
function quoteAt(
  lines: readonly string[],
  from: number
): { block: NoteBlock; next: number } {
  const collected: string[] = [];
  const raw: string[] = [];
  let at = from;

  while (at < lines.length) {
    const quote = QUOTE.exec(lines[at]);
    if (quote) {
      collected.push(quote[1]);
      raw.push(lines[at]);
      at += 1;
      continue;
    }
    // 空行の先に引用が続いていれば、引用の中の空行として繋ぐ
    if (!lines[at].trim()) {
      let ahead = at;
      while (ahead < lines.length && !lines[ahead].trim()) ahead += 1;
      if (ahead < lines.length && QUOTE.test(lines[ahead])) {
        for (let i = at; i < ahead; i += 1) {
          collected.push("");
          raw.push(lines[i]);
        }
        at = ahead;
        continue;
      }
    }
    break;
  }

  return { block: { kind: "quote", lines: collected, raw }, next: at };
}

/** 続く箇条書き（番号リスト）を1つのかたまりへ。無ければ undefined */
function listAt(
  lines: readonly string[],
  from: number
): { block: NoteBlock; next: number } | undefined {
  const ordered = NUMBERED.test(lines[from]);
  const pattern = ordered ? NUMBERED : BULLET;
  if (!pattern.test(lines[from])) return undefined;

  const items: string[] = [];
  const raw: string[] = [];
  let at = from;
  while (at < lines.length) {
    const matched = pattern.exec(lines[at]);
    if (!matched) break;
    items.push(matched[1]);
    raw.push(lines[at]);
    at += 1;
  }
  return { block: { kind: "list", ordered, items, raw }, next: at };
}

/**
 * 画像の目印。**ファイル名まで出す。** 説明だけでは、どの画像を
 * アップロードすればよいのかが分からない
 */
export function imageLabel(alt: string, src: string): string {
  const file = path.basename(src) || src;
  return alt ? `【画像：${alt}（${file}）】` : `【画像：${file}】`;
}

/**
 * コードの囲み。**noteが読むバッククォートに揃える**（`~~~` は読まない）。
 *
 * 中身に囲みと同じ並びがあるときは、1つ長くする——短いままだと
 * そこでコードが終わったことになる。
 */
function fenceFor(lines: readonly string[]): string {
  let longest = 0;
  for (const line of lines) {
    const found = /^\s*(`{3,})/.exec(line);
    if (found) longest = Math.max(longest, found[1].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * 行の中の記法を、noteへ貼る形へ。
 *
 * **順序に意味がある。**
 *
 * 1. 傍点があるかを、記法のまま見る（落としたあとでは分からない）
 * 2. ルビ・傍点を投稿キットと同じ規則で落とす（`ruby.ts` の `paren`）
 * 3. 画像を目印へ（リンクより先。`![…](…)` の `[` をリンクとして拾わせない）
 * 4. 斜体の印を外す（noteに無い）
 */
export function convertInline(
  raw: string,
  warn: Set<string>
): { text: string; images: Array<{ alt: string; src: string }> } {
  if (hasEmphasis(raw)) warn.add(NOTE_UNSUPPORTED.emphasis);

  // ルビは括弧書き、傍点は印だけが外れる（規則の出どころは core/ruby.ts）
  let text = toSiteNotation(raw, "paren");

  const images: Array<{ alt: string; src: string }> = [];
  text = text.replace(INLINE_IMAGE, (_, alt: string, src: string) => {
    images.push({ alt, src });
    return imageLabel(alt, src);
  });

  text = text.replace(ITALIC, (_, before: string, inner: string) => {
    warn.add(NOTE_UNSUPPORTED.italic);
    return before + inner;
  });

  return { text, images };
}

/**
 * 題名欄へそのまま入れられる形（記法の記号を落とす）。
 *
 * **題名欄はプレーンテキストである。** `**` を残すと、記号がそのまま
 * 記事の題として出る。
 */
function plainInline(raw: string): string {
  return toSiteNotation(raw, "paren")
    .replace(INLINE_IMAGE, (_, alt: string) => alt)
    .replace(INLINE_LINK, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(ITALIC, "$1$2")
    .trim();
}
