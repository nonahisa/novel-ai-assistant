import * as vscode from "vscode";
import {
  AIRegistry,
  ensureConfigured,
  type AssignableFeature,
} from "../ai/registry";
import {
  AIError,
  isFatalProviderFailure,
  recoveryForAIError,
  type AIProvider,
  type ProviderId,
} from "../ai/types";
import { CONTEXT_GUARD_EXEMPT_FEATURE } from "../ai/contextGuard";
import { isLocalProvider } from "../ai/otherLocalAi";
import { resolveMaxOutputTokens } from "../ai/outputLimit";
import { contextSizeForPrompt } from "../core/chunker";
import {
  buildProbePrompt,
  charsPerTokenFromProbe,
  describeProbeResult,
  judgeProbeAnswer,
  judgeProbeGrowth,
  makeProbeWords,
  nextProbeSize,
  probeCharsPerToken,
  probeCharsToTokens,
  probeOverheadChars,
  probeTokensPerChar,
  readProbeTokens,
  startProbeState,
  worstCaseProbeChars,
  MIN_PROBE_CHARS,
  type ProbeMeasureMethod,
  type ProbeSides,
  type ProbeState,
  type ProbeTokenReading,
} from "../core/contextProbe";
import {
  CHARS_PER_TOKEN,
  mergeCharsPerToken,
  type CharsPerTokenMeasurement,
} from "../core/sizeBudget";
import { logFailure, logStep, useLogFile } from "../core/logger";
// 記録の文面だけを組む部品（設計書6.53）。**判定はここへ持ち込まない**
import { describeTuningLog } from "../core/runLog";
import {
  buildOutputProbePrompt,
  countOutputLines,
  describeOutputProbeResult,
  nextOutputProbeSize,
  startOutputProbeState,
  MAX_OUTPUT_LINES,
  OUTPUT_PROBE_SYSTEM_PROMPT,
  type OutputProbeState,
} from "../core/outputProbe";
import {
  MAX_TIMEOUT_SECONDS,
  PROBE_MAX_TIMEOUT_SECONDS,
  maxTimeoutSeconds,
  modelTuning,
  modelTuningKey,
  modelTuningRaw,
  raiseTimeoutCeilingForProbe,
  recommendTimeoutSeconds,
  resolveTimeoutSeconds,
  saveModelTuning,
  type ModelTuning,
  type TuningWriteOutcome,
} from "../core/modelTuning";
import { TUNING_STORE_FILE } from "../core/modelTuningStore";
import { outputTokensPerSecond } from "../core/tuningStats";
import {
  measuresOutput,
  TUNING_SCOPE_CHOICES,
  type TuningScope,
} from "../core/tuningScope";
import { cancelItem } from "../views/dialogs";
import { withCancellableProgress } from "../views/progress";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { readChunkSettings } from "./chunkSettings";
import { errorWithLog } from "../views/notify";

/**
 * AIチューニング（設計書6.27.11・6.49）。
 *
 * 詰め物の先頭と末尾に合言葉を置いて送り、**両方返ってくる最大の
 * 字数**を二分探索で探す。組み立てと判定は `core/contextProbe.ts`
 * にあり、ここは「送る・数える・作者へ見せる」だけを持つ。
 *
 * 測るのは長さだけではない。**かかった時間も測る**——実測（作者のログ57件、
 * 2026-08-30）では中央34秒・90%点124秒で、既定の180秒には1.45倍しか
 * 余裕が無く、ローカルの小さいモデルどころかクラウドの31Bでも6回切れていた。
 *
 * 結果は**モデルごとの台帳**（`core/modelTuning.ts`）へ入れる。プロバイダ
 * 単位の設定1つに書いていた頃は、モデルを切り替えた瞬間に別のモデルで
 * 測った値が使われていた。
 *
 * **作品は要らない。** 測っているのはモデルの性質であって、
 * 作品の性質ではない。**ログの置き場所としてだけ受け取る**——
 * 出力パネルはVS Codeを閉じると消えるので、点滅や時間切れの原因を
 * 後から追うには作品フォルダの `actions.log` にも残っている必要がある
 * （決められないときは出力パネルだけ。無理に書き先を作らない）。
 */

/**
 * 応答に見込むトークン。
 *
 * 書き写すのは合言葉2つだけだが、**余裕を持たせる。** 足りないと
 * 「承知しました。最初の合言葉は…」と前置きした機種で答えが途中で
 * 切れ、末尾の合言葉が落ちる——**読めていたのに「読めなかった」**と
 * 判定してしまう。少なすぎて誤判定するほうが、多すぎて損するより悪い。
 */
const PROBE_OUTPUT_TOKENS = 128;

/**
 * モデルのコンテキスト長が取れないときに、まとめ送信の上限を導く計算へ
 * 渡す既定値（設計書6.65.14の2）。
 *
 * `ai/ollamaProvider.ts` の `UNKNOWN_CONTEXT_WINDOW` と同じ考え方
 * ——取れないときは、これまでの既定と同じ値に倒す。
 */
const FALLBACK_CONTEXT_WINDOW = 8192;

/**
 * 申告値がどれだけ小さくても、ここまでは試す。
 *
 * 256Kトークン相当（約180,000字）。**申告値で頭打ちにしない**——
 * さくらのAI Engine の申告値は、作者が設定に書いた当て推量であり、
 * そこで止めると「申告以上に読めるか」が永久に分からない
 * （関所も、この測定のときだけ素通りする。`ai/contextGuard.ts`）。
 *
 * これ以上を既定にはしない。有料AIでは、測るだけで払う額が増える。
 */
const MIN_CEILING_TOKENS = 256 * 1024;

/**
 * 測った**上限**を台帳へ書いてよいプロバイダ。
 *
 * **申告値を取れないプロバイダだけ**が対象である。Ollama・Gemini・
 * Claude はモデル側から上限を取れるので、こちらが上書きすると
 * 「取れる正しい値」を測定値で潰すことになる（参考表示にとどめる）。
 *
 * **待ち時間のほうは6つとも書く。** こちらはどのAIでも取りようがなく、
 * 実際に切れているのはローカルの小さいモデルとクラウドの両方である。
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
const GUESSED_CONTEXT_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "sakura",
  "openai",
]);

const CONTEXT_TUNABLE_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "sakura",
  "lmstudio",
  "openai",
]);

/**
 * 1回ぶんの結果。ログの1行になる。
 *
 * **前の4つは合言葉で測ったときの言葉**で、入力トークン数で測れたときは
 * 「伸びた／伸びない」になる（作者の裁定、2026-09-13）。言葉を分けてある
 * のは、ログを後から読む作者が**どちらで測った回か**を一目で分けられる
 * ようにするためである。
 */
type RoundOutcome =
  | "伸びた"
  | "伸びない"
  | "両方"
  | "先頭のみ"
  | "末尾のみ"
  | "無し"
  | "関所で止まった"
  | "エラーで入らない"
  /**
   * 60秒待って送り直してもなお、分あたりの上限に当たった回
   * （作者の裁定、2026-09-13夜）。
   *
   * **「入らない」とは別の札を立てる。** 探索の進み方（降りる）は同じでも、
   * 理由がまるで違う——混ぜて数えると、結果の文面でどちらの話なのかが
   * 分からなくなる。
   */
  | "分あたりの上限で送れない";

/**
 * その回のエラーを「入らなかった」と数えてよいか。
 *
 * **一度でも短い長さで通っていることが条件である。**
 * 通ったことがあるなら、接続も鍵も残高も生きていると分かっている。
 * そこから長くしていって落ちたなら、原因は長さのほうである
 * （設計書6.27.11「切り捨てはクラウドならエラーで『入らない』と数える」）。
 *
 * **一度も通っていないうちのエラーは、失敗として報告する。** ここを
 * 緩めると、鍵の間違いや残高不足を「入らない」と誤魔化して、
 * 「実効の上限は0字です」のような無意味な結果を出してしまう。
 *
 * **数えてよい種別は `bad_response` と `unknown` の2つだけ**
 * （作者の依頼、2026-09-13）。理由は2つある。
 *
 * - **この2つだけが「長すぎて断られた」の実績を持つ。** さくらの
 *   gpt-oss-120b は上限超えを400で返しており、それが `bad_response` として
 *   ここへ落ちていた。`context_overflow` に分けられるようになったのは
 *   2026-08-30以降で、**古い経路や別のプロバイダでは今もここへ落ちうる**
 * - **ほかの種別は、長さについて何も言っていない。** 残高切れ
 *   （`insufficient_credit`）も鍵の失効（`authentication_failed`）も
 *   分あたりの上限（`rate_limited`）もモデルが載らない
 *   （`model_load_failed`）も、長さとは無関係に起きる。数えると、
 *   **原因の違う失敗が「実効の上限」という数字に化ける**——実機の
 *   Gemini は6回の `rate_limited` を数えられ、1,024k トークンを申告して
 *   いるのに 186,434字で頭打ちになった（2026-09-13）
 *
 * 時間切れ（`timeout`）・作者の取り消し（`aborted`）・分あたりの上限は、
 * それぞれ専用の道が `runMeasurement` にある（待ち時間を延ばす／即座に
 * 抜ける／60秒待って測り直す）。ここへ落ちてくる前に捌かれるが、
 * **万一すり抜けても数えないよう、この関数でも断っておく。**
 */
export function countErrorAsTooLong(
  hadSuccessBelow: boolean,
  error: unknown
): boolean {
  if (!(error instanceof AIError)) return false;
  if (error.kind !== "bad_response" && error.kind !== "unknown") return false;
  return hadSuccessBelow;
}

/**
 * 探索を打ち切った理由（作者の依頼、2026-09-13）。
 *
 * **`timeout` 専用の入れ物を一般化したものである。** 0.61.0 で時間切れ
 * だけを別扱いにしたが、打ち切る理由はそれだけではなかった（分あたりの
 * 上限・残高切れ・鍵の失効）。理由を足すたびに入れ物の形が変わるのを
 * 避けるため、最初から名前付きの理由として持つ。
 *
 * **分あたりの上限に当たっただけでは打ち切らない**（作者の裁定、
 * 2026-09-13夜）。2回目はいきなり天井へ跳ぶので（設計書6.59）、無料枠では
 * **天井の回で必ず当たり、1回目の短い長さしか残らない。** いまは降りて
 * 探索を続け、降りた回数を文面と台帳の印（`contextLimitedByRate`）で伝える。
 *
 * 打ち切るのは**降りた回数が蓋（`MAX_RATE_LIMIT_DESCENTS`）に届いたとき**
 * だけで、そのときの理由が `rate_limit_floor` である。「上限に当たった」
 * ではなく「**当たりすぎたので、これ以上は待たない**」であり、作者へ
 * 言うべきことも違う（待てば伸びる、ではなく、時間を置いてやり直す）。
 * **使われない理由を型に残さない**——残すと、将来うっかり使ったときに
 * 「降りた測定」を「打ち切った測定」と言うことになる（作者の裁定）。
 */
export type ProbeStopReason = "timeout" | "rate_limit_floor" | "fatal";

/** 探索を打ち切ったときの、その回の字数と理由 */
export interface ProbeStop {
  /** 打ち切ることになった回の字数 */
  chars: number;
  reason: ProbeStopReason;
  /** 時間切れのときに待った秒数 */
  seconds?: number;
  /** そのほかの止まり方のときの、エラーの本文（そのまま作者へ見せる） */
  detail?: string;
}

/**
 * 打ち切ったことと、その理由を作者へ伝える一文。
 *
 * **どの理由でも「読めなかった」とは言わない**（作者の依頼、2026-09-13）。
 * 分かったのは「測れなかった」だけである。ここを黙る、あるいは「読めない」
 * と言い換えると、作者には「このモデルはここまでしか読めない」と映り、
 * 待ち時間を延ばす・しばらく待つ・残高を足す、といった打つ手が見えなくなる。
 */
export function describeProbeStop(stop: ProbeStop | undefined): string {
  if (stop === undefined) return "";
  const chars = stop.chars.toLocaleString("ja-JP");
  switch (stop.reason) {
    case "timeout":
      return (
        `${chars} 字で時間切れになりました（待ち時間 ${stop.seconds} 秒）。` +
        "これより長い長さは測れていません。実際にはもっと読める可能性があります。"
      );
    case "rate_limit_floor":
      return (
        `${chars} 字まで降りても、AIの分あたりの上限に当たり続けました` +
        `（${MAX_RATE_LIMIT_DESCENTS} 回。合わせて ${stop.seconds} 秒待ちました）。` +
        "これ以上は待たずに、ここまでの結果を出しています。" +
        "時間を置いてから測り直すと、もっと長くなることがあります。"
      );
    case "fatal":
      return (
        `${chars} 字で「${stop.detail ?? "理由の分からない失敗"}」が返り、` +
        "そこで測定を止めました。これより長い長さは測れていません。"
      );
  }
}

/**
 * 分あたりの上限に当たったときに待つ秒数（作者の依頼、2026-09-13）。
 *
 * **待つのは1回だけ、この長さだけ。** 無料枠の窓が分単位とは限らないので、
 * 粘っても伸びる保証が無い——粘るほど有料AIでは払う額が増える。
 * `httpClient` の再試行には手を入れない（測定の中だけで待つ）。
 */
const RATE_LIMIT_WAIT_SECONDS = 60;

