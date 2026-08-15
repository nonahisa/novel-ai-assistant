import * as vscode from "vscode";
import {
  EmbeddingError,
  type EmbeddingProvider,
} from "./embeddingProvider";

/**
 * Ollamaの `/api/embed` を使った埋め込み。
 *
 * ## 既定のモデル
 *
 * `bge-m3`。日本語を含む多言語向けで、1.2GB・1024次元。
 * 実データ（78.5万字・2,541件）で39秒、索引9.9MBだった。
 * **モデル名はハードコードせず設定で変えられるようにする。**
 * 新しいモデルが次々出るため（この作品で繰り返し確認してきた方針）。
 *
 * ## まとめて投げる
 *
 * `/api/embed` は配列を受け取れる。1件ずつ呼ぶと通信の往復で
 * 何倍も遅くなる。ただし一度に大量へ渡すと、機械が非力なときに
 * 詰まるので、呼び出し側で小分けにして渡す前提にしてある。
 */

const DEFAULT_ENDPOINT = "http://localhost:11434";
export const DEFAULT_EMBEDDING_MODEL = "bge-m3";

interface EmbedResponse {
  embeddings?: number[][];
  error?: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly label = "Ollama（手元・無料）";

  constructor(private readonly modelName?: string) {}

  get model(): string {
    if (this.modelName) return this.modelName;
    return vscode.workspace
      .getConfiguration("novelai")
      .get<string>("vectorSearch.model", DEFAULT_EMBEDDING_MODEL);
  }

  private get endpoint(): string {
    return vscode.workspace
      .getConfiguration("novelai")
      .get<string>("ollama.endpoint", DEFAULT_ENDPOINT)
      .replace(/\/+$/, "");
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const json = await this.post<EmbedResponse>(
      "/api/embed",
      { model: this.model, input: [...texts] },
      120000
    );

    if (json.error) {
      throw new EmbeddingError(
        `埋め込みに失敗しました: ${json.error}`,
        json.error.includes("not found") ? "model_missing" : "unknown",
        `Ollamaで「${this.model}」を取得してください。`
      );
    }
    const vectors = json.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      // 件数が合わないと、どの場面のベクトルか分からなくなる。
      // ずれたまま保存すると、見当違いの場面が上位に出続ける
      throw new EmbeddingError(
        `埋め込みの件数が合いません（送り${texts.length}件・戻り${
          Array.isArray(vectors) ? vectors.length : 0
        }件）。`,
        "unknown",
        "もう一度お試しください。続くようならモデルを変えてください。"
      );
    }

    return vectors.map((vector) => Float32Array.from(vector));
  }

  async check(): Promise<{ ok: true } | { ok: false; error: EmbeddingError }> {
    try {
      // 1件だけ埋め込んでみる。/api/tags だけでは
      // 「モデルはあるが埋め込みに対応していない」を見抜けない
      const vectors = await this.embed(["接続確認"]);
      if (vectors.length === 1 && vectors[0].length > 0) return { ok: true };
      return {
        ok: false,
        error: new EmbeddingError(
          `「${this.model}」は埋め込みを返しませんでした。`,
          "model_missing",
          "埋め込み用のモデル（bge-m3 など）を指定してください。"
        ),
      };
    } catch (error) {
      if (error instanceof EmbeddingError) return { ok: false, error };
      return {
        ok: false,
        error: new EmbeddingError(
          `Ollamaに接続できません（${this.endpoint}）。`,
          "not_running",
          "Ollamaを起動してください。"
        ),
      };
    }
  }

  private async post<T>(
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        if (response.status === 404) {
          throw new EmbeddingError(
            `モデル「${this.model}」が見つかりません。`,
            "model_missing",
            `「${this.model}」を取得してください。`
          );
        }
        throw new EmbeddingError(
          `埋め込みの要求が失敗しました（HTTP ${response.status}）。${detail.slice(0, 200)}`,
          "unknown",
          "Ollamaのログを確認してください。"
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new EmbeddingError(
          "埋め込みが時間内に終わりませんでした。",
          "timeout",
          "一度に処理する件数を減らすか、軽いモデルへ変えてください。"
        );
      }
      throw new EmbeddingError(
        `Ollamaに接続できません（${this.endpoint}）。`,
        "not_running",
        "Ollamaを起動してください。"
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
