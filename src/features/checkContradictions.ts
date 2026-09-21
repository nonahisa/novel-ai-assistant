import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  AIError,
  isFatalProviderFailure,
  recoveryForAIError,
} from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import {
  describeChunkScope,
  locateChunkLine,
  splitMergedChunk,
  withLineNumbers,
  type Chunk,
} from "../core/chunker";
import { linesAround } from "../core/factContradiction";
import { ChunkCache, type CacheKeyBase } from "../core/chunkCache";
import { measureParts } from "../core/usageLog";
import {
  capabilityCacheTag,
  capabilityProfile,
  describeCapability,
  describeContradictionCapabilityForAuthor,
} from "../ai/capability";
import { resolveModelInfoOrWarn } from "./chunkSettings";
import { collectManuscriptChunks } from "./manuscriptChunks";
import { isContextOverflow, retryOnOverflow } from "./chunkRetry";
import { factsRevealedAfter } from "../core/settingsAsOf";
import {
  buildContradictionTermIndex,
  carryOverBodyText,
  createContradictionMaterial,
  describeMissedCharacters,
  mergeMissedCharactersByEpisode,
  promptVersionWithCarryOver,
  CARRY_OVER_DEFAULT_CHAPTERS,
  CHARACTER_AS_OF_FIELDS,
  type CarryOverBody,
  type CarryOverResult,
  type MissedCharacters,
  type MissedCharactersInChunk,
  type RelevantOptions,
  type RelevantSettings,
} from "../core/contradictionMaterial";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import { SynopsisStore } from "../core/synopsisStore";
import { settingsFingerprint } from "../core/settingsSummary";
import { worldviewMaxChars } from "../core/worldviewSelect";
import {
  anyPastSceneReachable,
  buildPastScenes,
  pastSceneMaxChars,
  promptVersionWithPastScenes,
  PastSceneIndex,
} from "../core/pastSceneSelect";
import { loadExcerptSources } from "../core/manuscriptSources";
import type { ExcerptSource } from "../core/mentionExcerpts";
import {
  buildContradictionCheckPrompt,
  CONTRADICTION_CATEGORIES,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT,
  CONTRADICTION_CHECK_TEMPERATURE,
  CONTRADICTION_CHECK_VERSION,
  LIGHT_CATEGORIES,
  type ContradictionCategory,
} from "../prompts/contradictionCheck";
import {
  buildContradictionVerifyPrompt,
  CONTRADICTION_VERIFY_SCHEMA,
  CONTRADICTION_VERIFY_SYSTEM_PROMPT,
  CONTRADICTION_VERIFY_TEMPERATURE,
  CONTRADICTION_VERIFY_VERSION,
  type VerifyRejectReason,
} from "../prompts/contradictionVerify";
import {
  describeVerifyResults,
  parseVerifyOutcome,
  undecidedOutcome,
  type VerifyOutcome,
} from "../core/contradictionVerifyValidation";
import { buildKnownAtIndex, lookupKnownAtValue,
  contradictionKey,
  parseContradictionResult,
  sortContradictions,
  validateContradictions,
  type AcceptedContradiction,
} from "../core/contradictionValidation";
import {
  startRunEta,
  withCancellableProgress,
  type CheckProgress,
} from "../views/progress";
import { estimateRunTimeText } from "../ai/runTimeEstimate";
import type { SuiteAwareOptions } from "../core/proofreadingSuite";
import { withAiTurn } from "./aiTurn";
import { confirmProviderReachable } from "./aiConnectivity";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";
// 落とした理由の内訳は、通知ではなく操作ログへ残す（設計書6.8）
import { summarizeReasons } from "../core/checkRunCounts";
import { hashText } from "../core/textFile";
import { confirmRun } from "../views/notify";

/**
 * 矛盾検知（P-12、設計書6.10.1）。
 *
 * 既に作った設定資料を「正」として本文と突き合わせる。ただし
 * **設定側が古い・誤っていることがある**（抽出はAIがやっており、
 * 作者が直していない項目も多い）。したがって、
 *
 * - **何も自動で直さない。** 誤字脱字と違い、どちらが正しいかは作者にしか決められない
 * - 指摘は「設定ではこう／本文ではこう」を並べるだけにする
 * - 解決の道を2つ出す（本文を直す／設定を直す）
 *
 * **設定が無い作品では実行しない。** 照らし合わせる相手が無いのに
 * AIへ投げると、本文だけを見て「矛盾していそうなこと」を作り出す。
 */

/**
 * 「まとめたせいで入り切らなかった。分けて試し直す」の印。
 *
 * **`undefined`（この本文は飛ばす）と区別する。** 同じ値にすると、
 * 切り詰められたチャンクが黙って捨てられる。
 */
const RETRY_SMALLER = Symbol("retry-smaller");

/** 項目の名前を、作者に読める言葉にする */
const FIELD_LABELS: Record<string, string> = {
  summary: "紹介",
  role: "役割",
  personality: "性格",
  appearance: "外見",
  gender: "性別",
  affiliation: "所属",
  region: "地域",
  description: "説明",
};

export interface ContradictionRunResult {
  issues: AcceptedContradiction[];
  /** 本文に無い引用など、弾いた件数 */
  rejectedCount: number;
  /** 応答が読めなかったチャンク数 */
  failedChunks: number;
  /**
   * **本文そのものを読めなかった話の数**（AIへ渡せていない。ログに詳細）。
   *
   * **黙って落とさない。** 文字コードの壊れた話やロックされた話が1つあると、
   * その話だけ検知の対象から抜けるのに、作者には「その話には何も無い」と
   * 見える。
   */
  unreadableEpisodes: number;
  cancelled: boolean;
  /** 処理したチャンク数 */
  processedChunks: number;
  /**
   * 検証で何件を取り下げたか（設計書6.10.5）。
   *
   * **黙って消さない。** 内訳が見えないと、指摘が少ないのが
   * 「本当に無い」のか「消しすぎている」のか作者に分からない。
   */
  verifyNote: string;
  /**
   * **突き合わせなかった人物があることの断り**（設計書6.10.6）。
   * 落ちた話が無ければ空文字。
   *
   * **穴は塞がない。塞がずに、落としたことを言う。** 材料が落ちても結果は
   * 「矛盾なし」と出るので、これが無いと作者には**突き合わせていないのか、
   * 突き合わせて問題が無かったのか**が区別できない。誰を落としたかの詳細は
   * 操作ログ（`logStep`）にある。
   */
  missedNote: string;
}

export interface CheckContradictionsOptions extends SuiteAwareOptions {
  /** 話を絞る。指定しなければ作品全体 */
  filePaths?: string[];
  /**
   * 本文を読む段の進み具合の届け先（作者の報告、2026-08-29）。
   *
   * 検証の段は `onVerifyProgress` へ**別に**届ける。数え方（見つけた指摘の
   * 件数）も分母も違うので、同じ札の下へ流すと数が戻って見える。
   */
  onProgress?: CheckProgress;
  /**
   * 検証の段（設計書6.10.5）の進み具合の届け先。単位は「件」。
   *
   * 当初はここを流しておらず、本文を読み終えたあと提案パネルの進みが
   * 「12/12チャンク」で止まったまま検証が続く形だった。検証はAIを
   * 指摘1件につき1回呼ぶので、件数が多いと**止まって見える時間が長い**。
   * 別の札（「検出した矛盾を検証」）で件数を流す
   */
  onVerifyProgress?: CheckProgress;
  /**
   * 前の話を何話ぶん引き継いで人物を探すか（設計書6.10.6）。
   *
   * **既定は `CARRY_OVER_DEFAULT_CHAPTERS`（2話）。** 一人称で語る主人公は
   * 自分の名前を言わないので、その話では主人公の設定が材料に1つも載らない
   * ——直前の話の本文も索引にかければ拾える。0.70.5 で測るための口として
   * 足し、**測ってから 0.73.3 で既定にした**（6.102「測ってから言う」）。
   * 値を変える口は MCP の `options.carryOver`。
   */
  carryOverChapters?: number;
}

