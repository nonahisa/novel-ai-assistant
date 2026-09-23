/**
 * 大きさの予算——字とトークンの換算、および「モデル比＋頭打ち」型の上限
 * （設計書6.77）。
 *
 * **葉のモジュールである。** VS Code API にも、`src/core` の他のファイルにも
 * 依存しない。大きさの計算はプロンプト組み立ての最下層から呼ばれるので、
 * ここが何かを引き込むと、依存の輪ができる（実際 `chunker.ts` は
 * `textFile.ts` を引いており、上限を知りたいだけの側からは重い）。
 *
 * ## 大きさの上限の一覧表
 *
 * 2026-09-05の全数調査で、大きさの計算・上限が**約30か所**に散らばって
 * いることが分かった（設計書6.77）。**新しい上限を作るときは、まずここを
 * 見る。** 同じ意味の値を2か所目に書くのが、これまでの食い違いの原因だった
 * （「換算はこの1つだけ」と宣言した `TOKENS_PER_CHAR` があるのに、同じ
 * 意味の `0.7` が独立して4か所あった）。
 *
 * **値は書かない。** 書けば写しになり、片方だけが直る。ここに置くのは
 * 「どこに・何の上限が・どういう種類で」あるかだけで、値は各ファイルが持つ。
 *
 * ### 種類
 *
 * - **換算**……字↔トークン。**このファイルだけが持つ**
 * - **モデル比＋頭打ち**……`referenceBudgetChars`。モデルが大きくても
 *   頭打ちで止まり、小さければ自動で縮む
 * - **モデル比**……コンテキスト長に割合を掛けるだけのもの
 * - **固定字数・固定件数**……用途ごとの判断で決め打ちしたもの。
 *   **寄せない**（それぞれの節に理由ごと書いてある）
 *
 * ### 送る量を決めるもの（コンテキストの取り合い）
 *
 * | 場所 | 何の上限か | 種類 |
 * |---|---|---|
 * | `core/sizeBudget.ts` | 字↔トークン換算 | 換算（**ここだけ**） |
 * | `core/sizeBudget.ts` | 実測の字↔トークン換算（`resolveCharsPerToken`） | 実測＋余白＋下限 |
 * | `core/sizeBudget.ts` | 参照資料の予算（`referenceBudgetChars`） | モデル比＋頭打ち |
 * | `core/worldviewSelect.ts` | 矛盾検知へ渡す世界観の字数 | モデル比＋頭打ち |
 * | `core/pastSceneSelect.ts` | 矛盾検知へ渡す過去場面の字数 | モデル比＋頭打ち |
 * | `features/checkDeviations.ts` | 逸脱検知へ渡すプロットの字数 | モデル比＋頭打ち |
 * | `core/pastSceneSelect.ts` | 過去場面の検索語数・件数 | 固定件数 |
 * | `core/chunker.ts` | チャンク字数の自動決定と上下限 | モデル比／固定字数 |
 * | `core/chunker.ts` | 固定費を引いた本文の割当 | モデル比 |
 * | `core/chunker.ts` | 未チューニング時のチャンク頭打ち | 固定字数 |
 * | `core/chunker.ts` | 書ける量からのまとめ送信の絞り | 実測比 |
 * | `core/chunker.ts` | `num_ctx` の見積もりと丸めの段 | モデル比／固定 |
 * | `core/contextProbe.ts` | 読める量の測定の始点・下限 | 固定字数 |
 * | `core/outputProbe.ts` | 書ける量の測定の始点・上限 | 固定件数 |
 * | `features/measureContext.ts` | 測定の天井・応答見込み | 固定トークン |
 * | `features/chunkSettings.ts` | 上のチャンク系を束ねる窓口 | （窓口） |
 * | `ai/contextGuard.ts` | 送信直前の入りきり判定と出力見込み | 固定トークン |
 * | `ai/outputLimit.ts` | 出力トークン上限の既定・下限 | 固定トークン |
 * | `ai/outputLimit.ts` | 台帳の実測と既定の小さいほう | 実測比＋頭打ち |
 *
 * ### 材料を切り詰めるもの（**寄せない**。用途ごとの判断）
 *
 * | 場所 | 何の上限か | 種類 |
 * |---|---|---|
 * | `features/workChatPanel.ts` | 相談へ渡す抜粋・関連資料・要求ファイル | 固定字数・固定件数 |
 * | `features/chatSettingsSync.ts` | 相談へ渡す会話履歴 | 固定字数 |
 * | `core/chatLog.ts` / `chatEdit.ts` / `chatReload.ts` | 相談ログ・発言・覚え書き | 固定字数 |
 * | `features/checkDeviations.ts` | 逸脱検知へ渡す1話ぶん | 固定字数 |
 * | `features/checkContradictions.ts` | 未来の事実の行数・引用の抜粋 | 固定件数・固定字数 |
 * | `features/checkTypos.ts` | 渡す辞書の件数 | 固定件数 |
 * | `features/extractCharacters.ts` | 抽出へ渡す既知の名前の件数 | 固定件数 |
 * | `features/generatePlot.ts` / `generateBlurb.ts` | 冒頭の抜粋 | 固定字数 |
 * | `features/generateSynopses.ts` | 直前のあらすじの件数 | 固定件数 |
 * | `features/vectorSearch.ts` | 意味検索の結果の字数 | 固定字数 |
 * | `core/mentionExcerpts.ts` / `passages.ts` | 言及の抜粋と、場面の割り方 | 固定字数 |
 * | `core/summaryLimit.ts` | 人物・能力・場所の紹介文 | 固定字数 |
 * | `core/resumeSheet.ts` / `guideSelect.ts` | 執筆再開の末尾抜粋・ガイドの予算 | 固定字数 |
 * | `features/epubEditorPanel.ts` | 画面に出す抜粋 | 固定字数・固定行数 |
 * | `core/chunkCache.ts` | キャッシュの件数と寿命 | 固定件数・固定日数 |
 *
 * ### 出力の側の上限（AIに守らせ、コードで再検証するもの）
 *
 * `prompts/*.ts` に集めてある——あらすじ150字、サブタイトル15字、
 * 紹介文300〜400字、キャッチコピー30字、伏線の見出し15字、章名20字、
 * 独り言の抜粋1,500字と本文60字、表記の助言の抜粋80字など。いずれも
 * **固定字数・固定件数**で、AIの申告を信じずコード側で測り直す（実装ルール3）。
 *
 * **この表は網羅ではない。** 上限は増え続けるので、全件を書くと必ず古くなる
 * （`src/core` の一覧を全件書いて130件以上が抜けた前歴がある）。ここに載せる
 * のは「新しい上限を作る人が、同じものが既にあると気づける」ための道しるべ
 * であって、台帳ではない。**足りなければ足す。**
 *
 * ### 見つかった重複（**第2段で片付けた**）
 *
 * 全数調査で見つかった、同じ意味の値が複数箇所にあったもの。
 * **同じ形で増やさないための覚え書き**として、どう片付けたかを残す。
 *
 * - AI応答を失敗ログへ載せるときの切り詰め字数が、`features` の14ファイル・
 *   17か所に独立して書かれていた（400字が11か所、300字が6か所に割れていた）。
 *   → `core/logger.ts` の `responseExcerptForLog`（400字）へ寄せた
 * - 引用抜粋の字数が `core/deviationValidation.ts` と
 *   `core/episodePlotValidation.ts` に同名同値で二重定義されていた。
 *   → 逸脱検知側を正として export し、単話プロット側は借りる（80字のまま）
 * - `OPENING_EXCERPT_CHARS` が `generateBlurb.ts` と `generatePlot.ts` で
 *   **同名・別値**だった。→ 値は変えず、`BLURB_…`／`PLOT_…` へ改名
 * - ログのバイト上限が `logger.ts` / `chatLog.ts` / `usageLog.ts` の3つにあり、
 *   値も割れていた。→ **値は用途ごとの判断なので変えない。**
 *   名前を用途入りにし、3つが互いの居場所を書き合う
 * - コンテキスト長の「台帳 → プロバイダ別設定 → 既定」の読み順を、
 *   ChatGPT・LM Studio・さくらが別々に持っていた。
 *   → `core/modelTuning.ts` の `resolveContextWindow` へ寄せた
 *   （**API申告のあるOllama・Gemini・Claudeは台帳を見ない**——申告が正）
 *
 * 見張っているのは `test/unit/cross/sizeBudgetStage2.test.ts` と
 * `test/unit/cross/contextWindowResolve.test.ts`。写しが復活すると落ちる。
 *
 * **第2段（挙動変更）で触る予定のもの**は設計書6.77に列挙してある
 * ——関所の出力見込み（`OUTPUT_RESERVE_TOKENS`）と実送信の既定
 * （`DEFAULT_MAX_OUTPUT_TOKENS`）が2倍違う、プロバイダによって
 * `maxOutputTokens` が効いたり効かなかったりする。
 * **このファイルは第1段（挙動不変）の産物なので、値の是正はここでしない。**
 *
 * 逸脱検知のプロット無上限は**片付いた**（`features/checkDeviations.ts` の
 * `plotMaxChars`。世界観と同じ25%・30,000字で、上限内なら挙動不変）。
 */

