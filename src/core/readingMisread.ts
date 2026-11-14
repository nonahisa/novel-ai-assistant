import { tokenizeLine, type NotationMode } from "./manuscriptRender";
import { memoLineMask } from "./sceneMemo";
import type { MemoMarkers } from "./memoMarkers";
import {
  HIRAGANA_ONLY,
  KANJI,
  READING_QUOTE_MAX,
  toHiragana,
  type ReadingEntry,
  type ReadingSpan,
} from "./readingDictionary";
import {
  buildReadingPlan,
  notationCoverage,
  sentenceSpeechWith,
  type ReadingSentence,
} from "./readAloud";
import { buildFinding } from "./findingSource";
import { rubyEditReplacement, rubyNotationFor } from "./ruby";
import { MISREAD_FINDING_LABEL, isMisreadFinding } from "./readingMisreadLabel";
import type { Finding } from "../models/finding";

/**
 * 読み上げの読み間違いを、声を作る前に見つける（設計書6.42.5。作者の決定 2026-11-14 夜）。
 *
 * 人物の声（AivisSpeech・VOICEVOX）は、送った文の漢字の読みをエンジンが自分で選ぶ。
 * 作品の中で読みが分かっている語（ルビ・読みの辞書・設定資料の読み）でも、**送る文に
 * 漢字のまま残る出現**がある——ルビを最初の1回だけ振った語の2回目、設定資料の1字の名前・
 * 別名、別の話の辞書にしか無い語。そこをエンジンに任せて、読み間違える。
 *
 * ## 比べ方（考え方の出どころは arXiv:2610.07575「読みはかなで比べる」）
 *
 * その文について、エンジンに読み方の下ごしらえ（`audio_query`）を2回頼む。
 * (a) 送る文のまま、(b) その語を正しい読み（カタカナ）に置き換えた文。答えのモーラを
 * 並べたかなをならして比べ、同じなら読めている。**どちらもエンジンの答え**なので、
 * エンジンのかなの癖（長音の書き方など）は両方に同じように出て打ち消し合う。
 *
 * ## ここは vscode に触らない
 *
 * 読みを集める・漢字のまま残る出現を拾う・かなをならす・比べる、を純粋な関数で持つ。
 * エンジンへの頼みは外から渡す（`MisreadQuery`）。製品（`features/readingMisread.ts`）も
 * 実データの測定（`test/live/readingMisreadAcrossWorks.test.ts`）も、同じ関数を通す。
 */

/** 正しい読みをどこから知ったか */
export type KnownReadingSource =
  | { kind: "ruby"; episode: string }
  | { kind: "dictionary"; episode: string }
  | { kind: "settings" };

/** 作品の中で分かっている読みの1つ */
export interface KnownReading {
  /** 語（漢字を含む） */
  word: string;
  /** 読み（ひらがなと長音。比べるための形） */
  reading: string;
  /**
   * 作者が書いたとおりの読み（ルビの `《マジ》` ならカタカナのまま）。［ここにルビを振る］で振る読みに使う
   * ——ひらがなへ直した読みで振ると、作者の書き方（当て読みのカタカナ）と変わる
   */
  written: string;
  source: KnownReadingSource;
}

/** 読みを集める材料（話ごと） */
export interface KnownReadingEpisode {
  /** 画面に出す話の呼び名（「第3話」など） */
  label: string;
  /** 本文（LF区切り） */
  text: string;
  notation: NotationMode;
  /** その話の読みの辞書の項目 */
  dictionary: readonly ReadingEntry[];
}

/** 名前と読み（`core/imeReading.ts` の `NameReading` と同じ形。写さずに受ける） */
export interface KnownNameReading {
  surface: string;
  reading: string;
}

/** 出どころが設定資料のときの言い方。行の文に残るので、行から出どころを見分ける目印も兼ねる */
const SETTINGS_SOURCE_TEXT = "設定資料の読み";

/** 正しい読みの出どころを、作者に見せる言い方へ */
export function describeReadingSource(source: KnownReadingSource): string {
  if (source.kind === "ruby") return `${source.episode}のルビ`;
  if (source.kind === "dictionary") return `${source.episode}の読みの辞書`;
  return SETTINGS_SOURCE_TEXT;
}

