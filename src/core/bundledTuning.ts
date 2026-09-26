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
 * ## 考えるモデルの性質と、誤字脱字の精度の目安（2026-09-26 に足した）
 *
 * AIチューニングの「仕事に近い形で測る」（設計書6.49.9）で測れた値のうち、
 * **機械に依らないもの**だけを足した。時間（1000字あたりの秒数）と
 * 待ち時間は、同じ測定で取れていても載せない（回線・GPU で変わる）。
 *
 * - 考えるモデルか・止める指定が効くか・思考に使うトークン数
 *   （`thinking*`）。台帳にどれか1つでもあれば、同梱は1つも使わない
 * - 誤字脱字の精度の目安（`typoAccuracy`）。台帳に精度の欄が1つでもあれば
 *   使わない。**頼み方か文の版が変わったら使わない**（`isTypoAccuracyCurrent`）。
 *   画面には「同梱の測定」と名乗って出る（`describeTypoAccuracyHint`）
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
   * `contextWindow` を**サーバー自身が述べた**ときの、その文の写し
   * （比べ 2026-09-25〜26 で開けた道）。
   *
   * さくらの llm-jp と Phi は、出力の上限を大きく送ったときの400の本文に
   * 「maximum context length is 4096 tokens」「max_model_len=4096」と、
   * **自分の読める長さを書いてきた。** 字を詰めて測る測定（`measuredChars`）
   * は通った字数から逆算した値だが、こちらは向こうの設定そのもので、
   * より確かである。どこから来た数字かを後から辿れるように、文をそのまま
   * 持つ（`measuredChars` を持たない行は、これが出どころの印になる）。
   *
   * **一覧APIの申告ではない。** さくらの `/v1/models` は長さを返さない
   * ので、守り5（APIの申告を上書きしない）の相手はここにも居ない。
   */
  readonly contextDeclared?: string;
  /**
   * **考えるモデルの性質**（AIチューニングの「考えるモデルかの見分け」の段。
   * 設計書6.49.9）。台帳の `thinkingSeen`・`thinkingOffWorks`・
   * `thinkingOverheadTokens` と**同じ名前・同じ意味**である。
   *
   * **ローカルも載せてよい**——思考を出すか、止める指定が効くかは、モデルと
   * その会話の雛形の性質で、作者の機械の地力とは関係ない（字/トークンと同じ
   * 扱い）。思考に使うトークン数も「何トークン考えるか」であって、何秒かでは
   * ない。
   *
   * **3つはひとまとまりで混ぜる**（`core/modelTuning.ts` の
   * `mergeBundledTuning`）。台帳にどれか1つでもあれば、同梱のほうは1つも
   * 使わない——「見分けたのは作者の機械、止める指定の効き目は同梱」と
   * 混ざると、どの見分けの結論なのか読めなくなる。
   *
   * 効くのは `thinkingOffWorks: false` の行だけで、出力の見込みに
   * `thinkingOverheadTokens` を足す（`unsuppressedThinkingTokens`）。
   * 足すのは見込みが同梱の表か当て推量から来たときだけ、という 0.89.13 の
   * 決まりは読む側（`ai/outputLimit.ts`・`ai/runTimeEstimate.ts`）が持って
   * おり、ここから来た値にもそのまま効く（二重に数えない）。
   */
  readonly thinkingSeen?: boolean;
  readonly thinkingOffWorks?: boolean;
  readonly thinkingOverheadTokens?: number;
  /** 思考を見分けた日（ISO 8601）。行の `measuredAt` とは別の回の測定のことがある */
  readonly thinkingMeasuredAt?: string;
  /**
   * **誤字脱字の精度の目安**（AIチューニングの精度の段。設計書6.49.9）。
   *
   * 台帳の `typoAccuracy*` と同じ中身を、1つにまとめて持つ。**頼み方（P-09）
   * の版か同梱の文の版が、いまのものと違えば使わない**
   * （`isTypoAccuracyCurrent`。当たりは頼み方と文で動くので、版が違えば別の
   * 測りものである）。
   */
  readonly typoAccuracy?: BundledTypoAccuracy;
  /**
   * 測った日（ISO 8601 の日付）。
   *
   * **古くなったら黙って使わない**（作者の守り4）ための手がかり。
   * `preview/` の付くモデルは、同じ名前で中身が入れ替わる。
   */
  readonly measuredAt: string;
}

