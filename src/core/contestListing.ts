import { readCharLimit, type CharLimitReading } from "./contestCharLimit";
import { readDeadlines } from "./contestDeadline";

/**
 * 公募の一覧の読み取り（設計書6.3.6.1）。
 *
 * ## 入り口は2つ、読み取りは1つ
 *
 *   A. **ヘルパー**（ブラウザ拡張）が一覧のページを読み、1件ずつの文を
 *      クリップボードへ置く（`novelai-contests` v1）
 *   D. 作者がページの文を**全部選んでコピー**し、そのまま貼り付ける
 *
 * A はページの作り（要素）で1件ずつに分けてあり、D は文の並びで分ける。
 * **分けたあとの1件の読み取り（`parseContestCard`）は同じ関数を通す**——
 * 2つに分けると、片方を直した日にもう片方が黙って食い違う。
 *
 * ## 読むサイト
 *
 * - ノベルポータル（creative-story.net）の「文学賞・公募一覧」と「投稿サイトのコンテスト一覧」
 * - ツクリテミライ（tsukuritemirai.com）の「小説の公募一覧」
 *
 * 規則で読む。**AIは使わない**（読めないものに数を作らせない）。
 *
 * VS Code API には依存しない。
 */

/** 封筒の形式版数。読む側はこの数値と一致するときだけ受け取る（ヘルパーと揃える） */
export const CONTESTS_ENVELOPE_VERSION = 1;

/** 封筒の目印になる欄の名前（ただのJSONを封筒と読み違えないため） */
const MARKER = "novelai-contests";

/** 出どころ。貼り付けた文（D）はどのサイトのものか決めない */
export type ContestSource = "novelportal" | "tsukuritemirai" | "pasted";

const HELPER_SOURCES: readonly ContestSource[] = ["novelportal", "tsukuritemirai"];

export const CONTEST_SOURCE_LABELS: Record<ContestSource, string> = {
  novelportal: "ノベルポータル",
  tsukuritemirai: "ツクリテミライ",
  pasted: "貼り付けた一覧",
};

/** 公募1件 */
export interface ContestListing {
  readonly name: string;
  /**
   * 募集要項のURL（http・https だけ）。一覧に公式サイトへのリンクがあればそれ、
   * 無ければまとめサイトのその公募のページ。貼り付けた文（D）には無い
   */
  readonly url: string | null;
  /** 一覧の中の見出し（「2026年10月締切」「カクヨム」） */
  readonly section: string | null;
  readonly source: ContestSource;
  /** 締切の原文。無ければ null */
  readonly deadlineText: string | null;
  /** 締切の原文から読めた日付（YYYY-MM-DD）。読めなければ空 */
  readonly deadlines: readonly string[];
  readonly prize: string | null;
  /** 字数の原文。無ければ null */
  readonly charText: string | null;
  readonly organizer: string | null;
  readonly judges: string | null;
  /** 募集作品・募集内容 */
  readonly genre: string | null;
  readonly eligibility: string | null;
  readonly fee: string | null;
  readonly charLimit: CharLimitReading;
  /**
   * 欄の前に書かれた説明の書き出し（「湖を舞台にした短編を募集します。」）。
   * 応募先の提案（AI）と、作品との近さ（ベクトル検索）の材料にする（設計書6.3.6.4・6.3.6.5）。
   * **前の版の置き場には無い**ので省略できる形にしてある
   */
  readonly summary?: string | null;
}

/** 1件ずつに分けた、読み取り前の形 */
export interface ContestCardText {
  readonly name: string;
  readonly text: string;
}

export interface ContestCardInput extends ContestCardText {
  readonly url?: string | null;
  readonly section?: string | null;
  readonly source: ContestSource;
  /**
   * 説明の外で分かっている締切（RSS の専用欄 `kobo:deadline` から作った
   * 「2027-01-08 23:59」）。あれば説明の「〆切：」より先に採り、説明に
   * 「〆切：」が無くても公募として読む。**日付は `readDeadlines` で読める形で渡す**
   * ——置き場は締切の日付をこの原文から読み直すので、読めない形だと保存で消える
   */
  readonly deadlineText?: string | null;
}

