/**
 * 機能ごとの当たりの、同梱の測定記録（作者の裁定、2026-09-23。A3④）。
 *
 * ## なぜ要るか
 *
 * 矛盾検知・誤字脱字・推敲は、**当たりがモデルの大きさで変わる**。確認画面で
 * 「この機械なら大きいモデルが使えます」と案内するとき、**「当たりが多い」と
 * 言ってよいのは測った記録があるものだけ**である。記録の無いモデルに同じ
 * ことを言えば、当て推量が実測の顔をして並ぶ。
 *
 * ## CLAUDE.md 規則6の例外（測らないと分からない値）として守ること
 *
 * | 守ること | どう守っているか |
 * |---|---|
 * | APIが教えてくれる値はAPIを優先 | **順位はここで決めない。** 勧める順は API のパラメータ数（`/api/show` の `parameter_size`）だけで決め、ここは「添える」だけ（`core/largerModelAdvice.ts`） |
 * | 作者の実測が勝つ | 作者の機械での当たりを測る口は製品にまだ無い。**時間は必ず作者の台帳（実測）から出し、ここからは出さない** |
 * | 同梱と分かるようにする | 画面の文に「同梱の測定（日付）」と必ず添える（`describeAccuracyComparison`） |
 * | 測った日付を持ち、古くなったら使わない | `measuredAt` を持つ。**プロンプトの版が変わったら黙って使わない**（`promptVersion`）——当たりは指示の書き方で動くので、版が違えば別の測定である |
 *
 * **ここに足すのは、答え付きの台で実際に測った値だけ**（`test/fixtures/seeded/`、
 * 製品と同じ経路）。「同じ系統だから同じはず」は載せない。
 *
 * VS Code API に依存しない。
 */

/** 記録を持つ機能（機能別AI割当のキーと同じ名前） */
export type AccuracyFeature = "contradiction" | "typo" | "proofread";

export interface FeatureAccuracyRecord {
  readonly feature: AccuracyFeature;
  /** プロバイダID（台帳の鍵と同じ） */
  readonly providerId: string;
  /** モデル名（API が返す名前そのもの） */
  readonly model: string;
  /** 仕込みのうち当てた数 */
  readonly hits: number;
  /** 仕込みの数 */
  readonly total: number;
  /** 測ったときのプロンプトの版。**いまの版と違えば使わない** */
  readonly promptVersion: string;
  /** 測った日（ISO 8601 の日付） */
  readonly measuredAt: string;
  /** どの台で測ったか（画面に添える短い名前） */
  readonly bench: string;
}

/**
 * 同梱の記録。出どころは引継ぎ書8章・設計書6.10.8（矛盾検知）、
 * 誤字脱字の初回測定（0.69.3）、推敲の上限変更の前後測定（0.67.0）と
 * `--repeat` の直し（0.70.9）。
 *
 * 矛盾検知は**いまの製品の送り方**で測った値を置く——0.70.8 から、20B 未満の
 * モデルには抑制を残した版が行く（6.10.8）ので、`e4b`・`12b` はその版の成績
 * （1.5 の列）、`26b` はゆるめた版の成績である。
 */