/**
 * 日本語1トークンあたりの文字数（安全側）。
 *
 * **換算はこの1つだけにする。** 以前は `decideChunkSize` が「0.7字/トークン」を、
 * `decideContextSize` が「1/0.7 トークン/字」を別々に書いていた。片方だけ
 * 直すと、チャンクの大きさと確保するコンテキスト長が別の前提で決まる
 * （設計書6.27.10）。その宣言をしたあとも、同じ意味の `0.7` が独立して
 * 4か所に残っていた（設計書6.77）ので、逆数のほうも名前を与えてここへ置く。
 */
export const CHARS_PER_TOKEN = 0.7;

/**
 * 日本語1文字あたりのトークン数（安全側）。`CHARS_PER_TOKEN` の逆数。
 *
 * 入力の字数からトークン数を見積もる側（`contextSizeForPrompt`・
 * 送信直前の関所・コンテキストの実測）が使う。
 */
export const TOKENS_PER_CHAR = 1 / CHARS_PER_TOKEN;

/**
 * 実測の字/トークンを、信じ始める件数（設計書6.77）。
 *
 * **1回や2回では、その回の内容を測っただけである。** 指示とJSONばかりの
 * 回と、地の文ばかりの回では字/トークンが倍近く違う。少ないうちは
 * 当て推量（`CHARS_PER_TOKEN`）のままにしておくほうが安全である。
 */
