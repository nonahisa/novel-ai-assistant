import type { OutlineEpisode } from "./chapterOutline";
import { parseEpisodeTitle } from "./collectedFile";

/**
 * ヘルパー（Chrome 拡張「統合小説執筆環境ヘルパー」0.13.0）から届く章立て
 * （`novelai-chapters` v1。残課題 B7。設計書6.66.6）。
 *
 * ## なぜヘルパーから受けるのか
 *
 * **カクヨムのバックアップには章が入っていない**（話ファイル40件の欄は題・公開状態・
 * 日時・文字数・本文だけで、`about.txt` にも無い。2026-09-23 に確かめた）。章は
 * 作品管理の画面の「大見出し」にだけある。そこでヘルパーが、作者が押したときに
 * その画面の話の並びと大見出しを読み、クリップボードへ置いて
 * `vscode://nonahisa.novel-ai-assistant/import-chapters` を開く。
 *
 * **データはリンクに載らない**（読者の反応・公募と同じ約束。`readerStatsHelperLink.ts`）。
 *
 * ## 形
 *
 * ```json
 * {
 *   "novelai-chapters": 1,
 *   "site": "kakuyomu",
 *   "workId": "1177354054…",
 *   "pageUrl": "https://kakuyomu.jp/my/works/1177354054…",
 *   "readAt": "2026-09-24T09:00:00.000+09:00",
 *   "episodes": [{ "heading": "１話　転生", "part": "第一章『死の谷』" }]
 * }
 * ```
 *
 * `part` は**その話が属する章の題**（章の外なら null）。ヘルパーは画面の並びを
 * そのまま写すだけで、話数の読み分けはここでする——2か所で読むと、片方を直した日に
 * 食い違う（公募の封筒と同じ分け方）。
 *
 * **直して受け取らない。** 版が違う・知らないサイト・形が崩れている封筒は、
 * 理由を言って止める。
 *
 * VS Code API には依存しない。
 */

export const CHAPTERS_MARKER = "novelai-chapters";
export const CHAPTERS_ENVELOPE_VERSION = 1;

/** 章立てを受けるサイト。いまはカクヨムだけ（なろう・アルファポリスはバックアップに章がある） */
const CHAPTER_SITES = ["kakuyomu"] as const;
export type ChapterEnvelopeSite = (typeof CHAPTER_SITES)[number];

/** 1回に受ける話の数の上限（長い連載でも足りる数。これを超えるものは形を疑う） */
const MAX_EPISODES = 5000;
/** クリップボードの長さの上限（話の見出しだけなので、これより長いものは封筒ではない） */
const MAX_CLIPBOARD = 2_000_000;
/** 見出し1つの長さの上限 */
const MAX_TEXT = 200;

export type ChaptersClipboardResult =
  | {
      readonly ok: true;
      readonly site: ChapterEnvelopeSite;
      /** 作品ID。読めなければ null（作品は作者に選んでもらう） */
      readonly workId: string | null;
      readonly pageUrl: string | null;
      readonly readAt: string | null;
      readonly outline: readonly OutlineEpisode[];
    }
  /** 章立ての封筒ではない（中身には触れない。クリップボードは作者の私物） */
  | { readonly ok: false; readonly kind: "notFound" }
  /** 章立ての封筒だが、読めない形 */
  | { readonly ok: false; readonly kind: "invalid"; readonly reason: string };

export function parseChaptersClipboard(text: string): ChaptersClipboardResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || trimmed.length > MAX_CLIPBOARD) {
    return { ok: false, kind: "notFound" };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, kind: "notFound" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, kind: "notFound" };
  }
  const envelope = value as Record<string, unknown>;
  if (!(CHAPTERS_MARKER in envelope)) return { ok: false, kind: "notFound" };

  const version = envelope[CHAPTERS_MARKER];
  if (version !== CHAPTERS_ENVELOPE_VERSION) {
    return invalid(
      `章立ての形式の版（${String(version)}）が、この拡張機能の読める版（${CHAPTERS_ENVELOPE_VERSION}）と違います。` +
        "統合小説執筆環境ヘルパーと統合小説執筆環境の両方を新しくしてから、もう一度お試しください。"
    );
  }
  const site = envelope.site;
  if (typeof site !== "string" || !CHAPTER_SITES.includes(site as ChapterEnvelopeSite)) {
    return invalid("章立ての出どころ（投稿サイト）が読めませんでした。");
  }
  const episodes = envelope.episodes;
  if (!Array.isArray(episodes)) {
    return invalid("章立ての形が正しくありません。");
  }
  if (episodes.length === 0) {
    return invalid("章立てに話が1つも入っていませんでした。作品管理の画面が開き切ってから、もう一度お試しください。");
  }
  if (episodes.length > MAX_EPISODES) {
    return invalid(`話が${episodes.length}個あり、一度に受けられる数（${MAX_EPISODES}）を超えています。`);
  }

  const outline: OutlineEpisode[] = [];
  for (const [index, entry] of episodes.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return invalid(`章立ての${index + 1}番目の話の形が正しくありません。`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.heading !== "string") {
      return invalid(`章立ての${index + 1}番目の話に見出しがありません。`);
    }
    if (record.part !== null && record.part !== undefined && typeof record.part !== "string") {
      return invalid(`章立ての${index + 1}番目の話の章の題の形が正しくありません。`);
    }
    const heading = clean(record.heading);
    const part = typeof record.part === "string" ? clean(record.part) : "";
    const parsed = parseEpisodeTitle(heading);
    outline.push({
      label: heading || `${index + 1}番目の話`,
      number: parsed.chapter,
      title: parsed.title,
      part: part === "" ? null : part,
    });
  }

  return {
    ok: true,
    site: site as ChapterEnvelopeSite,
    workId: optionalId(envelope.workId),
    pageUrl: optionalText(envelope.pageUrl),
    readAt: optionalText(envelope.readAt),
    outline,
  };
}

function invalid(reason: string): ChaptersClipboardResult {
  return { ok: false, kind: "invalid", reason };
}

/**
 * **誰が作ったか分からない文字列**なので、制御文字を落として短く切る。
 * 制御文字は `\u0000`〜`\u001f` と `\u007f`（生のまま書かない。sourceHygiene）
 */
function clean(value: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = clean(value);
  return text === "" ? null : text;
}

/** 作品IDは英数字だけ（カクヨムは数字、なろうのNコードは英数字）。それ以外は持たない */
function optionalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[0-9A-Za-z]{1,64}$/u.test(id) ? id : null;
}
