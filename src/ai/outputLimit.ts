import * as vscode from "vscode";
import { OUTPUT_RESERVE_TOKENS, describeWindowCappedOutput } from "./contextGuard";
import type { GenerateResult } from "./types";
import { modelTuning, unsuppressedThinkingTokens } from "../core/modelTuning";
import {
  featureOutputCeiling,
  featureOutputTuning,
} from "../core/featureOutputTokens";
import { logLine } from "../core/logger";

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
 * **実測から決める**（作者の裁定、2026-09-19。設計書6.77の第3段）。
 * 見る実測は2つある。
 *
 * - **機能の実測**（`core/featureOutputTokens.ts`）……この仕事が1回に
 *   何トークン書くか。普段の呼び出しから貯まる
 * - **モデルの実測**（`measuredOutputTokens`）……このモデルが何トークン
 *   書けるか。「書ける量」の測定から入る
 *
 * どちらも無ければ、これまでどおり `min(設定, OUTPUT_RESERVE_TOKENS)`。
 * gemma4:12bですら実測6,500トークンなのに、既定の16,384を常に見込むのは
 * 非力なマシンでは要らないぶんまで num_ctx として確保することになる。
 *
 * **決定はここ1か所に括る。** 呼び出し側ごとに `resolveMaxOutputTokens()`
 * をそのまま使うと、実測が付いても見込みが古いままになる
 * （`readChunkSettings` を1か所にしたのと同じ理由）。
 *
 * **関所（`ai/meteredProvider.ts`）と実送信の上限
 * （`resolveOutputLimitForSend`）も、同じ機能の実測から引く。** ここだけが
 * 当て推量の 8,192 だったころは、**計画いっぱいに詰めたチャンクを関所が
 * 断って割る**のが常態だった（実機、2026-09-19）。
 *
 * **注意：測定そのもの（`features/measureContext.ts` の
 * `measureOutputLimit`）はこの丸めを通さない。** あちらは「設定値まで
 * 実際に書けるか」を測るのが目的なので、丸めると測る意味が無くなる
 * ——`resolveMaxOutputTokens()` を直接呼ぶ。
 */
export function resolveOutputTokensForPlanning(
  providerId: string,
  model: string,
  feature?: string
): number {
  const configured = resolveMaxOutputTokens();
  const tuning = modelTuning(providerId, model);
  const measured = tuning?.measuredOutputTokens;
  /*
    **機能ごとの実測**（`core/featureOutputTokens.ts`。設計書6.77の第3段）。

    ここが 8,192 の当て推量だったせいで、関所（実送信の上限で数える）と
    **同じ呼び出しについて別々の値**を持っていた。実測があるなら、
    計画も関所も実送信の上限もそこから引く——それが割れの元を断つ。
  */
  const expected = withThinkingOverhead(
    featureOutputCeiling(feature, providerId, model),
    feature,
    providerId,
    model
  );
  /*
    **止められない思考のぶんを、当て推量の見込みにも足す**（設計書6.49.9）。
    機能の実測も書ける量の実測も無いときの 8,192 は、思考を考えに入れて
    いない数字である。
  */
  const reserve = OUTPUT_RESERVE_TOKENS + unsuppressedThinkingTokens(tuning);
  /*
    **2つの実測は、意味が違うので両方を見る。**

    - `expected`……この**仕事**が何トークン書くか
    - `measured`……この**モデル**が何トークン書けるか

    要る量が15,360でも、モデルが6,500しか書けないなら確保すべきは6,500で
    ある（それ以上を空けても書かれない）。逆に測っていない機能では、
    これまでどおりモデル側の実測だけで決める——**渡していない呼び出しの
    挙動は変えない。**
  */
  const ceiling =
    expected !== undefined
      ? Math.min(expected, measured ?? expected)
      : (measured ?? reserve);
  if (expected !== undefined) {
    noteFeatureCeiling(feature, providerId, model, expected);
  }
  return Math.min(configured, ceiling);
}

