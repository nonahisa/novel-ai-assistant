import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import {
  DEFAULT_MANUSCRIPT_DIR,
  DEFAULT_SETTINGS_DIR,
  SUPPORTED_EXTENSIONS,
} from "../../models/types";
import { goesOutside } from "../../core/pathText";
import { decodeBytes } from "../../core/textDecode";
import { parseEpisodeFileName } from "../../core/episodeParser";
import {
  chunksOfSources,
  episodeBodySources,
  type EpisodeBodySource,
} from "../../core/episodeChunks";
import { decideChunkSize, type Chunk } from "../../core/chunker";

/**
 * ツールの土台（設計書6.87.8）。
 *
 * **ここには「読む」しか無い。** 外から呼ぶ口は読む・測る・提案するまでで、
 * 原稿も設定資料も書き換えない（6.87.7）。書き戻しは作者の操作を起点にする。
 *
 * **ファイルの読み方は Node の `fs`、解釈は製品の関数**（6.87.8 の7）。
 * `vscode.workspace.fs` を通らないだけで、文字コードの判定（`decodeBytes`）・
 * 話の分け方（`episodeBodySources`）・切り方（`chunksOfSources`）は
 * 拡張機能とまったく同じものを通す。写すと、直したはずの不具合が
 * MCP 側にだけ残る。
 */

/** 作者に見せる、その場で直せる失敗。転送層が `isError` にして返す */
export class McpToolError extends Error {}

/**
 * 設定資料の置き場所（`設定/` の下）。
 *
 * 名前は `characterStore.ts`・`abilityStore.ts`・`foreshadowStore.ts` が
 * 持っているが、**どれも `vscode` を import している**ので束へ持ち込めない。
 * ずれると「資料が1件も無い」と見えるだけで止まらないので、
 * `test/unit/mcpTools.test.ts` が作り物のフォルダーで読めることを見る。
 */
export const SETTINGS_SUBDIRS = {
  characters: "characters",
  locations: "locations",
  world: "world",
  foreshadows: "foreshadows",
} as const;

/** 各話あらすじ（`core/synopsisStore.ts` の `CHAPTER_SYNOPSES_FILE`） */
export const SYNOPSES_FILE = "chapter_synopses.json";
/** 作者が「直さない」と決めた語（`core/keepWordStore.ts` の `KEEP_WORDS_FILE`） */
export const KEEP_WORDS_FILE = "keep_words.json";
/** プロット（`core/workRegistry.ts` の `PLOT_FILE`） */
export const PLOT_FILE = "plot.md";

/** どのツールにも要る入力。**作品フォルダーの外は読まない** */
export const FOLDER_INPUT = {
  folder: z
    .string()
    .describe("作品フォルダーの場所。この配下のファイルだけを読みます"),
};

/**
 * 本文を切るときに要る入力。
 *
 * **チャンクの大きさは固定しない**（CLAUDE.md 規則6）。モデルの上限から
 * `decideChunkSize` で決めるので、使うモデルの上限（`num_ctx`）を必ずもらう。
 */
export const CHUNK_INPUT = {
  filePath: z
    .string()
    .describe("作品フォルダーからの相対パス（`work.scan` が返すもの）"),
  numCtx: z
    .number()
    .int()
    .positive()
    .describe("使うモデルのコンテキスト長。チャンクの大きさをここから決めます"),
  chunkIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("そのチャンクだけを対象にする。省略すると全チャンク"),
};

/**
 * 本文の行き先は、呼ぶ側が明示する（設計書6.87.6 の2）。
 *
 * **既定を作らない。** `ollama` なら原稿は機械の外へ出ないが、`claude` は
 * 本文が Anthropic へ渡る。省略を「安全なほう」で埋めると、作者が選んだ
 * ことにならない。
 */
export const RUNNER_INPUT = {
  runner: z
    .enum(["ollama", "claude"])
    .describe(
      "本文の行き先。ollama＝手元のOllamaで検算まで通す（原稿は外へ出ない）／" +
        "claude＝プロンプトだけ返す（本文がAnthropicへ渡る）。省略できません"
    ),
};

/** 手元の Ollama へ投げるときの宛先 */
export const OLLAMA_INPUT = {
  endpoint: z
    .string()
    .optional()
    .describe("Ollama の場所。既定は http://localhost:11434"),
  model: z.string().optional().describe("モデル名（runner が ollama のとき必須）"),
  allowRemote: z
    .boolean()
    .optional()
    .describe("手元以外の宛先へ本文を送ることを明示的に許す"),
};

