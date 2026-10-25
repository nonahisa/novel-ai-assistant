import { readingsOf } from "./jouyouOnKun";
import { isOnyomiReading } from "./onyomiReading";
import {
  editReading,
  HIRAGANA_ONLY,
  KANJI,
  READING_MAX,
  READING_WORD_MAX,
  readingEntryKey,
  toHiragana,
  validateReadingItems,
  type ReadingEntry,
} from "./readingDictionary";

/**
 * IMEで打った読みを、名前以外の語でも読みの辞書への**提案**にする（設計書6.42.2。
 * 作者の裁定、2026-10-25）。
 *
 * きっかけは、読み上げが「港」を「こう」と読んだこと。作者が打った読みは「みなと」で、
 * 打った時点で正しい読みは分かっていた。名前（`imeReading.ts`）と同じく、確定した
 * 変換から読みを拾う。
 *
 * ## 提案にとどめる
 *
 * 辞書へ入れるのは作者が［採る］を押したときだけで、採るまでは読み上げに使わない
 * （読みの辞書は作者が直した読みを持つ台帳なので、機械が黙って足さない）。
 *
 * ## 読みが2通り以上ある語だけ
 *
 * 声が読み違えるのは、読みが2通り以上ある語である（6.42.1 と同じ考え）。すべての
 * 漢字を提案にすると一覧が埋まって使えない。見分けは同梱の常用漢字の音訓表で行う
 * （作者の選択 Q1、2026-10-25）。決まりは `judgeImeWord` に書いた。
 *
 * ## ここは vscode に触らない
 *
 * 割り方・見分け方・控えの形・句の求め方・辞書との突き合わせは純粋な文字列処理で、
 * 単体テストで確かめる（ブラウザ版でもそのまま動く。実装ルール7）。読み書きは
 * `imeWordReadingStore.ts`、拾うのは `features/imeReadings.ts`、一覧は
 * `features/readingDictionary.ts`。
 */

/**
 * 画面が添えてくる「変換を始めた所の直前の字」の長さ。句を求めるとき、本文に
 * 確定の字が2か所以上あっても、打った所を選べるようにするため。長いと、その後の
 * 書き足しで合わなくなりやすい。
 *
 * **画面の側（`manuscriptEditorHtml.ts` の `ime-reading` の印の中）に同じ値の写しが
 * ある**（画面へは import できない）。揃っていることはテストが見張る
 */
export const IME_WORD_BEFORE_MAX = 12;

/** 確定の中の、漢字の並び1つとその読み */
export interface ImeWordSplit {
  /** 漢字の並び */
  run: string;
  /** その並びの読み（ひらがな） */
  reading: string;
  /** 確定の中での並びの始まり */
  offset: number;
  /** 並びのすぐ後ろのかな（ひらがなへ直したもの。送り仮名か助詞かはまだ決めない） */
  following: string;
}

/** 確定の字の区切り：漢字の並びか、かなの並び */
interface Segment {
  kind: "kanji" | "kana";
  text: string;
  offset: number;
}

const KANA_CHAR = /^[ぁ-ゖァ-ヶー]$/;

function segmentsOf(committed: string): Segment[] | undefined {
  const segments: Segment[] = [];
  let offset = 0;
  for (const char of committed) {
    // ヶ は漢字の並びでも使う（KANJI に入っている）ので、漢字を先に見る
    const kind = KANJI.test(char) ? "kanji" : KANA_CHAR.test(char) ? "kana" : undefined;
    // 句読点・英数・記号が混じると、どこまでが読みか決まらない
    if (!kind) return undefined;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += char;
    else segments.push({ kind, text: char, offset });
    offset += char.length;
  }
  return segments;
}

/**
 * 打った読みと確定した字を、漢字の並びごとの読みへ割る。
 *
 * 確定の中のかなの並びは、読みにも文字どおりあるはずとして合わせ（名前の
 * `readingShapeOf` と同じやり方）、漢字の並びはその間の読みを取る。漢字の並びは
 * 字の数以上の読みを持つ。**割り方が1通りに決まるときだけ採る**——2通りあれば
 * どちらが打った読みか分からない（誤って拾うと、声がその語を読み違える）。
 *
 * @returns 割れなければ undefined。漢字が無ければ空
 */
