import iconv = require("iconv-lite");
import { sjisMarkPlaces } from "./sjisMarkFinding";

/**
 * Shift_JIS（CP932）の原稿へ書くときに、符号の無い字を置き換える表（設計書5.4.2。
 * 作者の決定 2026-11-08「黙って置き換える」・11-09「似た字に置き換える」）。
 *
 * **置き換えるのは、この表の字だけ**である。表に無い書けない字（♡・絵文字・ゔ・小書きの
 * カタカナ・U+2011 など）は、今までどおり保存を止める——似た字が1つに決まらないものを
 * 機械が選ぶと、作者の字が黙って別の字になる。
 *
 * 表の入れ方の決まり（`sjisFallback.test.ts` が全行を機械で確かめる）：
 *
 * - **元の字は Shift_JIS で往復できない**こと。往復できる字を入れると、書ける字まで変わる
 * - **置き換え先は往復できる**こと（iconv で戻しても、ブラウザの TextDecoder で戻しても）
 * - **元の字は、Shift_JIS のどのバイト列を復号しても出てこない**こと。だから元の本文
 *   （Shift_JIS から読んだ字）には決して含まれず、置き換えは必ず「作者やAIが新しく入れた字」
 *   にだけ当たる。変わらなかった所の元バイトをそのまま置く作り（5.4.2）を崩さない根拠
 *
 * 生の字では見分けにくい組（〜と～など）は、符号でも書いておく。
 */

/**
 * 黙って置き換える記号（作者の決定 2026-11-08）。
 *
 * Unicode の規格どおりの字（左）と、Windows の CP932 が持つ字（右）の組。Mac の日本語入力・
 * Unicode どおりに書き出す投稿サイトは左を出し、CP932 には左の符号が無い。
 * `bodyCompare.ts` の「比べる前に揃える組」も、ここから作る（写しを作らない）。
 */
export const SJIS_SYMBOL_SWAPS: ReadonlyArray<readonly [string, string]> = [
  ["〜", "～"], // 〜 波ダッシュ → ～ 全角チルダ（Mac の日本語入力が出す）
  ["—", "―"], // — emダッシュ → ― 横線（小説でよく使う）
  ["−", "－"], // − 負符号 → － 全角ハイフンマイナス
  ["‖", "∥"], // ‖ 双柱 → ∥ 平行
  ["¢", "￠"], // ¢ → ￠
  ["£", "￡"], // £ → ￡
  ["¬", "￢"], // ¬ → ￢
  ["¥", "￥"], // ¥ → ￥（そのままだと 0x5C の「\」になり、往復できない）
];

/**
 * Shift_JIS に無い漢字を、似た字（JIS X 0208 にある字体）へ置き換える（作者の決定 2026-11-09）。
 *
 * 根拠は2つの国の表に限る（**旧字体〈國・揭・擊 など〉は入れない**。旧字は作者が選んで
 * 書く字で、似た字ではない）：
 *
 * 1. **常用漢字表（2010年 内閣告示）の〔 〕内の許容字体。** 改定で入った字のうち、
 *    表の字体が JIS X 0208 に無く「〔 〕の字体で代えてよい」とされた4字
 *    （𠮟〔叱〕・塡〔填〕・剝〔剥〕・頰〔頬〕）。箸・餌・遡・遜・謎の点の違いは同じ符号の
 *    字形の差なので、置き換えは要らない
 * 2. **表外漢字字体表（2000年 国語審議会答申）の印刷標準字体のうち、JIS X 0208 に無く
 *    JIS X 0213:2004 で足された字**と、JIS X 0208 にある簡易慣用字体・慣用の字体
 *    （鷗〔鴎〕・噓〔嘘〕・繫〔繋〕など）
 */