/**
 * `folder` の配下だけを指しているか確かめて、絶対パスにする。
 *
 * `..` で外へ出る指定は断る。**判定は `core/pathText.ts` の `goesOutside`**
 * ——区切り文字の取り違えで「外を中と誤判定する」のを避けるため、
 * 製品と同じものを通す。
 */
export function resolveInsideFolder(folder: string, relative: string): string {
  const base = nodePath.resolve(folder);
  const candidate = nodePath.resolve(base, relative);
  if (goesOutside(base, nodePath.relative(base, candidate))) {
    throw new McpToolError(
      `作品フォルダーの外は読めません: ${relative}（${folder} の配下を指定してください）`
    );
  }
  return candidate;
}

/** 本文の置き場所。`本文/` が無ければ作品フォルダーの直下 */
export function bodyDirOf(folder: string): string {
  const base = nodePath.resolve(folder);
  if (!fs.existsSync(base)) {
    throw new McpToolError(`作品フォルダーが見つかりません: ${folder}`);
  }
  const manuscripts = nodePath.join(base, DEFAULT_MANUSCRIPT_DIR);
  return fs.existsSync(manuscripts) ? manuscripts : base;
}

/** 設定資料の置き場所（`設定/`）。無ければ undefined */
export function settingsDirOf(folder: string): string | undefined {
  const dir = nodePath.join(nodePath.resolve(folder), DEFAULT_SETTINGS_DIR);
  return fs.existsSync(dir) ? dir : undefined;
}

/** 本文フォルダーの `.txt`/`.md` を、名前順に並べて返す（作品フォルダーからの相対） */
export function listBodyFiles(folder: string): string[] {
  const base = nodePath.resolve(folder);
  const dir = bodyDirOf(folder);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      SUPPORTED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))
    )
    .sort((a, b) => a.localeCompare(b, "ja"))
    .map((name) => nodePath.relative(base, nodePath.join(dir, name)));
}

/**
 * 1ファイルを読む。**バイト列を取って、解釈は製品に任せる**（6.87.8 の7）。
 *
 * 競合マーカーのあるファイルは、製品と同じくAIへ掛けない。
 */
export function readBody(folder: string, relative: string): string {
  const absolute = resolveInsideFolder(folder, relative);
  let bytes: Uint8Array;
  try {
    bytes = fs.readFileSync(absolute);
  } catch (error) {
    throw new McpToolError(
      `本文を読めませんでした: ${relative}（${describeError(error)}）`
    );
  }
  const decoded = decodeBytes(bytes);
  if (decoded.hasConflictMarkers) {
    throw new McpToolError(
      `Gitの競合マーカーが残っています: ${relative}（先に解消してください）`
    );
  }
  return decoded.text;
}

/** JSONの設定資料を1つ読む。読めなければ undefined（黙って直さない） */
function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * `設定/<subdir>/*.json` を全部読む。
 *
 * `parse` は `models/` の検証（`parseCharacter` など）。**壊れているものは
 * 飛ばして数える**——製品と同じく、勝手に直して書き戻すことはしない
 * （ここはそもそも書かない）。
 */
export function readSettingsRecords<T>(
  folder: string,
  subdir: string,
  parse: (raw: unknown) => T
): { records: T[]; unreadable: number } {
  const settings = settingsDirOf(folder);
  if (!settings) return { records: [], unreadable: 0 };
  const dir = nodePath.join(settings, subdir);
  if (!fs.existsSync(dir)) return { records: [], unreadable: 0 };

  const records: T[] = [];
  let unreadable = 0;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const raw = readJson(nodePath.join(dir, name));
    if (raw === undefined) {
      unreadable += 1;
      continue;
    }
    try {
      records.push(parse(raw));
    } catch {
      unreadable += 1;
    }
  }
  return { records, unreadable };
}

/** `設定/` の直下のファイルを1つ読む（あらすじ・直さない語）。無ければ undefined */
export function readSettingsFile(
  folder: string,
  fileName: string
): unknown | undefined {
  const settings = settingsDirOf(folder);
  if (!settings) return undefined;
  const file = nodePath.join(settings, fileName);
  if (!fs.existsSync(file)) return undefined;
  return readJson(file);
}

/** `設定/plot.md` の中身。無ければ undefined */
export function readPlotMarkdown(folder: string): string | undefined {
  const settings = settingsDirOf(folder);
  if (!settings) return undefined;
  const file = nodePath.join(settings, PLOT_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    return decodeBytes(fs.readFileSync(file)).text;
  } catch {
    return undefined;
  }
}

