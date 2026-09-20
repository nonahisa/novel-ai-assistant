/**
 * 「あとどれくらいかかるか」の見当（設計書6.8.19）。
 *
 * ## なぜ要るか（作者の指摘、2026-09-20）
 *
 * 219話の作品に矛盾検知を掛けると**6時間規模**になる。ところが押す前に
 * 画面へ出ていたのは「210チャンク中 208件を処理します」だけで、**それが
 * 10分なのか6時間なのかはどこにも出ていなかった。** 走り出したあとも
 * ステータスバーは「42/210」だけである。
 *
 * 作者が決めたいのは「夜に回すか、いま回すか」であって、正確な秒数では
 * ない。**だから粒度は粗くてよく、代わりに当てずっぽうを書かない。**
 *
 * ## 出どころは2つ
 *
 * 1. **走っている最中**……済んだぶんの平均に、残りの件数を掛ける。
 *    実測なので、これがいちばん当たる
 * 2. **押す前**……速さの台帳（`core/modelTuning.ts` の
 *    `outputTokensPerSecond`）と、機能ごとの出力量の実測
 *    （`core/featureOutputTokens.ts`）から見積もる。**どちらかが
 *    無ければ数字を作らない**——見当が付かないことを、そのまま言う
 *
 * VS Code API に依存しない（台帳を読むのは呼び出し側＝`views/progress.ts`）。
 */

/**
 * 残りの見当を出し始めるまでの件数。
 *
 * **1件では、たまたま速かった回と区別が付かない。** 立ち上がりの遅れ
 * （モデルの読み込みなど）も1件目に丸ごと乗るので、そのまま残り208件へ
 * 掛けると何時間もずれる。3件あれば均されるうえ、実行前の案内で
 * 「数チャンク進んだところで目安を出します」と断った約束にも合う。
 */
export const MIN_ETA_SAMPLES = 3;

/**
 * 所要時間を、作者が読んで判断できる粒度で言う。
 *
 * **秒は出さない。** 「4時間28分53秒」は正確だが、そこまで細かい数字は
 * 判断の材料にならないうえ、1件進むたびに数字が踊って落ち着かない。
 *
 * 丸め方は長さで変える——短いうちは1分刻み、1時間を超えたら30分刻み。
 * 残り6時間のときに「5時間58分」と出しても、「およそ6時間」以上のことは
 * 何も言っていない。
 */
