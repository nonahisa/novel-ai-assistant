/**
 * 脚本の行の種別と、その組み方（設計書6.70）。
 *
 * 脚本（作品タイプ `script`）の原稿は、柱・ト書き・セリフの3つが決まった
 * 形で並ぶ。雛形（`core/episodeTemplate.ts`）が示しているのと同じ形である。
 *
 *   ○駅前・夜          … 柱（hashira）。場面の見出し
 *   　太郎、ドアを開ける。 … ト書き（togaki）。全角空白で字下げする
 *   太郎「行こう」        … セリフ（serifu）。役名のあとに「」
 *
 * **判定は文字列の形だけを見る。** 本文の意味も、登場人物の台帳も見ない
 * ——設定資料に無い役名でもセリフとして組めるし、ルビ記法
 * （`｜太郎《たろう》` `{太郎|たろう}`）が役名に混ざっても、ただの字として
 * 数えるだけで壊れない。
 *
 * ## ここは vscode に触らない（純粋関数）
 *
 * 同じ答えを、原稿エディタの画面（`views/manuscriptEditorHtml.ts`）と
 * PDF（`core/printHtml.ts`）の両方が使う。**組み方の指定（CSS）も
 * ここが持つ**——写しを置くと、画面と紙で組み方が食い違う日が来る。
 */

/** 行の種別。どれにも当たらない行は plain（空行も plain） */
export type ScriptLineKind = "hashira" | "togaki" | "serifu" | "plain";

/** 印の付く種別（plain には class を付けない） */
export type ScriptLineMarkedKind = Exclude<ScriptLineKind, "plain">;

export interface ScriptLineRule {
  kind: ScriptLineMarkedKind;
  /**
   * 正規表現の本体。**文字列で持つ。**
   *
   * 原稿エディタの画面側JS（webviewのテンプレート文字列の中）へ、この
   * ままの形で埋め込むためである。あちらは `import` が効かないので、
   * 判定を写して書くと**片方だけが直る日が来る**（記法の定義
   * `core/manuscriptRender.ts` と同じ作法）。
   */
  pattern: string;
}

/**
 * 種別の見分け方。**この順に見る。**
 *
 * 柱を先に見るのは、`○喫茶「みなと」` のような柱がセリフの形にも
 * 当たるためである。ト書きをセリフより先に見るのも同じ理由
 * （`　太郎「…」` は、字下げされている以上ト書きの中の引用である）。
 *
 * 見た目で区別の付かない字は符号で書く。`○`（U+25CB）と `〇`（U+3007、
 * 漢数字のゼロ）は別の文字だが画面では同じに見え、IMEによっては後者が
 * 先に出る。`　`（U+3000、全角空白）は、そもそも目に見えない。
 */
export const SCRIPT_LINE_RULES: readonly ScriptLineRule[] = [
  // 柱。行頭の ○（U+25CB）または 〇（U+3007）
  { kind: "hashira", pattern: "^[\\u25CB\\u3007]" },
  // ト書き。行頭の全角空白（U+3000）
  { kind: "togaki", pattern: "^\\u3000" },
  /*
    セリフ。行頭から `「` までが1〜12字で、空白も「」も含まないこと。

    - **いきなり `「` で始まる行はセリフにしない。** 小説の会話文と
      同じ形なので、拾うと脚本以外の書き方まで巻き込む
    - **12字まで。** 長い前置きのある地の文（「…と言って、太郎は「行こう」）を
      役名と読み違えないための上限である
    - `\s` は全角空白も含む（役名の中に空白は入らない）
  */
  { kind: "serifu", pattern: "^[^\\s「」]{1,12}「" },
];

/** 行ごとに作り直さない（4万字の原稿では行数ぶん効く） */
const MATCHERS = SCRIPT_LINE_RULES.map((rule) => ({
  kind: rule.kind,
  regexp: new RegExp(rule.pattern),
}));

/** 種別に付ける class。**名前の定義はここだけ**（画面側JSへも渡す） */
export const SCRIPT_LINE_CLASSES: Record<ScriptLineKind, string> = {
  hashira: "script-hashira",
  togaki: "script-togaki",
  serifu: "script-serifu",
  // plain には印を付けない。付けると「何でもない行」にも規則が当たる
  plain: "",
};

