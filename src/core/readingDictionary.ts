import { isMemoLine } from "./sceneMemo";

/**
 * 読みの辞書（読み上げの読み違いを、話ごと・場所ごとに直す。設計書6.42.1）。
 *
 * ## なぜ「語ごとに1つの読み」にしないか
 *
 * 声が読み違えるのは、**読みが2通り以上ある語**である（十分＝じっぷん／
 * じゅうぶん、音＝おと／おん、一日＝ついたち／いちにち）。同じ語でも文で
 * 読みが変わるので、語だけを鍵にした辞書では片方の文を必ず読み違える。
 * そこで、**その語を含む短い句（本文の連続した引用）**を一緒に持ち、
 * 句が本文に在る場所だけへ読みを当てる（作者の選択、2026-10-18）。
 *
 * ## 位置ではなく句で持つ
 *
 * 文字の位置（オフセット）で持つと、前の行に1字足しただけで全部ずれる。
 * 句で持っておき、**当てるたびにいまの本文から句を探す**——本文を直しても、
 * 句が残っている項目はそのまま効き続ける（作り直さずに使い回せる）。
 * 句が見当たらなくなった項目は当てずに、一覧で「本文に見当たらない」と出す。
 *
 * ## ここは vscode に触らない
 *
 * 検算・当て方・混ぜ方は純粋な文字列処理で、単体テストで確かめる。
 * 読み書きは `readingDictionaryStore.ts`、AIを呼ぶのは `features/readingDictionary.ts`。
 */

/** 辞書の1項目 */
export interface ReadingEntry {
  /** 読みを当てる語（漢字を含む） */
  word: string;
  /** その語を含む、本文の連続した引用（句）。文脈を決める */
  quote: string;
  /** その場所での読み（ひらがなと長音だけ） */
  reading: string;
  /**
   * 誰が書いたか。**作者が直した・消した項目は、AIの作り直しで上書きしない**
   * （CLAUDE.md 実装ルール2）。作者が一度でも触ったら `author` になる。
   */
  source: "ai" | "author";
  /**
   * 作者が消した印（墓標）。**消しただけで行を落とすと、作り直しで同じ語が
   * 戻ってくる。** 印を残し、AIが同じ語・同じ句を返しても入れない。
   */
  removed?: boolean;
}

/** 声へ渡す写しの中で、読みに置き換える範囲（元の本文の位置） */
export interface ReadingSpan {
  start: number;
  end: number;
  reading: string;
}

/** 語の上限（字）。これより長いものは「語」ではなく句を返している */
export const READING_WORD_MAX = 8;
/**
 * 句の上限（字）。長い句は本文の書き換えで崩れやすく、AIが文を丸ごと
 * 写してくる（そのぶん、写し間違いで本文に見当たらなくなる）。
 */
export const READING_QUOTE_MAX = 30;
/** 読みの上限（字） */
export const READING_MAX = 16;

/**
 * 漢字（と、漢字の並びで使う 々 〆 ヶ）。
 *
 * **語に漢字が無ければ捨てる。** 仮名だけの語は声が読み違えない
 * （読み違えるのは、漢字の読みを声が選ぶときだけ）。
 */
export const KANJI = /[㐀-䶿一-鿿豈-﫿々〆ヶ]/;

/**
 * ひらがな（小書きを含む）と長音だけ。IMEで拾った読み（設計書6.42.2）も
 * 同じ範囲で見る——読み上げへ渡す読みの形を1つにする
 */
export const HIRAGANA_ONLY = /^[ぁ-ゖー]+$/;

/** 全角カタカナ（ァ〜ヶ）。ひらがなへ直す範囲 */
const KATAKANA = /[ァ-ヶ]/g;

/**
 * **指示の言葉がそのまま返ってくる前提で落とす**（CLAUDE.md「繰り返し起きた
 * 失敗」3）。プロンプトは「読み（ひらがな）」と頼んでいるので、読みの欄に
 * 頼み方の言葉そのものが入って返ることがある。
 *
 * 例に挙げた語（十分・音…）は**答えとして返ってきてよい**ので、ここには入れない。
 */
const ECHO_READINGS: ReadonlySet<string> = new Set([
  "ひらがな",
  "よみ",
  "よみかた",
  "よみがな",
  "ふりがな",
  "かな",
  "なし",
  "とくになし",
  "くうもじ",
  "くうはく",
  "ふめい",
  "わからない",
]);

/** 項目の見分け（語と句の組）。区切りは本文に現れない NUL */
export function readingEntryKey(entry: { word: string; quote: string }): string {
  return `${entry.word}\u0000${entry.quote}`;
}

