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

/**
 * 台詞の役名の上限（字）。上の規則の `{1,12}` と同じ値で、役名の欄の幅の印
 * （`script-role-N`）をここまで用意する。2つがずれないことは
 * `test/unit/core/scriptLines.test.ts` が見張る
 */
export const SCRIPT_ROLE_MAX = 12;

/**
 * 人物名の欄の幅（字。作者の裁定、2026-10-17）。**台詞の頭（「「」）をこの位置に
 * そろえる。** 公募の納品用（`manuscriptGrid.ts`）・読む紙（`printHtml.ts`）・
 * 原稿エディター（`views/manuscriptEditorHtml.ts`）が同じ値を使う（定義はここだけ）。
 *
 * 5字にしたのは、作者の作品の人物の呼び名が4〜6字に集まっているため
 * （三門太志・春原月夜が4字、おばあさん・月夜ちゃんが5字、お手伝いさん・密倉家の会長が6字。
 * 確認用コピーの設定資料で数えた）。フルネームと「さん」付けまでが欄に収まり、
 * 6字の呼び名だけ1字ぶん後ろへずれる。欄より長い名前は切らない
 */
export const SCRIPT_ROLE_WIDTH = 5;

/**
 * 台詞の折り返した行を、「「」の位置からさらに何字下げるか（作者の裁定、2026-10-17：
 * 「2行目が「「」と同じ高さだと上すぎる。もう1字下げる」）。1なら「「」の次の字＝
 * 台詞の1字目の下にそろう。公募の納品用・読む紙・原稿エディターが同じ値を使う
 * （定義はここだけ）。EPUB の 6em の決め打ち（`SCRIPT_LINE_CSS`）には当てない
 */
export const SCRIPT_SPEECH_HANG = 1;

/**
 * 台本のト書きと柱の書体（作者の裁定、2026-10-17：台詞は明朝、ト書きと柱はゴシック）。
 *
 * **游ゴシックは Medium を先に置く。** Windows の Chrome・Edge で「Yu Gothic」とだけ
 * 指定すると細い字（Light）が選ばれ、紙では薄くかすれる
 */
export const SCRIPT_GOTHIC_FONT_FAMILY =
  '"Yu Gothic Medium", "游ゴシック Medium", "Yu Gothic", "游ゴシック", "YuGothic", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif';

/**
 * 台詞の行に付ける、ぶら下げの幅の印（`script-role-N`。N は「「」までの字数）。
 * 1〜`SCRIPT_ROLE_MAX` に収める
 */
export function scriptRoleClass(cells: number): string {
  const n = Math.min(SCRIPT_ROLE_MAX, Math.max(1, Math.round(cells)));
  return `script-role-${n}`;
}

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

/**
 * 台本の人物名の欄と書体（作者の裁定、2026-10-17）。**台本だけ**に当てる
 * （漫画の原作は台詞・ト書きの印を借りているが、ここは足さない）。原稿エディターと
 * 読む紙（`printHtml.ts`）がそのまま埋め込む。EPUB には足さない（`SCRIPT_LINE_CSS` だけ）。
 *
 * - **台詞の折り返しを「「」の次の字の下にそろえる**：行に付けた `script-role-N`（N は
 *   「「」の前までの字数）で、ぶら下げの幅（N ＋ `SCRIPT_SPEECH_HANG` 字）を行ごとに
 *   決める。`SCRIPT_LINE_CSS` の 6em の決め打ちより強い指定（class 2つ）なので、
 *   印の付いた行だけが置き換わる
 * - **人物名の欄**（読む紙だけ）：人物名を `span.script-role` で包み、欄の幅
 *   （`SCRIPT_ROLE_WIDTH`）より短ければ空ける。長い名前は欄を押し広げる（切らない）。
 *   原稿エディターは打つ面の中に要素を足せない（足すとカーソルと変換がずれる）ので、
 *   欄は作らず、行ごとの「「」の位置でぶら下げる
 * - **書体**：ト書きと柱はゴシック、台詞（人物名を含む）は本文の書体（明朝）のまま
 * - **面をまたいだ台詞の続き**（読む紙の `p.cont`）は、ぶら下げの位置から始める
 */
export const SCRIPT_LAYOUT_CSS = [
  "/* 台本の人物名の欄と書体（定義は core/scriptLines.ts の SCRIPT_LAYOUT_CSS） */",
  `.script-hashira, .script-togaki { font-family: ${SCRIPT_GOTHIC_FONT_FAMILY}; }`,
  ...Array.from({ length: SCRIPT_ROLE_MAX }, (_, index) => {
    const n = index + 1;
    const hang = n + SCRIPT_SPEECH_HANG;
    return `.script-serifu.script-role-${n} { padding-inline-start: ${hang}em; text-indent: -${hang}em; }`;
  }),
  `.script-role { display: inline-block; min-inline-size: ${SCRIPT_ROLE_WIDTH}em; text-indent: 0; }`,
  ".script-serifu.cont { text-indent: 0; }",
].join("\n");