/**
 * 分あたりの上限で降りてよい回数（作者の裁定、2026-09-13夜）。
 *
 * **1段ごとに `RATE_LIMIT_WAIT_SECONDS` 待って測り直す**ので、段数が
 * そのまま作者の待ち時間になる。実機相当（Gemini、申告1,024kトークン）では
 * 3段で壁へ届いたが、壁が低いモデルほど段数は増え、上から見て何段かかるかは
 * 分からない。**中止はいつでも効くが、「待てば終わる」と思って待った作者を
 * 裏切らないよう、こちら側でも蓋をする。**
 *
 * 蓋に当たっても、そこまでの `low` は生かして結果を出す。
 */
const MAX_RATE_LIMIT_DESCENTS = 5;

/**
 * 待つあいだ、作者の取り消しを見に行く間隔（ミリ秒）。
 *
 * **60秒を1回で待たない。** まとめて待つと、作者が中止を押しても
 * 最大60秒は何も起きない——止まらないように見える。
 */
const RATE_LIMIT_POLL_MS = 500;

/**
 * 取り消しを見ながら待つ。最後まで待てたら true、取り消されたら false。
 *
 * **`onCancellationRequested` ではなく、刻んで見に行く。** 購読を張る形は
 * 解除の後始末が要り、待ちの途中で例外が出たときに取りこぼす。ここは
 * 「待つあいだ取り消しに気づく」だけが要件なので、短い眠りを繰り返して
 * そのたびに旗を見るほうが素直である。
 */
async function waitWatchingCancel(
  seconds: number,
  token: vscode.CancellationToken
): Promise<boolean> {
  let remainingMs = Math.max(0, seconds) * 1000;
  while (remainingMs > 0) {
    if (token.isCancellationRequested) return false;
    const step = Math.min(RATE_LIMIT_POLL_MS, remainingMs);
    await new Promise<void>((resolve) => setTimeout(resolve, step));
    remainingMs -= step;
  }
  return !token.isCancellationRequested;
}

/**
 * 時間切れになったとき、待ち時間をどこまで延ばして測り直すか。
 * 延ばせないなら undefined（もう延ばす余地が無い）。
 *
 * **倍にするだけ。** 何秒あれば足りるかはこちらには分からないので、
 * 当て推量の刻みを持ち込まない（CLAUDE.md 規則5）。上限を超えるぶんは
 * 切り詰める——それ以上待たせるくらいなら、モデルかチャンクの大きさを
 * 見直すほうが作者のためになる。
 *
 * @param maxSeconds 延ばしてよい上限。**測定は `PROBE_MAX_TIMEOUT_SECONDS`
 *   を渡す**（作者の依頼、2026-09-13）。ふだんの上限（600秒）のままだと、
 *   台帳が既に600秒のモデル——実機の gemma4:12b がそうだった——では
 *   1秒も延ばせず、時間切れがそのまま結果に化けていた。
 *   省略するとクラウドのふだんの上限（`MAX_TIMEOUT_SECONDS`。これまでの動き）。
 *   手元のAIのふだんの上限は2026-09-23から測定と同じ1800秒である
 *   （`maxTimeoutSeconds`）。
 */
export function doubledTimeoutSeconds(
  currentSeconds: number,
  maxSeconds: number = MAX_TIMEOUT_SECONDS
): number | undefined {
  if (!Number.isFinite(currentSeconds) || currentSeconds <= 0) return undefined;
  if (currentSeconds >= maxSeconds) return undefined;
  return Math.min(maxSeconds, currentSeconds * 2);
}

/**
 * その回に送る詰め物の長さから、渡す `num_ctx` を決める（設計書6.53.2）。
 *
 * **申告値に固定してはいけない。** 0.29.2 では読み込み直しを避けるために
 * 申告値へ固定したが、実機のログで害のほうが大きいと分かった（2026-08-31）。
 * 申告 262,144 の `gemma4:12b` を固定で載せると、**KVキャッシュだけで
 * 約4.9GB**（非SWA 4,096MiB＋SWA 960MiB）を確保する。モデル本体が約3.6GB
 * なので合計8.5GB——**8GBのVRAMに収まらない。**
 *
 * ここで効いてくるのが、**Ollamaは「載らない」を失敗として返さない**こと
 * である。溢れたぶんは黙ってCPUへ逃がすので、こちらから見ると成功したまま
 * 速度だけが10分の1になる。実機では16,000字の1回に264秒かかり、それより
 * 長い回は軒並み300秒で時間切れになった。結果として「実効の上限は
 * 約17,000字」という、**モデルの性質ではなく確保しすぎたメモリを測った値**
 * が出た。**多めに取っておけば安全、が成り立たない。**
 *
 * だから、その回に本当に要るぶんだけを渡す。丸めの段（4,096）は通常の
 * 呼び出しと同じものを使う——測定は長さを倍々に変えるので読み込み直しは
 * 起きるが、それは**探索の回数だけ（数回）**であり、チャンクごとに起きて
 * いた抽出中の点滅（6.53.1）とは桁が違う。
 *
 * @param promptChars その回に送るプロンプト全体の字数
 * @param ceiling モデルの申告値。取れないときは undefined
 * @returns 渡す `num_ctx`。申告値を取れないなら undefined
 *   （これまでどおりプロバイダが送る長さから決める）
 */
export function numCtxForProbe(
  promptChars: number,
  ceiling: number | undefined
): number | undefined {
  if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0) {
    return undefined;
  }
  // **頭打ちを最後に掛ける。** `contextSizeForPrompt` は下限（4,096）を
  // 上限より後に適用するので、申告が4,096未満のモデルでは申告を超えた
  // 値が返る。「申告値で頭打ち」という約束をここで守り直す
  return Math.min(
    ceiling,
    contextSizeForPrompt({
      promptChars,
      outputTokens: PROBE_OUTPUT_TOKENS,
      contextWindow: ceiling,
    })
  );
}

/**
 * 有料AIに見せる、送る量の見込み（トークン）。
 *
 * 土台は「探索の枝を全部たどったときの詰め物の合計」（`worstCaseProbeChars`）
 * で、実際にはこれより少なく済む。**そこへ測り直しの1回を足す。**
 * 時間切れになった回は同じ長さをもう一度送るので、探索のぶんだけでは
 * 足りない——最悪は上限の長さで1回なので、その分を見込む。
 *
 * **少なく見せる側へは倒さない。** 見せた額より多く請求されるのが
 * いちばん悪い（記録82で同じ判断をしている）。
 */
export function estimateProbeTokens(
  ceilingChars: number,
  /**
   * 字/トークンの実測（台帳）。
   *
   * **台帳へ書く値と同じ換算で数える**（`probeCharsToTokens`＝安全側）。
   * 天井の換算（`probeCharsPerToken`）で数えると、実際に送るトークン数より
   * 小さい数字を見せることになる——作者はこの数字を見て有料AIで「やる／
   * やめる」を決めるので、少なく見せる側へは倒さない。
   */
  measured?: CharsPerTokenMeasurement
): number {
  return probeCharsToTokens(
    worstCaseProbeChars(ceilingChars) + ceilingChars,
    measured
  );
}

/** ログと通知に載せる、エラー本文の長さ */
const ERROR_EXCERPT_CHARS = 200;

/**
 * 測定が途中で終わっても要る後始末を、外側へ渡すための入れ物。
 *
 * **`finally` で必ず戻したい**が、戻す処理は測定の中で組み立てられる
 * （延ばす前の値を知っているのはあちらだけ）。ここへ置いておけば、
 * どんな終わり方をしても外側が拾える。
 */
interface TuningCleanup {
  /** 延ばした待ち時間を戻す。台帳へ反映したときは消される */
  restoreTimeout?: () => Promise<void>;
}

/**
 * 何を測るかを訊く（設計書6.27.11。作者の依頼、2026-09-13）。
 *
 * **押したらすぐ始める形をやめた。** 読める長さは数分、書ける長さは
 * 遅いモデルで1時間以上かかるのに、これまでは続けて測るしか無かった。
 * どちらを測るかは作者にしか決められないので、ここで訊く。
 *
 * **訊くのは入口（コマンド）の仕事にしておく。** `measureContext` の側は
 * 渡された範囲を測るだけにして、呼び出し（時間切れの通知から来る経路や
 * 検査）が勝手に画面を出さないようにする。
 *
 * @returns 選ばれた範囲。取りやめたら undefined
 */
export async function askTuningScope(): Promise<TuningScope | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...TUNING_SCOPE_CHOICES.map((choice) => ({
        label: choice.label,
        detail: choice.detail,
        scope: choice.scope,
      })),
      cancelItem("取りやめる"),
    ],
    {
      title: "AIチューニング：何を測りますか",
      placeHolder: "測るものを選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || !("scope" in picked)) return undefined;
  return picked.scope;
}

/**
 * AIチューニングの入口。
 *
 * **後始末のためだけの殻である。** 中身は `runMeasurement` にあり、
 * ここは「延ばした待ち時間を必ず戻す」ことだけを引き受ける。
 *
 * 以前は戻す処理を出口ごと（失敗・中止・非反映）に置いていた。
 * **通知や設定の書き込みが投げた瞬間に、倍にした待ち時間が残る**——
 * そのモデルの全機能が以後その秒数を待つようになり、しかも
 * `logFailure` を通らないので理由がどこにも残らなかった
 * （規則5「エラーの本文を捨てない」）。
 */
export async function measureContext(
  registry: AIRegistry,
  feature: AssignableFeature | "default" = "default",
  /**
   * ログを残す作品フォルダ。**測定そのものには使わない。**
   *
   * 渡されなければ出力パネルにだけ残す（これまでの動き）。作品を
   * 決めるために作者へ問いかけはしない——測るのはモデルの性質であって、
   * どの作品を選んでも結果は同じなので、訊く理由が無い。
   */
  workFolderPath?: string,
  /**
   * 何を測るか（設計書6.27.11）。
   *
   * **既定は「両方」——これまでの動きである。** 範囲を選ばせるのは入口
   * （`askTuningScope`）の仕事で、ここは渡されたぶんを測るだけにしてある。
   * 省略したときに画面を出すと、時間切れの通知から呼ばれた経路や検査が
   * 勝手に選択画面を開くことになる。
   */
  scope: TuningScope = "both"
): Promise<void> {
  // **ここで先に決める。** 中で失敗しても、その失敗がファイルに残る
  if (workFolderPath) useLogFile(workFolderPath);

  const cleanup: TuningCleanup = {};
  /*
    **測定のあいだだけ、待ち時間の上限を上げる**（作者の依頼、2026-09-13）。

    上げるのは**読む側の線**である（`tunedTimeoutSeconds`）。台帳へ
    1,200秒と書いても、読む側が600秒で挟んでいてはプロバイダは600秒しか
    待たない——書いたのに効かない状態になる。

    ここで上げたぶんは `finally` が必ず戻す。台帳のほうは、反映しても
    `recommendTimeoutSeconds` がふだんの上限で挟み、反映しなければ元の値へ
    戻すので、**測定のあいだ延ばした値がふだんの呼び出しへ持ち込まれることは
    ない。**（2026-09-23 から手元のAIはふだんの上限も1800秒なので、上がるのは
    クラウドだけ。600秒の話はクラウドのこと）
  */
  const restoreTimeoutCeiling = raiseTimeoutCeilingForProbe();
  try {
    await runMeasurement(registry, feature, cleanup, scope);
  } catch (error) {
    // 測定そのものの失敗は `runMeasurement` が中で捌く。ここへ来るのは
    // 通知や設定の書き込みが投げたとき——黙って消さず、ログと通知へ出す
    reportFailure(error);
  } finally {
    // **台帳より先に上限を戻す。** 戻す書き込み（`restoreTimeout`）が
    // 何秒を読むかは、線が元へ戻ってからのほうが素直である
    restoreTimeoutCeiling();
    await cleanup.restoreTimeout?.();
  }
}

