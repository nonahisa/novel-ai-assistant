import {
  LARGE_MODEL_MIN_BILLIONS,
  parameterSizeInBillions,
  type CapabilityTier,
  type ProviderId,
} from "./types";
import { isLocalProviderId } from "../core/localProviders";

/**
 * モデルの地力に応じて、機能の重さを決める。
 *
 * ## なぜ1か所へ集めるか
 *
 * これまでは各機能が `provider.id === "ollama"` と直に書いていた。
 * そこには**性質の違う2つの軸**が混ざっている。
 *
 * | 軸 | 見るもの | 決めること |
 * |---|---|---|
 * | お金がかかるか | `provider.isPaid` | 見積もりを出すか。「無料」と言ってよいか |
 * | モデルの地力 | `ModelInfo.tier` | 観点を絞るか。「効きません」と断るか |
 *
 * 混ざっていたせいで、**LM Studio（手元・無料）が両方から漏れていた**。
 * 課金されないのに課金の警告が出て、3Bのモデルに矛盾検知の7観点が渡る。
 *
 * `features/chunkSettings.ts` が「同じ設定が機能によって効いたり効かなかったり
 * していた。読むところを1つにまとめる」でやったことと同じ考え方である。
 *
 * ## なぜ「light だけ」ではなく「high 以外」で絞るか
 *
 * 実データの測定による。プロット逸脱検知は `gemma4:e4b`（8B・standard）でも
 * `gemma4:12b` でも、**5回測って全話0件**だった。プロットに載せた話と
 * 外した話を見分けられていない。境目は light と standard の間ではない。
 *
 * VS Code APIに依存しない。
 */

export interface CapabilityInput {
  /**
   * モデルの能力。**取れないことがある。**
   *
   * モデル情報の取得は通信を伴うので失敗しうる。そのときは
   * `providerId` での判定へ落とす（下記）。
   */
  tier?: CapabilityTier;
  /** モデル情報が取れなかったときの手掛かり */
  providerId: ProviderId;
  /**
   * パラメータ数の表記（`ModelInfo.parameterSize`。"25.2B" など）。
   * **取れないことがある**（クラウドのモデルは答えない）。
   *
   * ティア（`tier`）では代わりにならない。境目は `LARGE_MODEL_MIN_BILLIONS`
   * で共通になったが、**ティアは大きさが取れなくても付く**——プロバイダで
   * 決まる high（Claude・ChatGPT・Gemini）と、取れなかったときの light が
   * あるので、抑制の判定はここを直に見る必要がある。
   */
  parameterSize?: string | null;
}

export interface CapabilityProfile {
  /** 矛盾検知の観点を7つから3つへ絞るか */
  narrowContradictionCategories: boolean;
  /**
   * 矛盾検知で、**確信の持てない箇所を抑えさせるか**（設計書6.10.8）。
   *
   * true＝これまで（プロンプト1.5）と同じ抑制を残す
   * （`CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT` を送る）。
   * false＝ゆるめた 1.6 の既定を送る。
   */
  suppressUncertainContradictions: boolean;
  /** プロット逸脱検知の種別を2つから1つへ絞るか（「間延び」を見ない） */
  narrowDeviationTypes: boolean;
  /** プロット逸脱検知の実行前に「ほとんど働きません」と断るか */
  warnDeviationIneffective: boolean;
}

/**
 * 手元で動かすAI。**大きさが分からなかったときだけ**見る。
 *
 * 手元は、作者がどの大きさのモデルを載せるかを選ぶので、分からなければ
 * 小さいほうを想定して抑える。クラウドは主力が大きいモデルなので、
 * `inferTier` が high 扱いにしているのと同じ理由でゆるめる側に置く。
 *
 * **「クラウドはパラメータ数を答えない」ではない**（0.70.12で直した誤り）。
 * さくらのAIと LM Studio は公開されている重みを動かすので、モデルIDから
 * `parseParameterSize` が大きさを読める。**読めたなら、どこで動いていようと
 * 大きさで決める**——名前で門を作ると、さくらの `12b` に「観点は絞るのに
 * 抑制はゆるめる」という、実測でいちばん出来の悪かった組み合わせが渡る。
 *
 * **一覧は `core/localProviders.ts` の1つだけ**（写しを持たない）。
 */

