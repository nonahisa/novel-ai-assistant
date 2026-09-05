import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { Foreshadow } from "../models/foreshadow";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  AIError,
  isFatalProviderFailure,
  recoveryForAIError,
} from "../ai/types";
import { resolveOutputTokensForPlanning } from "../ai/outputLimit";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import {
  describeChunkScope,
  mergeAdjacentChunks,
  splitIntoChunks,
  splitMergedChunk,
  type Chunk,
} from "../core/chunker";
import { ChunkCache } from "../core/chunkCache";
import { measureParts } from "../core/usageLog";
import {
  describeChunkSettings,
  readChunkSettings,
  resolveModelInfoOrWarn,
} from "./chunkSettings";
import { isContextOverflow, retryOnOverflow } from "./chunkRetry";
import { formatChapterLabel } from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import {
  addForeshadow,
  createForeshadowStore,
  saveOrUpdateForeshadow,
} from "../core/foreshadowStore";
import {
  buildForeshadowDetectPrompt,
  FORESHADOW_DETECT_SCHEMA,
  FORESHADOW_DETECT_SYSTEM_PROMPT,
  FORESHADOW_DETECT_VERSION,
} from "../prompts/foreshadowDetect";
import {
  buildForeshadowResolvePrompt,
  FORESHADOW_RESOLVE_SCHEMA,
  FORESHADOW_RESOLVE_SYSTEM_PROMPT,
  FORESHADOW_RESOLVE_VERSION,
  type OpenForeshadowBrief,
} from "../prompts/foreshadowResolve";
import {
  openForeshadowsFingerprint,
  parseForeshadowDetectResult,
  parseForeshadowResolveResult,
  validateForeshadowCandidates,
  describeRejectReasons,
  validateForeshadowResolutions,
  type AcceptedForeshadowCandidate,
  type AcceptedForeshadowResolution,
  type KnownForeshadow,
} from "../core/foreshadowValidation";
import { type CheckProgress } from "../views/progress";
import { withAiTurnProgress } from "./aiTurn";
import { confirmProviderReachable } from "./aiConnectivity";
import { logFailure, logStep, useLogFile } from "../core/logger";
import type { ProposalPanel, RecordUpdateViewItem } from "./proposalPanel";

/**
 * 伏線の配置・回収の自動検知（P-25 / P-26、設計書6.35.2・6.35.3）。
 *
 * **何も自動で保存しない。** 検知の結果は提案パネルへ並べ、作者が
 * 「登録」「回収済みにする」を押したものだけが台帳へ入る。矛盾からの
 * 転送（6.35.4）が直接保存してよいのは、あれが作者の操作そのものだからで、
 * ここは違う。
 *
 * 骨格は矛盾検知（`checkContradictions.ts`）・プロット逸脱検知に合わせる。
 * 検知の作りを1本ずつ変えると、キャッシュの鍵や中止の扱いが揃わなくなる。
 */

/** まとめたせいで入り切らなかった。分けて試し直す印（矛盾検知と同じ） */
const RETRY_SMALLER = Symbol("retry-smaller");

export interface ForeshadowDetectRunResult {
  candidates: AcceptedForeshadowCandidate[];
  /** 本文に無い引用など、弾いた件数 */
  rejectedCount: number;
  /** 既に台帳にあるので出さなかった件数 */
  duplicateCount: number;
  /** 応答が読めなかったチャンク数 */
  failedChunks: number;
  /** **本文そのものを読めなかった話の数**（AIへ渡せていない。ログに詳細） */
  unreadableEpisodes: number;
  cancelled: boolean;
}

/** 回収の候補1件。**どの伏線の話かを持ち回る**（画面に名前を出すため） */
export interface ForeshadowResolutionProposal {
  foreshadow: Foreshadow;
  resolution: AcceptedForeshadowResolution;
}

export interface ForeshadowResolveRunResult {
  proposals: ForeshadowResolutionProposal[];
  rejectedCount: number;
  failedChunks: number;
  /** **本文そのものを読めなかった話の数**（AIへ渡せていない。ログに詳細） */
  unreadableEpisodes: number;
  cancelled: boolean;
  /** 見に行った未回収の件数。0件のときは実行そのものを断る */
  openCount: number;
}

// ── 配置の検知（P-25）─────────────────────────────

export interface CheckForeshadowsOptions {
  /**
   * 進み具合の届け先（作者の報告、2026-08-29）。
   * 提案パネルへ出すために使う。渡されなければ何もしない
   */
  onProgress?: CheckProgress;
}