async function runMeasurement(
  registry: AIRegistry,
  /**
   * どの機能のAIを測るか。
   *
   * **省略すると既定のAIを測る**（コマンドパレットから呼ばれたとき）。
   * **時間切れの通知から呼ばれたときは、その機能のキーが渡る**——
   * 機能別割当（設計書6.28.9）があると、既定と実際に使ったAIが別物になる。
   * 誤字脱字だけ「さくら / gpt-oss-120b」を割り当てている作者が、さくらで
   * 時間切れになってボタンを押したのに既定のOllamaを測る、という食い違いが
   * 起きていた。台帳の鍵まで `ollama/…` になるので、**さくらの待ち時間は
   * 1秒も変わらない**（作者には「測ったのに直らない」としか見えない）。
   */
  feature: AssignableFeature | "default",
  /** 延ばした待ち時間を戻す手を、外側（`measureContext`）へ預ける入れ物 */
  cleanup: TuningCleanup,
  /** 何を測るか。「両方」のときの道筋は、これまでと同じである */
  scope: TuningScope
): Promise<void> {
  const resolved = await ensureConfigured(registry, feature);
  if (!resolved) return;

  /*
    **繋がるかを、いちばん先に確かめる**（設計書6.51）。

    ここは「AIが止まっている」に最初にぶつかる機能である——時間切れの通知
    から誘われて押した作者が、「Ollamaに接続できません」とだけ言われて
    起動する手立てが無かった（作者の報告、2026-08-30）。

    置くのは `resolveModelInfo` より前。止まったままでは申告値も取れず、
    測れる上限を実際より小さく見積もったまま先へ進んでしまう。
    費用の確認より前でもある——繋がらないと分かっているのに
    料金の話をしても意味がない。

    モデル名を渡す。LM Studioをこの場から起こしたとき、起こした直後に
    読み込ませるために要る（`aiConnectivity.ts`）。
  */
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "AIチューニング",
      resolved.model
    ))
  ) {
    return;
  }

  const modelInfo = await registry.resolveModelInfo(feature);
  const declaredTokens = modelInfo?.contextWindow;

  /*
    **書ける長さだけを測るときは、ここで分かれる**（作者の依頼、2026-09-13）。

    読める長さの測定にも、その結果を反映するかの確認にも入らない。
    測っていないものの数字を混ぜたダイアログは、作者には「勝手に何かを
    書き換えられた」としか読めない。
  */
  if (scope === "output") {
    await runOutputOnly(resolved.provider, resolved.model, declaredTokens);
    return;
  }

  /*
    **天井は、このモデルの実測の換算で置く**（設計書6.77）。

    0.7という当て推量で字へ直していた頃、天井は窓の半分あたりに落ちて
    いた（実機、2026-09-13。qwen3:8b で56%、gemma4:12b で50%）。
    測り足りないことは「これ以上は試していません」としか表に出ないので、
    ここでは**測りすぎる側へ倒す**（`probeCharsPerToken`）。
  */
  const measuredBefore = modelTuning(resolved.provider.id, resolved.model);
  // **申告が実測に基づく相手は、そこを超えて試さない**（設計書6.62.1）。
  // 当て推量なのは、作者が設定に書く さくら・ChatGPT だけである
  const ceilingChars = ceilingCharsFor(
    declaredTokens,
    !GUESSED_CONTEXT_PROVIDERS.has(resolved.provider.id),
    measuredBefore
  );

  // **見込みは安全側の換算で数える。** 有料AIでは、この数字がそのまま
  // 作者の「やる／やめる」の判断材料になる（少なく見せる側へ倒さない）
  const estimateTokens = estimateProbeTokens(ceilingChars, measuredBefore);
  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel: "AIチューニング",
    remember: { id: "ai.paid.measureContext" },
    model: resolved.model,
    detail:
      `最大で約 ${ceilingChars.toLocaleString("ja-JP")} 字まで、` +
      "長さを変えながら10回ほど送ります。\n" +
      `送る量は、多く見て合計 約 ${estimateTokens.toLocaleString("ja-JP")} ` +
      "トークンです（途中で決まれば、これより少なく済みます）。\n" +
      "送るのは検査用の詰め物だけで、作品の本文は送りません。",
  });
  if (!ok) return;

  // 台帳の鍵。ログにも通知にも出す——**どのモデルの話かを取り違えさせない**
  const tuningKey = modelTuningKey(resolved.provider.id, resolved.model);

  /*
    **なぜこの天井になったのかを、ログだけで追えるようにする。**

    実測の換算を使った回と使っていない回では、同じモデル・同じ申告値でも
    天井が倍近く違う。断りが無いと、実機のログを後から読んだときに
    「前回と数字が違う」以上のことが分からない。

    実測が 0.7 を下回って据え置いたときは**断りを書かない**——使ったのは
    従来と同じ 0.7 なのだから、「実測を使用」と名乗るのは嘘になる。
  */
  const probeRatio = probeCharsPerToken(measuredBefore);
  logStep(
    `読める長さの測定を開始: ${resolved.provider.displayName} / ` +
      `${tuningKey} / 申告 ${declaredTokens ?? "不明"} トークン / ` +
      `測れる上限 ${ceilingChars} 字` +
      (probeRatio === CHARS_PER_TOKEN
        ? ""
        : `（字/トークンの実測 ${probeRatio} を使用）`)
  );

  /*
    **測る前に、何が変わって何が変わらないかを言う**（作者の報告、
    2026-09-19）。

    Ollama は読める長さを自分で申告する（`/api/ps` が `context_length` を
    返す）ので、測った長さで申告値を置き換えない
    （`CONTEXT_TUNABLE_PROVIDERS`）。作者はそれを知らずに12分かけて測り、
    申告より短い値が出て、**それが捨てられたように見えた。**

    **選択肢は消さない。** この測定は無駄ではない——待ち時間の見立て、
    字/トークンの実測、そしてチャンクの大きさの上限（測っていないモデルは
    6,000字に抑えられる。`core/chunker.ts` の `capUntunedChunkChars`）が
    ここで決まる。だから消さずに、**始まる前に断っておく。**

    **止めない（押させない）。** 有料AIの確認とは別物で、ここで待たせる
    ほどの話ではない。無料のローカルAIには確認そのものが出ないので、
    伝える場所がここしか無い。
  */
  if (
    !CONTEXT_TUNABLE_PROVIDERS.has(resolved.provider.id) &&
    declaredTokens !== undefined
  ) {
    /*
      **「置き換えません」とは書かない。** その言い回しは、打ち切った測定が
      前の記録より小さいときの断り（`offerToSave`）で使っている。同じ言葉が
      違う意味で2度出ると、作者はどちらの話か分からなくなる。
    */
    void vscode.window.showInformationMessage(
      `${resolved.provider.displayName} は読める長さを自分で申告します` +
        `（${declaredTokens.toLocaleString("ja-JP")}トークン）。` +
        "この測定のあとも、読める長さはその申告値を使い続けます。" +
        "ここで決まるのは、待ち時間・チャンクの大きさ・字/トークンの換算です。"
    );
  }

  /**
   * `num_ctx` の上限。**上限であって、固定値ではない**（設計書6.53.2）。
   *
   * 各回に渡す値は `numCtxForProbe` が送る長さから決め、この値で頭打ちに
   * する。固定にすると、短い回でも申告ぶんのKVキャッシュを確保して
   * GPUから溢れ、**黙ってCPUへ落ちる**（そちらの理由は `numCtxForProbe`）。
   */
  const numCtxCeiling =
    declaredTokens !== undefined &&
    Number.isFinite(declaredTokens) &&
    declaredTokens > 0
      ? declaredTokens
      : undefined;
  /** 実際に渡したうちの最大値。結果に添えるために覚える */
  let largestNumCtxUsed: number | undefined;
  /**
   * 一度でもモデルが載って応答が返ったか。
   *
   * **`low` の代わりに使う。** `low` は「合言葉が両方返った」ときだけ
   * 増えるので、「載ったが写し損ねた」回を数え落とす（`model_load_failed`
   * の扱いを分けるときに、それでは誤診断になる）。
   */
  let everLoaded = false;
  logStep(
    numCtxCeiling === undefined
      ? "読める長さの測定：num_ctx は指定しません（申告値を取れませんでした）。"
      : `読める長さの測定：num_ctx は送る長さに合わせます（上限 ${numCtxCeiling}）。`
  );

  const sides: ProbeSides = { headDropped: false, tailDropped: false };
  /**
   * 採用した入力トークン数の読み取り。**長さの判定はここで行う**
   * （作者の裁定、2026-09-13。設計書6.27.11）。
   */
  const readings: ProbeTokenReading[] = [];
  /**
   * そのうち「全部届いた」と判定できた回。
   *
   * **字/トークンの傾きは、ここからしか採らない。** 切られた回を混ぜると
   * 傾きが寝て、実際より大きい（＝危ない側の）換算が出る。
   */
  const fittingReadings: ProbeTokenReading[] = [];
  /** 入力トークン数で判定できた回数 */
  let tokenRounds = 0;
  /** 入力トークン数を使えず、合言葉へ落ちた回数 */
  let wordRounds = 0;
  /**
   * 本文は届いていたのに合言葉を書き写せなかった、いちばん長い字数。
   *
   * **参考として結果に添えるだけ。** ここで長さを縮めない——縮めたら、
   * 合言葉で測っていた頃と同じ間違いをくり返すことになる。
   */
  let wordCopyFailedChars: number | undefined;
  /** 全部届いたと判定できた最大の字数 */
  let low = 0;
  let rounds = 0;
  /** エラーを「入らなかった」と数えた回数。作者へも件数で伝える */
  let errorsCountedAsTooLong = 0;
  /**
   * 分あたりの上限（`rate_limited`）のせいで短いほうへ降りた回数
   * （作者の裁定、2026-09-13夜）。
   *
   * **`errorsCountedAsTooLong` とは別に持つ。** どちらも「その長さは
   * 送れなかった」として探索を降りるが、理由が違う——同じ数に混ぜると、
   * 結果の文面が「長すぎたのか、枠を使い切ったのか」を言えなくなる。
   * 1回でも降りたら、その旨を必ず作者へ伝える（台帳にも印を残す）。
   */
  let rateLimitDescents = 0;
  /**
   * 「両方」が返った回のうち、いちばん時間がかかった秒数。
   *
   * **「両方」の回だけを数える。** 上限を大きく超えた回も時間はかかるが、
   * その長さは結局使わないので、待ち時間の見立てに混ぜると実際より
   * 長い設定になる。
   */
  let longestResponseSeconds = 0;
  /** 測定の途中で待ち時間を延ばしたなら、その秒数。延ばしたのは1回だけ */
  let raisedTimeoutSeconds: number | undefined;
  /**
   * 探索を**打ち切った**ときの、その回の字数と理由（作者の依頼、2026-09-13）。
   *
   * **どの理由も「入らなかった」ではない。** 時間切れも、分あたりの上限も、
   * 残高切れも、それ以上の長さが**測れていない**だけであって、読めないと
   * 決まったわけではない。そこで探索をやめ、ここまでの `low` を生かして
   * 終える。何字でどう止まったのかは、結果の文面で必ず言う。
   */
  let probeStop: ProbeStop | undefined;
  /**
   * 延ばす前に台帳へ入っていた待ち時間。**`undefined` は「欄が無かった」。**
   *
   * 「延ばしたかどうか」はこの値では判定できない（元から欄が無かった場合と
   * 区別が付かない）ので、必ず `raisedTimeoutSeconds` のほうで見る。
   */
  let timeoutBeforeRaise: number | undefined;
  let failure: unknown;
  /**
   * `num_ctx` を下限まで下げても載らなかったときの失敗。
   *
   * **ほかの失敗と分けて持つ。** 原因が「長さ」ではなく「モデルが
   * この機械に載らない」ことだと言い切れる唯一の場面なので、
   * 案内もそれ専用にする。
   */
  let loadFailure: AIError | undefined;
  let cancelled = false;

  /**
   * 待ち時間を延ばして台帳へ書く。書けたら true。
   *
   * **書けなくても測定は続ける。** 設定の書き込みが失敗する環境
   * （読み取り専用の設定など）はありうるが、そのために測定そのものを
   * 落とすほどのことではない。延ばせなかったのなら、この回は
   * これまでどおり「入らない」と数えて先へ進む。
   *
   * **ほかの欄は `saveModelTuning` が守る**（生の設定値へ、この欄だけを
   * 差し替える）。ここで現在値を読んで丸ごと書き戻すと、作者が手で書いた
   * 読めない欄まで巻き添えで消える。
   */
  const raiseTimeout = async (seconds: number): Promise<boolean> => {
    // **素の台帳を読む。** ここで読むのは「元へ戻す値」であり、
    // 同梱の初期値が混ざると、作者が書いていない値へ戻すことになる
    const current = modelTuningRaw(resolved.provider.id, resolved.model);
    try {
      const outcome = await saveModelTuning(
        resolved.provider.id,
        resolved.model,
        { timeoutSeconds: seconds }
      );
      /*
        **台帳が受け取らなかったなら、延ばせていない**（作者の報告、
        2026-09-19）。書き込みは書けなくても例外を投げないので、
        ここで札を見ないと「延ばした」ことにしてしまう——結果の文面に
        「待ち時間を一時的に◯秒へ延ばして測り直しました」と出るのに、
        プロバイダが読む値は1秒も変わっていない、という嘘になる。
      */
      if (outcome !== "written") {
        logStep(
          "読める長さの測定：待ち時間を延ばせませんでした" +
            `（${describeTuningWriteFailure(outcome)}）。`
        );
        return false;
      }
      // **書けたときだけ覚える。** 書けていないのに戻しにいくと、
      // 作者が自分で入れた値をこちらが消してしまう
      timeoutBeforeRaise = current?.timeoutSeconds;
      // ここから先はどんな終わり方をしても戻す。外側の `finally` が拾う
      cleanup.restoreTimeout = restoreTimeout;
      return true;
    } catch (error) {
      logStep(
        "読める長さの測定：待ち時間を延ばせませんでした" +
          `（${error instanceof Error ? error.message : String(error)}）。`
      );
      return false;
    }
  };

  /**
   * 延ばした待ち時間を、延ばす前へ戻す。
   *
   * **押していないのに設定が変わっているのは、この作品の原則
   * （作者が押したときだけ書く）に反する。** 測り直しのために一時的に
   * 書き換えるのは構わないが、反映されなかった終わり方——断られた・
   * 中止した・失敗した——のすべてで元へ戻す。
   *
   * 元が「欄が無かった」なら `undefined` を渡して欄ごと消させる
   * （`saveModelTuning` の約束）。ほかの欄はあちらが守る。
   *
   * **ここから外へ例外を出さない。** 呼ぶのは `finally` の中であり、
   * ここで投げると本来の失敗を覆い隠してしまう。
   */
  const restoreTimeout = async (): Promise<void> => {
    if (raisedTimeoutSeconds === undefined) return;
    try {
      await saveModelTuning(resolved.provider.id, resolved.model, {
        timeoutSeconds: timeoutBeforeRaise,
      });
      logStep(
        `読める長さの測定：反映しなかったので、${tuningKey} の待ち時間を` +
          (timeoutBeforeRaise === undefined
            ? "測る前（設定なし）"
            : `${timeoutBeforeRaise}秒`) +
          "へ戻しました。"
      );
    } catch (error) {
      // **戻せなかったことは黙らない。** 延ばした値が残ったままになる
      logStep(
        `読める長さの測定：延ばした待ち時間（${raisedTimeoutSeconds}秒）を` +
          `戻せませんでした。${tuningKey} に残っています` +
          `（${error instanceof Error ? error.message : String(error)}）。`
      );
    }
  };

  await withCancellableProgress(
    "AIチューニング：読める長さと待ち時間を測っています",
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      let state: ProbeState | undefined = startProbeState(ceilingChars);
      while (state) {
        // 回と回の間で押されたときは、次を送らずに抜ける。
        // 送っている最中の中止は `signal` が受ける
        if (token.isCancellationRequested) {
          cancelled = true;
          return;
        }
        rounds += 1;
        // **絞り込みを控えに取る。** `state` はこの回の中で何度か
        // 書き換わるので、そのたびに `ProbeState | undefined` へ戻る
        const round: ProbeState = state;
        const size = round.current;
        progress.report({
          message: `${size.toLocaleString("ja-JP")} 字を送っています（${rounds}回目）…`,
        });

        let outcome: RoundOutcome | undefined;
        /** その回にかかった秒数。ログと、待ち時間の見立てに使う */
        let seconds = 0;
        /**
         * この長さについて、分あたりの上限で1回測り直したか。
         *
         * **長さごとに数え直す。** 上限の窓は時間で流れるので、別の長さで
         * 当たったことを理由にこの長さを諦める筋が無い。逆に同じ長さで
         * 2回当たったら、そこは待っても抜けないと見て打ち切る。
         */
        let rateLimitRetried = false;

        // **同じ長さを2回送ることがある。** 時間切れになった回だけ、
        // 待ち時間を倍にして測り直す（作者の依頼、2026-08-30）。
        // `outcome` が決まらないうちは、この回がまだ終わっていない
        while (outcome === undefined) {
          // **毎回ちがう合言葉にする。** 同じ語を使い回すと、
          // プロンプトキャッシュの効いた回が「読めた」に見えかねない
          const { headWord, tailWord } = makeProbeWords(Math.random);
          const prompt = buildProbePrompt({
            fillerChars: size,
            headWord,
            tailWord,
          });

          // **その回に要るぶんだけを渡す。** 上限で頭打ちにする
          const numCtx = numCtxForProbe(
            prompt.systemPrompt.length + prompt.userPrompt.length,
            numCtxCeiling
          );
          if (numCtx !== undefined) {
            largestNumCtxUsed = Math.max(largestNumCtxUsed ?? 0, numCtx);
          }

          const sentAt = Date.now();
          try {
            const response = await resolved.provider.generate({
              systemPrompt: prompt.systemPrompt,
              userPrompt: prompt.userPrompt,
              model: resolved.model,
              // 書き写すだけなので、揺らす理由がまったく無い
              temperature: 0,
              // **見込みであって、上限ではない**（設計書6.77の第2段）。
              // 128は「合言葉2つ＋前置きが収まる」ための確保であって、
              // 「そこまでしか書くな」ではない。上限として送ると、前置きの
              // 長い機種で末尾の合言葉が落ち、**読めていたのに「読めなかった」**
              // と判定する——下の `PROBE_OUTPUT_TOKENS` のコメントが恐れて
              // いるのは、まさにこれである
              plannedOutputTokens: PROBE_OUTPUT_TOKENS,
              // **その回に要るぶんだけ。** 申告値に固定すると、確保した
              // KVキャッシュがVRAMから溢れて黙ってCPUへ落ちる（6.53.2）
              numCtx,
              /*
                **思考は必ず切る。外すと測定が壊れる**（実機、2026-09-13。
                qwen3:8b・詰め物4,000字）。

                - 思考を切らず出力を128に絞ると、考えごと488字で枠を使い切り
                  **答えは空**（`done_reason=length`）。「読めなかった」と
                  誤判定して探索が下へ降りる
                - 思考だけ切れば、出力9トークンで**両方正解**
                - 出力の枠だけ広げて思考を残すと、考えごと750字のあと
                  指示文をオウム返しした

                手元のAIでは出力に上限を掛けない（`ai/ollamaProvider.ts` は
                `capOutputTokens` のときだけ `num_predict` を送る）ので、
                上の128は確保の見込みにしか効かない。**効くのはこの一行**で、
                CLAUDE.md 規則6「`think: false` で思考モードを無効化する」
                そのものである。
              */
              disableThinking: true,
              /*
                **流し受信は使わない**（設計書6.63.1。2026-09-03）。

                測っているのは**配布物が通る道**の性能である。開発ビルドで
                だけ通る実験の道で測った値を、台帳（`core/modelTuning.ts`）
                の待ち時間として書くのは筋が通らない。加えて流す道は断片ごとに
                待ちを数え直すので、時間切れを「入らない」と数えるこの測定の
                前提（絶対の締め切りがあること）が崩れる。
              */
              disableStreaming: true,
              // 作品に属さない呼び出しなので workFolder は付けない
              // （どこかの作品の送信量に混ぜると、その作品の数字が狂う）。
              //
              // **機能名は関所側の定数から取る。** 文字列を写すと、
              // 片方を直したときに素通りの例外が静かに外れ、
              // 測定が申告値で頭打ちになったことに誰も気づけない
              meta: { feature: CONTEXT_GUARD_EXEMPT_FEATURE },
              signal: controller.signal,
            });
            seconds = elapsedSeconds(sentAt);
            // **返ってきた＝モデルは載った。** 合言葉を写せたかとは別である
            everLoaded = true;
            const judged = judgeProbeAnswer(response.text, headWord, tailWord);

            /*
              **長さの判定は、入力トークン数の伸びで行う**（作者の裁定、
              2026-09-13。設計書6.27.11）。

              合言葉は「言うことを聞くか」しか測れず、実機では長さと
              関係なく気まぐれに落ちた。入力トークン数なら、切り捨ては
              数字にそのまま出る——**モデルの協力が要らない。**

              トークン数を返さないAI・設定はあるので、そのときだけ
              これまでどおり合言葉へ落とす（下の `else`）。
            */
            const promptChars =
              prompt.systemPrompt.length + prompt.userPrompt.length;
            const read = readProbeTokens({
              promptChars,
              usage: response.usage,
              readings,
            });

            if (read.kind === "採用") {
              tokenRounds += 1;
              const growth = judgeProbeGrowth(read.reading, readings);
              readings.push(read.reading);
              if (growth.grew) fittingReadings.push(read.reading);
              outcome = growth.grew ? "伸びた" : "伸びない";
              logStep(
                `読める長さの測定：${size}字 → 入力トークン ` +
                  `${read.reading.inputTokens}（${growth.note}）`
              );
              // **合言葉は参考にとどめる。** 本文が届いていたことは
              // トークン数で分かっているので、写せなかったからといって
              // 「読めなかった」とは数えない
              if (growth.grew && !(judged.head && judged.tail)) {
                wordCopyFailedChars = Math.max(wordCopyFailedChars ?? 0, size);
                logStep(
                  `読める長さの測定：${size}字 → 本文は届いていましたが、` +
                    "合言葉は書き写せませんでした（長さの判定には使いません）"
                );
              }
            } else {
              wordRounds += 1;
              logStep(
                `読める長さの測定：${size}字 → 入力トークン数を使えません` +
                  `（${read.reason}）。合言葉で判定します`
              );
              outcome = judged.head
                ? judged.tail
                  ? "両方"
                  : "先頭のみ"
                : judged.tail
                  ? "末尾のみ"
                  : "無し";
            }

            // 応答が上限で切れると、合言葉が答えの中から落ちる。
            // 「読めていない」と取り違えないよう、記録に残す
            if (response.truncated) {
              logStep(
                `読める長さの測定：${size}字 → 応答が出力上限で切れました（判定が甘くなります）`
              );
            }
          } catch (error) {
            seconds = elapsedSeconds(sentAt);
            // 作者が止めたときは、途中まででも分かったことを見せる
            if (error instanceof AIError && error.kind === "aborted") {
              cancelled = true;
              return;
            }

            /*
              **読み込めなかったのが「長さのせい」かどうかは、下で通って
              いるかで決まる。**

              `num_ctx` を送る長さに合わせるようにしたので（6.53.2）、
              確保量はその回の長さに比例する。したがって：

              - **一度も通っていない**なら、いちばん短い回すら載らなかった
                ということ。長さを変えても直らないので、**モデルがこの機械に
                大きすぎる**と伝えて止める
              - **下で通っている**なら、モデル自体は載っている。この回だけ
                載らなかったのは長さのせいなので、ふつうに「入らない」と
                数えて探索を続ける

              固定していた頃（0.29.2）は確保量が長さと無関係だったため、
              どの回でも同じように失敗した。だから「入らない」と数えては
              いけなかった。**前提が変わったので、扱いも変える。**
            */
            if (error instanceof AIError && error.kind === "model_load_failed") {
              /*
                **「載ったことがあるか」で見る。`low` では見ない**（0.29.6）。

                `low` が増えるのは「合言葉が**両方**返った」回だけである。
                小さいモデルは、載ってはいるが写し損ねる（「無し」）ことが
                あり、そのとき `low` は 0 のままになる。そこから短い長さへ
                降りて読み込みに失敗すると、**より大きい num_ctx で載って
                いたのに**「このモデルはこの機械には大きすぎる」と言って
                しまう。見るべきは「一度でも生成が返ったか」である。
              */
              if (!everLoaded) {
                loadFailure = error;
                return;
              }
              const reason = (error.detail ?? error.message).slice(
                0,
                ERROR_EXCERPT_CHARS
              );
              errorsCountedAsTooLong += 1;
              logStep(
                `読める長さの測定：${size}字 → この長さではモデルを読み込めません` +
                  `でした。「入らない」と数えます（${reason}）`
              );
              // **`outcome` を決めて、この回を抜ける。**
              // `continue` にすると内側のループ（同じ長さの送り直し）が
              // 回り続ける。`break` でないと、下の `countErrorAsTooLong`
              // にも掛かって同じ回を2回数えてしまう
              outcome = "エラーで入らない";
              break;
            }

            // **時間切れは「長すぎた」とは限らない。** 待ち時間の設定が
            // このモデルに合っていないだけかもしれず、そのまま
            // 「入らない」と数えると実効の上限を実際より短く見積もる。
            // **台帳へ先に書いてから測り直す**——`generate` に待ち時間を
            // 渡す口が無いので、プロバイダが読む値を変えるしかない。
            // 台帳はモデルごとなので、ほかのモデルには影響しない
            if (error instanceof AIError && error.kind === "timeout") {
              const waited = resolveTimeoutSeconds(
                resolved.provider.id,
                resolved.model
              );
              if (raisedTimeoutSeconds === undefined) {
                /*
                  **延ばしてよい線は、測定用の上限まで**（作者の依頼、
                  2026-09-13）。ふだんの上限（600秒）で挟むと、台帳が既に
                  600秒のモデルでは1秒も延ばせず、時間切れがそのまま
                  「入らない」に化けていた（実機の gemma4:12b）。
                */
                const raised = doubledTimeoutSeconds(
                  waited,
                  PROBE_MAX_TIMEOUT_SECONDS
                );
                if (raised !== undefined && (await raiseTimeout(raised))) {
                  raisedTimeoutSeconds = raised;
                  logStep(
                    `読める長さの測定：${size}字 → ${seconds}秒で時間切れ。` +
                      `${tuningKey} の待ち時間を ${raised} 秒へ延ばして測り直します。`
                  );
                  progress.report({
                    message:
                      `${size.toLocaleString("ja-JP")} 字を送り直しています` +
                      `（待ち時間を ${raised} 秒へ延ばしました）…`,
                  });
                  continue;
                }
              }

              /*
                **延ばしても切れた（あるいは延ばせなかった）。ここで探索を
                やめる**（作者の依頼、2026-09-13）。

                「入らない」と数えて探索を続けると、遅いだけのモデルでは
                実効の上限が実際より短く出る——**遅いのか長すぎるのかが
                区別できていない。** ここまでの `low` は生かしたまま抜け、
                「これより長い長さは測れていない」と作者へ言う。
                **「測れなかった」を「読めなかった」と言い換えない。**
              */
              probeStop = { chars: size, reason: "timeout", seconds: waited };
              logStep(
                `読める長さの測定：${size}字 → ${seconds}秒で時間切れ` +
                  `（待ち時間 ${waited} 秒）。これより長い長さは測れないので、` +
                  "ここで探索を打ち切ります（「入らない」とは数えません）。"
              );
              return;
            }

            /*
              **分あたりの上限は、待てば回復する**（作者の依頼、2026-09-13）。

              実機の Gemini（`gemini-flash-lite-latest`、無料枠）は6回
              `rate_limited` を返し、それが全部「入らなかった」と数えられて
              いた。申告は 1,024k トークンなのに、実効の上限は 186,434字で
              固定された——**測っていたのは長さではなく無料枠の窓である。**

              **その長さについて1回だけ**待って測り直す。粘らないのは、
              無料枠の窓が分単位とは限らず、待つほど結果が良くなる保証が
              無いからである（`RATE_LIMIT_WAIT_SECONDS`）。
            */
            if (error instanceof AIError && error.kind === "rate_limited") {
              if (!rateLimitRetried) {
                rateLimitRetried = true;
                logStep(
                  `読める長さの測定：${size}字 → 分あたりの上限に当たりました。` +
                    `${RATE_LIMIT_WAIT_SECONDS}秒待って、同じ長さをもう一度だけ測ります。`
                );
                progress.report({
                  message:
                    "分あたりの上限に当たりました。" +
                    `${RATE_LIMIT_WAIT_SECONDS}秒待って測り直します…`,
                });
                // **待っているあいだも中止を効かせる。** 効かないと、
                // 押しても1分間なにも起きないように見える
                if (!(await waitWatchingCancel(RATE_LIMIT_WAIT_SECONDS, token))) {
                  cancelled = true;
                  return;
                }
                continue;
              }

              /*
                待っても同じだった。**その長さは「送れなかった」ものとして
                探索を降りる**（作者の裁定、2026-09-13夜）。

                **今日の方針を一部戻している。** 0.61.1 で打ち切るように
                したのは「無料枠の窓の広さを、このモデルが読める長さとして
                台帳へ書く」のを避けるためだった。ところが2回目はいきなり
                天井へ跳ぶ作りなので（設計書6.59）、実機の Gemini では
                **天井の 1,449,826字（約2.9MB）で必ず当たり**、通ったのが
                1回目の 4,000字 だけという使いものにならない結果になった。

                `rate_limited` は長さの限界ではない。しかし**60秒待って
                送り直してもなお通らない長さは、実用上「その長さでは
                送れない」。** 降りたことに印を付けて区別すれば嘘にはならない
                ——印を付けずに数えていたのが 0.61.1 以前の問題だった
                （`contextLimitedByRate` と、下の件数の文面がその印である）。
              */
              if (low > 0) {
                rateLimitDescents += 1;
                /*
                  **降りるのは決まった回数まで**（作者の裁定、2026-09-13夜）。

                  1段ごとに60秒待って測り直すので、降りる段が増えるほど
                  作者の待ち時間がそのまま積み上がる。壁が低いモデル
                  （＝天井との差が大きいモデル）では段数が読めない。
                  **中止はいつでも効くが、「待てば終わる」と思って待った
                  作者を裏切らないために、こちら側でも蓋をする。**

                  蓋に当たっても、そこまでの `low` は生かして結果を出す
                  ——測れたぶんは測れている。
                */
                if (rateLimitDescents >= MAX_RATE_LIMIT_DESCENTS) {
                  probeStop = {
                    chars: size,
                    reason: "rate_limit_floor",
                    seconds: RATE_LIMIT_WAIT_SECONDS * rateLimitDescents,
                  };
                  logStep(
                    `読める長さの測定：分あたりの上限に ${rateLimitDescents} 回当たったため、` +
                      "ここで探索を打ち切ります（そこまでの結果は生かします）。"
                  );
                  return;
                }
                logStep(
                  `読める長さの測定：${size}字 → 待ってもまた分あたりの上限でした。` +
                    "この長さでは送れないものとして、短いほうへ降ります" +
                    "（「入らない」とは数えません）。"
                );
                // **この回を抜ける。** `continue` だと同じ長さの送り直しが
                // 際限なく回る（`model_load_failed` の側と同じ理由で `break`）
                outcome = "分あたりの上限で送れない";
                break;
              }
              // 一度も通っていないなら出せる結果が無い。素直に失敗として報せる
              failure = error;
              return;
            }

            /*
              **待っても直らない失敗は、そこで正しく報告する**（作者の依頼、
              2026-09-13）。

              鍵の失効・権限・残高切れ・止まっている——どれも**長さについて
              何も言っていない。** 「入らなかった」と数えると、原因の違う
              失敗が「実効の上限」という数字に化ける。かといって
              `reportFailure` で丸ごと失敗にもしない：短い長さで通っている
              以上、そこまでの `low` は確かに測れた値である。

              `rate_limited` は上で捌いた（待てば回復する唯一の相手）。
              `model_load_failed` も上で捌いている——`num_ctx` をその回の
              長さに合わせている今、下で通ったあとの読み込み失敗は
              **長さのせい**だと言い切れる唯一の場面だからである。
            */
            if (
              error instanceof AIError &&
              (isFatalProviderFailure(error.kind) ||
                error.kind === "not_running" ||
                // **モデルが消えたのも同じ扱いにする。** `isFatalProviderFailure`
                // には入っていないが、測定の途中でモデルが見つからなくなるのは
                // 長さの話ではない。ここへ入れないと `reportFailure` へ落ち、
                // **そこまで確かに測れた `low` を捨てる**ことになる
                error.kind === "model_not_found")
            ) {
              const detail = (error.detail ?? error.message).slice(
                0,
                ERROR_EXCERPT_CHARS
              );
              if (low > 0) {
                probeStop = { chars: size, reason: "fatal", detail };
                logStep(
                  `読める長さの測定：${size}字 → ${error.kind} が返りました。` +
                    "長さとは関係の無い失敗なので、ここで探索を打ち切ります" +
                    `（「入らない」とは数えません。${detail}）`
                );
                return;
              }
              failure = error;
              return;
            }

            // **関所（6.27.10）は、この測定のときだけ素通りする**ので、
            // 関所からここへ来ることはまず無い（`ai/contextGuard.ts`）。
            // **来るのはプロバイダ側からである**——OpenAI互換の3つは
            // 上限超えの400を `context_overflow` に分けるようにした
            // （2026-08-30。それまでは `bad_response` で測定が止まっていた）。
            // どちらにせよ「その長さでは渡せない」ことに変わりはないので、
            // 失敗にせず「入らなかった」と数えて探索を続ける
            if (error instanceof AIError && error.kind === "context_overflow") {
              outcome = "関所で止まった";
            } else if (countErrorAsTooLong(low > 0, error)) {
              // **エラーで打ち切らない。** より短い長さで「両方」が返って
              // いるのだから、接続も鍵も生きている。ここで止めると
              // 作者には「AIにつながらない」に見える（実際の報告、
              // さくら gpt-oss-120b で128,000字→183,239字のとき）
              outcome = "エラーで入らない";
              errorsCountedAsTooLong += 1;
              const detail =
                error instanceof AIError
                  ? `${error.kind}／${(error.detail ?? error.message).slice(0, ERROR_EXCERPT_CHARS)}`
                  : String(error).slice(0, ERROR_EXCERPT_CHARS);
              logStep(
                `読める長さの測定：${size}字 → エラーが返ったので「入らない」と数えました（${detail}）`
              );
            } else {
              failure = error;
              return;
            }
          }
        }

        logStep(`読める長さの測定：${size}字 → ${outcome}（${seconds}秒）`);

        // 片方だけ返った回は、どちら側が切られるかの証拠になる。
        // **1回でも出れば記録する**（毎回出るとは限らない）。
        //
        // **合言葉で測った回にしか立たない。** 入力トークン数で測った回の
        // 「写せなかった」は切り捨ての証拠ではないので、ここへ混ぜると
        // 切られてもいない側を「切り落とされます」と言うことになる
        if (outcome === "先頭のみ") sides.tailDropped = true;
        if (outcome === "末尾のみ") sides.headDropped = true;

        const fitted = outcome === "伸びた" || outcome === "両方";
        if (fitted) {
          low = Math.max(low, size);
          longestResponseSeconds = Math.max(longestResponseSeconds, seconds);
        }
        state = nextProbeSize(round, fitted);
      }
    }
  );

  // どちらの出口でも、延ばした待ち時間は外側の `finally` が戻す
  //
  // **読み込みの失敗を先に見る。** 「測れなかった」の理由として、
  // ほかのどの失敗より作者の手が届く（別のモデルを選べばよい）
  if (loadFailure) {
    reportModelLoadFailure(loadFailure, largestNumCtxUsed);
    return;
  }
  if (failure) {
    reportFailure(failure);
    return;
  }

  // 中止しても、通った長さが分かっていれば見せる。
  // 有料AIでは、ここまでの呼び出しの代金はもう払っている
  if (cancelled && low <= 0) {
    logStep("読める長さの測定：中止しました。");
    return;
  }

  /*
    **どちらで測ったかを決める**（作者の依頼、2026-09-13）。

    1回でも合言葉へ落ちたなら「合言葉で測った」と名乗る。**混ざった
    測定を「トークンで測った」と言い切らない**——合言葉で判定した回が
    `low` や `high` を動かしていれば、その結果は気まぐれに落ちうる値を
    含んでいる。強いほうへ寄せて名乗ると、台帳の印が嘘になる。
  */
  const measuredBy: ProbeMeasureMethod =
    tokenRounds > 0 && wordRounds === 0 ? "tokens" : "words";

  /*
    **同じ測定から、実測の字/トークンも採る**（設計書6.77。作者の依頼、
    2026-09-13）。伸びの傾き＝送った字数 ÷ 増えた入力トークン数が、
    そのモデルの換算そのものである。**1回の測定で2つ取れる。**

    書き先は普段の呼び出しと同じ欄（`charsPerToken`）で、**写しは作らない。**
    最小値を覚える約束（`mergeCharsPerToken`）もそのまま守る。
  */
  const ratioSummary = await saveMeasuredCharsPerToken(
    resolved.provider.id,
    resolved.model,
    fittingReadings
  );

  /*
    **台帳へ書く値と、画面に出す値は、ここで読み直した台帳から換算する。**

    上の保存でこの回の実測が入っているので、読み直せば
    `decideChunkSize` / `planChunkBudget` が後で読むのと同じ値になる。
    行き（字→トークンで台帳へ書く）と帰り（トークン→字でチャンクを
    決める）で換算が違うと、二重にずれる（`probeCharsToTokens`）。
  */
  const measuredAfter = modelTuning(resolved.provider.id, resolved.model);
  /*
    **「前に測り切った値」は、素の台帳から読む。**

    同梱の初期値（`core/bundledTuning.ts`）を混ぜたほうを使うと、
    **一度も測っていない機械で、クラウドの同梱値（339,804字）が
    「前回の測定」として出てくる。** 打ち切った今回の結果はまず
    それより小さいので、反映を勧めない判断が毎回立ち、
    作者は測ったのに保存を勧められないことになる。

    換算（`measured`）のほうは混ぜたままでよい——あちらはチャンクを
    決める側と同じ値であることが要件で、同梱はまさにそのために入れた。
  */
  const ledgerAfter = modelTuningRaw(resolved.provider.id, resolved.model);

  // **数え方を隠さない。** エラーを「入らない」と読み替えた回があるなら、
  // 何回そうしたかを結果に添える（黙って読み替えると、作者は
  // 「全部きれいに測れた」と受け取る）
  const inputSummary =
    describeProbeResult({
      low,
      sides,
      ceilingChars,
      measuredBy,
      wordCopyFailedChars,
      // **確認ダイアログと同じ換算で出す。** 違えると、1つの文面に
      // 同じ「読める長さ」の数字が2つ並ぶ
      measured: measuredAfter,
    }) +
    /*
      **打ち切ったことと、その理由を必ず出す**（作者の依頼、2026-09-13）。

      ここを黙ると、作者には「このモデルはここまでしか読めない」と読める。
      実際に分かったのは「この止まり方では先を測れなかった」だけである。
      **「測れなかった」を「読めなかった」と言い換えない**——待ち時間を
      延ばす・しばらく待つ・残高を足す、といった打つ手が残っている。
      文面は理由ごとに分ける（`describeProbeStop`）。
    */
    describeProbeStop(probeStop) +
    ratioSummary +
    (longestResponseSeconds > 0
      ? `いちばん時間がかかった回は ${longestResponseSeconds} 秒でした。`
      : "") +
    (errorsCountedAsTooLong > 0
      ? `途中で ${errorsCountedAsTooLong} 回、AIがエラーを返したため、` +
        "その長さは入らないものとして数えました。"
      : "") +
    /*
      **分あたりの上限で降りたなら、必ず言う**（作者の裁定、2026-09-13夜）。

      降りた結果は、そのモデルが読める長さではなく**1分のあいだに送れる
      量**で決まっているかもしれない。ここを黙ると、無料枠の窓の広さが
      「このモデルの実力」として作者に伝わる——印を付けずに降りていたのが
      0.61.1 以前の問題だったので、件数と打つ手（待って測り直す）を出す。
    */
    (rateLimitDescents > 0
      ? `途中で ${rateLimitDescents} 回、AIの分あたりの上限に当たりました。` +
        "この結果は「1分のあいだに送れる量」で決まっている可能性があります。" +
        "しばらく待ってから測り直すと、もっと長くなることがあります。"
      : "") +
    // **待ち時間を延ばしたことを隠さない。** 反映しなければ元へ戻すので、
    // 「一時的に」と言い切れる
    (raisedTimeoutSeconds !== undefined
      ? `途中で時間切れになったため、待ち時間を一時的に ${raisedTimeoutSeconds} 秒へ` +
        "延ばして測り直しました。"
      : "") +
    // **どの `num_ctx` で測ったかを言う。** 同じモデルでも確保量が違えば
    // 結果は変わるので、これが無いと作者は「なぜこの結果か」を追えない
    describeProbeNumCtx(largestNumCtxUsed);
  logStep(
    `読める長さの測定を終了: ${rounds}回 / ${inputSummary}` +
      (cancelled ? "（中止したため、途中までの結果です）" : "")
  );

  /*
    **続けて「書ける量」を測る**（設計書6.61・6.65.14）。

    手元のAIには出力上限を訊く口が無い（Ollamaの `/api/show` にも
    LM Studio にもその項目は無い）ので、測るしかない。クラウドは申告値を
    APIから取れるうえ出力トークンは単価が高いので、**測らないし、
    測っていないことを黙って混ぜもしない**（何も言わない）。

    読める長さが測れたときだけ続ける。中止・失敗のあとに新しい呼び出しを
    足すのは、作者の「やめる」に反する。

    **測り終えたら台帳へ保存し、まとめ送信の上限へ繋ぐ**（6.65.14）。
    「参考値の報告だけ」（6.61）では繋ぎようが無く、「チューニングの意味が
    ないように思う」という指摘を受けた（作者の指摘、2026-09-03）。
    詳しくは `measureOutputLimit` の中にある。
  */
  const outputSummary =
    // 「読める長さだけ」を選んだときは、ここへ来ない（作者の依頼、2026-09-13）
    measuresOutput(scope) &&
    !cancelled &&
    low > 0 &&
    isLocalProvider(resolved.provider.id)
      ? await measureOutputLimit(
          resolved.provider,
          resolved.model,
          // まとめ送信の上限を導くのに要る、このモデルのコンテキスト長。
          // 取れないときは、これまでの既定（`ollamaProvider.ts` の
          // `UNKNOWN_CONTEXT_WINDOW`）と同じ値に倒す
          declaredTokens ?? FALLBACK_CONTEXT_WINDOW
        )
      : "";
  const summary = inputSummary + outputSummary;

  const applied = await offerToSave({
    providerId: resolved.provider.id,
    model: resolved.model,
    summary,
    low,
    // **天井まで通ったかを一緒に渡す**（作者の指摘、2026-09-13）。
    // 二分探索がここまで全部通してしまったときの値は、モデルの限界では
    // なく検査の限界である。一覧でそれと分かるように印を残す
    ceilingChars,
    cancelled,
    longestResponseSeconds,
    // **何で測ったかを台帳へ残す**（作者の依頼、2026-09-13）。合言葉で
    // 測った値は気まぐれに落ちうるので、一覧でそれと分かるようにする
    measuredBy,
    // **分あたりの上限で降りたかを台帳へ残す**（作者の裁定、2026-09-13夜）。
    // 降りた測定の値は低めに出ているので、一覧でも選ぶ画面でもそれと分かる
    // ようにする（`contextLimitedByRate`）
    limitedByRate: rateLimitDescents > 0,
    /*
      **打ち切ったかどうかと、いま台帳に入っている値を渡す**（作者の裁定、
      2026-09-13夜）。打ち切った測定の結果が、前に測り切った値より小さい
      ときは反映を勧めない——理由は `offerToSave` の中に書いた。
    */
    probeStop,
    previousChars: ledgerAfter?.measuredChars,
    // **台帳の `contextWindow` は、チャンクを決める側と同じ換算で書く**
    measured: measuredAfter,
  });
  /*
    **測った値と、記録したかどうかを、1行に残す**（作者の裁定、2026-09-19）。

    実機では 12 分かけて測ったのに、反映待ちで止まっていることも、
    測れた長さも、どこにも残らなかった（通知は消える）。ここに書いて
    おけば、待つ前に読める。

    **判定をここでやり直さない。** 反映するかどうかを決めているのは
    `offerToSave` なので、その条件を書き写すと片方だけ直したときに
    記録と実際の動きが食い違う。ここは `applied`（結果）と、判断の
    材料になった事実だけを `core/runLog.ts` へ渡している。
  */
  logStep(
    describeTuningLog({
      modelKey: modelTuningKey(resolved.provider.id, resolved.model),
      measuredChars: low,
      measuredTokens: probeCharsToTokens(low, measuredAfter),
      recorded: applied,
      recordsContextLength: CONTEXT_TUNABLE_PROVIDERS.has(resolved.provider.id),
      hitCeiling: low > 0 && low >= ceilingChars,
      stoppedBy: probeStop?.reason,
      previousChars: ledgerAfter?.measuredChars,
      cancelled,
    })
  );

  // 反映したなら、戻す相手がもう無い（見立てた秒数で上書きされている）。
  // 反映しなかったときは後始末を残したままにして、外側の `finally` に任せる
  if (applied) cleanup.restoreTimeout = undefined;
}