export function splitImeWords(kana: string, committed: string): ImeWordSplit[] | undefined {
  const typed = toHiragana(kana.trim());
  const fixed = committed.trim();
  if (!typed || !fixed || !HIRAGANA_ONLY.test(typed)) return undefined;
  const segments = segmentsOf(fixed);
  if (!segments) return undefined;
  if (!segments.some((segment) => segment.kind === "kanji")) return [];

  let found: string[] | undefined;
  let ways = 0;
  const readings: string[] = [];
  const walk = (index: number, at: number): void => {
    if (ways > 1) return;
    if (index === segments.length) {
      if (at === typed.length) {
        ways++;
        found = [...readings];
      }
      return;
    }
    const segment = segments[index];
    if (segment.kind === "kana") {
      const literal = toHiragana(segment.text);
      if (typed.startsWith(literal, at)) walk(index + 1, at + literal.length);
      return;
    }
    const least = Array.from(segment.text).length;
    for (let end = at + least; end <= typed.length; end++) {
      readings.push(typed.slice(at, end));
      walk(index + 1, end);
      readings.pop();
      if (ways > 1) return;
    }
  };
  walk(0, 0);
  if (ways !== 1 || !found) return undefined;

  const out: ImeWordSplit[] = [];
  let kanjiIndex = 0;
  segments.forEach((segment, index) => {
    if (segment.kind !== "kanji") return;
    const next = segments[index + 1];
    out.push({
      run: segment.text,
      reading: found![kanjiIndex++],
      offset: segment.offset,
      following: next && next.kind === "kana" ? toHiragana(next.text) : "",
    });
  });
  // 漢字の並びの読みは walk の順（かなの並びは数に入れていない）
  return out;
}

/** 拾った語：辞書へ入れる形（1字の語は送り仮名込み） */
export interface ImeWordCapture {
  word: string;
  reading: string;
  /** 確定の中での語の始まり（句を求めるときに使う） */
  offset: number;
}

/**
 * 送り仮名 `okurigana` を持つ語として、訓のうち語の形に合うものの「漢字の部分の読み」。
 *
 * 表の訓は送り仮名込みの辞書形で、どこまでが送り仮名かの印が無い（見＝みる・みえる・
 * みせる）。「見る」の「る」で尻を合わせると3つとも合ってしまうので、**ほかの読みを
 * 頭に持つ長い読みは数えない**（みえ・みせ は み を頭に持つ。「見える」「見せる」は
 * 送り仮名が「える」「せる」の別の語である）。
 */
function stemsFor(kun: readonly string[], okurigana: string): Set<string> {
  const stems = new Set<string>();
  for (const reading of kun) {
    if (reading.length > okurigana.length && reading.endsWith(okurigana)) {
      stems.add(reading.slice(0, reading.length - okurigana.length));
    }
  }
  for (const stem of [...stems]) {
    for (const other of stems) {
      if (other !== stem && stem.startsWith(other)) {
        stems.delete(stem);
        break;
      }
    }
  }
  return stems;
}

/**
 * 漢字の並び1つが、読みの辞書への提案の候補か（作者の選択 Q1、2026-10-25）。
 *
 * **2字以上**：打った読みが音読みをつないだだけ（`isOnyomiReading`。学校＝がっこう）
 * なら候補にしない。声はふつう音読みで読むので、読み違えない。今日（きょう）・
 * 表に無い字を含む並びは候補。
 *
 * **1字**：表の音訓のうち、語の形に合う読みが2つ以上なら候補（港＝こう・みなと）。
 *
 * - 後ろのかなの頭から、訓の尻と合う送り仮名を長いほうから探す（行く＝いく・ゆく）。
 *   合ったら語は送り仮名込みにする（辞書の検算が送り仮名を照らす）。合う読みが
 *   1つなら候補にしない（言う・思う・見る）
 * - 送り仮名が合わなければ、送り仮名の無い語（名詞など）として音と訓のすべてで数える。
 *   後ろのかなは助詞とみる（港へ）
 * - 打った読みが表に無ければ候補（止める＝やめる。表の外の読みは、声も読み違えやすい）。
 *   **ただし訓の頭だけを打った形は候補にしない**——「見た」「行った」のように活用した
 *   形は、表の辞書形と尻が合わず、語の形を判定できない（活用には付き合わない。
 *   候補を増やしすぎないほうに倒す）
 * - 表に無い字は候補
 *
 * @returns 候補なら辞書へ入れる形、候補でなければ undefined
 */
