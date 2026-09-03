import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  AIError,
  isFatalProviderFailure,
  recoveryForAIError,
  type ModelInfo,
} from "../ai/types";
import { resolveOutputTokensForPlanning } from "../ai/outputLimit";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import {
  describeChunkScope,
  locateChunkLine,
  mergeAdjacentChunks,
  splitIntoChunks,
  splitMergedChunk,
  withLineNumbers,
  type Chunk,
} from "../core/chunker";
import { ChunkCache } from "../core/chunkCache";
import { measureParts } from "../core/usageLog";
import {
  capabilityCacheTag,
  capabilityProfile,
  describeCapability,
} from "../ai/capability";
import {
  describeChunkSettings,
  readChunkSettings,
  resolveModelInfoOrWarn,
  type ChunkFixedCost,
} from "./chunkSettings";
import { isContextOverflow, retryOnOverflow } from "./chunkRetry";
import {
  factsRevealedAfter,
  hasAppearedBy,
  isEmptyAfterRollback,
  recordAsOf,
} from "../core/settingsAsOf";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import { SynopsisStore } from "../core/synopsisStore";
import {
  TermIndex,
  expandNameVariants,
  type TermEntry,
} from "../core/termIndex";
import {
  describeCharacter,
  describeLocation,
  describeWorldItem,
  settingsFingerprint,
} from "../core/settingsSummary";
import { selectWorldview, worldviewMaxChars } from "../core/worldviewSelect";
import { formatChapterLabel } from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import {
  buildContradictionCheckPrompt,
  CONTRADICTION_CATEGORIES,
  CONTRADICTION_CHECK_SCHEMA,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  CONTRADICTION_CHECK_VERSION,
  LIGHT_CATEGORIES,
  type ContradictionCategory,
} from "../prompts/contradictionCheck";
import {
  buildContradictionVerifyPrompt,
  CONTRADICTION_VERIFY_SCHEMA,
  CONTRADICTION_VERIFY_SYSTEM_PROMPT,
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
import { withCancellableProgress, type CheckProgress } from "../views/progress";
import { confirmProviderReachable } from "./aiConnectivity";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { hashText } from "../core/textFile";

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

/**
 * 話数で巻き戻す項目（設計書6.10.3）。
 *
 * **名前と読みは巻き戻さない。** 作中で変わるものではないし、
 * 消すと誰の話か分からなくなる。
 */
const CHARACTER_AS_OF_FIELDS = [
  "summary",
  "role",
  "personality",
  "appearance",
  "gender",
  "affiliation",
];

const LOCATION_AS_OF_FIELDS = ["summary", "region", "description"];

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
}

export interface CheckContradictionsOptions {
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
  const capability = capabilityProfile({
    tier,
    providerId: resolved.provider.id,
  });
  // 地力の足りないモデルでは観点を絞る。1回の負荷を下げないと検出漏れが増える
  const categories: readonly ContradictionCategory[] =
    capability.narrowContradictionCategories
      ? LIGHT_CATEGORIES
      : CONTRADICTION_CATEGORIES;

  // **参照資料の上限は、モデルの上限に対する割合で決める**（設計書6.27.10）。
  // 固定30,000字のままだと、32kのモデルでは本文を1文字も足さないうちに溢れる
  const material = await collectSettings(
    work,
    worldviewMaxChars(info.contextWindow)
  );
  if (!material) return undefined;