/**
 * 「書ける長さだけ測る」を選んだときの道（作者の依頼、2026-09-13）。
 *
 * **測り方そのものは `measureOutputLimit` のままで、前後だけを変える。**
 * 読める長さの測定を通らないので、その結果に触れる言葉も出さない。
 * 台帳へ書くのは出力側の欄だけ（`measureOutputLimit` の中）なので、
 * 前に測った読める長さ・待ち時間はそのまま残る。
 *
 * **費用の確認はしない。** 対象は手元のAIだけで、どれだけ回しても
 * 料金が出ないため（下でそれ以外を断っている）。
 */
async function runOutputOnly(
  provider: AIProvider,
  model: string,
  /** このモデルの申告の文脈長。取れないときは undefined */
  declaredTokens: number | undefined
): Promise<void> {
  /*
    **クラウドAIでは測らない**（設計書6.61）。申告値をAPIから取れるうえ、
    出力トークンは単価が高い。「両方」のときは黙って飛ばしているが、
    こちらは作者が名指しで選んだのだから、飛ばした理由を言う。
  */
  if (!isLocalProvider(provider.id)) {
    logStep(
      `書ける量の測定：${provider.displayName} は手元のAIではないので測りません。`
    );
    void vscode.window.showInformationMessage(
      "書ける長さを測れるのは、手元のAI（Ollama・LM Studio）だけです。" +
        `いま選んでいるのは ${provider.displayName} なので、測りませんでした。`
    );
    return;
  }

  const summary = await measureOutputLimit(
    provider,
    model,
    // 取れないときは、これまでの既定（`ollamaProvider.ts` の
    // `UNKNOWN_CONTEXT_WINDOW`）と同じ値に倒す
    declaredTokens ?? FALLBACK_CONTEXT_WINDOW
  );
  // 中止・失敗のときは空が返る（理由はログにある）。数字の無い結果を
  // それらしく見せない
  void vscode.window.showInformationMessage(
    summary ||
      "書ける長さは測れませんでした（途中で終わったか、AIが応えませんでした）。"
  );
}

