import * as vscode from "vscode";
import { WorkEntry } from "../models/types";
import { Bm25Index } from "../core/bm25";
import {
  buildRetrievalCorpus,
  type RetrievalItem,
} from "../core/retrievalCorpus";
import { VectorIndex } from "../core/vectorIndex";
import { retrieve, type RetrievalCandidate, type RetrievalOptions } from "../core/retrieval";
import {
  OllamaEmbeddingProvider,
  DEFAULT_EMBEDDING_MODEL,
} from "../ai/ollamaEmbedding";
import { EmbeddingError, type EmbeddingProvider } from "../ai/embeddingProvider";
import { withCancellableProgress } from "../views/progress";
import { logFailure } from "../core/logger";

/**
 * 検索の入口。相談パネル・設定資料パネル・（今後の）矛盾検知から呼ぶ。
 *
 * ## 使用・不使用の切り替え
 *
 * `novelai.vectorSearch.enabled` が入口。**既定は「切」にしてある。**
 * 埋め込みモデルの取得に1.2GBかかり、非力な機械では索引づくりが重い。
 * 黙って始めるものではないので、作者が入れると決めたときだけ動かす。
 *
 * **切っていても検索そのものは動く。** 語句一致（BM25）は
 * AIもモデルも要らない。質問を検索に使うようになるだけで、
 * 実測では今のやり方（均等間引き）より良くなる。
 */

/** 相談へ渡す材料の上限。既存の抜粋と同じ量に合わせる */
export const RETRIEVAL_MAX_CHARS = 12000;

/** 一度に埋め込む件数。非力な機械で詰まらせないため小さめにする */
const EMBED_BATCH = 16;

export interface RetrievalContext {
  items: RetrievalItem[];
  bm25: Bm25Index;
  /** 意味検索が使えるときだけ入る */
  vector?: { index: VectorIndex; provider: EmbeddingProvider };
  /** 競合マーカーがあって読めなかったファイル */
  conflicted: string[];
}

export function isVectorSearchEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>("vectorSearch.enabled", false);
}

export function embeddingModelName(): string {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<string>("vectorSearch.model", DEFAULT_EMBEDDING_MODEL);
}

/**
 * 検索の材料を用意する。
 *
 * 意味検索が使えないとき（設定が切、Ollamaが無い、索引が未作成）は
 * `vector` を付けずに返す。**呼び出し側は分岐しなくてよい。**
 */
export async function prepareRetrieval(
  work: WorkEntry
): Promise<RetrievalContext> {
  const corpus = await buildRetrievalCorpus(work);
  const bm25 = new Bm25Index(
    corpus.items.map((item) => ({ id: item.id, text: item.text }))
  );
  const lexicalOnly: RetrievalContext = {
    items: corpus.items,
    bm25,
    conflicted: corpus.conflicted,
  };

  if (!isVectorSearchEnabled()) return lexicalOnly;

  const provider = new OllamaEmbeddingProvider();
  let index = await VectorIndex.load(work, provider.model);

  const missing = corpus.items.filter((item) => !index.has(item.hash));

  // 索引がまだ無いときは、黙って作り始めない。
  // 作品まるごとで実測39秒かかり、非力な機械ではもっとかかる
  if (index.size === 0) return lexicalOnly;

  // 書き足したぶんだけ追いつかせる。1話ぶん（12件）で実測0.2秒
  if (missing.length > 0 && autoUpdateEnabled()) {
    try {
      index.setModel(provider.model);
      await embedInto(index, missing, provider);
      index.retainOnly(corpus.items.map((item) => item.hash));
      await index.save(work);
    } catch (error) {
      logFailure("索引の自動更新に失敗（そのままの索引で続行）", {
        件数: missing.length,
        理由: error instanceof Error ? error.message : String(error),
      });
      index = await VectorIndex.load(work, provider.model);
    }
  }

  // それでも大半が未収録なら意味検索は使わない。
  // 中途半端な索引で引くと、載っている場面ばかりが上位に出て偏る
  const covered = corpus.items.filter((item) => index.has(item.hash)).length;
  if (covered < corpus.items.length * 0.9) return lexicalOnly;

  return {
    items: corpus.items,
    bm25,
    vector: { index, provider },
    conflicted: corpus.conflicted,
  };
}

function autoUpdateEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>("vectorSearch.autoUpdate", true);
}

/** まとめて埋め込んで索引へ入れる。同じ内容は1回だけ */
async function embedInto(
  index: VectorIndex,
  items: readonly RetrievalItem[],
  provider: EmbeddingProvider
): Promise<number> {
  const unique = [...new Map(items.map((item) => [item.hash, item])).values()];
  let built = 0;
  for (let i = 0; i < unique.length; i += EMBED_BATCH) {
    built += await embedBatch(index, unique.slice(i, i + EMBED_BATCH), provider);
  }
  return built;
}

/**
 * 1回ぶんを埋め込む。詰まったら半分にして やり直す。
 *
 * **非力な機械では、まとめて投げると時間内に返ってこない。**
 * 実データ（2,541件）を通したときに実際に起きた。件数を減らせば通るので、
 * 作者に設定をいじらせるより、その場で小さくして続けるほうがよい。
 * 1件でも通らなければ、その塊は諦めて次へ進む
 * （1か所の失敗で索引づくり全体を止めない）。
 */
