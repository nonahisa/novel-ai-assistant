import {
  HIRAGANA_ONLY,
  KANJI,
  toHiragana,
  type ReadingSpan,
} from "./readingDictionary";
import { toDictionaryReading } from "./reading";
import { aliasReadingOf, type AliasReadings } from "../models/aliasReading";

/**
 * IMEで打った読みを拾う（設計書6.42.2）。
 *
 * 作者が原稿エディターで設定資料の名前を打つとき、IMEには必ず読みを打っている。
 * 「あかり」と打って「灯」へ変換したなら、作者にとっての「灯」の読みは「あかり」
 * である。これを拾って、設定資料の読みと読み上げに効かせる。
 *
 * ## どのIMEでも同じ道で取れる
 *
 * 読みはブラウザの標準の知らせ（compositionupdate・compositionend）から取る。
 * MS-IME・Google 日本語入力・ATOK のどれでも同じ形で届くので、IMEの種類は見ない。
 * 日本語のIMEでは、変換中の文字（data）が「かなだけ」から「漢字まじり」へ変わる。
 * **最後にかなだけだった状態**が、作者が打った読みである。
 *
 * ## 確かでないものは採らない
 *
 * 拾い損ねても何も壊れない（設定資料の読みが空のままなだけ）が、誤って拾うと
 * 声が名前を読み違える。そこで、確定した文字列が**設定資料の名前と完全に一致した
 * ときだけ**採る（前後に付いた助詞などのかなは、読みの側の同じかなと一緒に外す）。
 *
 * 姓と名を分けて確定する打ち方（「しらかば」→白樺、「あかり」→灯）では、画面が
 * すぐ後ろへ続けて打ったと確かめた前の確定を添えてくる。そのときは2回をつないで
 * 同じ決まりで照らす（`captureJoinedImeReading`）。
 *
 * ## ここは vscode に触らない
 *
 * 引き当て・控えの形・書くか提案するかの分かれ目・読み上げの範囲は純粋な
 * 文字列処理で、単体テストで確かめる。読み書きは `imeReadingStore.ts`、
 * 設定資料へ書くのは `features/imeReadings.ts`。
 */

/** 変換の知らせ1つ（画面で起きる順に並べる） */
export interface CompositionEvent {
  type: "start" | "update" | "end" | "input";
  /** 知らせの data。end で data が無い環境がある */
  data?: string;
}

/** 変換1回ぶん：打った読み（かな）と確定した文字列 */
export interface CompositionPair {
  kana: string;
  committed: string;
}

/** 拾った読み：どの名前を、どう読んだか */
export interface ImeCapture {
  surface: string;
  reading: string;
}

/** 画面から届く文字列の上限。名前1つの変換としては十分に長い */
export const IME_TEXT_MAX = 64;

/** 読みの上限（字）。長い名前（「白樺の森」など）でも収まる長さ */
const IME_READING_MAX = 32;

/** 変換中の「かなだけ」の形。画面と同じく、ひらがなと長音だけを見る */
const KANA_ONLY_FOR_READING = /^[ぁ-ゖー]+$/;

/** 名前の前後に付いてよい字（助詞・送り仮名など。かなと長音だけ） */
const KANA_ONLY = /^[ぁ-ゖァ-ヶー]*$/;

/**
 * 変換の流れから、読みと確定した文字列を取り出す。
 *
 * **画面の中の処理はこれと同じ決まりの写しである**（`manuscriptEditorHtml.ts` の
 * `ime-reading` の印の中）。画面では知らせを並べて持たず、変数を2つ覚えるだけにした
 * ——変換中の1字ごとに重い処理を走らせて、入力が重くなった過去がある（設計書6.34.5）。
 *
 * - 読み：最後にかなだけだった update の data
 * - 確定：end の data。**end の data が空の文字列なら取り消し（Esc）なので拾わない。**
 *   data そのものが無い環境では、最後に入った字（input）か最後の update を使う
 */
