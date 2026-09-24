/**
 * 作中の日付を、本文とあらすじから読み取って数える（設計書6.10.9）。
 *
 * **引き算をAIにさせない。** 答え付きの台には「十月三日に折ったのに、
 * 十二月八日の話で『ちょうど二週間が過ぎた』」という仕込みがあるが、
 * `gemma4:26b-a4b` でも `qwen3.8-27b` でも3回とも見逃した（設計書6.10.6）。
 * 日付の引き算は、言語モデルがいちばん苦手にしているものの一つである。
 * **こちらで数えて材料として渡し、突き合わせだけをAIにさせる。**
 *
 * **年表（`設定/timeline.json`）は読まない。** 作者の指摘は「時系列構造が
 * 無い／不備」なので、**構造を作らせずに効く**形にした——日付は作者が
 * 本文とあらすじに既に書いている。年表を作ってもらう前提にすると、
 * 作らない作品では何も変わらない。
 *
 * **推測で埋めない。** 月日がそろって書かれた表記だけを読み、
 * 「九月の終わり」「三日後」「王暦312年春」のような曖昧・相対・架空の暦は
 * 黙って落とす。この製品は「迷ったら出さない」で通している。
 */

/** 読み取れた、その話の作中の日付 */
export interface StoryDate {
  chapter: number;
  /** 本文に書かれていた表記そのもの（「十月三日」）。作者の言葉で見せる */
  text: string;
  month: number;
  day: number;
  /** いちばん前の話を起点にした通算の日数。年またぎを推定して数える */
  dayNumber: number;
}

/** 漢数字（月日に使う範囲だけ）。「百」「千」は日付には出ない */
const KANJI_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 平年の各月の日数。**閏年は考えない**（下の `dayOfYear` の注釈） */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * 「◯月◯日」の形だけを拾う。
 *
 * **数字と「月」「日」が直に続く形だけ**にしてある。「十月の三日」のように
 * 間に語が挟まるものまで拾うと、「十月の終わりから三日」のような相対表現を
 * 日付として読み違える。
 */
const DATE_PATTERN = /([0-9０-９一二三四五六七八九十]{1,3})月([0-9０-９一二三四五六七八九十]{1,3})日/g;

/**
 * 日付のうしろに続いたら、**期間の長さ**として書かれている疑いがある語。
 *
 * 「一月十日ほど」（＝1か月と10日ほど）のような書き方があるので、
 * こういう語が続くものは日付として採らない。**読めないものは落とす**が、
 * 読み違えるよりは落ちるほうが安全である。
 */
const RELATIVE_SUFFIX = /^(後|前|間|目|ぶり|ほど|余り|あまり|ばかり|近く)/;

/**
 * 全角の数字を半角へ寄せる。作者の原稿では全角のほうがむしろ多い。
 */
function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
}

/**
 * 「十一」「二十三」のような漢数字を数へ直す。**31まで**しか要らない。
 *
 * 日付に出ない形（「二三」のような桁の並記、「十〇」）は null を返して
 * 落とす——**読めないものを推測で埋めない。**
 */
function parseKanjiNumber(text: string): number | null {
  const tenIndex = text.indexOf("十");
  if (tenIndex < 0) {
    // 「三」のような一桁だけ。「二三」は日付の書き方ではないので採らない
    if (text.length !== 1) return null;
    return KANJI_DIGITS[text] ?? null;
  }

  const head = text.slice(0, tenIndex);
  const tail = text.slice(tenIndex + 1);

  let tens = 1; // 「十日」は10日
  if (head !== "") {
    if (head.length !== 1) return null;
    const value = KANJI_DIGITS[head];
    if (value === undefined) return null;
    tens = value;
  }

  let ones = 0;
  if (tail !== "") {
    if (tail.length !== 1) return null;
    const value = KANJI_DIGITS[tail];
    if (value === undefined) return null;
    ones = value;
  }

  return tens * 10 + ones;
}

/** 漢数字・算用数字（半角/全角）のどちらでも読む。読めなければ null */
function parseNumber(raw: string): number | null {
  const halfWidth = toHalfWidthDigits(raw);
  if (/^[0-9]{1,2}$/.test(halfWidth)) return Number(halfWidth);
  return parseKanjiNumber(raw);
}

