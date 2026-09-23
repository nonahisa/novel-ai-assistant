/**
 * 公募の「字数」の書き方を、下限・上限の字数へ読み替える（設計書6.3.6.1）。
 *
 * ## なぜコードで読むのか（AIを使わない）
 *
 * 応募先の字数は、作品目標の「あと何字」の元になる。AIに読ませると、読めない
 * 書き方にも数を作って返す——**読めないものは読めないと言う**ことが要るので、
 * 決まった規則で読み、規則に当たらなければ「読めない」を返す。
 *
 * ## 読む規則
 *
 * - 数字は全角・半角・桁区切り（1,000）と、漢数字の「万」「千」（3万2千）を読む
 * - 単位は「字・文字」はそのまま、「枚・ページ・頁」は1枚の字数を掛ける。
 *   1枚の字数は「400字詰」「原稿用紙」（400字）か「40字×30行」（1,200字）から取る。
 *   **1枚の字数が書かれていなければ読めない**（推し量らない）
 * - 「以上」は下限、「以下・以内・まで」は上限、「未満」は上限（その1つ手前）。
 *   「A〜B」「AからB」「A以上B以下」は幅
 * - あらすじ・タイトル・梗概などの字数は、本文の規定に数えない
 *
 * ## 読めないとする場合
 *
 * - 目安の1点だけ（「10,000字程度」）——下限か上限か決められない
 * - 規定が2つ以上あって食い違う（部門ごと・換算の違う2通り）
 * - 話ごとの規定（「各話2,000文字以上」）——作品全体の字数ではない
 *
 * VS Code API には依存しない。
 */

export type CharLimitReading =
  | {
      readonly kind: "range";
      /** 下限（字）。無ければ null */
      readonly min: number | null;
      /** 上限（字）。無ければ null */
      readonly max: number | null;
      /**
       * 枚数・ページ数から換算した値か。**換算は目安**なので、画面で
       * 「応募要項で確かめてください」と断る。字数そのものが書かれていれば false
       */
      readonly converted: boolean;
    }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** 400字詰の原稿用紙1枚の字数 */
const MANUSCRIPT_PAGE = 400;

/**
 * 2つの読みを「同じ」と見なす幅。「40字×30行で66枚以上」と「400字詰換算で200枚以上」
 * のように、募集側が丸めた換算を並べることがある（79,200字と80,000字）。
 */
const SAME_TOLERANCE = 0.03;

/** 字数の制限が無いことを言う書き方 */
const NO_LIMIT =
  /制限(?:なし|無し|は(?:設け|あり)ません|は設けない|を設けない|はない)|不問|規定(?:は|が)?(?:なし|無し|ございません|ありません)|[上下]限(?:[、,・]|および|と)?[上下]限(?:は|も)?(?:なし|無し|ありません)/u;

/** 作品全体でなく、1話ずつの規定 */
const PER_EPISODE = /各話|各エピソード|[1一]話(?:あたり|につき|ごと)|各回/u;

/** 本文でないものの字数（そこに付いた数は数えない） */
const NOT_BODY =
  /あらすじ|粗筋|梗概|タイトル|題名|キャッチ|要約|プロフィール|紹介文|プロット|コメント|ログライン|シノプシス/u;

/** 数のうしろの単位のうち、字数の読みに使うもの */
type Unit = "char" | "page";

interface Token {
  readonly start: number;
  /** 単位の終わり（方向の言葉の前） */
  readonly unitEnd: number;
  /** 方向の言葉まで含めた終わり */
  readonly end: number;
  value: number;
  unit: Unit | null;
  readonly multiplied: boolean;
  readonly direction: "min" | "max" | "below" | null;
  readonly approx: boolean;
}

interface PageSize {
  readonly at: number;
  readonly chars: number;
}

interface Reading {
  readonly min: number | null;
  readonly max: number | null;
  readonly converted: boolean;
}

