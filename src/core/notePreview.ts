import { escapeHtml } from "./manuscriptRender";
import { hasEmphasis, toSiteNotation } from "./ruby";
import { stripMemoLines } from "./sceneMemo";

/**
 * 「noteに貼ったときの見た目」を組む（設計書6.69）。
 *
 * ## 変換の規則を写さない
 *
 * ルビと傍点の落とし方は、投稿キット（設計書6.68.3）がnoteへ貼るときに
 * 使うものと**同じ関数**を通す——`core/ruby.ts` の
 * `toSiteNotation(text, "paren")` である（`{漢字|かんじ}` →「漢字（かんじ）」、
 * 傍点は印だけが外れる）。ここに同じ置換を書き写すと、片方だけが直る日が
 * 必ず来て、**プレビューで見た形と実際に貼った形が食い違う**。
 * EPUBの「見た目どおり」（6.65.6）と同じ原則である。
 *
 * ## noteに無いものには、必ず印を付ける
 *
 * 斜体・表・傍点はnoteに無い。**黙って落とすのがいちばん困る**
 * ——貼ってから崩れていることに気づくと、直す場所を探すところから
 * やり直しになる。行の脇に控えめな印を置き、理由はホバーで出す。
 *
 * ## 用語の色もシーンメモも出さない
 *
 * この面は「貼ったあとの姿」を見るためのもので、書く面ではない。
 * シーンメモの行は投稿用のコピー（`episodeCopy.ts`）と同じく落とす
 * ——作者の付箋が公開されては困る（設計書6.40.2）。
 *
 * ここは vscode に触らないので単体テストできる。
 */

/**
 * noteに無い記法と、その伝え方。**言葉の定義はここだけ**（画面は受け取った
 * 文字列をそのまま出す）。
 *
 * 「出ません」だけでは、記号が残るのか消えるのかが分からない。
 * **貼ったあとどうなるか**まで書く。
 */
export const NOTE_UNSUPPORTED = {
  italic: "斜体はnoteでは出ません（印は外れます）",
  table: "表はnoteでは出ません（文字がそのまま並びます）",
  emphasis: "傍点はnoteでは出ません（印は外れます）",
} as const;

/** 表の行（`| 名前 | 役 |`）。区切りの行（`| --- |`）もここに入る */
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** 区切り線。3つ以上並んだときだけ（`--` は本文のダッシュのことがある） */
const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function renderNotePreview(text: string): string {
  // 投稿用のコピーと同じ順序で落とす（付箋は貼るものではない）
  const lines = stripMemoLines(text).replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];

  let at = 0;
  while (at < lines.length) {
    const line = lines[at];

    if (!line.trim()) {
      // noteでは空行がそのまま間隔になる。詰めると読み味が変わる
      html.push('<p class="note-empty"></p>');
      at += 1;
      continue;
    }

    if (HORIZONTAL_RULE.test(line)) {
      html.push('<hr class="note-hr">');
      at += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      const warn = new Set<string>();
      const inner = renderInline(heading[2], warn);
      html.push(block(`h${level}`, `note-h${level}`, inner, warn));
      at += 1;
      continue;
    }

    if (TABLE_ROW.test(line)) {
      const warn = new Set<string>([NOTE_UNSUPPORTED.table]);
      html.push(block("p", "note-p", renderInline(line, warn), warn));
      at += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      // **続く引用行は1つのかたまりにする。** noteの引用は縦線1本で
      // まとまるので、行ごとに区切ると線が何本も並ぶ
      const warn = new Set<string>();
      const parts: string[] = [];
      while (at < lines.length) {
        const next = QUOTE.exec(lines[at]);
        if (!next) break;
        parts.push(renderInline(next[1], warn));
        at += 1;
      }
      html.push(block("blockquote", "note-quote", parts.join("<br>"), warn));
      continue;
    }

    const list = listAt(lines, at);
    if (list) {
      html.push(list.html);
      at = list.next;
      continue;
    }

    const warn = new Set<string>();
    html.push(block("p", "note-p", renderInline(line, warn), warn));
    at += 1;
  }

  return html.join("");
}

/** 続く箇条書き（番号リスト）を1つのかたまりへ。無ければ undefined */
function listAt(
  lines: readonly string[],
  from: number
): { html: string; next: number } | undefined {
  const numbered = NUMBERED.test(lines[from]);
  const pattern = numbered ? NUMBERED : BULLET;
  if (!pattern.test(lines[from])) return undefined;

  const items: string[] = [];
  let at = from;
  while (at < lines.length) {
    const matched = pattern.exec(lines[at]);
    if (!matched) break;
    const warn = new Set<string>();
    items.push(block("li", "note-item", renderInline(matched[1], warn), warn));
    at += 1;
  }
  const tag = numbered ? "ol" : "ul";
  return {
    html: `<${tag} class="note-list">${items.join("")}</${tag}>`,
    next: at,
  };
}

/**
 * かたまり1つを組む。注意があれば、行の脇の印を先頭に置く。
 *
 * **印は行の中に入れる**（ガターへ絶対配置するのはCSS側の仕事）。
 * 別の要素として外へ出すと、リストの項目や引用の中では行がずれる。
 */
function block(
  tag: string,
  className: string,
  inner: string,
  warn: ReadonlySet<string>
): string {
  if (warn.size === 0) {
    return `<${tag} class="${className}">${inner}</${tag}>`;
  }
  const reason = escapeHtml([...warn].join("／"));
  const mark = `<span class="note-warn" title="${reason}">※</span>`;
  return `<${tag} class="${className} note-flagged">${mark}${inner}</${tag}>`;
}

/**
 * 行の中の記法を、noteで出る形へ。
 *
 * **順序に意味がある。**
 *
 * 1. 傍点があるかを、記法のまま見る（落としたあとでは分からない）
 * 2. ルビ・傍点を投稿キットと同じ規則で落とす（`ruby.ts` の `paren`）
 * 3. HTMLとして無害にする（**この後でしかタグを足さない**）
 * 4. 太字 → リンク → 斜体の順に組む。太字を先に片づけないと、
 *    `**太字**` の `*` が斜体として拾われる
 */
function renderInline(raw: string, warn: Set<string>): string {
  if (hasEmphasis(raw)) warn.add(NOTE_UNSUPPORTED.emphasis);

  // ルビは括弧書き、傍点は印だけが外れる（規則の出どころは core/ruby.ts）
  const plain = toSiteNotation(raw, "paren");
  let html = escapeHtml(plain);

  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // **飛び先は持たせない。** ここは貼ったあとの姿を見る面で、
  // 開く場所ではない（noteの本文でもリンクは下線で見える）
  html = html.replace(
    /\[([^\]\n]*)\]\(([^()\s]*)\)/g,
    (_, label: string) => `<span class="note-link">${label}</span>`
  );

  html = html.replace(
    /(^|[^*])\*([^*\n]+)\*(?!\*)/g,
    (_, before: string, inner: string) => {
      warn.add(NOTE_UNSUPPORTED.italic);
      return before + inner;
    }
  );

  return html;
}