/**
 * 1月1日を1とした通日。
 *
 * **閏年は考えない**（設計書6.10.9）。年が書かれていない前提で数えるので、
 * 閏年かどうかを決めようがない。ずれても1日で、比べる相手は「二週間」対
 * 「66日」のような桁違いの食い違いである。
 */
function dayOfYear(month: number, day: number): number {
  let total = day;
  for (let index = 0; index < month - 1; index++) {
    total += DAYS_IN_MONTH[index];
  }
  return total;
}

/** その本文に**いちばん先に**出てくる日付。読めなければ null */
function firstDateIn(text: string): { text: string; month: number; day: number } | null {
  DATE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DATE_PATTERN.exec(text)) !== null) {
    const rest = text.slice(match.index + match[0].length);
    // 「十月三日ぶり」のような期間の書き方は日付ではない
    if (RELATIVE_SUFFIX.test(rest)) continue;

    const month = parseNumber(match[1]);
    const day = parseNumber(match[2]);
    if (month === null || day === null) continue;
    // 「十三月」「三十五日」は暦に無い。読み違えているので落とす
    if (month < 1 || month > 12) continue;
    if (day < 1 || day > 31) continue;

    return { text: match[0], month, day };
  }
  return null;
}

/**
 * 話ごとの日付を読む。
 *
 * **話数の順に並べて数える。** 年は書かれていない前提で、月日が前の話より
 * 前へ戻ったら翌年とみなして通算する——**回想や時間の前後がある作品では、
 * この数えが合わない**（欄の文面でそう断っている）。
 *
 * **同じ話に複数あれば、いちばん先に出たものだけ**を採る。場面転換で
 * 複数出るが、どれがその話の「今」かは機械には決められない。
 */
export function readStoryDates(
  sources: readonly { chapter: number; text: string }[]
): StoryDate[] {
  // 同じ話が2つに分かれて渡ることがある（あらすじと本文、合本の中の話）。
  // **繋いでから読む**——片方に日付が無いだけで落とすことにならない
  const textByChapter = new Map<number, string>();
  for (const source of sources) {
    if (!Number.isInteger(source.chapter)) continue;
    const previous = textByChapter.get(source.chapter);
    textByChapter.set(
      source.chapter,
      previous === undefined ? source.text : `${previous}\n${source.text}`
    );
  }

  const chapters = [...textByChapter.keys()].sort((a, b) => a - b);
  const dates: StoryDate[] = [];
  let year = 0;
  let previousInYear: number | null = null;
  for (const chapter of chapters) {
    const found = firstDateIn(textByChapter.get(chapter) ?? "");
    if (!found) continue;

    const inYear = dayOfYear(found.month, found.day);
    // 月日が前の話より前へ戻ったら、年が変わったとみなす（十二月→一月）
    if (previousInYear !== null && inYear < previousInYear) year += 1;
    previousInYear = inYear;
    dates.push({
      chapter,
      text: found.text,
      month: found.month,
      day: found.day,
      dayNumber: year * 365 + inYear,
    });
  }

  if (dates.length === 0) return [];
  // **いちばん前の話を起点（0）にする。** 見せるのは日数の差だけなので、
  // 起点を揃えておくと呼ぶ側が引き算の基準を持たずに済む
  const base = dates[0].dayNumber;
  return dates.map((date) => ({ ...date, dayNumber: date.dayNumber - base }));
}