/**
 * このモデルで、重い判断をさせてよいか。
 *
 * **`tier` が取れないときは、これまでと同じ判定へ落とす。**
 * 分からないことを理由に挙動を変えると、「モデル情報が取れなかった日だけ
 * 結果が違う」という追いにくい不具合になる。
 */
export function capabilityProfile(input: CapabilityInput): CapabilityProfile {
  const light =
    input.tier === undefined
      ? // これまでの判定。Ollamaだけを小さいモデルとみなしていた
        input.providerId === "ollama"
      : input.tier !== "high";

  return {
    narrowContradictionCategories: light,
    narrowDeviationTypes: light,
    warnDeviationIneffective: light,
    suppressUncertainContradictions: suppressUncertain(input),
  };
}

/**
 * 矛盾検知の抑制を残すか（設計書6.10.8）。
 *
 * **大きさが分かるなら、どこで動いていようと大きさで決める。** 実測が
 * 見ていたのはモデルの大きさであって、どこで動いているかではない。
 * さくらのAIと LM Studio はモデルIDから大きさが読めるので、**判断材料が
 * 手元にあるのに名前で門を作ると、さくらの `12b` に「観点は絞るのに抑制は
 * ゆるめる」が渡る**——実測で「当たりが増えないまま誤検出だけ増える」と
 * 結論した組み合わせそのものである（0.70.12で直した）。
 *
 * **大きさが取れないときだけ、プロバイダで分ける。** 分からないときは
 * これまでと同じ判定へ落とす——手元にとっての「これまで」は 1.5＝抑制あり、
 * クラウドにとっては 1.6＝ゆるめる、である。取れないのに大きいモデルと
 * みなすと、**モデル情報が取れなかった日だけ誤検出が増える**ことになる。
 */
/**
 * 誤字脱字検知で、小さいモデル向けの版（P-09 の 1.1 の文そのまま）を送るか。
 *
 * **境目は矛盾検知の抑制と同じ**（`LARGE_MODEL_MIN_BILLIONS`、大きさが取れない
 * ときの扱いも同じ）。P-09 1.2 の書き方を揃える指示は、`gemma4:e4b`（8B）では
 * 誤検出を 13 → 29 に増やし、`gemma4:26b` とさくらの Kimi-K2.6 では増やさなかった
 * （正解つきの台、2026-09-26。設計書6.8.20）。12b は測っていないので、
 * 境目の下＝これまでの文に置く。
 */
export function useSmallModelTypoPrompt(input: CapabilityInput): boolean {
  return suppressUncertain(input);
}

function suppressUncertain(input: CapabilityInput): boolean {
  const billions = parameterSizeInBillions(input.parameterSize);
  if (billions !== undefined) return billions < LARGE_MODEL_MIN_BILLIONS;
  return isLocalProviderId(input.providerId);
}

/**
 * ログと確認画面に出す、モデルの地力の説明。
 *
 * **絞ったことを黙って行わない。** LM Studio やさくらの小さいモデルを
 * 使っている作者は、この変更で指摘の件数が減る。理由が画面に出ていないと、
 * コードを読まない限り分からない。
 *
 * **機能を必ず渡す**（`capabilityCacheTag` とまったく同じ作法。0.70.12）。
 * 抑制は矛盾検知にしか無いので、機能を問わず1つの文へ畳むと、**プロット
 * 逸脱検知のログが、ありもしない抑制を毎回名乗る**。既定値を置かないのは、
 * 新しい機能が増えたときに**呼び忘れを型で止める**ため。
 */