export async function checkContradictions(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckContradictionsOptions = {}
): Promise<ContradictionRunResult | undefined> {
  useLogFile(work.folderPath);

  const resolved = await ensureConfigured(registry, "contradiction");
  if (!resolved) return undefined;

  // **モデルの情報を先に1回だけ引く。** チャンクの大きさも、観点の絞りも、
  // 世界観に回してよい字数も、すべてここから決まる（設計書6.27.10）。
  // 2回引くと、2回の結果が食い違ったときにどちらで動いたのか分からなくなる。
  //
  // **取れなければ止める。** 以前はここで `?? 8192` へ黙って落ちており、
  // 131,072のモデルでもチャンクが1,500字になってキャッシュが全滅していた
  const info = await resolveModelInfoOrWarn({
    registry,
    feature: "contradiction",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "矛盾検知",
  });
  if (!info) return undefined;
  const tier = info.tier;

  // 地力の足りないモデルには観点を絞って渡す（設計書6.28）。
  // **鍵より先に決める。** 観点が変われば答えも変わるので、
  // 鍵にも反映しなければ古い結果が再利用される
  //
  // **パラメータ数も渡す**（設計書6.10.8）。矛盾検知の抑制は、観点の絞りとは
  // 別の境目（20B）で決まる——ティアでは代わりにならない
  const capabilityInput = {
    tier,
    providerId: resolved.provider.id,
    parameterSize: info.parameterSize,
  };
  const capability = capabilityProfile(capabilityInput);
  /*
    **小さいモデルには、抑制を残した版を送る**（設計書6.10.8）。

    1.6 でゆるめて得をしたのは 26b 以上だけで、`e4b` と `12b` では
    当たりが増えないまま誤検出だけ増えた。**「疑わしい」の線引きは、
    モデルの大きさと一対**なので、大きさで送り分ける。
  */
  const systemPrompt = capability.suppressUncertainContradictions
    ? CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT
    : CONTRADICTION_CHECK_SYSTEM_PROMPT;
  // 地力の足りないモデルでは観点を絞る。1回の負荷を下げないと検出漏れが増える
  const categories: readonly ContradictionCategory[] =
    capability.narrowContradictionCategories
      ? LIGHT_CATEGORIES
      : CONTRADICTION_CATEGORIES;

  // **参照資料の上限は、モデルの上限に対する割合で決める**（設計書6.27.10）。
  // 固定30,000字のままだと、32kのモデルでは本文を1文字も足さないうちに溢れる
  const material = await collectSettings(
    work,
    worldviewMaxChars(info.contextWindow),
    options
  );
  if (!material) return undefined;
  // 下の入れ子の関数では、上の `if (!material) return` による絞り込みが
  // 効かない（関数宣言は巻き上がるので、絞り込みの前に呼ばれうるとみなされる）。
  // **ここで束ねる。** 過去の場面を引く関数が、鍵を決める段（＝下の
  // `settings` の宣言より前）から呼ばれるので、束ねる場所も前へ出してある
  const settings = material;

  // **本文を空にしてプロンプトを組み、その字数を固定費とする。**
  // 見込みの定数を置くと、プロンプトの改訂に置いていかれて必ず追い越される。
  //
  // 人物・場所はチャンクに出てきた名前だけを載せるので、**切る前には
  // 測れない**。測れる分（指示＋世界観の見込み）をここで引き、測れない分は
  // 送る直前の関所（`ai/contextGuard.ts`）と、逃げ道（`chunkRetry.ts`）が受ける
  const overheadChars =
    // **実際に送るほうで測る。** 抑制を残した版は少し短いので、
    // 送らない版の長さで見込むと固定費が実際とずれる
    systemPrompt.length +
    buildContradictionCheckPrompt({
      chapterLabel: "",
      chunkTextWithLineNumbers: "",
      characterDetails: "",
      locationDetails: "",
      worldviewSummary: "",
      previousSynopses: "",
      categories,
      futureFacts: "",
    }).length +
    material.referenceBudgetChars;

  // **応答の見込みに実測を使う**（設計書6.65.16の2）
  const outputTuning = { providerId: resolved.provider.id, model: resolved.model };
  /*
    **`contradiction_check` の実測で通す**（設計書6.77の第3段）。

    この1組を、本体（過去向き）と未来向きの**両方**が使う——同じ
    `generate` 呼び出しで、記録の名前だけが `mode` で変わるためである。
    計画（チャンクの大きさ）は走り始めに1回しか決められないので、
    ここで向きごとに変えると**計画と関所が食い違う**（まさに直している
    ことをやり直すことになる）。実測では本体10,229・未来8,570で、
    **大きいほうが本体**なので、本体で通せば未来側が足りなくなることは無い。
  */
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    outputTuning.providerId,
    outputTuning.model,
    "contradiction_check"
  );
  // **場所の確保（上）と、実際に送る上限（下）は別物である**（設計書6.77の
  // 第2段）。上を上限として送ると、測っていないモデルでは上限が設定値の
  // 半分になり、長い応答が途中で切れる
  const sendOutputTokens = resolveOutputTokensForSend(
    outputTuning.providerId,
    outputTuning.model,
    "contradiction_check"
  );
  /*
    **検証は別に見込む**（設計書6.77の第3段）。指摘1件ごとに1回呼ぶ短い
    仕事で、実測は本体の4分の1（2,459 対 10,229）である。本体の見込みを
    そのまま使うと、要らない席を4倍空けたまま何十回も呼ぶことになる。
  */
  const verifyPlannedOutputTokens = resolveOutputTokensForPlanning(
    outputTuning.providerId,
    outputTuning.model,
    "contradiction_verify"
  );
  const verifySendOutputTokens = resolveOutputTokensForSend(
    outputTuning.providerId,
    outputTuning.model,
    "contradiction_verify"
  );
  const tasks = await collectManuscriptChunks({
    work,
    info,
    options,
    fixedCost: { overheadChars, outputTokens: plannedOutputTokens },
    outputTuning,
    logLabel: "矛盾検知",
  });
  const { chunks, chapterLabelByFile, chunkNote, unreadableEpisodes } = tasks;
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("検知できる本文がありませんでした。");
    return undefined;
  }

  // **過去の関連場面の索引を、ここで1回だけ作る**（設計書6.74）。
  // チャンクごとに全話を読み直すと、作品の大きさぶんだけ二乗で効く。
  //
  // **チャンクの割当（`overheadChars`）には足していない。** 人物・場所の
  // 設定と同じく、チャンクに出た名前しだいで量が変わる材料なので、
  // 切る前には測れない。入るかどうかは送る直前の関所（`ai/contextGuard.ts`）と
  // 逃げ道（`chunkRetry.ts`）が受ける——ここで見込みを足すと、抜粋が0件の
  // 作品まで本文の割当が痩せ、チャンクの切れ目が変わってキャッシュが飛ぶ
  const pastSceneBudget = pastSceneMaxChars(info.contextWindow);
  // **全話の本文はここで1回だけ読む。** 過去の場面の索引（6.74）と、
  // 前の話の本文（6.10.6）が同じものを見る
  const episodeSources = await collectEpisodeSources(work);
  // **渡りうるときだけ組む**（0.32.6のレビュー）。合本（1ファイルに全話）の
  // 作品では、全チャンクが合本の最小話数を名乗るので抜粋は必ず0件になる。
  // それでも索引を組み、確認ダイアログでは「渡します」と告げていた
  const pastSceneIndex = collectPastScenes(
    episodeSources,
    chunks.map((chunk) => chunk.chapterStart)
  );
  /** チャンクごとの抜粋。鍵を決めるときと送るときで、同じものを使う */
  const pastSceneByChunk = new Map<string, string>();

  /*
    **前の話の本文**（設計書6.10.6）。2つの用途で使う。

    1. 引き継ぎ（`carryOverChapters`）——**材料へ人物を足す**。既定は2話
       （0.73.3。作者の裁定）
    2. **落としたことを言う**——直前の1話だけを見て、「物語の流れでは居る
       はずなのに、この話の材料から落ちた人物」を数える。**材料は変えない**

    2 は既定でも要るので、本文は必ず要る。**読むのは1回だけ**——
    `collectPastScenes` と同じものを見るので、分けて読むと話数ぶんの
    ファイルを二度読むことになる。
  */
  const carryOverChapters =
    options.carryOverChapters ?? CARRY_OVER_DEFAULT_CHAPTERS;
  const carryOverBodies = carryOverBodiesOf(episodeSources);
  /** チャンクごとの引き継ぎ。鍵を決めるときと送るときで、同じものを使う */
  const carryOverByChunk = new Map<string, CarryOverResult>();
  /** チャンクごとの「直前の1話」。**材料には入らない**（数えるためだけ） */
  const previousBodyByChunk = new Map<string, string>();

  // **設定が変われば、同じ本文でも答えが変わる。**
  // 材料のハッシュをキャッシュの鍵へ入れないと、設定を直したのに
  // 古い指摘が出続ける
  const cache = new ChunkCache(work);
  await cache.load();
  const cacheKeyBase = {
    feature: "contradiction_check",
    // 絞らないときは印が空になるので、`high` のモデルの鍵はこれまでと
    // 同じままになる（有料AIで処理済みのキャッシュを飛ばさない）
    promptVersion:
      `${CONTRADICTION_CHECK_VERSION}:` +
      `${capabilityCacheTag(capability, "contradiction")}${material.fingerprint}`,
    providerId: resolved.provider.id,
    model: resolved.model,
  };

  // **向きが違えば答えも違う。** 同じ鍵に入れると、片方が他方を上書きする
  const futureKeyBase = {
    ...cacheKeyBase,
    feature: "contradiction_future",
  };
  // 検証は別のプロンプトなので、版も別に持つ
  const verifyKeyBase = {
    feature: "contradiction_verify",
    // 検証のプロンプトは観点で変わらないので、印を混ぜない
    promptVersion: `${CONTRADICTION_VERIFY_VERSION}:${material.fingerprint}`,
    providerId: resolved.provider.id,
    model: resolved.model,
  };

  // **鍵は渡す抜粋ごとに変える**（設計書6.74）。過去の話を書き直したら、
  // 同じチャンクでも答えが変わりうる（settingsFingerprint と同じ理屈）
  const pending = chunks.filter(
    (chunk) => !cache.get(chunk.hash, keyWithPastScenes(cacheKeyBase, chunk))
  );
  if (pending.length > 0) {
    // **モデル名を渡す。** LM Studioをこの場から起こしたとき、
    // 起こした直後に読み込ませるために要る（`aiConnectivity.ts`）
    if (
      !(await confirmProviderReachable(
        resolved.provider,
        "矛盾検知",
        resolved.model
      ))
    ) {
      return undefined;
    }
    const detail = [
      `${chunks.length}チャンク中 ${pending.length}件を処理します` +
        `（処理済み ${chunks.length - pending.length}件はスキップ）。`,
      // **どれくらいかかるかを先に出す**（設計書6.8.19）。219話では
      // 6時間規模になるので、「夜に回すか、いま回すか」を決める材料が要る
      estimateRunTimeText({
        providerId: resolved.provider.id,
        model: resolved.model,
        feature: "contradiction_check",
        count: pending.length,
      }),
      `材料: 人物${material.characterCount}人 / 場所${material.locationCount}件 / ` +
        `世界観${material.worldCount}件`,
      // **送る量が増えることを黙らない**（設計書6.74）。過去の本文を
      // 足すので、有料AIでは料金にも効く
      pastSceneIndex
        ? `前の話の本文からも、名前の出てくる場面を探して渡します` +
          `（${pastSceneIndex.size}か所から最大${pastSceneBudget}字）。`
        : "",
      // **引き継ぐことを黙らない**（設計書6.10.6）。本文は送らないが、
      // 載る人物が増えるので、指摘の数も変わる
      carryOverChapters > 0
        ? `直前の${carryOverChapters}話に出てきた人物の設定も、` +
          "名前が出ていない話へ引き継ぎます（前の話の本文は送りません）。"
        : "",
      "",
      "この機能は本文を書き換えません。 設定と食い違う箇所を並べるだけで、",
      "どちらを直すかは作者が決めます（設定側が古いこともあります）。",
      // **モデルの地力で変わる断りは、1か所にまとめてある**
      // （`ai/capability.ts`。ログ向けの `describeCapability` の隣）。
      // 作者向けの文言とログの文言が食い違わないようにするため
      describeContradictionCapabilityForAuthor(capability),
      // **観点を絞ると鍵が変わり、キャッシュが総入れ替えになる。**
      // 何も変えていないのに全件が対象になると、作者は不具合だと思う
      pending.length === chunks.length && chunks.length > 1
        ? "\n（見る観点が前回から変わっているため、今回はすべて送り直します）"
        : "",
      resolved.provider.isPaid
        ? `\n${resolved.provider.displayName} はチャンクごとに課金されます。`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (options.suiteConfirmed) {
      // まとめ実行が先に1回だけ確認している（設計書6.80）。
      // **飛ばした中身はログへ残す**——観点を絞ったことや、過去の場面を
      // 足したことは、この確認の中にしか書かれていない
      logStep(`矛盾検知：まとめ実行のため確認を省略\n${detail}`);
    } else {
      const confirmed = await confirmRun(
        `${work.title} の矛盾を検知します。`,
        "実行",
        { detail, remember: { id: "ai.run.checkContradictions" } }
      );
      if (!confirmed) return undefined;
    }
  }

  logStep(
    `矛盾検知を開始: ${work.title} / ${resolved.provider.displayName} / ` +
      `${resolved.model}（${describeCapability(capabilityInput, capability, "contradiction")}） / ` +
      `${chunks.length}チャンク / ${chunkNote} / ` +
      `v${CONTRADICTION_CHECK_VERSION}`
  );

  /*
    **落としたことを言う**（設計書6.10.6）。

    材料に載るのは**本文に名前が出た人物だけ**なので、一人称で語る話では
    主人公の設定が1つも載らない（作者の219話で44話＝20%）。それでも結果は
    「矛盾なし」と出るため、作者には**突き合わせていないのか、突き合わせて
    問題が無かったのか**が区別できない。**穴は塞がない。落としたことを言う。**

    **AIを呼ぶ前に、全チャンクぶんを数える。** 処理済み（キャッシュ）の
    チャンクでも落ちていることは変わらないので、送るチャンクだけを見ると
    「2回目だけ何も言わない」ことになる。

    **引き継ぎ（既定2話）で塞げた回は、ここに出ない。** 出るのは引き継いで
    なお落ちた回だけ——作者の219話では2話ぶんにあたる。
  */
  const missedByEpisode = missedCharactersByEpisode();
  for (const entry of missedByEpisode) {
    logStep(
      // **手がかりの名前（登場話数・直前の話）を作者向けの文へ出さない。**
      // どちらで拾ったかは内部の都合で、作者に要るのは「見ていない」事実
      `矛盾検知：${entry.label}は「${entry.names.join("」「")}」の設定を` +
        "突き合わせていません（その話に登場するはずですが、" +
        "本文に名前が出ないため材料に載りませんでした）"
    );
  }
  // 完了の知らせへ出す1行。**落ちた話が0なら空**（毎回出る断りは読まれない）
  const missedNote = describeMissedCharacters(missedByEpisode);

  // 下の入れ子の関数では、上の `if (!resolved) return` による絞り込みが
  // 効かない（あとから書き換わりうるとみなされる）。ここで束ねておく
  const provider = resolved.provider;
  const model = resolved.model;

  /**
   * 検出した1件。**検証まで、どのチャンクの何行目かを持ち回る**
   * （設計書6.10.5）。前後の本文を渡すのに要る
   */
  const found: Array<{ issue: AcceptedContradiction; chunk: Chunk }> = [];
  let rejectedCount = 0;
  /**
   * 検証で落とした理由。**最後にまとめて操作ログへ出す**（設計書6.8）。
   * 総数だけでは、指摘が少ないのが「本当に無い」のか「消しすぎ」なのか
   * 切り分けられない
   */
  const rejectedReasons: string[] = [];
  const verifyRejected: Array<{ reason?: VerifyRejectReason }> = [];
  let verifyUndecided = 0;
  let failedChunks = 0;
  let cancelled = false;
  // 待っても直らない失敗を掴んだら、残りのチャンクは試さない
  let fatalFailure = "";
  /**
   * 検出の段の進み（何チャンク見たか／分母）。**中の関数ではなく、ここに置く。**
   *
   * 最後に「矛盾検知を終了」の1行を残すのに要る（誤字脱字側と同じ形）。
   * 中止や失敗で抜けた回でも、抜けたところまでの数がそのまま残る。
   *
   * **数えるのは、実際にAIへ送ったものだけである**（作者の指摘、
   * 2026-09-06）。キャッシュ命中まで分母に入れると、実際には1件しか
   * 動かない実行が「1/7」のまま止まったように見える。分母は分け直しで
   * 増えるので、`pending.length` とは別に持つ。
   */
  let chunksDone = 0;
  let chunksTotal = pending.length;
  /** 処理済みで飛ばした数。分母が小さくなっている断りとして画面へ添える */
  const skippedChunks = chunks.length - pending.length;
  let processedChunks = 0;

  /**
   * 検証を通った指摘。**札を取る前に置く**——順番待ちの最中に中止されると
   * 下の処理そのものが行われないので、中で宣言すると参照できない
   */
  const issues: AcceptedContradiction[] = [];

  // **検出と検証は、ひと続きの仕事として1つの札で回す**（設計書6.76）。
  // 関所（送信を1件ずつ）だけでは、ほかの一括処理と交互に流れて
  // モデルの読み込み直しが往復する。検証だけ別の札にすると、
  // 本文を読む段と検証の段のあいだに別の機能が割り込む
  await withAiTurn(
    {
      label: "矛盾の検知",
      onCancelled: () => (cancelled = true),
      // **まとめ実行から呼ばれたら、札は取らない**（設計書6.76・6.80）。
      // まとめ実行のほうが丸ごと持っているので、ここで取ると自分の札を
      // 自分で待つ形になり、永久に進まない
      alreadyHeld: options.suiteHoldsRun,
    },
    async () => {
      await withCancellableProgress("矛盾を検知しています", async (progress, token) => {
        // **輪に入る直前に時計を作る**（設計書6.8.19）。ここから先の
        // 実時間を、済んだ件数で割って残りを見積もる
        const runEta = startRunEta();
        const controller = new AbortController();
        token.onCancellationRequested(() => {
          cancelled = true;
          controller.abort();
        });

        // **まとめたチャンクは、切り詰められたら分けて試し直す**（設計書6.23）。
        // 部分的なJSONは読めないので、まとめたせいで入り切らなかったのなら
        // 元の大きさで出し直すほうがよい。処理中に増えるので配列で持つ
        const queue = [...chunks];

        for (let cursor = 0; cursor < queue.length; cursor++) {
          if (token.isCancellationRequested) break;
          if (fatalFailure) break;
          const chunk = queue[cursor];

          const cached = cache.get(chunk.hash, keyWithPastScenes(cacheKeyBase, chunk));
          const raw = cached ?? (await ask(chunk, "settled"));
          // **キャッシュ命中は数えない。** 進みが一気に飛んで待ち時間が
          // 読めなくなるうえ、分子が分母（送る件数）を超える
          if (cached === undefined) {
            chunksDone++;
            const eta = runEta.step(chunksDone, chunksTotal);
            progress.report({
              message: `${chunksDone}/${chunksTotal}${eta.suffix}`,
              increment: 100 / Math.max(chunksTotal, 1),
            });
            // 提案パネルにも同じ進みを出す（作者は結果が出る場所で待っている）
            options.onProgress?.(
              chunksDone,
              chunksTotal,
              skippedChunks,
              eta.remaining
            );
          }

          if (raw === RETRY_SMALLER) {
            const parts = splitMergedChunk(chunk);
            if (parts.length > 1) {
              queue.splice(cursor + 1, 0, ...parts);
              chunksTotal += parts.length;
              logStep(
                `切り詰められたため ${parts.length} 話に分けて試し直します: ${chunk.hash}`
              );
            } else {
              failedChunks++;
            }
            continue;
          }
          // 上限に入らなかった。**まとめたぶんを戻す→半分に割る→諦める**の順で、
          // 諦めるときは理由を残す（設計書6.27.10）
          if (raw instanceof AIError) {
            const retry = retryOnOverflow(chunk, raw);
            if (retry.kind === "split") {
              queue.splice(cursor + 1, 0, ...retry.parts);
              chunksTotal += retry.parts.length;
              logStep(`${chunk.hash}: ${retry.note}`);
            } else {
              failedChunks++;
              logFailure("矛盾検知", { チャンク: chunk.hash, 理由: retry.note });
            }
            continue;
          }
          if (raw === undefined) continue;

          collect(raw, chunk);

          // **あとで判明する事実とも突き合わせる**（設計書6.10.4）。
          // 「まだ知らない」ではなく「両立しない」を探す、逆向きの見方である
          const futureFacts = settings.futureFactsFor(chunk.text, chunk.chapterStart);
          if (futureFacts) {
            const futureCached = cache.get(chunk.hash, futureKeyBase);
            const futureRaw =
              futureCached ?? (await ask(chunk, "future", futureFacts));
            // **入らなかった向きは、ここでは分け直さない。** この段は
            // 「あとで判明する事実」との突き合わせで、本命（settled）が
            // 通ったチャンクの補足である。分け直すと同じ本文を二重に数える
            if (
              futureRaw !== undefined &&
              futureRaw !== RETRY_SMALLER &&
              !(futureRaw instanceof AIError)
            ) {
              collect(futureRaw, chunk);
            }
          }
          processedChunks++;
        }

        /** 応答を検証して、どのチャンクの指摘かを覚えておく */
        function collect(raw: unknown, chunk: Chunk): void {
          const validated = validateContradictions(raw, chunk);
          rejectedCount += validated.rejected.length;
          rejectedReasons.push(
            ...validated.rejected.map((entry) => entry.reason)
          );
          for (const issue of validated.accepted) {
            found.push({ issue, chunk });
          }
        }

        async function ask(
          chunk: Chunk,
          mode: "settled" | "future",
          futureFacts = ""
        ): Promise<unknown | undefined> {
          // **まとめたチャンクでは、いちばん前の話に合わせる。**
          // うしろに合わせると、前半の話にとって「まだ分かっていないこと」を
          // 材料に渡すことになる（設計書6.10.3）
          //
          // **引き継ぎは人物を索引で見つけるためだけ**（設計書6.10.6）。
          // 引き継いだ本文そのものはプロンプトへ入らない
          const relevant = settings.relevantFor(chunk.text, chunk.chapterStart, {
            carryOverText: carryOverFor(chunk).text,
          });
          // **照らし合わせる相手が無いチャンクは飛ばす。**
          // 材料なしで問うと、本文だけを見て矛盾を作り出す
          if (!relevant.hasAnything) return undefined;

          try {
            const bodyWithLines = withLineNumbers(chunk);
            const previousSynopses = settings.synopsesBefore(chunk.chapterStart);
            // **「あとで判明する事実」の向きには渡さない**（設計書6.74）。
            // あちらは本命（settled）が通ったチャンクの補足で、既に実データで
            // 測ってある。入力を増やすと、測った結果と別のものになる
            const pastScenes = mode === "future" ? "" : pastScenesFor(chunk);
            const userPrompt = buildContradictionCheckPrompt({
              // **まとめたチャンクは、話が1つとは限らない。**
              // 1つ目の話の名前だけを渡すと、2話目以降の本文を
              // 1話目だと言って読ませることになる
              chapterLabel: describeChunkScope(chunk, (filePath) =>
                chapterLabelByFile.get(filePath)
              ),
              chunkTextWithLineNumbers: bodyWithLines,
              characterDetails: relevant.characters,
              locationDetails: relevant.locations,
              worldviewSummary: relevant.worldview,
              previousSynopses,
              categories,
              futureFacts,
              pastScenes,
            });

            const response = await provider.generate({
              systemPrompt,
              userPrompt,
              model,
              // 事実の突き合わせなので揺らさない
              temperature: CONTRADICTION_CHECK_TEMPERATURE,
              maxOutputTokens: sendOutputTokens,
              plannedOutputTokens,
              jsonSchema: CONTRADICTION_CHECK_SCHEMA as unknown as object,
              disableThinking: true,
              signal: controller.signal,
              meta: {
                feature:
                  mode === "future" ? "contradiction_future" : "contradiction_check",
                workFolder: work.folderPath,
                parts: measureParts(userPrompt, {
                  本文: bodyWithLines.length,
                  人物: relevant.characters.length,
                  場所: relevant.locations.length,
                  // ここだけ上限が無かった（設計書6.27.6の穴2）。いまは
                  // `WORLDVIEW_MAX_CHARS` で頭を打つが、**実測はまだ無い**ので、
                  // 何字になるのかを測れるよう独立した項目として出し続ける
                  世界観: relevant.worldview.length,
                  あらすじ: previousSynopses.length,
                  未来の事実: futureFacts.length,
                  // **新しく増えた材料は、独立した項目で測る**（設計書6.74）。
                  // 上限（モデル比）が妥当かは実測を見てからでないと決められない
                  過去場面: pastScenes.length,
                }),
              },
            });

            if (response.truncated || !response.text.trim()) {
              // まとめたせいで入り切らなかったのなら、元の大きさなら通る見込みが
              // ある。**捨てるより試すほうがよい**（部分的なJSONは解析できない）
              logFailure("矛盾検知", {
                チャンク: chunk.hash,
                理由: "応答が上限で切り詰められました",
              });
              return RETRY_SMALLER;
            }

            const parsed = parseContradictionResult(response.text);
            if (!parsed) {
              failedChunks++;
              logFailure("矛盾検知", {
                チャンク: chunk.hash,
                理由: "応答を読み取れません",
                応答: responseExcerptForLog(response.text),
              });
              return undefined;
            }
            await cache.set(
              chunk.hash,
              mode === "future"
                ? futureKeyBase
                : keyWithPastScenes(cacheKeyBase, chunk),
              parsed
            );
            return parsed;
          } catch (error) {
            if (error instanceof AIError && error.kind === "aborted") return undefined;
            // **入らなかったときは、失敗として数える前に分け直しへ回す**
            // （設計書6.27.10）。そのまま数えると、そのチャンクは一度も
            // 見られないまま「失敗1件」で終わる
            if (isContextOverflow(error)) return error;
            // **同じ失敗を積まない。** 環境側の失敗はどのチャンクでも同じに
            // なるので、1回目で止めて理由を1つだけ残す（作者のログで9件並んだ）
            if (error instanceof AIError && isFatalProviderFailure(error.kind)) {
              fatalFailure = `${error.message} ${recoveryForAIError(error)}`.trim();
              logStep(`残りのチャンクは試しません: ${fatalFailure}`);
            }
            failedChunks++;
            logFailure("矛盾検知", {
              チャンク: chunk.hash,
              詳細:
                error instanceof AIError
                  ? `${error.message} ${recoveryForAIError(error)}`
                  : error instanceof Error
                    ? error.message
                    : String(error),
            });
            return undefined;
          }
        }
      });

      // ── 検証（設計書6.10.5）─────────────────────────
      //
      // **検出は本文を読みながら行う。** 1回で何十行も見て、設定も世界観も
      // 突き合わせるので、1件ずつを吟味する余裕が無い。ここでは**1件だけ**を
      // 見て、「これは本当に矛盾か」を問い直す。
      if (found.length > 0 && !cancelled) {
        await withCancellableProgress(
          "検出した矛盾を検証しています",
          async (progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => {
              cancelled = true;
              controller.abort();
            });

            let done = 0;
            for (const entry of found) {
              if (token.isCancellationRequested) break;
              progress.report({
                message: `${++done}/${found.length}`,
                increment: 100 / found.length,
              });
              // 提案パネルにも同じ進みを出す（本文を読む段とは別の札で）
              options.onVerifyProgress?.(done, found.length);

              const outcome = await verify(entry.issue, entry.chunk, controller);
              if (outcome.undecided) verifyUndecided++;
              if (!outcome.keep) {
                verifyRejected.push({ reason: outcome.reason });
                logStep(
                  `検証で取り下げ: ${entry.issue.excerpt.slice(0, 20)} ` +
                    `（${outcome.reason}／${outcome.explanation}）`
                );
                continue;
              }

              // **どのファイルの何行目かを、ここで確定させる。** まとめた
              // チャンクではAIが返す行番号がまとめた本文の通し番号になっており、
              // そのまま使うと別の話のファイルの、まったく違う行を指す
              const at = locateChunkLine(entry.chunk, entry.issue.line);
              if (!at) {
                // 戻せない行は捨てる。どこの話か決められない。
                // **どの行だったかを残す**（設計書6.8）。まとめ方を疑うときの
                // 唯一の手掛かりになる
                logStep(
                  `矛盾検知：行番号 ${entry.issue.line} を元のファイルへ戻せず除外`
                );
                rejectedCount++;
                continue;
              }
              issues.push({
                ...entry.issue,
                filePath: at.filePath,
                line: at.line,
                // 検証で分かったことは、作者の判断材料になる
                note: appendNote(entry.issue.note, outcome.explanation),
              });
            }
          }
        );
      }
    }
  );

  await cache.save();

  const verifyNote = describeVerifyResults(verifyRejected, verifyUndecided);
  if (verifyNote) logStep(`矛盾検知の検証: ${verifyNote}`);

  const accepted = sortContradictions(dedupe(issues));

  /*
    **開始したら、必ず終了の1行を残す**（実機確認 2026-09-05）。

    これまでは「矛盾検知を開始」のあと、検証の取り下げ行で途切れていた。
    操作ログだけを見ると、終わったのか途中で落ちたのかが分からない。
    誤字脱字側（`checkTypos.ts`）と同じ形にそろえる。

    中止・打ち切りでもここへ来る——`withAiTurn` は札を取れなければ本体を
    走らせずに戻り、ループの `break` も関数の外へは抜けないため、
    どの経路でも「そこまで何チャンク見たか」が残る。
    分母は分け直しで増えた後の数（`chunksTotal`）。
  */
  if (rejectedReasons.length > 0) {
    // 種別の名前をそのまま出す（`core/contradictionValidation.ts` の
    // `RejectedContradiction` に、それぞれの意味が書いてある）
    logStep(
      `矛盾検知：検証で除外 ${rejectedReasons.length}件` +
        `（${summarizeReasons(rejectedReasons)}）`
    );
  }
  logStep(
    `矛盾検知を終了: ${chunksDone}/${chunksTotal}` +
      `（失敗 ${failedChunks}件 / 指摘 ${accepted.length}件` +
      ` / 検証で取り下げ ${verifyRejected.length}件` +
      (skippedChunks > 0 ? ` / 処理済み ${skippedChunks}件はスキップ` : "") +
      (chunksTotal > pending.length
        ? ` / 入り切らず ${chunksTotal - pending.length}回に分けた`
        : "") +
      (cancelled ? " / 中止された" : "") +
      (fatalFailure ? " / 途中で打ち切った" : "") +
      "）"
  );

  return {
    issues: accepted,
    rejectedCount,
    failedChunks,
    unreadableEpisodes,
    cancelled,
    processedChunks,
    verifyNote,
    missedNote,
  };

  /**
   * そのチャンクへ渡す、過去の関連場面（設計書6.74）。無ければ空文字。
   *
   * **同じチャンクを2度引かない。** 鍵を決めるときと、実際に送るときの
   * 2回要る——揺れると鍵と中身が食い違う。`select` は決定的なので
   * 引き直しても同じ結果になるが、覚えておくほうが速い。
   */
  function pastScenesFor(chunk: Chunk): string {
    const remembered = pastSceneByChunk.get(chunk.hash);
    if (remembered !== undefined) return remembered;

    // **名前が1つも出ないチャンクでは引かない。** 検索語が無いまま引くと
    // 無関係な場面が並び、従来より悪くなる（＝そのときは従来と同じ入力）
    const selected = pastSceneIndex
      ? pastSceneIndex.select({
          chapter: chunk.chapterStart,
          terms: settings.namesIn(chunk.text),
          maxChars: pastSceneBudget,
        })
      : "";
    pastSceneByChunk.set(chunk.hash, selected);
    return selected;
  }

  /**
   * そのチャンクへ引き継ぐ前の話の本文（設計書6.10.6）。無ければ空。
   *
   * **同じチャンクを2度引かない**（`pastScenesFor` と同じ理由）。鍵を
   * 決めるときと、実際に材料を組むときの2回要る。
   */
  function carryOverFor(chunk: Chunk): CarryOverResult {
    const remembered = carryOverByChunk.get(chunk.hash);
    if (remembered !== undefined) return remembered;

    // **まとめたチャンクは、いちばん前の話に合わせる**（`relevantFor` へ渡す
    // 話数と同じ）。うしろに合わせると、前半の話にとって「まだ分かって
    // いないこと」を引き継ぐことになる
    const carried = carryOverBodyText({
      bodies: carryOverBodies,
      chapter: chunk.chapterStart,
      chapters: carryOverChapters,
    });
    carryOverByChunk.set(chunk.hash, carried);
    return carried;
  }

  /**
   * そのチャンクの**直前の1話**の本文（設計書6.10.6「落としたことを言う」）。
   *
   * **材料には入らないし、鍵にも混ぜない。** 見るのは「物語の流れでは
   * 居るはずなのに落ちた人物」を数えるためだけなので、プロンプトは
   * 1文字も変わらない——変えるとキャッシュが飛び、測り直しになる。
   *
   * **1話ぶんだけ**遡る。遡るほど「もう居ない人物」が並び、毎回騒がしくなる。
   */
  function previousBodyFor(chunk: Chunk): string {
    const remembered = previousBodyByChunk.get(chunk.hash);
    if (remembered !== undefined) return remembered;

    const previous = carryOverBodyText({
      bodies: carryOverBodies,
      // まとめたチャンクは、いちばん前の話に合わせる（`carryOverFor` と同じ）
      chapter: chunk.chapterStart,
      chapters: 1,
    }).text;
    previousBodyByChunk.set(chunk.hash, previous);
    return previous;
  }

  /**
   * 話ごとに、**直前の話には名前が出ているのに、この話の材料へ載らなかった
   * 人物**（設計書6.10.6）。落ちていない話は並べない。
   *
   * **材料に載らなかった人物を全部は挙げない。** 登場人物が40人いれば
   * 1話に出るのは数人なので、毎回37人が並んで騒がしくなる。
   *
   * **数えるのはチャンク単位、言うのは話単位なので、最後にまとめる**
   * （`mergeMissedCharactersByEpisode`。0.70.12）。1話が2つのチャンクへ
   * 割れて、人物が後半にだけ登場している場合、前半だけを見て
   * 「突き合わせていません」と言うと嘘になる。
   *
   * **落ちていないチャンクも渡す。** 積を取るのに要る（片方に載って
   * いれば、その話では突き合わせている）。
   */
  function missedCharactersByEpisode(): MissedCharacters[] {
    const perChunk: MissedCharactersInChunk[] = [];
    for (const chunk of chunks) {
      // **送るときと同じ材料で数える。** 引き継ぎ（`carryOver`）が効いて
      // いれば、その人物は載っているので落ちていない
      const names = settings.relevantFor(chunk.text, chunk.chapterStart, {
        carryOverText: carryOverFor(chunk).text,
        previousBodyText: previousBodyFor(chunk),
      }).missedCharacters;
      const label = describeChunkScope(chunk, (filePath) =>
        chapterLabelByFile.get(filePath)
      );
      perChunk.push({
        // 話数の読めない本文でも、どこの話かは言う（ログで辿れるように）
        label: label || `${chunk.index + 1}番目のまとまり`,
        names,
        chapter: chunk.chapterStart,
      });
    }
    return mergeMissedCharactersByEpisode(perChunk);
  }

  /**
   * 渡した抜粋と、引き継いだ本文の内容を鍵に混ぜる（設計書6.74・6.10.6）。
   *
   * **どちらも0件のときは混ぜない。** 混ぜると、何も足していないチャンクの
   * 鍵まで変わり、これまで処理済みだったぶんが無駄に飛ぶ。
   */
  function keyWithPastScenes(base: CacheKeyBase, chunk: Chunk): CacheKeyBase {
    const scenes = pastScenesFor(chunk);
    const carried = carryOverFor(chunk);
    if (!scenes && !carried.text) return base;
    return {
      ...base,
      promptVersion: promptVersionWithCarryOver(
        promptVersionWithPastScenes(base.promptVersion, scenes),
        carried.text
      ),
    };
  }

  /** 1件だけを見て、本当に矛盾かを問い直す */
  async function verify(
    issue: AcceptedContradiction,
    chunk: Chunk,
    controller: AbortController
  ): Promise<VerifyOutcome> {
    const key = hashText(
      `${chunk.hash}:${issue.line}:${issue.excerpt}:${issue.settingSays}`
    );
    const cached = cache.get(key, verifyKeyBase);
    if (cached !== undefined) {
      return parseVerifyOutcome(
        typeof cached === "string" ? cached : JSON.stringify(cached)
      );
    }

    try {
      const response = await provider.generate({
        systemPrompt: CONTRADICTION_VERIFY_SYSTEM_PROMPT,
        userPrompt: buildContradictionVerifyPrompt({
          chapterLabel: describeChunkScope(chunk, (filePath) =>
            chapterLabelByFile.get(filePath)
          ),
          contextWithLineNumbers: excerptAround(chunk, issue.line),
          excerpt: issue.excerpt,
          settingSays: issue.settingSays,
          textSays: issue.textSays,
          category: issue.category,
          // 指摘には「どの項目の話か」が付いてこないので、値だけで引く。
          // 以前は "role" 決め打ちで、外見や状態の指摘では当たらなかった
          settingKnownAt: settings.knownAtFor(issue.settingSays),
        }),
        model,
        temperature: CONTRADICTION_VERIFY_TEMPERATURE,
        maxOutputTokens: verifySendOutputTokens,
        plannedOutputTokens: verifyPlannedOutputTokens,
        jsonSchema: CONTRADICTION_VERIFY_SCHEMA as unknown as object,
        disableThinking: true,
        signal: controller.signal,
        // 指摘1件ごとに1回呼ぶ。**件数が多いと、本体より重くなりうる**ので
        // 別の機能名で数える
        meta: { feature: "contradiction_verify", workFolder: work.folderPath },
      });

      if (response.truncated || !response.text.trim()) {
        return undecidedOutcome("応答が切り詰められました");
      }
      await cache.set(key, verifyKeyBase, response.text);
      return parseVerifyOutcome(response.text);
    } catch (error) {
      if (error instanceof AIError && error.kind === "aborted") {
        return undecidedOutcome("取りやめました");
      }
      // **検証できなかったら通す。** 通信の失敗で本物の指摘を消さない
      logFailure("矛盾の検証", {
        引用: issue.excerpt.slice(0, 40),
        詳細: error instanceof Error ? error.message : String(error),
      });
      return undecidedOutcome("検証できませんでした");
    }
  }
}

