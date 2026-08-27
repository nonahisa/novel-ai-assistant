import type { CapabilityTier, ProviderId } from "./types";

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
}

export interface CapabilityProfile {
  /** 矛盾検知の観点を7つから3つへ絞るか */
  narrowContradictionCategories: boolean;
  /** プロット逸脱検知の種別を2つから1つへ絞るか（「間延び」を見ない） */
  narrowDeviationTypes: boolean;
  /** プロット逸脱検知の実行前に「ほとんど働きません」と断るか */
  warnDeviationIneffective: boolean;
}

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
  };
}

/**
 * ログと確認画面に出す、モデルの地力の説明。
 *
 * **絞ったことを黙って行わない。** LM Studio やさくらの小さいモデルを
 * 使っている作者は、この変更で指摘の件数が減る。理由が画面に出ていないと、
 * コードを読まない限り分からない。
 */
export function describeCapability(
  input: CapabilityInput,
  profile: CapabilityProfile
): string {
  const tier = input.tier ? TIER_LABELS[input.tier] : "地力は不明";
  if (!profile.narrowContradictionCategories) return tier;
  return `${tier}・観点を絞る`;
}

const TIER_LABELS: Record<CapabilityTier, string> = {
  high: "高性能",
  standard: "標準",
  light: "軽量",
};

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
 */
export function capabilityCacheTag(profile: CapabilityProfile): string {
  return profile.narrowContradictionCategories ? "light:" : "";
}
