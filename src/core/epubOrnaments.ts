/**
 * 飾りの図録（設計書6.65.17）。
 *
 * 目次・中表紙・奥付に置く飾りを、**1か所**で持つ。組み込みの飾りと、
 * 外から足した飾り（`設定/書籍/飾り/*.svg` と共通フォルダー。読むのは
 * `epubOrnamentFolder.ts`）が同じ形で並ぶ。
 *
 * ## 画像ファイルは増やさない
 *
 * 罫線はCSS、それ以外は断片の中に書いたSVGである。外部ファイルにすると
 * OPFの manifest へ載せ忘れたときに「本は開くが飾りだけ出ない」という
 * 分かりにくい壊れ方をする（6.65.6でそう決めた。外から取り込む飾りも、
 * ファイルのまま本へ入れず**中身をSVGとして持ち回る**のはこのため）。
 *
 * ## 形は左右対称にする
 *
 * 縦組みの本では飾りが90度寝る。横長・上下非対称の絵は横倒しになるので、
 * 組み込みの飾りはすべて左右対称にしてある（既存の「中央飾り」を菱形に
 * したのと同じ理由）。**形の対称は目視でしか見られない**ので、テストが
 * 見るのは形式だけである。
 *
 * ここは vscode に触らない（純粋関数だけ。単体テストできる）。
 */

/** CSSで引く飾りの種類。SVGを持たない飾りだけが使う */
export type OrnamentRuleKind = "rule" | "double-rule";

/** どこから来た飾りか。画面の呼び名の組み立てに使う */
export type OrnamentSource = "builtin" | "work" | "shared";

/**
 * 飾り1つ。**`svg` と `css` はどちらか一方**（両方持たないのが「なし」）。
 *
 * `id` は book.json に書かれる値そのもので、外から足した飾りでは
 * ファイル名（拡張子なし）になる。
 */
export interface OrnamentDef {
  id: string;
  /** 画面に出す呼び名。外から足した飾りではファイル名と同じ */
  label: string;
  /** インラインSVG（根が `<svg>`）。検査（`sanitizeOrnamentSvg`）を通した形 */
  svg?: string;
  /** CSSで引く罫線 */
  css?: OrnamentRuleKind;
  source: OrnamentSource;
}

/** 「飾らない」の id。既定値でもある（本の見た目を変えない） */
export const NO_ORNAMENT_ID = "none";

/**
 * 取り込むSVGの上限（設計書6.65.17）。
 *
 * **飾りに64KBは十分すぎる。** 上限を置くのは、書き出しのたびに何MBもの
 * SVGを本文の何倍も詰めた本ができるのを防ぐため（イラストは挿絵として
 * 入れる道が別にある）。
 */
export const MAX_ORNAMENT_SVG_BYTES = 64 * 1024;

/** SVGの決まり文句。**組み込みの飾りは、この形だけで書く** */
function svgOf(inner: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"' +
    ' width="24" height="24" aria-hidden="true" role="presentation">' +
    inner +
    "</svg>"
  );
}

/**
 * 組み込みの飾り（設計書6.65.17）。
 *
 * **`none`・`rule`・`center` は第1段からの3つで、1文字も変えていない。**
 * 版を上げただけで既にある本の見た目が変わっては困る。
 */
