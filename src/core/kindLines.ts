import {
  SCRIPT_LINE_CLASSES,
  SCRIPT_LINE_CSS,
  SCRIPT_LINE_RULES,
} from "./scriptLines";
import type { WorkKindKey } from "./workKind";

/**
 * 種類ごとの「行の組み方」（設計書6.109）。
 *
 * 台本の行の見分け方（`core/scriptLines.ts`、設計書6.70.2）を、ほかの
 * 種類にも同じ仕組みで広げたもの。**行の文字列の形だけを見て印（class）を
 * 付ける**——DOMの形は変えない。組んで書く面（contenteditable）で要素を
 * 1つでも足すと、直列化がずれて原稿が壊れる（6.70.2 と同じ理由）。
 *
 * 使う側は3つで、**同じ規則・同じCSSをそのまま埋め込む**：
 * 原稿エディタ（`views/manuscriptEditorHtml.ts`）・PDF（`core/printHtml.ts`）・
 * EPUB（`core/epubXhtml.ts`／`core/epubPackage.ts`）。写しを置くと、画面で
 * 見た組み方と紙・本の組み方が別物になる。
 *
 * **小説では規則もCSSも空**である。どの画面の出来上がりも、種類を渡さない
 * ときと1バイトも変わらない。
 *
 * VS Code APIに依存しない。
 */

export interface KindLineRule {
  /** 付ける class。**名前の定義はここ（台本は scriptLines）だけ** */
  cls: string;
  /** 正規表現の本体。画面側JSへ文字列のまま埋め込むため、文字列で持つ */
  pattern: string;
}

/** 台本の規則を、class 付きの形へ（定義は scriptLines の1か所のまま） */
const SCRIPT_RULES: readonly KindLineRule[] = SCRIPT_LINE_RULES.map((rule) => ({
  cls: SCRIPT_LINE_CLASSES[rule.kind],
  pattern: rule.pattern,
}));

const TOGAKI_RULE = SCRIPT_RULES.find((rule) => rule.cls === SCRIPT_LINE_CLASSES.togaki)!;
const SERIFU_RULE = SCRIPT_RULES.find((rule) => rule.cls === SCRIPT_LINE_CLASSES.serifu)!;

/**
 * 漫画の原作。**この順に見る**（先に当たったものが勝つ）。
 *
 * ページ（行頭の ■ U+25A0）とコマ（行頭の □ U+25A1）を先に見る。
 * 絵の説明（全角空白の字下げ）と台詞（人物名「…」）は台本と同じ規則を借りる
 * ——同じ形の行が、種類によって違う組み方になるのは紛らわしい。
 */
const MANGA_RULES: readonly KindLineRule[] = [
  { cls: "manga-page", pattern: "^\\u25A0" },
  { cls: "manga-panel", pattern: "^\\u25A1" },
  TOGAKI_RULE,
  SERIFU_RULE,
];

/**
 * エッセイ・記事。見出しは行頭の ■（.txt でも書ける）と、Markdown の
 * `# ` 〜 `### `（.md で書く人向け）。
 */
const ESSAY_RULES: readonly KindLineRule[] = [
  { cls: "essay-heading", pattern: "^(?:\\u25A0|#{1,3}\\s)" },
];

/** 歌詞・詩。行ぜんたいが【…】の行は、節の札として組む */
const LYRICS_RULES: readonly KindLineRule[] = [
  { cls: "lyrics-label", pattern: "^\\s*\\u3010[^\\u3010\\u3011]*\\u3011\\s*$" },
];

const MANGA_CSS = [
  "/* 漫画の原作の組み方（設計書6.109。定義は core/kindLines.ts） */",
  ".manga-page {",
  "  font-weight: bold;",
  "  /* ページの変わり目。前を空けて線を引く */",
  "  padding-block-start: 1em;",
  "  border-block-start: 1px solid currentColor;",
  "}",
  ".manga-panel { font-weight: bold; padding-block-start: 0.5em; }",
].join("\n");

const ESSAY_CSS = [
  "/* エッセイ・記事の組み方（設計書6.109。定義は core/kindLines.ts） */",
  ".essay-heading {",
  "  font-weight: bold;",
  "  font-size: 1.15em;",
  "  padding-block-start: 1em;",
  "}",
].join("\n");

const LYRICS_CSS = [
  "/* 歌詞・詩の組み方（設計書6.109。定義は core/kindLines.ts） */",
  ".lyrics-label {",
  "  font-size: 0.85em;",
  "  font-weight: bold;",
  "  opacity: 0.75;",
  "  padding-block-start: 1em;",
  "}",
].join("\n");

/** その種類の規則。**小説と未設定は空** */
export function kindLineRules(
  kind: WorkKindKey | undefined
): readonly KindLineRule[] {
  switch (kind) {
    case "script":
      return SCRIPT_RULES;
    case "manga":
      return MANGA_RULES;
    case "essay":
      return ESSAY_RULES;
    case "lyrics":
      return LYRICS_RULES;
    default:
      return [];
  }
}

/**
 * その種類の組み方（CSS）。**小説と未設定は空文字。**
 *
 * 漫画の原作は、台本のト書き・台詞の組み方（SCRIPT_LINE_CSS）もそのまま使う
 * （同じ class を付けるので、同じ規則で組まれる）。
 */
export function kindLineCss(kind: WorkKindKey | undefined): string {
  switch (kind) {
    case "script":
      return SCRIPT_LINE_CSS;
    case "manga":
      return `${SCRIPT_LINE_CSS}\n${MANGA_CSS}`;
    case "essay":
      return ESSAY_CSS;
    case "lyrics":
      return LYRICS_CSS;
    default:
      return "";
  }
}

/** 規則ごとに作り直さない（4万字の原稿では行数ぶん効く） */
const MATCHERS = new Map<string, Array<{ cls: string; regexp: RegExp }>>();

function matchersFor(kind: WorkKindKey | undefined) {
  const key = kind ?? "";
  let found = MATCHERS.get(key);
  if (!found) {
    found = kindLineRules(kind).map((rule) => ({
      cls: rule.cls,
      regexp: new RegExp(rule.pattern),
    }));
    MATCHERS.set(key, found);
  }
  return found;
}

/** その行に付ける class。どれにも当たらなければ空文字 */
export function kindLineClass(
  kind: WorkKindKey | undefined,
  line: string
): string {
  for (const matcher of matchersFor(kind)) {
    if (matcher.regexp.test(line)) return matcher.cls;
  }
  return "";
}
