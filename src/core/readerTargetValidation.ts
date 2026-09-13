import {
  evidenceSegments,
  normalizeForComparison,
} from "./groundedEvidence";
import { READER_AXIS_ORDER, READER_AXIS_LABELS } from "./readerTarget";
import type {
  ReaderAxis,
  ReaderEvidence,
  ReaderScores,
} from "../models/readerProfile";

/**
 * P-38 の答えを検算する（設計書6.91）。
 *
 * **AIの出力を信用しない**（CLAUDE.mdの実装ルール3）。ここで見るのは3つ。
 *
 * 1. **点数が0〜6の整数か。** 範囲の外や小数が入ると、段階の判定が壊れて
 *    どのタイプにも当てはまらない結果が出る
 * 2. **根拠が本当に本文にあるか。** 引き写しと言っておいて要約を書くのは、
 *    この作品で繰り返し起きている（実装ルール3）。実在しない引用を
 *    添えた軸は、**点数ごと捨てる**——根拠が作り物なら、点数も作り物である
 * 3. **軸が3つ揃っているか。** 欠けた軸は「どちらとも言えない」の3点に置く
 *
 * **捨てた軸は黙って埋めない。** 何を測れなかったかを返し、
 * 呼ぶ側が作者に伝えられるようにする（「黙って書き換えたことにしない」）。
 *
 * VS Code APIに依存しない。
 */

/** 材料が足りない軸に置く点数。どちらとも言えない位置 */
export const READER_NEUTRAL_SCORE = 3;

export interface ReaderTargetReading {
  scores: ReaderScores;
  evidence: ReaderEvidence[];
  /** 測れなかった軸の呼び名（「読み慣れ」）。**黙って埋めない** */
  unmeasured: string[];
  /** 捨てた理由。作者向けではなく、ログと開発のための記録 */
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 引用が材料の中に実在するか。
 *
 * `groundedEvidence.ts` と同じ物差しを使う（表記の揺れを落としてから
 * 逐語で探す）。**写しを作らない**——照合の甘さが2か所でずれると、
 * 片方だけが捏造を通す。
 */
export function quoteAppearsIn(quote: string, sources: string): boolean {
  const haystack = normalizeForComparison(sources);
  if (!haystack) return false;
  const segments = evidenceSegments(quote);
  if (segments.length === 0) {
    // 句読点で割れない短い引用は、そのまま照合する
    const whole = normalizeForComparison(quote);
    return whole.length > 0 && haystack.includes(whole);
  }
  return segments.some((segment) => haystack.includes(segment));
}

/**
 * 答えを読み解く。
 *
 * @param sources AIへ渡した材料をぜんぶ繋いだもの。引用の照合に使う
 */
export function parseReaderTargetReading(
  raw: unknown,
  sources: string
): ReaderTargetReading {
  const notes: string[] = [];
  const scores = {} as ReaderScores;
  const evidence: ReaderEvidence[] = [];
  const measured = new Set<ReaderAxis>();

  const entries = isRecord(raw) && Array.isArray(raw.axes) ? raw.axes : [];
  if (entries.length === 0) notes.push("軸が1つも返りませんでした。");

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const axis = entry.axis;
    if (
      typeof axis !== "string" ||
      !(READER_AXIS_ORDER as readonly string[]).includes(axis)
    ) {
      notes.push(`知らない軸「${String(axis)}」を捨てました。`);
      continue;
    }
    const key = axis as ReaderAxis;
    if (measured.has(key)) {
      notes.push(`${READER_AXIS_LABELS[key]}が2回返ったので、後のほうを捨てました。`);
      continue;
    }

    const score = entry.score;
    if (
      typeof score !== "number" ||
      !Number.isInteger(score) ||
      score < 0 ||
      score > 6
    ) {
      notes.push(
        `${READER_AXIS_LABELS[key]}の点数が0〜6の整数ではありません（${String(score)}）。`
      );
      continue;
    }

    // **根拠を付けてきたなら、それが本物かを見る。**
    // 空のまま返すのは許してある（材料が足りない軸の答え方として指示した）
    const given = Array.isArray(entry.evidence) ? entry.evidence : [];
    const kept: ReaderEvidence[] = [];
    let fabricated = false;
    for (const item of given) {
      if (!isRecord(item)) continue;
      const quote = typeof item.quote === "string" ? item.quote.trim() : "";
      if (!quote) continue;
      if (!quoteAppearsIn(quote, sources)) {
        fabricated = true;
        continue;
      }
      kept.push({
        axis: key,
        quote,
        from: typeof item.from === "string" ? item.from : "",
      });
    }

    if (fabricated && kept.length === 0) {
      // 根拠が作り物なら、点数も作り物である
      notes.push(
        `${READER_AXIS_LABELS[key]}の根拠が本文に見つからないので、点数ごと捨てました。`
      );
      continue;
    }
    if (fabricated) {
      notes.push(
        `${READER_AXIS_LABELS[key]}の根拠のうち、本文に無いものを捨てました。`
      );
    }

    scores[key] = score;
    evidence.push(...kept);
    measured.add(key);
  }

  const unmeasured: string[] = [];
  for (const axis of READER_AXIS_ORDER) {
    if (measured.has(axis)) continue;
    scores[axis] = READER_NEUTRAL_SCORE;
    unmeasured.push(READER_AXIS_LABELS[axis]);
  }

  return { scores, evidence, unmeasured, notes };
}

/**
 * 読み取りを使ってよいか。
 *
 * **3軸とも測れなかったら使わない。** どれも「どちらとも言えない」の
 * 3点では、宣言とのズレが必ず出なくなる（宣言が中ほどなら0、
 * 端なら必ず3のズレ）。当てにならない比較を見せるより、
 * 「読み取れませんでした」と言うほうがよい。
 */
export function isReadingUsable(reading: ReaderTargetReading): boolean {
  return reading.unmeasured.length < READER_AXIS_ORDER.length;
}