export const BUILTIN_ORNAMENTS: readonly OrnamentDef[] = [
  { id: NO_ORNAMENT_ID, label: "なし", source: "builtin" },
  { id: "rule", label: "罫線", css: "rule", source: "builtin" },
  { id: "double-rule", label: "二重罫", css: "double-rule", source: "builtin" },
  {
    id: "center",
    label: "中央飾り（菱形）",
    svg: svgOf('<path d="M12 2 L16 12 L12 22 L8 12 Z" fill="currentColor" />'),
    source: "builtin",
  },
  {
    // 三つ星（⁂）。小さな星を三角に置く、章の切れ目の古い飾り
    id: "asterism",
    label: "三つ星",
    svg: svgOf(
      '<path d="M12 2 L13 5 L16 6 L13 7 L12 10 L11 7 L8 6 L11 5 Z" fill="currentColor" />' +
        '<path d="M7 13 L8 16 L11 17 L8 18 L7 21 L6 18 L3 17 L6 16 Z" fill="currentColor" />' +
        '<path d="M17 13 L18 16 L21 17 L18 18 L17 21 L16 18 L13 17 L16 16 Z" fill="currentColor" />'
    ),
    source: "builtin",
  },
  {
    // 花形（フルーロン）。左右対称の葉と、その両脇の点
    id: "fleuron",
    label: "花形",
    svg: svgOf(
      '<path d="M12 3 C16 7 18 12 12 21 C6 12 8 7 12 3 Z" fill="currentColor" />' +
        '<circle cx="5" cy="12" r="1.3" fill="currentColor" />' +
        '<circle cx="19" cy="12" r="1.3" fill="currentColor" />'
    ),
    source: "builtin",
  },
  {
    // 波。**山を2つにして左右対称にしてある**（ふつうの波線は点対称なので、
    // 縦組みで寝たときに上下が入れ替わって見える）
    id: "wave",
    label: "波",
    svg: svgOf(
      '<path d="M2 14 Q7 8 12 14 Q17 8 22 14 L22 16.5 Q17 10.5 12 16.5' +
        ' Q7 10.5 2 16.5 Z" fill="currentColor" />'
    ),
    source: "builtin",
  },
  {
    id: "dots",
    label: "中黒三つ",
    svg: svgOf(
      '<circle cx="6" cy="12" r="1.6" fill="currentColor" />' +
        '<circle cx="12" cy="12" r="1.6" fill="currentColor" />' +
        '<circle cx="18" cy="12" r="1.6" fill="currentColor" />'
    ),
    source: "builtin",
  },
];

/** 図録から1つ引く。**無ければ null**（呼び出し側が「なし」に倒す） */
export function findOrnament(
  id: string,
  catalogue: readonly OrnamentDef[] = BUILTIN_ORNAMENTS
): OrnamentDef | null {
  return catalogue.find((item) => item.id === id) ?? null;
}

/**
 * 飾りの断片（設計書6.65.17）。**書き出しとプレビューが共に使う。**
 *
 * `<span>` も `<svg>` も見出しの中に置ける文字物なので、目次の `<nav>` の
 * 中でも仕様を外れずに「見出しの下の飾り」を作れる（6.65.6でそう決めた）。
 *
 * **知らない id は「なし」と同じ扱いにする。** book.json に書かれた飾りが
 * 図録から消えていること（共通フォルダーを外した、作品の飾りを消した）は
 * 起こりうる。ここで例外を投げると、飾り1つのために本そのものが出なくなる
 * ——落ちた飾りは `unknownOrnamentIds` で拾ってログと画面へ出す。
 */
export function buildOrnamentFragment(
  id: string,
  catalogue: readonly OrnamentDef[] = BUILTIN_ORNAMENTS
): string {
  const found = findOrnament(id, catalogue);
  if (!found) return "";
  if (found.css) {
    return `<span class="ornament ornament-${found.css}"></span>`;
  }
  if (found.svg) {
    return `<span class="ornament ornament-center">${found.svg}</span>`;
  }
  return "";
}

/**
 * 図録に無い id（設計書6.65.17）。
 *
 * **「なし」は数えない。** 飾らないことを選んだ本で毎回ログが出ては、
 * ほかの知らせが埋もれる。重複も畳む（同じ id を目次と奥付の両方に
 * 書いた本で、同じ行を2回出さない）。
 */
export function unknownOrnamentIds(
  ids: readonly string[],
  catalogue: readonly OrnamentDef[] = BUILTIN_ORNAMENTS
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const value = id.trim();
    if (!value || value === NO_ORNAMENT_ID) continue;
    if (findOrnament(value, catalogue)) continue;
    if (out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

/** 図録を重ねた結果 */
export interface MergedOrnaments {
  catalogue: OrnamentDef[];
  /** 先にある飾りと id がぶつかって、使われなかったもの */
  shadowed: string[];
}

/**
 * 図録を「組み込み → 作品の飾り → 共通フォルダー」の順に重ねる。
 *
 * **id がぶつかったら先勝ちである。** 後勝ちにすると、共通フォルダーへ
 * `rule.svg` を1つ置いただけで、その端末で開くすべての本の罫線が黙って
 * 変わる。組み込みの飾りは上書きできない、と決めておけば、本の見た目が
 * 端末の設定で変わるのは「作者が新しい id を選んだとき」だけになる。
 */
export function mergeOrnaments(
  ...lists: ReadonlyArray<readonly OrnamentDef[]>
): MergedOrnaments {
  const catalogue: OrnamentDef[] = [];
  const shadowed: string[] = [];
  const seen = new Set<string>();

  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.id)) {
        shadowed.push(item.id);
        continue;
      }
      seen.add(item.id);
      catalogue.push(item);
    }
  }

  return { catalogue, shadowed };
}