/**
 * 読み間違いの見込みの行の出どころが、設定資料の読みか。
 *
 * 行（Finding）には出どころの欄が無く、`misreadMessage` の文にだけ残る。欄を足すと
 * 保存済みの記録の形が変わるので、文の言い方（`describeReadingSource` と同じ字）で見分ける。
 * 設定資料の読みが違う・欠けているときの誤検出は、設定資料を直すと止まる
 */
export function isSettingsReadingFinding(finding: { label: string; message: string }): boolean {
  return isMisreadFinding(finding) && finding.message.includes(`（${SETTINGS_SOURCE_TEXT}）`);
}

/**
 * 作品の分かっている読みを集める（語 → 読みの並び）。
 *
 * - ルビ：親文字に漢字があり、読みが仮名だけのもの（傍点の代用 `《・・》` は落ちる）。
 *   **メモの行は読まない**（作者の覚え書きで、本文ではない）
 * - 読みの辞書：消した項目（墓標）と読みの空の項目は使わない
 * - 設定資料の読み：**1字の名前・別名も含める**（読み上げでは一般の語とぶつかるので当てないが、
 *   ここでは「エンジンがどう読むか」を問うだけなので、当てない理由にならない）
 * - 同じ語に違う読みがあれば両方を持つ（一日：ついたち／いちにち）。同じ読みは最初の出どころだけ
 *
 * 並びは、ルビ（話の順）→ 読みの辞書（話の順）→ 設定資料。先に出たものが「正しい読み」として
 * 行に出る
 */
export function collectKnownReadings(
  episodes: readonly KnownReadingEpisode[],
  names: readonly KnownNameReading[],
  memoMarkers?: MemoMarkers
): Map<string, KnownReading[]> {
  const known = new Map<string, KnownReading[]>();
  const add = (word: string, rawReading: string, source: KnownReadingSource): void => {
    const surface = word.trim();
    // 1字の語にルビを振ったもの（風《かぜ》）は、文脈で読みが変わる普通の語で、誤検出になった。
    // 設定資料・読みの辞書の1字の語は、作者が読みを決めたものなので今までどおり
    if (source.kind === "ruby" && [...surface].length === 1) return;
    const written = rawReading.replace(/[\s　]+/g, "");
    const reading = toHiragana(written);
    if (surface === "" || !KANJI.test(surface) || !HIRAGANA_ONLY.test(reading)) return;
    // 読みが字面と同じ（仮名の語）は、エンジンが読み違えない
    if (reading === toHiragana(surface)) return;
    const list = known.get(surface) ?? [];
    if (list.some((item) => item.reading === reading)) return;
    list.push({ word: surface, reading, written, source });
    known.set(surface, list);
  };
  for (const episode of episodes) {
    const lines = episode.text.split("\n");
    const memo = memoLineMask(lines, memoMarkers);
    lines.forEach((line, index) => {
      if (memo[index]) return;
      for (const token of tokenizeLine(line, episode.notation)) {
        if (token.kind === "ruby") add(token.base, token.reading, { kind: "ruby", episode: episode.label });
      }
    });
  }
  for (const episode of episodes) {
    for (const entry of episode.dictionary) {
      if (entry.removed || entry.reading === "") continue;
      add(entry.word, entry.reading, { kind: "dictionary", episode: episode.label });
    }
  }
  for (const name of names) add(name.surface, name.reading, { kind: "settings" });
  return known;
}

/** 調べる1か所（送る文に漢字のまま残る、読みの分かっている語の出現） */
export interface MisreadCandidate {
  /** 計画の中の文の添字 */
  sentence: number;
  /** 元の本文の位置（語の頭と終わり） */
  start: number;
  end: number;
  /** 1始まりの行番号 */
  line: number;
  word: string;
  /** その語の分かっている読み（1つ以上） */
  readings: readonly KnownReading[];
  /** (a) 送る文のまま */
  speech: string;
  /** (b) その語を読みごとに正しい読み（カタカナ）へ置き換えた文。`readings` と同じ並び */
  corrected: readonly string[];
}

/** ひらがな → カタカナ（字を足しも削りもしない） */
export function toKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
}

