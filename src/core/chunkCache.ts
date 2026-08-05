import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { WorkEntry } from "../models/types";
import { workPaths } from "./workRegistry";

export interface CacheKeyBase {
  feature: string;
  promptVersion: string;
  model: string;
}

interface CacheEntry {
  key: string;
  createdAt: string;
  value: unknown;
}

/**
 * チャンク単位の処理結果キャッシュ。
 *
 * 一度処理した内容を再処理しないための仕組み。
 * キーには内容ハッシュに加えてプロンプトversionとモデル名を含める。
 * 異なるモデルで生成された結果は品質が揃わないため再利用しない。
 */
export class ChunkCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  constructor(private readonly work: WorkEntry) {}

  private async filePath(): Promise<string> {
    const p = workPaths(this.work);
    return path.join(p.aiwriter, "cache", "chunks.json");
  }

  async load(): Promise<void> {
    const file = await this.filePath();
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(file)
      );
      const parsed = JSON.parse(
        new TextDecoder().decode(bytes)
      ) as CacheEntry[];
      for (const e of parsed) {
        this.entries.set(e.key, e);
      }
    } catch {
      // キャッシュは失われても再生成できるため、読めなくても続行する
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const file = await this.filePath();
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(file))
    );
    const body = JSON.stringify([...this.entries.values()], null, 0);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(file),
      new TextEncoder().encode(body)
    );
    this.dirty = false;
  }

  get(chunkHash: string, base: CacheKeyBase): unknown | undefined {
    return this.entries.get(makeKey(chunkHash, base))?.value;
  }

  async set(
    chunkHash: string,
    base: CacheKeyBase,
    value: unknown
  ): Promise<void> {
    const key = makeKey(chunkHash, base);
    this.entries.set(key, {
      key,
      createdAt: new Date().toISOString(),
      value,
    });
    this.dirty = true;
  }

  /** 特定機能のキャッシュを破棄する */
  clearFeature(feature: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.key.startsWith(`${feature}:`)) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

function makeKey(chunkHash: string, base: CacheKeyBase): string {
  const digest = crypto
    .createHash("sha1")
    .update(`${base.promptVersion}|${base.model}|${chunkHash}`)
    .digest("hex")
    .slice(0, 24);
  return `${base.feature}:${digest}`;
}
