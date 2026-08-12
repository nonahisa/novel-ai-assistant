import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError, type ProviderId } from "../ai/types";
import { confirmProviderReachable } from "./aiConnectivity";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { parseCollectedFile } from "../core/collectedFile";
import {
  decideChunkSize,
  decideContextSize,
  splitIntoChunks,
  withLineNumbers,
  Chunk,
} from "../core/chunker";
import { ChunkCache } from "../core/chunkCache";
import {
  TYPO_CHECK_SCHEMA,
  TYPO_CHECK_SYSTEM_PROMPT,
  TYPO_CHECK_VERSION,
  buildTypoCheckPrompt,
  type TypoCheckResult,
} from "../prompts/typoCheck";
import {
  parseTypoCheckResult,
  validateTypoIssues,
  type AcceptedTypoIssue,
} from "../core/typoCheckValidation";
import {
  appliedFixKey,
  dismissKey,
  loadAppliedFixKeys,
  TypoDismissedHistory,
} from "../core/typoIssueHistory";
import { checkWritingStyle } from "../core/writingStyleCheck";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
} from "../core/abilityStore";
import { withCancellableProgress } from "../views/progress";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { resolveMaxOutputTokens } from "../ai/outputLimit";
import {
  rateLimitWaitMs,
  describeRateLimitGiveUp,
  type RateLimitWaitState,
} from "./extractCharacters";

/**
 * 誤字脱字検知（P-09）のオーケストレーション。
 *
 * `extractCharacters.ts` の骨格を踏襲するが、誤字脱字検知に要らない
 * 複雑さ（能力・場所・組織の同時抽出、チャンクのまとめ送信）は持ち込まない。
 * 素直に1話＝相応のチャンク数のまま処理する。
 */

export interface TypoCheckIssue extends AcceptedTypoIssue {
  filePath: string;
  chunkHash: string;
}

export interface TypoCheckRunResult {
  issues: TypoCheckIssue[];
  rejectedCount: number;
  failedChunks: number;
  dismissedCount: number;
  cancelled: boolean;
}

interface FileChunkTask {
  filePath: string;
  chunks: Chunk[];
}

export interface CheckTyposOptions {
  /**
   * 対象を絞り込むファイルパス。指定すると、そのファイルだけを検知する
   * （作品一覧で1話を右クリックしたときなど）。省略すると作品全体が対象。
   */
  filePaths?: string[];
}

