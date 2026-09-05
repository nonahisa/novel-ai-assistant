import * as vscode from "vscode";
import { OUTPUT_RESERVE_TOKENS } from "./contextGuard";
import { modelTuning } from "../core/modelTuning";

/**
 * 1回の応答で受け取る出力トークンの上限。
 *
 * これを送らないと、モデルごとの既定値で動く。既定値は公開されていないことも多く、
 * **実行前に出す課金の目安が実態と合わなくなる。**
 * 金額に関わる表示なので、送る値と示す値を必ず一致させる。
 *
 * 小さすぎると応答が途中で切れ、そのチャンクの結果は丸ごと捨てられる
 * （部分的なJSONは解析できないため）。呼び出し1回分が無駄になるので、
 * 節約しすぎないほうがよい。
 */

/** 既定値。抽出のJSONが収まり、かつ極端に大きくない値 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/**
 * これ以上小さいと抽出のJSONが収まらない。
 *
 * **設定から来た値も、測って分かった値も、同じ床を通す。**
 * 送っても必ず途中で切れる上限は、そのチャンクを丸ごと捨てるのと同じである。
 */
export const MINIMUM_OUTPUT_TOKENS = 1024;

/** 中で書くときの短い別名（既存の呼び出しをそのままにするため） */
const MINIMUM = MINIMUM_OUTPUT_TOKENS;