/**
 * 漢字のまま残る出現を拾う。
 *
 * 文の並びは **`buildReadingPlan` で作る**——人物の声と同じ切り方（台詞の境目でも切る）・
 * 同じ読みの範囲で作らないと、エンジンへ送る文と違う文を調べることになる。
 *
 * 拾わないもの：
 * - ルビ・傍点の記法の内側（作者が読ませ方を決めた所）
 * - 読みの範囲（読みの辞書・設定資料の読み・IME の読み）で置き換え済みの所
 * - 語の前後が漢字に続く所（「灯」を「街灯」の中で拾わない。熟語の中では別の読みになる）
 *
 * 語は長い順に当て、重ねない（「灯里」の中の「灯」を別に拾わない）。
 *
 * @param readings 声へ渡す写しで差し替える読みの範囲（製品の読み上げと同じもの）
 */
export function findMisreadCandidates(
  text: string,
  notation: NotationMode,
  readings: readonly ReadingSpan[],
  known: ReadonlyMap<string, readonly KnownReading[]>,
  memoMarkers?: MemoMarkers
): { sentences: ReadingSentence[]; candidates: MisreadCandidate[] } {
  const sentences = buildReadingPlan(text, notation, readings, {
    splitDialogue: true,
    ...(memoMarkers ? { memoMarkers } : {}),
  });
  const covered = notationCoverage(text, notation);
  for (const span of readings) {
    for (let at = span.start; at < span.end && at < covered.length; at++) covered[at] = true;
  }
  // 頭の字ごとに、長い順の語の並び（全部の語を全部の位置で試さない）
  const byHead = new Map<string, string[]>();
  for (const word of known.keys()) {
    const list = byHead.get(word[0]) ?? [];
    list.push(word);
    byHead.set(word[0], list);
  }
  for (const list of byHead.values()) list.sort((a, b) => b.length - a.length);

  const candidates: MisreadCandidate[] = [];
  sentences.forEach((sentence, index) => {
    let at = sentence.start;
    while (at < sentence.end) {
      const word = (byHead.get(text[at]) ?? []).find((candidate) =>
        fitsAt(text, at, candidate, sentence.end, covered)
      );
      if (!word) {
        at++;
        continue;
      }
      const list = known.get(word) ?? [];
      candidates.push({
        sentence: index,
        start: at,
        end: at + word.length,
        line: sentence.line,
        word,
        readings: list,
        speech: sentence.speech,
        corrected: list.map((item) =>
          sentenceSpeechWith(text, sentence, notation, [
            ...readings,
            { start: at, end: at + word.length, reading: toKatakana(item.reading) },
          ])
        ),
      });
      at += word.length;
    }
  });
  return { sentences, candidates };
}

/** その位置にその語が、拾ってよい形で在るか */
function fitsAt(
  text: string,
  at: number,
  word: string,
  sentenceEnd: number,
  covered: readonly boolean[]
): boolean {
  const end = at + word.length;
  if (end > sentenceEnd || !text.startsWith(word, at)) return false;
  for (let i = at; i < end; i++) if (covered[i]) return false;
  if (at > 0 && KANJI.test(word[0]) && KANJI.test(text[at - 1])) return false;
  if (end < text.length && KANJI.test(word[word.length - 1]) && KANJI.test(text[end])) return false;
  return true;
}

/* ── エンジンの答えをかなに ───────────────────────────── */

/**
 * `audio_query` の答えから、モーラのかなを並べる。**形が違えば undefined**（呼ぶ側が理由を出して止める）。
 *
 * 使うのは `accent_phrases[].moras[].text` だけ。休止（`pause_mora`）は外す——読点の休止は
 * 読みではなく、(a)(b) で置き換えた語の長さが違うと休止の位置の見え方も変わる
 */
export function kanaOfAudioQuery(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const phrases = (json as Record<string, unknown>).accent_phrases;
  if (!Array.isArray(phrases)) return undefined;
  let kana = "";
  for (const phrase of phrases) {
    if (typeof phrase !== "object" || phrase === null) return undefined;
    const moras = (phrase as Record<string, unknown>).moras;
    if (!Array.isArray(moras)) return undefined;
    for (const mora of moras) {
      if (typeof mora !== "object" || mora === null) return undefined;
      const text = (mora as Record<string, unknown>).text;
      if (typeof text !== "string") return undefined;
      kana += text;
    }
  }
  return kana;
}