export const MIN_CHARS_PER_TOKEN_SAMPLES = 5;

/**
 * 実測に掛ける余白。
 *
 * **測った回と、次に送る回は違う内容である。** 実測1.46をそのまま
 * 使うと、少しでも詰まった内容を送ったときに見積りが足りなくなる。
 * 1割引いておけば、その分は素通りする。
 */
export const CHARS_PER_TOKEN_MARGIN = 0.9;

/**
 * 台帳（`core/modelTuning.ts` の `ModelTuning`）のうち、換算に要る欄だけ。
 *
 * **型をここで名乗る**——`sizeBudget` は葉のモジュールなので、
 * `modelTuning.ts`（VS Code に触る）を引き込めない。`ModelTuning` は
 * この形をそのまま満たすので、呼ぶ側は台帳をそのまま渡せばよい。
 */
export interface CharsPerTokenMeasurement {
  readonly charsPerToken?: number;
  readonly charsPerTokenSamples?: number;
}

/**
 * 台帳に実測があればそれを、無ければ当て推量（0.7）を返す（設計書6.77）。
 *
 * **実測は当て推量の倍あった。** 作者の送信量の記録437件で、いちばん悪い
 * モデルでも1.277字/トークン、全体では1.461字/トークン——製品が0.7と
 * 見ていた見積りの1.8倍が実際には入っていた。見積りが小さすぎると、
 * チャンクを必要以上に細かく切り、呼び出し回数と指示の送り直しが増える。
 *
 * ただし**実測をそのまま信じない。** 3つの歯止めを置く。
 *
 * 1. 件数が `MIN_CHARS_PER_TOKEN_SAMPLES` に満たなければ使わない
 * 2. `CHARS_PER_TOKEN_MARGIN` を掛けて余白を取る
 * 3. **0.7 を下回ったら 0.7 を使う**——実測のほうが悪いモデルでも、
 *    これまでより不利にしない（いまの値で動いてきた実績がある）
 *
 * **渡されなければ、いまと1バイトも同じ値を返す。** 実測が入るまでは、
 * チャンクの大きさも `num_ctx` も関所の判断も従来どおりである。
 */
