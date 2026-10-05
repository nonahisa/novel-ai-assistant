import fs from "node:fs";
import nodePath from "node:path";
import { z } from "zod";
import { Bm25Index } from "../../core/bm25";
import { manuscriptItems } from "../../core/manuscriptItems";
import { dropNeighbors, retrieve, type RetrievalCandidate } from "../../core/retrieval";
import type { RetrievalItem } from "../../core/retrievalCorpus";
import { lineOfPassage } from "../../core/semanticRank";
import {
  VECTOR_INDEX_DIR,
  VECTOR_INDEX_META_FILE,
  VECTOR_INDEX_VECTORS_FILE,
  cosine,
  decideSearchMethod,
  decodeVectors,
  isStoredMeta,
  nearestByCosine,
  type StoredMeta,
} from "../../core/vectorIndexFormat";
import {
  AI_ASSIGNMENTS_SNAPSHOT_PATH,
  parseAiAssignmentsSnapshot,
  type VectorSearchSetting,
} from "../../core/aiAssignmentsSnapshot";
import { localFetch } from "../../ai/fetchTimeouts";
import { mcpGlobalStorageRoot } from "../globalStorage";
import { enterLocalAi } from "../localAiTurn";
import { pastSceneSourcesOf } from "./contradiction";
import { DEFAULT_ENDPOINT, assertLocalOrAllowed } from "./ollama";
import { McpToolError, readBody } from "./shared";

/**
 * 質問に近い場面を探す（MCP `novel.search`。設計書6.19.11・6.87.23。0.99.19）。
 *
 * **作者が明示して引く道具。** MCP の相談（`chat.ts`）と資料の補強
 * （`settingsEnrich.ts`）は意味検索を使わない——索引の有無で答えが変わると、
 * 外から測った答えを製品の答えと比べられなくなる。ここは「索引を引く」こと
 * そのものが頼まれごとなので、その方針とぶつからない。どちらの道で探したかを
 * `method` に、語句で探した理由を `reason` に必ず書く。
 *
 * - **索引は作品フォルダーの `.aiwriter/cache/vector/`**（拡張機能が作ったもの）を
 *   読むだけ。作り直さない・書き足さない（作るのは `run.request` の `vectorIndex`）
 * - **検索語の埋め込みは、索引を作ったときと同じ Ollama・同じモデル**（索引の記録
 *   から読む）。拡張機能の今の設定と食い違えば意味では引かない
 * - **索引が無い・使えない作品は語句の一致で探す**（作者の裁定、2026-10-05）
 * - 本文の場面の割り方は製品と同じ（`pastSceneSourcesOf` → `manuscriptItems`）。
 *   鍵（`passageHash`）が合わなければ索引のベクトルを1件も引けない
 * - **本文の全文は返さない。** 場面ごとに抜粋（`SEARCH_EXCERPT_CHARS` 字まで）
 *
 * **製品の場面検索と違うところ**：語句一致の数え方（IDF）を本文の場面だけで
 * 組む（製品は設定資料・あらすじも混ぜた索引で数える）。並べ方（意味と語句を
 * 交互に詰め、隣の場面を畳む）は同じ部品を通す。
 */

/** 返す件数の既定と上限 */
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 20;
/** 1場面の抜粋の上限（字）。全文を返さない */
export const SEARCH_EXCERPT_CHARS = 200;
/**
 * 検索語の上限（字）。埋め込みは既定の読める長さで送る（製品の索引づくりと同じ
 * 要求の形にして、ベクトルを比べられるようにする）ので、それに収まる長さに切る。
 * 超えた分を黙って切らせないよう `truncate: false` も付ける（規則6の狙い）
 */
export const SEARCH_QUERY_MAX_CHARS = 500;
/** 1つの検索から取る件数（製品の場面検索と同じ） */
const PER_METHOD = 15;
/** 検索語の埋め込みを待つ上限 */
const EMBED_TIMEOUT_MS = 120_000;

