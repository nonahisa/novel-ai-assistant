/**
 * 拒否された指定を外して試すときの、試す順の組み立て。
 *
 * クラウドAIは「どの指定が悪いのか」を教えてくれない。
 * GeminiもAnthropicも本文からは特定できないため、外して試すしかない。
 *
 * **まず1つずつ外す。** 以前は積み上げ式（1つ外して駄目ならもう1つ足して外す）
 * だったため、原因が最後の1つでも、先に外した指定まで
 * 「非対応」として記憶に残った。Claudeで実際に起き、
 * 原因はスキーマ1つだったのに、思考の無効化と推論の深さまで失った状態になった。
 *
 * 1つずつ試せば、原因が1つのときは犯人だけを覚えられる。
 * どれを外しても直らないときだけ、まとめて外した組み合わせを試す。
 * 呼び出し回数は積み上げ式とほぼ同じで、失うものが少ない。
 */

export interface OptionAttempt<K extends string> {
  support: Record<K, boolean>;
  /** この試行で外した指定。空なら全部付けたまま */
  dropped: K[];
}

export function buildAttemptPlan<K extends string>(
  support: Record<K, boolean>,
  /**
   * この呼び出しで実際に送る指定だけを、外す順に渡す。
   * 送ってもいない指定を「非対応」と覚えると、次に必要になったとき失う。
   */
  applicable: K[]
): Array<OptionAttempt<K>> {
  const active = applicable.filter((key) => support[key]);
  const plan: Array<OptionAttempt<K>> = [
    { support: { ...support }, dropped: [] },
  ];

  for (const key of active) {
    const next = { ...support };
    next[key] = false;
    plan.push({ support: next, dropped: [key] });
  }

  if (active.length > 1) {
    const minimal = { ...support };
    for (const key of active) minimal[key] = false;
    plan.push({ support: minimal, dropped: [...active] });
  }

  return plan;
}