/** 検査の結果。**通らなかったものは図録へ入れない**（理由を添えて外す） */
export type OrnamentSvgCheck =
  | { ok: true; svg: string }
  | { ok: false; reason: string };

/**
 * 取り込むSVGを検査して整える（設計書6.65.17）。**純粋関数**である。
 *
 * 外から来たSVGは、本の中で開かれるXHTMLの一部になる。スクリプトや外部
 * 参照が混じると、本が壊れるか、読者の端末が知らないところへ通信する
 * ——**通ったものだけを本へ入れる**。
 *
 * ## 自前でXMLを走査している
 *
 * `DOMParser` はブラウザ版にしか無く、`node:` のXMLライブラリは使えない
 * （設計書5.8）。飾りのSVGに要るのは「入れ子が閉じているか」「どの要素と
 * 属性が使われているか」だけなので、小さな走査で足りる——**汎用のXML
 * パーサではない**ので、ほかの用途へ持ち出さないこと。
 *
 * ## 実体参照は、決まったものだけ通す
 *
 * DOCTYPE を落とすので、そこで定義された実体は本の中で未定義になる。
 * 未定義の実体があるとXHTMLごと開けなくなる（飾り1つで本が壊れる）ため、
 * XMLの5つと数値参照以外は断る。
 */
export function sanitizeOrnamentSvg(text: string): OrnamentSvgCheck {
  const size = new TextEncoder().encode(text).length;
  if (size > MAX_ORNAMENT_SVG_BYTES) {
    return {
      ok: false,
      reason: `大きすぎます（${Math.round(
        size / 1024
      )}KB）。飾りは64KBまでです。`,
    };
  }

  const scanned = scanXml(text);
  if (!scanned.ok) return scanned;

  const tokens = scanned.tokens;
  const root = tokens.find((token) => token.kind === "open");
  if (!root || localName(root.name) !== "svg") {
    return {
      ok: false,
      reason: "いちばん外側が <svg> ではありません（SVGのファイルを置いてください）。",
    };
  }

  const refused = refuse(tokens);
  if (refused) return { ok: false, reason: refused };

  return { ok: true, svg: serialize(tokens, root) };
}

/* ---- 断る理由 --------------------------------------------------------- */

/** 本へ入れられない中身。**理由は、直し方が分かる言い方にする** */
function refuse(tokens: readonly XmlToken[]): string | null {
  let styleDepth = 0;

  for (const token of tokens) {
    if (token.kind === "close") {
      if (localName(token.name) === "style") styleDepth -= 1;
      continue;
    }
    if (token.kind === "text" || token.kind === "cdata") {
      if (styleDepth > 0) {
        const refusedStyle = refuseStyle(token.text);
        if (refusedStyle) return refusedStyle;
      }
      continue;
    }
    if (token.kind !== "open") continue;

    const name = localName(token.name);
    if (name === "script" || name === "foreignobject" || name === "image") {
      // 断り文は、書いてあるとおりの綴りで返す（作者が探せるように）
      return `<${token.name}> は飾りに使えません（本の中で開かれるため、外の絵や動く仕掛けは入れられません）。`;
    }
    if (name === "style" && !token.selfClosing) styleDepth += 1;

    for (const attribute of token.attrs) {
      const attributeName = attribute.name.toLowerCase();
      if (attributeName.startsWith("on")) {
        return `属性 ${attribute.name} は飾りに使えません（動く仕掛けは入れられません）。`;
      }
      // **綴りではなく名前の実体で見る。** `xlink:href` だけを名指しで
      // 塞いでいたころは、同じ名前空間を別の接頭辞で宣言した
      // `xl:href="http://…"` が素通りしていた（接頭辞は書く人が決められる）
      if (localName(attribute.name) === "href") {
        if (!attribute.value.trim().startsWith("#")) {
          return `${attribute.name}「${attribute.value}」は飾りに使えません（同じ絵の中を指す # だけが使えます）。`;
        }
      }
      const refusedUrl = refuseAttributeUrl(attribute);
      if (refusedUrl) return refusedUrl;
    }
  }

  return null;
}

