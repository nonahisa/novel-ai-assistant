import * as vscode from "vscode";
import {
  AIRegistry,
  ensureConfigured,
  type AssignableFeature,
} from "../ai/registry";
import { AIError, recoveryForAIError, type ProviderId } from "../ai/types";
import { CONTEXT_GUARD_EXEMPT_FEATURE } from "../ai/contextGuard";
import { contextSizeForPrompt, TOKENS_PER_CHAR } from "../core/chunker";
import {
  buildProbePrompt,
  describeProbeResult,
  judgeProbeAnswer,
  makeProbeWords,
  nextProbeSize,
  probeCharsToTokens,
  probeOverheadChars,
  startProbeState,
  worstCaseProbeChars,
  MIN_PROBE_CHARS,
  type ProbeSides,
  type ProbeState,
} from "../core/contextProbe";
import { logFailure, logStep, showLog, useLogFile } from "../core/logger";
import {
  MAX_TIMEOUT_SECONDS,
  modelTuning,
  modelTuningKey,
  recommendTimeoutSeconds,
  resolveTimeoutSeconds,
  saveModelTuning,
  type ModelTuning,
} from "../core/modelTuning";
import { withCancellableProgress } from "../views/progress";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";

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

/** 1回ぶんの結果。ログの1行になる */
type RoundOutcome =
  | "両方"
  | "先頭のみ"
  | "末尾のみ"
  | "無し"
  | "関所で止まった"
  | "エラーで入らない";

/**
 * その回のエラーを「入らなかった」と数えてよいか。
 *
 * **一度でも短い長さで「両方」が返っていることが条件である。**
 * 通ったことがあるなら、接続も鍵も残高も生きていると分かっている。
 * そこから長くしていって落ちたなら、原因は長さのほうである
 * （設計書6.27.11「切り捨てはクラウドならエラーで『入らない』と数える」）。
 *
 * **一度も通っていないうちのエラーは、失敗として報告する。** ここを
 * 緩めると、鍵の間違いや残高不足を「入らない」と誤魔化して、
 * 「実効の上限は0字です」のような無意味な結果を出してしまう。
 *
 * 作者が止めたとき（`aborted`）は、当然ながら数えない。
 */
export function countErrorAsTooLong(
  hadSuccessBelow: boolean,
  error: unknown
): boolean {
  if (!(error instanceof AIError)) return false;
  if (error.kind === "aborted") return false;
  return hadSuccessBelow;
}

/**
 * 時間切れになったとき、待ち時間をどこまで延ばして測り直すか。
 * 延ばせないなら undefined（もう延ばす余地が無い）。
 *
 * **倍にするだけ。** 何秒あれば足りるかはこちらには分からないので、
 * 当て推量の刻みを持ち込まない（CLAUDE.md 規則5）。上限を超えるぶんは
 * 切り詰める——それ以上待たせるくらいなら、モデルかチャンクの大きさを
 * 見直すほうが作者のためになる。
 */
