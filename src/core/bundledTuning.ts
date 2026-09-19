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
 * | APIが教えてくれる値はAPIを優先 | `contextWindow` を載せるのは、**APIが申告しないプロバイダの行だけ**（下の例外） |
 *
 * ---
 *
 * ## 守り5の例外——申告が存在しないプロバイダ（作者の裁定、2026-09-19）
 *
 * 守り5の元の形は「**`contextWindow` を載せない**」だった。守ろうとして
 * いたのは「申告のコンテキスト長を同梱表で上書きしない」ことである。
 * **ところが、さくらのAI・ChatGPT・LM Studio には、その申告が存在しない**
 * ——モデル一覧APIがコンテキスト長を返さない（`ai/sakuraProvider.ts` に
 * 明記がある）。上書きされる相手が居ないのに載せないでいた結果、
 * **さくらは全モデルが既定の 32,000 で動いていた。** 31B の実測は
 * 273,001トークンなので、8分の1しか読ませていなかったことになる。
 * しかも 32,000 は申告ではなく、**製品が置いた当て推量**である。
 *
 * だから例外を1つだけ開ける。**同梱の `contextWindow` を見るのは、
 * 共通の読み順（`core/modelTuning.ts` の `resolveContextWindow`）を通る
 * プロバイダだけ**で、それはそのまま「APIが申告しないプロバイダ」の
 * 一覧である（さくら・ChatGPT・LM Studio）。Gemini・Claude・Ollama は
 * そもそもこの読み順を通らず、APIの申告を直に使う——そこは守り5の
 * 元の形のままで、同梱表が申告を上書きすることはない。
 *
 * **読む順は「台帳 → 設定 → 同梱 → 既定」。** 作者の実測（台帳）と
 * 作者が設定に書いた値は、これまでどおり同梱より常に先に来る（守り2）。
 * 同梱が割り込むのは、**これまで当て推量の既定へ落ちていた場所だけ**である。
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
   * 実効のコンテキスト長（**トークン**。`ModelTuning.contextWindow` と同じ
   * 単位・同じ意味）。**APIが申告しないプロバイダの行だけ**（上の例外）。
   *
   * **`measuredChars`（字）とは単位が違う。** 同じ測定から出た値だが、
   * 測定が数えるのは通った字数で、チャンク分割が要るのはトークン数である。
   * 製品が台帳へ書くときの換算は
   * `measuredChars ÷ (charsPerToken × 0.9)`（`contextProbe.ts` の
   * `probeCharsToTokens`。0.9 は `sizeBudget.ts` の
   * `CHARS_PER_TOKEN_MARGIN`＝安全側に1割引く余白）。
   * 31B は 339,804字 ÷ (1.383 × 0.9) ＝ 273,001トークンで、台帳の値と
   * 一致する。**ここに入れるのは、その換算まで済んだ台帳の値そのもの**
   * ——読む側で掛け算をすると、換算の写しが増えて行きと帰りでずれる。
   *
   * **実際より大きい値は入れない。** チャンク分割の基準なので、大きすぎると
   * 入力が黙って切り捨てられる（`ai/sakuraProvider.ts` の警告）。載せるのは
   * `contextHitCeiling: false`（＝探索の天井ではなく本当の限界まで測れた）
   * の測定だけである。
   */
  readonly contextWindow?: number;
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
  /*
    `preview/` の付くモデルは、**同じ名前で中身が入れ替わる。** だから
    `measuredAt` を見て古くなったら使わない——その扱いは変えていない。
  */
  "sakura/preview/gemma-4-31B-it": {
    charsPerToken: 1.383,
    measuredChars: 339_804,
    contextWindow: 273_001,
    contextHitCeiling: false,
    measuredAt: "2026-09-13",
  },
  "sakura/gpt-oss-120b": {
    charsPerToken: 1.065,
    measuredChars: 138_425,
    /*
      **この行だけ、文脈長は 2026-09-17 の測り直しから採っている**
      （作者の台帳の値）。同じ日の `measuredChars`（132,845字）で数えた
      トークン数なので、上の 138,425字 とは別の回の測定である。
      **新しいほうの測定は 09-13 より小さい**ので、こちらを載せるほうが
      安全側になる（09-13 の字数から換算すると 144,418トークンになり、
      作者が実際に測った上限を超える）。
    */
    contextWindow: 138_597,
    contextHitCeiling: false,
    measuredAt: "2026-09-13",
  },
  /*
    `sakura/preview/Qwen3.6-35B-A3B` は**読める長さを測っていない**ので、
    行ごと置いていない。「同じさくらの preview だから 31B と同じはず」は
    推測であり、この表の約束（実測だけ）を外れる。
  */

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

/**
 * 同梱の実効コンテキスト長（トークン）。無ければ undefined。
 *
 * **呼ぶのは `resolveContextWindow` だけである**（`core/modelTuning.ts`）。
 * あの読み順を通るのは、APIがコンテキスト長を申告しないプロバイダだけ
 * なので、**呼び出し口を1つに絞ることが、そのまま守り5の例外の線になる**
 * ——プロバイダ名の一覧をここへ写すと、片方だけ直したときに静かにずれる。
 */
export function bundledContextWindow(
  providerId: string,
  model: string
): number | undefined {
  return bundledTuning(providerId, model)?.contextWindow;
}

/** 同梱の一覧そのもの（テストと、一覧の組み立てが使う） */
export function bundledTuningKeys(): string[] {
  return Object.keys(BUNDLED);
}

/** 鍵から引く（`allModelTuning` が、台帳の鍵と突き合わせるのに使う） */
export function bundledTuningByKey(key: string): BundledTuning | undefined {
  return BUNDLED[key];
}