export const BUNDLED_FEATURE_ACCURACY: readonly FeatureAccuracyRecord[] = [
  // ── 矛盾検知（仕込み4・罠4の台） ──
  {
    feature: "contradiction",
    providerId: "ollama",
    model: "gemma4:e4b",
    hits: 0,
    total: 4,
    promptVersion: "1.6",
    measuredAt: "2026-09-20",
    bench: "答え付きの台（仕込み4）",
  },
  {
    feature: "contradiction",
    providerId: "ollama",
    model: "gemma4:12b",
    hits: 1,
    total: 4,
    promptVersion: "1.6",
    measuredAt: "2026-09-20",
    bench: "答え付きの台（仕込み4）",
  },
  {
    feature: "contradiction",
    providerId: "ollama",
    model: "gemma4:26b",
    hits: 4,
    total: 4,
    promptVersion: "1.6",
    measuredAt: "2026-09-20",
    bench: "答え付きの台（仕込み4）",
  },
  // ── 誤字脱字（仕込み12・罠18の台） ──
  {
    feature: "typo",
    providerId: "ollama",
    model: "gemma4:26b",
    hits: 8,
    total: 12,
    promptVersion: "1.1",
    measuredAt: "2026-09-20",
    bench: "答え付きの台（仕込み12）",
  },
  {
    feature: "typo",
    providerId: "ollama",
    model: "granite4.2:30b",
    hits: 0,
    total: 12,
    promptVersion: "1.1",
    measuredAt: "2026-09-20",
    bench: "答え付きの台（仕込み12）",
  },
  // ── 推敲・当て字（仕込み8の台） ──
  {
    feature: "proofread",
    providerId: "ollama",
    model: "gemma4:12b",
    hits: 4,
    total: 8,
    promptVersion: "1.9",
    measuredAt: "2026-09-18",
    bench: "答え付きの台（当て字8）",
  },
  {
    feature: "proofread",
    providerId: "ollama",
    model: "gemma4:26b",
    hits: 6,
    total: 8,
    promptVersion: "1.9",
    measuredAt: "2026-09-20",
    bench: "答え付きの台（当て字8）",
  },
  {
    feature: "proofread",
    providerId: "ollama",
    model: "granite4.2:30b",
    hits: 2,
    total: 8,
    promptVersion: "1.9",
    measuredAt: "2026-09-20",
    bench: "答え付きの台（当て字8）",
  },
];

/**
 * そのモデルの、いまの版で使える記録。無ければ undefined。
 *
 * **版が違う記録は返さない**（古くなったら黙って使わない）。
 */
export function accuracyRecordFor(
  params: {
    feature: AccuracyFeature;
    providerId: string;
    model: string;
    promptVersion: string;
  },
  records: readonly FeatureAccuracyRecord[] = BUNDLED_FEATURE_ACCURACY
): FeatureAccuracyRecord | undefined {
  return records.find(
    (record) =>
      record.feature === params.feature &&
      record.providerId === params.providerId &&
      record.model === params.model &&
      record.promptVersion === params.promptVersion &&
      record.total > 0
  );
}

/** 当たりの割合。比べるときだけ使う（画面には「8/12」の形で出す） */
export function accuracyRate(record: FeatureAccuracyRecord): number {
  return record.hits / record.total;
}

/**
 * 候補と、いまのモデルの記録を並べる文。**言えることが無ければ空文字。**
 *
 * - **両方に記録があり、候補のほうが多いときだけ**「当たりが多い」と言う
 * - 候補にだけ記録があるときは、数字だけを添えて比べない（いまのモデルは
 *   測っていないので、多いとも少ないとも言えない）
 * - 候補に記録が無ければ何も言わない（大きいから当たるとは言わない）
 */
export function describeAccuracyComparison(params: {
  candidateModel: string;
  candidate: FeatureAccuracyRecord | undefined;
  currentModel: string;
  current: FeatureAccuracyRecord | undefined;
}): string {
  const { candidate, current } = params;
  if (!candidate) return "";
  const source = `同梱の測定（${candidate.measuredAt}・${candidate.bench}）`;
  if (current && accuracyRate(candidate) > accuracyRate(current)) {
    return (
      `${source}では、この機能の当たりが ${params.candidateModel} で ` +
      `${candidate.hits}/${candidate.total}、いまの ${params.currentModel} で ` +
      `${current.hits}/${current.total} でした（当たりが多い側です）。`
    );
  }
  return (
    `${source}では、この機能で ${params.candidateModel} が ` +
    `${candidate.hits}/${candidate.total} を当てました` +
    (current ? "。" : `（いまの ${params.currentModel} は測っていません）。`)
  );
}