export async function checkForeshadows(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckForeshadowsOptions = {}
): Promise<ForeshadowDetectRunResult | undefined> {
  useLogFile(work.folderPath);

  const resolved = await ensureConfigured(registry, "foreshadow");
  if (!resolved) return undefined;

  const ledger = await loadLedger(work);
  if (!ledger) return undefined;

  // **取れなければ止める**（設計書6.27.10）。以前はここで `?? 8192` へ
  // 黙って落ちており、131,072のモデルでもチャンクが1,500字になって
  // キャッシュが全滅し、呼び出し回数が十数倍になっていた
  const info = await resolveModelInfoOrWarn({
    registry,
    feature: "foreshadow",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "伏線の検知",
  });
  if (!info) return undefined;

  // **本文を空にしてプロンプトを組み、その字数を固定費とする**（設計書6.27.10）。
  // 台帳が育つと「既に登録済みの見出し」が伸びる。伸びた分だけ本文を
  // 痩せさせないと、上限を超えて本文の後半が黙って捨てられる
  const detectOverheadChars =
    FORESHADOW_DETECT_SYSTEM_PROMPT.length +
    buildForeshadowDetectPrompt({
      chapterLabel: "",
      chunkText: "",
      knownLabels: ledger.records
        .map((record) => record.label.trim())
        .filter(Boolean)
        // 実際に送るときと同じ絞り方（`known.slice(-60)`）で測る
        .slice(-60),
    }).length;
  // **応答の見込みに実測を使う**（設計書6.65.16の2）
  const outputTuning = { providerId: resolved.provider.id, model: resolved.model };
  const chunkSettings = readChunkSettings(
    info.contextWindow,
    {
      overheadChars: detectOverheadChars,
      outputTokens: resolveOutputTokensForPlanning(
        outputTuning.providerId,
        outputTuning.model
      ),
    },
    outputTuning
  );
  const { chunks, chapterLabelByFile, unreadableEpisodes } = await collectChunks(
    work,
    chunkSettings
  );
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("検知できる本文がありませんでした。");
    return undefined;
  }

  const cache = new ChunkCache(work);
  await cache.load();
  // **台帳の指紋は混ぜない**（設計書6.35.2）。既に登録済みの名前は
  // プロンプトへ渡すが、それは「同じものを出させない」ための助けであって、
  // 重なりを落とすのはコード側（`validateForeshadowCandidates`）である。
  // 混ぜると、伏線を1件登録するたびに作品全体を送り直すことになる
  const cacheKeyBase = {
    feature: "foreshadow_detect",
    promptVersion: FORESHADOW_DETECT_VERSION,
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
        "伏線の検知",
        resolved.model
      ))
    ) {
      return undefined;
    }
    const confirm = await vscode.window.showInformationMessage(
      `${work.title} の伏線を検知します。`,
      {
        modal: true,
        detail: [
          `${chunks.length}チャンク中 ${pending.length}件を処理します` +
            `（処理済み ${chunks.length - pending.length}件はスキップ）。`,
          `既に登録されている伏線: ${ledger.records.length}件`,
          "",
          "台帳へは何も自動で入りません。 候補を「提案」パネルへ並べますので、",
          "登録するものを1件ずつ選んでください。",
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
    `伏線の検知を開始: ${work.title} / ${resolved.provider.displayName} / ` +
      `${resolved.model} / ${chunks.length}チャンク / ` +
      `${describeChunkSettings(chunkSettings)} / v${FORESHADOW_DETECT_VERSION}`
  );

  const provider = resolved.provider;
  const model = resolved.model;
  // num_ctx の確保にも同じ見込みを使う（設計書6.65.16の2）
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    outputTuning.providerId,
    outputTuning.model
  );
  // **既に台帳にあるものは出さない**（設計書6.35.2）。処理しながら
  // 増やしていくので、同じ候補が隣のチャンクから二度出ることもなくなる
  const known: KnownForeshadow[] = ledger.records.map((record) => ({
    label: record.label,
    plantedQuote: record.plantedQuote,
  }));

  const candidates: AcceptedForeshadowCandidate[] = [];
  let rejectedCount = 0;
  const rejectReasons: Array<{ reason: string }> = [];
  let duplicateCount = 0;
  let failedChunks = 0;
  let cancelled = false;
  // 待っても直らない失敗を掴んだら、残りのチャンクは試さない
  let fatalFailure = "";

  // **ほかの一括処理と重ならないよう、実行の札を取る**（設計書6.76）。
  // 関所（送信を1件ずつ）だけだと、機能どうしが交互に流れて
  // モデルの読み込み直しが往復する
  await withAiTurnProgress(
    "伏線になりそうな記述を探しています",
    { label: "伏線の検知", onCancelled: () => (cancelled = true) },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => {
        cancelled = true;
        controller.abort();
      });

      // まとめたチャンクが切り詰められたら、話ごとに分けて試し直す。
      // 処理中に増えるので `for...of` ではなく番号で回す（矛盾検知と同じ）
      const queue = [...chunks];
      let total = queue.length;
      let done = 0;

      for (let cursor = 0; cursor < queue.length; cursor++) {
        if (token.isCancellationRequested) break;
        if (fatalFailure) break;
        const chunk = queue[cursor];

        const cached = cache.get(chunk.hash, cacheKeyBase);
        const raw = cached ?? (await ask(chunk));
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
        // 上限に入らなかった。まとめたぶんを戻す→半分に割る→諦める
        if (raw instanceof AIError) {
          const retry = retryOnOverflow(chunk, raw);
          if (retry.kind === "split") {
            queue.splice(cursor + 1, 0, ...retry.parts);
            total += retry.parts.length;
            logStep(`${chunk.hash}: ${retry.note}`);
          } else {
            // **黙って飛ばさない。** 理由を残して次のチャンクへ進む
            failedChunks++;
            logFailure("伏線の検知", {
              チャンク: chunk.hash,
              理由: retry.note,
            });
          }
          continue;
        }
        if (raw === undefined) continue;

        const validated = validateForeshadowCandidates(raw, chunk, known);
        for (const entry of validated.rejected) {
          if (entry.reason === "duplicate") duplicateCount++;
          else rejectedCount++;
          // **理由を捨てない。** 数だけでは、次に直すのがプロンプトなのか
          // 照合なのか分からない（設計書6.35.7）
          rejectReasons.push({ reason: entry.reason });
        }
        for (const candidate of validated.accepted) {
          candidates.push(candidate);
          // 次のチャンクで同じものが出ないよう、その場で覚える
          known.push({
            label: candidate.label,
            plantedQuote: candidate.quote,
          });
        }
      }

      async function ask(chunk: Chunk): Promise<unknown | undefined> {
        try {
          // **`known` から毎回組み立てる。** 以前は開始時の写しを渡して
          // いたため、この実行中に受け入れた候補が反映されず、AIが同じ候補を
          // 何度も出し、そのたびに検証側が捨てていた（送る量も減らない）
          const knownLabels = known
            .map((entry) => entry.label.trim())
            .filter(Boolean);
          const userPrompt = buildForeshadowDetectPrompt({
            chapterLabel:
              describeChunkScope(chunk, (filePath) =>
                chapterLabelByFile.get(filePath)
              ) || "話数不明",
            chunkText: chunk.text,
            // **多すぎると本文が押し出される。** 直近に登録したものから渡す
            knownLabels: knownLabels.slice(-60),
          });

          const response = await provider.generate({
            systemPrompt: FORESHADOW_DETECT_SYSTEM_PROMPT,
            userPrompt,
            model,
            // 取り出すだけの仕事なので揺らさない
            temperature: 0.0,
            maxOutputTokens: plannedOutputTokens,
            jsonSchema: FORESHADOW_DETECT_SCHEMA as unknown as object,
            disableThinking: true,
            signal: controller.signal,
            meta: {
              feature: "foreshadow_detect",
              workFolder: work.folderPath,
              parts: measureParts(userPrompt, {
                本文: chunk.text.length,
                既存の伏線: knownLabels.join("").length,
              }),
            },
          });

          if (response.truncated || !response.text.trim()) {
            logFailure("伏線の検知", {
              チャンク: chunk.hash,
              理由: "応答が上限で切り詰められました",
            });
            return RETRY_SMALLER;
          }

          const parsed = parseForeshadowDetectResult(response.text);
          if (!parsed) {
            failedChunks++;
            logFailure("伏線の検知", {
              チャンク: chunk.hash,
              理由: "応答を読み取れません",
              応答: response.text.slice(0, 300),
            });
            return undefined;
          }
          await cache.set(chunk.hash, cacheKeyBase, parsed);
          return parsed;
        } catch (error) {
          if (error instanceof AIError && error.kind === "aborted") {
            return undefined;
          }
          // **入らなかったときは、失敗として数える前に分け直しへ回す**
          // （設計書6.27.10）
          if (isContextOverflow(error)) return error;
          // **同じ失敗を積まない。** 環境側の失敗はどのチャンクでも同じに
          // なるので、1回目で止めて理由を1つだけ残す（作者のログで9件並んだ）
          if (error instanceof AIError && isFatalProviderFailure(error.kind)) {
            fatalFailure = `${error.message} ${recoveryForAIError(error)}`.trim();
            logStep(`残りのチャンクは試しません: ${fatalFailure}`);
          }
          failedChunks++;
          logFailure("伏線の検知", {
            チャンク: chunk.hash,
            詳細: describeError(error),
          });
          return undefined;
        }
      }
    }
  );

  await saveCache(cache);

  logStep(
    `伏線の検知を終了: 候補 ${candidates.length}件 / 既存と重なり ${duplicateCount}件 / ` +
      `本文と合わない ${rejectedCount}件 / 読めなかった ${failedChunks}件 / ` +
      `本文を開けなかった話 ${unreadableEpisodes}件` +
      (cancelled ? " / 中止された" : "") +
      // **止めた理由を残す。** 「読めなかった1件」だけでは、残りを
      // 試していないことが読み取れない
      (fatalFailure
        ? ` / ${fatalFailure} のため残りは試していません`
        : "") +
      // 却下の内訳。**数だけでは次の一手が決まらない**（設計書6.35.7）
      (rejectReasons.length > 0 ? `
  却下の内訳: ${describeRejectReasons(rejectReasons)}` : "")
  );

  return {
    candidates,
    rejectedCount,
    duplicateCount,
    failedChunks,
    unreadableEpisodes,
    cancelled,
  };
}

