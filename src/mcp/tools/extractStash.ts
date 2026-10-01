import * as fs from "node:fs";
import * as nodePath from "node:path";
import { AIWRITER_DIR } from "../../models/types";
import {
  CHARACTER_EXTRACT_VERSION,
  type CharacterExtractResult,
} from "../../prompts/characterExtract";
import type { Chunk } from "../../core/chunker";
import { McpToolError, describeError } from "./shared";

/**
 * 外部AIが抽出した答えの貯め場所（2026-10-02、作者の裁定）。
 *
 * `novel.validate`（settings、`stash: true`）と `novel.run`（settings、
 * sampling）が、検算に通した答え（`parseResult` を通したもの）を
 * チャンクごとに貯め、`novel.extract.commit` がまとめて資料へ保存する。
 *
 * ## チャンクキャッシュ（`chunks.json`）に混ぜないわけ
 *
 * あちらの鍵は「内容ハッシュ＋プロバイダ＋モデル名＋プロンプト版」で、
 * 外部AI（claude・sampling）はモデル名がこちらに分からない。分からない
 * 名前で貯めると、拡張機能の抽出が別のモデルの答えを自分のものとして
 * 使い回すことになる（規則4）。ここは保存のための一時の置き場で、
 * 保存が済めば消す。
 *
 * ## 何を持つか
 *
 * - **答え（マージの前）**：保存のときに製品と同じ順で検算し直すため。
 *   検算の結果を貯めると、チャンクの順で育つ既知名が保存のときと食い違う
 * - **本文のハッシュ**：本文が変わったら、その答えは捨てる（別の本文の話になる）
 * - **プロンプト版**：版が変われば答えの形も変わりうるので、違う版のものは捨てる
 */

/** 置き場。キャッシュと同じ `cache/` の下（同期されない） */
export function extractStashFileOf(folder: string): string {
  return nodePath.join(
    nodePath.resolve(folder),
    AIWRITER_DIR,
    "cache",
    "external-extract.json"
  );
}

const STASH_SCHEMA_VERSION = 1;

export interface StashEntry {
  /** `novel.prompt`・`novel.run` が返した chunkId */
  chunkId: string;
  /** そのときの本文のハッシュ（`Chunk.hash`） */
  chunkHash: string;
  /** 答えたときのプロンプト版（`CHARACTER_EXTRACT_VERSION`） */
  promptVersion: string;
  /** `parseResult` を通した答え（検算の前） */
  parsed: CharacterExtractResult;
  savedAt: string;
}

interface StashFile {
  schemaVersion: number;
  entries: StashEntry[];
}

/**
 * 貯めたものを読む。無ければ空。
 *
 * **読めないときは止める。** 黙って空として扱うと、次に貯めた1件で
 * それまでの分を上書きして消すことになる（外部AIが読んだぶんの手間が消える）。
 */
export function readExtractStash(folder: string): StashEntry[] {
  const file = extractStashFileOf(folder);
  if (!fs.existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new McpToolError(
      `抽出の貯め場所を読めませんでした（${relativeTo(folder, file)}: ${describeError(error)}）。` +
        "中身を確かめるか、要らなければ消してから、もう一度抽出してください。"
    );
  }
  return entriesOf(raw, folder, file);
}

function entriesOf(raw: unknown, folder: string, file: string): StashEntry[] {
  const broken = (): never => {
    throw new McpToolError(
      `抽出の貯め場所の形が違います（${relativeTo(folder, file)}）。` +
        "中身を確かめるか、要らなければ消してから、もう一度抽出してください。"
    );
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) broken();
  const value = raw as Partial<StashFile>;
  if (!Array.isArray(value.entries)) broken();
  const entries: StashEntry[] = [];
  for (const item of value.entries as unknown[]) {
    if (typeof item !== "object" || item === null) broken();
    const entry = item as Partial<StashEntry>;
    if (
      typeof entry.chunkId !== "string" ||
      typeof entry.chunkHash !== "string" ||
      typeof entry.promptVersion !== "string" ||
      typeof entry.parsed !== "object" ||
      entry.parsed === null
    ) {
      broken();
    }
    entries.push(entry as StashEntry);
  }
  return entries;
}

/**
 * 1チャンクぶんの答えを貯める。**同じ chunkId は差し替える**（後から
 * 読み直したほうを使う）。
 *
 * 書き方はチャンクキャッシュ（`chunkCacheFile.ts`）と同じ——一時ファイルへ
 * 書いてから置き換える。書きかけを読ませると「壊れた貯め場所」に見えて
 * 保存が止まる。
 */
export function stashExtractAnswer(
  folder: string,
  chunkId: string,
  chunk: Chunk,
  parsed: CharacterExtractResult
): void {
  const entries = readExtractStash(folder).filter(
    (entry) => entry.chunkId !== chunkId
  );
  entries.push({
    chunkId,
    chunkHash: chunk.hash,
    promptVersion: CHARACTER_EXTRACT_VERSION,
    parsed,
    savedAt: new Date().toISOString(),
  });
  writeStash(folder, entries);
}

function writeStash(folder: string, entries: StashEntry[]): void {
  const file = extractStashFileOf(folder);
  const body: StashFile = { schemaVersion: STASH_SCHEMA_VERSION, entries };
  try {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    // プロセス番号を入れるのは、MCPサーバーが2つ動いていても一時ファイルが
    // ぶつからないようにするため（`chunkCacheFile.ts` と同じ）
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    throw new McpToolError(
      `抽出の答えを貯められませんでした: ${describeError(error)}`
    );
  }
}

/** 保存が済んだら消す。無ければ何もしない */
export function clearExtractStash(folder: string): void {
  const file = extractStashFileOf(folder);
  if (fs.existsSync(file)) fs.rmSync(file);
}

function relativeTo(folder: string, target: string): string {
  return nodePath
    .relative(nodePath.resolve(folder), target)
    .split(nodePath.sep)
    .join("/");
}