export const SJIS_SIMILAR_KANJI: ReadonlyArray<readonly [string, string]> = [
  // 1. 常用漢字表（2010）の許容字体
  ["\u{20b9f}", "叱"], // 𠮟 → 叱
  ["塡", "填"], // 塡 → 填
  ["剝", "剥"], // 剝 → 剥
  ["頰", "頬"], // 頰 → 頬
  // 2. 表外漢字字体表（2000）の印刷標準字体 → JIS X 0208 の字体
  ["鷗", "鴎"], // 鷗 → 鴎
  ["繫", "繋"], // 繫 → 繋
  ["蔣", "蒋"], // 蔣 → 蒋
  ["屛", "屏"], // 屛 → 屏
  ["醬", "醤"], // 醬 → 醤
  ["潑", "溌"], // 潑 → 溌
  ["軀", "躯"], // 軀 → 躯
  ["鹼", "鹸"], // 鹼 → 鹸
  ["噓", "嘘"], // 噓 → 嘘
  ["搔", "掻"], // 搔 → 掻
  ["禱", "祷"], // 禱 → 祷
  ["摑", "掴"], // 摑 → 掴
  ["瘦", "痩"], // 瘦 → 痩
  ["蠟", "蝋"], // 蠟 → 蝋
  ["俱", "倶"], // 俱 → 倶
  ["嚙", "噛"], // 嚙 → 噛
  ["囊", "嚢"], // 囊 → 嚢
  ["姸", "妍"], // 姸 → 妍
  ["幷", "并"], // 幷 → 并
  ["屢", "屡"], // 屢 → 屡
  ["麴", "麹"], // 麴 → 麹
  ["萊", "莱"], // 萊 → 莱
  ["蟬", "蝉"], // 蟬 → 蝉
  ["繡", "繍"], // 繡 → 繍
  ["顚", "顛"], // 顚 → 顛
  ["焰", "焔"], // 焰 → 焔
  ["瀆", "涜"], // 瀆 → 涜
  ["痹", "痺"], // 痹 → 痺
  ["簞", "箪"], // 簞 → 箪
  ["吞", "呑"], // 吞 → 呑
];

/** 表の全行（記号 → 漢字の順） */
export const SJIS_FALLBACK_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ...SJIS_SYMBOL_SWAPS,
  ...SJIS_SIMILAR_KANJI,
];

const FALLBACK = new Map<string, string>(SJIS_FALLBACK_PAIRS.map(([from, to]) => [from, to]));

/** 表の元の字をまとめて拾う（`u` 旗：𠮟 はサロゲートの2単位で1字） */
const FALLBACK_PATTERN = new RegExp(`[${SJIS_FALLBACK_PAIRS.map(([from]) => from).join("")}]`, "gu");

/** 何の字を何に何個置き換えたか（ログに残す。作者には知らせない） */
export interface SjisSubstitution {
  from: string;
  to: string;
  count: number;
}

/**
 * 表の字を置き換える。**Shift_JIS の原稿へ書くときだけ**呼ぶ（UTF-8 の原稿では全部の字が書ける）。
 * 置き換えの並びは、最初に出てきた順。
 */
export function substituteForShiftJis(text: string): { text: string; substitutions: SjisSubstitution[] } {
  const counts = new Map<string, SjisSubstitution>();
  const replaced = text.replace(FALLBACK_PATTERN, (char) => {
    const to = FALLBACK.get(char) ?? char;
    const seen = counts.get(char);
    if (seen) seen.count += 1;
    else counts.set(char, { from: char, to, count: 1 });
    return to;
  });
  return { text: replaced, substitutions: [...counts.values()] };
}

/** 表の字が1つ、本文のどこにあるか（`index`・`length` は JavaScript の文字列の単位） */
export interface SjisSubstitutionSpan {
  index: number;
  /** 𠮟 はサロゲートの2単位で1字なので、置き換え先（1単位）と長さが違う */
  length: number;
  to: string;
}