/**
 * 1ファイルを、製品と同じ手順でチャンクへ切る。
 *
 * **合本は話ごとに分ける**（`episodeBodySources`）。丸ごと切ると、全チャンクの
 * 話数が先頭の話数になる。
 *
 * **まとめ送信（`mergeChars`）はしない。** 拡張機能は送信回数を減らすために
 * 隣どうしをまとめるが、外から呼ぶ口では**チャンクの番号が呼び出しをまたいで
 * 変わらない**ほうが大事である（`prompt` で受け取った番号を `validate` へ
 * 返すため）。まとめ方はファイルの並びや対象の選び方で変わる。
 */
export function chunksOfWorkFile(
  folder: string,
  relative: string,
  numCtx: number
): { chunks: Chunk[]; maxChars: number; sources: EpisodeBodySource[] } {
  const text = readBody(folder, relative);
  const parsed = parseEpisodeFileName(nodePath.basename(relative));
  const sources = episodeBodySources(relative, text, {
    chapterStart: parsed.chapterStart,
    chapterEnd: parsed.chapterEnd,
  });
  const maxChars = decideChunkSize(numCtx);
  return {
    chunks: chunksOfSources(sources, { maxChars }),
    maxChars,
    sources,
  };
}

/** `chunkIndex` が指定されていれば、そのチャンクだけに絞る */
export function selectChunks(chunks: Chunk[], chunkIndex?: number): Chunk[] {
  if (chunkIndex === undefined) return chunks;
  const found = chunks.filter((chunk) => chunk.index === chunkIndex);
  if (found.length === 0) {
    throw new McpToolError(
      `チャンク ${chunkIndex} がありません（このファイルは ${chunks.length} チャンクです）`
    );
  }
  return found;
}

/**
 * チャンクの呼び名。
 *
 * **切り方が変われば名前も変わる**ように、切った大きさまで入れてある。
 * `prompt` を取ったときと違う `numCtx` で `validate` を呼ぶと、別の本文を
 * 相手に検算することになるので、そこで気づけるようにする。
 */
export function chunkIdOf(
  relative: string,
  chunk: Chunk,
  maxChars: number
): string {
  return `${relative}#${chunk.index}@${maxChars}`;
}

export interface ParsedChunkId {
  filePath: string;
  index: number;
  maxChars: number;
}

export function parseChunkId(chunkId: string): ParsedChunkId {
  const at = chunkId.lastIndexOf("@");
  const hash = chunkId.lastIndexOf("#", at);
  if (at < 0 || hash < 0) {
    throw new McpToolError(
      `chunkId の形が違います: ${chunkId}（prompt か run が返したものをそのまま渡してください）`
    );
  }
  const index = Number(chunkId.slice(hash + 1, at));
  const maxChars = Number(chunkId.slice(at + 1));
  if (!Number.isInteger(index) || !Number.isInteger(maxChars)) {
    throw new McpToolError(`chunkId の形が違います: ${chunkId}`);
  }
  return { filePath: chunkId.slice(0, hash), index, maxChars };
}

/**
 * `chunkId` から、そのチャンクをもう一度組み立てる。
 *
 * **検算には本文そのものが要る**（AIが言った箇所が本文に実在するかを
 * 照合するため）。`chunkId` に切り方まで入れてあるので、同じ切り方で
 * 切り直せば同じチャンクになる。
 */
export function chunkFromId(folder: string, chunkId: string): Chunk {
  const parsed = parseChunkId(chunkId);
  const text = readBody(folder, parsed.filePath);
  const name = parseEpisodeFileName(nodePath.basename(parsed.filePath));
  const sources = episodeBodySources(parsed.filePath, text, {
    chapterStart: name.chapterStart,
    chapterEnd: name.chapterEnd,
  });
  const chunks = chunksOfSources(sources, { maxChars: parsed.maxChars });
  const chunk = chunks.find((item) => item.index === parsed.index);
  if (!chunk) {
    throw new McpToolError(
      `${chunkId} に当たるチャンクがありません（本文が変わっていませんか）`
    );
  }
  return chunk;
}

/**
 * そのチャンクが何話か。
 *
 * `chunker.ts` の `describeChunkScope` はファイルごとの見出しを引く形なので、
 * **合本（1ファイルに何話も入っている）では全チャンクが同じ見出しになる。**
 * ここではチャンクが持っている話数をそのまま読む。
 */
export function chapterLabelOf(chunk: Chunk): string {
  const start = chunk.chapterStart;
  const end = chunk.chapterEnd;
  if (start === null) return "話数不明";
  if (end === null || end === start) return `第${start}話`;
  return `第${start}〜${end}話`;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