export async function checkTypos(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckTyposOptions = {}
): Promise<TypoCheckRunResult | undefined> {
  const resolved = await ensureConfigured(registry);
  if (!resolved) return undefined;

  let modelInfo = await registry.resolveModelInfo();
  if (!modelInfo) {
    if (!(await confirmProviderReachable(resolved.provider, "誤字脱字の検知"))) {
      return undefined;
    }
    modelInfo = await registry.resolveModelInfo();
  }
  if (!modelInfo) {
    const action = await vscode.window.showWarningMessage(
      `モデル「${resolved.model}」の情報を取得できませんでした。` +
        "このまま実行すると本文の分割単位が変わり、" +
        "これまでの処理済みキャッシュが使えなくなります。" +
        "モデルを選び直してから、もう一度実行してください。",
      "AIの設定を開く",
      "中止"
    );
    if (action === "AIの設定を開く") {
      await vscode.commands.executeCommand("novelai.setupAI");
    }
    return undefined;
  }

  const contextWindow = modelInfo.contextWindow;
  const configuredChunkChars = vscode.workspace
    .getConfiguration("novelai")
    .get<number>("chunkChars", 0);
  const chunkChars =
    Number.isInteger(configuredChunkChars) && configuredChunkChars >= 1
      ? configuredChunkChars
      : decideChunkSize(contextWindow);

  const configuredNumCtx = vscode.workspace
    .getConfiguration("novelai")
    .get<number>("ollama.numCtx", 0);
  const numCtx =
    configuredNumCtx > 0
      ? configuredNumCtx
      : decideContextSize({
          chunkChars,
          outputTokens: resolveMaxOutputTokens(),
          contextWindow,
        });

  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return undefined;
  }

  const targetEpisodes = options.filePaths
    ? scan.episodes.filter((ep) => options.filePaths?.includes(ep.filePath))
    : scan.episodes;
  if (targetEpisodes.length === 0) {
    vscode.window.showWarningMessage("対象のファイルが見つかりません。");
    return undefined;
  }

  const conflicted: string[] = [];
  const tasks: FileChunkTask[] = [];

  for (const ep of targetEpisodes) {
    const file = await readTextFile(ep.filePath);
    if (file.hasConflictMarkers) {
      conflicted.push(ep.fileName);
      continue;
    }

    // 全話が1ファイルに入っている形（合本）は、話ごとに分けて送る。
    // まとめて1つの塊にすると、指摘の行番号がファイル全体の行番号と
    // ずれてしまう（後書き・リアクションが本文に混ざる問題も同じ理由）
    const collected = parseCollectedFile(file.text);
    if (collected) {
      let searchFrom = 0;
      for (const episode of collected) {
        if (!episode.body.trim()) continue;
        const located = locateBody(file.text, episode.body, searchFrom);
        searchFrom = located.nextSearchIndex;
        const chunks = splitIntoChunks(
          ep.filePath,
          episode.body,
          episode.chapter,
          episode.chapter,
          { maxChars: chunkChars }
        ).map((chunk) => ({
          ...chunk,
          startLine: chunk.startLine + located.line,
        }));
        tasks.push({ filePath: ep.filePath, chunks });
      }
      continue;
    }

    const meta = parseEpisodeMetadata(file.text);
    if (!meta.body.trim()) continue;
    const located = locateBody(file.text, meta.body, 0);
    const chunks = splitIntoChunks(
      ep.filePath,
      meta.body,
      ep.chapterStart,
      ep.chapterEnd,
      { maxChars: chunkChars }
    ).map((chunk) => ({
      ...chunk,
      startLine: chunk.startLine + located.line,
    }));
    tasks.push({ filePath: ep.filePath, chunks });
  }

  if (conflicted.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `未解決の競合が ${conflicted.length} 件あります（${conflicted
        .slice(0, 3)
        .join(", ")}${conflicted.length > 3 ? " ほか" : ""}）。` +
        "これらのファイルは処理対象から除外されます。",
      "除外して続行",
      "中止"
    );
    if (proceed !== "除外して続行") return undefined;
  }

  const chunks = tasks.flatMap((task) => task.chunks);
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("処理できる本文がありません。");
    return undefined;
  }

  // 固有名詞辞書。誤字ではなく作品の用語として保護する材料。
  // 実行中に増えることはない（誤字脱字検知は新しい人物・場所等を作らない）ため、
  // 抽出処理と違い、チャンクごとに組み立て直す必要はない
  const [characters, abilities, locations, organizations] = await Promise.all([
    new CharacterStore(work).loadAll(),
    createAbilityStore(work).loadAll(),
    createLocationStore(work).loadAll(),
    createOrganizationStore(work).loadAll(),
  ]);
  const protectedNames = [
    ...characters.characters.flatMap((c) => [c.name, ...c.aliases]),
    ...abilities.records.flatMap((a) => [a.name, ...a.aliases]),
    ...locations.records.flatMap((l) => [l.name, ...l.aliases]),
    ...organizations.records.flatMap((o) => [o.name, ...o.aliases]),
  ]
    .map((name) => name.trim())
    .filter(Boolean);

  const dismissedHistory = new TypoDismissedHistory(work);
  const dismissed = await dismissedHistory.load();
  const appliedFixKeys = await loadAppliedFixKeys(work);

  const filePathByChunk = new Map<string, string>();
  for (const task of tasks) {
    for (const chunk of task.chunks) filePathByChunk.set(chunk.hash, task.filePath);
  }

  const issues: TypoCheckIssue[] = [];

  // 文章作法（三点リーダー・ダッシュの偶数使用、鉤括弧内文末の句点、
  // 感嘆符・疑問符後の空白）はAIを使わずコードだけで判定できるため、
  // AIの実行有無・キャッシュに関係なく毎回すべてのチャンクに対して行う
  for (const chunk of chunks) {
    const filePath = filePathByChunk.get(chunk.hash) ?? chunk.filePath;
    for (const issue of checkWritingStyle(chunk)) {
      const key = dismissKey(chunk.hash, issue);
      if (dismissed.has(key)) continue;
      issues.push({ ...issue, filePath, chunkHash: chunk.hash });
    }
  }

  useLogFile(work.folderPath);
  logStep(
    `誤字脱字検知を開始: ${work.title} / ${resolved.provider.displayName} / ` +
      `${resolved.model} / ${chunks.length}チャンク / v${TYPO_CHECK_VERSION}`
  );

  const cache = new ChunkCache(work);
  await cache.load();
  const cacheKeyBase = {
    feature: "typo_check",
    promptVersion: TYPO_CHECK_VERSION,
    model: resolved.model,
  };

  const pending = chunks.filter((c) => !cache.get(c.hash, cacheKeyBase));

  if (pending.length > 0) {
    if (!(await confirmProviderReachable(resolved.provider, "誤字脱字の検知"))) {
      return undefined;
    }
    const estimateMinutes = Math.ceil((pending.length * 15) / 60);
    const costNotice = buildTypoCheckCostNotice(resolved.provider.id, pending);
    const confirm = await vscode.window.showInformationMessage(
      `${chunks.length} チャンク中 ${pending.length} 件を処理します` +
        `（処理済み ${chunks.length - pending.length} 件はスキップ）。\n` +
        `モデル: ${resolved.model} / 目安 ${estimateMinutes} 分程度\n` +
        costNotice,
      "実行",
      "中止"
    );
    if (confirm !== "実行") return undefined;
  } else if (chunks.length > 0) {
    vscode.window.showInformationMessage(
      "AIでの検知はすべてのチャンクが処理済みです。キャッシュから結果を再表示します。"
    );
  }

  let rejectedCount = 0;
  let failedChunks = 0;
  let cancelled = false;
  let connectivityLost = false;
  let consecutiveConnectivityFailures = 0;
  const rateLimit: RateLimitWaitState = { waits: 0, totalWaitedMs: 0 };
  let rateLimitGaveUp = false;

  await withCancellableProgress("誤字脱字を検知しています", async (progress, token) => {
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
      if (cached) {
        collectIssues(
          cached as TypoCheckResult,
          chunk,
          filePath,
          protectedNames,
          dismissed,
          appliedFixKeys,
          issues
        );
        done++;
        continue;
      }

      const label = describeChunkFile(filePath, chunk);
      progress.report({
        message: `${done + 1}/${pending.length}  ${label}`,
        increment: 100 / Math.max(pending.length, 1),
      });
      logStep(`AIへ送信: ${done + 1}/${pending.length} ${label}`);
      const startedAt = Date.now();

      const callAI = () =>
        resolved.provider.generate({
          systemPrompt: TYPO_CHECK_SYSTEM_PROMPT,
          userPrompt: buildTypoCheckPrompt({
            chunkTextWithLineNumbers: withLineNumbers(chunk),
            properNounDictionary: protectedNames.slice(0, 200),
          }),
          model: resolved.model,
          temperature: 0.0,
          numCtx,
          jsonSchema: TYPO_CHECK_SCHEMA as unknown as object,
          disableThinking: true,
          signal: controller.signal,
        });

      try {
        let res: Awaited<ReturnType<typeof callAI>> | undefined;
        for (;;) {
          try {
            res = await callAI();
            break;
          } catch (error) {
            const waitMs = rateLimitWaitMs(error, rateLimit);
            if (waitMs === undefined) {
              if (
                error instanceof AIError &&
                error.kind === "rate_limited" &&
                rateLimit.waits > 0
              ) {
                rateLimitGaveUp = true;
              }
              throw error;
            }
            rateLimit.waits++;
            rateLimit.totalWaitedMs += waitMs;
            progress.report({
              message:
                `${done + 1}/${pending.length}  ` +
                `レート上限のため ${Math.ceil(waitMs / 1000)} 秒待っています` +
                `（${rateLimit.waits}回目 / 合計 ${Math.round(
                  rateLimit.totalWaitedMs / 1000
                )} 秒）`,
            });
            if (!(await delay(waitMs, token))) {
              throw new AIError("処理が中止されました。", "aborted");
            }
          }
        }

        consecutiveConnectivityFailures = 0;
        logStep(
          `応答を受信: ${done + 1}/${pending.length} ${label} ` +
            `（${Math.round((Date.now() - startedAt) / 1000)}秒）`
        );

        if (res.truncated || !res.text.trim()) {
          failedChunks++;
          done++;
          continue;
        }

        const parsed = parseTypoCheckResult(res.text);
        if (!parsed) {
          failedChunks++;
        } else {
          collectIssues(
            parsed,
            chunk,
            filePath,
            protectedNames,
            dismissed,
            appliedFixKeys,
            issues,
            (count) => (rejectedCount += count)
          );
          await cache.set(chunk.hash, cacheKeyBase, parsed);
        }
      } catch (e) {
        if (
          e instanceof AIError &&
          e.kind === "aborted" &&
          (cancelled || token.isCancellationRequested)
        ) {
          break;
        }
        logTypoFailure(chunk, e, {
          provider: resolved.provider.displayName,
          model: resolved.model,
        });
        failedChunks++;
        if (e instanceof AIError && isFatalProviderFailure(e.kind)) {
          done++;
          break;
        }
        if (e instanceof AIError && isConnectivityFailure(e.kind)) {
          consecutiveConnectivityFailures++;
          if (consecutiveConnectivityFailures >= CONNECTIVITY_FAILURE_LIMIT) {
            connectivityLost = true;
            done++;
            break;
          }
        }
      }
      done++;
    }

    logStep(
      `誤字脱字検知を終了: ${done}/${chunks.length}（失敗 ${failedChunks}件${
        cancelled ? " / 中止された" : ""
      }）`
    );

    try {
      await cache.save();
    } catch {
      // キャッシュは再生成できるので、検知結果はそのまま返す
    }
  });

  if (cancelled) {
    vscode.window.showInformationMessage(
      "誤字脱字検知を中止しました。完了済みの処理は次回再利用されます。"
    );
    return { issues, rejectedCount, failedChunks, dismissedCount: 0, cancelled: true };
  }

  if (connectivityLost) {
    vscode.window.showWarningMessage(
      "AIへ接続できなくなったため、残りのチャンクを中断しました。" +
        "AIが起動しているか、ネットワーク接続を確認してください。" +
        "完了済みの処理は次回再利用されます。"
    );
  } else if (rateLimitGaveUp) {
    vscode.window.showWarningMessage(describeRateLimitGiveUp(rateLimit));
  }

  return {
    issues,
    rejectedCount,
    failedChunks,
    dismissedCount: 0,
    cancelled: false,
  };
}

