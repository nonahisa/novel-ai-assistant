import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
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
import { readChunkSettings } from "./chunkSettings";
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
import { withCancellableProgress } from "../views/progress";
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
 * 冗長・同語反復・係り受け・長すぎる文の4つだけを見る。
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
  failedChunks: number;
  cancelled: boolean;
}

export interface CheckProofreadOptions {
  /** 話を絞る。指定しなければ作品全体 */
  filePaths?: string[];
}

export async function checkProofread(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckProofreadOptions = {}
): Promise<ProofreadRunResult | undefined> {
  useLogFile(work.folderPath);

  const resolved = await ensureConfigured(registry);
  if (!resolved) return undefined;

  const chunks = await collectChunks(work, registry, options);
  if (!chunks) return undefined;
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("推敲できる本文がありませんでした。");
    return undefined;
  }

  const narrativeStyle = await readNarrativePerson(work);
  // 作者が「直さない」と決めた語。推敲は原文まるごとを置き換えるので、
  // 含まれていたら指摘ごと出さない
  const keepWords = await new KeepWordStore(work).loadWords();

  // **誤字脱字と同じ作法を渡す**（設計書6.8.14）。片方だけに渡すと、
  // 同じ本文について機能ごとに違う前提で判断することになる
  const styleNote = buildStyleNote(
    collectWorkStyle({
      // 全チャンクを繋いで見る。1話だけでは一人称も文語かも決められない
      bodyText: chunks.map((chunk) => chunk.text).join("\n"),
      narrativePerson: narrativeStyle,
      keepWords: keepWords.map((entry) => entry.word),
    })
  );

  const cache = new ChunkCache(work);
  await cache.load();
  const cacheKeyBase = {
    feature: "proofread",
    promptVersion: PROOFREAD_VERSION,
    model: resolved.model,
  };

  const pending = chunks.filter((chunk) => !cache.get(chunk.hash, cacheKeyBase));
  if (pending.length > 0) {
    if (!(await confirmProviderReachable(resolved.provider, "推敲"))) {
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
          "見るのは4つだけです（冗長・同語反復・係り受け・長すぎる文）。",
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
  let failedChunks = 0;
  let cancelled = false;

  await withCancellableProgress("推敲しています", async (progress, token) => {
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

      const cached = cache.get(chunk.hash, cacheKeyBase);
      let raw: unknown | undefined;
      if (cached !== undefined) {
        raw = cached;
      } else {
        const asked = await ask(chunk);
        if (asked.ok) {
          raw = asked.value;
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
      if (raw === undefined) continue;

      const validated = validateProofreadIssues(raw, chunk, keepWords);
      rejectedCount += validated.rejected.length;
      overBudgetCount += validated.rejected.filter(
        (entry) => entry.reason === "over_budget"
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

    /** 応答。切り詰められたときだけ、話ごとに戻して試し直す */
    type AskResult =
      | { ok: true; value: unknown }
      | { ok: false; truncated: boolean };

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
  });

  await cache.save();

  return {
    issues: sortProofreadIssues(issues) as ProofreadIssue[],
    rejectedCount,
    overBudgetCount,
    failedChunks,
    cancelled,
  };
}

/**
 * 作品の人称・文体をプロットから読む。
 *
 * **無くても推敲はできる。** 渡すのは「三人称なのに一人称の癖を直せと
 * 言わない」ための手がかりで、必須ではない。
 */
async function collectChunks(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckProofreadOptions
): Promise<Chunk[] | undefined> {
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

  const info = await registry.resolveModelInfo();
  // **設定を見るようにした**（設計書6.23）。以前はここだけ設定を無視して
  // いつも自動で決めており、作者が字数を指定しても効かなかった
  const chunkSettings = readChunkSettings(info?.contextWindow ?? 8192);
  const maxChars = chunkSettings.chunk.chars;

  const chunks: Chunk[] = [];

  for (const episode of targets) {
    // 競合マーカーのあるファイルはAI処理をブロックする
    if (episode.hasConflictMarkers) continue;
    let text: string;
    try {
      text = (await readTextFile(episode.filePath)).text;
    } catch {
      continue;
    }
    for (const chunk of splitIntoChunks(
      episode.filePath,
      text,
      episode.chapterStart,
      episode.chapterEnd,
      { maxChars }
    )) {
      chunks.push(chunk);
    }
  }

  // **1話ずつ送ると、指示のほうが本文より大きい。** 誤字脱字と同じ理由で
  // 隣どうしをまとめる（設計書6.8.10）。返ってきた行番号は
  // `locateChunkLine` で元のファイルへ戻す
  const mergeChars = chunkSettings.mergeChars;
  return mergeChars > 0
    ? mergeAdjacentChunks(chunks, { maxChars: mergeChars })
    : chunks;
}