export function judgeImeWord(
  run: string,
  reading: string,
  following: string
): { word: string; reading: string } | undefined {
  const chars = Array.from(run);
  if (chars.length >= 2) {
    return isOnyomiReading(run, reading) ? undefined : { word: run, reading };
  }
  const entry = readingsOf(run);
  if (!entry) return { word: run, reading };

  for (let length = following.length; length >= 1; length--) {
    const okurigana = following.slice(0, length);
    const stems = stemsFor(entry.kun, okurigana);
    if (!stems.has(reading)) continue;
    return stems.size >= 2 ? { word: run + okurigana, reading: reading + okurigana } : undefined;
  }

  const all = new Set([...entry.on.map(toHiragana), ...entry.kun]);
  if (all.has(reading)) return all.size >= 2 ? { word: run, reading } : undefined;
  if (entry.kun.some((kun) => kun.length > reading.length && kun.startsWith(reading))) {
    return undefined;
  }
  // 表の外の読み。訓の尻と合う送り仮名があれば語に含める（止める＝やめる）
  for (let length = following.length; length >= 1; length--) {
    const okurigana = following.slice(0, length);
    if (stemsFor(entry.kun, okurigana).size > 0) {
      return { word: run + okurigana, reading: reading + okurigana };
    }
  }
  return { word: run, reading };
}

/**
 * 変換1回ぶんから、提案の候補の語を拾う。
 *
 * **名前に当たった表記は除く**——名前の読みは設定資料の側で扱う（`imeReading.ts`）。
 * 確定の中で名前と重なる語は、辞書へも出さない。
 *
 * @param names 設定資料の名前と別名
 */
export function captureImeWords(
  kana: string,
  committed: string,
  names: readonly string[]
): ImeWordCapture[] {
  const fixed = committed.trim();
  const splits = splitImeWords(kana, fixed);
  if (!splits) return [];
  const taken: Array<[number, number]> = [];
  for (const raw of new Set(names)) {
    const name = raw.trim();
    if (!name) continue;
    for (let at = fixed.indexOf(name); at >= 0; at = fixed.indexOf(name, at + 1)) {
      taken.push([at, at + name.length]);
    }
  }
  const out: ImeWordCapture[] = [];
  for (const split of splits) {
    const judged = judgeImeWord(split.run, split.reading, split.following);
    if (!judged) continue;
    const end = split.offset + judged.word.length;
    if (taken.some(([start, stop]) => start < end && split.offset < stop)) continue;
    if (judged.word.length > READING_WORD_MAX || judged.reading.length > READING_MAX) continue;
    out.push({ ...judged, offset: split.offset });
  }
  return out;
}

/* ── 控え（`.aiwriter/imeWordReadings.json`。同期しない） ─────────── */

/** 控えの1項目：その話で、その語をその読みで打った */
export interface ImeWordReadingEntry {
  /** 話（作品フォルダーからの相対パス。`/` 区切り。読みの辞書と同じ鍵） */
  episode: string;
  word: string;
  reading: string;
  /** 最後に打ったときの確定の字（句を求めるとき、本文の中で探す） */
  committed: string;
  /** 確定の中での語の始まり */
  offset: number;
  /**
   * 最後に打ったとき、変換を始めた所の直前の字（末尾 `IME_WORD_BEFORE_MAX` 字）。
   * 空の字は「行頭で打った」。**無い（undefined）は「画面が所を読めなかった」**で、
   * 行頭とは別に扱う（混ぜると、別の行の行頭の所を打った所と取り違える）
   */
  before?: string;
  count: number;
  /** 最後に打った日時（ISO） */
  lastSeen: string;
}

export interface ImeWordReadingFile {
  version: 1;
  entries: ImeWordReadingEntry[];
}

/** 控えの上限。古く打ったものから落とす（落ちても提案が1つ出なくなるだけ） */
export const IME_WORD_ENTRY_MAX = 1000;

