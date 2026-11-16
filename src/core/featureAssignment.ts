/**
 * 機能ごとのAIの割り当ての**型と決め方**（設計書6.28.7の1、共通設計書4.2）。
 *
 * ## なぜ `ai/registry.ts` から切り出したか（2026-11-16）
 *
 * モバイル版が「設定 → AI の機能ごとの割り当て」を作るのに、同じ型と同じ決め方を
 * 使いたい。`ai/registry.ts` は `vscode` に頼る（`globalState`・選ぶ窓）ので借りられない。
 * そこで**どの機能にどのプロバイダ・モデルを当てるかを決める純粋な部分**をここへ置き、
 * 拡張機能の `AIRegistry` もこれを呼ぶ。**写しを作らない**——片方にだけ機能を足すと、
 * 端末によって割り当てられる機能が食い違う。
 *
 * `vscode` も `ai/` も引き込まない（モバイル版・MCP の束から読めるように）。
 * プロバイダの種類（`ai/types.ts` の `ProviderId`）は型の引数で受け取る。
 */

/**
 * 作者が割り当てを選べる機能のまとまり。増やすときはメニューの文言も揃える。
 *
 * **粒度は「作者が使い分けたい単位」で切っている。** 内部の
 * `meta.feature`（`contradiction_verify` など）より粗いのは、
 * 矛盾検知の本体と検証だけ別のAIにしたい作者はいないため。
 */
export type AssignableFeature =
  | "extract" // 設定資料の抽出（人物・場所・能力・組織・世界観、AIで再読込・項目の充実）
  | "typo" // 誤字脱字
  | "proofread" // 推敲
  | "contradiction" // 矛盾検知（指摘の検証・再チェックも含む）
  /*
    場面の事実の抽出（P-37。設計書6.88.9）。

    **矛盾検知と分けてあるのは、要る地力が違うから**である。抽出は
    「本文に書いてあることを項目に分けて返す」定型のJSON化で、ローカルの
    小さいモデルでも足りる。一方、絞り込まれた候補2か所を見て
    「矛盾か／意図的な変化か／誤検知か」を決める工程は地力が要るので、
    そちらは `contradiction` の割当をそのまま使う（キーを増やさない）。
  */
  | "factExtract"
  | "deviation" // プロットからの逸脱
  | "foreshadow" // 伏線の検知（配置と回収。どちらも同じ台帳を見る）
  | "generate" // あらすじ・紹介文・キャッチコピー・更新告知・プロット逆算・冒頭診断・感情曲線・読者像の読み取り・適合度・ターゲットシートの助言
  | "chat" // 相談（相談パネル・設定の相談・検索語の生成・独り言・推敲の指摘の［AIに相談］）
  /*
    写真の書き起こし（P-48。設計書6.117）。**写真を読めるAIでないと動かない**
    ので、ほかの機能と相乗りさせない（相乗りすると、相談のために選んだ文字だけの
    AIへ写真を回すことになる）。
  */
  | "transcribe"
  /*
    読み上げの読みの辞書（P-50。設計書6.42.1）。**話ごとに1回走らせる軽い
    作業**で、手元の小さいモデルでも足りる。ほかの機能と相乗りさせると、
    推敲のために選んだ大きなクラウドのAIへ、押すたびに1話ぶん送ることになる。
  */
  | "readingDictionary"
  /*
    人物の声で朗読する——台詞の話者と感情の推定（P-54。設計書6.42.3）。
    読みの辞書と分けるのは、要る地力が違うから。読みは語を見るだけだが、
    話者は前後の地の文と人物の口調を突き合わせて決める。
  */
  | "voiceCast";

/**
 * 機能の表示名。**画面に出す名前はここだけが持つ。**
 * 割当の選択画面・通知・ログのすべてがこれを読む。
 */