/** 名前・欄の長さの上限（長い文を流し込ませない。画面に出すのは要所だけ） */
const MAX_NAME = 200;
const MAX_FIELD = 500;
/** 説明の書き出しの上限（AIへ渡す量を抑える。募集の狙いは書き出しに出る） */
const MAX_SUMMARY = 300;
const MAX_TEXT = 8000;
/** 1回に受ける件数の上限 */
export const MAX_CONTEST_ITEMS = 500;
/** クリップボードの文の上限（一覧のページ全体でも20万字には届かない） */
const MAX_CLIPBOARD = 2_000_000;

/**
 * 欄の名前。**直前が行頭か空白のときだけ**欄と読む（「読者賞：」の「賞：」を拾わない）。
 * 名前のうしろは「：」「:」、または行末・全角空白（「締切」の次の行に上期・下期が並ぶ形、
 * 「字数　小説部門：…」の形）。
 */
const LABEL =
  /(^|[\s　])(締切|〆切|賞典|賞金|賞品|賞|字数|作品文字数|主催|選考|審査員|選者|募集作品|募集内容|募集部門|募集ジャンル|応募資格|応募料|応募形式|応募方法|参加特典|注意事項|掲載・発表|応募期間)(?:[ \t　]*[：:]|[ \t]*(?=\n)|　)/gu;

type FieldName =
  | "deadline"
  | "prize"
  | "chars"
  | "organizer"
  | "judges"
  | "genre"
  | "eligibility"
  | "fee"
  | "other";

const FIELD_OF: Record<string, FieldName> = {
  締切: "deadline",
  〆切: "deadline",
  賞典: "prize",
  賞金: "prize",
  賞品: "prize",
  賞: "prize",
  字数: "chars",
  作品文字数: "chars",
  主催: "organizer",
  選考: "judges",
  審査員: "judges",
  選者: "judges",
  募集作品: "genre",
  募集内容: "genre",
  募集部門: "genre",
  募集ジャンル: "genre",
  応募資格: "eligibility",
  応募料: "fee",
};

/**
 * 1件の文を読む。**締切の欄が無ければ公募と読まない**（null）——
 * 一覧の中の「開催予定」の表や、ランキングの行を公募に数えないため。
 */
export function parseContestCard(input: ContestCardInput): ContestListing | null {
  const name = clean(input.name, MAX_NAME);
  if (!name) return null;
  // 原文のまま持つ（全角の「＋」「／」を半角へ変えない）。数の読み取りは
  // `readDeadlines`・`readCharLimit` の中で揃える
  const text = cutTrailer(input.text.slice(0, MAX_TEXT));
  const fields = readFields(text);
  const knownDeadline = clean(input.deadlineText ?? "", MAX_FIELD) || null;
  if (!knownDeadline && !fields.has("deadline")) return null;

  const deadlineText = knownDeadline ?? fields.get("deadline") ?? null;
  const labeledChars = fields.get("chars") ?? null;
  const charText = labeledChars ?? charCandidates(text, name);
  return {
    name,
    url: safeUrl(input.url),
    section: clean(input.section ?? "", MAX_NAME) || null,
    source: input.source,
    deadlineText,
    deadlines: readDeadlines(deadlineText),
    prize: fields.get("prize") ?? null,
    charText,
    organizer: fields.get("organizer") ?? null,
    judges: fields.get("judges") ?? null,
    genre: fields.get("genre") ?? null,
    eligibility: fields.get("eligibility") ?? null,
    fee: fields.get("fee") ?? null,
    charLimit: readCharLimit(charText),
    summary: leadText(text, name),
  };
}

/**
 * 欄の前に書かれた説明の書き出し。名前の行と「〆切：日付」の行（ツクリテミライの
 * 1件の頭）は外す。**欄の名前の読み分けは `LABEL` と同じもの**を使う。
 */
