import * as fs from "node:fs";
import * as nodePath from "node:path";
import { AIWRITER_DIR } from "../../models/types";
import type { ChapterEmotion } from "../../models/synopsis";
import { splitEpisodeBodyParts, type EpisodeBodyPart } from "../../core/episodeBodyParts";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { parseEpisodeMetadata } from "../../core/metadataParser";
import { McpToolError, describeError, readBody } from "./shared";

/**
 * 外部AIが作った各話あらすじと作品紹介文の貯め場所（2026-10-02、作者の裁定
 * 「何もない状態からであれば承認は不要」）。
 *
 * `novel.validate`（feature: synopsis／blurb、`stash: true`）が、製品の検算
 * （`validateSynopsisResult`・`parseBlurbResponse`）を通した答えをここへ貯め、
 * `novel.synopsis.commit` が資料へ保存する。考え方は設定資料の抽出の貯め場所
 * （`extractStash.ts`）と同じ。
 *
 * ## 何を持つか
 *
 * - **検算を通したあとの答え**：あらすじは検算が1話で閉じている（抽出のように
 *   話の順で既知名が育つことがない）ので、保存のときに検算し直す必要がない
 * - **本文のハッシュ**：製品と同じ材料（シーンメモを消した本文）から取る。
 *   本文が変わったら、その答えは捨てる（別の本文の話になる）
 * - **プロンプトの版**：製品が控える版（`synopsisPromptVersion`）。保存のときに
 *   版の本体（`|` より前）が違えば捨てる
 *
 * サブタイトルの案は貯めない。製品でもファイル名を変える案として作者に
 * 見せるだけで、`chapter_synopses.json` には入らない。
 */

/** 置き場。キャッシュと同じ `cache/` の下（同期されない） */
export function synopsisStashFileOf(folder: string): string {
  return nodePath.join(
    nodePath.resolve(folder),
    AIWRITER_DIR,
    "cache",
    "external-synopsis.json"
  );
}

const STASH_SCHEMA_VERSION = 1;

export interface EpisodeSynopsisStashEntry {
  /** 作品フォルダーからの相対パス（`novel.scan` が返すもの） */
  filePath: string;
  /** 話数。合本の中の話を指すのに使う。読めなければ null */
  chapter: number | null;
  /** 本文のハッシュ（製品の `EpisodeBody.hash` と同じ材料） */
  sourceHash: string;
  /** 製品が控える版（`synopsisPromptVersion`） */
  promptVersion: string;
  /** 検算を通したあらすじ（150字に詰めたもの） */
  synopsis: string;
  emotion: ChapterEmotion | null;
  savedAt: string;
}

export interface BlurbStashEntry {
  /** 検算を通した紹介文 */
  blurb: string;
  /** 製品の版（`blurbPromptVersion`） */
  promptVersion: string;
  savedAt: string;
}

export interface SynopsisStash {
  episodes: EpisodeSynopsisStashEntry[];
  blurb: BlurbStashEntry | null;
}

interface StashFile extends SynopsisStash {
  schemaVersion: number;
}

/**
 * 貯めたものを読む。無ければ空。
 *
 * **読めないときは止める。** 黙って空として扱うと、次に貯めた1件で
 * それまでの分を上書きして消すことになる（`extractStash.ts` と同じ）。
 */
export function readSynopsisStash(folder: string): SynopsisStash {
  const file = synopsisStashFileOf(folder);
  if (!fs.existsSync(file)) return { episodes: [], blurb: null };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw brokenStash(folder, file, describeError(error));
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw brokenStash(folder, file);
  }
  const value = raw as Partial<StashFile>;
  if (!Array.isArray(value.episodes)) throw brokenStash(folder, file);
  const episodes: EpisodeSynopsisStashEntry[] = [];
  for (const item of value.episodes as unknown[]) {
    const entry = item as Partial<EpisodeSynopsisStashEntry> | null;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.filePath !== "string" ||
      !(entry.chapter === null || typeof entry.chapter === "number") ||
      typeof entry.sourceHash !== "string" ||
      typeof entry.promptVersion !== "string" ||
      typeof entry.synopsis !== "string"
    ) {
      throw brokenStash(folder, file);
    }
    episodes.push({ ...entry, emotion: entry.emotion ?? null } as EpisodeSynopsisStashEntry);
  }
  let blurb: BlurbStashEntry | null = null;
  if (value.blurb !== undefined && value.blurb !== null) {
    const entry = value.blurb as Partial<BlurbStashEntry>;
    if (typeof entry.blurb !== "string" || typeof entry.promptVersion !== "string") {
      throw brokenStash(folder, file);
    }
    blurb = entry as BlurbStashEntry;
  }
  return { episodes, blurb };
}

