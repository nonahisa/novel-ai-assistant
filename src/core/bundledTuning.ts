/**
 * 測って分かった値の、同梱の初期値（作者の裁定、2026-09-13）。
 *
 * 作者の提案：「ローカルLLMと違い、クラウドAIは初期値として製品に
 * 反映してもよいのではないでしょうか」。
 *
 * **なぜ要るか。** 台帳（`novelai.modelTuning`）が空のあいだ、字/トークンは
 * 当て推量の 0.7 で動く。実測が5回ぶん貯まるまで本文の量が増えないので、
 * **全員が自分の無料枠を使って同じ値を測り直している。** クラウドの値は
 * 向こうのサーバーで決まるので作者の機械と無関係だし、字/トークンは
 * トークナイザの性質なのでローカルでも機械に依存しない。
 *
 * 実測（2026-09-13）：gemma-4 系は **12B でも 31B でも、手元の Ollama でも
 * さくらでも 1.383**。qwen3:8b は 1.234、gpt-oss-120b は 1.065。
 *
 * ---
 *
 * **CLAUDE.md 規則6（モデル名をハードコードしない）の、ただ1つの例外である。**
 * 規則の狙いは「APIが教えてくれることを名前から当てにいくな」であり、
 * **測らないと分からない値の初期値**は趣旨を外さない。そのうえで、
 * 作者が決めた5つの守りを、この一覧とここの関数で守る。
 *
 * | 守ること | どう守っているか |
 * |---|---|
 * | 台帳へ書き写さない | ここは**読むときだけ**混ぜる。`saveModelTuning` は設定を直に読むので、混ぜた値が保存へ回ることはない |
 * | 作者の実測が常に勝つ | `mergeBundledTuning` は**欄ごとに、台帳に無いところだけ**埋める |
 * | 出どころを見せる | 混ぜた行に `bundled` と `bundledAt` が付き、一覧と選ぶ画面に「同梱」と出る |
 * | 分あたりの上限で頭打ちの測定は載せない | `gemini/*` を**載せていない**（`contextLimitedByRate` が立っていた） |
 * | APIが教えてくれる値はAPIを優先 | **`contextWindow` を載せない。** 申告のコンテキスト長を同梱表で上書きしない |
 *
 * VS Code APIに依存しない。
 */

/** 同梱する値。**測れたものだけ**入る（台帳と同じ約束） */
export interface BundledTuning {
  /**
   * 字/トークン（設計書6.77）。
   *
   * **ローカルも含めて載せてよい**——トークナイザの性質で、機械に依存しない。
   */
  readonly charsPerToken?: number;
  /**
   * 読める長さ（字）。**クラウドのモデルだけ。**
   *
   * ローカルは VRAM 次第で、同じモデルでも機械が変われば別の値になる。
   */
  readonly measuredChars?: number;
  /**
   * その測定が天井に当たったか（`ModelTuning.contextHitCeiling` と同じ意味）。
   *
   * 載せているのは**当たらなかった＝本当の限界**のものだけなので、
   * いまはどれも `false` である。欄を持っておくのは、一覧の「以上」の
   * 二文字が台帳の行と同じ理由で決まるようにするため。
   */
  readonly contextHitCeiling?: boolean;
  /**
   * 測った日（ISO 8601 の日付）。
   *
   * **古くなったら黙って使わない**（作者の守り4）ための手がかり。
   * `preview/` の付くモデルは、同じ名前で中身が入れ替わる。
   */
  readonly measuredAt: string;
}

/**
 * 同梱する実測の一覧。鍵は `modelTuningKey`（`providerId/model`）と同じ形。
 *
 * **ここに足すのは、実際に測った値だけ。** 「同じ系統だから同じはず」と
 * いう推測は載せない（それは実測ではなく当て推量で、規則6の例外の
 * 範囲を出る）。系統ごとの当てはめが要るなら、作者に諮ってから足す。
 */
const BUNDLED: Readonly<Record<string, BundledTuning>> = {
  /* ── さくらのAI（クラウド）───────────────────────── */
  "sakura/preview/gemma-4-31B-it": {
    charsPerToken: 1.383,
    measuredChars: 339_804,
    contextHitCeiling: false,
    measuredAt: "2026-09-13",
  },
  "sakura/gpt-oss-120b": {
    charsPerToken: 1.065,
    measuredChars: 138_425,
    contextHitCeiling: false,
    measuredAt: "2026-09-13",
  },

  /* ── Ollama（手元）。字/トークンだけ ──────────────────
     読める長さは載せない——VRAM 次第で、機械が変われば別の値になる。 */
  "ollama/qwen3:8b": {
    charsPerToken: 1.234,
    measuredAt: "2026-09-13",
  },
  "ollama/gemma4:12b": {
    charsPerToken: 1.383,
    measuredAt: "2026-09-13",
  },
};

/** そのモデルの同梱の初期値。無ければ undefined */
export function bundledTuning(
  providerId: string,
  model: string
): BundledTuning | undefined {
  return BUNDLED[`${providerId}/${model}`];
}

/** 同梱の一覧そのもの（テストと、一覧の組み立てが使う） */
export function bundledTuningKeys(): string[] {
  return Object.keys(BUNDLED);
}

/** 鍵から引く（`allModelTuning` が、台帳の鍵と突き合わせるのに使う） */
export function bundledTuningByKey(key: string): BundledTuning | undefined {
  return BUNDLED[key];
}
