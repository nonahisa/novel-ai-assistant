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
import { rankByNearest, type VectorLookup } from "../core/semanticRank";
import { withCancellableProgress } from "../views/progress";
import { logFailure, useLogFile } from "../core/logger";

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
  /**
   * 意味検索を使えなかった理由（`vector` が無いときだけ入る）。
   * 場面検索・執筆再開が「準備すると使えます」を出し分けるのに使う
   */
  vectorUnavailable?: VectorUnavailable;
  /** 競合マーカーがあって読めなかったファイル */
  conflicted: string[];
}

/**
 * 意味検索を使えない理由（設計書6.19.10）。
 *
 * - `disabled` … 設定で「切」（ベクトル検索の準備をしていない）
 * - `noIndex`  … この作品の索引がまだ無い
 * - `stale`    … 索引はあるが、いまの本文の9割に届かない（古い）
 */
export type VectorUnavailable = "disabled" | "noIndex" | "stale";

/**
 * 使えないときの案内。**何をすれば使えるようになるかを1文で**言う。
 *
 * 操作の名前はメニューにある名前のまま書く（言い換えると探しても見つからない）。
 * 「ベクトル検索準備」と「検索索引作成／更新」は、設定管理の
 * `novelai.vectorSearch.enabled` の説明の下のリンクから押せる。
 */
export function vectorSetupHint(
  reason: VectorUnavailable,
  purpose: string
): string {
  if (reason === "disabled") {
    return `ベクトル検索の準備をすると、${purpose}（「ベクトル検索準備」）。`;
  }
  if (reason === "noIndex") {
    return `この作品の検索索引を作ると、${purpose}（「検索索引作成／更新」）。`;
  }
  return `検索索引が本文に追いついていません。更新すると、${purpose}（「検索索引作成／更新」）。`;
}

/** 記録に残す短い理由 */
export function describeVectorUnavailable(reason: VectorUnavailable): string {
  if (reason === "disabled") return "ベクトル検索が切";
  if (reason === "noIndex") return "索引が無い";
  return "索引が本文に追いついていない";
}

/** 案内から押せる操作。理由ごとに行き先が違う */
export function vectorSetupCommand(reason: VectorUnavailable): string {
  return reason === "disabled"
    ? "novelai.setupVectorSearch"
    : "novelai.buildVectorIndex";
}

/**
 * この作品で意味検索が使えるか（索引を開かずに見る、軽い判定）。
 *
 * 公募の並べ替え（`contestSimilarity.ts`）と似た場面の検出が、押す前の
 * 分かれ道に使う。**本文に追いついているか（`stale`）はここでは見ない**——
 * それには全話を読む必要がある。追いつきは索引を開く口（`loadStoredVectors`）で見る。
 */
export async function vectorReadiness(
  work: WorkEntry
): Promise<{ ready: true } | { ready: false; reason: VectorUnavailable }> {
  if (!isVectorSearchEnabled()) return { ready: false, reason: "disabled" };
  if ((await VectorIndex.storedBytes(work)) === 0) {
    return { ready: false, reason: "noIndex" };
  }
  return { ready: true };
}

/**
 * 検知（矛盾・伏線の回収）にもベクトル検索を使うか（設計書6.19.10）。
 *
 * **既定は「切」。** 入れると矛盾検知へ渡す前の話の抜粋が変わり、
 * 抜粋のハッシュを混ぜた鍵が変わるので、処理済みのキャッシュが飛ぶ
 * （有料AIなら費用がかかる）。伏線の回収の確認は照らす箇所を絞るので、
 * 見逃しの危険と引き換えになる。どちらも作者が選んでから動かす。
 */
export function isVectorUseInChecksEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>("vectorSearch.useInChecks", false);
}

/**
 * 保存済みの索引から、ベクトルを引く口を開く（検知・似た場面の検出が使う）。
 *
 * **Ollama を呼ばない。** 索引に既にあるベクトルだけを使う。検知の途中で
 * 埋め込みを取ると、Ollama が落ちている日に検知ごと止まり、同じ本文でも
 * 抜粋が揺れて鍵が変わる。**追いつかせる（索引の更新）のは作者の操作**
 * （「検索索引作成／更新」）か、相談の自動更新に任せる。
 *
 * 渡したハッシュの9割に届かなければ使わない（相談と同じ門。中途半端な
 * 索引は、載っている場面ばかりを上位に出す）。
 */
export async function loadStoredVectors(
  work: WorkEntry,
  hashes: readonly string[]
): Promise<
  | { lookup: VectorLookup; covered: number; total: number }
  | { unavailable: VectorUnavailable }
> {
  if (!isVectorSearchEnabled()) return { unavailable: "disabled" };
  const index = await VectorIndex.load(work, embeddingModelName());
  if (index.size === 0) return { unavailable: "noIndex" };
  const unique = [...new Set(hashes)];
  const covered = unique.filter((hash) => index.has(hash)).length;
  if (unique.length === 0 || covered < unique.length * 0.9) {
    return { unavailable: "stale" };
  }
  return {
    lookup: (hash) => index.get(hash),
    covered,
    total: unique.length,
  };
}

/**
 * 検知（矛盾・伏線の回収）がベクトル検索を使うかどうかと、その索引。
 *
 * - `off`         … 検知には使わない設定（既定）。**これまでと1文字も変わらない**
 * - `on`          … 使う。`lookup` で索引のベクトルを引く
 * - `unavailable` … 使う設定だが、この作品では使えない（理由つき）。
 *                   **検知はこれまでどおり走らせ**、確認の画面で案内だけ出す
 */