/**
 * 同梱する、誤字脱字の精度の目安（1回ぶん）。
 *
 * 欄の意味は台帳の `typoAccuracy*`（`core/tuningAccuracy.ts` の
 * `TypoAccuracyRecord`）と同じ。ここでは名前の頭の `typoAccuracy` を省いた。
 */
export interface BundledTypoAccuracy {
  /** 置いた誤りのうち、正しく直した数 */
  readonly hits: number;
  /** 置いた誤りの数 */
  readonly total: number;
  /** 誤りでない所への指摘の数（罠に掛かったものを含む） */
  readonly falsePositives: number;
  /** 場所は合ったが直し方が違った数 */
  readonly wrongFixes: number;
  /** 掛かった罠の数（誤検出の内訳） */
  readonly trapHits: number;
  /** 置いた罠の数 */
  readonly trapTotal: number;
  /** 送った頼み方の版（P-09 の `typoPromptVersion`） */
  readonly promptVersion: string;
  /** 小さいモデル向けの頼み方を送ったか（版の比べ先を決める） */
  readonly smallPrompt: boolean;
  /** 同梱の文の版（`TUNING_WORK_SAMPLE_VERSION`） */
  readonly sampleVersion: string;
  /** 測った時刻（ISO 8601。作者の機械の暦で日付を出すので、時差まで書く） */
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
    /*
      **サーバーが述べた長さ（262,144）より大きく見えるが、数え方が違う**
      （2026-09-26 に確かめた。値は変えていない）。

      サーバーの 262,144 は**本物のトークン**で数えた長さである。こちらの
      273,001 は製品の換算（字 ÷（字/トークン × 0.9））で数えたトークンで、
      1割多めに数える側に倒してある。製品がこの値まで詰めて送る本文は
      339,804字で、本物のトークンに直すと 339,804 ÷ 1.383 ≒ 245,700——
      **サーバーの長さより小さい**。製品の読み順では安全側に収まっている。
    */
    contextWindow: 273_001,
    contextHitCeiling: false,
    // 考えない（止める指定を送らなくても思考が出なかった）。2026-09-26
    thinkingSeen: false,
    thinkingMeasuredAt: "2026-09-26",
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
    /*
      **考えるのに、止める指定が効かない**（2026-09-26。会話の雛形が
      `enable_thinking`・`thinking` を読まない）。止める指定を送らない回の
      思考は約3,893字で、見分けの段が 2,560トークンと見積もった。
      出力の見込みにこのぶんを足さないと、考える途中で上限を使い切り、
      答えが空で返る。
    */
    thinkingSeen: true,
    thinkingOffWorks: false,
    thinkingOverheadTokens: 2560,
    thinkingMeasuredAt: "2026-09-26",
    /*
      精度の目安は2回測って揺れた（どちらも当たり 6/7）。1回目は口語の台詞の
      罠（「左です」→「左に」）に掛かって誤検出1、2回目は誤検出0だった。
      **悪いほうの回を載せる**——目安は作者に注意を促すためのもので、
      2回に1回掛かった罠は作者の作品でも掛かりうる。良いほうを載せると、
      罠に掛からないモデルに見える。
    */
    typoAccuracy: {
      hits: 6,
      total: 7,
      falsePositives: 1,
      wrongFixes: 0,
      trapHits: 1,
      trapTotal: 5,
      promptVersion: "1.2",
      smallPrompt: false,
      sampleVersion: "2",
      measuredAt: "2026-09-26T06:28:15+09:00",
    },
    measuredAt: "2026-09-13",
  },
  /*
    **4,096しか読めない2つ**（誤字脱字検知の比べ、2026-09-25〜26）。

    どのモデルも既定の 32,000 として扱っていたため、出力の上限 11,264 を
    送って**10話すべてが HTTP 400** になった。長さは一覧APIには無く、
    サーバーが400の本文で述べた（`contextDeclared` に写しを持つ）。

    字/トークンは、誤字脱字検知のプロンプト（1,500字のチャンク）を5話ぶん
    実際に送り、`usage.prompt_tokens` から製品と同じ式（`recordCharsPerToken`
    ＝（指示＋本文の字数）÷ 入力トークン、小数3桁で切り捨て、最小値）で
    出した。**4,096の窓では、当て推量の 0.7 だと指示だけで窓が埋まる**
    ——誤字脱字の指示（約2,100字）を 0.7 で数えると約3,000トークンになり、
    本文も応答も入らない見積りになる。
  */
  "sakura/llm-jp-3.1-8x13b-instruct4": {
    // 5回の実測：1.730・1.719・1.712・1.719・1.736
    charsPerToken: 1.712,
    contextWindow: 4096,
    contextHitCeiling: false,
    contextDeclared:
      "This model's maximum context length is 4096 tokens and your request has 16 input tokens (11264 > 4096 - 16).",
    // 考えない（止める指定を送らなくても思考が出なかった）
    thinkingSeen: false,
    thinkingMeasuredAt: "2026-09-26",
    measuredAt: "2026-09-26",
  },
  "sakura/preview/Phi-4-mini-instruct-cpu": {
    // 5回の実測：1.237・1.240・1.235・1.249・1.252
    charsPerToken: 1.235,
    contextWindow: 4096,
    contextHitCeiling: false,
    contextDeclared:
      "max_tokens=11264 cannot be greater than max_model_len=max_total_tokens=4096. Please request fewer output tokens.",
    measuredAt: "2026-09-26",
  },
  /*
    **サーバーが述べた長さ 262,144 の2つ**（AIチューニングの「読める長さの
    申告」の段、2026-09-26。その長さに収まる要求がもう1回通ることまで
    確かめた）。

    **262,144 は本物のトークンで数えた長さで、そのまま載せて安全側になる。**
    製品は本文のトークン数を「字 ÷（字/トークン × 0.9）」で多めに数える
    （字/トークンが測れていない間は 0.7 の当て推量で、さらに多めに数える）。
    多めに数えたトークンが 262,144 に収まるなら、本物のトークンは必ずそれより
    少ない。

    **字/トークンは載せていない。** 測れたのは誤字脱字の頼み方を送った1〜2回
    だけで、指示の字が多い形では字/トークンが高めに出る（同じ回の 31B は
    1.61、表の 1.383 より2割高い）。高めの値を配ると本文のトークン数を
    少なく数える側に倒れるので、5回以上を本文の多い形で測るまで置かない。
  */
  "sakura/preview/Qwen3.6-35B-A3B": {
    contextWindow: 262_144,
    contextHitCeiling: false,
    contextDeclared:
      "max_tokens=2000000 cannot be greater than max_model_len=max_total_tokens=262144. Please request fewer output tokens.",
    // 考える（止める指定を送らない回の思考は約7,878字）。止める指定が効く
    thinkingSeen: true,
    thinkingOffWorks: true,
    thinkingMeasuredAt: "2026-09-26",
    /*
      精度の目安は載せない。測ったのは文の版1（罠なし）だけで、いまの版2の
      結果が無い——版の違う結果は、いまの頼み方と文の結果ではない。
    */
    measuredAt: "2026-09-26",
  },
  "sakura/preview/Kimi-K2.6": {
    contextWindow: 262_144,
    contextHitCeiling: false,
    contextDeclared:
      "max_tokens=2000000 cannot be greater than max_model_len=max_total_tokens=262144. Please request fewer output tokens.",
    // 考える（止める指定を送らない回の思考は約2,133字）。止める指定が効く
    thinkingSeen: true,
    thinkingOffWorks: true,
    thinkingMeasuredAt: "2026-09-26",
    typoAccuracy: {
      hits: 6,
      total: 7,
      falsePositives: 0,
      wrongFixes: 0,
      trapHits: 0,
      trapTotal: 5,
      promptVersion: "1.2",
      smallPrompt: false,
      sampleVersion: "2",
      measuredAt: "2026-09-26T06:29:14+09:00",
    },
    measuredAt: "2026-09-26",
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
  /*
    **考えるモデルの性質と誤字脱字の精度の目安だけ**（2026-09-26）。
    どちらもモデルの性質で、機械の地力に依らない。時間（1000字あたりの
    秒数）と待ち時間は、同じ測定で取れていても載せない——GPU に入りきるか
    （26b は作者の機械で CPU と分けて載った）で何倍も変わる。
  */
  "ollama/gemma4:e4b": {
    // 考える（止める指定を送らない回の思考は約846字）。止める指定が効く
    thinkingSeen: true,
    thinkingOffWorks: true,
    thinkingMeasuredAt: "2026-09-26",
    typoAccuracy: {
      hits: 3,
      total: 7,
      falsePositives: 0,
      wrongFixes: 0,
      trapHits: 0,
      trapTotal: 5,
      // 8.0B なので小さいモデル向けの頼み方（P-09 1.1）が行った
      promptVersion: "1.1",
      smallPrompt: true,
      sampleVersion: "2",
      measuredAt: "2026-09-26T06:29:55+09:00",
    },
    measuredAt: "2026-09-26",
  },
  "ollama/gemma4:26b": {
    // 考える（止める指定を送らない回の思考は約2,642字）。止める指定が効く
    thinkingSeen: true,
    thinkingOffWorks: true,
    thinkingMeasuredAt: "2026-09-26",
    typoAccuracy: {
      hits: 5,
      total: 7,
      falsePositives: 0,
      wrongFixes: 0,
      trapHits: 0,
      trapTotal: 5,
      promptVersion: "1.2",
      smallPrompt: false,
      sampleVersion: "2",
      measuredAt: "2026-09-26T06:31:27+09:00",
    },
    measuredAt: "2026-09-26",
  },
};