export const ASSIGNABLE_FEATURE_LABELS: Record<AssignableFeature, string> = {
  extract: "設定資料の抽出",
  typo: "誤字脱字",
  proofread: "推敲",
  contradiction: "矛盾検知",
  factExtract: "場面の事実の抽出",
  deviation: "プロットからの逸脱",
  foreshadow: "伏線の検知",
  generate: "あらすじ・紹介文・キャッチコピーなど",
  chat: "AIに相談",
  transcribe: "写真の書き起こし",
  readingDictionary: "読み上げの読みの確かめ",
  voiceCast: "朗読の台詞の話者と感情",
};

/** 選択画面に並べる順。重い（＝手元AIの効きが大きい）ものから */
export const ASSIGNABLE_FEATURES: AssignableFeature[] = [
  "extract",
  "typo",
  "proofread",
  "contradiction",
  "factExtract",
  "deviation",
  "foreshadow",
  "generate",
  "chat",
  "transcribe",
  "readingDictionary",
  "voiceCast",
];

/** 1つの機能に当てたプロバイダとモデル。`P` はプロバイダの種類（拡張機能では `ProviderId`） */
export interface FeatureAssignment<P extends string = string> {
  provider: P;
  model: string;
}

/**
 * 保存されている割当。**キーが無い＝既定を使う。**
 *
 * 「機能別割当が有効か」のフラグは作らない（設計書6.28.7）。
 * フラグと中身の2か所が食い違うと、割り当てたのに効かない・
 * 外したのに効き続ける、という追いにくい状態ができる。
 */
export type FeatureAssignments<P extends string = string> = Partial<
  Record<AssignableFeature, FeatureAssignment<P>>
>;

/** その機能だけを当てた新しい割当（元は変えない） */
export function withAssignment<P extends string>(
  current: FeatureAssignments<P>,
  feature: AssignableFeature,
  provider: P,
  model: string
): FeatureAssignments<P> {
  return { ...current, [feature]: { provider, model } };
}

/** その機能だけを外した新しい割当（元は変えない）。外した機能は既定のAIで動く */
export function withoutAssignment<P extends string>(
  current: FeatureAssignments<P>,
  feature: AssignableFeature
): FeatureAssignments<P> {
  const next = { ...current };
  delete next[feature];
  return next;
}

/** 決めた結果 */
export interface FeatureAIDecision<P extends string = string> {
  /** 実際に使うプロバイダとモデル。既定も無ければ `undefined`（AI を選ぶ画面へ案内する） */
  choice: FeatureAssignment<P> | undefined;
  /** 割当が使えず既定へ落としたとき、その割当のプロバイダ（ログに残すため） */
  fellBackFrom?: P;
}

/**
 * その機能で使うプロバイダとモデルを決める。
 *
 * 1. 割当があり、そのプロバイダがこの環境で使えるなら、割当を使う
 * 2. 割当が使えないときは既定へ落とす。**止めない**（共通設計書4.3）。
 *    ブラウザ版で開いただけで全機能が止まるのは、作者から見て「壊れた」としか見えない
 * 3. 既定（プロバイダとモデルの両方）が無ければ `undefined`
 *
 * `"default"` は「どの機能でもない場所」用——版の表示・接続の確認など。割当を見ない。
 * **既定のプロバイダが使えるかはここでは見ない**（作者がいま選んでいるものなので、
 * 使えなければ呼んだ先で理由を出す。拡張機能の動きのまま）。
 */
export function decideFeatureAI<P extends string>(
  feature: AssignableFeature | "default",
  assignments: FeatureAssignments<P>,
  defaultChoice: { provider: P | undefined; model: string | undefined },
  isUsable: (provider: P) => boolean
): FeatureAIDecision<P> {
  const assigned = feature === "default" ? undefined : assignments[feature];
  if (assigned && isUsable(assigned.provider)) {
    return { choice: { provider: assigned.provider, model: assigned.model } };
  }
  const fellBackFrom = assigned ? { fellBackFrom: assigned.provider } : {};
  const { provider, model } = defaultChoice;
  if (!provider || !model) return { choice: undefined, ...fellBackFrom };
  return { choice: { provider, model }, ...fellBackFrom };
}