function objectOf(text: string, label: string): Record<string, unknown> {
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null) throw new Error(`${label}の形が違います`);
  const record = data as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.entries)) {
    throw new Error(`${label}の形が違います`);
  }
  return record;
}

/** 控えを読む。**壊れていたら直さずに投げる**（CLAUDE.md 実装ルール2） */
export function parseImeWordReadingFile(text: string): ImeWordReadingFile {
  const record = objectOf(text, "IMEの読みの提案の控え");
  const entries: ImeWordReadingEntry[] = [];
  for (const raw of record.entries as unknown[]) {
    const item = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (
      typeof item.episode !== "string" ||
      typeof item.word !== "string" ||
      typeof item.reading !== "string" ||
      typeof item.committed !== "string" ||
      typeof item.offset !== "number" ||
      (item.before !== undefined && typeof item.before !== "string") ||
      typeof item.count !== "number" ||
      typeof item.lastSeen !== "string"
    ) {
      throw new Error("IMEの読みの提案の控えの項目の形が違います");
    }
    entries.push({
      episode: item.episode,
      word: item.word,
      reading: item.reading,
      committed: item.committed,
      offset: item.offset,
      ...(typeof item.before === "string" ? { before: item.before } : {}),
      count: item.count,
      lastSeen: item.lastSeen,
    });
  }
  return { version: 1, entries };
}

/**
 * 拾った語を控えへ足す。同じ（話・語・読み）は回数を足し、確定の字と直前の字を
 * 新しくする（句は最後に打った所から求める）。元の控えは変えない。
 *
 * @returns 足したあとの控えと、**新しく出た**（話・語・読み）
 */
export function recordImeWordEntries(
  file: ImeWordReadingFile,
  input: {
    episode: string;
    captures: readonly ImeWordCapture[];
    committed: string;
    /** 無ければ「画面が所を読めなかった」（空の字の「行頭」とは別） */
    before: string | undefined;
    now: string;
  }
): { file: ImeWordReadingFile; added: Array<{ word: string; reading: string }> } {
  const entries = [...file.entries];
  const added: Array<{ word: string; reading: string }> = [];
  const before = input.before?.slice(-IME_WORD_BEFORE_MAX);
  for (const capture of input.captures) {
    const fresh = {
      committed: input.committed,
      offset: capture.offset,
      ...(before === undefined ? {} : { before }),
      lastSeen: input.now,
    };
    const at = entries.findIndex(
      (entry) =>
        entry.episode === input.episode &&
        entry.word === capture.word &&
        entry.reading === capture.reading
    );
    if (at >= 0) {
      // 直前の字は最後に打ったときのものだけを持つ（前の打鍵の字を残すと、別の所を指す）
      const { before: _stale, ...rest } = entries[at];
      entries[at] = { ...rest, ...fresh, count: entries[at].count + 1 };
      continue;
    }
    entries.push({
      episode: input.episode,
      word: capture.word,
      reading: capture.reading,
      ...fresh,
      count: 1,
    });
    added.push({ word: capture.word, reading: capture.reading });
  }
  if (entries.length > IME_WORD_ENTRY_MAX) {
    entries.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    entries.length = IME_WORD_ENTRY_MAX;
  }
  return { file: { version: 1, entries }, added };
}

/* ── 見送りの印（`.aiwriter/imeReadingDismissals.json`。同期する） ──── */

/** 見送った（話・語・読み）。句は含めない——句はいまの本文から毎回求め直すため */
export interface ImeWordDismissal {
  episode: string;
  word: string;
  reading: string;
  /** 見送った日時（ISO） */
  at: string;
}

export interface ImeWordDismissalFile {
  version: 1;
  entries: ImeWordDismissal[];
}

/** 見送りの印を読む。**壊れていたら直さずに投げる**（作者の判断の記録なので空で上書きしない） */
export function parseImeWordDismissalFile(text: string): ImeWordDismissalFile {
  const record = objectOf(text, "IMEの読みの見送りの印");
  const entries: ImeWordDismissal[] = [];
  for (const raw of record.entries as unknown[]) {
    const item = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (
      typeof item.episode !== "string" ||
      typeof item.word !== "string" ||
      typeof item.reading !== "string" ||
      typeof item.at !== "string"
    ) {
      throw new Error("IMEの読みの見送りの印の項目の形が違います");
    }
    entries.push({ episode: item.episode, word: item.word, reading: item.reading, at: item.at });
  }
  return { version: 1, entries };
}

