import iconv = require("iconv-lite");

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

/** 止めたときの知らせに添える文（「2行目「かきくけ♡さしすせ」の「♡」」） */
export function describeUnencodable(found: readonly UnencodableChar[]): string {
  return found.map(({ char, line, context }) => `${line}行目「${context}」の「${char}」`).join("、");
}