/**
 * 機能の見込みに、**止められない思考のぶん**を足す（設計書6.49.9）。
 *
 * **足すのは、見込みが同梱の表から来たときだけ。** 同梱の表は作者の機械の
 * 別のモデルで測った「答えの量」で、このモデルが答えの前に考えるぶんは
 * 入っていない——そのまま上限として送ると、考える途中で上限を使い切って
 * 答えが空になる（比べ 2026-09-25〜26 の Qwen3.6・Kimi がそれだった）。
 * **このモデル自身の実測から出た見込みには足さない。** 実測の出力トークン数
 * には思考のぶんがもう入っているので、足すと二重に数える。
 */
function withThinkingOverhead(
  expected: number | undefined,
  feature: string | undefined,
  providerId: string,
  model: string
): number | undefined {
  if (expected === undefined) return undefined;
  if (featureOutputTuning(feature, providerId, model)?.bundled !== true) {
    return expected;
  }
  return expected + unsuppressedThinkingTokens(modelTuning(providerId, model));
}

/**
 * 実測から見込んだことを、**一度だけ**記録に残す（同梱の守り3「出どころを
 * 見せる」）。
 *
 * **効いているのに見えない値を作らない。** 見込みが変わるとチャンクの
 * 大きさが変わるので、作者からは「急に細かく割られるようになった」と
 * しか見えない。何を根拠にその数字になったのかを、`describeChunkSettings`
 * の1行と同じ場所（操作ログ）へ出す。
 *
 * 呼び出しのたびに書くとログが埋まるので、同じ機能・同じ値なら一度きり
 * （`core/modelTuning.ts` の `noteOnce` と同じ形）。**0.71.6 からは
 * モデルも数え分ける**——実測がモデルごとに分かれたので、同じ機能でも
 * モデルを替えれば違う値が出る。まとめて一度にすると、替えたあとの値が
 * ログに出ない。
 */
const notedFeatureCeilings = new Set<string>();

function noteFeatureCeiling(
  feature: string | undefined,
  providerId: string,
  model: string,
  tokens: number
): void {
  const tuning = featureOutputTuning(feature, providerId, model);
  const note =
    `${providerId}/${model}:${feature}:${tokens}:` +
    `${tuning?.bundled === true ? "同梱" : "実測"}`;
  if (notedFeatureCeilings.has(note)) return;
  notedFeatureCeilings.add(note);
  logLine(
    `出力の見込み：${feature} は ${tokens.toLocaleString("ja-JP")}トークン` +
      // **どのモデルのぶんかを出す。** 同じ機能でもモデルごとに違う値に
      // なったので、機械の実測としか書かないと、どの実測なのか読めない
      `（${model} の` +
      `${tuning?.bundled === true ? "同梱の初期値" : "この機械の実測"}` +
      `${tuning?.outputTokens?.toLocaleString("ja-JP") ?? "?"}トークン × ` +
      `${tuning?.outputTokenSamples ?? 0}回ぶん）。`
  );
}

/**
 * 上限の出どころ。案内の文言を分けるためだけにある。
 *
 * `機能の実測` は、その機能がこれまでに書いた量から見込んだ上限
 * （`core/featureOutputTokens.ts`）。**直し方が「実測」とも「設定」とも
 * 違う**ので分けてある——こちらは切り詰められたことが記録に残り、
 * 次の回から自動で設定値へ戻る。
 */
