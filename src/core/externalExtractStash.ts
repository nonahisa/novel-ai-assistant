import type { Chunk } from "./chunker";
import { chunksOfSources, episodeBodySources } from "./episodeChunks";
import { parseEpisodeFileName } from "./episodeParser";
import type { CharacterExtractResult } from "../prompts/characterExtract";

/**
 * 外部AIの抽出の貯め場所（`.aiwriter/cache/external-extract.json`）の形と、
 * そこへ貯める答えのチャンクの切り方（2026-10-16 に `mcp/tools/` から移した）。
 *
 * ## なぜ core に置くか
 *
 * 貯めるのは2か所になった。
 *
 * - MCP の `novel.validate`（`stash: true`）・`novel.run`（sampling）——Node の `fs` で書く
 * - 拡張機能の `run.request`（feature: settings）——作者のAI設定で抽出して、`vscode.workspace.fs` で書く
 *
 * 読むのは MCP の `novel.extract.commit` だけで、**`chunkId` から本文を切り直し、
 * ハッシュが合わない答えを「本文が変わった」として捨てる**。拡張機能の側が
 * 製品の［設定資料を抽出］と同じ切り方（隣の話をまとめて送る）で切ると、
 * 名前もハッシュも合わず、**貯めた答えが全部黙って捨てられる**。
 * そこで切り方と名前の付け方・貯め場所の形を1か所に置き、両方がここを使う
 * （`test/unit/cross/runRequestSettingsStash.test.ts` が見張る）。
 *
 * VS Code にも Node にも依存しない（MCP の束から使うため）。
 */

/** 貯め場所の形の版。上げたら MCP 側の読み方も揃える */
export const EXTRACT_STASH_SCHEMA_VERSION = 1;

/** 作品の `.aiwriter/` の下の置き場（`cache/` の下＝同期されない・作り直せる控え） */
export const EXTRACT_STASH_SUBPATH = ["cache", "external-extract.json"] as const;

export interface ExtractStashEntry {
  /** `novel.prompt`・`novel.run` が返した chunkId（`externalChunkIdOf` の形） */
  chunkId: string;
  /** そのときの本文のハッシュ（`Chunk.hash`） */
  chunkHash: string;
  /** 答えたときのプロンプト版（`CHARACTER_EXTRACT_VERSION`） */
  promptVersion: string;
  /** `parseResult` を通した答え（検算の前） */
  parsed: CharacterExtractResult;
  savedAt: string;
}

interface ExtractStashFile {
  schemaVersion: number;
  entries: ExtractStashEntry[];
}

/**
 * 読んだ JSON から答えの列を取り出す。**形が合わなければ undefined**
 * （＝壊れている。呼ぶ側は止める——黙って空として扱うと、次に貯めた1件で
 * それまでの分を上書きして消す）。
 */
export function parseExtractStashEntries(raw: unknown): ExtractStashEntry[] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Partial<ExtractStashFile>;
  if (!Array.isArray(value.entries)) return undefined;
  const entries: ExtractStashEntry[] = [];
  for (const item of value.entries as unknown[]) {
    if (typeof item !== "object" || item === null) return undefined;
    const entry = item as Partial<ExtractStashEntry>;
    if (
      typeof entry.chunkId !== "string" ||
      typeof entry.chunkHash !== "string" ||
      typeof entry.promptVersion !== "string" ||
      typeof entry.parsed !== "object" ||
      entry.parsed === null
    ) {
      return undefined;
    }
    entries.push(entry as ExtractStashEntry);
  }
  return entries;
}

/** 書く形（MCP の `writeStash` と同じ。末尾に改行） */
export function formatExtractStash(entries: readonly ExtractStashEntry[]): string {
  const body: ExtractStashFile = {
    schemaVersion: EXTRACT_STASH_SCHEMA_VERSION,
    entries: [...entries],
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * 貯めた列へ足す。**同じ chunkId は差し替える**（後から読み直したほうを使う）。
 * 並びは「残したもの → 足したもの」——保存の道は話の順に並べ直すので、
 * ここの並びは意味を持たない。
 */
export function withStashEntries(
  existing: readonly ExtractStashEntry[],
  added: readonly ExtractStashEntry[]
): ExtractStashEntry[] {
  const replaced = new Set(added.map((entry) => entry.chunkId));
  return [...existing.filter((entry) => !replaced.has(entry.chunkId)), ...added];
}

/**
 * チャンクの呼び名。
 *
 * **切り方が変われば名前も変わる**ように、切った大きさまで入れてある。
 * **話数も入れる**（0.64.3）。`chunk.index` は話ごとに0から振り直されるので、
 * 合本で各話が1つのチャンクに収まると、話数が無いと3話とも同じ名前になる。
 * 話数が読めないファイルは `x`。
 */
export function externalChunkIdOf(relative: string, chunk: Chunk, maxChars: number): string {
  return `${relative}#${chunk.chapterStart ?? "x"}-${chunk.index}@${maxChars}`;
}

/**
 * 1ファイルの本文を、外から頼む道の切り方で切る。
 *
 * **まとめ送信（`mergeChars`）はしない。** 製品は送信回数を減らすために隣どうしを
 * まとめるが、外から頼む道では**チャンクの名前が呼び出しをまたいで変わらない**
 * ほうが大事である（貯めた答えを保存のときに切り直して照合するため）。
 * 合本は話ごとに分ける（`episodeBodySources`）。
 *
 * @param relative 作品フォルダーからの相対パス（名前に入る）
 * @param text 解釈済みの本文（`decodeBytes` の `text`）
 */
export function externalChunksOfText(
  relative: string,
  text: string,
  maxChars: number
): Array<{ chunkId: string; chunk: Chunk }> {
  const fileName = relative.split(/[\\/]/u).pop() ?? relative;
  const parsed = parseEpisodeFileName(fileName);
  const sources = episodeBodySources(relative, text, {
    chapterStart: parsed.chapterStart,
    chapterEnd: parsed.chapterEnd,
  });
  return chunksOfSources(sources, { maxChars }).map((chunk) => ({
    chunkId: externalChunkIdOf(relative, chunk, maxChars),
    chunk,
  }));
}