/**
 * 配置の候補を提案パネルへ出す（設計書6.35.2）。
 *
 * **設定資料の更新と同じ形に載せる。** どちらも「1件ずつ承認して保存する」
 * 提案であり、描画も適用の道も既にある。新しい入れ物を作ると、作者の判断を
 * 保つ仕掛け（作品ごと・分類ごとの控え）をもう一度書くことになる。
 */
export function showForeshadowCandidates(
  panel: ProposalPanel,
  work: WorkEntry,
  candidates: readonly AcceptedForeshadowCandidate[]
): void {
  // **画面のidから元の候補へ戻れるようにする。** 並び順で引くと、
  // 画面側で並べ替えたときに別の候補を登録することになる
  const byId = new Map<string, AcceptedForeshadowCandidate>();
  const items: RecordUpdateViewItem[] = candidates.map((candidate, index) => {
    const id = `f:${candidate.chunkHash}:${index}`;
    byId.set(id, candidate);
    return {
      id,
      name: candidate.label,
      changes: [
        `${chapterText(candidate.chapter)}で張られています`,
        `引用：「${candidate.quote}」`,
        ...(candidate.note ? [`示唆：${candidate.note}`] : []),
      ],
      source: path.basename(candidate.filePath),
      status: "pending" as const,
      applyLabel: "登録",
    };
  });

  panel.showRecordUpdates(
    work,
    items,
    async (id) => {
      const candidate = byId.get(id);
      if (!candidate) return { ok: false, reason: "対象が見つかりません。" };
      try {
        // **保存は台帳の口を通す**（`addForeshadow`）。IDの採番と
        // ハッシュ照合がそこにあり、書き方を写すと必ずどれかを落とす
        await addForeshadow(work, {
          label: candidate.label,
          note: candidate.note,
          plantedChapter: candidate.chapter,
          plantedQuote: candidate.quote,
          source: "ai",
          // 元はAIの読みなので、作者が確定させた記述とは区別する
          autoGenerated: true,
        });
        return { ok: true };
      } catch (error) {
        const detail = describeError(error);
        logFailure("伏線の登録に失敗", {
          伏線: candidate.label,
          詳細: detail,
        });
        return { ok: false, reason: detail };
      }
    },
    // 見送りは何も書かない。**候補は台帳に無い**ので、片付ける先が無い
    async () => ({ ok: true }),
    "伏線の候補"
  );
}

