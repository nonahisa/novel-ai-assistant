import {
  describeRunTimeEstimate,
  estimateCallsTime,
  type CallTimeEstimate,
  type RunTimeEstimateBasis,
} from "../core/etaEstimate";
import { modelTuning } from "../core/modelTuning";
import { resolveTokensPerChar } from "../core/sizeBudget";
import {
  MIN_FEATURE_OUTPUT_SAMPLES,
  featureOutputTuning,
} from "../core/featureOutputTokens";

/**
 * 押す前の所要時間の見当（設計書6.8.19）。
 *
 * **`views/` から出してある**（0.72.0）。中身は台帳（プロバイダID＋モデル名）を
 * 引くだけで、画面の部品ではない——`ai/capability.ts` が「モデルの地力で
 * 何が変わるか」を1か所に集めているのと同じ並びである。
 *
 * **ここに `vscode` を持ち込まない**（実装ルール7）。持ち込むと、外から呼ぶ束
 * （MCP）へ出す道が塞がる。**ただし今はまだ届いていない**——`core/modelTuning.ts`
 * と `core/featureOutputTokens.ts` が `vscode` を静的 import しているためで、
 * そちらを割るまでは MCP の束からは引けない（`test/unit/cross/mcpReach.test.ts`）。
 */

/**
 * 押す前に「およそどれだけかかるか」を言う（設計書6.8.19）。
 *
 * **見当が付かないときは、正直にそう言う。** ここで既定値を置くと、
 * 一度も測っていないモデルにも数字が出て、当てずっぽうが実測の顔をして
 * 並ぶ。台帳（`core/modelTuning.ts` の `outputTokensPerSecond`）は作者
 * 自身の呼び出しからしか入らないので、無いということは本当に「この機械で
 * このモデルを動かしたことがない」である。
 *
 * **`speedMeasuredAt` はここでは見ない。** 古い測定でも、いまある唯一の
 * 実測である——粒度は「およそ5時間」なので、多少古くても判断は変わらない。
 * 黙って捨てると、代わりに出せるものが何も無くなる。
 */
export function estimateRunTimeText(params: {
  /** AIのプロバイダID（速さの台帳の鍵） */
  readonly providerId: string;
  /** モデル名（同上） */
  readonly model: string;
  /** 出力量の実測を引く機能名（`meta.feature` と同じもの） */
  readonly feature: string;
  /** これからAIへ送る件数 */
  readonly count: number;
  /** 数えているもの。話ごとに送る検知は「話」 */
  readonly unit?: string;
  /**
   * 1回ごとに送る本文の字数（長さは `count` と揃える）。**渡せば読み込みの
   * 時間も足す**（設計書6.8.19。ノートPCの実機、2026-09-23）。
   *
   * 渡さなければ、これまでどおり書き出しの側だけで見る。読み込みの速さが
   * 台帳に入ると、書き出しの速さはAIが申告した書き出しの時間だけで割った
   * 値になる（`ai/meteredProvider.ts`）ので、CPUだけの機械では渡さないと
   * 読み込みのぶんだけ短く出る。
   */
  readonly inputChars?: readonly number[];
}): string {
  const unit = params.unit ?? "チャンク";
  const speeds = lookupCallSpeeds(params.providerId, params.model, params.feature);
  const inputs =
    params.inputChars !== undefined && params.inputChars.length === params.count
      ? params.inputChars
      : undefined;

  const estimate = estimateCallsTime({
    // 字数が無いときは件数ぶんの0字を置き、読み込みの速さを渡さない
    // ——読み込みの時間を0と見積もったことにしない
    inputChars: inputs ?? new Array<number>(Math.max(0, params.count)).fill(0),
    tokensPerChar: speeds.tokensPerChar,
    inputTokensPerSecond:
      inputs !== undefined ? speeds.inputTokensPerSecond : undefined,
    outputTokensPerSecond: speeds.outputTokensPerSecond,
    outputTokensPerCall: speeds.outputTokensPerCall,
    // **決め打ちを渡さない。** 検知の確認は、測っていなければ「見当が
    // 付きません」と言う決まり（上の断り書き）
  });
  return describeRunTimeEstimate({
    count: params.count,
    unit,
    ms: estimate?.ms,
    basis: speeds.basis,
  });
}

/**
 * 押す前の目安を、**送る量と速さから**出す（設計書6.8.19）。
 *
 * **CPUだけの機械で15倍ずれた**のを直すために置いた（ノートPCの実機、
 * 2026-09-23）。人物抽出・各話あらすじ・校正のまとめ実行・新作の仕上げが
 * 「1チャンク◯秒」の決め打ちで目安を出しており、送る量を見ていなかった。
 *
 * **速さが分からないときは、これまでの決め打ちへ落とす**
 * （`fallbackSecondsPerCall`）。遅い値を勝手に仮定しない。式は
 * `core/etaEstimate.ts` の `estimateCallsTime` の1か所にある。
 */
