import { bestSimilarity } from "./semanticRank";

/**
 * 伏線の回収の確認で、照らす箇所を意味の近さで絞る（設計書6.19.10）。
 *
 * これまでは、未回収の伏線を**張った話より後のすべての箇所**へ掛けていた
 * （`foreshadowTargets.ts`）。話数が多い作品では、1つの伏線のために
 * 数百か所を読ませることになる。ベクトル検索の索引があるときは、
 * 伏線ごとに**意味の近い箇所の上位だけ**へ掛ける。
 *
 * ## 分からないものは絞らない
 *
 * - 伏線のベクトルが取れなかった（埋め込みに失敗した）→ その伏線は全箇所へ
 * - 箇所の場面が索引に載っていない（書き足した直後など）→ その箇所は絞らない
 *
 * 測れないものを落とすと、確かめもせずに回収を見逃す。落としてよいのは、
 * 近さを測ったうえで上位に入らなかった組だけ。
 *
 * VS Code API に依らない。
 */

export interface RelevanceEntry<T extends { id: string }> {
  /** 箇所の名前（キャッシュの鍵・記録に使う） */
  key: string;
  /** これまでの規則（張った話より後）で掛かる伏線 */
  targets: readonly T[];
  /** その箇所に入っている場面のベクトル（索引から引いたもの）。無ければ空 */
  vectors: readonly Float32Array[];
}

export interface NarrowedEntry<T extends { id: string }> {
  key: string;
  targets: T[];
  /** 1件でも落としたか。**落としたら鍵を分ける**（全部掛けた答えと混ぜない） */
  narrowed: boolean;
}

/**
 * 伏線ごとに、近い箇所の上位 `keepPerForeshadow` 件へだけ掛ける。
 *
 * 近さが同じなら、もとの並び（話の早い順）で先のものを残す。
 * 並びは変えない——回収は「話の早いほうから見て先に見つかったもの」を
 * 採る決まりがある（`checkForeshadows.ts`）。
 */
export function narrowTargetsByMeaning<T extends { id: string }>(
  entries: readonly RelevanceEntry<T>[],
  foreshadowVectors: ReadonlyMap<string, Float32Array>,
  keepPerForeshadow: number,
  /**
   * 近さに関わらず必ず残す組（上位の数には数えない）。
   *
   * **張った話そのもの**に使う。張った箇所は伏線の文そのものを含むので、
   * 近さで並べると必ず1位に来て、上位の枠を1つ食う（実測：回収済み4件の
   * うち3件で、回収の話が2位だった）。同じ話での回収もありうるので落とさず、
   * 枠の外で残す。
   */
  keepAlways?: (target: T, key: string) => boolean
): NarrowedEntry<T>[] {
  const kept = new Map<string, Set<string>>();
  for (const [id, vector] of foreshadowVectors) {
    const scored: Array<{ key: string; score: number; order: number }> = [];
    entries.forEach((entry, order) => {
      if (entry.vectors.length === 0) return;
      const target = entry.targets.find((candidate) => candidate.id === id);
      if (!target) return;
      if (keepAlways?.(target, entry.key)) return;
      const score = bestSimilarity(entry.vectors, vector);
      if (score === undefined) return;
      scored.push({ key: entry.key, score, order });
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    kept.set(
      id,
      new Set(scored.slice(0, Math.max(0, keepPerForeshadow)).map((entry) => entry.key))
    );
  }

  return entries.map((entry) => {
    if (entry.vectors.length === 0) {
      return { key: entry.key, targets: [...entry.targets], narrowed: false };
    }
    const targets = entry.targets.filter((target) => {
      if (keepAlways?.(target, entry.key)) return true;
      const keys = kept.get(target.id);
      // ベクトルの無い伏線は測れないので残す
      return keys === undefined || keys.has(entry.key);
    });
    return {
      key: entry.key,
      targets,
      narrowed: targets.length < entry.targets.length,
    };
  });
}

/**
 * 伏線を埋め込むときの文。名・何を示唆しているか・張った箇所の引用を
 * つなぐ（空の項目は飛ばす）。**回収の場面は、引用の言葉そのものより
 * 「何が明かされるか」に近い**ので、示唆（note）を落とさない。
 */
export function foreshadowQueryText(record: {
  label: string;
  note: string;
  plantedQuote: string;
}): string {
  return [record.label, record.note, record.plantedQuote]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n");
}