// ── 回収の検知（P-26）─────────────────────────────

export async function checkForeshadowResolution(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckForeshadowsOptions = {}
): Promise<ForeshadowResolveRunResult | undefined> {
  useLogFile(work.folderPath);

  const ledger = await loadLedger(work);
  if (!ledger) return undefined;

  // **未回収が無ければAIを呼ばない**（設計書6.35.3）。
  // 「意図して開けたまま」は作者が回収しないと決めたものなので外す
  const open = ledger.records.filter((record) => record.status === "open");
  if (open.length === 0) {
    vscode.window.showInformationMessage(
      "未回収の伏線がありません。" +
        "「伏線を検知する」や「伏線を手で追加」で登録してから実行してください。"
    );
    return undefined;
  }

  const resolved = await ensureConfigured(registry, "foreshadow");
  if (!resolved) return undefined;

  // 検知と同じく、取れなければ止める（黙って 8,192 へ落ちない）
  const info = await resolveModelInfoOrWarn({
    registry,
    feature: "foreshadow",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "伏線の回収の確認",
  });
  if (!info) return undefined;

  // **本文を空にしてプロンプトを組み、その字数を固定費とする**（設計書6.27.10）。
  // 未回収の伏線は1件も減らないまま増えることがあり、ここがいちばん育つ。
  // 実際に渡すのは話数で絞った分だけなので、**全件で測るのは安全側**である
  const resolveOverheadChars =
    FORESHADOW_RESOLVE_SYSTEM_PROMPT.length +
    buildForeshadowResolvePrompt({
      chapterLabel: "",
      chunkText: "",
      foreshadows: open.map(toBrief),
    }).length;
  // **応答の見込みに実測を使う**（設計書6.65.16の2）
  const outputTuning = { providerId: resolved.provider.id, model: resolved.model };
  const chunkSettings = readChunkSettings(
    info.contextWindow,
    {
      overheadChars: resolveOverheadChars,
      outputTokens: resolveOutputTokensForPlanning(
        outputTuning.providerId,
        outputTuning.model
      ),
    },
    outputTuning
  );
  // **話をまたいでまとめない。** 「張った話より後か」を話数で決めるので、
  // 前後の話が1つの塊になっていると、その判断ができなくなる
  const { chunks, chapterLabelByFile, unreadableEpisodes } = await collectChunks(
    work,
    chunkSettings,
    { merge: false }
  );
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("確かめられる本文がありませんでした。");
    return undefined;
  }

  const cache = new ChunkCache(work);
  await cache.load();
  // **台帳が変われば、同じ本文でも判定が変わる**（設計書6.35.3）。
  // 未回収の集合を鍵に混ぜないと、伏線を足したのに前回の結果が返り続ける
  const cacheKeyBase = {
    feature: "foreshadow_resolve",
    promptVersion: `${FORESHADOW_RESOLVE_VERSION}:${openForeshadowsFingerprint(
      open
    )}`,
    providerId: resolved.provider.id,
    model: resolved.model,
  };

  // 見に行くのは、その本文より前に張られた伏線があるチャンクだけである
  const targeted = chunks
    .map((chunk) => ({ chunk, targets: targetsFor(open, chunk) }))
    .filter((entry) => entry.targets.length > 0);
  if (targeted.length === 0) {
    vscode.window.showInformationMessage(
      "未回収の伏線より後の本文がありません。" +
        "（伏線を張った話より後の話でしか、回収は確かめられません）"
    );
    return undefined;
  }

  const pending = targeted.filter(
    (entry) => !cache.get(entry.chunk.hash, cacheKeyBase)
  );
  if (pending.length > 0) {
    if (
      !(await confirmProviderReachable(
        resolved.provider,
        "伏線の回収の確認",
        resolved.model
      ))
    ) {
      return undefined;
    }
    const confirm = await vscode.window.showInformationMessage(
      `${work.title} の伏線の回収を確かめます。`,
      {
        modal: true,
        detail: [
          `未回収の伏線 ${open.length}件を、${targeted.length}か所の本文と` +
            `照らします（うち ${pending.length}件を処理。` +
            `処理済み ${targeted.length - pending.length}件はスキップ）。`,
          "",
          "台帳へは何も自動で入りません。 回収されたと読める箇所を「提案」パネルへ",
          "並べますので、回収済みにするものを1件ずつ選んでください。",
          resolved.provider.isPaid
            ? `\n${resolved.provider.displayName} は1か所ごとに課金されます。`
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
    `伏線の回収の確認を開始: ${work.title} / ${resolved.provider.displayName} / ` +
      `${resolved.model} / 未回収 ${open.length}件 / ${targeted.length}か所 / ` +
      `v${FORESHADOW_RESOLVE_VERSION}`
  );

  const provider = resolved.provider;
  const model = resolved.model;
  // num_ctx の確保にも同じ見込みを使う（設計書6.65.16の2）
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    outputTuning.providerId,
    outputTuning.model
  );
  const byId = new Map(open.map((record) => [record.id, record]));

  const proposals: ForeshadowResolutionProposal[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;
  const rejectReasons: Array<{ reason: string }> = [];
  let failedChunks = 0;
  let cancelled = false;
  // 待っても直らない失敗を掴んだら、残りのチャンクは試さない
  let fatalFailure = "";

  // **ほかの一括処理と重ならないよう、実行の札を取る**（設計書6.76）
  await withAiTurnProgress(
    "伏線が回収されたかを見ています",
    { label: "伏線の回収の確認", onCancelled: () => (cancelled = true) },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => {
        cancelled = true;
        controller.abort();
      });

      let done = 0;
      // **上限に入らなかったチャンクは、小さくして試し直す**（設計書6.27.10）。
      // 処理中に増えるので、`for...of` ではなく番号で回す
      const queue = [...targeted];
      let total = queue.length;
      for (let cursor = 0; cursor < queue.length; cursor++) {
        if (token.isCancellationRequested) break;
        if (fatalFailure) break;
        const entry = queue[cursor];

        const cached = cache.get(entry.chunk.hash, cacheKeyBase);
        const raw = cached ?? (await ask(entry.chunk, entry.targets));
        done++;
        progress.report({
          message: `${done}/${total}`,
          increment: 100 / total,
        });
        // 提案パネルにも同じ進みを出す（作者は結果が出る場所で待っている）
        options.onProgress?.(done, total);
        if (raw instanceof AIError) {
          const retry = retryOnOverflow(entry.chunk, raw);
          if (retry.kind === "split") {
            // **分けたら、その断片に掛かる伏線を選び直す。** 元の組を
            // そのまま持ち回すと、張った話より前の本文にまで掛けてしまう
            const parts = retry.parts
              .map((chunk) => ({ chunk, targets: targetsFor(open, chunk) }))
              .filter((part) => part.targets.length > 0);
            queue.splice(cursor + 1, 0, ...parts);
            total += parts.length;
            logStep(`${entry.chunk.hash}: ${retry.note}`);
          } else {
            // **黙って飛ばさない。** 理由を残して次のチャンクへ進む
            failedChunks++;
            logFailure("伏線の回収の確認", {
              チャンク: entry.chunk.hash,
              理由: retry.note,
            });
          }
          continue;
        }
        if (raw === undefined) continue;

        const validated = validateForeshadowResolutions(
          raw,
          entry.chunk,
          entry.targets
        );
        rejectedCount += validated.rejected.length;
        rejectReasons.push(...validated.rejected.map((entry) => ({ reason: entry.reason })));
        for (const resolution of validated.accepted) {
          // **1つの伏線に回収は1つでよい。** 話の早いほうから見ているので、
          // 先に見つかったものを採る（あとの話でも触れられることはある）
          if (seen.has(resolution.id)) continue;
          const foreshadow = byId.get(resolution.id);
          if (!foreshadow) continue;
          seen.add(resolution.id);
          proposals.push({ foreshadow, resolution });
        }
      }

      async function ask(
        chunk: Chunk,
        targets: readonly Foreshadow[]
      ): Promise<unknown | undefined> {
        try {
          const userPrompt = buildForeshadowResolvePrompt({
            chapterLabel:
              describeChunkScope(chunk, (filePath) =>
                chapterLabelByFile.get(filePath)
              ) || "話数不明",
            chunkText: chunk.text,
            foreshadows: targets.map(toBrief),
          });

          const response = await provider.generate({
            systemPrompt: FORESHADOW_RESOLVE_SYSTEM_PROMPT,
            userPrompt,
            model,
            temperature: 0.0,
            maxOutputTokens: plannedOutputTokens,
            jsonSchema: FORESHADOW_RESOLVE_SCHEMA as unknown as object,
            disableThinking: true,
            signal: controller.signal,
            meta: {
              feature: "foreshadow_resolve",
              workFolder: work.folderPath,
              parts: measureParts(userPrompt, {
                本文: chunk.text.length,
                未回収の伏線: targets
                  .map((target) => target.label + target.plantedQuote)
                  .join("").length,
              }),
            },
          });

          if (response.truncated || !response.text.trim()) {
            failedChunks++;
            logFailure("伏線の回収の確認", {
              チャンク: chunk.hash,
              理由: "応答が上限で切り詰められました",
            });
            return undefined;
          }

          const parsed = parseForeshadowResolveResult(response.text);
          if (!parsed) {
            failedChunks++;
            logFailure("伏線の回収の確認", {
              チャンク: chunk.hash,
              理由: "応答を読み取れません",
              応答: response.text.slice(0, 300),
            });
            return undefined;
          }
          await cache.set(chunk.hash, cacheKeyBase, parsed);
          return parsed;
        } catch (error) {
          if (error instanceof AIError && error.kind === "aborted") {
            return undefined;
          }
          // **入らなかったときは、失敗として数える前に分け直しへ回す**
          // （設計書6.27.10）
          if (isContextOverflow(error)) return error;
          // **同じ失敗を積まない。** 環境側の失敗はどのチャンクでも同じに
          // なるので、1回目で止めて理由を1つだけ残す（作者のログで9件並んだ）
          if (error instanceof AIError && isFatalProviderFailure(error.kind)) {
            fatalFailure = `${error.message} ${recoveryForAIError(error)}`.trim();
            logStep(`残りのチャンクは試しません: ${fatalFailure}`);
          }
          failedChunks++;
          logFailure("伏線の回収の確認", {
            チャンク: chunk.hash,
            詳細: describeError(error),
          });
          return undefined;
        }
      }
    }
  );

  await saveCache(cache);

  logStep(
    `伏線の回収の確認を終了: 候補 ${proposals.length}件 / ` +
      `本文と合わない ${rejectedCount}件 / 読めなかった ${failedChunks}件 / ` +
      `本文を開けなかった話 ${unreadableEpisodes}件` +
      (cancelled ? " / 中止された" : "") +
      // **止めた理由を残す。** 「読めなかった1件」だけでは、残りを
      // 試していないことが読み取れない
      (fatalFailure
        ? ` / ${fatalFailure} のため残りは試していません`
        : "") +
      // 却下の内訳。**数だけでは次の一手が決まらない**（設計書6.35.7）
      (rejectReasons.length > 0 ? `
  却下の内訳: ${describeRejectReasons(rejectReasons)}` : "")
  );

  return {
    proposals,
    rejectedCount,
    failedChunks,
    unreadableEpisodes,
    cancelled,
    openCount: open.length,
  };
}