export function doubledTimeoutSeconds(
  currentSeconds: number
): number | undefined {
  if (!Number.isFinite(currentSeconds) || currentSeconds <= 0) return undefined;
  if (currentSeconds >= MAX_TIMEOUT_SECONDS) return undefined;
  return Math.min(MAX_TIMEOUT_SECONDS, currentSeconds * 2);
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
export function estimateProbeTokens(ceilingChars: number): number {
  return probeCharsToTokens(worstCaseProbeChars(ceilingChars) + ceilingChars);
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
  workFolderPath?: string
): Promise<void> {
  // **ここで先に決める。** 中で失敗しても、その失敗がファイルに残る
  if (workFolderPath) useLogFile(workFolderPath);

  const cleanup: TuningCleanup = {};
  try {
    await runMeasurement(registry, feature, cleanup);
  } catch (error) {
    // 測定そのものの失敗は `runMeasurement` が中で捌く。ここへ来るのは
    // 通知や設定の書き込みが投げたとき——黙って消さず、ログと通知へ出す
    reportFailure(error);
  } finally {
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
  cleanup: TuningCleanup
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
  // **申告が実測に基づく相手は、そこを超えて試さない**（設計書6.62.1）。
  // 当て推量なのは、作者が設定に書く さくら・ChatGPT だけである
  const ceilingChars = ceilingCharsFor(
    declaredTokens,
    !GUESSED_CONTEXT_PROVIDERS.has(resolved.provider.id)
  );

  const estimateTokens = estimateProbeTokens(ceilingChars);
  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel: "AIチューニング",
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

  logStep(
    `読める長さの測定を開始: ${resolved.provider.displayName} / ` +
      `${tuningKey} / 申告 ${declaredTokens ?? "不明"} トークン / ` +
      `測れる上限 ${ceilingChars} 字`
  );

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
  /** 両方返った最大の字数 */
  let low = 0;
  let rounds = 0;
  /** エラーを「入らなかった」と数えた回数。作者へも件数で伝える */
  let errorsCountedAsTooLong = 0;
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
    const current = modelTuning(resolved.provider.id, resolved.model);
    try {
      await saveModelTuning(resolved.provider.id, resolved.model, {
        timeoutSeconds: seconds,
      });
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
              maxOutputTokens: PROBE_OUTPUT_TOKENS,
              // **その回に要るぶんだけ。** 申告値に固定すると、確保した
              // KVキャッシュがVRAMから溢れて黙ってCPUへ落ちる（6.53.2）
              numCtx,
              disableThinking: true,
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
            outcome = judged.head
              ? judged.tail
                ? "両方"
                : "先頭のみ"
              : judged.tail
                ? "末尾のみ"
                : "無し";
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
            if (
              error instanceof AIError &&
              error.kind === "timeout" &&
              raisedTimeoutSeconds === undefined
            ) {
              const raised = doubledTimeoutSeconds(
                resolveTimeoutSeconds(resolved.provider.id, resolved.model)
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
        // **1回でも出れば記録する**（毎回出るとは限らない）
        if (outcome === "先頭のみ") sides.tailDropped = true;
        if (outcome === "末尾のみ") sides.headDropped = true;

        const bothReturned = outcome === "両方";
        if (bothReturned) {
          low = Math.max(low, size);
          longestResponseSeconds = Math.max(longestResponseSeconds, seconds);
        }
        state = nextProbeSize(round, bothReturned);
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

  // **数え方を隠さない。** エラーを「入らない」と読み替えた回があるなら、
  // 何回そうしたかを結果に添える（黙って読み替えると、作者は
  // 「全部きれいに測れた」と受け取る）
  const summary =
    describeProbeResult({ low, sides, ceilingChars }) +
    (longestResponseSeconds > 0
      ? `いちばん時間がかかった回は ${longestResponseSeconds} 秒でした。`
      : "") +
    (errorsCountedAsTooLong > 0
      ? `途中で ${errorsCountedAsTooLong} 回、AIがエラーを返したため、` +
        "その長さは入らないものとして数えました。"
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
    `読める長さの測定を終了: ${rounds}回 / ${summary}` +
      (cancelled ? "（中止したため、途中までの結果です）" : "")
  );

  const applied = await offerToSave({
    providerId: resolved.provider.id,
    model: resolved.model,
    summary,
    low,
    cancelled,
    longestResponseSeconds,
  });
  // 反映したなら、戻す相手がもう無い（見立てた秒数で上書きされている）。
  // 反映しなかったときは後始末を残したままにして、外側の `finally` に任せる
  if (applied) cleanup.restoreTimeout = undefined;
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
  void vscode.window
    .showErrorMessage(
      `${tried}モデルを読み込めませんでした。より小さいモデルをお試しください。\n` +
        (error.detail ?? error.message).slice(0, ERROR_EXCERPT_CHARS),
      "ログを見る"
    )
    .then((answer) => {
      if (answer === "ログを見る") showLog();
    });
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
function ceilingCharsFor(
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
  trustDeclared: boolean
): number {
  const tokens = trustDeclared
    ? (declaredTokens ?? MIN_CEILING_TOKENS)
    : Math.max(declaredTokens ?? 0, MIN_CEILING_TOKENS);
  const usableTokens = tokens - PROBE_OUTPUT_TOKENS;
  const chars = Math.floor(usableTokens / TOKENS_PER_CHAR) - probeOverheadChars();
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
  cancelled: boolean;
  longestResponseSeconds: number;
}): Promise<boolean> {
  const prefix = input.cancelled ? "（途中で中止しました）" : "";

  if (input.low <= 0) {
    // 一度も通っていないなら、覚える値が無い。原因は長さではなく
    // 接続か設定の側なので、書き込む提案自体をしない
    vscode.window.showInformationMessage(`${prefix}${input.summary}`);
    return false;
  }

  const key = modelTuningKey(input.providerId, input.model);
  const tokens = probeCharsToTokens(input.low);
  const timeoutSeconds = recommendTimeoutSeconds(input.longestResponseSeconds);
  // 上限を書いてよいのは、申告値を取れないプロバイダだけ
  const writesContext = CONTEXT_TUNABLE_PROVIDERS.has(input.providerId);

  const answer = await vscode.window.showInformationMessage(
    `${prefix}${input.summary}` +
      `この結果は、いま選んでいるモデル（${key}）の設定として覚えます。` +
      "ほかのモデルには影響しません——モデルを切り替えれば、そのモデルの値に変わります。" +
      "反映するのは、" +
      (writesContext
        ? `読める長さ 約${tokens.toLocaleString("ja-JP")}トークンと、`
        : "") +
      `待ち時間 ${timeoutSeconds}秒 です。`,
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
    measuredAt: new Date().toISOString(),
  };
  await saveModelTuning(input.providerId, input.model, tuning);

  logStep(
    `読める長さの測定：${key} の設定を反映しました` +
      `（${writesContext ? `上限 ${tokens} トークン / ` : ""}待ち時間 ${timeoutSeconds} 秒）。`
  );
  vscode.window.showInformationMessage(
    `${key} の設定として覚えました` +
      `（${writesContext ? `読める長さ 約${tokens.toLocaleString("ja-JP")}トークン / ` : ""}` +
      `待ち時間 ${timeoutSeconds}秒）。ほかのモデルには影響しません。`
  );
  return true;
}

function reportFailure(error: unknown): void {
  if (error instanceof AIError) {
    logFailure("読める長さの測定", {
      種別: error.kind,
      詳細: error.detail,
      本文: error.message,
    });
    void vscode.window
      .showErrorMessage(
        `${error.message}\n${recoveryForAIError(error)}`,
        "ログを見る"
      )
      .then((answer) => {
        if (answer === "ログを見る") showLog();
      });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  logFailure("読める長さの測定", { 本文: message });
  void vscode.window.showErrorMessage(`測定に失敗しました。\n${message}`);
}