export function estimateCallsTimeFor(params: {
  readonly providerId: string;
  readonly model: string;
  /** 出力量の実測を引く機能名（`meta.feature` と同じもの）。無ければ書く量は決め打ち */
  readonly feature?: string;
  /** 1回ごとに送る字数（指示や資料を含む、送るぶんそのもの） */
  readonly inputChars: readonly number[];
  /** 速さが分からないときの、1回あたりの決め打ちの秒数（これまでの目安） */
  readonly fallbackSecondsPerCall: number;
}): CallTimeEstimate | undefined {
  const speeds = lookupCallSpeeds(params.providerId, params.model, params.feature);
  return estimateCallsTime({
    inputChars: params.inputChars,
    tokensPerChar: speeds.tokensPerChar,
    inputTokensPerSecond: speeds.inputTokensPerSecond,
    outputTokensPerSecond: speeds.outputTokensPerSecond,
    /*
      **平均だけを見る。最大へは落とさない。**

      検知の確認（上の `estimateRunTimeText`）は最大へ落ちたとき
      「多めに見ています」と名乗れるが、こちらの言い方は「目安 ◯ 分程度」の
      1行で、名乗りの置き場が出どころ1つしか無い。しかも人物抽出の同梱の
      最大は12,023トークンで、書き出し6.5トークン/秒の機械なら1チャンク
      30分を超える——**桁を外す向きが逆になるだけ**である。平均が無ければ
      書く側は「分からない」とし、これまでの決め打ちで埋める（`partial`）。
    */
    outputTokensPerCall: speeds.outputTokensAverage,
    fallbackSecondsPerCall: params.fallbackSecondsPerCall,
  });
}

/**
 * 見積もりに要る、台帳の値。**引き方をここ1か所にする**（2つの目安で写さない）。
 *
 * チャンクの大きさを待ち時間に収める側（`features/chunkSettings.ts`。
 * 2026-09-23）も、ここから引く——目安と大きさが別々の速さを見ると、
 * 目安は「収まる」と言うのに大きさは縮む、という食い違いになる。
 */
export interface CallSpeeds {
  readonly inputTokensPerSecond?: number;
  readonly outputTokensPerSecond?: number;
  /** 1回に書く量（平均があれば平均、無ければ最大） */
  readonly outputTokensPerCall?: number;
  /** 1回に書く量の平均だけ（件数がしきい値に届いたもの） */
  readonly outputTokensAverage?: number;
  readonly tokensPerChar: number;
  readonly basis: RunTimeEstimateBasis;
}

export function lookupCallSpeeds(
  providerId: string,
  model: string,
  feature: string | undefined
): CallSpeeds {
  const tuning = modelTuning(providerId, model);
  // **出力量の実測もモデルごと**（0.71.6）。速さの台帳と同じ鍵で引く
  // ——同じ機能でも、思考を吐くモデルは書く量が違う
  const output = featureOutputTuning(feature, providerId, model);
  // **件数が足りない実測は使わない**（`core/featureOutputTokens.ts` の
  // しきい値と同じ線を引く）。1回ぶんでは、たまたま短かった回と区別が付かない
  const enough =
    (output?.outputTokenSamples ?? 0) >= MIN_FEATURE_OUTPUT_SAMPLES;
  /*
    **時間の見積もりは、平均を見る**（0.71.5。2026-09-21 に実機で外した）。

    台帳が覚えている最大（`outputTokens`）は容量のための値で、**所要時間に
    使えば必ず過大になる**——プロット逸脱10話で「およそ15分」と出て、実際は
    39秒だった。平均が無い（同梱の表、または0.71.4以前の行）ときだけ最大へ
    落ち、そのときは「多めに見ています」と名乗る。
  */
  const average = enough ? output?.outputTokensAverage : undefined;
  const max = enough ? output?.outputTokens : undefined;
  // **出どころを渡す。** 最大から出した数字に、普段の量と同じ顔をさせない
  const basis: RunTimeEstimateBasis =
    average !== undefined
      ? "average"
      : output?.bundled === true
        ? "bundled-max"
        : "max";
  return {
    inputTokensPerSecond: tuning?.inputTokensPerSecond,
    outputTokensPerSecond: tuning?.outputTokensPerSecond,
    outputTokensPerCall: average ?? max,
    outputTokensAverage: average,
    /*
      **字→トークンは、チャンクを決めるのと同じ換算を使う**（設計書6.77）。
      新しい換算を作らない。台帳の実測（同梱の表を含む）が5件あれば実測に
      1割の余白を掛けた値、無ければ当て推量の0.7字/トークン——どちらも
      トークンを多めに数える側なので、目安は長めに出る（短く出るよりよい）。
    */
    tokensPerChar: resolveTokensPerChar(tuning),
    basis,
  };
}
