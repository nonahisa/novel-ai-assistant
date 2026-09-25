/**
 * 測っていないモデルに切り替えたら、AIチューニングを一言勧める
 * （設計書6.49.8。作者の判断、2026-09-26）。
 *
 * ## なぜ勧めるのか
 *
 * 測っていないモデルは、安全側の既定（6.65.16）で小さく・遅く動く。
 * 測れば待ち時間も読める長さもそのモデルに合う——ところが作者は、
 * モデルを替えたあとに「測り直す」ことを思い出す手がかりを持たない。
 * 替えたその場がいちばん思い出しやすい。
 *
 * ## しつこくしない
 *
 * - **同じモデルは一度だけ**（押しても押さなくても、二度目は出さない）
 * - **「今後出さない」を置く**
 * - **切り替えたときだけ**出す。起動のたびや、別の機能の割当を変えた
 *   ついでに、前から使っているモデルのことを言わない
 *
 * ## `vscode` に触らない
 *
 * 知らせを出すのは `features/tuningNudge.ts`。ここは「どのモデルについて
 * 言うか」と「何と言うか」だけを決めるので、単体で試せる。
 */

/** いま使われているモデル1つ（どの機能の割当か、または既定か） */
export interface SelectedModel {
  providerId: string;
  model: string;
  /**
   * 測るときに渡す機能の鍵（`novelai.measureContext` の第1引数）。
   * 既定のAIなら `"default"`。
   *
   * **割当先を測らないと、測ったAIと使うAIが別物になる**（6.49.5 の①）。
   */
  feature: string;
}

/** 同じモデルかを見分ける鍵（AIチューニングの台帳と同じ形） */
export function selectedModelKey(selected: {
  providerId: string;
  model: string;
}): string {
  return `${selected.providerId}/${selected.model}`;
}

/**
 * 切り替えのあとで**新しく使われ始めた**モデル。
 *
 * **前から使っていたモデルは返さない。** 誤字脱字の割当を替えたとき、
 * ずっと既定で使っているモデルのことまで言い出すと、切り替えと関係の無い
 * 知らせになる。
 *
 * 同じモデルが複数の機能で使われ始めたら、最初の1つだけを返す
 * （同じことを2度言わない）。
 */
export function newlySelectedModels(
  before: readonly SelectedModel[],
  after: readonly SelectedModel[]
): SelectedModel[] {
  const known = new Set(before.map(selectedModelKey));
  const found: SelectedModel[] = [];
  for (const selected of after) {
    const key = selectedModelKey(selected);
    if (known.has(key)) continue;
    known.add(key);
    found.push(selected);
  }
  return found;
}

/**
 * 勧めるか。
 *
 * @param tuned そのモデルを作者が測ったか（台帳に読める長さの実測があるか）
 * @param shown これまでに勧めたモデルの鍵
 * @param muted 作者が「今後出さない」を押したか
 */
export function shouldNudgeTuning(
  selected: SelectedModel,
  state: { tuned: boolean; shown: ReadonlySet<string>; muted: boolean }
): boolean {
  if (state.muted) return false;
  if (state.tuned) return false;
  return !state.shown.has(selectedModelKey(selected));
}

/** 知らせのボタン。**画面の言葉とテストで同じものを見る** */
export const NUDGE_MEASURE_LABEL = "AIチューニングで測る";
export const NUDGE_MUTE_LABEL = "今後出さない";

/**
 * 知らせの文。
 *
 * **有料のAIでは、測ると料金がかかることを添える**（作者の判断）。
 * 測る側（6.49.4）の断りと同じく、**判定が無いときに「無料」へは
 * 倒さない**——`isPaid` が分からなければ「有料のAIでは」と条件つきで添える。
 */
export function nudgeTuningMessage(params: {
  providerName: string;
  model: string;
  /** 有料か。**分からなければ `undefined`**（無料とみなさない） */
  isPaid: boolean | undefined;
}): string {
  const lines = [
    `${params.providerName}（${params.model}）はまだ測っていません。` +
      "AIチューニングで測ると、待ち時間や読める長さがこのモデルに合います。",
  ];
  if (params.isPaid === true) {
    lines.push(
      `${params.providerName} は有料です。測るとAIを何回か呼ぶので、その回数ぶん料金がかかります。`
    );
  } else if (params.isPaid === undefined) {
    lines.push(
      "測るとAIを何回か呼びます。有料のAIでは、その回数ぶん料金がかかります。"
    );
  }
  return lines.join("\n");
}