export function readCharLimit(text: string | null | undefined): CharLimitReading {
  const source = (text ?? "").normalize("NFKC").trim();
  if (!source) return unreadable("字数の記載がありません。");
  if (PER_EPISODE.test(source)) {
    return unreadable("1話ごとの規定で、作品全体の字数が書かれていません。");
  }

  const { masked, pageSizes } = maskPageSizes(source);
  const tokens = findTokens(masked);
  const readings: { reading: Reading | "noPageSize" }[] = [];
  const used = new Set<Token>();

  // 幅（A〜B・A以上B以下）を先に組む
  for (let i = 0; i < tokens.length - 1; i++) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (used.has(left) || used.has(right)) continue;
    if (!pairs(masked, left, right)) continue;
    // 片方にしか単位・万が無ければ、もう片方へ写す（「8万～20万字」「1〜3万字」）
    if (left.unit === null) left.unit = right.unit;
    if (right.unit === null) right.unit = left.unit;
    if (left.unit === null) continue;
    if (!left.multiplied && right.multiplied && left.value < 100 && right.value >= 1000) {
      left.value *= multiplierOf(right.value);
    }
    if (isNotBody(masked, tokens, i, i + 1)) {
      used.add(left);
      used.add(right);
      continue;
    }
    used.add(left);
    used.add(right);
    readings.push({
      reading: toReading(
        left.value,
        right.value,
        left.unit,
        left.start,
        pageSizes,
        right.direction === "below"
      ),
    });
  }

  // 残りのうち、方向の言葉が付いたものだけを1つの読みにする（目安の1点は数えない）
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (used.has(token) || token.unit === null || token.direction === null) continue;
    if (isNotBody(masked, tokens, i, i)) continue;
    const reading =
      token.direction === "min"
        ? toReading(token.value, null, token.unit, token.start, pageSizes, false)
        : toReading(null, token.value, token.unit, token.start, pageSizes, token.direction === "below");
    readings.push({ reading });
  }

  if (readings.length === 0) {
    if (NO_LIMIT.test(source)) return { kind: "none" };
    const loose = tokens.some((token) => token.unit !== null);
    return unreadable(
      loose
        ? "目安の字数だけで、下限・上限が書かれていません。"
        : "字数の書き方を読めませんでした。"
    );
  }
  if (readings.some((entry) => entry.reading === "noPageSize")) {
    return unreadable("1枚あたりの字数が書かれていないため、字数へ換算できません。");
  }

  let merged: Reading | undefined;
  for (const entry of readings) {
    const reading = entry.reading as Reading;
    if (!merged) {
      merged = reading;
      continue;
    }
    const next = mergeReadings(merged, reading);
    if (!next) {
      return unreadable("字数の規定が2つ以上あり、どれを当てるか決められません。");
    }
    merged = next;
  }
  if (!merged) return unreadable("字数の書き方を読めませんでした。");
  if (merged.min !== null && merged.max !== null && merged.min > merged.max) {
    return unreadable("下限が上限を超えて読めてしまいました。");
  }
  return { kind: "range", min: merged.min, max: merged.max, converted: merged.converted };
}

function unreadable(reason: string): CharLimitReading {
  return { kind: "unreadable", reason };
}

/**
 * 1枚の字数の書き方を見つけ、**その数字を数として拾わないよう伏せる**。
 * 伏せるときは同じ長さの印で埋める——位置がずれると、どの換算がどの枚数に
 * 近いかが分からなくなる。
 */
function maskPageSizes(source: string): { masked: string; pageSizes: PageSize[] } {
  const pageSizes: PageSize[] = [];
  let masked = source;
  const cover = (start: number, length: number) => {
    masked = masked.slice(0, start) + "§".repeat(length) + masked.slice(start + length);
  };
  const patterns: { regex: RegExp; chars: (match: RegExpExecArray) => number }[] = [
    // 40字×30行・20字×20字・40文字×28行
    {
      regex: /(\d+)\s*(?:文字|字)?\s*[×xX*]\s*(\d+)\s*(?:行|文字|字)/gu,
      chars: (match) => Number(match[1]) * Number(match[2]),
    },
    // 400字×15枚（うしろの「15枚」は数として残す）
    {
      regex: /(\d+)\s*字\s*[×xX*]\s*(?=\d+(?:\.\d+)?\s*枚)/gu,
      chars: (match) => Number(match[1]),
    },
    // 400字詰め・400字誌（書き誤り）
    { regex: /(\d+)\s*字\s*(?:詰め?|誌)/gu, chars: (match) => Number(match[1]) },
    // 原稿用紙（字数の書き添えが無ければ400字）
    { regex: /原稿用紙/gu, chars: () => MANUSCRIPT_PAGE },
  ];
  for (const { regex, chars } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(masked)) !== null) {
      const size = chars(match);
      if (size > 0) pageSizes.push({ at: match.index, chars: size });
      cover(match.index, match[0].length);
      regex.lastIndex = match.index + match[0].length;
    }
  }
  return { masked, pageSizes: pageSizes.sort((a, b) => a.at - b.at) };
}