/**
 * 検証を通った指摘のうち、無視済みでないもの・往復ループでないものだけを集める。
 *
 * `appliedFixKeys` は、直前に適用済みの「target→suggestion」の組。
 * 今回の指摘がその逆向き（suggestion→target）なら、AIが表記ゆれなどを
 * 誤字として往復で指摘し続けている可能性が高いため除外する。
 */
function collectIssues(
  result: TypoCheckResult,
  chunk: Chunk,
  filePath: string,
  protectedNames: string[],
  dismissed: Set<string>,
  appliedFixKeys: ReadonlySet<string>,
  out: TypoCheckIssue[],
  onRejected?: (count: number) => void
): void {
  const validated = validateTypoIssues(result, chunk, protectedNames);
  let rejectedCount = validated.rejected.length;
  const fileName = path.basename(filePath);

  for (const issue of validated.accepted) {
    const key = dismissKey(chunk.hash, issue);
    if (dismissed.has(key)) continue;

    if (appliedFixKeys.has(appliedFixKey(fileName, issue.suggestion, issue.target))) {
      rejectedCount++;
      continue;
    }

    out.push({ ...issue, filePath, chunkHash: chunk.hash });
  }

  onRejected?.(rejectedCount);
}

/**
 * ヘッダーを除いた本文が、元ファイルの何行目から始まるかを求める。
 *
 * `splitIntoChunks` が返す `startLine` は渡した本文の中での行番号であり、
 * メタデータヘッダーを剥がした分だけ実ファイルとずれる。
 * このずれを直さないと、AIが返す行番号が本文の実際の行と一致せず、
 * 「該当箇所へ移動」や「適用」が誤った行を指してしまう。
 */