/**
 * **1回の応答でどれだけ書けるか**を測る（設計書6.61・6.65.14）。
 *
 * 組み立てと数え方と言葉は `core/outputProbe.ts` にあり、ここは入力側と
 * 同じく「送る・数える・作者へ見せる」だけを持つ。**測り終えたら、台帳
 * （`core/modelTuning.ts`）へ実測の出力トークン数を保存し、まとめ送信の
 * 上限（`features/chunkSettings.ts`）へ繋ぐところまでを持つ**（6.65.14）。
 *
 * @returns 結果の一文。測れなかったときは空文字（**入力側の結果には
 * 触らない**——ここで何が起きても、読める長さの報告は出す）
 */
async function measureOutputLimit(
  provider: AIProvider,
  model: string,
  /** まとめ送信の上限を導くのに要る、このモデルのコンテキスト長（設計書6.65.14の2） */
  contextWindow: number
): Promise<string> {
  const maxOutputTokens = resolveMaxOutputTokens();
  /*
    頼める行数の上限。

    1行（"0001" ＋ 改行）はおよそ2〜4トークンなので、設定の出力上限を
    2で割る。**「設定ぶんは頼める」側へ倒している**——3や4で割ると、
    設定どおり書けるモデルでも頼む前から頭打ちになり、「上限まで書き切った」
    としか分からない。多めに頼みすぎたぶんは、書き切れずに探索が縮めるだけで
    済むので、少なく頼むより害が小さい。
  */
  const ceilingLines = Math.min(
    MAX_OUTPUT_LINES,
    Math.ceil(maxOutputTokens / 2)
  );

  /** 最後まで書けた最大の行数 */
  let low = 0;
  /** その回にAIが実際に使った出力トークン数（応答に付いてくる実数） */
  let bestTokens: number | undefined;
  /**
   * その回にかかった時間（ミリ秒）。**速度の分母**になる。
   *
   * `bestTokens` と同じ回のものを持つ——別の回の時間と割ると、
   * 何を測ったのか分からない数字になる。秒ではなくミリ秒で持つのは、
   * 速い回が「0秒」に丸まって割れなくなるのを避けるため
   * （ログに出す秒数は、これまでどおり丸めた値を使う）。
   */
  let bestElapsedMs: number | undefined;
  let rounds = 0;
  /** 中止・失敗で探索を打ち切ったか */
  let stopped = false;
  /**
   * 時間切れの回が1度でもあったか（設計書6.77の第2段）。
   *
   * 時間切れは下で「その量は書けなかった」と数えるので、**遅いだけの
   * モデルでは、実際には書けるのに小さい実測が出る。** その値を
   * 実送信のハード上限にすると「測っただけで以後すべての応答が切られる」
   * ので、台帳へ印を残して上限としては使わせない
   * （`ai/outputLimit.ts` の `resolveOutputLimitForSend`）。
   */
  let timedOut = false;

  logStep(
    `書ける量の測定を開始: 上限 ${ceilingLines} 行 / ` +
      `出力上限の設定 ${maxOutputTokens} トークン`
  );

  await withCancellableProgress(
    "AIチューニング：1回に書ける量を測っています",
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      let state: OutputProbeState | undefined =
        startOutputProbeState(ceilingLines);
      while (state) {
        // 回と回の間で押されたときは、次を送らずに抜ける（入力側と同じ）
        if (token.isCancellationRequested) {
          stopped = true;
          return;
        }
        const round: OutputProbeState = state;
        rounds += 1;
        progress.report({
          message:
            `${round.current.toLocaleString("ja-JP")} 行を頼んでいます` +
            `（${rounds}回目）…`,
        });

        const sentAt = Date.now();
        /** その回に頼んだ量を書き切れたか */
        let completed = false;
        try {
          const response = await provider.generate({
            systemPrompt: OUTPUT_PROBE_SYSTEM_PROMPT,
            userPrompt: buildOutputProbePrompt(round.current),
            model,
            // 番号を数えるだけなので、揺らす理由がまったく無い
            temperature: 0,
            // **測っているのがこの上限である。** ここを削ると、
            // プロバイダの既定値を測ることになる
            maxOutputTokens,
            /*
              **設定値を超えて書けても測定の役には立たない**（設計書6.65.14の4）。
              普段の生成では出力上限を掛けない方針（`ai/ollamaProvider.ts`）を
              ここでだけ外す——25分かかった回（設定16,384に対し20,337トークン）
              が10分以上縮む。見るのは `ai/ollamaProvider.ts` だけでよい。
            */
            capOutputTokens: true,
            /*
              **`num_ctx` は渡さない。** 入力側は「その回に送る長さ」が
              測る対象そのものなので計算して渡すが、こちらは送る指示が
              数行しかない。渡さなければプロバイダが送る長さから決め、
              作者の指定（6.58）とも揃う。出力の見込みは
              `maxOutputTokens` のほうで伝わる。
            */
            /*
              **こちらも思考を切る**（入力側と同じ判断。2026-09-13に確かめ直した）。

              理由は入力側とは別である。ここでは `capOutputTokens: true` で
              `num_predict` を実際に送っているので、**思考ぶんもその枠から
              引かれる。** 切らないと「何行書けたか」ではなく「考えごとの
              あと何行書けたか」を測ることになり、モデルの気分で測る対象が
              変わる。数えているのは番号の行数（`countOutputLines`）なので、
              思考を残しても得るものが無い。
            */
            disableThinking: true,
            /*
              **流し受信は使わない**（作者の報告「F5でAIチューニングが
              終わりません」2026-09-03。設計書6.63.1）。

              **この呼び出しが、根治すべき当のものである。** 頼むのは数千行の
              列挙なので、モデルが繰り返しに崩れて延々と書き続けることがある。
              流す道は断片が届くたびに待ち時間を数え直すので、**その回は
              永遠に時間切れにならず、測定そのものが終わらない。**

              下の `catch` は時間切れを「その量は書けない」と数えて探索を
              進める設計になっており、**絶対の締め切りがあることを前提に
              している。** 前提を満たす道（`fetchJson`）で送る。
            */
            disableStreaming: true,
            // 作品に属さない呼び出しなので workFolder は付けない。
            // 機能名は関所側の定数から取る（入力側と同じ理由）
            meta: { feature: CONTEXT_GUARD_EXEMPT_FEATURE },
            signal: controller.signal,
          });
          const elapsedMs = Date.now() - sentAt;
          const seconds = elapsedSeconds(sentAt);
          const written = countOutputLines(response.text);
          const tokens = response.usage?.outputTokens;
          completed = written >= round.current;
          logStep(
            `書ける量の測定：${round.current}行 → ` +
              (completed ? "書き切った" : `${written}行で止まった`) +
              `（${seconds}秒` +
              (tokens !== undefined ? ` / 出力${tokens}トークン` : "") +
              "）"
          );
          if (completed && round.current > low) {
            low = round.current;
            bestTokens = tokens;
            // **速度も、この回のものを採る**（作者の要望、2026-09-06）。
            // 時間切れの回は書き切れていないので分子が無く、ここへは来ない
            bestElapsedMs = elapsedMs;
          }
        } catch (error) {
          const seconds = elapsedSeconds(sentAt);
          if (error instanceof AIError && error.kind === "aborted") {
            stopped = true;
            return;
          }
          if (error instanceof AIError && error.kind === "timeout") {
            // **時間切れも「その量は書けない」である。** 待っても返って
            // こない長さは、作者にとって書けないのと変わらない。
            // ここで探索を止めると、書ける量が分からないまま終わる
            logStep(
              `書ける量の測定：${round.current}行 → ${seconds}秒で時間切れ。` +
                "書き切れなかったものとして数えます。"
            );
            completed = false;
            // **数え方を台帳にも残す。** この結果は上限として使わせない
            timedOut = true;
          } else {
            /*
              **出力の測定だけを打ち切る。** 入力の結果は既に手にあり、
              こちらの失敗で捨ててよいものではない（作者にとっては
              「読める長さも測れなかった」に見えてしまう）。

              通知は出さず、ログにだけ残す——測定の主目的は果たせており、
              ここでエラーを重ねると本来の結果が読み飛ばされる
              （規則5「エラーの本文を捨てない」ので、ログには必ず残す）。
            */
            logFailure("書ける量の測定", {
              種別: error instanceof AIError ? error.kind : undefined,
              行数: round.current,
              詳細: error instanceof AIError ? error.detail : undefined,
              本文: error instanceof Error ? error.message : String(error),
            });
            stopped = true;
            return;
          }
        }
        state = nextOutputProbeSize(round, completed);
      }
    }
  );

  /*
    **途中でやめたときに「1行も書けなかった」と言わない。**

    `describeOutputProbeResult` は 0行を「AIの設定か接続の側に原因が
    ある」と読む。それは**最後まで探索して0行だった**ときの意味であって、
    中止や別の失敗で測れなかったことを指してはいけない。
  */
  if (stopped && low <= 0) {
    logStep(`書ける量の測定を終了: ${rounds}回 / 測り切れませんでした。`);
    return "";
  }

  /*
    **測り終えたら、台帳へ保存する**（設計書6.65.14の1）。

    6.61では「参考値の報告だけ」で、台帳へは書いていなかった。それでは
    まとめ送信の上限へ繋ぎようが無く、「チューニングの意味がないように
    思う」という指摘を受けた（作者の指摘、2026-09-03）。

    **中止・失敗で打ち切ったとき（`stopped`）は書かない。** 途中までの
    `low` は「そこまでは確かめられた」であって「これが上限」ではないので、
    古い実測（あれば）のほうが信頼できる。`bestTokens` が無いとき
    （完走したのに応答が出力トークン数を返さなかった、など）も、
    保存できる数字が無いので書かない。
  */
  let mergeCapMessage = "";
  /*
    **速度は、実測を保存する回に必ず書き直す**（作者の要望、2026-09-06）。

    測れなかったとき（応答が出力トークン数を返さない・所要時間が0）は
    `undefined` になり、その欄が落ちる。**古い速度を残さない**——新しい
    実測と前回の速度が並ぶと、一覧では「このモデルはこの速さ」と読めて
    しまう。分からないものは、分からないままにしておく。
  */
  const speed = outputTokensPerSecond(bestTokens, bestElapsedMs ?? 0);
  if (!stopped && bestTokens !== undefined) {
    try {
      const outcome = await saveModelTuning(provider.id, model, {
        measuredOutputTokens: bestTokens,
        outputTokensPerSecond: speed,
        /*
          **出どころと日時も、速度と一緒に書き直す**（設計書6.65.14）。

          速度は普段のAI呼び出しからも入る（`ai/meteredProvider.ts`）ので、
          いま台帳にあるのが「普段の呼び出しで採れた推定値」であることが
          ある。測り直した値へ入れ替えるときは札も入れ替えないと、
          一覧が古い出どころを指したままになる。

          測れなかったとき（`speed` が undefined）は札も日時も落とす
          ——速度の無い行に「普段の呼び出し」とだけ残ると読めない
        */
        speedSource: speed !== undefined ? "tuning" : undefined,
        speedMeasuredAt:
          speed !== undefined ? new Date(Date.now()).toISOString() : undefined,
        // **時間切れが無かったなら、前の印を消す**（`undefined` を渡すと
        // その欄だけ落ちる）。測り直して素直に終わったのに、前回の印が
        // 残って上限が広がらないままになるのを防ぐ
        outputMeasureTimedOut: timedOut ? true : undefined,
      });
      /*
        **入らなかったなら、上限を変えたと言わない**（作者の報告、
        2026-09-19）。台帳が受け取らなかったとき `readChunkSettings` は
        古い（または無い）記録を読むので、下の文面は「上限はそのまま」に
        なる——事実ではあるが、**書けなかったことが伝わらない。**
      */
      if (outcome !== "written") {
        logStep(
          "書ける量の測定：台帳へ保存できませんでした" +
            `（${describeTuningWriteFailure(outcome)}）。`
        );
        mergeCapMessage =
          "測った結果を記録できませんでした。" +
          describeTuningWriteFailure(outcome);
      } else {
        // **保存した直後の台帳を読み直す。** まとめ送信の上限がどう変わったかは
        // `chunkSettings.ts`（唯一の決め手）に訊かないと分からない——ここで
        // 独自に計算すると、決め方が2か所に散る（設計書6.58.3と同じ理由）
        const settings = readChunkSettings(contextWindow, undefined, {
          providerId: provider.id,
          model,
        });
        mergeCapMessage =
          settings.mergeCharsBeforeOutputCap !== undefined
            ? `この結果から、まとめ送信の上限を` +
              `${settings.mergeChars.toLocaleString("ja-JP")}字にしました。`
            : `上限はそのまま（${settings.mergeChars.toLocaleString("ja-JP")}字）です。`;
      }
    } catch (error) {
      // **書けなくても測定そのものは落とさない**（`raiseTimeout` と同じ方針）。
      // エラーの本文は捨てない（CLAUDE.md 規則5）
      logStep(
        "書ける量の測定：台帳へ保存できませんでした" +
          `（${error instanceof Error ? error.message : String(error)}）。`
      );
    }
  }

  // **途中で終わったことは、ログだけでなく通知にも出す。** 探索を
  // 打ち切った値は「そこまでは書けた」であって「ここが上限」ではない
  const summary =
    describeOutputProbeResult({
      lines: low,
      tokens: bestTokens,
      reachedCeiling: low >= ceilingLines,
    }) +
    (stopped ? "（測定が途中で終わったため、そこまでの結果です）" : "") +
    // **数え方を隠さない**（入力側で「エラーを入らないと数えた回数」を
    // 出しているのと同じ）。時間切れ混じりの値は、送る上限には使わない
    (timedOut
      ? "途中で時間切れになった回があるため、この値は1回の応答の上限としては" +
        "使いません（送る量の見立てにだけ使います）。"
      : "") +
    // **速度も一緒に見せる**（作者の要望、2026-09-06）。ここで出しておくと、
    // 一覧を開かなくても「いま測ったモデルが速いのか」がその場で分かる
    // 途中で終わったときは言わない（そこまでの回の速さであって、
    // 台帳にも入っていない）
    (!stopped && speed !== undefined
      ? `出力の速さは 約 ${speed.toFixed(1)} トークン/秒でした` +
        "（機械の負荷で変わるので目安です）。"
      : "") +
    // **保存できたときは、その結果（まとめ送信の上限）を言う。**
    // 保存できなかったとき（中止・失敗・台帳への書き込み失敗）は、
    // これまでどおり「参考値だけ」であることを伝える
    (mergeCapMessage || "書ける量は今回の参考値で、設定には入れません。");
  logStep(`書ける量の測定を終了: ${rounds}回 / ${summary}`);
  return summary;
}