export function describeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "1分未満";

  const raw = ms / 60_000;
  let minutes: number;
  if (raw < 10) {
    // 短いときだけ1分刻み。**0分にはしない**（「およそ0分」は無意味）
    minutes = Math.max(1, Math.round(raw));
  } else if (raw < 60) {
    minutes = Math.round(raw / 5) * 5;
  } else {
    minutes = Math.round(raw / 30) * 30;
  }

  // 丸めで60分へ届いたら時間へ繰り上げる（「およそ60分」とは言わない）
  if (minutes < 60) return `およそ${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `およそ${hours}時間` : `およそ${hours}時間${rest}分`;
}

/**
 * 済んだぶんの平均から、残りの所要時間を見積もる。
 *
 * **数字を作れないときは undefined を返す。** 呼び出し側はそれを
 * 「まだ言えない」と読んで、何も添えない。
 *
 * @param done これまでに終わった件数
 * @param total 全体の件数
 * @param elapsedMs 始めてからここまでの実時間
 */
export function estimateRemainingMs(
  done: number,
  total: number,
  elapsedMs: number
): number | undefined {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;
  if (done < MIN_ETA_SAMPLES) return undefined;
  if (total <= done) return undefined;
  return (elapsedMs / done) * (total - done);
}

/**
 * 押す前の見積もり（トークン/秒 × 1回に書く量）。
 *
 * **どちらかが欠けたら undefined。** ここで既定値を置くと、測っていない
 * モデルにも数字が出てしまい、**当てずっぽうが実測の顔をして並ぶ。**
 *
 * @param count これからAIへ送る件数
 * @param outputTokensPerSecond そのモデルの出力の速さ（台帳の実測）
 * @param outputTokensPerCall その機能が1回に書くトークン数（実測の最大）
 */
export function estimateRunMs(
  count: number,
  outputTokensPerSecond: number | undefined,
  outputTokensPerCall: number | undefined
): number | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  if (
    outputTokensPerSecond === undefined ||
    !Number.isFinite(outputTokensPerSecond) ||
    outputTokensPerSecond <= 0
  ) {
    return undefined;
  }
  if (
    outputTokensPerCall === undefined ||
    !Number.isFinite(outputTokensPerCall) ||
    outputTokensPerCall <= 0
  ) {
    return undefined;
  }
  return (outputTokensPerCall / outputTokensPerSecond) * count * 1000;
}

/**
 * 見積もりに使った、1回あたりの出力量の出どころ。
 *
 * **「同梱かどうか」ではなく「最大か平均か」で分ける**（0.71.5）。
 * 0.71.4 では同梱かどうかで名乗りを分けたが、**台帳の最大も同じだけ
 * 過大**なので、線を引く場所が違っていた。
 */
export type RunTimeEstimateBasis =
  /** この機械の実測の**平均**。普段の量なので、そのまま読んでよい */
  | "average"
  /** この機械の実測の**最大**。実測ではあるが、必ず多めに出る */
  | "max"
  /** 同梱の表の**最大**（`core/bundledTuning.ts`）。この機械では測っていない */
  | "bundled-max";

/**
 * 押す前の見積もりを、**出どころつきで**言う（実装ルール6の例外条件3）。
 *
 * **2026-09-21、実機で外した。** プロット逸脱を10話に掛けると
 * 「10件 ≒ およそ15分（**これまでの実測から**）」と出たが、**実際は39秒**
 * だった。作者が「15分なら夜に回そう」と判断してもおかしくない差である。
 *
 * **数字が嘘だったのではない。** 1回あたりの出力量は「切り詰められていない
 * 回の実測の**最大**」だった。**容量の見積もりには最大が正しい**——足りな
 * ければ落ちるのだから。**だが所要時間に最大を使えば、必ず過大になる。**
 *
 * 0.71.5 で、台帳が平均も覚えるようにした（`core/featureOutputTokens.ts`）。
 * 平均が使えたときだけ「これまでの実測から」と名乗り、**最大へ落ちたときは、
 * 同梱でなくても「多めに見ています」と言う。** 名乗りを変えるだけでは、
 * 作者は15分という数字をそのまま受け取る。割り引いて読めるようにしておく。
 */
export function describeRunTimeEstimate(params: {
  /** これからAIへ送る件数 */
  readonly count: number;
  /** 数えているもの。話ごとに送る検知は「話」 */
  readonly unit: string;
  /** 見積もった所要時間。**見当が付かなければ `undefined`** */
  readonly ms: number | undefined;
  /** 1回あたりの出力量を、どこから採ったか */
  readonly basis: RunTimeEstimateBasis;
}): string {
  if (params.ms === undefined) {
    return (
      "このモデルでどれくらいかかるかは、まだ測っていないので見当が付きません。\n" +
      `${MIN_ETA_SAMPLES}${params.unit}進んだところで、残り時間の目安を出します。`
    );
  }
  const source = RUN_TIME_BASIS_LABEL[params.basis];
  return `${params.count}件 ≒ ${describeDuration(params.ms)}（${source}）`;
}

/** 出どころごとの名乗り。**最大を使ったなら、必ず「多め」と言う** */
const RUN_TIME_BASIS_LABEL: Readonly<Record<RunTimeEstimateBasis, string>> = {
  average: "これまでの実測から",
  max: "これまでの実測の最大から。多めに見ています",
  "bundled-max": "同梱の目安から。多めに見ています",
};