/** カタカナで返ってきた読みをひらがなへ。**字を足しも削りもしない** */
export function toHiragana(text: string): string {
  return text.replace(KATAKANA, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60)
  );
}

/** 検算で捨てた理由（件数を記録へ残す） */
export type ReadingDropReason =
  | "形が違う"
  | "句が本文に無い"
  | "句が長すぎる"
  | "句が語だけ"
  | "語が句に無い"
  | "語に漢字が無い"
  | "語が長すぎる"
  | "読みがひらがなでない"
  | "読みが指示の言葉"
  | "読みの長さが合わない"
  | "送り仮名が合わない"
  | "重複";

export interface ReadingValidation {
  entries: ReadingEntry[];
  dropped: Array<{ reason: ReadingDropReason; item: unknown }>;
}

/**
 * AIの答え（項目の並び）を検算する。**AIを信用しない**（CLAUDE.md 実装ルール3）。
 *
 * 通すのは、次をすべて満たすものだけである。
 *
 * 1. 句が送った本文にそのまま在る（改行を含まない・上限以内・語より長い）
 * 2. 語が句の中に在り、漢字を含み、上限以内
 * 3. 読みがひらがなと長音だけ（カタカナはひらがなへ直してから見る）で、
 *    指示の言葉そのものではなく、長さが語と釣り合う
 * 4. 語の末尾の送り仮名が、読みの末尾と同じ（「上手い」なのに「じょうず」は捨てる）
 *
 * @param sourceText AIへ送った本文（句はこの中に在るはず）
 */
export function validateReadingItems(
  sourceText: string,
  items: readonly unknown[]
): ReadingValidation {
  const entries: ReadingEntry[] = [];
  const dropped: ReadingValidation["dropped"] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const reason = checkItem(sourceText, item);
    if (typeof reason === "string") {
      dropped.push({ reason, item });
      continue;
    }
    const key = readingEntryKey(reason);
    if (seen.has(key)) {
      dropped.push({ reason: "重複", item });
      continue;
    }
    seen.add(key);
    entries.push(reason);
  }
  return { entries, dropped };
}

function checkItem(
  sourceText: string,
  item: unknown
): ReadingEntry | ReadingDropReason {
  if (typeof item !== "object" || item === null) return "形が違う";
  const record = item as Record<string, unknown>;
  if (
    typeof record.word !== "string" ||
    typeof record.quote !== "string" ||
    typeof record.reading !== "string"
  ) {
    return "形が違う";
  }
  const word = record.word.trim();
  const quote = record.quote.trim();
  // 読みの中の空白（「じっ ぷん」）は字ではないので詰める
  const reading = toHiragana(record.reading.replace(/[\s　]+/g, ""));

  if (word === "" || quote === "") return "形が違う";
  if (quote.length > READING_QUOTE_MAX) return "句が長すぎる";
  if (/[\r\n]/.test(quote) || !sourceText.includes(quote)) return "句が本文に無い";
  if (word.length > READING_WORD_MAX) return "語が長すぎる";
  if (!quote.includes(word)) return "語が句に無い";
  /*
    **句が語だけだと、文脈が無い。** その語が本文のどこに出ても同じ読みを
    当てることになり、もう一方の読みの所を必ず読み違える（「十分」を全部
    「じっぷん」にする）。句は語より長くなければならない。
  */
  if (quote === word) return "句が語だけ";
  if (!KANJI.test(word)) return "語に漢字が無い";
  if (ECHO_READINGS.has(reading)) return "読みが指示の言葉";
  if (!HIRAGANA_ONLY.test(reading)) return "読みがひらがなでない";
  if (reading.length > READING_MAX) return "読みの長さが合わない";
  if (reading.length < word.length || reading.length > readingMaxFor(word)) {
    return "読みの長さが合わない";
  }
  if (reading === toHiragana(word)) return "読みの長さが合わない";
  const okurigana = trailingKana(word);
  if (okurigana !== "" && !reading.endsWith(toHiragana(okurigana))) {
    return "送り仮名が合わない";
  }
  return { word, quote, reading, source: "ai" };
}

/**
 * その語の読みとして長すぎない上限（字）。
 *
 * **漢字1字は1音以上、ふつうは語の字数以上の読みになる**ので下限は語の字数。
 * 上限は、漢字1字だけの語なら5音（承る＝うけたまわる）、2字以上の熟語なら
 * 1字3音（十分＝じゅうぶん、入学＝にゅうがく）までとし、仮名の字はそのまま足す。
 *
 * **句の前の字まで読みに入れた答えを落とすため**である。gemma4:e4b が
 * 「最初の一行」の一行に「さいしょのいちぎょう」を返した（2026-10-19 の測定）。
 * 通すと声が「最初のさいしょのいちぎょう」と読む。以前の上限（語の5倍）では
 * 2字の語に10字まで通っていた。
 */