/**
 * 測定から採れた**実測の字/トークン**を台帳へ残す（設計書6.77）。
 *
 * **普段の呼び出しの関所（`ai/meteredProvider.ts`）とまったく同じ扱い**に
 * する——確認を訊かず自動で保存し、最小値を覚え、件数を1つ増やす。
 * 欄も同じ `charsPerToken` で、**写しは作らない。**
 *
 * 確認を訊かないのは、これが `contextWindow` や `timeoutSeconds` のような
 * 「押したときだけ書く」設定ではないからである（普段の呼び出しからも
 * 勝手に入る参考値で、そちらと食い違わせる理由が無い）。
 *
 * **途中で中止したときも採ってよい。** 「書ける量」の実測（`low`）は探索の
 * 答えなので、打ち切ると意味の無い値になるが、こちらは**1回ごとの応答から
 * 直に採れる**——探索が最後まで行ったかどうかと関係が無い。普段の呼び出しの
 * 関所が毎回採っているのと、同じ性質の値である。
 *
 * **書けなくても測定は落とさない。** ただしエラーの本文は捨てない
 * （CLAUDE.md 規則5。`raiseTimeout` と同じ方針）。
 *
 * @param fittingReadings 「全部届いた」と判定できた回だけ
 * @returns 結果に添える一文。採れなかった・書けなかったときは空文字
 */
