import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import {
  decideChunkSize,
  splitIntoChunks,
  withLineNumbers,
  type Chunk,
} from "../core/chunker";
import { ChunkCache } from "../core/chunkCache";
import { parsePlotMarkdown } from "../core/plotDoc";
import { readPlotText } from "../core/plotFile";
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
 * **AI指摘パネルの適用の仕組みをそのまま使う。**
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

  const collected = await collectChunks(work, registry, options);
  if (!collected) return undefined;
  const { chunks, filePathByChunk } = collected;
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("推敲できる本文がありませんでした。");
    return undefined;
  }

  const narrativeStyle = await readNarrativeStyle(work);
  // 作者が「直さない」と決めた語。推敲は原文まるごとを置き換えるので、
  // 含まれていたら指摘ごと出さない
  const keepWords = await new KeepWordStore(work).loadWords();

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
          "",
          "**見るのは4つだけです**（冗長・同語反復・係り受け・長すぎる文）。",
          "語彙や文体、描写の増減には触れません。",
          `指摘は多くても ${maxIssues}件までに絞ります（1000字あたり3件）。`,
          "",
          "**本文は書き換えません。** 指摘を1件ずつ確認して適用します。",
          resolved.provider.isPaid
            ? `\n**${resolved.provider.displayName} はチャンクごとに課金されます。**`
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
    for (const chunk of chunks) {
      if (token.isCancellationRequested) break;

      const filePath = filePathByChunk.get(chunk.hash) ?? chunk.filePath;
      const cached = cache.get(chunk.hash, cacheKeyBase);
      const raw = cached ?? (await ask(chunk));
      done++;
      progress.report({
        message: `${done}/${chunks.length}`,
        increment: 100 / chunks.length,
      });
      if (raw === undefined) continue;

      const validated = validateProofreadIssues(raw, chunk, keepWords);
      rejectedCount += validated.rejected.length;
      overBudgetCount += validated.rejected.filter(
        (entry) => entry.reason === "over_budget"
      ).length;
      for (const issue of validated.accepted) {
        issues.push({ ...issue, filePath, chunkHash: chunk.hash });
      }
    }

    async function ask(chunk: Chunk): Promise<unknown | undefined> {
      try {
        const response = await provider.generate({
          systemPrompt: PROOFREAD_SYSTEM_PROMPT,
          userPrompt: buildProofreadPrompt({
            chunkTextWithLineNumbers: withLineNumbers(chunk),
            narrativeStyle,
            maxIssues: issueBudget(chunk.text.length),
          }),
          model,
          // 言い回しの提案なので、事実の突き合わせより少しだけ揺らす
          temperature: 0.2,
          jsonSchema: PROOFREAD_SCHEMA as unknown as object,
          disableThinking: true,
          signal: controller.signal,
        });

        const parsed = parseProofreadResult(response.text);
        if (!parsed) {
          failedChunks++;
          logFailure("推敲", {
            チャンク: chunk.hash,
            理由: "応答を読み取れません",
            応答: response.text.slice(0, 300),
          });
          return undefined;
        }
        await cache.set(chunk.hash, cacheKeyBase, parsed);
        return parsed;
      } catch (error) {
        if (error instanceof AIError && error.kind === "aborted") return undefined;
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
        return undefined;
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
async function readNarrativeStyle(work: WorkEntry): Promise<string> {
  try {
    const sections = parsePlotMarkdown(await readPlotText(work)).sections;
    return sections.narrativePerson.trim();
  } catch {
    return "";
  }
}

async function collectChunks(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckProofreadOptions
): Promise<
  { chunks: Chunk[]; filePathByChunk: Map<string, string> } | undefined
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

  const info = await registry.resolveModelInfo();
  const maxChars = decideChunkSize(info?.contextWindow ?? 8192);

  const chunks: Chunk[] = [];
  const filePathByChunk = new Map<string, string>();

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
      filePathByChunk.set(chunk.hash, episode.filePath);
    }
  }

  return { chunks, filePathByChunk };
}