export function readingFromComposition(
  events: readonly CompositionEvent[]
): CompositionPair | undefined {
  let kana = "";
  let last = "";
  let committed: string | undefined;
  for (const event of events) {
    const data = event.data;
    if (event.type === "start") {
      kana = "";
      last = "";
      committed = undefined;
    } else if (event.type === "update") {
      if (typeof data === "string") {
        last = data;
        if (KANA_ONLY_FOR_READING.test(data)) kana = data;
      }
    } else if (event.type === "input") {
      if (typeof data === "string" && data !== "") last = data;
    } else {
      committed = typeof data === "string" ? data : last;
    }
  }
  if (!kana || !committed) return undefined;
  return { kana, committed };
}

/**
 * 名前のすぐ後ろに続いてよいかなの頭（助詞・敬称・複数）。
 *
 * **送り仮名を名前の外と読み違えないため。** 名前が「灯」の作品で、作者が
 * ふつうの語の「灯り」（あかり）を打つと、後ろの「り」を助詞と同じに外して
 * 「灯」を「あか」と読んだことになる。名前の後ろに続くのは、ほとんどが
 * 助詞か敬称なので、それ以外で始まるかなが続く確定は採らない
 */
const AFTER_NAME = [
  "は", "が", "を", "に", "へ", "と", "の", "で", "も", "や", "か", "よ", "ね", "な",
  "さん", "さま", "くん", "ちゃん", "たち", "ら", "から", "まで", "より", "だ", "です",
  "って",
];

function canFollowName(after: string): boolean {
  if (after === "") return true;
  const head = toHiragana(after);
  return AFTER_NAME.some((word) => head.startsWith(word));
}

/**
 * 名前の形から、読みが満たすべき形を作る。
 *
 * 漢字の並びは「漢字の数以上のかな」、名前の中のかな（「白樺の森」の「の」、
 * 「灯り」の「り」）は**読みの同じ位置に同じかな**。漢字でもかなでもない字
 * （中黒・英字など）を含む名前は、読みの形が決まらないので undefined
 */
function readingShapeOf(name: string): RegExp | undefined {
  let source = "";
  let kanjiRun = 0;
  const flush = (): void => {
    if (kanjiRun > 0) source += `[ぁ-ゖー]{${kanjiRun},}`;
    kanjiRun = 0;
  };
  for (const char of name) {
    if (KANJI.test(char)) {
      kanjiRun++;
      continue;
    }
    if (!KANA_ONLY.test(char)) return undefined;
    flush();
    // かなは正規表現の特別な字を含まない
    source += toHiragana(char);
  }
  flush();
  return new RegExp(`^${source}$`);
}

/**
 * 打った読みと確定した文字列から、設定資料の名前の読みを引き当てる。
 *
 * 決まり（どれか1つでも外れたら採らない）：
 *
 * 1. 確定した文字列に漢字がある（かなだけ・カタカナ名は読みが字そのもの）
 * 2. 確定した文字列 ＝ かな ＋ **名前と完全に一致する部分** ＋ かな。
 *    前後のかなは、読みの頭と尻にも同じかなが要る（「灯は」と「あかりは」の「は」）。
 *    **前後に漢字が残るものは捨てる**——どこまでが名前の読みか決まらない。
 *    後ろのかなは助詞・敬称で始まるものだけ（送り仮名と取り違えない。`AFTER_NAME`）
 * 3. 名前の頭・尻のかな（「白樺の森」の「の」は中なので見ない、「灯り」の「り」）は
 *    読みの頭・尻にも在る
 * 4. 読みの字数が名前の漢字の数以上（予測変換で途中の読みしか無いものを捨てる）
 * 5. 当たる名前が複数あれば長いほう（「灯里」の中の「灯」で採らない）。
 *    同じ長さで読みが割れたら採らない
 *
 * 前後のかなを先に削ってから名前と比べる形にしないのは、名前の尻のかな
 * （「灯り」の「り」）まで削れて、名前と合わなくなるため。
 */