async function saveMeasuredCharsPerToken(
  providerId: ProviderId,
  model: string,
  fittingReadings: readonly ProbeTokenReading[]
): Promise<string> {
  const sample = charsPerTokenFromProbe(fittingReadings);
  if (sample === undefined) return "";

  /*
    **素の台帳を読む。** 同梱の初期値を土台にすると、字/トークンは
    最小値を覚える決まりなので**同梱の値が作者の実測に勝ってしまう**し、
    添えてある回数（5回）が数え始めになって1回目から「6回ぶん」になる。
    どちらも「作者の実測が常に勝つ」（作者の守り2）を破る。
  */
  const current = modelTuningRaw(providerId, model);
  const next = mergeCharsPerToken(current?.charsPerToken, sample);
  const samples = (current?.charsPerTokenSamples ?? 0) + 1;
  try {
    const outcome = await saveModelTuning(providerId, model, {
      charsPerToken: next,
      charsPerTokenSamples: samples,
    });
    /*
      **入らなかったなら「覚えました」と言わない**（作者の報告、2026-09-19）。

      台帳が書き込みを断ったときも、ここは例外を受け取らない。札を見ずに
      文面を返していたので、**何も記録されていないのに「覚えました」と
      結果に添えていた**——作者が「台帳が変わらない」に気づく唯一の手が
      かりを、こちらが塞いでいたことになる。
    */
    if (outcome !== "written") {
      logStep(
        "読める長さの測定：字/トークンを台帳へ保存できませんでした" +
          `（${describeTuningWriteFailure(outcome)}）。`
      );
      return "";
    }
  } catch (error) {
    logStep(
      "読める長さの測定：字/トークンを台帳へ保存できませんでした" +
        `（${error instanceof Error ? error.message : String(error)}）。`
    );
    return "";
  }

  logStep(
    `読める長さの測定：字/トークンの実測 ${sample} を採りました` +
      `（台帳は ${next}／${samples}回ぶん）。`
  );
  // **採った値と、覚えた値の両方を出す。** 最小値を覚える決まりなので、
  // 今回の実測より小さい値が台帳に残ることがある——数字が食い違って
  // 見えるところは、必ず理由ごと見せる
  return next === sample
    ? `この測定から、字/トークンの実測を ${sample} として覚えました。`
    : `この測定の字/トークンは ${sample} でしたが、これまでの最小値 ` +
        `${next} のほうを覚えています。`;
}

/**
 * 結果に添える「どの `num_ctx` で測ったか」の一文。
 *
 * **同じモデルでも確保量が違えば結果は変わる。** これが無いと、作者は
 * 「なぜこの結果になったのか」を後から追えない。
 */
export function describeProbeNumCtx(
  largestNumCtxUsed: number | undefined
): string {
  if (largestNumCtxUsed === undefined) return "";
  return (
    `num_ctx は送る長さに合わせました（この測定で最大 ` +
    `${largestNumCtxUsed.toLocaleString("ja-JP")}）。`
  );
}

/**
 * `num_ctx` を下限まで下げても載らなかったときの報せ。
 *
 * **ここだけ専用にする。** 測定の仕事は「長さを変えながら送る」ことなので、
 * 確保そのものができないなら測りようが無い。長さを疑わせず、
 * 「このモデルはこの機械には大きい」とだけ伝える。
 *
 * **AIが返した理由を添える**（必要なメモリ量など、直し方の手がかりは
 * 向こうにしかない。CLAUDE.md 規則5「エラーの本文を捨てない」）。
 */
function reportModelLoadFailure(
  error: AIError,
  triedNumCtx: number | undefined
): void {
  logFailure("読める長さの測定", {
    種別: error.kind,
    "この回のnum_ctx": triedNumCtx,
    詳細: error.detail,
    本文: error.message,
  });
  /*
    **「下げましたが」と言わない**（0.29.6）。

    0.29.5 で「半分ずつ下げる」仕組みを消したのに、案内文だけが
    「num_ctx を N まで下げましたが」のまま残っていた。**一度も
    下げていないのに下げたと言う**のは、作者を誤った方へ導く
    （「これ以上は打つ手が無い」と読める）。

    いま渡っているのは**その回に使った値**なので、そう言う。
  */
  const tried =
    triedNumCtx !== undefined
      ? `num_ctx を ${triedNumCtx.toLocaleString("ja-JP")} で試しましたが、`
      : "";
  void errorWithLog(
    `${tried}モデルを読み込めませんでした。より小さいモデルをお試しください。\n` +
      (error.detail ?? error.message).slice(0, ERROR_EXCERPT_CHARS)
  );
}

/** 送ってから返るまでの秒数。ログに出すので、秒より細かくしない */
function elapsedSeconds(sentAt: number): number {
  return Math.round((Date.now() - sentAt) / 1000);
}

/**
 * どこまで測るかを決める。
 *
 * **申告値と 256K 相当の、大きいほう。** 申告値で頭打ちにすると、
 * 申告どおりの長さまでしか試せず、この測定の目的（申告が本当かを
 * 確かめる）を果たせない。申告が 256K を超えるモデルでは、
 * その申告どおりのところまで試す。
 *
 * そのうえで**指示ぶんと出力ぶんを差し引く。** 詰め物に使える字数を
 * 返したいので、指示と応答の分を含めたまま返すと、上限のあたりで
 * 詰め物が申告値をわずかに超えてしまう。
 */