function brokenStash(folder: string, file: string, detail?: string): McpToolError {
  return new McpToolError(
    `あらすじの貯め場所を読めませんでした（${relativeTo(folder, file)}${
      detail ? `: ${detail}` : ""
    }）。中身を確かめるか、要らなければ消してから、もう一度検算してください。`
  );
}

/** 同じ話か。**製品の `synopsisKey` と同じく、話数があれば話数で決める** */
function sameEpisode(
  entry: EpisodeSynopsisStashEntry,
  filePath: string,
  chapter: number | null
): boolean {
  if (entry.chapter !== null || chapter !== null) return entry.chapter === chapter;
  return normalizeRelative(entry.filePath) === normalizeRelative(filePath);
}

/** 1話ぶんを貯める。**同じ話は差し替える**（後から作り直したほうを使う） */
export function stashEpisodeSynopsis(
  folder: string,
  entry: Omit<EpisodeSynopsisStashEntry, "savedAt">
): void {
  const current = readSynopsisStash(folder);
  const episodes = current.episodes.filter(
    (item) => !sameEpisode(item, entry.filePath, entry.chapter)
  );
  episodes.push({ ...entry, savedAt: new Date().toISOString() });
  writeSynopsisStash(folder, { ...current, episodes });
}

/** 紹介文を貯める。**1件だけ持つ**（後から作ったほうに差し替える） */
export function stashBlurb(
  folder: string,
  entry: Omit<BlurbStashEntry, "savedAt">
): void {
  const current = readSynopsisStash(folder);
  writeSynopsisStash(folder, {
    ...current,
    blurb: { ...entry, savedAt: new Date().toISOString() },
  });
}

/**
 * 書く。一時ファイルへ書いてから置き換える（`extractStash.ts` と同じ）。
 * **両方とも空になったらファイルごと消す。**
 */
export function writeSynopsisStash(folder: string, stash: SynopsisStash): void {
  const file = synopsisStashFileOf(folder);
  try {
    if (stash.episodes.length === 0 && stash.blurb === null) {
      if (fs.existsSync(file)) fs.rmSync(file);
      return;
    }
    const body: StashFile = { schemaVersion: STASH_SCHEMA_VERSION, ...stash };
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    // プロセス番号を入れるのは、MCPサーバーが2つ動いていても一時ファイルが
    // ぶつからないようにするため（`chunkCacheFile.ts` と同じ）
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    throw new McpToolError(`あらすじの答えを貯められませんでした: ${describeError(error)}`);
  }
}

/* ── 製品と同じ「話ごとの本文」 ─────────────────────────── */

export interface ResolvedEpisode extends EpisodeBodyPart {
  /** 作品フォルダーからの相対パス */
  filePath: string;
  /** ファイル名（`ChapterSynopsis.fileName`。合本なら合本ファイルの名前） */
  fileName: string;
  /** ファイル名が初期状態（数字だけ）か。サブタイトルを提案する話かの判定に使う */
  isInitialName: boolean;
}

/**
 * 指された話を、**製品の各話あらすじと同じ本文**で取り出す
 * （`loadEpisodeBodies` と同じ `splitEpisodeBodyParts` を通す）。
 *
 * 題は製品の走査と同じく「ファイル名の題 → 頭書きの題」。合本で `chapter` を
 * 省けば先頭の話（`novel.prompt` の synopsis と同じ選び方）。
 */
export function resolveEpisodeForSynopsis(
  folder: string,
  filePath: string,
  chapter?: number | null
): ResolvedEpisode {
  const text = readBody(folder, filePath);
  const fileName = nodePath.basename(filePath);
  const parsed = parseEpisodeFileName(fileName);
  const parts = splitEpisodeBodyParts(text, {
    chapter: parsed.chapterStart,
    title: parsed.subtitle ?? parseEpisodeMetadata(text).title,
  });
  if (parts.length === 0) {
    throw new McpToolError(`その本文から話を取り出せませんでした: ${filePath}`);
  }
  const picked =
    chapter === undefined || chapter === null
      ? parts[0]
      : parts.find((part) => part.chapter === chapter);
  if (!picked) {
    throw new McpToolError(
      `第${chapter}話が、そのファイルの中に見つかりませんでした（${filePath}）。`
    );
  }
  return {
    ...picked,
    filePath,
    fileName,
    isInitialName: parsed.isInitialName,
  };
}

/** 製品の `needsSubtitle`（`episodeBodies.ts`）と同じ判定 */
export function needsSubtitleOf(episode: ResolvedEpisode): boolean {
  if (episode.insideCollected) return false;
  if (!episode.isInitialName) return false;
  return !episode.title;
}

function normalizeRelative(relative: string): string {
  return relative.replace(/\\/g, "/");
}

function relativeTo(folder: string, target: string): string {
  return nodePath
    .relative(nodePath.resolve(folder), target)
    .split(nodePath.sep)
    .join("/");
}
