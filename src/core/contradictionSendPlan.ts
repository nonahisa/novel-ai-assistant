/**
 * 矛盾検知の「送る予定の一覧」（2026-09-23）。
 *
 * ## なぜ一覧で決めるか
 *
 * 矛盾検知は1つの区切りについてAIを2回呼ぶ——本命（設定資料との突き合わせ）と、
 * 「あとで判明する事実」との突き合わせ（設計書6.10.4）。2つは**別のキャッシュ**
 * を持つので、本命が処理済みでも2回目だけが残っていることがある（前回、2回目の
 * 途中で中止したときなど）。
 *
 * 確認を出すかどうかを「処理済みでない本命の件数」で決めていたので、その状態では
 * **確認も同意も出さないまま2回目を送っていた**。クラウドの「まるごと読む」では
 * 本文がまるごと外へ出るのに、同意を取らなかったことになる。
 *
 * 作者の決まり（2026-09-23）：**AIをまとめて呼ぶ前には必ず確認を出す。
 * 確認を通らずに送る道があってはならない。** そこで、確認を出すかどうかも、
 * 確認に出す件数・量も、**実際に送る呼び出しの一覧**1つから数える。
 *
 * VS Code API に依存しない（組み立て方と処理済みかどうかは呼ぶ側が渡す）。
 */

import { sumPlannedSends, type PlannedSend, type PlannedSendTotal } from "./sendVolume";

/** 呼ぶ側が答える問い。送るときと同じ判定を渡すこと */
export interface ContradictionSendProbe<C> {
  /** 本命の答えが処理済み（キャッシュにある）か */
  settledCached(chunk: C): boolean;
  /** 「あとで判明する事実」との突き合わせの答えが処理済みか */
  futureCached(chunk: C): boolean;
  /**
   * 本命で送る字数（指示＋組んだプロンプト）。**送らない**（照らし合わせる
   * 相手が無い）なら undefined
   */
  settledChars(chunk: C): number | undefined;
  /** 2回目で送る字数。事実が無いなどで送らないなら undefined */
  futureChars(chunk: C): number | undefined;
}

export interface ContradictionSendPlan<C> {
  /** 本命を送る区切り */
  readonly settled: readonly C[];
  /** 2回目を送る区切り */
  readonly future: readonly C[];
  /** 送る呼び出しそのもの（本命→2回目の順） */
  readonly sends: readonly PlannedSend[];
  /** 送る量の合計。**確認に出す量はここから** */
  readonly total: PlannedSendTotal;
  /** 1回でも送る区切りの数（重ねずに） */
  readonly chunkCount: number;
  /** 1回でも送る区切りの本文の字数（重ねずに） */
  readonly distinctBodyChars: number;
}

/**
 * 送る予定の一覧を作る。
 *
 * 2回目は実行の輪と同じ条件で積む——本命が送られるか処理済みの区切りで、
 * 2回目がまだ処理済みでないもの。本命が失敗すれば2回目は送らないので、
 * 実際はこれ以下になる（上限寄り）。
 *
 * **同じ本文の区切りは1度だけ積む。** キャッシュの鍵は本文のハッシュなので、
 * 2つ目は1つ目の答えを引き、送らない。
 */
export function planContradictionSends<C extends { hash: string; text: string }>(
  chunks: readonly C[],
  probe: ContradictionSendProbe<C>
): ContradictionSendPlan<C> {
  const settled: C[] = [];
  const future: C[] = [];
  const settledSends: PlannedSend[] = [];
  const futureSends: PlannedSend[] = [];
  const seen = new Set<string>();
  const sentChunks = new Map<string, C>();

  for (const chunk of chunks) {
    if (seen.has(chunk.hash)) continue;
    seen.add(chunk.hash);

    if (!probe.settledCached(chunk)) {
      const chars = probe.settledChars(chunk);
      // 本命を送らない区切りは、2回目も送らない（輪の中で本命の答えが
      // 無ければ、2回目へ進まない）
      if (chars === undefined) continue;
      settled.push(chunk);
      settledSends.push({ chars, bodyChars: chunk.text.length });
      sentChunks.set(chunk.hash, chunk);
    }
    if (probe.futureCached(chunk)) continue;
    const chars = probe.futureChars(chunk);
    if (chars === undefined) continue;
    future.push(chunk);
    futureSends.push({ chars, bodyChars: chunk.text.length });
    sentChunks.set(chunk.hash, chunk);
  }

  const sends = [...settledSends, ...futureSends];
  let distinctBodyChars = 0;
  for (const chunk of sentChunks.values()) distinctBodyChars += chunk.text.length;
  return {
    settled,
    future,
    sends,
    total: sumPlannedSends(sends),
    chunkCount: sentChunks.size,
    distinctBodyChars,
  };
}

/**
 * 確認（クラウドでまるごと読むなら同意）を出さなければならないか。
 *
 * **送る呼び出しが1つでもあれば出す。** 本命の件数では決めない（本命が
 * 処理済みでも、2回目や検証が残っていれば送る）。
 *
 * @param pendingVerifies 処理済みの指摘のうち、検証（1件ずつの問い直し）が
 *   まだのものの数。本文を読む段を1回も送らなくても、検証は送る
 */
export function mustConfirmBeforeSending(
  plan: { readonly sends: readonly unknown[] },
  pendingVerifies = 0
): boolean {
  return plan.sends.length > 0 || pendingVerifies > 0;
}