/**
 * 外を指す `url(…)`。無ければ null。
 *
 * **`url(` の規則は1つだけにする**（0.37.5）。同じ絵の中を指す `#` は通し、
 * それ以外は断る——`<style>` の中と属性値で違う規則にしていると、
 * 「グラデーションの参照は書けるのに、`<style>` に書くと断られる」という
 * 説明のつかない差になる。
 *
 * `url('#g')` `url( #g )` のような書き方も同じものとして見る。
 */
function externalUrlIn(text: string): string | null {
  for (const match of text.matchAll(/url\(\s*([^)]*)\)?/gi)) {
    const target = match[1].trim().replace(/^["']|["']$/g, "").trim();
    if (target.startsWith("#")) continue;
    return target;
  }
  return null;
}

/**
 * 属性値の `url(…)`。
 *
 * `url(` を `<style>` の中でしか見ていなかったころは、
 * `fill="url(http://…)"` や `style="filter:url(…)"` が素通りしていた
 * ——飾りを開くたびに読者の端末が外へ通信する。入口は `fill`・`filter`・
 * `mask`・`clip-path`・`marker-*` と多いので、**属性の名前では絞らずに
 * 全部の値を見る**（名前で絞ると、いつか1つ増えたときに漏れる）。
 */
function refuseAttributeUrl(attribute: XmlAttr): string | null {
  if (externalUrlIn(attribute.value) === null) return null;
  return `${attribute.name}「${attribute.value}」は飾りに使えません（url( は同じ絵の中を指す # だけが使えます）。`;
}

/** `<style>` の中身。**外を読みに行く書き方だけ**を断る */
function refuseStyle(css: string): string | null {
  if (/@import/i.test(css)) {
    return "<style> の中の @import は使えません（外のCSSを読みに行くため）。";
  }
  const external = externalUrlIn(css);
  if (external !== null) {
    return `<style> の中の url(${external}) は使えません（同じ絵の中を指す # だけが使えます）。`;
  }
  return null;
}

/* ---- 整える ----------------------------------------------------------- */

/**
 * 検査を通した形に組み直す。
 *
 * **XML宣言・DOCTYPE・コメントは落とす。** 断片として見出しの中へ差し込む
 * ので、宣言があるとそこでXHTMLが壊れる。コメントは作った道具の名前や
 * 作者の覚え書きが入っていることがあり、本へ配る意味が無い。
 */
function serialize(tokens: readonly XmlToken[], root: XmlOpen): string {
  const out: string[] = [];

  for (const token of tokens) {
    switch (token.kind) {
      case "open":
        out.push(openTag(token, token === root));
        break;
      case "close":
        out.push(`</${token.name}>`);
        break;
      case "text":
        out.push(token.text);
        break;
      case "cdata":
        out.push(`<![CDATA[${token.text}]]>`);
        break;
      default:
        // 宣言・DOCTYPE・コメント・処理命令は落とす
        break;
    }
  }

  return out.join("").trim();
}

function openTag(token: XmlOpen, isRoot: boolean): string {
  const attrs = isRoot ? rootAttributes(token) : token.attrs;
  const rendered = attrs
    .map((attribute) => ` ${attribute.name}="${escapeAttr(attribute.value)}"`)
    .join("");
  return `<${token.name}${rendered}${token.selfClosing ? " />" : ">"}`;
}

/**
 * 根に付ける印。
 *
 * - `aria-hidden` と `role`：飾りは読み上げない（組み込みの飾りと揃える）
 * - `xmlns`：**無いとXHTMLの中で絵にならない**。名前空間が付いていない
 *   SVGはXHTMLの名前空間の要素として読まれ、リーダーは何も描かない
 * - `width`・`height`：**素の数値でなければ** `viewBox` の比から長辺24で
 *   割り出す。寸法の無いSVGはリーダーによって面いっぱいに広がるが、
 *   `width="100%"` や `24px` も同じことが起きる——単位や割合を書いた飾りは
 *   本文が1行も見えない面を作るので、割り出しへ倒す
 */
function rootAttributes(token: XmlOpen): XmlAttr[] {
  const attrs = token.attrs.filter(
    (attribute) =>
      attribute.name !== "aria-hidden" && attribute.name !== "role"
  );
  const has = (name: string): boolean =>
    attrs.some((attribute) => attribute.name === name);
  /** 単位も割合も付いていない、そのまま使える寸法か */
  const isPlainSize = (name: string): boolean => {
    const found = attrs.find((attribute) => attribute.name === name);
    return found !== undefined && /^\s*\d+(?:\.\d+)?\s*$/.test(found.value);
  };

  if (!has("xmlns")) {
    attrs.unshift({ name: "xmlns", value: "http://www.w3.org/2000/svg" });
  }
  if (!isPlainSize("width") || !isPlainSize("height")) {
    const size = sizeFromViewBox(
      attrs.find((attribute) => attribute.name === "viewBox")?.value
    );
    const rest = attrs.filter(
      (attribute) => attribute.name !== "width" && attribute.name !== "height"
    );
    rest.push({ name: "width", value: String(size.width) });
    rest.push({ name: "height", value: String(size.height) });
    attrs.length = 0;
    attrs.push(...rest);
  }

  attrs.push({ name: "aria-hidden", value: "true" });
  attrs.push({ name: "role", value: "presentation" });
  return attrs;
}

/** `viewBox` の比を保ったまま、長辺を24にする（無ければ 24×24） */
function sizeFromViewBox(viewBox: string | undefined): {
  width: number;
  height: number;
} {
  const parts = (viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return { width: 24, height: 24 };
  }
  const [, , width, height] = parts;
  if (width <= 0 || height <= 0) return { width: 24, height: 24 };

  const scale = 24 / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 名前空間の接頭辞を落とした小文字の名前（要素の見分けにだけ使う） */
function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return (colon < 0 ? name : name.slice(colon + 1)).toLowerCase();
}

/* ---- XMLの走査 -------------------------------------------------------- */

interface XmlAttr {
  name: string;
  value: string;
}

interface XmlOpen {
  kind: "open";
  name: string;
  attrs: XmlAttr[];
  selfClosing: boolean;
}

type XmlToken =
  | XmlOpen
  | { kind: "close"; name: string }
  | { kind: "text"; text: string }
  | { kind: "cdata"; text: string }
  | { kind: "drop" };

type XmlScan =
  | { ok: true; tokens: XmlToken[] }
  | { ok: false; reason: string };

const NAME_PATTERN = /^[A-Za-z_:][\w.:-]*/;

/**
 * SVGとして読める程度にXMLを走査する。**汎用のパーサではない。**
 *
 * 見るのは「入れ子が閉じているか」「根が1つか」「どの要素と属性か」だけ。
 * 実体参照は、DOCTYPEを落とす都合で決まったものだけ通す（上の説明を参照）。
 */
function scanXml(source: string): XmlScan {
  const tokens: XmlToken[] = [];
  const stack: string[] = [];
  /**
   * いま使ってよい名前空間の接頭辞。**`xml` だけは宣言なしで使える**
   * （`xml:space` `xml:lang`。XMLの決まりで最初から結ばれている）。
   */
  let declared = new Set<string>(["xml"]);
  /** 親の時点の集合。閉じ札で戻す（宣言は書いた要素の中でしか効かない） */
  const declaredStack: Array<Set<string>> = [];
  let index = 0;
  let rootClosed = false;

  const fail = (reason: string): XmlScan => ({
    ok: false,
    reason: `XMLとして読めません（${reason}）。`,
  });

  while (index < source.length) {
    const next = source.indexOf("<", index);
    if (next < 0) {
      const tail = source.slice(index);
      const bad = badEntity(tail);
      if (bad) return fail(bad);
      if (stack.length > 0) tokens.push({ kind: "text", text: tail });
      else if (tail.trim()) return fail("いちばん外側に文字があります");
      break;
    }

    if (next > index) {
      const text = source.slice(index, next);
      const bad = badEntity(text);
      if (bad) return fail(bad);
      if (stack.length > 0) tokens.push({ kind: "text", text });
      else if (text.trim()) return fail("いちばん外側に文字があります");
    }

    if (source.startsWith("<!--", next)) {
      const end = source.indexOf("-->", next + 4);
      if (end < 0) return fail("閉じていないコメントがあります");
      tokens.push({ kind: "drop" });
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", next)) {
      const end = source.indexOf("]]>", next + 9);
      if (end < 0) return fail("閉じていない CDATA があります");
      tokens.push({ kind: "cdata", text: source.slice(next + 9, end) });
      index = end + 3;
      continue;
    }
    if (source.startsWith("<?", next)) {
      const end = source.indexOf("?>", next + 2);
      if (end < 0) return fail("閉じていない宣言があります");
      tokens.push({ kind: "drop" });
      index = end + 2;
      continue;
    }
    if (source.startsWith("<!", next)) {
      // DOCTYPE。内部サブセット（`[ ... ]`）があれば、その閉じまで飛ばす
      const end = doctypeEnd(source, next);
      if (end < 0) return fail("閉じていない DOCTYPE があります");
      tokens.push({ kind: "drop" });
      index = end;
      continue;
    }

    if (source.startsWith("</", next)) {
      const end = source.indexOf(">", next + 2);
      if (end < 0) return fail("閉じ札が閉じていません");
      const name = source.slice(next + 2, end).trim();
      const open = stack.pop();
      if (open === undefined) return fail(`閉じ札 </${name}> が余っています`);
      if (open !== name) {
        return fail(`<${open}> が </${name}> で閉じられています`);
      }
      tokens.push({ kind: "close", name });
      declared = declaredStack.pop() ?? declared;
      if (stack.length === 0) rootClosed = true;
      index = end + 1;
      continue;
    }

    const parsed = parseOpenTag(source, next);
    if (!parsed.ok) return fail(parsed.reason);
    if (rootClosed) return fail("いちばん外側の要素が2つあります");

    // その札で宣言された接頭辞は、その札自身からもう使える
    const here = new Set(declared);
    for (const prefix of declaredPrefixes(parsed.token)) here.add(prefix);
    const undeclared = undeclaredPrefix(parsed.token, here);
    if (undeclared) {
      return fail(
        `名前空間 ${undeclared}: が宣言されていません` +
          `（根の <svg> へ xmlns:${undeclared}="…" を足してください）`
      );
    }

    tokens.push(parsed.token);
    if (!parsed.token.selfClosing) {
      stack.push(parsed.token.name);
      declaredStack.push(declared);
      declared = here;
    } else if (stack.length === 0) rootClosed = true;
    index = parsed.end;
  }

  if (stack.length > 0) return fail(`<${stack[stack.length - 1]}> が閉じていません`);
  if (!rootClosed) return fail("要素が1つもありません");
  return { ok: true, tokens };
}

/** その札が新しく宣言する接頭辞（`xmlns:xl="…"` の `xl`） */
function declaredPrefixes(token: XmlOpen): Set<string> {
  const out = new Set<string>();
  for (const attribute of token.attrs) {
    if (!attribute.name.startsWith("xmlns:")) continue;
    const prefix = attribute.name.slice("xmlns:".length);
    if (prefix) out.add(prefix);
  }
  return out;
}

/** 名前に付いた接頭辞。付いていなければ null */
function prefixOf(name: string): string | null {
  const colon = name.indexOf(":");
  return colon > 0 ? name.slice(0, colon) : null;
}

/**
 * 宣言されていない接頭辞を使っている名前。無ければ null。
 *
 * **足さずに断る**（0.37.5の裁定）。`xlink` だけを知っていて根へ
 * `xmlns:xlink` を補う手もあったが、それでは「どの接頭辞なら直して
 * もらえるのか」が図録の中に隠れ、`xl:` で書いた同じ絵は断られる。
 * 規則を1つにしておけば、断り文が直し方そのものになる——断って失うのは
 * 飾り1つで、**本は開く**。
 */
function undeclaredPrefix(
  token: XmlOpen,
  declared: ReadonlySet<string>
): string | null {
  const elementPrefix = prefixOf(token.name);
  if (elementPrefix && !declared.has(elementPrefix)) return elementPrefix;

  for (const attribute of token.attrs) {
    // 宣言そのもの（`xmlns` / `xmlns:…`）は接頭辞の使用ではない
    if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) {
      continue;
    }
    const prefix = prefixOf(attribute.name);
    if (prefix && !declared.has(prefix)) return prefix;
  }
  return null;
}

