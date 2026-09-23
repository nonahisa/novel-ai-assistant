// ログの書き先：呼ぶ側が向ける（完成予定から選ぶ・AIの提案が、作品のログへ向けてから呼ぶ）
import type { WorkEntry } from "../models/types";
import { VectorIndex } from "../core/vectorIndex";
import { contestMatchText, hasWorkProfile, workProfileText, type WorkProfile } from "../core/contestMatchText";
import type { StoredContest } from "../core/contestInbox";
import { logFailure } from "../core/logger";
import { OllamaEmbeddingProvider } from "../ai/ollamaEmbedding";
import type { EmbeddingProvider } from "../ai/embeddingProvider";
import { vectorReadiness } from "./vectorSearch";

/**
 * 作品に近い順に公募を並べる（設計書6.3.6.4。作者の選択）。
 *
 * 作品の概要（プロット・紹介文）と、公募の募集内容の文を埋め込み、近さ
 * （コサイン類似度）で並べる。**相談で使っているベクトル検索の部品をそのまま
 * 使う**（埋め込みは `OllamaEmbeddingProvider`、近さの計算は `VectorIndex.search`）。
 * 部品そのものは作り替えない（別の担当があとで広げる）。
 *
 * ## いつ使うか
 *
 * **作者がこの作品でベクトル検索の準備を済ませているときだけ**（設定が入で、
 * 索引が作られている）。済んでいなければ使わずに並べ、画面で「準備をすると
 * 作品に近い順にも並べられます」と案内する。黙って埋め込みのモデルを呼ばない
 * ——準備の済んでいない機械では、Ollama が無いか、モデルが入っていない。
 *
 * 公募の埋め込みは**覚えない**（その場で数十件を埋め込むだけ。手元で数秒）。
 * 作品の索引には混ぜない（作品の本文の索引に他人の文を入れない）。
 */

export type SimilarityReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: "disabled" | "noIndex" | "noProfile" };

/** この作品で、近さで並べられるか */
export async function similarityReadiness(
  work: WorkEntry,
  profile: WorkProfile
): Promise<SimilarityReadiness> {
  // 使えるかの判定は共通の口に任せる（設計書6.19.10。判定を写さない）
  const readiness = await vectorReadiness(work);
  if (!readiness.ready) {
    return { ready: false, reason: readiness.reason === "disabled" ? "disabled" : "noIndex" };
  }
  if (!hasWorkProfile(profile)) return { ready: false, reason: "noProfile" };
  return { ready: true };
}

/** 準備ができていないときの案内（画面に出す） */
export function similarityGuide(readiness: SimilarityReadiness): string {
  if (readiness.ready) return "";
  if (readiness.reason === "noProfile") {
    return "プロットのジャンル・ログライン・あらすじか、作品紹介文を書くと、作品に近い順にも並べられます。";
  }
  return "ベクトル検索の準備をすると、作品に近い順にも並べられます。";
}

/**
 * 公募ごとの近さ（-1〜1。大きいほど近い）。**埋め込みに失敗したら undefined**
 * （並べ替えをやめるだけで、選ぶ画面は止めない）。
 */
export async function scoreContestsByWork(
  profile: WorkProfile,
  contests: readonly StoredContest[],
  provider: EmbeddingProvider = new OllamaEmbeddingProvider()
): Promise<Map<StoredContest, number> | undefined> {
  if (contests.length === 0) return new Map();
  try {
    const [workVector, ...contestVectors] = await provider.embed([
      workProfileText(profile),
      ...contests.map(contestMatchText),
    ]);
    if (!workVector) return undefined;
    // 近さの計算は索引の部品に任せる（計算を写さない）。鍵は並びの番号
    const index = VectorIndex.empty();
    contestVectors.forEach((vector, position) => {
      if (vector) index.set(String(position), vector);
    });
    const ranked = index.search(
      workVector,
      contests.map((_, position) => ({ id: String(position), hash: String(position) })),
      contests.length
    );
    const scores = new Map<StoredContest, number>();
    for (const entry of ranked) scores.set(contests[Number(entry.id)], entry.score);
    return scores;
  } catch (error) {
    logFailure("公募の近さを測れませんでした（締切の順のまま並べます）", {
      件数: contests.length,
      理由: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