/**
 * **機能ごと**の、1回の応答に要る出力トークン数（設計書6.77の第3段）。
 *
 * モデルごとの上の表とは、鍵も単位も別物である。載せる理由も違う。
 *
 * - 上の表……「このモデルは何字読めるか」。**機械とモデルの性質**
 * - この表……「この機能は何トークン書くか」。**仕事の大きさ**
 *
 * 出力の量を決めているのは、モデルではなく**仕事のほう**である
 * （誤字脱字の指摘は本文の誤字の数だけ返り、各話あらすじは話数だけ返る）。
 * だから鍵は機能だけにしてある——`機能×プロバイダ×モデル` で分けると、
 * 実測が散らばって**いつまでも件数がしきい値に届かない。**
 */
export interface BundledFeatureOutput {
  /** 切り詰められていない回の、実測の**最大**トークン数 */
  readonly outputTokens: number;
  /**
   * 何回ぶんの実測から採ったか。
   *
   * **回数ごと載せる。** 読む側（`core/featureOutputTokens.ts`）は
   * 件数がしきい値に届いた機能だけを信じるので、少ない回数の機能は
   * 同梱しても使われない——それでよい。**1回の実測を「これがこの機能の
   * 要る量だ」と言い切るほうが危ない**（たまたま短かった回かもしれない）。
   */
  readonly samples: number;
  /** 測った日（ISO 8601 の日付）。古くなったら黙って使わないための手がかり */
  readonly measuredAt: string;
}