/**
 * 表の字の場所を拾う（置き換えはしない）。VS Code の保存の直前に、**字ごとの小さな書き換え**を
 * 作るために使う（`features/shiftJisSave.ts`。全文を置き換えると取り消しの履歴とカーソルが崩れる）。
 * `substituteForShiftJis` と同じ表・同じ拾い方なので、並びと数は必ず揃う。
 */
export function findShiftJisSubstitutions(text: string): {
  spans: SjisSubstitutionSpan[];
  substitutions: SjisSubstitution[];
} {
  const spans: SjisSubstitutionSpan[] = [];
  const counts = new Map<string, SjisSubstitution>();
  for (const match of text.matchAll(FALLBACK_PATTERN)) {
    const char = match[0];
    const to = FALLBACK.get(char) ?? char;
    spans.push({ index: match.index ?? 0, length: char.length, to });
    const seen = counts.get(char);
    if (seen) seen.count += 1;
    else counts.set(char, { from: char, to, count: 1 });
  }
  return { spans, substitutions: [...counts.values()] };
}

/** ログへ残す1行の中身（「〜→～ 2個、𠮟→叱 1個」。本文の前後は書かない） */
export function describeSubstitutions(substitutions: readonly SjisSubstitution[]): string {
  return substitutions.map(({ from, to, count }) => `${from}→${to} ${count}個`).join("、");
}

/** 書けない字が1つ、どこにあるか */
export interface UnencodableChar {
  char: string;
  /** 1から数える行 */
  line: number;
  /** その行の前後の数文字（字はそのまま入っている） */
  context: string;
}

/** 前後に添える字数（字＝コードポイント） */
const CONTEXT_CHARS = 4;
/** 知らせに並べる数の上限（長い原稿で何百も並べない） */
const UNENCODABLE_LIMIT = 3;

function encodesInShiftJis(char: string): boolean {
  return iconv.decode(iconv.encode(char, "shift_jis"), "shift_jis") === char;
}

/**
 * Shift_JIS で書けない字を、行と前後の数文字つきで拾う（最初の3つまで）。
 * 置き換えを済ませた本文に対して呼ぶ（残ったものが、止める理由になる）。
 */
export function findUnencodableShiftJis(text: string): UnencodableChar[] {
  const found: UnencodableChar[] = [];
  // ほとんどの保存は全部書ける。全文を1回で確かめ、書けない字があるときだけ1字ずつ見る
  // （VS Code の保存の直前にも呼ぶ。受け口の持ち時間は1.5秒しかない）
  if (iconv.decode(iconv.encode(text, "shift_jis"), "shift_jis") === text) return found;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length && found.length < UNENCODABLE_LIMIT; index += 1) {
    const chars = Array.from(lines[index]);
    for (let at = 0; at < chars.length && found.length < UNENCODABLE_LIMIT; at += 1) {
      // 元の本文の読めないバイトは U+FFFD に読まれ、元のバイトのまま置くので書ける。
      // 数えると3件の枠を先に埋め、作者が入れた字が知らせから落ちる
      if (chars[at] === "�" || encodesInShiftJis(chars[at])) continue;
      found.push({
        char: chars[at],
        line: index + 1,
        context: chars.slice(Math.max(0, at - CONTEXT_CHARS), at + CONTEXT_CHARS + 1).join(""),
      });
    }
  }
  return found;
}

/**
 * 置き換え先の無い字の代わりに置く目印（U+3013 ゲタ記号。CP932 で 81 AC）。
 *
 * **作者が VS Code で打って保存する道だけ**で使う（作者の答え 2026-11-09「目印に置き換えた上で、
 * メモ校正パネルに説明を残して、ポップアップもあげてください」）。その道は保存を止められず、
 * 何もしなければ VS Code が黙って「?」にする。「?」は本文にも普通に出る字で、あとから
 * 探せない。〓は小説の本文にまず出ない字で、印刷でも「字が無い」の印として使われてきた。
 *
 * 拡張機能が書き戻す道（`writeTextFilePreservingFormat`）は今までどおり止める。
 */