export function captureImeReading(
  kana: string,
  committed: string,
  names: readonly string[]
): ImeCapture | undefined {
  const typed = kana.trim();
  const fixed = committed.trim();
  if (typed.length > IME_TEXT_MAX || fixed.length > IME_TEXT_MAX) return undefined;
  return captureWhere(typed, fixed, names, () => true);
}

/**
 * 続けて打った2回の確定を、1回の確定とみなしてよい間の長さ（ミリ秒）。
 *
 * 作者は姓と名を分けて確定する（「しらかば」→白樺、「あかり」→灯。2026-10-24）。
 * その夜の actions.log では、1組の2回の確定が 7〜8 秒離れていた（21:54:19→:26、
 * :33→:41。後ろの名を打って変換する間を含む）。3秒などにすると作者本人の打ち方が
 * 通らないので、その倍ほどの 15 秒にした。
 *
 * **誤ってつなげない守りは、時間ではなく位置と照合である。** つなぐのは前の確定の
 * すぐ後ろ（カーソルの直前に前の確定の字がある）に打ったときだけで、しかも
 * つないだ字がまるごと設定資料の名前と一致したときだけ採る。時間は「しばらく
 * 書いたあと戻ってきた」ものを切る程度の役目なので、寛めに取ってよい。
 *
 * **画面の側（`manuscriptEditorHtml.ts` の `ime-reading` の印の中）に同じ値の写しが
 * ある**（画面へは import できない）。揃っていることはテストが見張る
 */
export const IME_JOIN_GAP_MS = 15_000;

/**
 * 続けて打った2回の確定を、つなげて名前と照らす（設計書6.42.2。作者の裁定
 * 「つなげて照らす」、2026-10-24）。
 *
 * **つなぐのは2回まで**（前の確定1つと、いまの確定）。作者の打ち方（姓＋名）は
 * 2回で、ミドルネームのある名前は「・」などの区切りを別に打つので、区切りで
 * かなでも漢字でもない字が入り、どのみち読みの形が決まらない（`readingShapeOf`）。
 *
 * 照らし方は1回の確定と同じ決まり（`captureImeReading`）を、つないだ字と読みに
 * そのまま当てる。違うのは1つだけ——**名前が2回の確定の境目をまたぐときだけ採る。**
 * 名前がまるごと前の確定の中にあるなら、前の確定を受け取ったときに拾い済みで
 * （後ろに助詞「は」を確定した、など）、まるごといまの確定の中にあるなら
 * 1回の確定として拾う側が受け持つ。どちらもここで拾うと二重に数える。
 *
 * 前後に空白の付いた確定はつながない（どこまでが前の確定か決まらない）
 */
export function captureJoinedImeReading(
  previous: CompositionPair,
  current: CompositionPair,
  names: readonly string[]
): ImeCapture | undefined {
  for (const part of [previous, current]) {
    if (!part.kana || !part.committed) return undefined;
    if (part.kana.trim() !== part.kana || part.committed.trim() !== part.committed) {
      return undefined;
    }
  }
  const boundary = previous.committed.length;
  return captureWhere(
    previous.kana + current.kana,
    previous.committed + current.committed,
    names,
    (at, end) => at < boundary && end > boundary
  );
}

/**
 * 引き当ての本体。`accept` は、確定した字の中の名前の位置（at〜end）を採ってよいか。
 * **採れない位置は、長い名前を選ぶ比べにも入れない**（入れると、採れない長い名前が
 * 採れる短い名前を押しのける）
 */
