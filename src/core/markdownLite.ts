/**
 * AIの応答に含まれるMarkdownを、最低限だけHTMLへ整える。
 *
 * 設定資料パネルはWebViewなので、`**強調**` や `* 箇条書き` が
 * 記号のまま表示されてしまう。読みづらいので整形する。
 *
 * Markdownライブラリは使わない。WebViewのCSPで外部読み込みを禁じており、
 * 依存を増やすと配布前の監査も増えるため。扱うのは太字・斜体・
 * 箇条書き・コード・見出しだけで足りる。
 *
 * **必ず先にHTMLを無害化してから記法を変換する。** 順序を逆にすると、
 * AIの応答に含まれるタグがそのまま画面で効いてしまう。
 */

export function renderMarkdownLite(text: string): string {
  // コードの取り置きにNULを目印として使う（`renderInline`）。
  // 「本文には現れない」という前提だったが、現れた場合に
  // 存在しない取り置きを参照して `<code>undefined</code>` と表示される。
  // 前提にせず、ここで落としておく
  const withoutMarkers = String(text ?? "").replace(/\u0000/gu, "");
  const escaped = escapeHtmlText(withoutMarkers);

  const html: string[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    html.push(`<ul>${listItems.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    listItems = [];
  };

  for (const raw of escaped.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }

    // 中黒は空白を伴わずに書かれることが多い（「・一つ目」）。
    // 行頭の中黒＋本文は日本語ではまず箇条書きなので、空白を必須にしない
    const bullet = /^(?:[*+-]\s+|・\s*)(.*)$/.exec(line);
    if (bullet) {
      listItems.push(renderInline(bullet[1]));
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      // 見出しの階層までは再現しない。段落内の強調で足りる
      html.push(`<p><strong>${renderInline(heading[1])}</strong></p>`);
      continue;
    }

    flushList();
    html.push(`<p>${renderInline(line)}</p>`);
  }

  flushList();
  return html.join("");
}

// 属性値には入れず要素の本文にだけ入れるので `"` は逃がさない（htmlEscape.ts の escapeHtml とは別物）
function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 行内の記法を変換する。
 *
 * コードは先に取り置いてから戻す。順に置換するだけだと、
 * `` `**そのまま**` `` の中身まで強調に変わってしまう。
 */
function renderInline(line: string): string {
  const codes: string[] = [];
  const withoutCode = line.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    // 記法として解釈されない印を使う。応答本文には現れない制御文字
    return `\u0000${codes.length - 1}\u0000`;
  });

  const emphasized = withoutCode
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  return emphasized.replace(
    /\u0000(\d+)\u0000/g,
    (_, index: string) => `<code>${codes[Number(index)]}</code>`
  );
}