export function locateBody(
  rawText: string,
  body: string,
  fromIndex: number
): { line: number; nextSearchIndex: number } {
  const normalized = rawText.replace(/\r\n?/g, "\n");
  const index = normalized.indexOf(body, fromIndex);
  if (index === -1) return { line: 0, nextSearchIndex: fromIndex };
  const line = normalized.slice(0, index).split("\n").length - 1;
  return { line, nextSearchIndex: index + body.length };
}

function describeChunkFile(filePath: string, chunk: Chunk): string {
  const name = path.basename(filePath);
  if (chunk.chapterStart === null) return name;
  const ch =
    chunk.chapterEnd !== null && chunk.chapterEnd !== chunk.chapterStart
      ? `第${chunk.chapterStart}〜${chunk.chapterEnd}話`
      : `第${chunk.chapterStart}話`;
  return chunk.index > 0 ? `${ch}(${chunk.index + 1})` : ch;
}

function logTypoFailure(
  chunk: Chunk,
  error: unknown,
  used: { provider: string; model: string }
): void {
  logFailure("誤字脱字検知の失敗", {
    ファイル: describeChunkFile(chunk.filePath, chunk),
    使用中のAI: `${used.provider} / ${used.model}`,
    種別: error instanceof AIError ? error.kind : "不明",
    詳細:
      error instanceof AIError
        ? error.detail
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
  });
}