function leadText(text: string, name: string): string | null {
  const body = text
    .split("\n")
    .filter((line) => clean(line, MAX_NAME) !== name && !/^\s*[〆締]切[：:]\s*\d/u.test(line))
    .join("\n");
  LABEL.lastIndex = 0;
  const first = LABEL.exec(body);
  LABEL.lastIndex = 0;
  const lead = clean(first ? body.slice(0, first.index) : body, MAX_SUMMARY);
  return lead || null;
}

/** 欄を読む（同じ欄が2度出たら、最初のものを採る） */
function readFields(text: string): Map<FieldName, string> {
  const marks: { field: FieldName; valueStart: number; labelStart: number }[] = [];
  let match: RegExpExecArray | null;
  LABEL.lastIndex = 0;
  while ((match = LABEL.exec(text)) !== null) {
    const labelStart = match.index + match[1].length;
    marks.push({
      field: FIELD_OF[match[2]] ?? "other",
      labelStart,
      valueStart: match.index + match[0].length,
    });
    // 欄の名前の直後から、次の欄を探す（空白を共有しても拾えるように）
    LABEL.lastIndex = match.index + match[0].length;
  }
  const fields = new Map<FieldName, string>();
  marks.forEach((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].labelStart : text.length;
    let raw = text.slice(mark.valueStart, end);
    // 1行目に日付が読めた締切（ツクリテミライの「〆切：2026/10/31」）は、その行だけ。
    // 次の行は公募の名前と説明である
    if (mark.field === "deadline") {
      const firstLine = raw.split("\n")[0];
      if (readDeadlines(firstLine).length > 0) raw = firstLine;
    }
    // 空行から先は別の段落（ツクリテミライの説明・タグ）
    raw = raw.split(/\n[ \t　]*\n/u)[0];
    const value = clean(raw.replace(/^[：:\s]+/u, ""), MAX_FIELD);
    if (value && mark.field !== "other" && !fields.has(mark.field)) {
      fields.set(mark.field, value);
    }
    // 締切だけは、値が空（「締切」の次の行が空）でも「締切の欄がある」ことを残す
    if (mark.field === "deadline" && !fields.has("deadline")) fields.set("deadline", value);
  });
  return fields;
}

/**
 * 1件の文の末尾の、公募でない部分を落とす：
 * 「◇ 気になる！ 12」（ノベルポータル）、「#タグ」の行・分類の行（ツクリテミライ）。
 */