export const NOVEL_SEARCH_INPUT = {
  folder: z.string().describe("作品フォルダーの絶対パス"),
  query: z
    .string()
    .min(1)
    .max(SEARCH_QUERY_MAX_CHARS)
    .describe("探したい場面を言葉で（本文の言い回しと違っていてよい）"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_LIMIT)
    .optional()
    .describe(`返す場面の数（既定${SEARCH_DEFAULT_LIMIT}、上限${SEARCH_MAX_LIMIT}）`),
};

export interface NovelSearchInput {
  folder: string;
  query: string;
  limit?: number;
}

export interface NovelSearchHit {
  rank: number;
  /** 作品フォルダーからの相対パス */
  file: string | null;
  /** 話の呼び名（「第3話 再会」） */
  episode: string;
  chapter: number | null;
  /** 話の中の何番目の場面か（「2/11」）。1つに収まった話は null */
  part: string | null;
  /** 場面が始まる行（1始まり）。見つからなければ null */
  line: number | null;
  excerpt: string;
  /** 近さ（コサイン。意味で引いたときだけ。語句で探したときは null） */
  score: number | null;
  foundBy: RetrievalCandidate["foundBy"];
}

export interface NovelSearchResult {
  method: "vector" | "wordMatch";
  /** 語句で探した理由（`wordMatch` のときだけ） */
  reason?: string;
  index: {
    model: string;
    /** 索引の作成日時（ISO）。記録に無い古い索引はファイルの更新時刻 */
    builtAt: string | null;
    builtAtSource: "record" | "fileTime" | null;
    /** 索引のベクトルの数（本文・設定資料・あらすじ） */
    vectors: number;
    /** いまの本文の場面のうち、索引にある数／全部 */
    covered: number;
    total: number;
  } | null;
  hits: NovelSearchHit[];
  note: string;
}

export interface NovelSearchDeps {
  /** 拡張機能の今の意味検索の設定（AI設定の写し）。無ければ undefined */
  setting(): VectorSearchSetting | undefined;
  /** 検索語を埋め込む（Ollama の `/api/embed`） */
  embed(endpoint: string, model: string, text: string): Promise<Float32Array>;
}

const defaultDeps: NovelSearchDeps = {
  setting: readVectorSetting,
  embed: embedQuery,
};