/** 母音の段（モーラの最後の字で決まる。キョ は ョ でオ段） */
const VOWEL_ROWS: ReadonlyArray<[string, string]> = [
  ["a", "アカガサザタダナハバパマヤラワァャヮヵ"],
  ["i", "イキギシジチヂニヒビピミリィ"],
  ["u", "ウクグスズツヅヌフブプムユルゥュヴ"],
  ["e", "エケゲセゼテデネヘベペメレェヶ"],
  ["o", "オコゴソゾトドノホボポモヨロヲォョ"],
];
const VOWEL_OF = new Map<string, string>();
for (const [vowel, chars] of VOWEL_ROWS) for (const char of chars) VOWEL_OF.set(char, vowel);
const VOWEL_KANA: Record<string, string> = { a: "ア", i: "イ", u: "ウ", e: "エ", o: "オ" };

/** 小書きの字（前の字と1つのモーラ。比べた違いの境目をここで切らない） */
const SMALL_KANA = new Set("ァィゥェォャュョヮ");

/**
 * かなを比べる形にならす。返すのは、ならす前の字（`raw`）と、ならした字（`norm`）の
 * **同じ長さの並び**（違いの場所を、ならす前の字で作者に見せるため）。
 *
 * - ひらがな → カタカナ。カタカナと長音以外（句読点・空白・記号）は外す
 * - ヲ→オ、ヂ→ジ、ヅ→ズ
 * - 長音 `ー` は前の字の母音にする（カー＝カア）
 * - オ段のあとのウはオ、エ段のあとのイはエ（トウキョウ＝トーキョー、セイ＝セー。
 *   エンジンは同じ語を、文の形によってどちらでも返しうる）
 */
export function normalizeKana(kana: string): { raw: string[]; norm: string[] } {
  const raw = [...toKatakana(kana)].filter((char) => /[ァ-ヶー]/.test(char));
  const norm: string[] = [];
  for (const char of raw) {
    let out = char === "ヲ" ? "オ" : char === "ヂ" ? "ジ" : char === "ヅ" ? "ズ" : char;
    const previous = norm.length > 0 ? VOWEL_OF.get(norm[norm.length - 1]) : undefined;
    if (out === "ー" && previous) out = VOWEL_KANA[previous];
    else if (out === "ウ" && previous === "o") out = "オ";
    else if (out === "イ" && previous === "e") out = "エ";
    norm.push(out);
  }
  return { raw, norm };
}

/**
 * (a) と (b) のかなを比べる。同じなら `same: true`。違えば、前後の共通部分を外した
 * 真ん中の (a) 側（＝エンジンの読み。ならす前の字）を返す
 */
export function compareKana(
  sent: string,
  corrected: string,
  expected?: string
): { same: boolean; engineReading: string } {
  const a = normalizeKana(sent);
  const b = normalizeKana(corrected);
  if (a.norm.join("") === b.norm.join("")) return { same: true, engineReading: "" };
  /*
    正しい読みを差し込んだ位置（(b) の中）。分かれば、外す共通部分は語の手前と後ろまでにする。
    共通部分だけで切ると、語の頭や尾が正しい読みと同じとき、語の途中で切れる
    （近衛騎士：コノエキシ／コンエイキシ → 「ノ」。2026-11-15 の実データの測定）
  */
  const word = expected === undefined ? undefined : wordSpanIn(b.norm, normalizeKana(expected).norm);
  let head = 0;
  while (head < a.norm.length && head < b.norm.length && a.norm[head] === b.norm[head]) head++;
  if (word) head = Math.min(head, word.before);
  // 小書きの字の手前で切らない（キ｜ョ にしない）
  while (head > 0 && (SMALL_KANA.has(a.raw[head] ?? "") || SMALL_KANA.has(b.raw[head] ?? ""))) head--;
  let tail = 0;
  while (
    tail < a.norm.length - head &&
    tail < b.norm.length - head &&
    a.norm[a.norm.length - 1 - tail] === b.norm[b.norm.length - 1 - tail]
  ) {
    tail++;
  }
  if (word) tail = Math.min(tail, word.after);
  // 共通の後ろの頭が小書きの字なら、その字を真ん中へ戻す
  while (tail > 0 && SMALL_KANA.has(a.raw[a.raw.length - tail] ?? "")) tail--;
  return { same: false, engineReading: a.raw.slice(head, a.raw.length - tail).join("") };
}