/**
 * 回収の候補を提案パネルへ出す（設計書6.35.3）。
 *
 * **押して初めて `resolved` になる。** 誤って回収済みの印が付くと、
 * 作者は安心して回収を忘れる（設計書6.35.3）。
 */
export function showForeshadowResolutions(
  panel: ProposalPanel,
  work: WorkEntry,
  proposals: readonly ForeshadowResolutionProposal[]
): void {
  const byId = new Map<string, ForeshadowResolutionProposal>();
  const items: RecordUpdateViewItem[] = proposals.map((proposal, index) => {
    const id = `fr:${proposal.foreshadow.id}:${index}`;
    byId.set(id, proposal);
    return {
      id,
      name: proposal.foreshadow.label,
      changes: [
        `${chapterText(proposal.foreshadow.plantedChapter)}で張った` +
          (proposal.foreshadow.plantedQuote
            ? `：「${proposal.foreshadow.plantedQuote}」`
            : ""),
        `${chapterText(proposal.resolution.chapter)}で回収` +
          `：「${proposal.resolution.quote}」`,
        ...(proposal.resolution.note ? [proposal.resolution.note] : []),
      ],
      source: path.basename(proposal.resolution.filePath),
      status: "pending" as const,
      applyLabel: "回収済みにする",
    };
  });

  panel.showRecordUpdates(
    work,
    items,
    async (id) => {
      const proposal = byId.get(id);
      if (!proposal) return { ok: false, reason: "対象が見つかりません。" };
      try {
        // **更新も台帳の口を通す**（読んでから書く／退避してから作り直す）
        await saveOrUpdateForeshadow(work, proposal.foreshadow.id, {
          status: "resolved",
          resolvedChapter: proposal.resolution.chapter,
          resolvedQuote: proposal.resolution.quote,
        });
        return { ok: true };
      } catch (error) {
        const detail = describeError(error);
        logFailure("伏線の回収の記録に失敗", {
          伏線: proposal.foreshadow.label,
          詳細: detail,
        });
        return { ok: false, reason: detail };
      }
    },
    // 見送っても台帳は変わらない（未回収のまま残る）
    async () => ({ ok: true }),
    "伏線の回収"
  );
}

