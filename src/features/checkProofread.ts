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
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import {
  splitIntoChunks,
  withLineNumbers,
  mergeAdjacentChunks,
  splitMergedChunk,
  locateChunkLine,
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
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { blankMemoLines } from "../core/sceneMemo";
import type { KeepWord } from "../models/keepWord";
import {
  buildProofreadPrompt,
  issueBudget,
  PROOFREAD_SCHEMA,
  PROOFREAD_SYSTEM_PROMPT,
  PROOFREAD_VERSION,
} from "../prompts/proofread";
import {
  parseProofreadResult,
  sortProofreadIssues,
  validateProofreadIssues,
  type AcceptedProofreadIssue,
} from "../core/proofreadValidation";
import { type CheckProgress } from "../views/progress";
import { withAiTurnProgress } from "./aiTurn";
import { confirmProviderReachable } from "./aiConnectivity";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { KeepWordStore } from "../core/keepWordStore";
import {
  buildStyleNote,
  collectWorkStyle,
  readNarrativePerson,
} from "../core/workStyle";

/**
 * 推敲支援（P-10、設計書6.9.1）。
 *
 * **「できるだけシンプル」が要求である。** 文体の大幅改変はしない。
 * 冗長・同語反復・係り受け・長すぎる文・漢字ひらき・語尾単調の6つだけを見る
 * （後ろの2つはプロンプト1.5で追加。**実モデルでの見逃し・誤検出は未計測**）。
 *
 * **いちばん危ないのは出しすぎること。** 誤字脱字には正解があるが
 * 推敲には無く、AIはどの文にも何かしら言える。1000字あたり3件で切る
 * （`core/proofreadValidation.ts`）。
 *
 * 指摘の形は誤字脱字と同じ（`original`/`target`/`suggestion`）なので、
 * **提案パネルの適用の仕組みをそのまま使う。**
 */

export interface ProofreadIssue extends AcceptedProofreadIssue {
  filePath: string;
  chunkHash: string;
}

export interface ProofreadRunResult {
  issues: ProofreadIssue[];
  /** 本文に無い原文・上限超過などで弾いた件数 */
  rejectedCount: number;
  /** 上限で切ったぶん（作者へ「絞りました」と伝えるため） */
  overBudgetCount: number;
  /**
   * 語尾単調で、数え直したら4連続に届かなかったぶん（作者の報告、2026-09-04）。
   *
   * **黙って捨てない。** AIが数え違えているという事実は、この機能の
   * 当たり具合を測るときの手掛かりになる
   */
  monotonyDroppedCount: number;
  failedChunks: number;
  cancelled: boolean;
}

export interface CheckProofreadOptions {
  /** 話を絞る。指定しなければ作品全体 */
  filePaths?: string[];
  /**
   * 進み具合の届け先（作者の報告、2026-08-29）。
   * 提案パネルへ出すために使う。渡されなければ何もしない
   */
  onProgress?: CheckProgress;
}

export async function checkProofread(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckProofreadOptions = {}
): Promise<ProofreadRunResult | undefined> {
  useLogFile(work.folderPath);

  const resolved = await ensureConfigured(registry, "proofread");
  if (!resolved) return undefined;

  // **モデル情報はここで1回だけ引く**（設計書6.27.10）。以前はチャンクを
  // 作る側が引き、取れないときは黙って `?? 8192` へ落ちていた——131,072の
  // モデルでもチャンクが1,500字になり、キャッシュが全滅して呼び出し回数が
  // 十数倍になる。作者には「急に遅くなった」としか見えない
  const info = await resolveModelInfoOrWarn({
    registry,
    feature: "proofread",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "推敲",
  });
  if (!info) return undefined;

  // **応答の見込みに実測を使う**（設計書6.65.16の2）
  const outputTuning = { providerId: resolved.provider.id, model: resolved.model };
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    outputTuning.providerId,
    outputTuning.model
  );
  // **場所の確保（上）と、実際に送る上限（下）は別物である**（設計書6.77の
  // 第2段）。上を上限として送ると、測っていないモデルでは上限が設定値の
  // 半分になり、長い応答が途中で切れる
  const sendOutputTokens = resolveOutputTokensForSend(
    outputTuning.providerId,
    outputTuning.model
  );

  const prepared = await collectChunks(work, info, options, outputTuning);
  if (!prepared) return undefined;
  const { chunks, narrativeStyle, keepWords, styleNote } = prepared;
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("推敲できる本文がありませんでした。");
    return undefined;
  }

  const cache = new ChunkCache(work);
  await cache.load();
  const cacheKeyBase = {
    feature: "proofread",
    promptVersion: PROOFREAD_VERSION,
    providerId: resolved.provider.id,
    model: resolved.model,
  };

  const pending = chunks.filter((chunk) => !cache.get(chunk.hash, cacheKeyBase));
  if (pending.length > 0) {
    // **モデル名を渡す。** LM Studioをこの場から起こしたとき、
    // 起こした直後に読み込ませるために要る（`aiConnectivity.ts`）
    if (
      !(await confirmProviderReachable(resolved.provider, "推敲", resolved.model))
    ) {
      return undefined;
    }
    const maxIssues = chunks.reduce(
      (sum, chunk) => sum + issueBudget(chunk.text.length),
      0
    );
    const confirm = await vscode.window.showInformationMessage(
      `${work.title} の推敲を行います。`,
      {
        modal: true,
        detail: [
          `${chunks.length}チャンク中 ${pending.length}件を処理します` +
            `（処理済み ${chunks.length - pending.length}件はスキップ）。`,
          // **まとめ方を変えると、キャッシュが総入れ替えになる。** 何も
          // 変えていないのに全件が対象になると、作者は不具合だと思う
          pending.length === chunks.length && chunks.length > 1
            ? "（前回から本文の分け方が変わっているため、今回はすべて送り直します）"
            : "",
          "",
          "見るのは6つだけです（冗長・同語反復・係り受け・長すぎる文・" +
            "読みに詰まる漢字・語尾の単調さ）。",
          "語彙や文体、描写の増減には触れません。",
          `指摘は多くても ${maxIssues}件までに絞ります（1000字あたり3件）。`,
          "",
          "本文は書き換えません。 指摘を1件ずつ確認して適用します。",
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
    `推敲を開始: ${work.title} / ${resolved.provider.displayName} / ` +
      `${resolved.model} / ${chunks.length}チャンク / v${PROOFREAD_VERSION}`
  );

  const provider = resolved.provider;
  const model = resolved.model;

  const issues: ProofreadIssue[] = [];
  let rejectedCount = 0;
  let overBudgetCount = 0;
  let monotonyDroppedCount = 0;
  let failedChunks = 0;
  let cancelled = false;
  // 待っても直らない失敗を掴んだら、残りのチャンクは試さない
  let fatalFailure = "";

  // **ほかの一括処理と重ならないよう、実行の札を取る**（設計書6.76）。
  // 関所（送信を1件ずつ）だけだと、機能どうしが交互に流れて
  // モデルの読み込み直しが往復する
  await withAiTurnProgress(
    "推敲しています",
    { label: "推敲", onCancelled: () => (cancelled = true) },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => {
        cancelled = true;
        controller.abort();
      });

      let done = 0;
      // **切り詰められたら、まとめたぶんを話ごとに戻して試し直す。**
      // まとめると出力も増えるので、上限に当たる見込みが上がる。
      // 処理中に足すので、`for...of` ではなく番号で回す
      const queue = [...chunks];
      let total = chunks.length;
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const chunk = queue[cursor];
        if (token.isCancellationRequested) break;
        if (fatalFailure) break;

        const cached = cache.get(chunk.hash, cacheKeyBase);
        let raw: unknown | undefined;
        if (cached !== undefined) {
          raw = cached;
        } else {
          const asked = await ask(chunk);
          if (asked.ok) {
            raw = asked.value;
          } else if (asked.overflow) {
            // 上限に入らなかった。まとめたぶんを戻す→半分に割る→諦める
            const retry = retryOnOverflow(chunk, asked.overflow);
            if (retry.kind === "split") {
              queue.splice(cursor + 1, 0, ...retry.parts);
              total += retry.parts.length;
              logStep(`${chunk.hash}: ${retry.note}`);
            } else {
              // **黙って飛ばさない。** 理由を残して次のチャンクへ進む
              failedChunks++;
              logFailure("推敲", { チャンク: chunk.hash, 理由: retry.note });
            }
          } else if (asked.truncated) {
            const parts = splitMergedChunk(chunk);
            if (parts.length > 1) {
              queue.splice(cursor + 1, 0, ...parts);
              total += parts.length;
            }
          }
        }
        done++;
        progress.report({
          message: `${done}/${total}`,
          increment: 100 / total,
        });
        // 提案パネルにも同じ進みを出す（作者は結果が出る場所で待っている）
        options.onProgress?.(done, total);
        if (raw === undefined) continue;

        const validated = validateProofreadIssues(raw, chunk, keepWords);
        rejectedCount += validated.rejected.length;
        overBudgetCount += validated.rejected.filter(
          (entry) => entry.reason === "over_budget"
        ).length;
        monotonyDroppedCount += validated.rejected.filter(
          (entry) => entry.reason === "not_monotonous"
        ).length;
        for (const issue of validated.accepted) {
          // **どのファイルの何行目かを、ここで確定させる。** まとめたチャンクでは
          // AIが返す行番号がまとめた本文の通し番号になっており、そのまま使うと
          // 別の話のファイルの、まったく違う行を書き換える
          const at = locateChunkLine(chunk, issue.line);
          if (!at) {
            rejectedCount++;
            continue;
          }
          issues.push({
            ...issue,
            line: at.line,
            filePath: at.filePath,
            chunkHash: chunk.hash,
          });
        }
      }

      /**
       * 応答。切り詰められたとき、または**上限に入らなかったとき**だけ、
       * 小さくして試し直す（設計書6.27.10）
       */
      type AskResult =
        | { ok: true; value: unknown }
        | { ok: false; truncated: boolean; overflow?: AIError };

      async function ask(chunk: Chunk): Promise<AskResult> {
        try {
          const bodyWithLines = withLineNumbers(chunk);
          const userPrompt = buildProofreadPrompt({
            chunkTextWithLineNumbers: bodyWithLines,
            narrativeStyle,
            styleNote,
            maxIssues: issueBudget(chunk.text.length),
          });

          const response = await provider.generate({
            systemPrompt: PROOFREAD_SYSTEM_PROMPT,
            userPrompt,
            model,
            // 言い回しの提案なので、事実の突き合わせより少しだけ揺らす
            temperature: 0.2,
            maxOutputTokens: sendOutputTokens,
            plannedOutputTokens,
            jsonSchema: PROOFREAD_SCHEMA as unknown as object,
            disableThinking: true,
            signal: controller.signal,
            meta: {
              feature: "proofread",
              workFolder: work.folderPath,
              parts: measureParts(userPrompt, {
                本文: bodyWithLines.length,
                作法: styleNote.length,
              }),
            },
          });

          const parsed = parseProofreadResult(response.text);
          if (!parsed) {
            // **切り詰められたのなら、まとめたせいかもしれない。**
            // 話ごとに戻せば通る見込みがある（捨てるより試すほうがよい）
            if (!response.truncated) failedChunks++;
            logFailure("推敲", {
              チャンク: chunk.hash,
              理由: response.truncated
                ? "応答が上限で切り詰められました"
                : "応答を読み取れません",
              応答: response.text.slice(0, 300),
            });
            return { ok: false, truncated: response.truncated === true };
          }
          await cache.set(chunk.hash, cacheKeyBase, parsed);
          return { ok: true, value: parsed };
        } catch (error) {
          if (error instanceof AIError && error.kind === "aborted") {
            return { ok: false, truncated: false };
          }
          // **入らなかったときは、失敗として数える前に分け直しへ回す**。
          // そのまま数えると、そのチャンクは一度も推敲されないまま終わる
          if (isContextOverflow(error)) {
            return { ok: false, truncated: false, overflow: error };
          }
          // **同じ失敗を積まない。** 環境側の失敗はどのチャンクでも同じに
          // なるので、1回目で止めて理由を1つだけ残す（作者のログで9件並んだ）
          if (error instanceof AIError && isFatalProviderFailure(error.kind)) {
            fatalFailure = `${error.message} ${recoveryForAIError(error)}`.trim();
            logStep(`残りのチャンクは試しません: ${fatalFailure}`);
          }
          failedChunks++;
          logFailure("推敲", {
            チャンク: chunk.hash,
            詳細:
              error instanceof AIError
                ? `${error.message} ${recoveryForAIError(error)}`
                : error instanceof Error
                  ? error.message
                  : String(error),
          });
          return { ok: false, truncated: false };
        }
      }
    }
  );

  await cache.save();

  if (monotonyDroppedCount > 0) {
    // **どれだけ数え違えていたかを残す。** この観点は実モデルでの当たり具合を
    // まだ測れていないので、記録が測る手掛かりになる
    logStep(
      `語尾単調：数え直して4連続未満だったため${monotonyDroppedCount}件除外`
    );
  }

  return {
    issues: sortProofreadIssues(issues) as ProofreadIssue[],
    rejectedCount,
    overBudgetCount,
    monotonyDroppedCount,
    failedChunks,
    cancelled,
  };
}