function captureWhere(
  kana: string,
  fixed: string,
  names: readonly string[],
  accept: (at: number, end: number) => boolean
): ImeCapture | undefined {
  const typed = toHiragana(kana);
  if (!typed || !fixed) return undefined;
  // つないだ字は2回ぶんの長さまで（1回ぶんの上限は呼ぶ側と画面で見ている）
  if (typed.length > IME_TEXT_MAX * 2 || fixed.length > IME_TEXT_MAX * 2) return undefined;
  if (!HIRAGANA_ONLY.test(typed)) return undefined;
  if (!KANJI.test(fixed)) return undefined;

  let best: ImeCapture | undefined;
  let ambiguous = false;
  for (const raw of new Set(names)) {
    const name = raw.trim();
    if (!name || !KANJI.test(name)) continue;
    for (let at = fixed.indexOf(name); at >= 0; at = fixed.indexOf(name, at + 1)) {
      if (!accept(at, at + name.length)) continue;
      const before = fixed.slice(0, at);
      const after = fixed.slice(at + name.length);
      if (!KANA_ONLY.test(before) || !KANA_ONLY.test(after)) continue;
      if (!canFollowName(after)) continue;
      const head = toHiragana(before);
      const tail = toHiragana(after);
      if (!typed.startsWith(head) || !typed.endsWith(tail)) continue;
      if (typed.length <= head.length + tail.length) continue;
      const reading = typed.slice(head.length, typed.length - tail.length);
      if (!isPlausibleReading(name, reading)) continue;
      if (!best || name.length > best.surface.length) {
        best = { surface: name, reading };
        ambiguous = false;
      } else if (name.length === best.surface.length && reading !== best.reading) {
        ambiguous = true;
      }
    }
  }
  return ambiguous ? undefined : best;
}

function isPlausibleReading(name: string, reading: string): boolean {
  if (!HIRAGANA_ONLY.test(reading) || reading.length > IME_READING_MAX) return false;
  return readingShapeOf(name)?.test(reading) === true;
}

/* ── 控え（`.aiwriter/imeReadings.json`） ─────────────────────── */

/** 控えの1項目：その名前をその読みで何回打ったか */
export interface ImeReadingEntry {
  surface: string;
  reading: string;
  count: number;
  /** 最後に打った日時（ISO） */
  lastSeen: string;
}

export interface ImeReadingFile {
  version: 1;
  entries: ImeReadingEntry[];
}

/**
 * 控えの上限。打った名前の数に見合う量で、増え続けないように古いものから落とす。
 * 落ちるのは長く打っていない名前だけなので、設定資料の読みには響かない
 */
export const IME_READING_ENTRY_MAX = 1000;

/** 控えを読む。**壊れていたら直さずに投げる**（CLAUDE.md 実装ルール2） */
export function parseImeReadingFile(text: string): ImeReadingFile {
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null) {
    throw new Error("IMEの読みの控えの形が違います");
  }
  const record = data as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.entries)) {
    throw new Error("IMEの読みの控えの形が違います");
  }
  const entries: ImeReadingEntry[] = [];
  for (const raw of record.entries) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("IMEの読みの控えの項目の形が違います");
    }
    const item = raw as Record<string, unknown>;
    if (
      typeof item.surface !== "string" ||
      typeof item.reading !== "string" ||
      typeof item.count !== "number" ||
      typeof item.lastSeen !== "string"
    ) {
      throw new Error("IMEの読みの控えの項目の形が違います");
    }
    entries.push({
      surface: item.surface,
      reading: item.reading,
      count: item.count,
      lastSeen: item.lastSeen,
    });
  }
  return { version: 1, entries };
}

/** 拾った読みを1回ぶん足す（同じ名前・同じ読みは回数を足す）。元の控えは変えない */
export function recordImeReadingEntry(
  file: ImeReadingFile,
  capture: ImeCapture,
  now: string
): ImeReadingFile {
  let found = false;
  const entries = file.entries.map((entry) => {
    if (entry.surface !== capture.surface || entry.reading !== capture.reading) return entry;
    found = true;
    return { ...entry, count: entry.count + 1, lastSeen: now };
  });
  if (!found) {
    entries.push({ surface: capture.surface, reading: capture.reading, count: 1, lastSeen: now });
  }
  if (entries.length > IME_READING_ENTRY_MAX) {
    entries.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    entries.length = IME_READING_ENTRY_MAX;
  }
  return { version: 1, entries };
}