export function resolveMaxOutputTokens(): number {
  const config = vscode.workspace.getConfiguration("novelai");

  // 以前はClaude専用の設定だった。作者が明示的に変えていた場合は尊重する
  const legacy = config.get<number>("claude.maxOutputTokens", 0);
  const configured =
    legacy > 0
      ? legacy
      : config.get<number>("maxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS);

  return Math.max(MINIMUM, configured);
}

/** 設定値をモデルの上限に丸める */
export function clampToModelLimit(
  configured: number,
  modelLimit: number | undefined
): number {
  if (modelLimit === undefined || modelLimit <= 0) return configured;
  return Math.max(MINIMUM, Math.min(configured, modelLimit));
}

/**
 * チャンク予算（`planChunkBudget` の `outputTokens`）と num_ctx の確保
 * （`generate` へ渡す `maxOutputTokens`）に見込む出力トークン数
 * （設計書6.65.16の2）。
 *
 * 台帳（`core/modelTuning.ts`）に実測（`measuredOutputTokens`）があれば
 * `min(設定, 実測)`、無ければ `min(設定, OUTPUT_RESERVE_TOKENS)`。
 * gemma4:12bですら実測6,500トークンなのに、既定の16,384を常に見込むのは
 * 非力なマシンでは要らないぶんまで num_ctx として確保することになる。
 *
 * **決定はここ1か所に括る。** 呼び出し側ごとに `resolveMaxOutputTokens()`
 * をそのまま使うと、実測が付いても見込みが古いままになる
 * （`readChunkSettings` を1か所にしたのと同じ理由）。
 *
 * **注意：測定そのもの（`features/measureContext.ts` の
 * `measureOutputLimit`）はこの丸めを通さない。** あちらは「設定値まで
 * 実際に書けるか」を測るのが目的なので、丸めると測る意味が無くなる
 * ——`resolveMaxOutputTokens()` を直接呼ぶ。
 */
export function resolveOutputTokensForPlanning(
  providerId: string,
  model: string
): number {
  const configured = resolveMaxOutputTokens();
  const measured = modelTuning(providerId, model)?.measuredOutputTokens;
  const ceiling = measured !== undefined ? measured : OUTPUT_RESERVE_TOKENS;
  return Math.min(configured, ceiling);
}

/** 上限の出どころ。案内の文言を分けるためだけにある */
export type OutputLimitSource = "設定" | "実測";

/** 実際に送る上限と、その値がどこから来たか */
export interface OutputTokenLimit {
  readonly tokens: number;
  readonly source: OutputLimitSource;
}

/**
 * **実際に上限として送る**トークン数と、その出どころ（設計書6.77の第2段）。
 *
 * `max(1024, min(設定, 実測 ?? 設定))`——実測があればそこまで、無ければ設定値。
 * ただし**床（1,024）は必ず通す**、そして**時間切れ混じりの実測は使わない**。
 *
 * ## 床を通す理由（0.33.0で入れ直した）
 *
 * ほかの関数（`resolveMaxOutputTokens`・`clampToModelLimit`）はどれも
 * 床を掛けているのに、**実際に送るこの口だけが素通り**だった。
 * 「書ける量」の測定は時間切れを「書けない」と数えるので、遅いモデルでは
 * 数百トークンの実測が台帳へ入りうる。0.32.11からこの値がハード上限に
 * なったため、**測っただけで以後すべての応答が切られる**状態が作れた。
 *
 * ## 時間切れ混じりを使わない理由
 *
 * 「待っても返らなかった」は「書けない」の証拠として弱い（`ModelTuning`
 * の `outputMeasureTimedOut`）。**見込み（`resolveOutputTokensForPlanning`）
 * と まとめ送信の絞り込み（`features/chunkSettings.ts`）では従来どおり使う**
 * ——あちらは場所の確保と量の見立てなので、小さく見るぶんには安全側に働く。
 * こちらだけが「どこまで書いてよいか」を決める、取り返しのつかない値である。
 *
 * ## 出どころを返す理由
 *
 * 切り詰められたときの案内は、上限が設定から来たのか実測から来たのかで
 * 直し方が違う。**同じ判定を2か所で書かない**ために、値と一緒に返す。
 *
 * **見込み（上の `resolveOutputTokensForPlanning`）と分けている理由。**
 * あちらは実測が無いとき `OUTPUT_RESERVE_TOKENS`（8,192）で頭を打つが、
 * それは「場所をどれだけ空けるか」の話であって「どこまで書いてよいか」
 * ではない。**見込みをそのまま上限として送ると、測っていないモデルでは
 * 上限が設定値の半分になり、長い応答が途中で切れる**（抽出のJSONは
 * 切れると解析できず、そのチャンクが丸ごと捨てられる）。0.32.11で実際に
 * そうなりかけたので、欄そのものを2つに分けた。
 *
 * **実測は「そこまで書けた」ことの記録なので、上限にしてよい。**
 * それ以上を許しても書けないことは測って分かっている。設定値を超える
 * 実測は設定値で丸める——作者が設定で下げたなら、そちらが勝つ。
 */
export function resolveOutputLimitForSend(
  providerId: string,
  model: string
): OutputTokenLimit {
  const configured = resolveMaxOutputTokens();
  const tuning = modelTuning(providerId, model);
  const measured = tuning?.measuredOutputTokens;
  if (measured === undefined || tuning?.outputMeasureTimedOut === true) {
    return { tokens: configured, source: "設定" };
  }
  const tokens = Math.max(MINIMUM, Math.min(configured, measured));
  // 設定より下がっていないなら、効いているのは設定のほうである
  return { tokens, source: tokens < configured ? "実測" : "設定" };
}

/** 送る上限の値だけが要るとき（大半の呼び出し側） */
export function resolveOutputTokensForSend(
  providerId: string,
  model: string
): number {
  return resolveOutputLimitForSend(providerId, model).tokens;
}

/**
 * 応答が上限で切り詰められたときに、作者へ出す直し方。
 *
 * **上限の出どころで文言を変える。** 実測が効いているのに
 * 「設定の『1回の応答の上限』を大きくして」と言うのは**嘘**である
 * ——大きくしても実測で頭打ちのままで、作者は直らない操作を繰り返す。
 */
export function truncatedOutputAdvice(limit: OutputTokenLimit): string {
  if (limit.source === "実測") {
    return (
      "応答が出力上限で切り詰められました。上限は、AIチューニングで測った" +
      `「書ける量」の実測（約${limit.tokens.toLocaleString("ja-JP")}トークン）です。` +
      "質問を短くするか、AIチューニングで測り直す（または設定 " +
      "novelai.modelTuning からこのモデルの measuredOutputTokens を消す）と広がります。"
    );
  }
  return (
    "応答が出力上限で切り詰められました。質問を短くするか、" +
    "設定の「1回の応答の上限」を大きくしてお試しください。"
  );
}