// ── 共通 ────────────────────────────────────

/** 台帳を読む。**読めないファイルがあることは黙らない** */
async function loadLedger(
  work: WorkEntry
): Promise<{ records: Foreshadow[] } | undefined> {
  try {
    const loaded = await createForeshadowStore(work).loadAll();
    if (loaded.errors.length > 0) {
      void vscode.window.showWarningMessage(
        `読み込めない伏線が ${loaded.errors.length} 件あります（${loaded.errors
          .map((error) => error.file)
          .join("、")}）。残りだけを見ます。`
      );
    }
    return { records: loaded.records };
  } catch (error) {
    void vscode.window.showErrorMessage(
      `伏線の台帳を読み込めませんでした：${describeError(error)}`
    );
    return undefined;
  }
}

/**
 * そのチャンクで回収を見る対象。
 *
 * **張った話以降の本文に掛ける。** 張る前に回収はできないので、
 * 前の話へ掛けても誤検知が増えるだけである。**同じ話は対象に含める**
 * （0.24.10）——短い話では同じ話の中で張って回収する型がよくあり、
 * 外すとその伏線は永遠に未回収のまま残る。張った箇所そのものを
 * 回収と言い張る誤検知は、検証側が弾く（`planted_echo`）。
 * **話数が分からないもの（どちらか一方でも null）は外さない**——
 * 前後を決められないのに落とすと、話数の読めないファイルで
 * 回収が一度も見つからなくなる。
 */