/**
 * 本文を読み、固定費を測り、その残りでチャンクへ切る。
 *
 * **読むのと切るのを分けてある**（設計書6.27.10）。切る大きさは、指示と
 * 作法が何字あるかを測ってからでないと決められないが、その作法（styleNote）を
 * 決めるには本文が要る。読む → 測る → 切る、の順にすれば一度で済む。
 *
 * 作法（人称・文語かどうか）は呼び出し側でも使うので、一緒に返す。
 */
async function collectChunks(
  work: WorkEntry,
  /** 呼び出し側が引いたモデル情報。**ここでは引き直さない**（1回だけ引く） */
  info: ModelInfo,
  options: CheckProofreadOptions,
  /** 未チューニングの安全既定・書ける量の絞り込み用（設計書6.65.16） */
  outputTuning: { providerId: string; model: string }
): Promise<
  | {
      chunks: Chunk[];
      /** 作品の人称・文体（プロットから読む）。無くても推敲はできる */
      narrativeStyle: string;
      /** 作者が「直さない」と決めた語 */
      keepWords: KeepWord[];
      /** AIへ渡す作法の説明 */
      styleNote: string;
    }
  | undefined
> {
  const scan = await scanWork(work);
  const targets = options.filePaths
    ? scan.episodes.filter((episode) =>
        options.filePaths!.some(
          (filePath) =>
            path.resolve(filePath).toLowerCase() ===
            path.resolve(episode.filePath).toLowerCase()
        )
      )
    : scan.episodes;

  // **切る前の本文をいったん溜める**（設計書6.27.10）
  const sources: Array<{
    filePath: string;
    text: string;
    chapterStart: number | null;
    chapterEnd: number | null;
  }> = [];

  for (const episode of targets) {
    // 競合マーカーのあるファイルはAI処理をブロックする
    if (episode.hasConflictMarkers) continue;
    let text: string;
    try {
      text = (await readTextFile(episode.filePath)).text;
    } catch {
      continue;
    }
    sources.push({
      filePath: episode.filePath,
      text,
      chapterStart: episode.chapterStart,
      chapterEnd: episode.chapterEnd,
    });
  }

  const narrativeStyle = await readNarrativePerson(work);
  // 作者が「直さない」と決めた語。推敲は原文まるごとを置き換えるので、
  // 含まれていたら指摘ごと出さない
  const keepWords = await new KeepWordStore(work).loadWords();

  // **誤字脱字と同じ作法を渡す**（設計書6.8.14）。片方だけに渡すと、
  // 同じ本文について機能ごとに違う前提で判断することになる
  const styleNote = buildStyleNote(
    collectWorkStyle({
      // 全話を繋いで見る。1話だけでは一人称も文語かも決められない。
      // **シーンメモは落とす**（`splitIntoChunks` が本文から消すのと同じ）
      bodyText: sources.map((source) => blankMemoLines(source.text)).join("\n"),
      narrativePerson: narrativeStyle,
      keepWords: keepWords.map((entry) => entry.word),
    })
  );

  // **本文を空にしてプロンプトを組み、その字数を固定費とする**（設計書6.27.10）。
  // `maxIssues` は本文の長さで変わるが、桁は変わらない（数字1つ）ので0で測る
  const overheadChars =
    PROOFREAD_SYSTEM_PROMPT.length +
    buildProofreadPrompt({
      chunkTextWithLineNumbers: "",
      narrativeStyle,
      styleNote,
      maxIssues: 0,
    }).length;

  // **設定を見るようにした**（設計書6.23）。以前はここだけ設定を無視して
  // いつも自動で決めており、作者が字数を指定しても効かなかった
  const chunkSettings = readChunkSettings(
    info.contextWindow,
    {
      overheadChars,
      outputTokens: resolveOutputTokensForPlanning(
        outputTuning.providerId,
        outputTuning.model
      ),
    },
    outputTuning
  );
  const maxChars = chunkSettings.chunk.chars;

  const chunks: Chunk[] = [];
  for (const source of sources) {
    for (const chunk of splitIntoChunks(
      source.filePath,
      source.text,
      source.chapterStart,
      source.chapterEnd,
      { maxChars }
    )) {
      chunks.push(chunk);
    }
  }

  logStep(`推敲のチャンク: ${describeChunkSettings(chunkSettings)}`);

  // **1話ずつ送ると、指示のほうが本文より大きい。** 誤字脱字と同じ理由で
  // 隣どうしをまとめる（設計書6.8.10）。返ってきた行番号は
  // `locateChunkLine` で元のファイルへ戻す
  const mergeChars = chunkSettings.mergeChars;
  return {
    chunks:
      mergeChars > 0
        ? mergeAdjacentChunks(chunks, { maxChars: mergeChars })
        : chunks,
    narrativeStyle,
    keepWords,
    styleNote,
  };
}