function readingMaxFor(word: string): number {
  let kanji = 0;
  for (const char of word) if (KANJI.test(char)) kanji++;
  const kana = word.length - kanji;
  return (kanji <= 1 ? 5 : kanji * 3) + kana;
}

/** 語の末尾の仮名（送り仮名）。無ければ空 */
function trailingKana(word: string): string {
  let at = word.length;
  while (at > 0 && /[ぁ-ゖァ-ヶー]/.test(word[at - 1])) {
    at--;
  }
  return word.slice(at);
}

/** 当てた結果 */
export interface ReadingSpansResult {
  spans: ReadingSpan[];
  /** 句が本文に見当たらなかった項目（作り直しを促す材料） */
  missing: ReadingEntry[];
}

/**
 * いまの本文に、辞書の読みを当てる範囲を求める。
 *
 * - 消した項目（墓標）と読みが空の項目は当てない
 * - 同じ句が本文に2回あれば2回とも当てる（句で文脈を決めているので、
 *   同じ句なら同じ読みでよい）
 * - **作者の項目を先に当てる。** 範囲が重なったら、先に置いたほうが勝つ
 *   ——AIの項目が作者の直しを押しのけない
 *
 * 作者のルビとの重なりは、ここでは見ない（記法の範囲を知っているのは
 * `core/readAloud.ts` なので、あちらで外す）。
 */
export function readingSpansFor(
  text: string,
  entries: readonly ReadingEntry[]
): ReadingSpansResult {
  const spans: ReadingSpan[] = [];
  const missing: ReadingEntry[] = [];
  const ordered = [
    ...entries.filter((entry) => entry.source === "author"),
    ...entries.filter((entry) => entry.source !== "author"),
  ];
  for (const entry of ordered) {
    if (entry.removed || entry.reading === "" || entry.quote === "") continue;
    const offset = entry.quote.indexOf(entry.word);
    if (offset < 0) continue;
    let found = false;
    for (
      let at = text.indexOf(entry.quote);
      at >= 0;
      at = text.indexOf(entry.quote, at + 1)
    ) {
      found = true;
      const start = at + offset;
      const end = start + entry.word.length;
      if (spans.some((span) => span.start < end && start < span.end)) continue;
      spans.push({ start, end, reading: entry.reading });
    }
    if (!found) missing.push(entry);
  }
  spans.sort((a, b) => a.start - b.start);
  return { spans, missing };
}

/**
 * 作り直した項目を、いまの辞書へ混ぜる。**混ぜるのはAIではなくコード**
 * （CLAUDE.md 実装ルール3）。
 *
 * - 作者の項目（直した・消した）はそのまま残す
 * - AIの項目は、新しい答えで**入れ替える**（キャッシュに当たった区切りの
 *   答えも新しい答えに入っているので、取りこぼしは出ない）
 * - 新しい答えのうち、作者の項目と同じ語・同じ句のものは入れない
 */
export function mergeReadingEntries(
  current: readonly ReadingEntry[],
  fresh: readonly ReadingEntry[]
): ReadingEntry[] {
  const authored = current.filter((entry) => entry.source === "author");
  const taken = new Set(authored.map(readingEntryKey));
  const merged = [...authored];
  for (const entry of fresh) {
    const key = readingEntryKey(entry);
    if (taken.has(key)) continue;
    taken.add(key);
    merged.push({ ...entry, source: "ai", removed: undefined });
  }
  return merged.map(stripUndefined);
}

/** 作者が読みを直す。直した項目は `author` になり、作り直しで上書きされない */
export function editReading(
  current: readonly ReadingEntry[],
  key: string,
  reading: string
): ReadingEntry[] {
  return current.map((entry) =>
    readingEntryKey(entry) === key
      ? stripUndefined({ ...entry, reading, source: "author", removed: undefined })
      : entry
  );
}

/** 作者が項目を消す。**行を落とさず墓標にする**（作り直しで戻さないため） */
export function removeReading(
  current: readonly ReadingEntry[],
  key: string
): ReadingEntry[] {
  return current.map((entry) =>
    readingEntryKey(entry) === key
      ? { ...entry, source: "author" as const, removed: true }
      : entry
  );
}

function stripUndefined(entry: ReadingEntry): ReadingEntry {
  const out: ReadingEntry = {
    word: entry.word,
    quote: entry.quote,
    reading: entry.reading,
    source: entry.source,
  };
  if (entry.removed) out.removed = true;
  return out;
}

/**
 * 作者が直した読みを確かめる（一覧の入力欄）。通らなければ理由の文。
 *
 * AIの答えと同じ字種の決まりを当てる——作者がうっかり漢字を打つと、
 * 声は結局その漢字を読み違える。
 */