export const SJIS_UNENCODABLE_MARK = "〓";

/** 読めないバイトの印（U+FFFD）。元のバイトのまま置く道があるので「〓」にしない */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/** 目印にした字が1つ、どこにあるか */
export interface SjisMark {
  /** 元の字（❤️ のように、1字に見える並びはまとめて1つ） */
  char: string;
  /** 1から数える行 */
  line: number;
  /**
   * 置き換えた**あと**の本文での、その行の前後の数文字（〓を含む）。
   * 校正・メモパネルの行が、保存したあとの本文から場所を探し直す鍵になる
   */
  context: string;
}

/** 保存の直前の置き換えの計画（`features/shiftJisSave.ts` が字ごとの書き換えにする） */
export interface ShiftJisSavePlan {
  /** 元の本文の位置での置き換え（表の字と目印の両方。前から順） */
  spans: SjisSubstitutionSpan[];
  /** 表の字を何に何個（ログ用） */
  substitutions: SjisSubstitution[];
  /** 目印にした字の全部（知らせの3件の枠で切らない） */
  marks: SjisMark[];
  /** 置き換えたあとの本文（保存されるもの） */
  text: string;
}

/**
 * 保存の直前に、表の字は表のとおりに、表に無く書けない字は目印の「〓」に置き換える計画を立てる。
 *
 * - 位置は**元の本文の単位**で取る（𠮟 は2単位で置き換え先は1単位。置き換えたあとから数えるとずれる）
 * - **1字に見える並びは〓1つ**にする（❤️ は ❤ と異体字セレクタの2つ、家族の絵文字は5つの符号から
 *   なる。符号ごとに置くと〓〓〓〓〓になり、作者には何が1字だったか分からない）。ただし並びの中に
 *   書ける字があるとき（か＋結合の半濁点）は、書けない符号だけを〓にする——作者の「か」を消さない
 * - 受け口の持ち時間は1.5秒しかないので、全文が書ければ1回で済ませ、書けない行だけを字ごとに見る
 */
export function planShiftJisSave(text: string): ShiftJisSavePlan {
  const table = findShiftJisSubstitutions(text);
  const tableText = substituteForShiftJis(text).text;
  if (encodesWhole(tableText)) {
    return { spans: table.spans, substitutions: table.substitutions, marks: [], text: tableText };
  }
  const needing = linesNeedingMarks(text);

  const markSpans: Array<SjisSubstitutionSpan & { char: string }> = [];
  const encodable = new Map<string, boolean>();
  const markable = (char: string): boolean => {
    if (char === REPLACEMENT_CHAR || FALLBACK.has(char)) return false;
    let known = encodable.get(char);
    if (known === undefined) {
      known = encodesInShiftJis(char);
      encodable.set(char, known);
    }
    return !known;
  };
  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  for (const { start, content } of needing) {
    for (const { segment, index } of segmenter.segment(content)) {
      const chars = Array.from(segment);
      if (chars.every(markable)) {
        markSpans.push({ index: start + index, length: segment.length, to: SJIS_UNENCODABLE_MARK, char: segment });
        continue;
      }
      let at = start + index;
      for (const char of chars) {
        if (markable(char)) markSpans.push({ index: at, length: char.length, to: SJIS_UNENCODABLE_MARK, char });
        at += char.length;
      }
    }
  }

  const spans = [...table.spans, ...markSpans.map(({ index, length, to }) => ({ index, length, to }))].sort(
    (a, b) => a.index - b.index
  );
  // 置き換えたあとの本文と、目印の置き換えたあとでの位置を、前から順に組む
  let replaced = "";
  let cursor = 0;
  const markIndices = new Set(markSpans.map(({ index }) => index));
  const markedAt = new Map<number, number>();
  for (const span of spans) {
    replaced += text.slice(cursor, span.index);
    if (markIndices.has(span.index)) markedAt.set(span.index, replaced.length);
    replaced += span.to;
    cursor = span.index + span.length;
  }
  replaced += text.slice(cursor);

  /*
    行と前後の字は、置き換えたあとの本文の〓を前から1回で拾って引く（校正・メモパネルが〓を探し直す
    `sjisMarkPlaces` と同じ決め方。写すと、記録した前後とパネルが探す前後が食い違う）。
    〓ごとに頭から数え直す形は、300万字に〓が200あるとそれだけで数百ミリ秒かかった
  */
  const places = new Map(sjisMarkPlaces(replaced).map((place) => [place.index, place]));
  const marks = markSpans.map((span) => {
    const place = places.get(markedAt.get(span.index) ?? 0);
    return { char: span.char, line: place?.line ?? 1, context: place?.context ?? SJIS_UNENCODABLE_MARK };
  });
  return { spans, substitutions: table.substitutions, marks, text: replaced };
}