/** ならしたかなの列 `whole` の中で、`part` が始まる前の字数と、終わったあとの字数（見つからなければ undefined） */
function wordSpanIn(whole: readonly string[], part: readonly string[]): { before: number; after: number } | undefined {
  if (part.length === 0) return undefined;
  outer: for (let at = 0; at + part.length <= whole.length; at++) {
    for (let index = 0; index < part.length; index++) {
      if (whole[at + index] !== part[index]) continue outer;
    }
    return { before: at, after: whole.length - at - part.length };
  }
  return undefined;
}

/* ── 判定 ─────────────────────────────────────────── */

/** エンジンへ読み方の下ごしらえを頼み、答え（JSON）を返す口 */
export type MisreadQuery = (speech: string) => Promise<unknown>;

/** 読み間違いの見込み（1か所） */
export interface MisreadFinding {
  candidate: MisreadCandidate;
  /** エンジンの読み（カタカナ。前後の共通部分を外した真ん中） */
  engineReading: string;
  /** 正しい読み（行に出すもの。分かっている読みの最初） */
  expected: KnownReading;
}

/** エンジンの答えの形が読めない（調べずに止める。エラー文から原因を当てない） */
export class MisreadAnswerError extends Error {
  constructor(readonly speech: string) {
    super("音声合成のエンジンの読み方の答え（audio_query）に、読み（モーラ）の並びがありません");
  }
}

/**
 * 拾った出現を、エンジンに問うて確かめる。
 *
 * - **同じ文は2回問わない**（1回の調べの中。文が同じなら答えも同じ）。この調べより長く覚える
 *   控えは呼ぶ側が `query` の中に持つ（エンジンと文の中身を鍵にする）
 * - 読みが2つ以上ある語は、**どれかの読みで (a) と同じになれば読めている**
 * - 答えの形が違えば `MisreadAnswerError` を投げる（調べ全体を止める。途中までの結果は出さない）
 *
 * 問う順は頭から1つずつ（エンジンは頼みを1つずつ作る。並べても速くならない）。`signal` で止められる
 */
export async function judgeMisreads(
  candidates: readonly MisreadCandidate[],
  query: MisreadQuery,
  signal?: AbortSignal
): Promise<MisreadFinding[]> {
  const asked = new Map<string, string>();
  const kanaOf = async (speech: string): Promise<string> => {
    const cached = asked.get(speech);
    if (cached !== undefined) return cached;
    const kana = kanaOfAudioQuery(await query(speech));
    if (kana === undefined) throw new MisreadAnswerError(speech);
    asked.set(speech, kana);
    return kana;
  };
  const found: MisreadFinding[] = [];
  for (const candidate of candidates) {
    if (signal?.aborted) break;
    const sent = await kanaOf(candidate.speech);
    let first: { same: boolean; engineReading: string } | undefined;
    let readable = false;
    for (const [index, corrected] of candidate.corrected.entries()) {
      // corrected は readings と同じ順（findMisreadCandidates）。正しい読みで語の範囲を決める
      const compared = compareKana(sent, await kanaOf(corrected), candidate.readings[index]?.reading);
      first ??= compared;
      if (compared.same) {
        readable = true;
        break;
      }
    }
    if (readable || !first || candidate.readings.length === 0) continue;
    found.push({ candidate, engineReading: first.engineReading, expected: candidate.readings[0] });
  }
  return found;
}

/* ── 行にする材料 ─────────────────────────────────────── */

/** 前後に添える字の上限（片側） */
const WINDOW_SIDE = 8;

/** 記法の字（書きかけのものも）。窓に入れない——当てる側の置き換えが記法の中へ当たらないように */
const NOTATION_CHAR = /[|｜{}《》]/;

/**
 * その出現を指す短い窓（行の中・記法を含まない・語がちょうど1回）。
 *
 * 校正・メモパネルの行の原文（`original`）と、［読みの辞書へ足す］の句（`quote`）に使う。
 * **語がちょうど1回**にするのは、当てる側（`findingApply.ts`）が原文の中の最初の一致を
 * 置き換えるため——同じ文に `{灯|あかり}` と素の「灯」があると、ルビの親文字へ当たりうる
 */
