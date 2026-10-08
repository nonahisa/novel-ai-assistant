import type { ProviderId } from "../ai/types";

/**
 * 読める長さの申告を、プロバイダごとにどう扱うか（設計書6.49・6.62.1）。
 *
 * **測定（`features/measureContext.ts`）とチャンクの大きさ
 * （`features/chunkSettings.ts`）の両方が、同じ判定を使う。** 2026-10-08 に
 * 「APIが申告するモデルには詰め物を送らない」と決めたとき、チャンクの側にも
 * 同じ線が要った（測らないモデルを「未チューニング」として 6,000字に
 * 抑え続けないため）。写しを2つ持つと片方だけ直したときに食い違うので、
 * ここへ置いて両方から読む。
 */

/**
 * 申告の文脈長が**当て推量**であるプロバイダ（設計書6.62.1）。
 *
 * ここは作者が設定（`novelai.sakura.contextWindow` など）に書いた値を
 * そのまま返してくるだけなので、**申告より長く読めるかもしれない**。
 * だから 256K までは試す。
 *
 * **ほかは信じる。** Ollama は `/api/show`、LM Studio は読み込み済み
 * モデル、Gemini・Claude は API から取れる**実測に基づく値**である。
 * 超えて送っても必ず弾かれるので、いちばん大きい1回を捨てるだけになる。
 */
export const GUESSED_CONTEXT_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "sakura",
  "openai",
]);

/**
 * 測った**上限**を台帳へ書いてよいプロバイダ。
 *
 * 申告値を取れないプロバイダ（さくら・LM Studio・ChatGPT）と、**Ollama**。
 *
 * **Ollama は申告するが、作者の実測を先に使う**（作者の裁定、2026-09-26 夕。
 * 残課題 J3。設計書 6.49.6）。申告は学習した長さで、作者の機械に載る長さ
 * ではない（`gemma4:26b` は 262,144 と申告して載らなかった。6.28.11）。
 * 読む側（`ollamaProvider` の `withMeasured`）は、実測が申告より短いときだけ
 * 使い、申告を超えては使わない。
 *
 * Gemini・Claude は入れない。クラウドの申告は機械に左右されないので、
 * 測定値で潰す理由が無い（参考表示にとどめる）。
 *
 * **待ち時間のほうは6つとも書く。** こちらはどのAIでも取りようがなく、
 * 実際に切れているのはローカルの小さいモデルとクラウドの両方である。
 */
export const CONTEXT_TUNABLE_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "sakura",
  "lmstudio",
  "openai",
  "ollama",
]);

/**
 * 読める長さの測定（詰め物を送る測定）を飛ばすか（2026-10-08。設計書6.49.10）。
 *
 * **飛ばすのは、APIが申告を返し、しかもその申告を測った値で置き換えない
 * プロバイダだけ**——いまは Gemini と Claude。測っても読める長さは何も
 * 変わらないので、数十万字の詰め物を有料で送る理由が無い。
 *
 * - **Ollama・LM Studio は測る。** 申告は学習した長さで、作者の機械に
 *   載る長さではない（`CONTEXT_TUNABLE_PROVIDERS` の説明。J3）
 * - **さくら・ChatGPT は測る。** 申告は作者が設定に書いた値で、APIからは
 *   取れない（`GUESSED_CONTEXT_PROVIDERS`）
 * - **申告が取れなかったときは測る。** これまでどおり
 *
 * チャンクの大きさの「未チューニングの安全既定」（6,000字）も、これが真の
 * モデルには掛けない（`features/chunkSettings.ts`）。測る道が無いのに
 * 「測っていない」として抑え続けることになるため。
 */
export function declaredContextSkipsProbe(
  /** チャンクの側は台帳の鍵と同じく文字列で持つので、文字列で受ける */
  providerId: string,
  declaredTokens: number | undefined
): declaredTokens is number {
  const tunable: ReadonlySet<string> = CONTEXT_TUNABLE_PROVIDERS;
  const guessed: ReadonlySet<string> = GUESSED_CONTEXT_PROVIDERS;
  return (
    declaredTokens !== undefined &&
    Number.isFinite(declaredTokens) &&
    declaredTokens > 0 &&
    !tunable.has(providerId) &&
    !guessed.has(providerId)
  );
}