/**
 * あらすじの**書き出し**（最初の区切り——読点か句点の、先に来たほうまで）。
 *
 * **あらすじは「その話で何が起きたか」を時の順に書く**ので、その話の
 * 「いつ」は書き出しに来る——過去への言及は後ろに回る。答え付きの台の
 * 第4話のあらすじがまさにその形である。
 *
 * > 十一月の最初の月曜、**十月三日に折った**左の足首のギプスが外れる。
 * > 折ってから一か月が経っている。
 *
 * 先頭の「十一月の最初の月曜」は月日がそろっていないので読めない。
 * 絞らずに読むと、**そのあとの過去の日付を今日として拾い**、
 * 「第4話: 十月三日（第2話から0日）」と並んでしまう——第4話の「一か月が
 * 経っている」と食い違うので、**こちらが誤検出を生む。**
 * **誤って並べるくらいなら、読めないままにしておくほうがよい。**
 *
 * **一文（句点まで）では足りない。** 上の第4話は、**最初の一文の中に**
 * 過去の日付が入っている——句点で切っても「十月三日」が残る（実際に試して
 * 確かめた）。日付が**書き出しそのもの**にあるときだけを採るために、
 * 最初の読点でも切る。
 *
 * **これで台の3話とも狙いどおりになる。**
 * 第2話「十月三日、雨。……」→「十月三日、」＝読める。
 * 第5話「十二月八日、この冬の初雪。……」→「十二月八日、」＝読める。
 * 第4話「十一月の最初の月曜、……」→ 読めないまま落ちる。
 *
 * **本文には使わない。** 本文は場面がそのまま流れるので、頭から数えた
 * 最初の月日がその話の「いま」である見込みが高い。
 */
function openingOf(text: string): string {
  const end = text.search(/[、。]/);
  return end < 0 ? text : text.slice(0, end + 1);
}

/**
 * あらすじと本文を、話ごとに1本の文字列へ繋ぐ（`readStoryDates` の入力）。
 *
 * **2か所で組まない。** 製品（`features/checkContradictions.ts`）とMCP
 * （`mcp/tools/contradiction.ts`）が同じものを渡すので、組み方が分かれると
 * 「MCPで覗いたものと画面が送るものが別物」になる。
 *
 * **話数の分からないものは落とす。** 並べる場所が決められないし、
 * 「その話より後の日付は渡さない」（設計書6.10.3）も守れなくなる。
 */
export function buildStoryDateSources(
  synopses: readonly { chapter: number | null; synopsis: string }[],
  bodies: readonly { chapter: number | null; text: string }[]
): Array<{ chapter: number; text: string }> {
  const sources: Array<{ chapter: number; text: string }> = [];
  for (const item of synopses) {
    if (item.chapter === null) continue;
    // **あらすじは書き出しだけ**（`openingOf` の注釈）。
    // 過去の日付への言及を、その話の「今」として拾わないため
    sources.push({ chapter: item.chapter, text: openingOf(item.synopsis) });
  }
  for (const body of bodies) {
    if (body.chapter === null) continue;
    sources.push({ chapter: body.chapter, text: body.text });
  }
  return sources;
}

/**
 * プロンプトの欄にする（設計書6.10.9）。
 *
 * **読み取れたものが2件未満なら空文字**（＝欄を出さない）。1件では日数差が
 * 出ず、欄を出す意味がない。
 *
 * **その話より後の日付は並べない**（設計書6.10.3。`synopsesBefore` と同じ
 * 基準）。ただし**「この話」自身の日付は並べる**——欄の主役である。
 *
 * @param currentChapter いま見ている話数。null なら全部を「第N話:」で並べる
 */
export function describeStoryDates(
  dates: readonly StoryDate[],
  currentChapter: number | null
): string {
  const visible =
    currentChapter === null
      ? [...dates]
      : dates.filter((date) => date.chapter <= currentChapter);
  if (visible.length < 2) return "";

  const base = visible[0];
  const lines = visible.map((date, index) => {
    const label =
      currentChapter !== null && date.chapter === currentChapter
        ? `この話（第${date.chapter}話）`
        : `第${date.chapter}話`;
    // 起点の話に「0日」とは書かない（差の相手が自分自身になる）
    const gap =
      index === 0
        ? ""
        : `（第${base.chapter}話から${date.dayNumber - base.dayNumber}日）`;
    return `${label}: ${date.text}${gap}`;
  });

  return `【作中の日付】（本文とあらすじに書かれた表記から、機械が読み取って数えたものです）
${lines.join("\n")}

- 年は書かれていないので、**話の順に進むものとして数えています。** 回想や時間の前後がある作品では、この数えが合っていないことがあります。
- 読み取れなかった話（「九月の終わり」のような書き方）は並んでいません。
- **本文に「◯日が過ぎた」「◯週間ぶり」のような経過の記述があれば、上の日数と食い違っていないかを見てください。**
- 読み取った日付そのものが誤っている可能性もあります。断定せず、「日付ではこう、本文ではこう」と並べてください。`;
}
