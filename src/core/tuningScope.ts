/**
 * AIチューニングで「何を測るか」（設計書6.27.11・6.61）。
 *
 * **2つを続けて測ると、遅いモデルでは1時間以上かかる**（作者の実機、
 * 2026-09-13。qwen3.8:latest・qwen3:8b）。読める長さは数分で終わるのに、
 * 書ける長さのほうが桁違いに長い——しかも**遅いモデルほど時間切れになる**
 * ので、そういうモデルでは必ず「時間切れあり」の印が付き、その値は1回の
 * 応答の上限としては使わない（`core/modelTuning.ts` の
 * `outputMeasureTimedOut`）。読める長さだけ知りたい作者を、1時間付き合わせて
 * いた。
 *
 * **分けるだけで、測り方は何も変えない。** ここは「どちらを走らせるか」と
 * 「選ぶ画面に並べる言葉」だけを持つ純粋な部品で、送る・数えるは
 * `features/measureContext.ts` にある。
 */

/** どこまで測るか */
export type TuningScope =
  /** 読める長さと待ち時間だけ（数分） */
  | "input"
  /** 1回に書ける長さだけ（長い。手元のAIのみ） */
  | "output"
  /** これまでと同じく、両方を続けて */
  | "both";

/** 選ぶ画面に並べる1項目 */
export interface TuningScopeChoice {
  readonly scope: TuningScope;
  readonly label: string;
  /**
   * 選ぶのに要ることだけを書く（作者の指定、2026-09-13）。
   *
   * **どれも時間の目安から書き出す。** 今回の困りごとは「どれだけ待たされる
   * のか分からないまま始まる」ことだったので、そこを先頭に置く。
   * 画面にそのまま出るプレーンテキストなので、記号は混ぜない
   * （`test/unit/plainTextUi.test.ts`）。
   */
  readonly detail: string;
}

export const TUNING_SCOPE_CHOICES: readonly TuningScopeChoice[] = [
  {
    scope: "input",
    label: "読める長さだけ測る",
    detail:
      "数分で終わります。1回に読める長さと、必要な待ち時間を測ります。",
  },
  {
    scope: "output",
    label: "書ける長さだけ測る",
    detail:
      "時間がかかります（遅いモデルでは1時間以上）。手元のAI（Ollama・LM Studio）だけが対象です。",
  },
  {
    scope: "both",
    label: "両方まとめて測る",
    detail:
      "これまでと同じです。読める長さのあとに書ける長さを測るので、合わせて1時間以上かかることがあります。",
  },
];

/** その回に、読める長さ（と待ち時間）を測るか */
export function measuresInput(scope: TuningScope): boolean {
  return scope !== "output";
}

/** その回に、1回に書ける長さを測るか */
export function measuresOutput(scope: TuningScope): boolean {
  return scope !== "input";
}

/**
 * 記録に書く「何を測ったか」。
 *
 * **選ぶ画面の言葉をそのまま使う。** 別の言い回しを起こすと、作者が
 * 押した項目と記録の行が結びつかない（片方だけ直したときにずれる）。
 */
export function describeTuningScope(scope: TuningScope): string {
  return (
    TUNING_SCOPE_CHOICES.find((choice) => choice.scope === scope)?.label ??
    scope
  );
}