/**
 * 名前ごとの主な読み。**回数の多いほう**、同じ回数なら新しく打ったほう。
 * 予測変換で一度だけ短い読みが入っても、いつもの打ち方が勝つ
 */
export function primaryImeReadings(file: ImeReadingFile): Map<string, string> {
  const best = new Map<string, ImeReadingEntry>();
  for (const entry of file.entries) {
    const current = best.get(entry.surface);
    if (
      !current ||
      entry.count > current.count ||
      (entry.count === current.count && entry.lastSeen > current.lastSeen)
    ) {
      best.set(entry.surface, entry);
    }
  }
  return new Map([...best].map(([surface, entry]) => [surface, entry.reading]));
}

/* ── 設定資料へ書くか、提案にするか ──────────────────────────── */

/** 読みを比べる形（カタカナ・区切りの違いは同じ読みとみる） */
function comparable(reading: string | null): string {
  const text = (reading ?? "").trim();
  if (!text) return "";
  return toDictionaryReading(text) ?? text;
}

/**
 * 拾った読みを、その項目にどう効かせるか（作者の裁定、2026-10-24）。
 *
 * - `fill`：AIが作った項目（`autoGenerated: true`）で読みが空——自動で埋める
 * - `suggest`：作者が作った項目、またはすでに別の読みが入っている——書かずに
 *   パネルで「IMEでは『…』と打っています」と出す（CLAUDE.md 実装ルール2）
 * - `none`：同じ読みが入っている
 */
export function decideImeReading(
  record: { autoGenerated: boolean; reading: string | null },
  reading: string
): "fill" | "suggest" | "none" {
  const current = comparable(record.reading);
  if (current === comparable(reading)) return "none";
  if (record.autoGenerated && current === "") return "fill";
  return "suggest";
}

/**
 * パネルに出す提案の読み（無ければ undefined）。
 *
 * **名前の読みだけを見る。** 別名で拾った読み（「姫」→「ひめ」）は別名の読みで
 * あって、項目の読み（名前の読み）ではない。まだ埋めていない `fill` も提案として
 * 出す（控えが先にあって項目があとからできた、など）
 */
export function imeSuggestionFor(
  record: { name: string; autoGenerated: boolean; reading: string | null },
  primary: ReadonlyMap<string, string>
): string | undefined {
  const reading = primary.get(record.name.trim());
  if (!reading) return undefined;
  return decideImeReading(record, reading) === "none" ? undefined : reading;
}

/**
 * パネルに出す、別名ごとの提案（無ければ空）。
 *
 * 別名で拾った読みは、**その別名の読み（`aliasReadings`）と比べる**。分かれ目は
 * 名前の読みと同じ `decideImeReading`——別名の読みが空で AIが作った項目なら
 * 裏で埋まる（`fill`）が、まだ埋めていないものも提案として出す（名前の提案と同じ）
 */
export function imeAliasSuggestionsFor(
  record: {
    aliases: readonly string[];
    autoGenerated: boolean;
    aliasReadings?: Readonly<AliasReadings>;
  },
  primary: ReadonlyMap<string, string>
): Array<{ alias: string; reading: string }> {
  const out: Array<{ alias: string; reading: string }> = [];
  const seen = new Set<string>();
  for (const raw of record.aliases) {
    const alias = raw.trim();
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    const reading = primary.get(alias);
    if (!reading) continue;
    const current = { autoGenerated: record.autoGenerated, reading: aliasReadingOf(record, alias) };
    if (decideImeReading(current, reading) !== "none") out.push({ alias, reading });
  }
  return out;
}

/* ── 読み上げの範囲 ──────────────────────────────────────── */

/** 名前と、その読み（声へ渡す写しで差し替える） */
export interface NameReading {
  surface: string;
  reading: string;
}