export type CheckVectors =
  | { kind: "off" }
  | { kind: "on"; lookup: VectorLookup; covered: number; total: number }
  | { kind: "unavailable"; reason: VectorUnavailable };

export async function openCheckVectors(
  work: WorkEntry,
  hashes: readonly string[]
): Promise<CheckVectors> {
  if (!isVectorUseInChecksEnabled()) return { kind: "off" };
  try {
    const opened = await loadStoredVectors(work, hashes);
    if ("unavailable" in opened) {
      return { kind: "unavailable", reason: opened.unavailable };
    }
    return { kind: "on", ...opened };
  } catch (error) {
    // 索引が読めなくても検知は止めない（索引はいつでも作り直せる）
    logFailure("検知用に索引を開けませんでした（ベクトル検索を使わずに続けます）", {
      理由: error instanceof Error ? error.message : String(error),
    });
    return { kind: "unavailable", reason: "noIndex" };
  }
}

/** 使う設定なのに使えなかったときの、確認の画面の1行。使わない・使えたときは空 */
export function checkVectorsNote(vectors: CheckVectors, purpose: string): string {
  if (vectors.kind !== "unavailable") return "";
  return `（検知にもベクトル検索を使う設定ですが、この作品ではまだ使えません。${vectorSetupHint(
    vectors.reason,
    purpose
  )}）`;
}

export interface MeaningSearchOptions {
  /** 並べる件数 */
  limit: number;
  /** この話数より前の場面だけ（話数の読めない場面は外す） */
  beforeChapter?: number;
  /** 1つの話から1件だけ出す（隣り合う場面が上位を埋めないように） */
  onePerEpisode?: boolean;
  /** これより遠いものは並べない */
  minScore?: number;
}

/**
 * 本文の場面を、文章の**意味の近さだけ**で並べる（執筆再開の関係しそうな場面）。
 *
 * 相談の検索（`search`）は語句一致と交互に詰めるが、単話プロットのように
 * 長くて名前だらけの問いでは、語句一致が名前の多い場面ばかりを拾う。
 * ここは索引が使えるとき（`context.vector`）専用で、使えなければ空を返す。
 */
export async function searchScenesByMeaning(
  context: RetrievalContext,
  query: string,
  options: MeaningSearchOptions
): Promise<Array<{ item: RetrievalItem; score: number }>> {
  if (!context.vector || !query.trim()) return [];
  const [vector] =
    (await embedTexts([query], context.vector.provider)) ?? [];
  if (!vector) return [];

  const pool = context.items.filter(
    (item) =>
      item.source === "本文" &&
      (options.beforeChapter === undefined ||
        (typeof item.chapter === "number" && item.chapter < options.beforeChapter))
  );
  const index = context.vector.index;
  const ranked = rankByNearest([vector], pool, (hash) => index.get(hash), {
    // 1話1件に畳むので、多めに引いてから畳む
    limit: options.onePerEpisode ? options.limit * 20 : options.limit,
    minScore: options.minScore,
  });
  const byId = new Map(pool.map((item) => [item.id, item]));
  const out: Array<{ item: RetrievalItem; score: number }> = [];
  const seenEpisodes = new Set<string>();
  for (const hit of ranked) {
    const item = byId.get(hit.id);
    if (!item) continue;
    if (options.onePerEpisode) {
      if (seenEpisodes.has(item.label)) continue;
      seenEpisodes.add(item.label);
    }
    out.push({ item, score: hit.score });
    if (out.length >= options.limit) break;
  }
  return out;
}

/**
 * 文章をその場で埋め込む（伏線の説明・場面検索の問い・単話プロット）。
 *
 * **失敗したら undefined を返す**（呼ぶ側は意味検索をやめて、これまでの
 * 道へ戻る）。理由はログへ残す。
 */
export async function embedTexts(
  texts: readonly string[],
  provider: EmbeddingProvider = new OllamaEmbeddingProvider()
): Promise<Float32Array[] | undefined> {
  if (texts.length === 0) return [];
  try {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const vectors = await provider.embed(texts.slice(i, i + EMBED_BATCH));
      out.push(...vectors);
    }
    return out.length === texts.length ? out : undefined;
  } catch (error) {
    logFailure("埋め込みに失敗（意味検索を使わずに続けます）", {
      件数: texts.length,
      理由: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
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
  const lexicalOnly = (reason: VectorUnavailable): RetrievalContext => ({
    items: corpus.items,
    bm25,
    vectorUnavailable: reason,
    conflicted: corpus.conflicted,
  });

  if (!isVectorSearchEnabled()) return lexicalOnly("disabled");

  const provider = new OllamaEmbeddingProvider();
  let index = await VectorIndex.load(work, provider.model);

  const missing = corpus.items.filter((item) => !index.has(item.hash));

  // 索引がまだ無いときは、黙って作り始めない。
  // 作品まるごとで実測39秒かかり、非力な機械ではもっとかかる
  if (index.size === 0) return lexicalOnly("noIndex");

  // 書き足したぶんだけ追いつかせる。1話ぶん（12件）で実測0.2秒
  if (missing.length > 0 && autoUpdateEnabled()) {
    try {
      index.setModel(provider.model);
      await embedInto(index, missing, provider);
      index.retainOnly(corpus.items.map((item) => item.hash));
      await index.save(work);
    } catch (error) {
      // **記録の直前に書き先を向ける**（0.43.3 と同じ）
      useLogFile(work.folderPath);
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
  if (covered < corpus.items.length * 0.9) return lexicalOnly("stale");

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
            useLogFile(work.folderPath);
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
