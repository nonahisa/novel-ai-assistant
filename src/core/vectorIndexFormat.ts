/**
 * 意味検索の索引（`vectorIndex.ts`）の**ファイルの形と判断だけ**を持つ葉の部品。
 *
 * **VS Code にも Node にも依存しない。** 索引を読み書きする `VectorIndex` は
 * `vscode.workspace.fs` を使うので MCP の束からは使えない。MCP の `novel.search`
 * （設計書6.19.11）も同じ索引を読むので、形の解釈・ベクトルの並べ方・近さの
 * 計算を2か所に写さないよう、ここへ出した（`test/unit/cross/mcpReach.test.ts`）。
 */

/** 保存形式の版。作りを変えたら上げる（古い索引は作り直す） */
export const VECTOR_INDEX_VERSION = 2;

/** 作品フォルダーからの索引の置き場（`.aiwriter/cache/` は Git 除外。5.5節） */
export const VECTOR_INDEX_DIR = [".aiwriter", "cache", "vector"] as const;
export const VECTOR_INDEX_META_FILE = "index.json";
export const VECTOR_INDEX_VECTORS_FILE = "vectors.bin";

export interface StoredMeta {
  version: number;
  model: string;
  dimensions: number;
  /** ベクトルの並び順と対応する。i番目のハッシュがi番目のベクトル */
  hashes: string[];
  /**
   * 最後に保存した時刻（ISO）。0.99.19 から書く。**任意の欄**——版
   * （`VECTOR_INDEX_VERSION`）を上げると全員の索引が作り直しになるので上げない。
   * 無い索引は、読む側がファイルの更新時刻で代わりにする
   */
  builtAt?: string;
  /**
   * 埋め込みに使った Ollama の場所（0.99.19 から）。MCP の `novel.search` が
   * **索引を作ったのと同じ場所・同じモデル**で検索語を埋め込むために読む
   */
  endpoint?: string;
}

export function isStoredMeta(value: unknown): value is StoredMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.version === "number" &&
    typeof meta.model === "string" &&
    typeof meta.dimensions === "number" &&
    meta.dimensions > 0 &&
    Array.isArray(meta.hashes) &&
    meta.hashes.every((hash) => typeof hash === "string") &&
    (meta.builtAt === undefined || typeof meta.builtAt === "string") &&
    (meta.endpoint === undefined || typeof meta.endpoint === "string")
  );
}

/**
 * `vectors.bin` のバイト列から、ハッシュ → ベクトルの表を組む。
 * **大きさが合わなければ undefined**（途中で切れた索引は使わない。作り直せば済む）。
 */
export function decodeVectors(
  meta: StoredMeta,
  bytes: Uint8Array
): Map<string, Float32Array> | undefined {
  const expected = meta.hashes.length * meta.dimensions * 4;
  if (bytes.byteLength !== expected) return undefined;
  // 4の倍数の位置から始まるとは限らないので、写してから読む
  const floats = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
  const out = new Map<string, Float32Array>();
  meta.hashes.forEach((hash, i) => {
    out.set(hash, floats.subarray(i * meta.dimensions, (i + 1) * meta.dimensions));
  });
  return out;
}

/**
 * 近い順に返す（総当たりのコサイン）。
 *
 * **近似検索の仕組みは入れない。** 実測で 2,541件・1024次元の総当たりが
 * 1問219ms（質問の埋め込み込み）で、作品1つぶんの規模では十分速い。
 */
export function nearestByCosine(
  lookup: (hash: string) => Float32Array | undefined,
  query: Float32Array,
  candidates: readonly { id: string; hash: string }[],
  limit: number
): Array<{ id: string; score: number }> {
  const queryNorm = vectorNorm(query);
  if (queryNorm === 0 || limit <= 0) return [];
  const scored: Array<{ id: string; score: number }> = [];
  for (const candidate of candidates) {
    const vector = lookup(candidate.hash);
    if (!vector) continue;
    const norm = vectorNorm(vector);
    if (norm === 0) continue;
    scored.push({ id: candidate.id, score: dot(query, vector) / (queryNorm * norm) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** 2つのベクトルのコサイン。どちらかが零なら 0 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const na = vectorNorm(a);
  const nb = vectorNorm(b);
  return na === 0 || nb === 0 ? 0 : dot(a, b) / (na * nb);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}

function vectorNorm(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum);
}

// ── MCP の novel.search：意味で引くか、語句の一致で探すか ─────────

/**
 * 索引が本文の何割に届いていれば意味で引くか。**製品と同じ門**
 * （`features/vectorSearch.ts` の `prepareRetrieval`。中途半端な索引は、
 * 載っている場面ばかりを上位に出す）。
 */
export const VECTOR_COVERAGE_GATE = 0.9;

export interface SearchMethodInput {
  /** 索引の記録。無い・読めない・壊れていれば undefined */
  meta: StoredMeta | undefined;
  /** `vectors.bin` が記録どおりの大きさで読めたか */
  vectorsOk: boolean;
  /**
   * 拡張機能の今の設定（AI設定の写し。`aiAssignmentsSnapshot.ts`）。
   * **写しが古くて欄が無ければ undefined**——そのときは設定との照合を飛ばす
   */
  setting: { enabled: boolean; model: string } | undefined;
  /** 検索語を埋め込む Ollama が手元か（`allowRemote` の無い遠くへは送らない） */
  endpointLocal: boolean;
  /** いまの本文の場面のうち、索引にベクトルがある数 */
  covered: number;
  total: number;
}

export type SearchMethodDecision =
  | { method: "vector" }
  | { method: "wordMatch"; reason: string };

/**
 * 意味で引くか、語句の一致で探すか（作者の裁定、2026-10-05「語句の一致で探す」）。
 *
 * **索引を作ったときと同じモデルで検索語を埋め込めないなら、意味では引かない。**
 * 別のモデルのベクトルと比べると、近さが意味を失う。理由は呼び手（Claude Code）が
 * 作者へそのまま伝えられる言い方で返す。
 */
export function decideSearchMethod(input: SearchMethodInput): SearchMethodDecision {
  const meta = input.meta;
  if (!meta) return { method: "wordMatch", reason: "この作品には検索用の索引がありません" };
  if (meta.version !== VECTOR_INDEX_VERSION) {
    return { method: "wordMatch", reason: "索引の形式が古いため使えません（作り直すと使えます）" };
  }
  if (!input.vectorsOk) {
    return { method: "wordMatch", reason: "索引のファイルが途中で切れています（作り直すと使えます）" };
  }
  if (input.setting && !input.setting.enabled) {
    return { method: "wordMatch", reason: "拡張機能の設定でベクトル検索が「切」です" };
  }
  if (input.setting && input.setting.model !== meta.model) {
    return {
      method: "wordMatch",
      reason: `索引のモデル（${meta.model}）が今の設定（${input.setting.model}）と違います（作り直すと使えます）`,
    };
  }
  if (!input.endpointLocal) {
    return {
      method: "wordMatch",
      reason: "検索語を埋め込む Ollama が手元ではないため送りませんでした",
    };
  }
  if (input.total === 0 || input.covered < input.total * VECTOR_COVERAGE_GATE) {
    return {
      method: "wordMatch",
      reason: `索引が本文に追いついていません（${input.covered}/${input.total}場面。更新すると使えます）`,
    };
  }
  return { method: "vector" };
}