/**
 * 設定資料とIMEの控えから、名前ごとの読みを決める。
 *
 * - 名前：設定資料の読み（ひらがなへ直せるもの）、無ければIMEの主な読み
 * - 別名：設定資料の別名の読み（`aliasReadings`）、無ければIMEの主な読み。
 *   **項目の読みは名前の読みなので、別名には当てない**
 *   （別名「姫」に名前「灯」の読み「あかり」を当てると、声が「姫」を「あかり」と読む）
 *
 * 同じ文字列が2つの項目にあれば、先に決まったほうを使う。設定資料の読み（名前・
 * 別名とも）を先にすべて決めてから IME の読みを足すので、設定資料が勝つ。
 * 別名の読みを設定資料に持つのは、IMEの控えがPCごと（同期しない）で、
 * 別のPCの読み上げでは効かないため
 */
export function nameReadingsFrom(
  records: ReadonlyArray<{
    name: string;
    aliases: readonly string[];
    reading: string | null;
    aliasReadings?: Readonly<AliasReadings>;
  }>,
  imePrimary: ReadonlyMap<string, string>
): NameReading[] {
  const out: NameReading[] = [];
  const taken = new Set<string>();
  const push = (surface: string, reading: string | undefined): void => {
    const key = surface.trim();
    if (!key || !reading || taken.has(key)) return;
    taken.add(key);
    out.push({ surface: key, reading });
  };
  for (const record of records) {
    const reading = record.reading ? toDictionaryReading(record.reading) : undefined;
    push(record.name, reading);
  }
  for (const record of records) {
    for (const alias of record.aliases) {
      const reading = aliasReadingOf(record, alias);
      push(alias, reading ? toDictionaryReading(reading) : undefined);
    }
  }
  for (const record of records) {
    push(record.name, imePrimary.get(record.name.trim()));
    for (const alias of record.aliases) push(alias, imePrimary.get(alias.trim()));
  }
  return out;
}

/**
 * 本文の中の名前の出現に、読みの範囲を作る。
 *
 * - **漢字を含む2字以上の名前だけ。** 1字の名前（「灯」）は一般の語とぶつかる
 *   （「灯がともる」まで「あかり」と読ませてしまう）。仮名だけの名前は声が読み違えない
 * - 長い名前から当て、重なる範囲は入れない（「灯里」の中の「灯」に当てない）
 */
export function nameReadingSpans(
  text: string,
  readings: readonly NameReading[]
): ReadingSpan[] {
  const usable = readings
    .filter(
      (item) =>
        item.surface.length >= 2 &&
        KANJI.test(item.surface) &&
        HIRAGANA_ONLY.test(item.reading)
    )
    .sort((a, b) => b.surface.length - a.surface.length);
  const spans: ReadingSpan[] = [];
  for (const item of usable) {
    for (
      let at = text.indexOf(item.surface);
      at >= 0;
      at = text.indexOf(item.surface, at + item.surface.length)
    ) {
      const end = at + item.surface.length;
      if (spans.some((span) => span.start < end && at < span.end)) continue;
      spans.push({ start: at, end, reading: item.reading });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * 2つの範囲の並びを合わせる。**先の並びが勝つ**——後の並びは、先のどれとも
 * 重ならないものだけ入れる。
 *
 * 声へ渡す写しは範囲を後ろから差し替えるので、重なった範囲が来ると写しが壊れる。
 * 読み上げでは「読みの辞書（文脈つき）」を先、「名前の読み」を後に渡す。
 * 作者のルビは `buildReadingPlan` が記法に掛かる範囲を使わないことで勝つ
 */
export function mergeReadingSpans(
  first: readonly ReadingSpan[],
  second: readonly ReadingSpan[]
): ReadingSpan[] {
  const merged = [...first];
  for (const span of second) {
    if (merged.some((kept) => kept.start < span.end && span.start < kept.end)) continue;
    merged.push(span);
  }
  return merged.sort((a, b) => a.start - b.start);
}