export function describeCapability(
  input: CapabilityInput,
  profile: CapabilityProfile,
  feature: "contradiction" | "deviation"
): string {
  const tier = input.tier ? TIER_LABELS[input.tier] : "地力は不明";
  const notes: string[] = [];
  if (profile.narrowContradictionCategories) notes.push("観点を絞る");
  // **抑制を残したことも黙って行わない**（設計書6.10.8）。同じモデル名でも
  // 送っている指示が違うので、出しておかないとログから読み取れない
  if (feature === "contradiction" && profile.suppressUncertainContradictions) {
    notes.push("確信の持てない指摘は抑える");
  }
  return [tier, ...notes].join("・");
}

const TIER_LABELS: Record<CapabilityTier, string> = {
  high: "高性能",
  standard: "標準",
  light: "軽量",
};

/**
 * 矛盾検知の**実行前の確認文**に出す、モデルの地力による断り。
 *
 * **`describeCapability` の隣に置く。** あちらはログ向けに同じ地力を一言で
 * 言うもので、こちらは作者向けの説明文である。**同じ判断を2か所で言葉に
 * しているので、離して置くと片方だけ直して食い違う。**
 *
 * 返すのは2つの断りを繋いだ文字列で、当てはまらない側は空になる。
 * 呼び出し側は確認文の配列へそのまま並べる（`.filter(Boolean)` で
 * 空なら消える形を保つ）。
 */
export function describeContradictionCapabilityForAuthor(
  profile: CapabilityProfile
): string {
  return [
    // **絞ったことを黙って行わない。** 指摘の件数が減るので、
    // 理由が画面に出ていないと作者には分からない（設計書6.28）
    profile.narrowContradictionCategories
      ? `\nこのモデルでは、見る観点を7つから3つ（人物・状態・時系列）へ絞ります。\n` +
        "一度にたくさん見せると、かえって見落としが増えるためです。"
      : "",
    // **抑制の強さを変えたことも黙らない**（設計書6.10.8）。
    // 大きいモデルでは指摘が増え、小さいモデルではこれまでどおりになる。
    // **どちらも「モデルのせいで結果が違う」ので、理由を先に出す**
    profile.suppressUncertainContradictions
      ? "\nこのモデルでは、確信の持てない箇所は指摘しません。\n" +
        "小さいモデルで疑わしい箇所まで挙げさせると、当たりは増えずに\n" +
        "見当違いの指摘だけが増えるためです（実測）。"
      : "\nこのモデルでは、確信が持てない箇所も挙げます。\n" +
        "どちらが正しいかは作者が決めるので、黙って見逃すより出します。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * キャッシュの鍵に混ぜる印。
 *
 * **観点が変われば、同じ本文でも答えが変わる。** 混ぜないと、
 * 7観点で作った古い結果を3観点の結果として再利用してしまう。
 *
 * **絞らないときは空にする。** そうすれば `high` のモデル
 * （Claude・ChatGPT・Gemini・さくらの大きいモデル）の鍵はこれまでと
 * 同じままで、**有料AIで処理済みのキャッシュが飛ばない**。
 * 飛ぶのは手元の無料AIのぶんだけになる。
 *
 * **抑制の有無も混ぜる**（0.70.8）。送るシステムプロンプトそのものが
 * 変わるので、混ぜないと**抑制ありで作った古い結果を、ゆるめた結果として
 * 再利用する**（実装ルール4）。こちらも**ゆるめる側＝新しい既定には
 * 印を付けない**——大きいモデルの鍵をこれまでどおりに保つ。
 *
 * **順番は「絞り → 抑制」で固定する**（テストで見張る）。並びが揺れると、
 * 同じ設定なのに別の鍵になり、キャッシュが二重に積み上がる。
 *
 * **機能を必ず渡す。** 抑制は矛盾検知にしか無いので、プロット逸脱検知の
 * 鍵に混ぜると**関係のない変更で、逸脱の結果まで総入れ替えになる**。
 * 既定値を置かないのは、新しい機能が増えたときに**呼び忘れを型で止める**ため。
 */
export function capabilityCacheTag(
  profile: CapabilityProfile,
  feature: "contradiction" | "deviation"
): string {
  return (
    (profile.narrowContradictionCategories ? "light:" : "") +
    (feature === "contradiction" && profile.suppressUncertainContradictions
      ? "strict:"
      : "")
  );
}
