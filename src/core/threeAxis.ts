/**
 * 3軸で測って、主軸と副軸から名前を決める仕掛け（設計書6.86・6.91の共通部分）。
 *
 * ## なぜ切り出したか
 *
 * 助言方針（6.86、作者を測る）とターゲット読者（6.91、読者を測る）は、
 * **測るものが違うだけで、測り方は同じ**である——3つの軸に各3問、
 * 各問0〜2点、合計0〜6点、段階は低・中・高。いちばん強い軸を主軸、
 * 次に強い「中以上」の軸を副軸にして、その組み合わせで名前が決まる。
 *
 * **写しを作らない。** 同じ計算を2か所に置くと、片方だけ直る日が来る。
 * この作品では `termColors.ts`（用語の色）で同じ判断をしている。
 *
 * ## 何をここへ置かないか
 *
 * **軸の名前・質問・タイプの一覧は、呼ぶ側が持つ。** ここが持つのは
 * 「点数から段階を出す」「軸を強い順に並べる」だけである。
 * 名前の表をここへ持ち込むと、作者のタイプと読者のタイプが
 * 同じファイルに並び、どちらを直しているのか分からなくなる。
 *
 * VS Code APIに依存しない。
 */

/** 各軸の段階 */
export type ThreeAxisLevel = "low" | "mid" | "high";

/** 段階の重み（比べるためだけの数） */
const LEVEL_RANK: Record<ThreeAxisLevel, number> = { low: 0, mid: 1, high: 2 };

/**
 * 合計点から段階を決める。
 *
 * 診断の答えは整数（0〜1＝低、2〜4＝中、5〜6＝高）だが、**推定で動いたあとは
 * 小数になる**（±0.5ずつ）。境界を `< 2` と `>= 5` で書けば、整数のときは
 * これまでと同じ結果になり、小数も同じ物差しで測れる。
 */
export function threeAxisLevel(score: number): ThreeAxisLevel {
  if (score < 2) return "low";
  if (score < 5) return "mid";
  return "high";
}

/**
 * 名前を決めた軸。
 *
 * **診断の紙が「なぜその名前になったか」を出すのに要る**——名前だけでは、
 * 当たっているかを作者が確かめようがない。
 *
 * 3軸が同じ帯にあるとき（全低・全中）は、どれか一つを主とは呼ばない。
 * 差が無いのに選ばれただけの軸を「主軸」と呼ぶことになるからである。
 * そのときの名前は軸の強弱から来ていないので、呼ぶ側が別に決める。
 */
export interface ThreeAxisPick<A extends string> {
  main?: A;
  sub?: A;
}

/**
 * 軸を強い順に見て、主軸と副軸を決める。
 *
 * @param order 軸を見る順。**同点のときは、この順で先にあるものを主軸にする。**
 *   順を決めておかないと、同じ答えから違うタイプが出る。
 */
export function pickThreeAxes<A extends string>(
  order: readonly A[],
  scores: Readonly<Record<A, number>>
): ThreeAxisPick<A> {
  const levels = order.map((axis) => threeAxisLevel(scores[axis]));
  if (levels.every((level) => level === "low")) return {};
  if (levels.every((level) => level === "mid")) return {};

  // (段階, 点数) が最大のものを主軸にする。同点なら order の先のもの
  const ranked = [...order].sort((a, b) => compareAxis(order, scores, b, a));
  return {
    main: ranked[0],
    // 副軸は「残りのうち段階が中以上」で最大のもの。無ければ「なし」
    sub: ranked
      .slice(1)
      .find((axis) => threeAxisLevel(scores[axis]) !== "low"),
  };
}

/** 3軸がどれも同じ帯にあるか。名前が軸の強弱から来ないときの見分け */
export function threeAxisFlat<A extends string>(
  order: readonly A[],
  scores: Readonly<Record<A, number>>
): "low" | "mid" | null {
  const levels = order.map((axis) => threeAxisLevel(scores[axis]));
  if (levels.every((level) => level === "low")) return "low";
  if (levels.every((level) => level === "mid")) return "mid";
  return null;
}

/** 軸の強さを比べる。正なら a のほうが強い */
function compareAxis<A extends string>(
  order: readonly A[],
  scores: Readonly<Record<A, number>>,
  a: A,
  b: A
): number {
  const byLevel =
    LEVEL_RANK[threeAxisLevel(scores[a])] - LEVEL_RANK[threeAxisLevel(scores[b])];
  if (byLevel !== 0) return byLevel;
  const byScore = scores[a] - scores[b];
  if (byScore !== 0) return byScore;
  // 同点は order の先にあるほうを強いとみなす（並びを一意にするため）
  return order.indexOf(b) - order.indexOf(a);
}

/** 1問ぶんの選択肢 */
export interface ThreeAxisChoice {
  /** 選択肢の文言。そのまま画面に出す */
  label: string;
  /** 0〜2点 */
  score: number;
}

/** 1問 */
export interface ThreeAxisQuestion<A extends string> {
  /** X1・Y2 のような呼び名。答えの並びを人が読み解くときの手掛かり */
  id: string;
  axis: A;
  text: string;
  /** 0点・1点・2点の順に並べる（画面の並びもこのまま） */
  choices: ThreeAxisChoice[];
}

/**
 * 答えを軸ごとに合計する。**足りない答えは0点として扱う。**
 *
 * 途中でやめた人の答えも、そこまでの分で判定できる。
 */
export function scoreThreeAxisAnswers<A extends string>(
  order: readonly A[],
  questions: readonly ThreeAxisQuestion<A>[],
  answers: readonly number[]
): Record<A, number> {
  const scores = {} as Record<A, number>;
  for (const axis of order) scores[axis] = 0;
  questions.forEach((question, index) => {
    const answer = answers[index];
    if (typeof answer !== "number") return;
    const choice = question.choices[answer];
    if (!choice) return;
    scores[question.axis] += choice.score;
  });
  return scores;
}