function targetsFor(
  open: readonly Foreshadow[],
  chunk: Chunk
): Foreshadow[] {
  return open.filter((record) => {
    if (record.plantedChapter === null) return true;
    if (chunk.chapterStart === null) return true;
    return chunk.chapterStart >= record.plantedChapter;
  });
}

function toBrief(record: Foreshadow): OpenForeshadowBrief {
  return {
    id: record.id,
    label: record.label,
    note: record.note,
    plantedQuote: record.plantedQuote,
    plantedChapter: record.plantedChapter,
  };
}

interface CollectedChunks {
  chunks: Chunk[];
  /** ファイルごとの見出し。**まとめたチャンクでも内訳ごとに引ける** */
  chapterLabelByFile: Map<string, string>;
  /**
   * 読めなかった話の数。
   *
   * **黙って落とさない。** 文字コードの壊れた話やロックされた話が1つあると、
   * その話だけ検知の対象から抜けるのに、作者には「その話には何も無い」と
   * 見える。誤字脱字検知の `failedChunks` と同じく、完了報告に添える。
   */
  unreadableEpisodes: number;
}

/**
 * 本文をチャンクに分ける（矛盾検知と同じ手順）。
 *
 * @param merge 隣どうしをまとめてよいか。回収の確認では**まとめない**
 */