/** 見送りの印を足す（同じものは重ねない）。元の印は変えない */
export function dismissImeWord(
  file: ImeWordDismissalFile,
  target: { episode: string; word: string; reading: string },
  now: string
): ImeWordDismissalFile {
  if (file.entries.some((entry) => sameWord(entry, target))) return file;
  return { version: 1, entries: [...file.entries, { ...target, at: now }] };
}

function sameWord(
  a: { episode: string; word: string; reading: string },
  b: { episode: string; word: string; reading: string }
): boolean {
  return a.episode === b.episode && a.word === b.word && a.reading === b.reading;
}

/* ── 句（確定した時点では決めない。一覧を出すときにいまの本文から求める） ── */

/**
 * 句に含める、語の前と後ろの字の数（それぞれ）。
 *
 * 句は短いほど本文の書き足しで崩れにくく、長いほど別の所に当たりにくい
 * （6.42.1）。前後6字なら、ふつうは同じ句が本文に2度出ない長さで、上限の
 * 30字にも収まる（語は8字まで）
 */
const PHRASE_CONTEXT = 6;

/** 求めた句と、本文の中の語の始まり */
export interface ImeWordPhrase {
  quote: string;
  wordStart: number;
}

/**
 * 控えの1項目から、いまの本文の中の句を求める。
 *
 * 1. 本文の中の確定の字の所を探し、控えた直前の字で終わる所を優先する（直前の字が
 *    空なら行頭で打ったので、行頭の所だけを見る。直前の字が無ければ優先しない）
 * 2. 無ければ1か所だけの所。どちらも無ければ出さない（どこに当てるか決まらない）
 * 3. 句はその行の中で、語の前後を `PHRASE_CONTEXT` 字まで。**句の中で語が先に出ない
 *    ようにする**——辞書は句の中の最初の所に読みを当てる（`readingSpansFor`）
 * 4. 条件は AIの答えと同じ検算（`checkItem`）に通す（改行なし・30字以内・語より長い…）
 *
 * 直前の字は画面の見えている字なので、組んで書く面ではルビの読みが混じって本文と
 * 合わないことがある。そのときは 2 で拾う。
 */
export function phraseForImeWord(
  text: string,
  entry: Pick<ImeWordReadingEntry, "word" | "reading" | "committed" | "offset" | "before">
): ImeWordPhrase | undefined {
  const { word, committed } = entry;
  if (!committed || !word) return undefined;
  const places: number[] = [];
  for (let at = text.indexOf(committed); at >= 0; at = text.indexOf(committed, at + 1)) {
    places.push(at);
  }
  const before = entry.before;
  // 直前の字が無い（画面が所を読めなかった）なら、優先する所は無い
  const followsBefore = (at: number): boolean =>
    before === undefined
      ? false
      : before === ""
        ? at === 0 || text[at - 1] === "\n"
        : text.slice(0, at).endsWith(before);
  const place = places.find(followsBefore) ?? (places.length === 1 ? places[0] : undefined);
  if (place === undefined) return undefined;

  const wordStart = place + entry.offset;
  const wordEnd = wordStart + word.length;
  if (text.slice(wordStart, wordEnd) !== word) return undefined;

  const lineStart = text.lastIndexOf("\n", wordStart - 1) + 1;
  const lineEnd = text.indexOf("\n", wordEnd) < 0 ? text.length : text.indexOf("\n", wordEnd);
  const earlier = wordStart > 0 ? text.lastIndexOf(word, wordStart - 1) : -1;
  // 句の始まりは、手前にある同じ語の始まりより後ろ（句の中で語が先に出ない）
  const floor = Math.max(lineStart, earlier >= 0 ? earlier + 1 : lineStart);
  const start = Math.max(floor, wordStart - PHRASE_CONTEXT);
  const end = Math.min(lineEnd, wordEnd + PHRASE_CONTEXT);
  const raw = text.slice(start, end);
  const quote = raw.trim();
  if (quote === word || quote.indexOf(word) !== wordStart - (start + raw.indexOf(quote))) {
    return undefined;
  }
  const checked = validateReadingItems(text, [{ word, quote, reading: entry.reading }]);
  if (checked.entries.length !== 1) return undefined;
  return { quote, wordStart };
}