export function resolveCharsPerToken(
  measured?: CharsPerTokenMeasurement
): number {
  const value = measured?.charsPerToken;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return CHARS_PER_TOKEN;
  }
  const samples = measured?.charsPerTokenSamples ?? 0;
  if (!Number.isFinite(samples) || samples < MIN_CHARS_PER_TOKEN_SAMPLES) {
    return CHARS_PER_TOKEN;
  }
  // **下回らせない**（上の3）。実測が悪いモデルでも従来の値で送る
  return Math.max(CHARS_PER_TOKEN, value * CHARS_PER_TOKEN_MARGIN);
}

/**
 * `resolveCharsPerToken` の逆数。字数からトークン数を見積もる側が使う。
 *
 * **逆数をここで作る。** 使う側が `1 / resolveCharsPerToken(...)` と
 * 書き始めると、`TOKENS_PER_CHAR` を置いたときと同じ形で写しが増える。
 */
export function resolveTokensPerChar(
  measured?: CharsPerTokenMeasurement
): number {
  return 1 / resolveCharsPerToken(measured);
}

/**
 * 台帳へ書くときの丸め（小数3桁）。
 *
 * 桁を落とすのは、設定ファイルを開いた作者が読める形にするため。
 * **切り捨てる**——丸め上げると、実測よりわずかに大きい（危ない側の）
 * 値が台帳に残る。
 */
export function roundCharsPerToken(value: number): number {
  return Math.floor(value * 1000) / 1000;
}

/**
 * すでに覚えている実測と、新しく採れた値から、**覚え直す値**を決める。
 *
 * **平均しない。これまでの最小値を覚える**（作者の裁定）。内容によって
 * 変わる値なので——指示やJSONが多い回は大きく、地の文だけの回は小さい
 * ——平均を採ると、本文を多く送る回（まさに見積りが要る回）で甘くなる。
 * 最小値なら単純で、外れ値に強く、必ず安全側へ倒れる。
 *
 * **ここに1つだけ置く。** 書き手は2つある（普段の呼び出しの関所
 * `ai/meteredProvider.ts` と、読める長さの測定 `features/measureContext.ts`）。
 * 片方に書いて片方が写すと、「最小値を覚える」という約束が静かに割れる。
 */
export function mergeCharsPerToken(
  previous: number | undefined,
  sample: number
): number {
  return previous === undefined ? sample : Math.min(previous, sample);
}

/**
 * 「モデルの上限の◯%」と「固定の頭打ち◯字」の小さいほうを取る
 * （設計書6.77の第1段）。
 *
 * 参照資料（世界観・過去場面）の上限は、この形が2か所に別々に書かれていた。
 * **固定字数だけだとモデルを小さいものに替えたときにそのまま溢れ**、
 * モデル比だけだと大きなモデルで際限なく育つ。両方が要る。
 *
 * **比率と頭打ちの値は、呼ぶ側が持つ。** 世界観に25%まわしてよいか、
 * 過去場面は10%で足りるか、は用途ごとの判断であって、共通化するのは
 * 式だけである（値まで寄せると、片方の都合でもう片方が動く）。
 *
 * コンテキスト長が分からない（`undefined`・0以下）ときは、頭打ちを返す。
 * **0を返さない**——分からないことを「使ってはいけない」と読み替えると、
 * モデル情報を取れないプロバイダで参照資料が丸ごと消える。
 *
 * @param contextWindow モデルが扱える上限（トークン）。不明なら undefined
 * @param ratio そのモデルの上限のうち、この用途へまわしてよい割合
 * @param capChars 固定の頭打ち（字）
 */
export function referenceBudgetChars(
  contextWindow: number | undefined,
  ratio: number,
  capChars: number
): number {
  if (!contextWindow || contextWindow <= 0) return capChars;
  const fromModel = Math.floor(contextWindow * ratio * CHARS_PER_TOKEN);
  return Math.min(capChars, fromModel);
}