export function checkAuthorReading(reading: string): string | undefined {
  const normalized = toHiragana(reading.replace(/[\s　]+/g, ""));
  if (normalized === "") return "読みを入れてください。";
  if (!HIRAGANA_ONLY.test(normalized)) return "ひらがな（と長音）で入れてください。";
  if (normalized.length > READING_MAX) return `${READING_MAX}字までにしてください。`;
  return undefined;
}

/** 作者が打った読みを、保存する形へ（カタカナはひらがなへ、空白は詰める） */
export function normalizeAuthorReading(reading: string): string {
  return toHiragana(reading.replace(/[\s　]+/g, ""));
}

/** AIへ送る区切り（本文の一部と、その元の位置） */
export interface ReadingChunk {
  text: string;
}

/**
 * AIへ送る区切りを作る。**行の切れ目でだけ切る**（句が区切りをまたがない）。
 *
 * シーンメモの行は送らない（作者の覚え書きで、読み上げでも読まない）。
 * 空の行は区切りの中に残す（段落の切れ目が文脈の手がかりになる）。
 *
 * 1行が上限を超えるときは、その行だけで1区切りにする（行の途中で切ると
 * 句が割れる）。
 */
export function readingChunksOf(text: string, maxChars: number): ReadingChunk[] {
  const chunks: ReadingChunk[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = (): void => {
    const body = current.join("\n");
    if (body.trim() !== "") chunks.push({ text: body });
    current = [];
    size = 0;
  };
  for (const line of text.split("\n")) {
    if (isMemoLine(line)) continue;
    if (size > 0 && size + line.length + 1 > maxChars) flush();
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return chunks;
}

/** 辞書のファイル（`.aiwriter/readings/<話>.json`）の形 */
export interface ReadingDictionaryFile {
  version: 1;
  /** どの話の辞書か（作品フォルダーからの相対パス。`/` 区切り） */
  episode: string;
  entries: ReadingEntry[];
  /** 最後にAIで作った回の控え（どのAI・どの版で作ったかを後から辿る） */
  lastRun?: {
    providerId: string;
    model: string;
    promptVersion: string;
    at: string;
    /** 検算で捨てた数 */
    dropped: number;
  };
}

/**
 * 辞書のファイルを読む。**壊れていたら直さずに投げる**（CLAUDE.md 実装ルール2）。
 * 作者の直しが入っている台帳なので、読めないからといって空で上書きしない。
 */
export function parseReadingDictionary(text: string): ReadingDictionaryFile {
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null) {
    throw new Error("読みの辞書の形が違います");
  }
  const record = data as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.entries)) {
    throw new Error("読みの辞書の形が違います");
  }
  const entries: ReadingEntry[] = [];
  for (const raw of record.entries) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("読みの辞書の項目の形が違います");
    }
    const item = raw as Record<string, unknown>;
    if (
      typeof item.word !== "string" ||
      typeof item.quote !== "string" ||
      typeof item.reading !== "string" ||
      (item.source !== "ai" && item.source !== "author")
    ) {
      throw new Error("読みの辞書の項目の形が違います");
    }
    const entry: ReadingEntry = {
      word: item.word,
      quote: item.quote,
      reading: item.reading,
      source: item.source,
    };
    if (item.removed === true) entry.removed = true;
    entries.push(entry);
  }
  const file: ReadingDictionaryFile = {
    version: 1,
    episode: typeof record.episode === "string" ? record.episode : "",
    entries,
  };
  const last = record.lastRun;
  if (typeof last === "object" && last !== null) {
    const run = last as Record<string, unknown>;
    if (
      typeof run.providerId === "string" &&
      typeof run.model === "string" &&
      typeof run.promptVersion === "string" &&
      typeof run.at === "string"
    ) {
      file.lastRun = {
        providerId: run.providerId,
        model: run.model,
        promptVersion: run.promptVersion,
        at: run.at,
        dropped: typeof run.dropped === "number" ? run.dropped : 0,
      };
    }
  }
  return file;
}

/**
 * AIの答えの文字列から項目の並びを取り出す。読めなければ undefined。
 * 中身の検算は `validateReadingItems` が行う（ここは形だけを見る）。
 */
export function parseReadingDictionaryResult(text: string): unknown[] | undefined {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const items = (data as Record<string, unknown>).items;
  return Array.isArray(items) ? items : undefined;
}

/** 辞書のファイル名。話の相対パスの区切りを `__` へ（入れ子の話でも1段に置く） */
export function readingDictionaryFileName(episodeRelative: string): string {
  return `${episodeRelative.replace(/[\\/]+/g, "__")}.json`;
}