async function embedBatch(
  index: VectorIndex,
  batch: readonly RetrievalItem[],
  provider: EmbeddingProvider
): Promise<number> {
  if (batch.length === 0) return 0;
  try {
    const vectors = await provider.embed(batch.map((item) => item.text));
    batch.forEach((item, j) => {
      const vector = vectors[j];
      if (vector) index.set(item.hash, vector);
    });
    return batch.length;
  } catch (error) {
    const timedOut =
      error instanceof EmbeddingError && error.kind === "timeout";
    if (!timedOut || batch.length === 1) throw error;

    logFailure("埋め込みが詰まったので件数を半分にして続けます", {
      件数: batch.length,
    });
    const half = Math.ceil(batch.length / 2);
    return (
      (await embedBatch(index, batch.slice(0, half), provider)) +
      (await embedBatch(index, batch.slice(half), provider))
    );
  }
}

/**
 * 実際に引く。
 *
 * 質問の埋め込みに失敗したら、**語句一致だけで続ける**。
 * ここで例外にすると相談そのものが止まる。
 */
export async function search(
  context: RetrievalContext,
  query: string,
  options: RetrievalOptions
): Promise<RetrievalCandidate[]> {
  let semantic: { index: VectorIndex; queryVector: Float32Array } | undefined;

  if (context.vector) {
    try {
      const [vector] = await context.vector.provider.embed([query]);
      if (vector) semantic = { index: context.vector.index, queryVector: vector };
    } catch (error) {
      logFailure("質問の埋め込みに失敗（語句一致だけで続行）", {
        理由: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return retrieve(
    { items: context.items, bm25: context.bm25, query, semantic },
    options
  );
}

export interface IndexBuildResult {
  built: number;
  reused: number;
  removed: number;
  total: number;
  seconds: number;
  bytes: number;
  cancelled: boolean;
}

/**
 * 索引を作る・更新する。
 *
 * **変わっていない材料は作り直さない。** 内容ハッシュで判定する。
 * 実測で1話ぶん（12件）0.2秒、作品まるごと（2,541件）39秒。
 *
 * 途中で中止されても、**それまでのぶんは保存する**。
 * 次に実行したとき続きから進められる（大きい作品ほど効く）。
 */
export async function buildVectorIndex(
  work: WorkEntry
): Promise<IndexBuildResult | undefined> {
  const provider = new OllamaEmbeddingProvider();
  const check = await provider.check();
  if (!check.ok) {
    await showEmbeddingError(check.error);
    return undefined;
  }

  const corpus = await buildRetrievalCorpus(work);
  if (corpus.items.length === 0) {
    vscode.window.showWarningMessage(
      "索引にする材料がありません。本文が読み込めているか確認してください。"
    );
    return undefined;
  }

  const index = await VectorIndex.load(work, provider.model);
  index.setModel(provider.model);

  const pending = corpus.items.filter((item) => !index.has(item.hash));
  const reused = corpus.items.length - pending.length;

  // 同じ内容の場面が複数あることがある（定型のあいさつなど）。
  // ハッシュが同じなら1回だけ埋め込めばよい
  const uniquePending = [...new Map(pending.map((i) => [i.hash, i])).values()];

  const started = Date.now();
  let built = 0;
  let cancelled = false;

  if (uniquePending.length > 0) {
    await withCancellableProgress(
      `検索用の索引を作っています（${uniquePending.length}件）`,
      async (progress, token) => {
        for (let i = 0; i < uniquePending.length; i += EMBED_BATCH) {
          if (token.isCancellationRequested) {
            cancelled = true;
            return;
          }
          const batch = uniquePending.slice(i, i + EMBED_BATCH);
          try {
            // 詰まったら中で半分にして やり直す（非力な機械への備え）
            built += await embedBatch(index, batch, provider);
          } catch (error) {
            // 1回の失敗で全部を捨てない。残りを続け、最後にまとめて報告する
            logFailure("索引づくりの一部が失敗", {
              位置: `${i + 1}件目から${batch.length}件`,
              理由: error instanceof Error ? error.message : String(error),
            });
          }
          progress.report({
            message: `${Math.min(i + EMBED_BATCH, uniquePending.length)}/${
              uniquePending.length
            }`,
            increment: (EMBED_BATCH / uniquePending.length) * 100,
          });
        }
      }
    );
  }

  const removed = index.retainOnly(corpus.items.map((item) => item.hash));
  await index.save(work);

  return {
    built,
    reused,
    removed,
    total: corpus.items.length,
    seconds: (Date.now() - started) / 1000,
    bytes: await VectorIndex.storedBytes(work),
    cancelled,
  };
}

export async function removeVectorIndex(work: WorkEntry): Promise<void> {
  await VectorIndex.remove(work);
}

async function showEmbeddingError(error: EmbeddingError): Promise<void> {
  const setup = "セットアップを見る";
  const picked = await vscode.window.showErrorMessage(
    `${error.message} ${error.nextStep}`,
    setup
  );
  if (picked === setup) {
    await vscode.commands.executeCommand("novelai.setupVectorSearch");
  }
}