/* ── 辞書との突き合わせ ─────────────────────────────────────── */

/** 一覧に出す提案 */
export interface ImeWordProposal {
  word: string;
  reading: string;
  quote: string;
  wordStart: number;
  count: number;
  /** AIの項目がその所に違う読みを当てているとき、その読み */
  aiReading?: string;
}

/** 辞書の項目が、本文の wordStart〜wordEnd に掛かるか */
function covers(text: string, entry: ReadingEntry, wordStart: number, wordEnd: number): boolean {
  if (!entry.quote || !entry.word) return false;
  const offset = entry.quote.indexOf(entry.word);
  if (offset < 0) return false;
  for (let at = text.indexOf(entry.quote); at >= 0; at = text.indexOf(entry.quote, at + 1)) {
    const start = at + offset;
    if (start < wordEnd && wordStart < start + entry.word.length) return true;
  }
  return false;
}

/**
 * その話の、いま一覧に出す提案。
 *
 * - **作者の項目か消した印がその所にあれば出さない**（作者が決めた読みを提案で
 *   揺さぶらない。CLAUDE.md 実装ルール2）
 * - AIの項目が同じ語に同じ読みを当てていれば出さない（もう正しく読む）
 * - AIの項目が同じ語に違う読みを当てていれば、AIの読みを添えて出す
 * - 見送った（話・語・読み）は出さない
 * - 句が求まらないもの（本文から消えた・どこか決まらない）は出さない
 * - 同じ語・同じ句が2つ出たら、多く打ったほうだけ
 */
export function imeWordProposals(input: {
  entries: readonly ImeWordReadingEntry[];
  dismissals: ImeWordDismissalFile;
  dictionary: readonly ReadingEntry[];
  episode: string;
  text: string;
}): ImeWordProposal[] {
  const { text } = input;
  const authored = input.dictionary.filter((item) => item.source === "author");
  const ai = input.dictionary.filter((item) => item.source !== "author" && !item.removed);
  const byKey = new Map<string, { proposal: ImeWordProposal; lastSeen: string }>();
  for (const entry of input.entries) {
    if (entry.episode !== input.episode) continue;
    if (input.dismissals.entries.some((item) => sameWord(item, { ...entry }))) continue;
    const phrase = phraseForImeWord(text, entry);
    if (!phrase) continue;
    const wordEnd = phrase.wordStart + entry.word.length;
    if (authored.some((item) => covers(text, item, phrase.wordStart, wordEnd))) continue;
    const sameWordAi = ai.filter(
      (item) => item.word === entry.word && covers(text, item, phrase.wordStart, wordEnd)
    );
    if (sameWordAi.some((item) => item.reading === entry.reading)) continue;
    const proposal: ImeWordProposal = {
      word: entry.word,
      reading: entry.reading,
      quote: phrase.quote,
      wordStart: phrase.wordStart,
      count: entry.count,
    };
    if (sameWordAi.length > 0) proposal.aiReading = sameWordAi[0].reading;
    const key = readingEntryKey(proposal);
    const kept = byKey.get(key);
    if (kept && kept.proposal.count >= proposal.count) continue;
    byKey.set(key, { proposal, lastSeen: entry.lastSeen });
  }
  return [...byKey.values()]
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .map((item) => item.proposal);
}

/**
 * ［採る］：提案を作者の項目として辞書へ入れる。同じ語・同じ句の項目（AIの項目）は
 * 置き換える（`editReading` が作者の項目にし、消した印を外す）。無ければ足す。
 * 作者の項目なので、AIで作り直しても上書きされない（`mergeReadingEntries`）
 */
export function adoptImeWordProposal(
  current: readonly ReadingEntry[],
  proposal: Pick<ImeWordProposal, "word" | "quote" | "reading">
): ReadingEntry[] {
  const key = readingEntryKey(proposal);
  if (current.some((entry) => readingEntryKey(entry) === key)) {
    return editReading(current, key, proposal.reading);
  }
  return [
    ...current,
    { word: proposal.word, quote: proposal.quote, reading: proposal.reading, source: "author" },
  ];
}