export function misreadWindow(text: string, start: number, end: number, notation: NotationMode): string {
  const word = text.slice(start, end);
  const covered = notationCoverage(text, notation);
  const blocked = (at: number): boolean =>
    at < 0 || at >= text.length || text[at] === "\n" || covered[at] || NOTATION_CHAR.test(text[at]);
  let from = start;
  while (start - from < WINDOW_SIDE && !blocked(from - 1)) from--;
  let to = end;
  while (to - end < WINDOW_SIDE && !blocked(to)) to++;
  // 語が窓の中でちょうど1回になるまで、外側から削る
  let window = text.slice(from, to);
  while (window.indexOf(word) !== start - from || window.indexOf(word, start - from + 1) >= 0) {
    const before = text.slice(from, start);
    if (before.includes(word)) from++;
    else to--;
    window = text.slice(from, to);
  }
  // 句の上限（読みの辞書の決まり）に収める
  while (window.length > READING_QUOTE_MAX && (from < start || to > end)) {
    if (start - from >= to - end && from < start) from++;
    else to--;
    window = text.slice(from, to);
  }
  return window;
}

/* ── 校正・メモパネルの行 ─────────────────────────────── */

/**
 * 見込みを、校正・メモパネルの行（指摘の置き場 `.aiwriter/findings.jsonl`）の形へ組む。
 *
 * - 原文（`original`）は `misreadWindow`、置き換える範囲（`target`）は語
 * - 修正案（`suggestion`）はその場所へ振るルビ（その原稿の書き方。`.md` は `{灯|あかり}`、
 *   `.txt` は `｜灯《あかり》`）。**当てるのは作者が［ここにルビを振る］を押したときだけ**で、
 *   当てる道は提案パネルの［適用］と同じ（ハッシュの照合・文字コードと改行の保持）
 * - 番号は中身から作る（`buildFinding`）ので、調べ直しても同じ所は同じ番号になり、
 *   見送った行は見送ったまま
 * - 種類は `other`（AIの検知ではない。声のエンジンの読みとの比べ）
 */
export function buildMisreadFindings(
  workFolder: string,
  filePath: string,
  text: string,
  notation: NotationMode,
  found: readonly MisreadFinding[],
  time: string
): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const item of found) {
    const { candidate, expected } = item;
    const original = misreadWindow(text, candidate.start, candidate.end, notation);
    const finding = buildFinding(
      workFolder,
      {
        filePath,
        line: candidate.line,
        original,
        target: candidate.word,
        suggestion: rubyEditReplacement(candidate.word, expected.written, rubyNotationFor(filePath)),
        message: misreadMessage(candidate.word, item.engineReading, expected),
        category: "other",
        label: MISREAD_FINDING_LABEL,
      },
      text,
      time
    );
    if (!finding || seen.has(finding.id)) continue;
    seen.add(finding.id);
    out.push(finding);
  }
  return out;
}

/** 行の主文（場所の札の横に出る1文） */
export function misreadMessage(word: string, engineReading: string, expected: KnownReading): string {
  const heard = engineReading === "" ? "読み飛ばしそうです" : `「${engineReading}」と読みそうです`;
  return `「${word}」を、声のエンジンは${heard}。正しい読みは「${expected.written}」（${describeReadingSource(expected.source)}）。`;
}

/**
 * ［読みの辞書へ足す］で足す項目（語・句・読み）。足せなければ理由の文。
 *
 * 句は行の原文（記法を含まない短い窓）。読みの辞書の決まり（30字以内・改行なし・語より長い・
 * 本文にそのまま在る）を、ここで確かめる——足しても当たらない項目を作らない
 */
export function misreadDictionaryEntry(
  finding: Pick<Finding, "original" | "target" | "suggestion">,
  notation: NotationMode,
  text: string
): { word: string; quote: string; reading: string } | string {
  const word = finding.target;
  const quote = finding.original;
  const ruby = tokenizeLine(finding.suggestion, notation).find((token) => token.kind === "ruby");
  const reading = ruby && ruby.kind === "ruby" ? toHiragana(ruby.reading) : "";
  if (word === "" || !HIRAGANA_ONLY.test(reading)) return "この行から読みを取り出せませんでした。";
  if (quote === word || !quote.includes(word)) {
    return `「${word}」の前後に字が無いので、読みの辞書の句にできません（［ここにルビを振る］で直してください）。`;
  }
  if (quote.length > READING_QUOTE_MAX || /[\r\n]/.test(quote)) return "句が長すぎて、読みの辞書に入れられません。";
  if (!text.includes(quote)) {
    return "本文が変わっていて、この場所が見つかりません。もう一度「読み間違いを調べる」を押してください。";
  }
  return { word, quote, reading };
}