/**
 * 全文が Shift_JIS で往復できるか。**できれば、保存の直前に置き換える字は1つも無い**——表の字も
 * 〓にする字も、往復できない字だけだから（表の決まり。`sjisFallback.test.ts` が全行を見張る）。
 * 保存の直前の受け口が、ファイルを読んで文字コードを確かめる前に早く抜けるために使う
 */
export function roundTripsInShiftJis(text: string): boolean {
  return encodesWhole(text);
}

function encodesWhole(text: string): boolean {
  return iconv.decode(iconv.encode(text, "shift_jis"), "shift_jis") === text;
}

/** 書けない字を探すとき、まとめて確かめる長さ（字。行の途中では切らず、次の LF のあとで切る） */
const CHUNK_UNITS = 65536;

/**
 * 表の字を置き換えてもなお書けない字のある行だけを返す（前から順）。
 *
 * **本文を約6万字ずつまとめて確かめ、書けない字のあるまとまりだけを1行ずつ見る。** iconv の往復は
 * 字ごとに決まる（前後の字に左右されない）ので、まとめて往復できればその中のどの行も往復できる。
 * 切れ目は LF のすぐあとにするので、行（CRLF も）がまとまりをまたがない（LF の無い CR だけの本文は
 * 1つのまとまりになるだけで、拾うものは変わらない）。
 * 1行ずつ往復させる形は、300万字（約8万行）で書けない字が1つあるだけで100ミリ秒あまりかかった
 * （2026-11-14 の測定。受け口の持ち時間は1.5秒）
 */
function linesNeedingMarks(text: string): Array<{ start: number; content: string }> {
  const needing: Array<{ start: number; content: string }> = [];
  for (let start = 0; start < text.length; ) {
    const newline = start + CHUNK_UNITS < text.length ? text.indexOf("\n", start + CHUNK_UNITS) : -1;
    const end = newline < 0 ? text.length : newline + 1;
    const chunk = text.slice(start, end);
    if (!encodesWhole(substituteForShiftJis(chunk).text)) {
      for (const line of linesWithOffsets(chunk)) {
        if (!encodesWhole(substituteForShiftJis(line.content).text)) {
          needing.push({ start: start + line.start, content: line.content });
        }
      }
    }
    start = end;
  }
  return needing;
}

/** 行の中身と、その行の頭の位置（改行は CRLF・CR・LF のどれでも1つに数える） */
function linesWithOffsets(text: string): Array<{ start: number; content: string }> {
  const lines: Array<{ start: number; content: string }> = [];
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  for (const match of text.matchAll(breaks)) {
    const at = match.index ?? 0;
    lines.push({ start, content: text.slice(start, at) });
    start = at + match[0].length;
  }
  lines.push({ start, content: text.slice(start) });
  return lines;
}

/** 止めたときの知らせに添える文（「2行目「かきくけ♡さしすせ」の「♡」」） */
export function describeUnencodable(found: readonly UnencodableChar[]): string {
  return found.map(({ char, line, context }) => `${line}行目「${context}」の「${char}」`).join("、");
}