export async function novelSearch(
  args: NovelSearchInput,
  deps: NovelSearchDeps = defaultDeps
): Promise<NovelSearchResult> {
  const folder = nodePath.resolve(args.folder);
  if (!fs.existsSync(folder)) {
    throw new McpToolError(`作品フォルダーが見つかりません: ${args.folder}`);
  }
  const query = args.query.trim();
  if (!query) throw new McpToolError("query が空です。");
  const limit = Math.min(Math.max(args.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);

  // 本文の場面（製品と同じ割り方・同じ鍵）
  const items: RetrievalItem[] = pastSceneSourcesOf(folder).flatMap((source) =>
    manuscriptItems(source.label, source.text, {
      ...(source.filePath !== undefined ? { filePath: source.filePath } : {}),
      chapter: source.chapter ?? null,
    })
  );
  if (items.length === 0) {
    throw new McpToolError("本文の場面が1つもありません（本文が読めているか novel.scan で確かめてください）。");
  }

  const stored = readStoredIndex(folder);
  const uniqueHashes = [...new Set(items.map((item) => item.hash))];
  const covered = stored.vectors
    ? uniqueHashes.filter((hash) => stored.vectors?.has(hash)).length
    : 0;
  const setting = deps.setting();
  const endpoint = (stored.meta?.endpoint ?? setting?.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/u, "");
  let decision = decideSearchMethod({
    meta: stored.meta,
    vectorsOk: stored.vectors !== undefined,
    setting: setting ? { enabled: setting.enabled, model: setting.model } : undefined,
    endpointLocal: isLocal(endpoint),
    covered,
    total: uniqueHashes.length,
  });

  let queryVector: Float32Array | undefined;
  if (decision.method === "vector" && stored.meta) {
    try {
      queryVector = await deps.embed(endpoint, stored.meta.model, query);
      if (queryVector.length !== stored.meta.dimensions) {
        decision = {
          method: "wordMatch",
          reason: `検索語の埋め込みの次元（${queryVector.length}）が索引（${stored.meta.dimensions}）と合いません`,
        };
        queryVector = undefined;
      }
    } catch (error) {
      // **止めずに語句一致へ落とす**（製品の相談・場面検索と同じ）
      decision = {
        method: "wordMatch",
        reason: `検索語を埋め込めませんでした（${error instanceof Error ? error.message : String(error)}）`,
      };
    }
  }

  const bm25 = new Bm25Index(items.map((item) => ({ id: item.id, text: item.text })));
  const vectors = stored.vectors;
  const candidates = retrieve(
    {
      items,
      bm25,
      query,
      ...(queryVector && vectors
        ? {
            semantic: {
              index: {
                search: (q: Float32Array, c: readonly { id: string; hash: string }[], n: number) =>
                  nearestByCosine((hash) => vectors.get(hash), q, c, n),
              },
              queryVector,
            },
          }
        : {}),
    },
    // 字数では切らない（AIへ渡すのではなく、呼び手に並べるだけ）
    { maxChars: Number.MAX_SAFE_INTEGER, perMethod: PER_METHOD, sources: ["本文"] }
  );
  const picked = dropNeighbors(candidates).slice(0, limit);

  const fileTexts = new Map<string, string | undefined>();
  const hits = picked.map((candidate, position): NovelSearchHit => {
    const item = candidate.item;
    const vector = queryVector ? vectors?.get(item.hash) : undefined;
    return {
      rank: position + 1,
      file: item.filePath ?? null,
      episode: item.label,
      chapter: typeof item.chapter === "number" ? item.chapter : null,
      part: item.part ? `${item.part.index}/${item.part.total}` : null,
      line: lineOf(folder, item, fileTexts),
      excerpt: excerptOf(item.text),
      score: queryVector && vector ? Math.round(cosine(queryVector, vector) * 1000) / 1000 : null,
      foundBy: candidate.foundBy,
    };
  });

  const index = stored.meta
    ? {
        model: stored.meta.model,
        builtAt: stored.builtAt ?? null,
        builtAtSource: stored.builtAtSource ?? null,
        vectors: stored.meta.hashes.length,
        covered,
        total: uniqueHashes.length,
      }
    : null;

  return {
    method: decision.method,
    ...(decision.method === "wordMatch" ? { reason: decision.reason } : {}),
    index,
    hits,
    note:
      (decision.method === "vector"
        ? "意味の近さ（索引）と語句の一致を交互に並べました（製品の場面検索と同じ並べ方）。score はコサインの近さです。"
        : `語句の一致で探しました（${decision.reason}）。言い回しが本文と違うと当たりにくくなります。` +
          "索引は run.request の feature: vectorIndex で作れます（作者の確認つき）。") +
      ` 抜粋は1場面${SEARCH_EXCERPT_CHARS}字までです。全文は novel.material などで読んでください。` +
      "読むだけで、原稿も索引も変えていません。",
  };
}

interface StoredIndex {
  meta: StoredMeta | undefined;
  vectors: Map<string, Float32Array> | undefined;
  builtAt?: string;
  builtAtSource?: "record" | "fileTime";
}

/** 作品の索引を読む。**読むだけ**で、無い・壊れていれば空（理由は判定が付ける） */
function readStoredIndex(folder: string): StoredIndex {
  const dir = nodePath.join(folder, ...VECTOR_INDEX_DIR);
  const metaPath = nodePath.join(dir, VECTOR_INDEX_META_FILE);
  let meta: StoredMeta | undefined;
  let mtime: Date | undefined;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (isStoredMeta(raw)) meta = raw;
    mtime = fs.statSync(metaPath).mtime;
  } catch {
    return { meta: undefined, vectors: undefined };
  }
  if (!meta) return { meta: undefined, vectors: undefined };
  let vectors: Map<string, Float32Array> | undefined;
  try {
    vectors = decodeVectors(meta, fs.readFileSync(nodePath.join(dir, VECTOR_INDEX_VECTORS_FILE)));
  } catch {
    vectors = undefined;
  }
  return {
    meta,
    vectors,
    ...(meta.builtAt
      ? { builtAt: meta.builtAt, builtAtSource: "record" as const }
      : mtime
        ? { builtAt: mtime.toISOString(), builtAtSource: "fileTime" as const }
        : {}),
  };
}

