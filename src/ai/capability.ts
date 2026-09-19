import { parameterSizeInBillions, type CapabilityTier, type ProviderId } from "./types";

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
   * パラメータ数の表記（`ModelInfo.parameterSize`。"26.0B" など）。
   * **取れないことがある**（クラウドのモデルは答えない）。
   *
   * ティア（`tier`）では代わりにならない。ティアの境目は27Bで、
   * 矛盾検知の抑制の境目（20B）とは別の実測から決まっている。
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
 * 手元で動かすAI。**どの大きさのモデルを載せるかは作者が選ぶ**ので、
 * 抑制の判断はパラメータ数で行う。
 *
 * クラウドの4社は主力が大きいモデルなので、`inferTier` が high 扱いに
 * しているのと同じ理由でゆるめる側に置く（パラメータ数も答えてくれない）。
 */
const LOCAL_PROVIDERS: readonly ProviderId[] = ["ollama", "lmstudio"];

/**
 * 矛盾検知の抑制をゆるめてよい、モデルの大きさ（パラメータ数・B）。
 *
 * **実測で決めた**（2026-09-20、製品の経路 `novel.run` で3回ずつ。設計書6.10.8）。
 *
 * | モデル | 1.5（抑制あり） | 1.6（ゆるめた） | 1.6 の誤検出 |
 * |---|---|---|---|
 * | `gemma4:e4b`（8B・いまの既定） | 0/4 | 0/4 | **1〜2件**（1.5では0） |
 * | `gemma4:12b` | 1/4 | 2/4 | **2件**（罠に掛かった） |
 * | `gemma4:26b` | 2/4 | **4/4** | **0件** |
 *
 * **12b と 26b のあいだに線を引く。** 12b はゆるめると当たりが増えた
 * 代わりに罠へ掛かり、26b だけが誤検出0で満点を出した。**小さいモデルは
 * 「疑わしい」の線引きごと失う。**
 *
 * **ティアの境目（27B）は流用しない。** あれはチャンクの重さと観点の
 * 絞りのために決めた値で、`gemma4:26b` は standard 側に落ちる——
 * 使い回すと、**満点を出したモデルが抑制される側に入る。**
 */
const LOOSE_SUPPRESSION_MIN_BILLIONS = 20;

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
 * **パラメータ数が取れないときは抑える。** このファイルの作法どおり、
 * 分からないときはこれまでと同じ判定へ落とす——矛盾検知にとっての
 * 「これまで」は 1.5＝抑制ありである。取れないのに大きいモデルとみなすと、
 * **モデル情報が取れなかった日だけ誤検出が増える**ことになる。
 */
function suppressUncertain(input: CapabilityInput): boolean {
  if (!LOCAL_PROVIDERS.includes(input.providerId)) return false;
  const billions = parameterSizeInBillions(input.parameterSize);
  if (billions === undefined) return true;
  return billions < LOOSE_SUPPRESSION_MIN_BILLIONS;
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
  const notes: string[] = [];
  if (profile.narrowContradictionCategories) notes.push("観点を絞る");
  // **抑制を残したことも黙って行わない**（設計書6.10.8）。同じモデル名でも
  // 送っている指示が違うので、出しておかないとログから読み取れない
  if (profile.suppressUncertainContradictions) notes.push("確信の持てない指摘は抑える");
  return [tier, ...notes].join("・");
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