function isConnectivityFailure(kind: AIError["kind"]): boolean {
  return kind === "not_running" || kind === "timeout";
}

function isFatalProviderFailure(kind: AIError["kind"]): boolean {
  return (
    kind === "authentication_failed" ||
    kind === "permission_denied" ||
    kind === "insufficient_credit" ||
    kind === "rate_limited"
  );
}

const CONNECTIVITY_FAILURE_LIMIT = 3;

function delay(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(true);
    }, ms);
    const subscription = token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

const CLOUD_SERVICE_NAMES: Partial<Record<ProviderId, string>> = {
  claude: "Claude API",
  openai: "OpenAI API",
  gemini: "Gemini API",
};

/** 実行前に、プロバイダごとの料金上の影響を明示する（簡易版） */
export function buildTypoCheckCostNotice(
  providerId: ProviderId,
  pendingChunks: Chunk[]
): string {
  if (providerId === "ollama") {
    return "料金: 無料・ローカル実行（API課金なし）";
  }

  const estimatedInputTokens = pendingChunks.reduce((total, chunk) => {
    const userPrompt = buildTypoCheckPrompt({
      chunkTextWithLineNumbers: withLineNumbers(chunk),
      properNounDictionary: [],
    });
    return (
      total +
      new TextEncoder().encode(TYPO_CHECK_SYSTEM_PROMPT).length +
      new TextEncoder().encode(userPrompt).length
    );
  }, 0);
  const perCall = resolveMaxOutputTokens();
  const totalOutputTokens = perCall * pendingChunks.length;
  const serviceName = CLOUD_SERVICE_NAMES[providerId] ?? "利用中のAIサービス";

  return [
    "【課金対象トークン量の目安（上限寄り）】",
    `入力: 約 ${estimatedInputTokens.toLocaleString("ja-JP")} トークン`,
    `出力: 最大 ${totalOutputTokens.toLocaleString("ja-JP")} トークン` +
      `（設定上限 ${perCall.toLocaleString("ja-JP")} × ${pendingChunks.length} 回）`,
    `${serviceName}は実行すると利用量が加算されます。実際の金額はモデル、実使用量、` +
      "各社の現行料金によって変わります。",
  ].join("\n");
}