/**
 * 同梱する、機能ごとの出力トークンの実測。
 *
 * 出どころは作者の作品の `.aiwriter/logs/usage.md`（2026-09-19に集計）。
 * 各機能の `usage.completion_tokens` の**最大値**と、その件数である。
 *
 * ---
 *
 * **5つの守りは、モデルの表とまったく同じ形で守る。**
 *
 * | 守ること | どう守っているか |
 * |---|---|
 * | 台帳へ書き写さない | 読むときだけ混ぜる（`featureOutputTuning`）。書き込み（`recordFeatureOutputTokens`）は素の台帳だけを土台にする |
 * | 作者の実測が常に勝つ | 台帳にその機能の行があり、件数がしきい値に届いていれば（または切り詰めの印があれば）、同梱は見ない。届くまでは同梱が当て推量の代わりを続ける（0.89.6 の報告 #3） |
 * | 出どころを見せる | 混ぜた結果に `bundled` が付き、見込みを決めたときの記録（操作ログ）に「同梱」と出る |
 * | 弱い測定は載せない | 件数がしきい値未満の機能も**数字ごと**載せるが、読む側が信じない。**切り詰められた回しか無い `blurb` は行ごと置かない** |
 * | APIが教えてくれる値はAPIを優先 | 「この機能が何トークン書くか」を申告するAPIは**どこにも無い**。上書きする相手が居ないので、この守りは効く先が無い |
 *
 * ## `blurb`（紹介文）を載せていない理由
 *
 * 実測は1件で、その値は 16,384 ——**設定の上限ちょうど**である。実機で
 * 「応答が出力上限で切り詰められました」が出た回なので、**そこで切られた
 * 量**であって、要った量ではない。載せると「16,384 で足りる」と言い切る
 * ことになるが、本当はもっと要ったのかもしれない。**要る量を知らない機能は
 * 知らないままにして、設定値に任せる**（`sakura/preview/Qwen3.6-35B-A3B`
 * を行ごと置いていないのと同じ約束）。
 *
 * 切り詰められた回は、普段の呼び出しでも記録に残る
 * （`recordFeatureOutputTokens` の `truncated`）。要る量が分からない印が
 * 付くので、以後その機能の上限は設定値のままになる。
 */