/** 数の並び。「A4」「第1回」のような、英字や数字に続く数は拾わない */
const NUMBER =
  /(?<![A-Za-z\d.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(万|千)?(?:\s*(\d+)\s*千)?\s*(文字|字|枚|ページ|頁|[^\s\d~〜\-‐－―ー、,。（）()［］\[\]「」『』／|:：=]{0,5})?/gu;

/** 字数でない単位（ここに当たる数は拾わない） */
const OTHER_UNIT =
  /^(?:行|話|回|円|歳|才|名|人|部|作|本|冊|位|年|月|日|時|分|秒|エピソード|点|割|%|段|組|号|章|ヶ月|か月|カ月|週|編|倍|度|件|通|種|色|ポイント|スコア|pt)/u;

function findTokens(masked: string): Token[] {
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  NUMBER.lastIndex = 0;
  while ((match = NUMBER.exec(masked)) !== null) {
    const [whole, digits, mult, extraThousands, rawUnit = ""] = match;
    const start = match.index;
    let value = Number(digits.replace(/,/gu, ""));
    if (!Number.isFinite(value)) continue;
    if (mult === "万") value *= 10000;
    if (mult === "千") value *= 1000;
    if (extraThousands) value += Number(extraThousands) * 1000;

    let unit: Unit | null = null;
    let unitLength = 0;
    if (rawUnit.startsWith("文字")) {
      unit = "char";
      unitLength = 2;
    } else if (rawUnit.startsWith("字")) {
      unit = "char";
      unitLength = 1;
    } else if (rawUnit.startsWith("枚") || rawUnit.startsWith("頁")) {
      unit = "page";
      unitLength = 1;
    } else if (rawUnit.startsWith("ページ")) {
      unit = "page";
      unitLength = 3;
    } else if (OTHER_UNIT.test(rawUnit)) {
      continue;
    }
    const unitEnd = start + whole.length - rawUnit.length + unitLength;
    // 「13枚目」「1ページ目」は順番であって量ではない
    if (masked[unitEnd] === "目") continue;

    const after = readAfter(masked, unitEnd);
    const before = masked.slice(Math.max(0, start - 4), start);
    let direction = after.direction;
    if (!direction && /(?:最大|上限は?|最長|最高)\s*$/u.test(before)) direction = "max";
    if (!direction && /(?:最低|最小|下限は?|最短)\s*$/u.test(before)) direction = "min";
    tokens.push({
      start,
      unitEnd,
      end: after.end,
      value,
      unit,
      multiplied: mult !== undefined,
      direction,
      approx: after.approx,
    });
    // 単位を読み過ぎた分（「字以内のあらすじ」の「以内の…」）は、次の数の探しに残す
    NUMBER.lastIndex = unitEnd;
  }
  return tokens;
}

/** 単位のうしろの言葉から、方向（以上・以下…）と目安かを読む */
function readAfter(
  masked: string,
  from: number
): { direction: Token["direction"]; approx: boolean; end: number } {
  let rest = masked.slice(from);
  let consumed = 0;
  let approx = false;
  const skip = /^(?:\s+|分|相当|換算|（[^（）\d]{0,12}）|\([^()\d]{0,12}\)|程度|前後|くらい|ぐらい|ほど|目安)/u;
  for (;;) {
    const match = skip.exec(rest);
    if (!match || match[0].length === 0) break;
    if (/程度|前後|くらい|ぐらい|ほど|目安/u.test(match[0])) approx = true;
    consumed += match[0].length;
    rest = rest.slice(match[0].length);
  }
  const words: [RegExp, NonNullable<Token["direction"]>][] = [
    // 「8万文字〜上限なし」は、下限だけを言っている
    [/^(?:以上|超|[~〜\-‐－―ー]?\s*(?:文字数)?(?:上限|制限)(?:なし|無し))/u, "min"],
    [/^(?:以下|以内|まで|迄)/u, "max"],
    [/^未満/u, "below"],
  ];
  for (const [word, direction] of words) {
    const match = word.exec(rest);
    if (match) return { direction, approx, end: from + consumed + match[0].length };
  }
  return { direction: null, approx, end: from + consumed };
}

/** 2つの数が1つの幅（A〜B・A以上B以下）を成すか */
function pairs(masked: string, left: Token, right: Token): boolean {
  const gap = masked
    .slice(left.unitEnd, right.start)
    .replace(/（[^（）\d]*）|\([^()\d]*\)|程度|前後|くらい|ぐらい|ほど|相当|換算|分|\s+/gu, "");
  if (/^(?:[~〜\-‐－―ー]|から|より)$/u.test(gap)) return true;
  if (left.direction === "min") {
    const rest = gap.replace(/^(?:以上|超)/u, "").replace(/[、,~〜\-‐－―ー]/gu, "");
    return rest === "" && right.direction !== "min";
  }
  return false;
}

/**
 * 本文でないもの（あらすじ・タイトル…）の字数か。前は1つ前の数から、
 * うしろは次の数までの近くを見る——遠くの「あらすじ」に引っ張られないように。
 */
function isNotBody(masked: string, tokens: readonly Token[], first: number, last: number): boolean {
  const beforeFrom = first > 0 ? tokens[first - 1].end : 0;
  // 句切り（空白・句点・／）より前は別の話なので見ない
  const before =
    masked
      .slice(Math.max(beforeFrom, tokens[first].start - 15), tokens[first].start)
      .split(/[\s。／|]/u)
      .pop() ?? "";
  const afterTo = last + 1 < tokens.length ? tokens[last + 1].start : masked.length;
  const after = masked.slice(tokens[last].end, Math.min(afterTo, tokens[last].end + 6));
  return NOT_BODY.test(before) || /^の?(?:あらすじ|粗筋|梗概|要約|タイトル|題名|キャッチ)/u.test(after);
}

function multiplierOf(value: number): number {
  return value >= 10000 ? 10000 : 1000;
}

/** 数を字数の読みにする。枚数なら、いちばん近い「1枚の字数」を掛ける */
function toReading(
  min: number | null,
  max: number | null,
  unit: Unit,
  at: number,
  pageSizes: readonly PageSize[],
  below: boolean
): Reading | "noPageSize" {
  if (unit === "char") {
    return { min, max: max !== null && below ? max - 1 : max, converted: false };
  }
  const size = nearestPageSize(at, pageSizes);
  if (size === null) return "noPageSize";
  const convert = (value: number | null): number | null =>
    value === null ? null : Math.round(value * size);
  // 「N枚未満」は、換算してから1つ手前にする（枚の1つ手前ではない）
  const convertedMax = max === null ? null : below ? Math.round(max * size) - 1 : convert(max);
  return { min: convert(min), max: convertedMax, converted: true };
}

/** 前にあるいちばん近いもの。前に無ければ、うしろのいちばん近いもの（「30〜100枚（400字詰換算）」） */
function nearestPageSize(at: number, pageSizes: readonly PageSize[]): number | null {
  const before = pageSizes.filter((size) => size.at < at);
  if (before.length > 0) return before[before.length - 1].chars;
  const after = pageSizes.find((size) => size.at > at);
  return after ? after.chars : null;
}

/** 2つの読みが食い違わなければ1つにまとめる（片方にしか無い側は補い合う） */
function mergeReadings(a: Reading, b: Reading): Reading | undefined {
  if (!compatible(a.min, b.min) || !compatible(a.max, b.max)) return undefined;
  // 字数そのものの書き方があれば、そちらの数を採る（換算は目安なので）
  const prefer = !a.converted || b.converted ? a : b;
  const other = prefer === a ? b : a;
  return {
    min: prefer.min ?? other.min,
    max: prefer.max ?? other.max,
    converted: a.converted && b.converted,
  };
}

function compatible(x: number | null, y: number | null): boolean {
  if (x === null || y === null) return true;
  return Math.abs(x - y) <= SAME_TOLERANCE * Math.max(x, y);
}
