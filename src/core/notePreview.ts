import { escapeHtml } from "./manuscriptRender";
import {
  NOTE_UNSUPPORTED,
  convertInline,
  imageLabel,
  noteHeadingLevel,
  parseNoteBlocks,
  type NoteBlock,
} from "./noteMarkdown";

/**
 * 「noteに貼ったときの見た目」を組む（設計書6.69）。
 *
 * ## 読み方は `noteMarkdown.ts` のものを使う
 *
 * どの行が見出しでどこがコードか、ルビと傍点をどう落とすか——**貼るときの
 * 整え（`toNoteMarkdown`）と同じ字句解析を通す。** ここが持つのはHTMLへの
 * 出力だけである。読み方を書き写すと、**プレビューで見た形と実際に貼った
 * 形が食い違う**日が必ず来る（EPUBの「見た目どおり」6.65.6と同じ原則）。
 *
 * ## noteに無いものには、必ず印を付ける
 *
 * 斜体・表・傍点はnoteに無く、画像は貼り付けでは入らない。
 * **黙って落とすのがいちばん困る**——貼ってから崩れていることに気づくと、
 * 直す場所を探すところからやり直しになる。行の脇に控えめな印を置き、
 * 理由はホバーで出す。
 *
 * ## 用語の色もシーンメモも出さない
 *
 * この面は「貼ったあとの姿」を見るためのもので、書く面ではない。
 * シーンメモの行は投稿用のコピーと同じく落とす（`parseNoteBlocks`）
 * ——作者の付箋が公開されては困る（設計書6.40.2）。
 *
 * ここは vscode に触らないので単体テストできる。
 */

/** 文言の定義は `noteMarkdown.ts` に置く（貼るときの知らせと同じ言葉を使う） */
export { NOTE_UNSUPPORTED } from "./noteMarkdown";

export function renderNotePreview(text: string): string {
  return parseNoteBlocks(text).map(renderBlock).join("");
}

function renderBlock(block: NoteBlock): string {
  const warn = new Set<string>();

  switch (block.kind) {
    case "empty":
      // noteでは空行がそのまま間隔になる。詰めると読み味が変わる
      return '<p class="note-empty"></p>';

    case "rule":
      return '<hr class="note-hr">';

    case "heading": {
      /*
        **noteの見出しは2段しかない**（大見出し＝`##`・小見出し＝`###`）。
        貼るときも同じ段へ丸めるので、ここでも丸めた姿で見せる
        ——`#` と `##` が違う大きさに見えると、貼ってから「同じになった」
        と驚くことになる。

        class は大きい順に `note-h1`／`note-h2`（見た目の定義は
        `views/manuscriptEditorHtml.ts`）。**noteの大見出しは、この面で
        いちばん大きい見出しである**ので、段の番号ではなく大きさの順で当てる。
      */
      const level = noteHeadingLevel(block.level);
      const inner = renderInline(block.text, warn);
      return wrap(`h${level}`, `note-h${level - 1}`, inner, warn);
    }

    case "table":
      warn.add(NOTE_UNSUPPORTED.table);
      return block.raw
        .map((line) => wrap("p", "note-p", renderInline(line, warn), warn))
        .join("");

    case "quote": {
      // **続く引用行は1つのかたまりにする。** noteの引用は縦線1本で
      // まとまるので、行ごとに区切ると線が何本も並ぶ。
      // 中の空行は全角スペースの行になる（貼るときと同じ扱い）
      const parts = block.lines.map((line) =>
        line.trim() ? renderInline(line, warn) : "　"
      );
      return wrap("blockquote", "note-quote", parts.join("<br>"), warn);
    }

    case "list": {
      const items = block.items
        .map((item) => wrap("li", "note-item", renderInline(item, warn), warn))
        .join("");
      const tag = block.ordered ? "ol" : "ul";
      return `<${tag} class="note-list">${items}</${tag}>`;
    }

    case "code":
      // **中身は変換しない。** コードの中の記号は記法ではない
      return `<pre class="note-code"><code>${escapeHtml(
        block.lines.join("\n")
      )}</code></pre>`;

    case "image":
      // **貼り付けでは入らない。** 入る場所だけを、ここに見せておく
      warn.add(NOTE_UNSUPPORTED.image);
      return wrap(
        "p",
        "note-p note-image",
        escapeHtml(imageLabel(block.alt, block.src)),
        warn
      );

    case "embed":
      /*
        **これは「できない」の印ではない。** URLだけの行はnoteが
        埋め込みカードにしてくれる——そうなると分かっていないと、
        作者は自分で説明文を書き足してしまい、埋め込みが消える
      */
      return (
        '<p class="note-p note-embed">' +
        `<span class="note-link">${escapeHtml(block.url)}</span>` +
        '<span class="note-embed-label">埋め込みカードになります</span>' +
        "</p>"
      );

    case "text": {
      const inner = renderInline(block.text, warn);
      return wrap("p", "note-p", inner, warn);
    }
  }
}

/**
 * かたまり1つを組む。注意があれば、行の脇の印を先頭に置く。
 *
 * **印は行の中に入れる**（ガターへ絶対配置するのはCSS側の仕事）。
 * 別の要素として外へ出すと、リストの項目や引用の中では行がずれる。
 */
function wrap(
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
 * 1. ルビ・傍点・画像・斜体を落とす（`convertInline`。貼るときと同じ規則）
 * 2. HTMLとして無害にする（**この後でしかタグを足さない**）
 * 3. 太字 → リンクの順に組む。太字を先に片づけないと、
 *    `**太字**` の `*` が斜体として拾われる（`convertInline` の中も同じ順）
 */
function renderInline(raw: string, warn: Set<string>): string {
  const converted = convertInline(raw, warn);
  // 文の中の画像も、貼り付けでは入らない
  if (converted.images.length > 0) warn.add(NOTE_UNSUPPORTED.image);
  if (/https?:\/\/\S+/.test(converted.text.replace(LINK, "$1"))) {
    warn.add(NOTE_UNSUPPORTED.inlineUrl);
  }

  let html = escapeHtml(converted.text);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  /*
    **飛び先は持たせない。** ここは貼ったあとの姿を見る面で、開く場所では
    ない（押して外のページが開くと、書いている手が止まる）。`<a>` で
    出すのは、noteでリンクとして出ることを字面で分からせるためである。
  */
  html = html.replace(
    LINK,
    (_, label: string) => `<a class="note-link">${label}</a>`
  );

  return html;
}

/** リンク（`[文字](飛び先)`）。飛び先は捨てるが、字は残す */
const LINK = /\[([^\]\n]*)\]\(([^()\s]*)\)/g;
