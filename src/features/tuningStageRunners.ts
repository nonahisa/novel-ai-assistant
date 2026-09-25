// ログの書き先：呼ぶ側が向ける——入口の `novelai.measureContext` と `measureContext` が、作品（無ければ保管庫）のログへ向けてから呼ぶ
import * as vscode from "vscode";
import {
  AIError,
  isFatalProviderFailure,
  recoveryForAIError,
  type AIProvider,
  type GenerateResult,
} from "../ai/types";
import { CONTEXT_GUARD_EXEMPT_FEATURE } from "../ai/contextGuard";
import { isLocalProvider } from "../ai/otherLocalAi";
import {
  resolveMaxOutputTokens,
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { localFetch } from "../ai/fetchTimeouts";
import { withLineNumbers, type Chunk } from "../core/chunker";
import {
  isSplitAcrossCpu,
  readOllamaPsWith,
  type OllamaLoadedModel,
} from "../core/gpuLoad";
import { logFailure, logStep } from "../core/logger";
import {
  maxTimeoutSeconds,
  modelTuningKey,
  recommendTimeoutFromWorkRate,
  saveModelTuning,
  type ModelTuning,
} from "../core/modelTuning";
import { TUNING_STORE_FILE } from "../core/modelTuningStore";
import {
  DECLARED_LIMIT_CONFIRM_MARGIN,
  DECLARED_LIMIT_PROBE_OUTPUT_TOKENS,
  TUNING_WORK_FEATURE,
  WORK_REFERENCE_CHARS,
  describeStagePlan,
  fitWorkRate,
  judgeThinking,
  parseDeclaredContextLimit,
  plannedCallCount,
  plannedStages,
  predictWorkSeconds,
  type ThinkingObservation,
  type ThinkingVerdict,
  type TuningStageId,
  type TuningStageSpec,
  type TuningStageTarget,
  type WorkSample,
} from "../core/tuningStages";
import {
  TUNING_WORK_LONG,
  TUNING_WORK_PROPER_NOUNS,
  TUNING_WORK_SHORT,
  TUNING_WORK_WARMUP,
} from "../core/tuningWorkSample";
import {
  TYPO_CHECK_SCHEMA,
  TYPO_CHECK_SYSTEM_PROMPT,
  TYPO_CHECK_TEMPERATURE,
  buildTypoCheckPrompt,
} from "../prompts/typoCheck";
import { withCancellableProgress } from "../views/progress";
import { errorWithLog } from "../views/notify";
import { confirmPaidUsage, ollamaEndpoint } from "./aiConnectivity";
import { describeTuningWriteFailure } from "./tuningWriteFailure";

/**
 * AIチューニングの「仕事に近い形の測定」を走らせる（設計書6.49.9。
 * 作者の判断、2026-09-26）。
 *
 * 段の一覧と判断は `core/tuningStages.ts` にあり、ここは**送る・台帳へ
 * 残す・作者へ見せる**だけを持つ。
 *
 * ## 段を足すには
 *
 * 1. `core/tuningStages.ts` の `TuningStageId` に名前を足し、`TUNING_STAGES`
 *    に1行（名前・どのAIで走るか・最大の回数）を足す
 * 2. ここの `STAGE_RUNNERS` に走らせ方を1つ足す（`StageContext` を受け取り、
 *    `StageOutcome` を返す）
 *
 * 回数の見込み（有料AIの確認）・進み具合・結果の文面・台帳への保存・
 * 「反映」の確認は、どれもこの並びから組まれるので、ほかは触らなくてよい。
 */

/** 段が受け取るもの */
export interface StageContext {
  readonly provider: AIProvider;
  readonly model: string;
  readonly target: TuningStageTarget;
  readonly signal: AbortSignal;
  /** 進み具合に出す一文 */
  report(message: string): void;
  /**
   * いま Ollama に読み込まれているモデルを読む（`/api/ps`）。**Ollama の
   * ときだけ渡す**。読めなければ undefined。
   *
   * 時間を測ったとき、**ほかのモデルが載っていた**か、**測るモデルが GPU に
   * 入りきらず CPU と分けて載っていた**かを台帳に印として残すために使う
   * （リーダーの指摘、2026-09-26：前に使ったモデルが既定で5分居残ると、
   * 測るモデルが GPU に入りきらず、gemma4:12b が124秒→765秒になった）。
   * **ほかのモデルを勝手に下ろさない**——作者がそのモデルで作業している
   * かもしれない。下ろさずに印を付け、測った時間が長めに出ている
   * かもしれないことを言う。
   */
  readonly readLoadedModels?: () => Promise<readonly OllamaLoadedModel[] | undefined>;
}

/**
 * 作者が「反映」を押したときだけ台帳へ書く欄（作品の原則「作者が押した
 * ときだけ書く」）。待ち時間と読める長さは、呼び出しの振る舞いそのものを
 * 変えるので、測っただけでは書かない。
 */
export interface StageProposal {
  readonly timeoutSeconds?: number;
  readonly contextWindow?: number;
  readonly contextDeclared?: string;
  readonly contextDeclaredAt?: string;
}

/** 段の結果 */
export interface StageOutcome {
  /** 作者へ見せる一文（空なら何も足さない） */
  readonly summary: string;
  /**
   * 確かめたうえで、**押さなくても**台帳へ残す欄（参考値。速さや
   * 字/トークンと同じ流儀）。`undefined` を入れた欄は消える
   * （前の測定の古い値を残さないため）。
   */
  readonly record?: ModelTuning;
  /** 押したときだけ書く欄 */
  readonly propose?: StageProposal;
  /** 作者が止めた */
  readonly cancelled?: boolean;
  /**
   * 待っても直らない失敗（鍵・残高・モデルが載らない）。**残りの段を
   * 試さない**（設計書6.50と同じ判断）。
   */
  readonly fatal?: AIError;
}

type StageRunner = (context: StageContext) => Promise<StageOutcome>;

/** 段を並べて走らせた結果 */
export interface StagesResult {
  /** 段ごとの一文（走らせた順） */
  readonly summaries: string[];
  /** 押したときだけ書く欄をまとめたもの */
  readonly proposal: StageProposal;
  /** 押さなくても残した欄が、ほんとうに台帳へ入ったか（1つでも入れば true） */
  readonly recorded: boolean;
  readonly cancelled: boolean;
  readonly fatal?: AIError;
}

/** 作者の言葉で書く「いまの時刻」（台帳の日時欄。ISO 8601） */
function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

/**
 * 段を上から順に走らせる。**止め方は2つだけ**——作者が止めたときと、
 * 待っても直らない失敗のとき。ほかの失敗はその段の一文に書いて、次の段へ
 * 進む（チャンク単位の失敗で全体を止めないのと同じ考え方）。
 */
export async function runTuningStages(
  context: StageContext,
  stages: readonly TuningStageSpec[] = plannedStages(context.target),
  runners: Readonly<Record<TuningStageId, StageRunner>> = STAGE_RUNNERS
): Promise<StagesResult> {
  const summaries: string[] = [];
  let proposal: StageProposal = {};
  let recorded = false;
  const key = modelTuningKey(context.provider.id, context.model);

  for (const stage of stages) {
    if (context.signal.aborted) {
      return { summaries, proposal, recorded, cancelled: true };
    }
    context.report(`${stage.label}を測っています…`);
    logStep(`仕事に近い形の測定：${stage.label}（${key}）`);
    const outcome = await runners[stage.id](context);

    let summary = outcome.summary;
    if (outcome.record !== undefined) {
      /*
        **入ったことを確かめてから「覚えました」と言う**（作者の報告、
        2026-09-19）。台帳が壊れているときは書き込みを断る（規則2。壊れた
        上から書くと作者の実測が消える）ので、札を見て言い分ける。
      */
      try {
        const written = await saveModelTuning(
          context.provider.id,
          context.model,
          outcome.record
        );
        if (written === "written") {
          recorded = true;
        } else {
          summary +=
            `（${stage.label}の結果は記録できませんでした。` +
            `${describeTuningWriteFailure(written)}）`;
          logStep(
            `仕事に近い形の測定：${stage.label}の結果を記録できませんでした（${written}）。`
          );
        }
      } catch (error) {
        // 書けなくても測定は続ける。ただし理由は捨てない（規則5）
        const message = error instanceof Error ? error.message : String(error);
        summary += `（${stage.label}の結果は記録できませんでした。${message}）`;
        logStep(`仕事に近い形の測定：${stage.label}の記録に失敗しました（${message}）。`);
      }
    }
    if (summary.length > 0) summaries.push(summary);
    if (outcome.propose !== undefined) {
      proposal = { ...proposal, ...outcome.propose };
    }
    if (outcome.cancelled) {
      return { summaries, proposal, recorded, cancelled: true };
    }
    if (outcome.fatal !== undefined) {
      return { summaries, proposal, recorded, cancelled: false, fatal: outcome.fatal };
    }
  }
  return { summaries, proposal, recorded, cancelled: false };
}

/* ── 送る部品 ───────────────────────────────────── */

/**
 * 同梱の文を、**誤字脱字と同じ形で**送る。
 *
 * プロンプト・形式の強制・温度・出力の上限と見込みは、製品の誤字脱字
 * （`features/checkTypos.ts`）が使うものをそのまま引く。写しを作ると、
 * 誤字脱字のプロンプトが変わったときに測りだけ古い形のまま残る。
 */
async function sendTypoSample(
  context: StageContext,
  body: string,
  options: { readonly disableThinking: boolean; readonly roomyOutput?: boolean }
): Promise<GenerateResult> {
  const chunk: Chunk = {
    filePath: "",
    index: 0,
    text: body,
    startLine: 0,
    chapterStart: null,
    chapterEnd: null,
    hash: "",
  };
  const userPrompt = buildTypoCheckPrompt({
    chunkTextWithLineNumbers: withLineNumbers(chunk),
    properNounDictionary: [...TUNING_WORK_PROPER_NOUNS],
  });
  const providerId = context.provider.id;
  return context.provider.generate({
    systemPrompt: TYPO_CHECK_SYSTEM_PROMPT,
    userPrompt,
    model: context.model,
    temperature: TYPO_CHECK_TEMPERATURE,
    /*
      **思考を止めない回は、設定の上限まで許す。** 思考が出るかを見る回で
      上限を誤字脱字の見込みに絞ると、考える途中で使い切って空になり、
      「思考が出た」ことすら確かめられない（比べ 2026-09-25〜26 の Qwen3.6）。
    */
    maxOutputTokens: options.roomyOutput
      ? resolveMaxOutputTokens()
      : resolveOutputTokensForSend(providerId, context.model, "typo_check"),
    plannedOutputTokens: resolveOutputTokensForPlanning(
      providerId,
      context.model,
      "typo_check"
    ),
    jsonSchema: TYPO_CHECK_SCHEMA as unknown as object,
    disableThinking: options.disableThinking,
    /*
      **流し受信は使わない**（読める長さの測定と同じ理由。設計書6.63.1）。
      測るのは配布物が通る道であり、流す道は断片ごとに待ちを数え直すので
      時間の測りにならない。
    */
    disableStreaming: true,
    meta: { feature: TUNING_WORK_FEATURE },
    signal: context.signal,
  });
}

/** 返ってきた応答から、思考について見えたこと */
function observe(result: GenerateResult): ThinkingObservation {
  return {
    thinkingChars: result.thinking?.length ?? 0,
    answerChars: result.text.length,
    // 0は「申告しなかった」と区別が付かない（さくら・Ollama は必ず返す）
    outputTokens:
      result.usage !== undefined && result.usage.outputTokens > 0
        ? result.usage.outputTokens
        : undefined,
  };
}

/** その失敗が、残りの段を試しても同じになるものか（設計書6.50） */
function isFatal(error: unknown): error is AIError {
  return (
    error instanceof AIError &&
    (isFatalProviderFailure(error.kind) ||
      error.kind === "not_running" ||
      error.kind === "model_not_found")
  );
}

/** 作者が止めたか */
function isAborted(error: unknown): boolean {
  return error instanceof AIError && error.kind === "aborted";
}

/** ログと一文に載せる、失敗の短い説明（本文を捨てない。規則5） */
function describeFailure(error: unknown): string {
  if (error instanceof AIError) {
    return `${error.message}${error.detail ? `（${error.detail.slice(0, 200)}）` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 1回の失敗を段の結果に直す。**止める／続けるの判断はここ1か所** */
function failedOutcome(stageLabel: string, error: unknown): StageOutcome {
  if (isAborted(error)) return { summary: "", cancelled: true };
  logFailure(`仕事に近い形の測定（${stageLabel}）`, {
    種別: error instanceof AIError ? error.kind : undefined,
    詳細: error instanceof AIError ? error.detail : undefined,
    本文: error instanceof Error ? error.message : String(error),
  });
  if (isFatal(error)) {
    return {
      summary: `${stageLabel}の途中で「${describeFailure(error)}」が返ったため、残りは試していません。`,
      fatal: error,
    };
  }
  return {
    summary: `${stageLabel}は測れませんでした（${describeFailure(error)}）。`,
  };
}

/* ── 段1：考えるモデルかの見分け ───────────────────── */

async function runThinkingStage(context: StageContext): Promise<StageOutcome> {
  const label = "考えるモデルかの見分け";
  /*
    **止める指定を送る回を先にする。** 製品が普段送る形なので速く返る。
    手元のAIではここでモデルが読み込まれるが、次の段はそれを当てにせず、
    自分で読み込ませる1回を入れる（`runWorkStage` に理由）。
  */
  let off: ThinkingObservation | undefined;
  let offFailure: unknown;
  try {
    const result = await sendTypoSample(context, TUNING_WORK_SHORT, {
      disableThinking: true,
    });
    off = observe(result);
    logStep(
      `仕事に近い形の測定：思考を止める指定あり → 思考 ${off.thinkingChars}字 / ` +
        `答え ${off.answerChars}字 / 出力 ${off.outputTokens ?? "不明"}トークン`
    );
  } catch (error) {
    if (isAborted(error) || isFatal(error)) return failedOutcome(label, error);
    // **失敗から「効かない」とは決めない**（規則5）。記録に残して続ける
    offFailure = error;
    logStep(`仕事に近い形の測定：思考を止める指定ありの回が失敗（${describeFailure(error)}）`);
  }

  let on: ThinkingObservation | undefined;
  let onFailure: unknown;
  try {
    const result = await sendTypoSample(context, TUNING_WORK_SHORT, {
      disableThinking: false,
      roomyOutput: true,
    });
    on = observe(result);
    logStep(
      `仕事に近い形の測定：思考を止める指定なし → 思考 ${on.thinkingChars}字 / ` +
        `答え ${on.answerChars}字 / 出力 ${on.outputTokens ?? "不明"}トークン`
    );
  } catch (error) {
    if (isAborted(error) || isFatal(error)) return failedOutcome(label, error);
    onFailure = error;
    logStep(`仕事に近い形の測定：思考を止める指定なしの回が失敗（${describeFailure(error)}）`);
  }

  const verdict = judgeThinking(on, off);
  if (verdict === undefined) {
    const reason = onFailure ?? offFailure;
    return {
      summary:
        "考えるモデルかどうかは確かめられませんでした" +
        (reason !== undefined ? `（${describeFailure(reason)}）` : "") +
        "。",
    };
  }
  return {
    summary: describeThinkingVerdict(verdict, on, offFailure),
    record: {
      thinkingSeen: verdict.thinkingSeen,
      thinkingOffWorks: verdict.thinkingOffWorks,
      /*
        **効くと分かったら消す。** 前の測定で「効かない」と書いた見込みが
        残ると、以後ずっと出力の見込みへ足され続ける
      */
      thinkingOverheadTokens: verdict.thinkingOverheadTokens,
      thinkingMeasuredAt: nowIso(),
    },
  };
}

/** 見分けた結果を、作者の言葉にする */
export function describeThinkingVerdict(
  verdict: ThinkingVerdict,
  on: ThinkingObservation | undefined,
  offFailure: unknown
): string {
  if (verdict.thinkingSeen === false) {
    return "思考を止める指定を送らなくても思考は出ませんでした（考えないモデルとして扱います）。";
  }
  const amount =
    on !== undefined && on.thinkingChars > 0
      ? `（止める指定を送らないと、思考に約${on.thinkingChars.toLocaleString("ja-JP")}字）`
      : "";
  if (verdict.thinkingOffWorks === true) {
    return `考えるモデルでした${amount}。思考を止める指定が効くことを確かめました。`;
  }
  if (verdict.thinkingOffWorks === false) {
    return (
      `考えるモデルで、思考を止める指定が効きませんでした${amount}。` +
      `出力の見込みに、1回あたり約${(verdict.thinkingOverheadTokens ?? 0).toLocaleString("ja-JP")}` +
      "トークンの思考のぶんを足します。"
    );
  }
  return (
    `考えるモデルでした${amount}。思考を止める指定が効くかは確かめられませんでした` +
    (offFailure !== undefined ? `（${describeFailure(offFailure)}）` : "") +
    "。"
  );
}

/* ── 段2：仕事に近い形の時間 ──────────────────────── */

async function runWorkStage(context: StageContext): Promise<StageOutcome> {
  const label = "仕事に近い形の時間";
  /*
    **手元のAIは、測る直前に、測るのと同じ形の1回を入れる**（時間に
    数えない。リーダーの決まり、2026-09-26）。

    **前の段が載せたことを当てにしない**（実接続 2026-09-26、gemma4:e4b）。
    前の段の「思考を止めない回」は出力の上限を広く取るので、Ollama へ渡る
    文脈の長さ（`num_ctx`）が違い、次の回でモデルが**読み込み直される**。
    そのまま測ると、短い文の1回目が17.4秒（長い文は3.3秒）になり、固定の
    秒数が読み込みの時間で狂った。同じ形の1回を先に入れれば、読み込み
    直しはその1回に吸われる。
  */
  if (context.target.local) {
    try {
      // **本文は測る回と書き出しを変える**（同じだと、読み込みの使い回しで
      // 短い回が0.2秒になった。`core/tuningWorkSample.ts`）
      await sendTypoSample(context, TUNING_WORK_WARMUP, { disableThinking: true });
      logStep("仕事に近い形の測定：測る形でモデルを読み込ませました（この1回は時間に数えません）");
    } catch (error) {
      return failedOutcome(label, error);
    }
  }

  const samples: WorkSample[] = [];
  const notes: string[] = [];
  let nearlyEmpty = false;
  for (const body of [TUNING_WORK_SHORT, TUNING_WORK_LONG]) {
    const sentAt = Date.now();
    let result: GenerateResult;
    try {
      result = await sendTypoSample(context, body, { disableThinking: true });
    } catch (error) {
      return failedOutcome(label, error);
    }
    // **AIが申告した所要時間を先に使う**（順番待ちの時間を混ぜない。
    // `ai/meteredProvider.ts` は待ち終えてから中へ渡す）
    const ms = result.elapsedMs > 0 ? result.elapsedMs : Date.now() - sentAt;
    const seconds = ms / 1000;
    samples.push({ bodyChars: body.length, seconds });
    if (result.text.trim().length < 20) nearlyEmpty = true;
    notes.push(
      `${body.length.toLocaleString("ja-JP")}字は${seconds.toFixed(1)}秒` +
        (result.usage && result.usage.outputTokens > 0
          ? `（出力${result.usage.outputTokens.toLocaleString("ja-JP")}トークン）`
          : "")
    );
    logStep(
      `仕事に近い形の測定：本文 ${body.length}字 → ${seconds.toFixed(1)}秒 / ` +
        `答え ${result.text.length}字 / 出力 ${result.usage?.outputTokens ?? "不明"}トークン`
    );
  }

  /*
    **測った直後に、載っているモデルを見る**（Ollama だけ）。測るモデルは
    いま載っているはずなので、ここで見れば「ほかのモデルが居たか」と
    「GPU に入りきったか」が両方分かる。
  */
  const residency = await readResidency(context);

  const rate = fitWorkRate(samples);
  if (rate === undefined) {
    return {
      summary:
        `${label}：${notes.join("、")}でしたが、見込みの式を決められませんでした。` +
        residency.note,
    };
  }
  const timeoutSeconds = recommendTimeoutFromWorkRate(
    rate,
    maxTimeoutSeconds(context.provider.id)
  );
  const reference = predictWorkSeconds(rate, WORK_REFERENCE_CHARS);
  return {
    summary:
      `誤字脱字と同じ形で、${notes.join("、")}でした。` +
      `1回あたり約${rate.fixedSeconds}秒＋本文1000字あたり約${rate.secondsPer1000Chars}秒と見込みます` +
      `（${WORK_REFERENCE_CHARS.toLocaleString("ja-JP")}字を1回送るなら約${Math.round(reference)}秒）。` +
      (nearlyEmpty
        ? "答えがほとんど空の回があったので、実際の機能ではもっとかかることがあります。"
        : "") +
      residency.note,
    record: {
      workSecondsPer1000Chars: rate.secondsPer1000Chars,
      workFixedSeconds: rate.fixedSeconds,
      workMeasuredAt: nowIso(),
      /*
        **印は測るたびに書く**（見られなかったら `undefined` で消す）。
        台帳は差分で書かれるので、省くと前の測定の印が今回の値に付いたまま
        残る（`contextHitCeiling` で踏んだ穴と同じ）。
      */
      workOtherModelsLoaded: residency.otherModelsLoaded,
      workSplitAcrossCpu: residency.splitAcrossCpu,
    },
    propose: { timeoutSeconds },
  };
}

/** 測ったときに載っていたモデルから分かったこと */
interface Residency {
  /** 測るモデルのほかに載っていたか。見られなければ undefined */
  readonly otherModelsLoaded?: boolean;
  /** 測るモデルが GPU と CPU に分けて載っていたか。見られなければ undefined */
  readonly splitAcrossCpu?: boolean;
  /** 結果の文に足す一文（言うことが無ければ空） */
  readonly note: string;
}

/**
 * 載っているモデルを見て、印と一文にする。
 *
 * **ほかのモデルは下ろさない**（`StageContext.readLoadedModels` に理由）。
 * 印を付けて、時間が長めに出ているかもしれないことを言うだけにする。
 */
async function readResidency(context: StageContext): Promise<Residency> {
  if (!context.readLoadedModels) return { note: "" };
  let loaded: readonly OllamaLoadedModel[] | undefined;
  try {
    loaded = await context.readLoadedModels();
  } catch {
    loaded = undefined;
  }
  if (loaded === undefined) {
    logStep("仕事に近い形の測定：読み込まれているモデルを確かめられませんでした（印は付けません）。");
    return { note: "" };
  }
  const own = loaded.find((model) => model.name === context.model);
  const others = loaded.filter((model) => model.name !== context.model);
  // **見た数字をそのまま残す**（size と size_vram。申告が当てにならない
  // モデルがあるので、判断に使わない値もログには写す。`core/gpuLoad.ts`）
  logStep(
    "仕事に近い形の測定：測った直後に読み込まれていたモデル " +
      (loaded.length === 0
        ? "なし"
        : loaded
            .map(
              (model) =>
                `${model.name}（size ${model.sizeBytes ?? "不明"} / size_vram ${model.sizeVramBytes}）`
            )
            .join("・"))
  );
  const split = own !== undefined ? isSplitAcrossCpu(own) : undefined;
  const notes: string[] = [];
  if (others.length > 0) {
    notes.push(
      `測ったとき、ほかのモデル（${others.map((model) => model.name).join("・")}）も` +
        "読み込まれていました。GPU を分け合っていた可能性があるので、時間は長めに" +
        "出ているかもしれません（ほかのモデルは下ろしていません）。"
    );
  }
  if (split === true) {
    notes.push(
      "このモデルは GPU に入りきらず、一部を CPU で動かしていました（Ollama の申告）。"
    );
  }
  return {
    otherModelsLoaded: others.length > 0,
    splitAcrossCpu: split,
    note: notes.join(""),
  };
}

/* ── 段3：読める長さの申告 ───────────────────────── */

/** 断らせる回と確かめの回に送る、短い問い（答えは「はい」だけで済む） */
const DECLARED_PROBE_SYSTEM = "問いに一言で答えてください。";
const DECLARED_PROBE_USER = "「はい」とだけ答えてください。";

/** 台帳へ写す、断られた文の長さ */
const DECLARED_TEXT_EXCERPT_CHARS = 300;

async function sendDeclaredProbe(
  context: StageContext,
  maxOutputTokens: number
): Promise<GenerateResult> {
  return context.provider.generate({
    systemPrompt: DECLARED_PROBE_SYSTEM,
    userPrompt: DECLARED_PROBE_USER,
    model: context.model,
    temperature: 0,
    maxOutputTokens,
    disableThinking: true,
    disableStreaming: true,
    /*
      **関所を素通りさせる**（読める長さの測定と同じ名前）。関所は出力の
      見込みが読める長さに届くと上限を縮めて送る（6.22.1①）ので、通すと
      サーバーに断らせることができない。わざと上限を試す呼び出しである。
    */
    meta: { feature: CONTEXT_GUARD_EXEMPT_FEATURE },
    signal: context.signal,
  });
}

async function runDeclaredLimitStage(context: StageContext): Promise<StageOutcome> {
  const label = "読める長さの申告";
  let declaredText: string;
  try {
    await sendDeclaredProbe(context, DECLARED_LIMIT_PROBE_OUTPUT_TOKENS);
    return {
      summary:
        "大きな出力の上限を頼んでも断られなかったので、読める長さの申告は" +
        "読めませんでした（サーバーが長さを述べない作りか、とても長く読めるモデルです）。",
    };
  } catch (error) {
    if (isAborted(error) || isFatal(error)) return failedOutcome(label, error);
    if (
      !(error instanceof AIError) ||
      (error.kind !== "context_overflow" && error.kind !== "bad_response")
    ) {
      return failedOutcome(label, error);
    }
    declaredText = error.detail ?? error.message;
  }

  // **断られた文は必ず残す**（規則5。読み違えたときに辿れるように）
  logStep(`仕事に近い形の測定：読める長さの申告 → 断られた文: ${declaredText.slice(0, 500)}`);
  const declared = parseDeclaredContextLimit(declaredText);
  if (declared === undefined) {
    return {
      summary: "大きな出力の上限は断られましたが、断りの文に読める長さは書かれていませんでした。",
    };
  }

  /*
    **読んだ値をすぐには覚えない**（規則5「覚えるのは通ったときだけ」）。
    その長さに収まる要求を送り、通ったときだけ「反映」の候補にする。
    読み違えていれば、ここが断られて何も変わらない。
  */
  const confirmTokens = declared - DECLARED_LIMIT_CONFIRM_MARGIN;
  try {
    await sendDeclaredProbe(context, confirmTokens);
  } catch (error) {
    if (isAborted(error) || isFatal(error)) return failedOutcome(label, error);
    logStep(
      `仕事に近い形の測定：読める長さ ${declared} に収まる要求（出力の上限 ${confirmTokens}）が` +
        `通りませんでした（${describeFailure(error)}）。覚えません。`
    );
    return {
      summary:
        `サーバーは読める長さを${declared.toLocaleString("ja-JP")}トークンと述べましたが、` +
        "その長さに収まる要求が通らなかったので、覚えません。",
    };
  }
  return {
    summary:
      `サーバーが述べた読める長さは${declared.toLocaleString("ja-JP")}トークンでした` +
      "（その長さに収まる要求が通ることを確かめました）。",
    propose: {
      contextWindow: declared,
      contextDeclared: declaredText.slice(0, DECLARED_TEXT_EXCERPT_CHARS),
      contextDeclaredAt: nowIso(),
    },
  };
}

/** 段の名前ごとの走らせ方。**段を足したらここへ1つ足す** */
export const STAGE_RUNNERS: Readonly<Record<TuningStageId, StageRunner>> = {
  thinking: runThinkingStage,
  work: runWorkStage,
  declaredLimit: runDeclaredLimitStage,
};

/* ── 入口：仕事に近い形で測る ───────────────────────── */

/**
 * 「仕事に近い形で測る」を選んだときの道（設計書6.49.9）。
 *
 * **有料AIでは、測る前に回数を示す**（作品の決まり「確認は処理量とコストを
 * 示してから」）。段ごとの回数と合計は段の一覧から組む。
 */
export async function runWorkTuning(provider: AIProvider, model: string): Promise<void> {
  const target: TuningStageTarget = {
    providerId: provider.id,
    local: isLocalProvider(provider.id),
  };
  const stages = plannedStages(target);
  const plan = describeStagePlan(target);
  const ok = await confirmPaidUsage(provider, {
    actionLabel: "AIチューニング",
    remember: { id: "ai.paid.measureContext" },
    model,
    calls: plannedCallCount(target),
    detail: `${plan}\n送るのは製品に同梱した短い文だけで、作品の本文は送りません。`,
  });
  if (!ok) return;

  const key = modelTuningKey(provider.id, model);
  logStep(`仕事に近い形の測定を開始: ${provider.displayName} / ${key} / ${plan}`);

  const result = await withCancellableProgress(
    "AIチューニング：仕事に近い形で測っています",
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      return runTuningStages(
        {
          provider,
          model,
          target,
          signal: controller.signal,
          report: (message) => progress.report({ message }),
          // 載っているモデルを読めるのは Ollama だけ（`/api/ps`）。
          // 宛先の組み立てと通信の口は、管理外の負荷の見張り
          // （`features/localAiGate.ts`）と同じ書き方にする
          ...(provider.id === "ollama"
            ? {
                readLoadedModels: () =>
                  readOllamaPsWith((psSignal) =>
                    localFetch(
                      `${ollamaEndpoint().replace(/\/+$/, "")}/api/ps`,
                      { signal: psSignal },
                      2000
                    )
                  ),
              }
            : {}),
        },
        stages
      );
    }
  );

  const summary = result.summaries.join("");
  logStep(
    `仕事に近い形の測定を終了: ${summary}` +
      (result.cancelled ? "（中止したため、途中までの結果です）" : "")
  );

  if (result.fatal !== undefined) {
    void errorWithLog(
      `${summary}\n${recoveryForAIError(result.fatal)}`
    );
    return;
  }
  await offerStageProposals(provider.id, model, summary, result);
}

/**
 * 押したときだけ書く欄を見せて、反映するかを訊く。
 *
 * **押さなくても残した欄（1000字あたりの秒数・考えるモデルか）は、
 * 入ったときだけそう言う**——書けていないのに「記録に残してあります」と
 * 言うと、作者が気づく手がかりを塞ぐ（2026-09-19 の報告と同じ穴）。
 */
async function offerStageProposals(
  providerId: string,
  model: string,
  summary: string,
  result: StagesResult
): Promise<void> {
  const key = modelTuningKey(providerId, model);
  const prefix = result.cancelled ? "（途中で中止しました）" : "";
  const recordedNote = result.recorded
    ? "1000字あたりの秒数と、考えるモデルかどうかは、押さなくても記録に残しました" +
      "（押す前の所要時間の見込みと、出力の見込みに使います）。"
    : "";
  const { proposal } = result;
  const parts: string[] = [];
  if (proposal.timeoutSeconds !== undefined) {
    parts.push(`待ち時間 ${proposal.timeoutSeconds}秒`);
  }
  if (proposal.contextWindow !== undefined) {
    parts.push(
      `読める長さ ${proposal.contextWindow.toLocaleString("ja-JP")}トークン（サーバーが述べた値）`
    );
  }
  if (parts.length === 0) {
    void vscode.window.showInformationMessage(`${prefix}${summary}${recordedNote}`);
    return;
  }

  const answer = await vscode.window.showInformationMessage(
    `${prefix}${summary}${recordedNote}` +
      `いま選んでいるモデル（${key}）のAIチューニングの記録として` +
      `（VS Code の設定ではなく、拡張機能の保管庫の ${TUNING_STORE_FILE} に）、` +
      `${parts.join("と、")}を反映できます。ほかのモデルには影響しません。`,
    "設定に反映",
    "そのままにする"
  );
  if (answer !== "設定に反映") return;

  const outcome = await saveModelTuning(providerId, model, {
    ...(proposal.timeoutSeconds !== undefined
      ? { timeoutSeconds: proposal.timeoutSeconds }
      : {}),
    ...(proposal.contextWindow !== undefined
      ? {
          contextWindow: proposal.contextWindow,
          contextDeclared: proposal.contextDeclared,
          contextDeclaredAt: proposal.contextDeclaredAt,
        }
      : {}),
  });
  if (outcome !== "written") {
    logFailure("仕事に近い形の測定", {
      台帳: outcome,
      対象: key,
      本文: describeTuningWriteFailure(outcome),
    });
    void vscode.window.showWarningMessage(
      `${key} の測定結果を記録できませんでした。${describeTuningWriteFailure(outcome)}`
    );
    return;
  }
  logStep(`仕事に近い形の測定：${key} に反映しました（${parts.join(" / ")}）。`);
  void vscode.window.showInformationMessage(
    `${key} の記録として覚えました（${parts.join(" / ")}）。ほかのモデルには影響しません。`
  );
}