  // **本文を空にしてプロンプトを組み、その字数を固定費とする。**
  // 見込みの定数を置くと、プロンプトの改訂に置いていかれて必ず追い越される。
  //
  // 人物・場所はチャンクに出てきた名前だけを載せるので、**切る前には
  // 測れない**。測れる分（指示＋世界観の見込み）をここで引き、測れない分は
  // 送る直前の関所（`ai/contextGuard.ts`）と、逃げ道（`chunkRetry.ts`）が受ける
  const overheadChars =
    CONTRADICTION_CHECK_SYSTEM_PROMPT.length +
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
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    outputTuning.providerId,
    outputTuning.model
  );
  const tasks = await collectChunks(
    work,
    info,
    options,
    {
      overheadChars,
      outputTokens: plannedOutputTokens,
    },
    outputTuning
  );
  if (!tasks) return undefined;
  const { chunks, chapterLabelByFile, chunkNote, unreadableEpisodes } = tasks;
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("検知できる本文がありませんでした。");
    return undefined;
  }

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
      `${capabilityCacheTag(capability)}${material.fingerprint}`,
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

  const pending = chunks.filter((chunk) => !cache.get(chunk.hash, cacheKeyBase));
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
    const confirm = await vscode.window.showInformationMessage(
      `${work.title} の矛盾を検知します。`,
      {
        modal: true,
        detail: [
          `${chunks.length}チャンク中 ${pending.length}件を処理します` +
            `（処理済み ${chunks.length - pending.length}件はスキップ）。`,
          `材料: 人物${material.characterCount}人 / 場所${material.locationCount}件 / ` +
            `世界観${material.worldCount}件`,
          "",
          "この機能は本文を書き換えません。 設定と食い違う箇所を並べるだけで、",
          "どちらを直すかは作者が決めます（設定側が古いこともあります）。",
          // **絞ったことを黙って行わない。** 指摘の件数が減るので、
          // 理由が画面に出ていないと作者には分からない（設計書6.28）
          capability.narrowContradictionCategories
            ? `\nこのモデルでは、見る観点を7つから3つ（人物・状態・時系列）へ絞ります。\n` +
              "一度にたくさん見せると、かえって見落としが増えるためです。"
            : "",
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
          .join("\n"),
      },
      "実行"
    );
    if (confirm !== "実行") return undefined;
  }

  logStep(
    `矛盾検知を開始: ${work.title} / ${resolved.provider.displayName} / ` +
      `${resolved.model}（${describeCapability({ tier, providerId: resolved.provider.id }, capability)}） / ` +
      `${chunks.length}チャンク / ${chunkNote} / ` +
      `v${CONTRADICTION_CHECK_VERSION}`
  );

  // 下の入れ子の関数では、上の `if (!resolved) return` による絞り込みが
  // 効かない（あとから書き換わりうるとみなされる）。ここで束ねておく
  const provider = resolved.provider;
  const model = resolved.model;
  const settings = material;

  /**
   * 検出した1件。**検証まで、どのチャンクの何行目かを持ち回る**
   * （設計書6.10.5）。前後の本文を渡すのに要る
   */
  const found: Array<{ issue: AcceptedContradiction; chunk: Chunk }> = [];
  let rejectedCount = 0;
  const verifyRejected: Array<{ reason?: VerifyRejectReason }> = [];
  let verifyUndecided = 0;
  let failedChunks = 0;
  let cancelled = false;
  // 待っても直らない失敗を掴んだら、残りのチャンクは試さない
  let fatalFailure = "";
  let processedChunks = 0;

  await withCancellableProgress("矛盾を検知しています", async (progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => {
      cancelled = true;
      controller.abort();
    });

    // **まとめたチャンクは、切り詰められたら分けて試し直す**（設計書6.23）。
    // 部分的なJSONは読めないので、まとめたせいで入り切らなかったのなら
    // 元の大きさで出し直すほうがよい。処理中に増えるので配列で持つ
    const queue = [...chunks];
    let total = queue.length;
    let done = 0;

    for (let cursor = 0; cursor < queue.length; cursor++) {
      if (token.isCancellationRequested) break;
      if (fatalFailure) break;
      const chunk = queue[cursor];

      const cached = cache.get(chunk.hash, cacheKeyBase);
      const raw = cached ?? (await ask(chunk, "settled"));
      done++;
      progress.report({
        message: `${done}/${total}`,
        increment: 100 / total,
      });
      // 提案パネルにも同じ進みを出す（作者は結果が出る場所で待っている）
      options.onProgress?.(done, total);

      if (raw === RETRY_SMALLER) {
        const parts = splitMergedChunk(chunk);
        if (parts.length > 1) {
          queue.splice(cursor + 1, 0, ...parts);
          total += parts.length;
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
          total += retry.parts.length;
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
      const relevant = settings.relevantFor(chunk.text, chunk.chapterStart);
      // **照らし合わせる相手が無いチャンクは飛ばす。**
      // 材料なしで問うと、本文だけを見て矛盾を作り出す
      if (!relevant.hasAnything) return undefined;

      try {
        const bodyWithLines = withLineNumbers(chunk);
        const previousSynopses = settings.synopsesBefore(chunk.chapterStart);
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
        });

        const response = await provider.generate({
          systemPrompt: CONTRADICTION_CHECK_SYSTEM_PROMPT,
          userPrompt,
          model,
          // 事実の突き合わせなので揺らさない
          temperature: 0.0,
          maxOutputTokens: plannedOutputTokens,
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
            応答: response.text.slice(0, 300),
          });
          return undefined;
        }
        await cache.set(
          chunk.hash,
          mode === "future" ? futureKeyBase : cacheKeyBase,
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
  const issues: AcceptedContradiction[] = [];
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
            // 戻せない行は捨てる。どこの話か決められない
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

  await cache.save();

  const verifyNote = describeVerifyResults(verifyRejected, verifyUndecided);
  if (verifyNote) logStep(`矛盾検知の検証: ${verifyNote}`);

  return {
    issues: sortContradictions(dedupe(issues)),
    rejectedCount,
    failedChunks,
    unreadableEpisodes,
    cancelled,
    processedChunks,
    verifyNote,
  };

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
        temperature: 0.0,
        maxOutputTokens: plannedOutputTokens,
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

/** 該当行の前後を、行番号付きで切り出す */
function excerptAround(chunk: Chunk, line: number, around = 6): string {
  const lines = chunk.text.split("\n");
  const target = line - chunk.startLine - 1;
  const from = Math.max(0, target - around);
  const to = Math.min(lines.length, target + around + 1);
  return lines
    .slice(from, to)
    .map((text, index) => `${chunk.startLine + from + index + 1}: ${text}`)
    .join("\n");
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
   *
   * **上限そのものではなく、上限と全文の小さいほう**を返す。世界観が
   * 3項目しかない作品で30,000字を確保すると、本文が要らないほど痩せる。
   */
  referenceBudgetChars: number;
  /**
   * @param chapter その本文が何話か。**その時点で分かっていることだけ**を返す
   */
  relevantFor(
    text: string,
    chapter: number | null
  ): {
    characters: string;
    locations: string;
    /** そのチャンクへ載せる世界観。上限内なら全項目（設計書6.27.6） */
    worldview: string;
    hasAnything: boolean;
  };
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
  worldviewMax: number
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

  // 本文に出てくるものを探すための索引。用語ハイライトと同じ作り
  const entries: TermEntry[] = [];
  for (const character of people) {
    for (const text of expandNameVariants([character.name, ...character.aliases])) {
      entries.push({
        text,
        kind: "character",
        id: character.id,
        canonicalName: character.name,
      });
    }
  }
  for (const place of places) {
    for (const text of [place.name, ...place.aliases]) {
      entries.push({
        text,
        kind: "location",
        id: place.id,
        canonicalName: place.name,
      });
    }
  }
  const index = new TermIndex(entries);

  const characterById = new Map(people.map((item) => [item.id, item]));
  const locationById = new Map(places.map((item) => [item.id, item]));
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

  // 世界観の全文（上限に掛ける前）の長さ。チャンクの大きさを決めるときに、
  // 「上限いっぱい確保する」のではなく実際に必要な分だけ引くために測る
  const worldviewWholeChars = worldItems
    .map((item) => describeWorldItem(item).length)
    .reduce((sum, length) => sum + length + 2, 0);

  return {
    characterCount: people.length,
    locationCount: places.length,
    worldCount: worldItems.length,
    fingerprint,
    referenceBudgetChars: Math.min(worldviewMax, worldviewWholeChars),
    relevantFor(text, chapter) {
      const seenCharacters = new Set<string>();
      const seenLocations = new Set<string>();
      for (const match of index.find(text)) {
        if (match.entry.kind === "character") seenCharacters.add(match.entry.id);
        if (match.entry.kind === "location") seenLocations.add(match.entry.id);
      }

      // **その話の時点で分かっていることだけを渡す**（設計書6.10.3）。
      // 資料は作品全体から作られているので、そのまま渡すと
      // **あとの話で明かされる事実**と食い違って見える
      const characterText = [...seenCharacters]
        .map((id) => characterById.get(id))
        .filter((item) => item !== undefined)
        .filter((item) => hasAppearedBy(item.appearedChapters, chapter))
        .map((item) => recordAsOf(item, CHARACTER_AS_OF_FIELDS, chapter))
        .filter((item) => !isEmptyAfterRollback(item, CHARACTER_AS_OF_FIELDS))
        .map((item) => describeCharacter(item, []))
        .join("\n\n");
      const locationText = [...seenLocations]
        .map((id) => locationById.get(id))
        .filter((item) => item !== undefined)
        .filter((item) => hasAppearedBy(item.appearedChapters, chapter))
        .map((item) => recordAsOf(item, LOCATION_AS_OF_FIELDS, chapter))
        .filter((item) => !isEmptyAfterRollback(item, LOCATION_AS_OF_FIELDS))
        .map((item) => describeLocation(item))
        .join("\n\n");

      return {
        characters: characterText,
        locations: locationText,
        // **世界観にも上限を置く**（設計書6.27.6の穴2）。上限内なら
        // 全項目が元の並び順で入るので、いまの作品では従来と同じ文字列になる
        worldview: selectWorldview({
          items: worldItems,
          chunkText: text,
          chapter,
          // **上限はモデルによって変わる**（設計書6.27.10）。固定30,000字だと
          // 小さいモデルでは資料だけで上限を使い切る
          maxChars: worldviewMax,
        }),
        // 世界観は誰が出ていても効くので、それだけでも材料になる。
        // 上限で絞っても1件は必ず残るので、項目があるかどうかで見てよい
        hasAnything: Boolean(
          characterText || locationText || worldItems.length > 0
        ),
      };
    },
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

/** 本文をチャンクに分ける。誤字脱字検知と同じ手順 */
async function collectChunks(
  work: WorkEntry,
  /** 呼び出し側が引いたモデル情報。**ここでは引き直さない**（下のコメント） */
  info: ModelInfo,
  options: CheckContradictionsOptions,
  fixedCost: ChunkFixedCost,
  /** 未チューニングの安全既定・書ける量の絞り込み用（設計書6.65.16） */
  outputTuning: { providerId: string; model: string }
): Promise<
  | {
      chunks: Chunk[];
      chapterLabelByFile: Map<string, string>;
      /** 何を根拠に大きさを決めたか。ログに残す（設計書6.23） */
      chunkNote: string;
      /**
       * 読めなかった話の数。
       *
       * **黙って落とさない。** その話だけ検知の対象から抜けるのに、
       * 作者には「その話には何も無い」と見える。
       */
      unreadableEpisodes: number;
    }
  | undefined
> {
  const scan = await scanWork(work);
  const format = await readWorkFormat(work);
  const targets = options.filePaths
    ? scan.episodes.filter((episode) =>
        options.filePaths!.some(
          (filePath) =>
            path.resolve(filePath).toLowerCase() ===
            path.resolve(episode.filePath).toLowerCase()
        )
      )
    : scan.episodes;

  // **固定費を差し引いてから本文の割当を決める**（設計書6.27.10）。
  // コンテキスト長が取れないときは、ここまで来ない
  // （`resolveModelInfoOrWarn` が理由を出して止めている）
  const chunkSettings = readChunkSettings(
    info.contextWindow,
    fixedCost,
    outputTuning
  );
  const maxChars = chunkSettings.chunk.chars;

  const chunks: Chunk[] = [];
  const chapterLabelByFile = new Map<string, string>();
  let unreadableEpisodes = 0;

  for (const episode of targets) {
    if (episode.hasConflictMarkers) continue;
    let text: string;
    try {
      text = (await readTextFile(episode.filePath)).text;
    } catch (error) {
      // **記録して数える。** 黙って落とすと、その話は検知の対象から
      // 抜けたのに、作者には「何も無かった」と見える
      unreadableEpisodes++;
      logFailure("矛盾検知：本文の読み込み", {
        ファイル: episode.filePath,
        詳細: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const label = formatChapterLabel(episode, format) || episode.fileName;
    for (const chunk of splitIntoChunks(
      episode.filePath,
      text,
      episode.chapterStart,
      episode.chapterEnd,
      { maxChars }
    )) {
      chunks.push(chunk);
    }
    chapterLabelByFile.set(episode.filePath, label);
  }

  // **1話ずつ送ると、指示のほうが本文より大きい**（設計書6.23）。
  // 矛盾検知は設定資料も一緒に送るので、1回あたりの指示はさらに重い。
  // 隣どうしをまとめて呼び出し回数を減らす。返ってきた行番号は
  // `locateChunkLine` で元のファイルへ戻す
  const merged =
    chunkSettings.mergeChars > 0
      ? mergeAdjacentChunks(chunks, { maxChars: chunkSettings.mergeChars })
      : chunks;

  return {
    chunks: merged,
    chapterLabelByFile,
    chunkNote: describeChunkSettings(chunkSettings),
    unreadableEpisodes,
  };
}