function isLocal(endpoint: string): boolean {
  try {
    assertLocalOrAllowed(endpoint);
    return true;
  } catch {
    return false;
  }
}

/** 抜粋。改行と空白を詰めて頭から上限まで */
export function excerptOf(text: string, limit = SEARCH_EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 場面の始まる行（製品の場面検索と同じ探し方）。読めなければ null */
function lineOf(
  folder: string,
  item: RetrievalItem,
  cache: Map<string, string | undefined>
): number | null {
  if (!item.filePath) return null;
  if (!cache.has(item.filePath)) {
    try {
      cache.set(item.filePath, readBody(folder, item.filePath));
    } catch {
      cache.set(item.filePath, undefined);
    }
  }
  const text = cache.get(item.filePath);
  return text === undefined ? null : (lineOfPassage(text, item.text) ?? null);
}

/** 拡張機能の意味検索の設定（AI設定の写し）。写しが無い・古ければ undefined */
function readVectorSetting(): VectorSearchSetting | undefined {
  const root = mcpGlobalStorageRoot();
  if (!root) return undefined;
  try {
    const text = fs.readFileSync(nodePath.join(root, ...AI_ASSIGNMENTS_SNAPSHOT_PATH), "utf8");
    return parseAiAssignmentsSnapshot(text)?.vectorSearch;
  } catch {
    return undefined;
  }
}

/**
 * 検索語を Ollama で埋め込む。**製品の索引づくり（`OllamaEmbeddingProvider.embed`）と
 * 同じ要求の形**（`model` と `input`）に、黙って切らせない `truncate: false` を足す。
 * ほかの窓・ほかの MCP サーバーとは順番を取る（設計書6.76.1）。
 */
async function embedQuery(endpoint: string, model: string, text: string): Promise<Float32Array> {
  const leave = await enterLocalAi(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    // **手元の口（`localFetch`）で投げる**（製品の埋め込み・`ollama.ts` と同じ。`fetchTimeouts.ts`）
    const response = await localFetch(
      `${endpoint}/api/embed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: [text], truncate: false }),
        signal: controller.signal,
      },
      EMBED_TIMEOUT_MS
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        response.status === 404
          ? `モデル「${model}」が Ollama にありません`
          : `HTTP ${response.status} ${detail.slice(0, 200)}`
      );
    }
    const json = (await response.json()) as { embeddings?: unknown; error?: unknown };
    if (typeof json.error === "string") throw new Error(json.error.slice(0, 200));
    const first = Array.isArray(json.embeddings) ? json.embeddings[0] : undefined;
    if (!Array.isArray(first) || first.some((value) => typeof value !== "number")) {
      throw new Error("埋め込みが返りませんでした");
    }
    return Float32Array.from(first as number[]);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("埋め込みが時間内に終わりませんでした");
    }
    if (error instanceof TypeError) throw new Error(`Ollama に接続できません（${endpoint}）`);
    throw error;
  } finally {
    clearTimeout(timer);
    leave();
  }
}
