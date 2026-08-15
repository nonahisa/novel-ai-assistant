import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";
import { atomicWriteFile } from "./atomicWrite";

/**
 * 意味検索のための索引（ベクトルDB）。
 *
 * ## 置き場所と同期
 *
 * `.aiwriter/cache/` に置く。**ここは既にGit除外されている**ので、
 * 数MBの索引がGitHubへ流れ込むことはない。代わりに端末ごとに作り直しが要る。
 * 実データ（78.5万字・219話・2,541件）で39秒だったので、それで釣り合う。
 *
 * ## 形式
 *
 * ベクトルは `vectors.bin`（float32の並び）、対応表は `index.json`。
 * JSONに数値の配列で入れると、2,541件で数十MBの文字列になり
 * 読み書きが重い。バイナリなら同じ内容が9.9MBで済む。
 *
 * ## 作り直しの単位
 *
 * **内容ハッシュで持つ。** 1話直したらその話の場面だけ作り直す。
 * 実測で1話ぶん12件＝0.2秒。既存の `chunkCache.ts` と同じ考え方。
 * モデル名も鍵に含める。別のモデルで作ったベクトルは混ぜると
 * 距離が意味を持たなくなるため、モデルを変えたら全部作り直す。
 */

/** 保存形式の版。作りを変えたら上げる（古い索引は作り直す） */
export const VECTOR_INDEX_VERSION = 2;

interface StoredMeta {
  version: number;
  model: string;
  dimensions: number;
  /** ベクトルの並び順と対応する。i番目のハッシュがi番目のベクトル */
  hashes: string[];
}

export interface VectorEntry {
  hash: string;
  vector: Float32Array;
}

export class VectorIndex {
  private readonly byHash = new Map<string, Float32Array>();
  private model = "";
  private dimensions = 0;

  private constructor() {}

  static empty(): VectorIndex {
    return new VectorIndex();
  }

  get size(): number {
    return this.byHash.size;
  }

  get modelName(): string {
    return this.model;
  }

  has(hash: string): boolean {
    return this.byHash.has(hash);
  }

  get(hash: string): Float32Array | undefined {
    return this.byHash.get(hash);
  }

  set(hash: string, vector: Float32Array): void {
    if (this.dimensions === 0) this.dimensions = vector.length;
    this.byHash.set(hash, vector);
  }

  setModel(model: string): void {
    this.model = model;
  }

  /**
   * 使われなくなったベクトルを落とす。
   *
   * 本文を書き換えるたびに古い場面のベクトルが残ると、
   * 索引が延々と太る。作り直しのたびに掃除する。
   */
  retainOnly(hashes: Iterable<string>): number {
    const keep = new Set(hashes);
    let removed = 0;
    for (const hash of [...this.byHash.keys()]) {
      if (!keep.has(hash)) {
        this.byHash.delete(hash);
        removed++;
      }
    }
    return removed;
  }

  /**
   * 近い順に返す。
   *
   * 総当たりで計算する。**近似検索の仕組みは入れない。** 実測で
   * 2,541件・1024次元の総当たりが1問219ms（質問の埋め込み込み）で、
   * 作品1つぶんの規模では十分速い。近似の仕組みを入れると
   * 依存も、索引の作り直しの手間も増える。
   */
  search(
    query: Float32Array,
    candidates: readonly { id: string; hash: string }[],
    limit: number
  ): Array<{ id: string; score: number }> {
    const queryNorm = norm(query);
    if (queryNorm === 0 || limit <= 0) return [];

    const scored: Array<{ id: string; score: number }> = [];
    for (const candidate of candidates) {
      const vector = this.byHash.get(candidate.hash);
      if (!vector) continue;
      const vectorNorm = norm(vector);
      if (vectorNorm === 0) continue;
      scored.push({
        id: candidate.id,
        score: dot(query, vector) / (queryNorm * vectorNorm),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // ─── 保存と読み込み ───

  static async load(work: WorkEntry, model: string): Promise<VectorIndex> {
    const index = new VectorIndex();
    const paths = indexPaths(work);
    try {
      const metaBytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(paths.meta)
      );
      const meta: unknown = JSON.parse(new TextDecoder().decode(metaBytes));
      if (!isStoredMeta(meta)) return index;
      // 版かモデルが違えば、読まずに空から作り直す。
      // 別のモデルのベクトルと混ぜると距離が意味を失う
      if (meta.version !== VECTOR_INDEX_VERSION || meta.model !== model) {
        return index;
      }

      const binBytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(paths.vectors)
      );
      const expected = meta.hashes.length * meta.dimensions * 4;
      if (binBytes.byteLength !== expected) {
        // 途中で切れた索引は使わない。作り直せば済む
        return index;
      }

      const floats = new Float32Array(
        binBytes.buffer.slice(
          binBytes.byteOffset,
          binBytes.byteOffset + binBytes.byteLength
        )
      );
      meta.hashes.forEach((hash, i) => {
        index.byHash.set(
          hash,
          floats.subarray(i * meta.dimensions, (i + 1) * meta.dimensions)
        );
      });
      index.model = meta.model;
      index.dimensions = meta.dimensions;
    } catch {
      // 索引は失われても作り直せる。読めなくても空で続行する
    }
    return index;
  }

  async save(work: WorkEntry): Promise<void> {
    const paths = indexPaths(work);
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(paths.meta))
    );

    const hashes = [...this.byHash.keys()];
    const dimensions = this.dimensions;
    const bin = new Float32Array(hashes.length * dimensions);
    hashes.forEach((hash, i) => {
      const vector = this.byHash.get(hash);
      if (vector) bin.set(vector, i * dimensions);
    });

    const meta: StoredMeta = {
      version: VECTOR_INDEX_VERSION,
      model: this.model,
      dimensions,
      hashes,
    };

    // キャッシュなので上書きでよい（作者のデータではない）
    await atomicWriteFile(
      paths.vectors,
      new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength)
    );
    await atomicWriteFile(
      paths.meta,
      new TextEncoder().encode(JSON.stringify(meta))
    );
  }

  /** 索引を消す。設定を切ったときや、作り直したいときに使う */
  static async remove(work: WorkEntry): Promise<void> {
    const paths = indexPaths(work);
    for (const target of [paths.vectors, paths.meta]) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(target));
      } catch {
        // 無ければそれでよい
      }
    }
  }

  /** 保存されている大きさ（バイト）。作者に費用を示すために使う */
  static async storedBytes(work: WorkEntry): Promise<number> {
    const paths = indexPaths(work);
    let total = 0;
    for (const target of [paths.vectors, paths.meta]) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(target));
        total += stat.size;
      } catch {
        // 無ければ0
      }
    }
    return total;
  }
}

function indexPaths(work: WorkEntry): { vectors: string; meta: string } {
  const base = path.join(workPaths(work).aiwriter, "cache", "vector");
  return {
    vectors: path.join(base, "vectors.bin"),
    meta: path.join(base, "index.json"),
  };
}

function isStoredMeta(value: unknown): value is StoredMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.version === "number" &&
    typeof meta.model === "string" &&
    typeof meta.dimensions === "number" &&
    meta.dimensions > 0 &&
    Array.isArray(meta.hashes) &&
    meta.hashes.every((hash) => typeof hash === "string")
  );
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum);
}