async function collectChunks(
  work: WorkEntry,
  chunkSettings: ReturnType<typeof readChunkSettings>,
  options: { merge?: boolean } = {}
): Promise<CollectedChunks> {
  const scan = await scanWork(work);
  const format = await readWorkFormat(work);
  const chunks: Chunk[] = [];
  const chapterLabelByFile = new Map<string, string>();
  let unreadableEpisodes = 0;

  for (const episode of scan.episodes) {
    // 競合マーカーのあるファイルはAI処理をブロックする
    if (episode.hasConflictMarkers) continue;
    let text: string;
    try {
      text = (await readTextFile(episode.filePath)).text;
    } catch (error) {
      // **記録して数える。** 黙って落とすと、その話は検知の対象から
      // 抜けたのに、作者には「何も無かった」と見える
      unreadableEpisodes++;
      logFailure("伏線の検知：本文の読み込み", {
        ファイル: episode.filePath,
        詳細: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!text.trim()) continue;

    for (const chunk of splitIntoChunks(
      episode.filePath,
      text,
      episode.chapterStart,
      episode.chapterEnd,
      { maxChars: chunkSettings.chunk.chars }
    )) {
      chunks.push(chunk);
    }
    chapterLabelByFile.set(
      episode.filePath,
      formatChapterLabel(episode, format) || episode.fileName
    );
  }

  if (options.merge === false || chunkSettings.mergeChars <= 0) {
    return { chunks, chapterLabelByFile, unreadableEpisodes };
  }

  // **1話ずつ送ると、指示のほうが本文より大きい**（設計書6.23）。
  // まとめたチャンクでも、引用がどの話のものかは内訳から戻せる
  // （`locateQuoteInChunk`）
  return {
    chunks: mergeAdjacentChunks(chunks, { maxChars: chunkSettings.mergeChars }),
    chapterLabelByFile,
    unreadableEpisodes,
  };
}

function chapterText(chapter: number | null): string {
  // 話数を推測で埋めない。分からないことは分からないと書く
  return chapter === null ? "話数不明" : `第${chapter}話`;
}

function describeError(error: unknown): string {
  if (error instanceof AIError) {
    return `${error.message} ${recoveryForAIError(error)}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/** キャッシュは再生成できるので、書けなくても検知の結果はそのまま返す */
async function saveCache(cache: ChunkCache): Promise<void> {
  try {
    await cache.save();
  } catch {
    // 次回は処理済みのチャンクをもう一度送ることになるだけ
  }
}