/** DOCTYPE の終わり。内部サブセットの `]` をまたぐ */
function doctypeEnd(source: string, start: number): number {
  let index = start + 2;
  let inSubset = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "[") inSubset = true;
    else if (character === "]") inSubset = false;
    else if (character === ">" && !inSubset) return index + 1;
    index += 1;
  }
  return -1;
}

type OpenTagScan =
  | { ok: true; token: XmlOpen; end: number }
  | { ok: false; reason: string };

function parseOpenTag(source: string, start: number): OpenTagScan {
  const nameMatch = NAME_PATTERN.exec(source.slice(start + 1));
  if (!nameMatch) return { ok: false, reason: "要素の名前を読めません" };

  const name = nameMatch[0];
  const attrs: XmlAttr[] = [];
  let index = start + 1 + name.length;

  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) break;

    if (source.startsWith("/>", index)) {
      return {
        ok: true,
        token: { kind: "open", name, attrs, selfClosing: true },
        end: index + 2,
      };
    }
    if (source[index] === ">") {
      return {
        ok: true,
        token: { kind: "open", name, attrs, selfClosing: false },
        end: index + 1,
      };
    }

    const attributeMatch = NAME_PATTERN.exec(source.slice(index));
    if (!attributeMatch) {
      return { ok: false, reason: `<${name}> の属性を読めません` };
    }
    index += attributeMatch[0].length;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] !== "=") {
      // 値の無い属性はXMLでは書けない（HTMLの書き方が混ざっている）
      return { ok: false, reason: `属性 ${attributeMatch[0]} に値がありません` };
    }
    index += 1;
    while (index < source.length && /\s/.test(source[index])) index += 1;

    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      return {
        ok: false,
        reason: `属性 ${attributeMatch[0]} の値が引用符で囲まれていません`,
      };
    }
    const end = source.indexOf(quote, index + 1);
    if (end < 0) {
      return { ok: false, reason: `属性 ${attributeMatch[0]} の値が閉じていません` };
    }
    const raw = source.slice(index + 1, end);
    const bad = badEntity(raw);
    if (bad) return { ok: false, reason: bad };
    // **同じ属性を2度書いた札は整形式ではない。** 通すと、断片を差し込んだ
    // XHTMLごと開けなくなる（飾り1つで本が壊れる）。どちらの値が勝つかは
    // 読み手次第なので、こちらで選ばずに断る
    if (attrs.some((existing) => existing.name === attributeMatch[0])) {
      return { ok: false, reason: `属性 ${attributeMatch[0]} が2つあります` };
    }
    attrs.push({ name: attributeMatch[0], value: unescapeXml(raw) });
    index = end + 1;
  }

  return { ok: false, reason: `<${name}> が閉じていません` };
}

/**
 * 通せない実体参照。**XMLの5つと数値参照だけを通す。**
 *
 * DOCTYPE を落とすので、そこで定義された実体は本の中で未定義になる。
 * 未定義の実体は「開けないXHTML」を作る——飾り1つで本そのものが壊れる。
 */
function badEntity(text: string): string | null {
  for (const match of text.matchAll(/&([^;\s]*)(;?)/g)) {
    const body = match[1];
    // **`;` は省けない。** `A &amp B` を通していたころは、名前だけを見て
    // 「XMLの5つ」と読んでいた——実際には `&` が生のまま残っており、
    // XHTMLとして開けない断片になる
    if (!match[2]) {
      return `実体参照 &${body} が ; で終わっていません`;
    }
    if (/^#(\d+|x[0-9a-fA-F]+)$/.test(body)) continue;
    if (["amp", "lt", "gt", "quot", "apos"].includes(body)) continue;
    return `使えない実体参照 &${body}; があります`;
  }
  return null;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