function cutTrailer(text: string): string {
  const lines = text.split(/\r?\n/u);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "◇" || trimmed.startsWith("気になる！")) break;
    if (trimmed.startsWith("#")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * 「字数」の欄が無い説明文（ツクリテミライ）から、字数の書かれた句を拾う。
 * 句は空白・句点で切る。**数と「字・文字・枚・ページ」の両方がある句だけ**を拾い、
 * 読み替えは `readCharLimit` に任せる（あらすじの字数などを外すのもそちら）。
 */
function charCandidates(text: string, name: string): string | null {
  const body = text
    .split("\n")
    .filter((line) => line.trim() !== name && !/^\s*[〆締]切[：:]\s*\d/u.test(line))
    .join("\n");
  const chunks = body
    .split(/[。\s]+/u)
    .filter(
      (chunk) =>
        (/\d/u.test(chunk) && /字|文字|枚|ページ|頁/u.test(chunk)) ||
        // 「文字数の規定なし」「字数不問」も字数の書き方である（制限が無い）
        /(?:文字数|字数|分量)[^。\s]{0,8}(?:なし|無し|不問|問わ|自由|ありません)/u.test(chunk)
    );
  if (chunks.length === 0) return null;
  return clean(chunks.join(" ／ "), MAX_FIELD);
}

/** 空白をまとめ、長すぎれば切る */
function clean(value: string, max: number): string {
  const text = value.replace(/[\s　]+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** http・https のリンクだけを持つ（それ以外は開かせない） */
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^https?:\/\/[^\s]+$/u.test(trimmed) || trimmed.length > 2000) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// D：ページの文をそのまま貼り付けたとき
// ---------------------------------------------------------------------------

/** ノベルポータルの締切の行（欄の名前が行頭に来る） */
const PORTAL_DEADLINE_LINE = /^[ \t　]*締切(?:[ \t　]*[：:]|[ \t　]*$)/u;
/** ツクリテミライの〆切の行（日付だけの行が、名前の前に来る） */
const TSUKURI_HEADER_LINE = /^[ \t　]*〆切[：:]\s*\d{4}\/\d{1,2}\/\d{1,2}\s*$/u;
/** ツクリテミライの、公募でない行（分類・終了の印・ページ送り） */
const TSUKURI_NOISE_LINE = /^(?:漫画|小説|イラスト|終了|前へ|次へ|\d{1,3})$/u;

/**
 * 貼り付けた文を1件ずつに分ける。どのサイトの一覧かは、締切の行の形で見分ける。
 * 公募の一覧でない文からは何も返さない。
 */
export function splitContestPageText(text: string): ContestCardText[] {
  const lines = text.split(/\r?\n/u);
  // 形の見分けは全角・半角を揃えて行い、返す文は原文のまま
  const normalized = lines.map((line) => line.normalize("NFKC"));
  if (normalized.some((line) => TSUKURI_HEADER_LINE.test(line))) {
    return splitTsukuri(lines, normalized);
  }
  return splitPortal(lines, normalized);
}

/**
 * ノベルポータル：締切の行の**直前の行が公募の名前**。1件は名前の行から、
 * 次の名前の行の手前まで（「◇ 気になる！」から先は `cutTrailer` が落とす）。
 */
function splitPortal(
  lines: readonly string[],
  normalized: readonly string[]
): ContestCardText[] {
  const nameRows: number[] = [];
  normalized.forEach((line, index) => {
    if (!PORTAL_DEADLINE_LINE.test(line)) return;
    let row = index - 1;
    while (row >= 0 && lines[row].trim() === "") row--;
    if (row >= 0 && !nameRows.includes(row)) nameRows.push(row);
  });
  return nameRows.map((row, index) => {
    const end = index + 1 < nameRows.length ? nameRows[index + 1] : lines.length;
    return {
      name: lines[row].trim(),
      text: lines.slice(row, end).join("\n"),
    };
  });
}

/**
 * ツクリテミライ：「〆切：YYYY/M/D」の行の**次の行が公募の名前**（「終了」の印は飛ばす）。
 * 1件は〆切の行から、次の〆切の行の手前まで。分類・ページ送りの行は落とす。
 */
function splitTsukuri(
  lines: readonly string[],
  normalized: readonly string[]
): ContestCardText[] {
  const headers: number[] = [];
  normalized.forEach((line, index) => {
    if (TSUKURI_HEADER_LINE.test(line)) headers.push(index);
  });
  const cards: ContestCardText[] = [];
  headers.forEach((header, index) => {
    const end = index + 1 < headers.length ? headers[index + 1] : lines.length;
    const body = lines
      .slice(header, end)
      .filter(
        (_line, offset) =>
          offset === 0 || !TSUKURI_NOISE_LINE.test(normalized[header + offset].trim())
      );
    const nameLine = body.slice(1).find((line) => line.trim() !== "");
    if (!nameLine) return;
    cards.push({ name: nameLine.trim(), text: body.join("\n") });
  });
  return cards;
}

// ---------------------------------------------------------------------------
// クリップボードの受け口（A・Dの両方）
// ---------------------------------------------------------------------------

export type ContestsClipboardResult =
  | {
      readonly ok: true;
      /** ヘルパーの封筒か、貼り付けた文か */
      readonly from: "helper" | "text";
      readonly listings: readonly ContestListing[];
      /** 1件ずつに分けたうち、公募として読めなかった数（締切の欄が無い・名前が無い） */
      readonly skipped: number;
      /** ヘルパーが読んだページ（出どころ）。貼り付けた文には無い */
      readonly pageUrl: string | null;
      /** ヘルパーが読んだ日時。貼り付けた文には無い */
      readonly readAt: string | null;
    }
  | { readonly ok: false; readonly kind: "notFound" }
  | { readonly ok: false; readonly kind: "invalid"; readonly reason: string };

/**
 * クリップボードの文を読む。ヘルパーの封筒ならそれを、そうでなければ
 * 貼り付けた一覧の文として読む。**どちらでもなければ notFound**
 * （作者の私物のクリップボードを、公募の一覧と読み違えない）。
 */
export function parseContestsClipboard(text: string): ContestsClipboardResult {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_CLIPBOARD) return { ok: false, kind: "notFound" };

  const envelope = parseJsonObject(trimmed);
  if (envelope) {
    if (!(MARKER in envelope)) return { ok: false, kind: "notFound" };
    return parseEnvelope(envelope);
  }

  const cards = splitContestPageText(trimmed);
  if (cards.length === 0) return { ok: false, kind: "notFound" };
  const listings = cards
    .slice(0, MAX_CONTEST_ITEMS)
    .map((card) => parseContestCard({ ...card, source: "pasted" }))
    .filter((listing): listing is ContestListing => listing !== null);
  if (listings.length === 0) return { ok: false, kind: "notFound" };
  return {
    ok: true,
    from: "text",
    listings,
    skipped: cards.length - listings.length,
    pageUrl: null,
    readAt: null,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ヘルパーの封筒を読む。**直して受け取らない**——版が違う・出どころが知らない
 * ものは、理由を言って止める（形が変われば、黙って別の欄を読むことになる）。
 */
function parseEnvelope(envelope: Record<string, unknown>): ContestsClipboardResult {
  const version = envelope[MARKER];
  if (version !== CONTESTS_ENVELOPE_VERSION) {
    return {
      ok: false,
      kind: "invalid",
      reason:
        `公募の一覧の形式の版（${String(version)}）が、この拡張機能の読める版（${CONTESTS_ENVELOPE_VERSION}）と違います。` +
        "統合小説執筆環境ヘルパーと統合小説執筆環境の両方を新しくしてから、もう一度お試しください。",
    };
  }
  const source = envelope.source;
  if (typeof source !== "string" || !HELPER_SOURCES.includes(source as ContestSource)) {
    return { ok: false, kind: "invalid", reason: "公募の一覧の出どころが読めませんでした。" };
  }
  const items = envelope.items;
  if (!Array.isArray(items)) {
    return { ok: false, kind: "invalid", reason: "公募の一覧の形が正しくありません。" };
  }
  if (items.length > MAX_CONTEST_ITEMS) {
    return {
      ok: false,
      kind: "invalid",
      reason: `公募が${items.length}件あり、一度に受けられる数（${MAX_CONTEST_ITEMS}件）を超えています。`,
    };
  }
  const listings: ContestListing[] = [];
  let skipped = 0;
  for (const item of items) {
    const listing = parseEnvelopeItem(item, source as ContestSource);
    if (listing) listings.push(listing);
    else skipped++;
  }
  return {
    ok: true,
    from: "helper",
    listings,
    skipped,
    pageUrl: safeUrl(envelope.pageUrl),
    readAt: typeof envelope.readAt === "string" && !Number.isNaN(Date.parse(envelope.readAt))
      ? envelope.readAt
      : null,
  };
}

function parseEnvelopeItem(item: unknown, source: ContestSource): ContestListing | null {
  if (typeof item !== "object" || item === null) return null;
  const value = item as Record<string, unknown>;
  if (typeof value.name !== "string" || typeof value.text !== "string") return null;
  return parseContestCard({
    name: value.name,
    text: value.text,
    url: typeof value.url === "string" ? value.url : null,
    section: typeof value.section === "string" ? value.section : null,
    source,
  });
}