export function ceilingCharsFor(
  declaredTokens: number | undefined,
  /**
   * 申告値を信じてよいか（設計書6.62.1）。
   *
   * **申告が実測に基づくなら、それを超えて試さない。** LM Studio は
   * 読み込み済みモデルの文脈長を返すので、そこを超える長さは**必ず
   * 弾かれる**——作者のログ（2026-09-01）では、申告 131,072 のモデルへ
   * 261,770トークン相当を送り、「関所で止まった」で1回を捨てていた。
   * しかも 6.59 で公称値へ跳ぶようにしたぶん、**捨てるのはいちばん
   * 大きい回**になる。
   *
   * 逆に、さくらの申告値は**作者が設定に書いた当て推量**なので、
   * そこで止めると「申告以上に読めるか」を永久に確かめられない。
   * だから信じてよい相手だけを分ける。
   */
  trustDeclared: boolean,
  /**
   * 字/トークンの実測（台帳）。
   *
   * **天井は気前のよい換算で置く**（`probeCharsPerToken`）。0.7という
   * 当て推量で字へ直していた頃、実測1.2〜1.4のモデルでは**天井が窓の
   * 半分あたり**に落ちていた——qwen3:8b（窓40,960）で28,405字＝約23,000
   * トークン、gemma4:12b（窓262,144）で183,234字＝約132,000トークン。
   * どちらも「天井まで伸びが止まらなかった」と出たが、その天井が窓の
   * 半分だったのだから、測れていない。
   *
   * 渡されなければ従来どおり 0.7 で置く（1字も変わらない）。
   */
  measured?: CharsPerTokenMeasurement
): number {
  const tokens = trustDeclared
    ? (declaredTokens ?? MIN_CEILING_TOKENS)
    : Math.max(declaredTokens ?? 0, MIN_CEILING_TOKENS);
  const usableTokens = tokens - PROBE_OUTPUT_TOKENS;
  const chars =
    Math.floor(usableTokens / probeTokensPerChar(measured)) -
    probeOverheadChars();
  return Math.max(MIN_PROBE_CHARS, chars);
}

/**
 * 結果を見せて、台帳へ反映するかを訊く。
 *
 * **黙って書かない。** 測定は1回きりの目安であり、モデルを載せ直せば
 * 変わる。上限を書き換えると本文の分割単位が変わってキャッシュも
 * 効かなくなるので、押すのは作者である。
 *
 * **「このモデルの設定である」ことを言葉で出す。** 台帳の鍵を見せないと、
 * 作者には「AIの設定を書き換えた」としか見えず、別のモデルへ切り替えた
 * ときに値が変わることを不具合と受け取る。
 *
 * @returns 台帳へ書いたら true。**呼び出し側はこれを見て、測り直しのために
 * 延ばした待ち時間を元へ戻す**（押していないのに設定が変わっているのは、
 * 作者が押したときだけ書くという原則に反する）。
 */
async function offerToSave(input: {
  providerId: ProviderId;
  model: string;
  summary: string;
  low: number;
  /**
   * 測れる上限（天井）。**通った最大の字数がここまで届いていたら、
   * それは検査の限界であって、モデルの限界ではない。**
   */
  ceilingChars: number;
  cancelled: boolean;
  longestResponseSeconds: number;
  /** 何で測ったか。**合言葉で測った値には印を残す**（作者の依頼、2026-09-13） */
  measuredBy: ProbeMeasureMethod;
  /**
   * 分あたりの上限のせいで短いほうへ降りた測定か（作者の裁定、2026-09-13夜）。
   *
   * **降りていないときも `false` を渡す。** 台帳は差分で書かれるので、
   * 省くと前回の `true` が残り続ける（`contextHitCeiling` と同じ穴）。
   */
  limitedByRate: boolean;
  /**
   * 探索を**打ち切った**なら、その理由。最後まで測り切ったなら `undefined`。
   *
   * **歯止め（下記）を掛けてよいかの分かれ目である。**
   */
  probeStop?: ProbeStop;
  /**
   * いま台帳に入っている「読める長さ」（字）。まだ測っていなければ `undefined`。
   */
  previousChars?: number;
  /**
   * 字/トークンの実測（台帳）。
   *
   * **台帳へ書く `contextWindow` を、これで字→トークンへ直す。**
   * この欄を読むのは `decideChunkSize` / `planChunkBudget` で、あちらは
   * `resolveCharsPerToken` で字へ戻す。片方だけ実測にすると、行きと帰りで
   * 換算が違って二重にずれる（`probeCharsToTokens`）。
   */
  measured?: CharsPerTokenMeasurement;
}): Promise<boolean> {
  const prefix = input.cancelled ? "（途中で中止しました）" : "";

  if (input.low <= 0) {
    // 一度も通っていないなら、覚える値が無い。原因は長さではなく
    // 接続か設定の側なので、書き込む提案自体をしない
    vscode.window.showInformationMessage(`${prefix}${input.summary}`);
    return false;
  }

  /*
    **打ち切った測定で、前より小さい値を勧めない**（作者の裁定、2026-09-13夜）。

    打ち切った測定の `low` は「**そこまでは通った**」でしかなく、
    「そこまでしか通らない」ではない。上限の情報としては、前回**最後まで
    測り切った**値のほうが強い。実機では天井の回で分あたりの上限に当たって
    打ち切り、通っていたのは1回目の 4,000字 だけだったのに、確認ダイアログが
    その 4,000字 を勧めた——**押すと台帳の 186,435字 が 4,000字 に化ける。**

    **最後まで測り切った測定には掛けない。** モデルを別の量子化へ差し替えた
    ときのように、本当に短くなることはある。そのときは小さい値で上書き
    できなければならない。歯止めを掛けるのは**打ち切ったときだけ**である。
  */
  if (
    input.probeStop !== undefined &&
    input.previousChars !== undefined &&
    input.low < input.previousChars
  ) {
    vscode.window.showInformationMessage(
      `${prefix}${input.summary}` +
        `いまの記録（${input.previousChars.toLocaleString("ja-JP")}字）の` +
        "ほうが大きいので、置き換えません。"
    );
    return false;
  }

  const key = modelTuningKey(input.providerId, input.model);
  const tokens = probeCharsToTokens(input.low, input.measured);
  // **上限はプロバイダごと**（手元1800秒・クラウド600秒。2026-09-23）。
  // 手元のAIへ600秒を書くと、読む側は1800秒まで許すのに台帳の値で切れる
  const timeoutSeconds = recommendTimeoutSeconds(
    input.longestResponseSeconds,
    maxTimeoutSeconds(input.providerId)
  );
  // 上限を書いてよいのは、申告値を取れないプロバイダだけ
  const writesContext = CONTEXT_TUNABLE_PROVIDERS.has(input.providerId);

  /*
    **どこへ、何を書くのかを言う**（作者の報告、2026-09-19）。

    これまでは「設定として覚えます」とだけ言っていた。作者は VS Code の
    設定（`settings.json`）を見に行き、`novelai.ollama.timeoutSeconds` が
    変わっていないので「何も起きていない」と受け取った。書き先は設定では
    なく**拡張機能の保管庫の台帳**である（0.66.6 で移した）。名前で言う。

    もう1つ、**Ollama のように読める長さを自分で申告する相手では、測った
    長さで申告値を置き換えない**（`CONTEXT_TUNABLE_PROVIDERS`）。それを
    黙って「設定として覚えます」と言うと、測った 138,714字 がそのまま効くと
    読める。**記録する欄と、記録しても置き換えない値を、分けて言う。**
  */
  const answer = await vscode.window.showInformationMessage(
    `${prefix}${input.summary}` +
      `この結果は、いま選んでいるモデル（${key}）のAIチューニングの記録として残します` +
      `（VS Code の設定ではなく、拡張機能の保管庫の ${TUNING_STORE_FILE} です）。` +
      "ほかのモデルには影響しません——モデルを切り替えれば、そのモデルの値に変わります。" +
      "反映するのは、" +
      (writesContext
        ? `読める長さ 約${tokens.toLocaleString("ja-JP")}トークンと、`
        : "") +
      `待ち時間 ${timeoutSeconds}秒 です。` +
      `測った長さ ${input.low.toLocaleString("ja-JP")}字 も記録に残り、` +
      "チャンクの大きさを決めるのに使います。" +
      (writesContext
        ? ""
        : "読める長さそのものは、このAIが申告する値を使い続けます" +
          "（測った長さは記録に残すだけです）。"),
    "設定に反映",
    "そのままにする"
  );
  // 断られたら何も書かない。測り直しのために延ばした値を戻すのは呼び出し側
  if (answer !== "設定に反映") return false;

  // 台帳に入れる上限は**トークン数**（字数ではない）。通った最大の字数は
  // `measuredChars` に別に残す——あとから「何字で測ったのか」を辿れるように。
  //
  // **ここに無い欄は消えない**（`saveModelTuning` が生の設定値へ差し替える）。
  // 作者が手で書いた覚書などは、測るたびに消えてよいものではない
  const tuning: ModelTuning = {
    ...(writesContext ? { contextWindow: tokens } : {}),
    timeoutSeconds,
    measuredChars: input.low,
    /*
      **天井に届いたかどうかにかかわらず、毎回書く**（作者の指摘、
      2026-09-13）。

      届かなかったときに項目ごと省いていたが、`saveModelTuning` は台帳へ
      **差分で書く**——省いた欄は消えるのではなく、**前回の印が残る。**
      実機では前回 183,234字で天井に届いており、今回 194,288字（天井は
      362,191字）で届かなかったのに `contextHitCeiling: true` が残り、
      一覧に「これ以上は試していません」と出た。**強い測定が、弱い印を
      着たままになる。**

      「印が無い＝これまでどおり」を守るために省いていたのだが、この欄では
      裏目に出た。`contextMeasuredBy` が既に毎回書いているのと同じ理由で、
      こちらも毎回書く（古い台帳の `undefined` とは、これで意味が分かれる）。
    */
    contextHitCeiling: input.low >= input.ceilingChars,
    /*
      **分あたりの上限で降りたかも、毎回書く**（作者の裁定、2026-09-13夜。
      天井の印とまったく同じ理由）。省くと、上限に当たらなかった強い測定が
      前回の弱い印を着たまま一覧に並ぶ——0.61.0 でそこを踏んでいる。
    */
    contextLimitedByRate: input.limitedByRate,
    // **測り方は、どちらでも書く。** 天井の印と違って「印が無い＝強い
    // ほう」ではない——古い台帳（この欄が入る前）と、今回トークンで
    // 測った値を、一覧が取り違えないようにする
    contextMeasuredBy: input.measuredBy,
    measuredAt: new Date().toISOString(),
  };
  const outcome = await saveModelTuning(input.providerId, input.model, tuning);

  /*
    **入ったことを確かめてから「覚えました」と言う**（作者の報告、
    2026-09-19。この件の本体である）。

    台帳への書き込みは、断ったとき（壊れている）も諦めたとき（別の窓と
    取り合い）も**例外を投げずに戻る**（`core/modelTuningStore.ts`）。
    ここはその戻りを見ずに言い切っていたので、12分かけて測った結果が
    1バイトも入らなくても「覚えました」と出ていた。**作者が気づく手が
    かりが、どこにも無い状態だった。**

    書けなかったときは警告で出す。理由と、打つ手（台帳を直す・窓を1つに
    する）を添えないと、作者は同じ12分をもう一度払うことになる。
  */
  if (outcome !== "written") {
    logFailure("読める長さの測定", {
      台帳: outcome,
      対象: key,
      本文: describeTuningWriteFailure(outcome),
    });
    void vscode.window.showWarningMessage(
      `${key} の測定結果を記録できませんでした。` +
        `${describeTuningWriteFailure(outcome)}` +
        "測った値は残っていないので、直してから測り直してください。"
    );
    return false;
  }

  logStep(
    `読める長さの測定：${key} の記録を反映しました` +
      `（${writesContext ? `上限 ${tokens} トークン / ` : ""}待ち時間 ${timeoutSeconds} 秒）。`
  );
  vscode.window.showInformationMessage(
    `${key} の記録として覚えました` +
      `（${writesContext ? `読める長さ 約${tokens.toLocaleString("ja-JP")}トークン / ` : ""}` +
      `待ち時間 ${timeoutSeconds}秒 / 測った長さ ${input.low.toLocaleString("ja-JP")}字）。` +
      "ほかのモデルには影響しません。"
  );
  return true;
}

/**
 * 台帳へ書けなかった理由を、作者の言葉にする（作者の報告、2026-09-19）。
 *
 * **札をそのまま出さない。** `unreadable` と `lost` では打つ手がまるで
 * 違う——前者は台帳のファイルを直すまで何度測っても入らないし、後者は
 * 開いている窓を1つにすれば入る。区別を伝えないと、作者は「また12分
 * 測る」以外の手を思いつけない。
 */
function describeTuningWriteFailure(outcome: TuningWriteOutcome): string {
  switch (outcome) {
    case "written":
      return "";
    case "unreadable":
      return (
        `AIチューニングの台帳（拡張機能の保管庫の ${TUNING_STORE_FILE}）が` +
        "読めない形になっているため、上書きせずに止めました。" +
        "中身を直すか、詳細メニューの「AIチューニングの記録を消す」で" +
        "作り直してから測り直してください。"
      );
    case "no_store":
      return (
        "AIチューニングの台帳の置き場が使えないため、書けませんでした。" +
        "拡張機能を入れ直すか、VS Code を開き直してから測り直してください。"
      );
    case "lost":
      return (
        "台帳へ書いても残りませんでした。" +
        "ほかの VS Code の窓が同じ台帳を書いている可能性があります。" +
        "窓を1つにしてから測り直してください。"
      );
  }
}

function reportFailure(error: unknown): void {
  if (error instanceof AIError) {
    logFailure("読める長さの測定", {
      種別: error.kind,
      詳細: error.detail,
      本文: error.message,
    });
    void errorWithLog(`${error.message}\n${recoveryForAIError(error)}`);
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  logFailure("読める長さの測定", { 本文: message });
  void vscode.window.showErrorMessage(`測定に失敗しました。\n${message}`);
}