const BUNDLED_FEATURE_OUTPUT: Readonly<Record<string, BundledFeatureOutput>> = {
  /* ── 件数がしきい値（3回）に届いているもの ───────────────── */
  character_extract: { outputTokens: 12_023, samples: 6, measuredAt: "2026-09-19" },
  deviation_check: { outputTokens: 9_758, samples: 5, measuredAt: "2026-09-19" },
  typo_check: { outputTokens: 8_753, samples: 3, measuredAt: "2026-09-19" },
  foreshadow_detect: { outputTokens: 5_728, samples: 3, measuredAt: "2026-09-19" },
  synopsis: { outputTokens: 4_034, samples: 5, measuredAt: "2026-09-19" },
  contradiction_verify: { outputTokens: 2_459, samples: 3, measuredAt: "2026-09-19" },

  /* ── まだ届いていないもの。**数字は残すが、使われない** ──────
     使わないのに載せるのは、次の1回で件数が足りたときに、その1回だけで
     決まってしまうのを避けるため——同梱の件数が足し算の土台になる。 */
  proofread: { outputTokens: 12_491, samples: 2, measuredAt: "2026-09-19" },
  contradiction_check: { outputTokens: 10_229, samples: 2, measuredAt: "2026-09-19" },
  contradiction_future: { outputTokens: 8_570, samples: 1, measuredAt: "2026-09-19" },
  opening_check: { outputTokens: 5_771, samples: 1, measuredAt: "2026-09-19" },
  catchphrase: { outputTokens: 4_740, samples: 1, measuredAt: "2026-09-19" },
  chapter_propose: { outputTokens: 3_550, samples: 1, measuredAt: "2026-09-19" },
};

/** その機能の同梱の初期値。無ければ undefined */
export function bundledFeatureOutput(
  feature: string
): BundledFeatureOutput | undefined {
  return BUNDLED_FEATURE_OUTPUT[feature];
}

/** 同梱している機能の一覧（テストと、見込みの説明が使う） */
export function bundledFeatureOutputKeys(): string[] {
  return Object.keys(BUNDLED_FEATURE_OUTPUT);
}

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
