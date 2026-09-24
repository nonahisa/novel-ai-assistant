/**
 * 外から呼べる機能の名前（設計書6.87.15 の柱1）。
 *
 * **何も import しない。** MCPの道具（`mcp/tools/features.ts`）・許可
 * （`mcp/tools/permission.ts`）・作者の画面（`features/externalAccessPermission.ts`）
 * がここを見るので、ここが何かを指すと読み込みが循環する。
 *
 * **`core/` に置いてあるのは、拡張機能側も読むから。** 許可の画面は
 * 「外部AIが typo を使おうとしました」ではなく「誤字脱字の検知」と
 * 出さなければ、作者は何を許すのか分からない。`views`／`features` →
 * `core` の向きを守るために、表はこちらに置く。
 *
 * **`feature` は、作者が許可する単位でもある**（0.66.7）。0.66.6 までは
 * 道具ごと（`typo.run`）だったが、道具が `novel.run` の1本に束ねられた
 * いまは、**feature が道具の実体**である。
 */

/**
 * 外から呼べる機能。**この並びが一覧の並びになる**（AIが読む順）。
 *
 * 近いものを隣に置く——本文を直す系（誤字脱字・推敲・表記ゆれ）、
 * 筋を見る系（矛盾・伏線・逸脱）、書き起こす系（あらすじ・紹介文）。
 */
export const FEATURE_NAMES = [
  "typo",
  "proofread",
  "notation",
  "contradiction",
  "factContradiction",
  "foreshadow",
  "deviation",
  "episodePlot",
  "settings",
  "synopsis",
  "plotReverse",
  "chapter",
  "blurb",
  "catchphrase",
  "opening",
  "name",
  "chat",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/**
 * 作者と外部AIが読む呼び名。
 *
 * **断り文句にも、許可の画面にも出る。** `feature: typo` だけでは、
 * 作者は何を許そうとしているのか分からない。
 */
export const FEATURE_LABELS: Record<FeatureName, string> = {
  typo: "誤字脱字の検知",
  proofread: "推敲",
  notation: "表記ゆれ",
  contradiction: "矛盾検知",
  // **P-12 とは別の道である**（設計書6.88）。作者の裁定でしばらく並行させる
  // ので、呼び名も分ける——同じ「矛盾検知」だと、どちらを許すのか分からない
  factContradiction: "矛盾検知（事実の照合）",
  foreshadow: "伏線",
  deviation: "プロット逸脱",
  episodePlot: "単話プロットの緩み",
  settings: "設定資料の抽出",
  synopsis: "各話あらすじ",
  plotReverse: "プロット逆算",
  chapter: "章立て",
  blurb: "作品紹介文",
  catchphrase: "キャッチコピー",
  opening: "冒頭診断",
  name: "名前の候補",
  chat: "相談",
};

/**
 * 本文を1話ずつ見る機能。**`filePath` が要る。**
 *
 * 測定の台本（`scripts/measureScoring.mjs`）が同じ表を持っており、
 * ずれていないことを `test/unit/mcp/mcpBundledTools.test.ts` が見張る
 * ——ずれると、作品ぜんたいを1回見る機能を**話数ぶん回す**ことになる。
 */
export const FILE_TARGET_FEATURES: readonly FeatureName[] = [
  "typo",
  "proofread",
  "contradiction",
  "foreshadow",
  "settings",
  "synopsis",
  "deviation",
];

/** 本文をチャンクに切る機能。**`numCtx` が要る**（切る大きさを決めるため） */
export const CHUNKED_FEATURES: readonly FeatureName[] = [
  "typo",
  "proofread",
  "contradiction",
  // **`FILE_TARGET_FEATURES` には入れない。** 事実の照合は話をまたいで
  // 事実を追うところに値打ちがあり（第2話で折った足が、第4話でどちらか）、
  // 1話ずつ回すとその型は原理的に拾えない。切るのはチャンクだけ
  "factContradiction",
  "foreshadow",
  "settings",
];

/** AIを使わずに探す機能（`novel.detect`） */
export const DETECT_FEATURES = ["notation", "name", "proofread"] as const;

/** AIへ渡す材料だけを組む機能（`novel.material`） */
export const MATERIAL_FEATURES = ["contradiction"] as const;

/** 一覧に出す1行（`feature` の説明）。**長くしない**——AIが毎回読む */
export function featureListText(names: readonly FeatureName[]): string {
  return names
    .map((name) => `${name}＝${FEATURE_LABELS[name]}`)
    .join("／");
}