/**
 * 該当行の前後を、行番号付きで切り出す。
 *
 * **切り出しそのものは `core/factContradiction.ts` に置いてある。**
 * 事実の照合（6.88の第4段）はチャンクではなくファイルから同じものを
 * 切り出すので、番号の振り方が2か所で食い違うと、片方だけ1行ずれる。
 */
function excerptAround(chunk: Chunk, line: number, around = 6): string {
  return linesAround(chunk.text, line, around, chunk.startLine + 1);
}

/** 検証で分かったことを、もとの補足へ足す */
function appendNote(note: string, explanation: string): string {
  const extra = explanation.trim();
  if (!extra) return note;
  return note.trim() ? `${note.trim()}（検証: ${extra}）` : `検証: ${extra}`;
}

/** 同じ箇所の同じ指摘が、重なったチャンクから二重に出ることがある */
function dedupe(items: AcceptedContradiction[]): AcceptedContradiction[] {
  const seen = new Set<string>();
  const out: AcceptedContradiction[] = [];
  for (const item of items) {
    const key = contradictionKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

interface SettingsMaterial {
  characterCount: number;
  locationCount: number;
  worldCount: number;
  /** 設定の中身のハッシュ。変われば検知をやり直す */
  fingerprint: string;
  /**
   * 参照資料に見込む字数（世界観）。チャンクの大きさを決めるのに使う。
   * 中身は `core/contradictionMaterial.ts`。
   */
  referenceBudgetChars: number;
  /**
   * @param chapter その本文が何話か。**その時点で分かっていることだけ**を返す
   * @param options 引き継ぐ本文（設計書6.10.6）。省略すると従来どおり
   */
  relevantFor(
    text: string,
    chapter: number | null,
    options?: RelevantOptions
  ): RelevantSettings;
  /** その本文に出てくる、索引にある語（設計書6.74） */
  namesIn(text: string): string[];
  /**
   * その本文より**あと**で判明する事実（設計書6.10.4）。
   * 無ければ空文字。
   */
  futureFactsFor(text: string, chapter: number | null): string;
  /** その設定が何話で分かるか。検証で使う（設計書6.10.5） */
  knownAtFor(value: string): string;
  synopsesBefore(chapter: number | null): string;
}

/**
 * 突き合わせる設定を集める。
 *
 * **本文に出てくるものだけを渡す。** 全部渡すと入力が膨らむうえ、
 * 出てこない人物の設定まで見て「登場していない」を矛盾にしてくる。
 */
async function collectSettings(
  work: WorkEntry,
  /** そのモデルで世界観に使ってよい字数（`worldviewMaxChars`） */
  worldviewMax: number,
  /** まとめ実行の印。前提が無いときの伝え方が変わる（設計書6.80） */
  suite: SuiteAwareOptions
): Promise<SettingsMaterial | undefined> {
  const [characters, locations, abilities, organizations, world] =
    await Promise.all([
      new CharacterStore(work).loadAll(),
      createLocationStore(work).loadAll(),
      createAbilityStore(work).loadAll(),
      createOrganizationStore(work).loadAll(),
      createWorldStore(work).loadAll(),
    ]);

  const people = characters.characters.filter((character) => !character.isMob);
  const places = locations.records;
  const worldItems = world.records;

  if (people.length === 0 && places.length === 0 && worldItems.length === 0) {
    // **まとめ実行では、ここで作者を止めない**（設計書6.80）。走らせられない
    // ことに変わりはないが、この前提は矛盾検知だけのものなので、残りの検知
    // （誤字脱字・伏線など）まで巻き添えで止まるのは筋が通らない。
    // 理由を持ち帰って、最後のまとめへ一言として並べる
    if (suite.suiteConfirmed) {
      // **「失敗」と言わせない**（作者の指摘、2026-09-06）。短い理由は
      // 内訳の括弧へ、次の一手はまとめの末尾へ、と行き先を分けて渡す
      suite.noteMissing?.(
        "矛盾は、先に「設定資料をまとめて抽出」を実行してください。",
        "設定資料がまだ無いため"
      );
      return undefined;
    }
    const answer = await vscode.window.showWarningMessage(
      "突き合わせる設定資料がまだありません。",
      {
        modal: true,
        detail:
          "矛盾検知は、作った設定資料と本文を照らし合わせる機能です。" +
          "設定が無いまま実行すると、AIは本文だけを見て" +
          "「矛盾していそうなこと」を作り出します。\n\n" +
          "先に「設定資料をまとめて抽出」を実行してください。",
      },
      "設定資料を抽出する"
    );
    if (answer === "設定資料を抽出する") {
      await vscode.commands.executeCommand("novelai.extractSettings", {
        type: "work",
        work,
      });
    }
    return undefined;
  }

  // 本文に出てくるものを探すための索引。用語ハイライトと同じ作り。
  // **組み方は core に置いてある**——ここと試す側で別々に組むと、別名の
  // 広げ方が食い違って「テストでは当たるのに実機では当たらない」が起きる
  const index = buildContradictionTermIndex({ people, places });

  // **材料の組み立ては core の純粋関数へ出した**（設計書6.10.3）。
  // features の中に閉じていた頃は、外から一度も測れなかった
  const material = createContradictionMaterial({
    people,
    places,
    worldItems,
    index,
    worldviewMax,
  });

  const characterById = new Map(people.map((item) => [item.id, item]));
  const abilitySystem = abilities.records;

  // 設定が変われば同じ本文でも答えが変わる。**更新時刻ではなく中身**で見る
  // （抽出は中身が同じでも updatedAt を書き換えるため。以前ここに
  // updatedAt が混ざっており、抽出のたびに全チャンクのキャッシュが飛んでいた）
  const fingerprint = settingsFingerprint({ people, places, worldItems });

  let synopses: Array<{ chapter: number | null; synopsis: string }> = [];
  try {
    synopses = (await new SynopsisStore(work).load()).episodes.map((item) => ({
      chapter: item.chapter,
      synopsis: item.synopsis,
    }));
  } catch {
    // あらすじが無くても矛盾検知はできる。時系列の確認が弱くなるだけ
  }

  // **どの値が何話で分かるか**の索引（設計書6.10.5）。検証で使う
  // 鍵の組み立ては buildKnownAtIndex に集めてある。書く側と読む側が
  // 別々に鍵を作っていた頃、区切りがずれて**読みが一度も当たらなかった**
  const knownAt = buildKnownAtIndex(people);

  return {
    characterCount: people.length,
    locationCount: places.length,
    worldCount: worldItems.length,
    fingerprint,
    referenceBudgetChars: material.referenceBudgetChars,
    relevantFor: (text, chapter, relevantOptions) =>
      material.relevantFor(text, chapter, relevantOptions),
    namesIn: (text) => material.namesIn(text),
    futureFactsFor(text, chapter) {
      if (chapter === null) return "";
      const lines: string[] = [];
      for (const match of index.find(text)) {
        if (match.entry.kind !== "character") continue;
        const character = characterById.get(match.entry.id);
        if (!character) continue;
        const facts = factsRevealedAfter(
          character,
          CHARACTER_AS_OF_FIELDS,
          chapter
        );
        for (const fact of facts) {
          const label = FIELD_LABELS[fact.field] ?? fact.field;
          const line = `${character.name}の${label}（第${fact.chapter}話で判明）: ${fact.value}`;
          if (!lines.includes(line)) lines.push(line);
        }
      }
      // **多すぎると、1件ずつの吟味が薄まる。** 近い先の話から順に絞る
      return lines.slice(0, 20).join("\n");
    },
    knownAtFor(value) {
      const chapters = lookupKnownAtValue(knownAt, value);
      if (chapters.length === 0) return "";
      return chapters.map((at) => `第${at}話`).join("、");
    },
    synopsesBefore(chapter) {
      if (chapter === null) return "";
      // **その話より前だけを渡す。** 後の話を渡すと、まだ書かれていない
      // 展開と食い違うことを「矛盾」と言い出す
      return synopses
        .filter((item) => item.chapter !== null && item.chapter < chapter)
        .slice(-12)
        .map((item) => `第${item.chapter}話: ${item.synopsis}`)
        .join("\n");
    },
  };
  // 能力・組織はまだ渡していない（引継ぎ書に残した）
  void abilitySystem;
  void organizations;
}

/**
 * 全話の本文を読む。**1回の検知で1回だけ**（設計書6.74・6.10.6）。
 *
 * 用途が2つある——過去の関連場面の索引（6.74）と、前の話の本文
 * （6.10.6の引き継ぎ・落としたことを言う）。**別々に読んでいたのを
 * ここへ寄せた**（0.70.10）。落としたことを言うのは既定でも要るので、
 * 分けたままだと**毎回、話数ぶんのファイルを二度読む**ことになる。
 *
 * **読めなくても検知は続ける。** どちらも補助の材料であり、無ければ
 * 従来どおりの入力に戻るだけである。ここで止めると、本文が1つ壊れて
 * いるだけで矛盾検知そのものが使えなくなる。
 *
 * 本文の読み方は既存の作法（`loadExcerptSources`）に合わせる——合本は
 * 中の話ごとに分かれ、シーンメモは抜かれる。**写しを作らない。**
 */
async function collectEpisodeSources(
  work: WorkEntry
): Promise<ExcerptSource[]> {
  try {
    return (await loadExcerptSources(work)).sources;
  } catch (error) {
    logFailure("矛盾検知：本文の読み込み（過去の場面・前の話）", {
      詳細: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** 読んだ本文を、話数つきの形へ移す（設計書6.10.6） */
function carryOverBodiesOf(
  sources: readonly ExcerptSource[]
): CarryOverBody[] {
  return sources.map((source) => ({
    chapter: source.chapter ?? null,
    text: source.text,
  }));
}

/**
 * 過去の場面の索引を作る（設計書6.74）。
 *
 * **1件も渡りようがない作品では、索引を組まない**（0.32.6のレビュー）。
 * 合本（1ファイルに全話）はチャンクの話数がファイル単位に決まるため、
 * どのチャンクにも「自分より前の話の場面」が存在しない。索引作り
 * （BM25）はそこそこ重く、確認ダイアログの一文も嘘になる。
 *
 * **索引を組むところまでを守りで囲う**（0.70.12で戻した）。本文の読み込みを
 * 1本化したときに、この3行が try/catch の外へ出ていた。過去の場面は補助の
 * 材料なので、**組めなくても検知は続ける**——ここで投げると、本文が1つ
 * 壊れているだけで矛盾検知そのものが使えなくなる。
 */
function collectPastScenes(
  sources: readonly ExcerptSource[],
  /** チャンクの話数。**渡りうるかの判断に要る**（`anyPastSceneReachable`） */
  chunkChapters: readonly (number | null)[]
): PastSceneIndex | undefined {
  try {
    const scenes = buildPastScenes(sources);
    if (scenes.length === 0) return undefined;
    if (!anyPastSceneReachable(scenes, chunkChapters)) return undefined;
    return new PastSceneIndex(scenes);
  } catch (error) {
    logFailure("矛盾検知：過去の場面の索引づくり", {
      詳細: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