export type OutputLimitSource = "設定" | "実測" | "機能の実測";

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
  model: string,
  feature?: string
): OutputTokenLimit {
  const configured = resolveMaxOutputTokens();
  const tuning = modelTuning(providerId, model);
  const measured =
    tuning?.outputMeasureTimedOut === true
      ? undefined
      : tuning?.measuredOutputTokens;
  /*
    **機能ごとの実測も、ここで効かせる**（設計書6.77の第3段）。

    実送信の上限は、上限を送るプロバイダ（クラウド5社）では**そのまま席を
    食う**——関所はこの値で場所を数える。だから計画と食い違わせないために
    は、計画が見るのと同じ実測をここでも見るしかない。

    **切れる危険は、`resolveOutputTokensForPlanning` のときより重い**
    （切れた応答のJSONは解析できず、そのチャンクが丸ごと捨てられる）。
    だから見込みには余裕を上乗せしてあり、それでも足りなかったときは
    切り詰められたことが台帳へ残って、**次の回から設定値へ戻る。**
  */
  const expected = withThinkingOverhead(
    featureOutputCeiling(feature, providerId, model),
    feature,
    providerId,
    model
  );

  // **いちばん小さい制約が効く。** 出どころを一緒に持ち回るのは、
  // 切り詰めの案内で同じ判定をもう一度書かないため
  const limits: Array<[number, OutputLimitSource]> = [[configured, "設定"]];
  if (measured !== undefined) limits.push([measured, "実測"]);
  if (expected !== undefined) limits.push([expected, "機能の実測"]);
  const [smallest, from] = limits.reduce((a, b) => (b[0] < a[0] ? b : a));

  const tokens = Math.max(MINIMUM, smallest);
  // 床で押し上げた・設定より下がっていないなら、効いているのは設定のほう
  return { tokens, source: tokens < configured ? from : "設定" };
}

/** 送る上限の値だけが要るとき（大半の呼び出し側） */
export function resolveOutputTokensForSend(
  providerId: string,
  model: string,
  feature?: string
): number {
  return resolveOutputLimitForSend(providerId, model, feature).tokens;
}

/**
 * 応答が上限で切り詰められたときに、作者へ出す直し方。
 *
 * **上限の出どころで文言を変える。** 実測が効いているのに
 * 「設定の『1回の応答の上限』を大きくして」と言うのは**嘘**である
 * ——大きくしても実測で頭打ちのままで、作者は直らない操作を繰り返す。
 */
export function truncatedOutputAdvice(
  limit: OutputTokenLimit,
  /**
   * 切り詰められた応答（`outputCappedByWindow` だけを見る）。
   *
   * **送る前の関所が上限を縮めた回は、何より先にそう言う**（0.89.6 の担当の
   * 報告 #5）。上限の出どころが設定でも実測でも、実際に送ったのは関所が
   * 縮めた値で、設定を上げても測り直しても変わらない。渡さない呼び出しは
   * これまでどおり。
   */
  response?: Pick<GenerateResult, "outputCappedByWindow">
): string {
  const cap = response?.outputCappedByWindow;
  if (cap !== undefined) {
    return (
      "応答が出力上限で切り詰められました。" +
      describeWindowCappedOutput(cap) +
      "送る量を減らすか、もっと長く読めるモデルをお試しください。"
    );
  }
  if (limit.source === "機能の実測") {
    return (
      "応答が出力上限で切り詰められました。上限は、この機能がこれまでに" +
      `書いた量から見込んだ値（約${limit.tokens.toLocaleString("ja-JP")}トークン）です。` +
      // **切れたことは台帳に残る**（`recordFeatureOutputTokens`）ので、
      // 作者がすべきことは「もう一度実行する」だけである。直らない操作を
      // 案内しない（0.66.6 で「設定を大きくして」が嘘になっていたのと同じ形）
      "見込みが足りなかったことは記録したので、次からは設定の上限まで送ります" +
      "——そのままもう一度お試しください。"
    );
  }
  if (limit.source === "実測") {
    return (
      "応答が出力上限で切り詰められました。上限は、AIチューニングで測った" +
      `「書ける量」の実測（約${limit.tokens.toLocaleString("ja-JP")}トークン）です。` +
      // **消し方は、いまある道で言う**（0.66.6）。台帳は設定から保管庫の
      // ファイルへ移ったので、設定画面を開いても該当の欄はもう無い
      "質問を短くするか、AIチューニングで測り直す（または詳細メニューの" +
      "「AIチューニング記録削除」でこのモデルの記録を消す）と広がります。"
    );
  }
  return (
    "応答が出力上限で切り詰められました。質問を短くするか、" +
    "設定の「1回の応答の上限」を大きくしてお試しください。"
  );
}