export function classifyScriptLine(line: string): ScriptLineKind {
  for (const matcher of MATCHERS) {
    if (matcher.regexp.test(line)) return matcher.kind;
  }
  return "plain";
}

/** その行に付ける class。plain なら空文字 */
export function scriptLineClass(line: string): string {
  return SCRIPT_LINE_CLASSES[classifyScriptLine(line)];
}

/**
 * セリフの行を、役名と発話に分ける。
 *
 * **括弧付きの指示（`太郎（小声）「…」`）は役名の側に含める。** 誰の
 * どういう言い方かはひとまとまりで、発話そのものではない。
 *
 * **足すと元の行に戻る**（`role + speech === line`）。1文字も落とさない
 * ことを守っておけば、この分け方をどこで使っても本文が消えない。
 *
 * セリフでない行には何も返さない。
 */
export function splitSerifu(
  line: string
): { role: string; speech: string } | undefined {
  if (classifyScriptLine(line) !== "serifu") return undefined;
  // 種別の規則が「行頭から1〜12字のあとに `「`」を保証しているので、
  // 最初の `「` が発話の始まりである
  const at = line.indexOf("「");
  return { role: line.slice(0, at), speech: line.slice(at) };
}

/**
 * 脚本の組み方（CSS）。**定義はここ1か所。**
 *
 * 原稿エディタの画面と、PDFの印刷用スタイルの**両方がこの文字列を
 * そのまま埋め込む**。値を写すと、画面で見た組み方と刷った紙の組み方が
 * 別物になる（作者は画面を見て書くので、ずれに気づくのは刷ったあと）。
 *
 * ## 縦書き・横書きの両方で効かせる（論理プロパティ）
 *
 * 脚本は縦書きで開く（`core/manuscriptViewTypes.ts`）が、横書きで書く人も
 * PDFのA4横組みもある。`padding-left` で書くと、縦書きにしたとき字下げが
 * 行頭ではなく紙の左へ寄る。`padding-inline-start` は「行の始まり」を
 * 指すので、どちらの向きでも同じ場所に効く。
 *
 * ## 柱の間隔を margin ではなく padding で空ける
 *
 * 埋め込み先の片方（原稿エディタ）には `#compose p { margin: 0; }` という
 * **id を含む規則**が既にあり、class だけの規則では打ち消せない
 * （`.script-hashira` より `#compose p` のほうが強い）。padding は
 * どちらの埋め込み先でも誰も指定していないので、同じ値が両方で効く。
 * ここを margin で書くと、**紙では空くのに画面では空かない**。
 *
 * ## セリフのぶら下げは、役名の長さを見ない
 *
 * 折り返した2行目を `「` の位置へ揃えるには、役名の幅だけ字下げすればよい
 * （`padding-inline-start` と、同じ幅の負の `text-indent`）。役名の長さは
 * 行ごとに違うが、**6em に決め打つ**。行ごとに幅を測って書き分けるには
 * 行を要素で包む必要があり、組んで書く面（contenteditable）では
 * 要素を足した時点で本文の直列化がずれる（＝原稿が壊れる）。
 * 役名が6字を超える行では2行目の頭が揃わないが、**揃わないだけで
 * 本文は無傷**である。
 */
export const SCRIPT_LINE_CSS = [
  "/* 脚本の組み方（設計書6.70。定義は core/scriptLines.ts の SCRIPT_LINE_CSS） */",
  ".script-hashira {",
  "  font-weight: bold;",
  "  /* 場面の変わり目。前に1行ぶん空ける */",
  "  padding-block-start: 1em;",
  "}",
  "/* ト書きは、本文の全角空白1字に加えて2字ぶん下げる（合わせて約3字） */",
  ".script-togaki { padding-inline-start: 2em; }",
  "/* 折り返した行を、役名のうしろ（「の位置）へ揃える */",
  ".script-serifu {",
  "  padding-inline-start: 6em;",
  "  text-indent: -6em;",
  "}",
].join("\n");
