import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { Character } from "../models/character";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  AIError,
  recoveryForAIError,
  type ProviderId,
} from "../ai/types";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { decideChunkSize, splitIntoChunks, Chunk } from "../core/chunker";
import {
  CharacterStore,
  CharacterStoreError,
} from "../core/characterStore";
import { mergeExtractedCharacters } from "../core/characterMerge";
import {
  parseResult,
  validateCharacterExtractResult,
  type CharacterRejectionReason,
  type RejectedCharacterCandidate,
} from "../core/characterExtractionValidation";
import {
  BASE_SYSTEM_PROMPT,
  CHARACTER_EXTRACT_SCHEMA,
  CHARACTER_EXTRACT_VERSION,
  CharacterExtractResult,
  ExtractedCharacter,
  buildCharacterExtractPrompt,
} from "../prompts/characterExtract";
import { ChunkCache } from "../core/chunkCache";

interface ExtractionFailure {
  chunk: Chunk;
  message: string;
  kind?: AIError["kind"];
}

interface ExtractionSummaryCounts {
  added: number;
  updated: number;
  rejected: RejectedCharacterCandidate[];
  conflicts: number;
  failedChunks: number;
  saved: number;
  ambiguous: number;
  unsavedConflicts: number;
  cacheWarnings: number;
}

/** 作品内の未保存文書を保存し、成功を再検査できた場合だけ実行を許可する。 */
export async function saveDirtyDocumentsBeforeExtraction(
  work: WorkEntry
): Promise<boolean> {
  const dirtyDocuments = dirtyDocumentsInside(work.folderPath);
  if (dirtyDocuments.length === 0) return true;

  const answer = await vscode.window.showWarningMessage(
    `未保存の変更が ${dirtyDocuments.length} 件あります。保存してから実行しますか？`,
    "保存して実行",
    "中止"
  );
  if (answer !== "保存して実行") return false;

  for (const document of dirtyDocuments) {
    if (!document.save || !(await document.save())) {
      await vscode.window.showWarningMessage(
        "保存できない文書があるため、人物抽出を中止しました。"
      );
      return false;
    }
  }

  if (dirtyDocumentsInside(work.folderPath).length > 0) {
    await vscode.window.showWarningMessage(
      "保存後も未保存の文書が残っているため、人物抽出を中止しました。"
    );
    return false;
  }
  return true;
}

export async function extractCharacters(
  work: WorkEntry,
  registry: AIRegistry
): Promise<void> {
  const resolved = await ensureConfigured(registry);
  if (!resolved) return;

  const modelInfo = await registry.resolveModelInfo();
  const contextWindow = modelInfo?.contextWindow ?? 8192;
  const configuredChunkChars = vscode.workspace
    .getConfiguration("novelai")
    .get<number>("chunkChars", 0);
  const chunkChars =
    Number.isInteger(configuredChunkChars) && configuredChunkChars >= 1
      ? configuredChunkChars
      : decideChunkSize(contextWindow);

  // 実際に使うコンテキスト長。モデルの上限をそのまま使うと
  // メモリを大量に消費するため、必要分だけ確保する
  const configuredNumCtx = vscode.workspace
    .getConfiguration("novelai")
    .get<number>("ollama.numCtx", 0);
  const numCtx =
    configuredNumCtx > 0
      ? configuredNumCtx
      : Math.min(contextWindow, 16384);

  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    vscode.window.showWarningMessage("本文ファイルが見つかりません。");
    return;
  }

  // 競合マーカーを含むファイルはAI処理をブロックする
  const conflicted: string[] = [];
  const chunks: Chunk[] = [];

  for (const ep of scan.episodes) {
    const file = await readTextFile(ep.filePath);
    if (file.hasConflictMarkers) {
      conflicted.push(ep.fileName);
      continue;
    }
    const meta = parseEpisodeMetadata(file.text);
    const body = meta.body;
    if (!body.trim()) continue;

    chunks.push(
      ...splitIntoChunks(
        ep.filePath,
        body,
        ep.chapterStart,
        ep.chapterEnd,
        { maxChars: chunkChars }
      )
    );
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
    if (proceed !== "除外して続行") return;
  }

  if (chunks.length === 0) {
    vscode.window.showWarningMessage("処理できる本文がありません。");
    return;
  }

  const store = new CharacterStore(work);
  if ((await store.dirtyDocumentPaths()).length > 0) {
    await vscode.window.showWarningMessage(
      "未保存の人物設定があります。人物設定を保存してから、もう一度実行してください。"
    );
    return;
  }
  const loaded = await store.loadAll();

  if (loaded.errors.length > 0) {
    const msg = loaded.errors
      .map((e) => `${e.file}: ${e.message}`)
      .join("\n");
    const answer = await vscode.window.showErrorMessage(
      `読み込めない設定ファイルがあります。上書きを避けるため処理を中止します。\n${msg}`,
      "詳細を表示",
      "閉じる"
    );
    if (answer === "詳細を表示") {
      const doc = await vscode.workspace.openTextDocument({
        content: msg,
        language: "text",
      });
      await vscode.window.showTextDocument(doc);
    }
    return;
  }

  const cache = new ChunkCache(work);
  await cache.load();

  const cacheKeyBase = {
    feature: "character_extract",
    promptVersion: CHARACTER_EXTRACT_VERSION,
    model: resolved.model,
  };

  // 未処理チャンクの件数を先に出して確認を取る
  const pending = chunks.filter(
    (c) => !cache.get(c.hash, cacheKeyBase)
  );

  if (pending.length === 0) {
    vscode.window.showInformationMessage(
      "すべてのチャンクが処理済みです。キャッシュから人物設定を再反映します。"
    );
  } else {
    const estimateMinutes = Math.ceil((pending.length * 20) / 60);
    const configuredMaxOutputTokens = vscode.workspace
      .getConfiguration("novelai")
      .get<number>("claude.maxOutputTokens", 8192);
    const costNotice = buildExtractionCostNotice(
      resolved.provider.id,
      pending,
      buildKnownCharacterNames(loaded.characters, []),
      configuredMaxOutputTokens
    );
    const confirm = await vscode.window.showInformationMessage(
      `${chunks.length} チャンク中 ${pending.length} 件を処理します` +
        `（処理済み ${chunks.length - pending.length} 件はスキップ）。\n` +
        `モデル: ${resolved.model} / 目安 ${estimateMinutes} 分程度\n` +
        costNotice,
      "実行",
      "中止"
    );
    if (confirm !== "実行") return;
  }

  const extractedAll: Array<{
    data: ExtractedCharacter;
    chapters: number[];
  }> = [];
  const rejectedCandidates: RejectedCharacterCandidate[] = [];
  const failures: ExtractionFailure[] = [];
  let cacheWarnings = 0;
  let cancelled = false;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "登場人物を抽出しています",
      cancellable: true,
    },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => {
        cancelled = true;
        controller.abort();
      });

      let done = 0;

      for (const chunk of chunks) {
        if (token.isCancellationRequested) break;

        const cached = cache.get(chunk.hash, cacheKeyBase);
        if (cached) {
          const validated = validateCharacterExtractResult(
            cached as CharacterExtractResult,
            chunk
          );
          extractedAll.push(...validated.accepted);
          rejectedCandidates.push(...validated.rejected);
          done++;
          continue;
        }

        const label = describeChunk(chunk);
        progress.report({
          message: `${done + 1}/${chunks.length}  ${label}`,
          increment: 100 / chunks.length,
        });

        // 既知の人物名を渡して同一人物判定を助ける
        const knownNames = buildKnownCharacterNames(
          loaded.characters,
          extractedAll
        );

        try {
          const res = await resolved.provider.generate({
            systemPrompt: BASE_SYSTEM_PROMPT,
            userPrompt: buildCharacterExtractPrompt({
              chunkText: chunk.text,
              chapterLabel: label,
              knownCharacterNames: knownNames.slice(0, 100),
            }),
            model: resolved.model,
            temperature: 0.2,
            numCtx,
            jsonSchema: CHARACTER_EXTRACT_SCHEMA as unknown as object,
            disableThinking: true,
            signal: controller.signal,
          });

          if (res.truncated) {
            failures.push({
              chunk,
              message:
                "AIの応答が出力上限で切り詰められました。" +
                "出力上限を増やすかチャンクを小さくしてください。",
            });
            done++;
            continue;
          }

          if (!res.text.trim()) {
            failures.push({
              chunk,
              message:
                "AIの応答が空でした。" +
                "出力上限とモデル設定を確認してください。",
            });
            done++;
            continue;
          }

          const parsed = parseResult(res.text);
          if (!parsed) {
            failures.push({
              chunk,
              message:
                "応答をJSONとして解析できませんでした。" +
                "出力上限とモデル設定を確認してください。",
            });
          } else {
            const validated = validateCharacterExtractResult(parsed, chunk);
            extractedAll.push(...validated.accepted);
            rejectedCandidates.push(...validated.rejected);
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
          failures.push(toExtractionFailure(chunk, e));
          if (e instanceof AIError && isFatalProviderFailure(e.kind)) {
            done++;
            break;
          }
          // 1チャンクの失敗で全体を止めない
        }

        done++;
      }

      try {
        await cache.save();
      } catch {
        // キャッシュは再生成可能。人物抽出結果の永続化は継続する。
        cacheWarnings++;
      }
    }
  );

  if (cancelled) {
    vscode.window.showInformationMessage(
      "登場人物の抽出を中止しました。完了済みの処理は次回再利用されます。"
    );
    return;
  }

  const merged =
    extractedAll.length > 0
      ? mergeExtractedCharacters(loaded.characters, extractedAll)
      : undefined;
  const changedCharacters = merged
    ? selectChangedCharacters(merged.characters, merged.changedIds)
    : [];
  const baseCounts: ExtractionSummaryCounts = {
    added: merged?.added.length ?? 0,
    updated: merged?.updated.length ?? 0,
    rejected: rejectedCandidates,
    conflicts: merged?.conflicts.length ?? 0,
    failedChunks: failures.length,
    saved: 0,
    ambiguous: 0,
    unsavedConflicts: 0,
    cacheWarnings,
  };

  if (changedCharacters.length > 0) {
    if ((await store.dirtyDocumentPaths()).length > 0) {
      await vscode.window.showWarningMessage(
        "保存直前に未保存の人物設定が見つかりました。作者の変更を保護するため、抽出結果は保存しませんでした。"
      );
      return;
    }
    try {
      await store.saveAll(changedCharacters);
      baseCounts.saved = changedCharacters.length;
    } catch (error) {
      if (!(error instanceof CharacterStoreError)) throw error;
      const persistence = persistenceCountsForSaveError(
        error,
        changedCharacters
      );
      baseCounts.saved = persistence.saved;
      baseCounts.ambiguous = persistence.ambiguous;
      baseCounts.unsavedConflicts = persistence.unsaved;
      const classification = describeCharacterStoreError(error);
      const recovery = describeFailureRecoveries(failures);
      const hasSettingsFailure = failures.some((failure) =>
        failure.kind ? shouldOfferSettings(failure.kind) : false
      );
      const actions = [
        ...(failures.length > 0 ? ["詳細を表示"] : []),
        ...(error.recoveryPaths.length > 0 ? ["回復パスを表示"] : []),
        ...(hasSettingsFailure ? ["設定を開く"] : []),
      ];
      const protectionMessage =
        persistence.saved === 0 && persistence.ambiguous === 0
          ? "作者の変更を保護するため保存しませんでした。" +
            "抽出結果は未保存です。"
          : "作者の変更を保護するため保存処理を途中で停止しました。";
      const reconciliationMessage =
        persistence.ambiguous > 0
          ? "保存状態を確定できない人物があります。" +
            "保存先と回復ファイルを手動で照合してください。\n"
          : "";
      const action = await vscode.window.showErrorMessage(
        `${classification}${protectionMessage}\n${reconciliationMessage}` +
          buildExtractionSummary(baseCounts) +
          (recovery ? `\n対応: ${recovery}` : ""),
        ...actions
      );
      if (action === "詳細を表示") {
        await showFailureDetails(failures);
      } else if (action === "回復パスを表示") {
        await showRecoveryPaths(error.recoveryPaths);
      } else if (action === "設定を開く") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `novelai.${resolved.provider.id}`
        );
      }
      return;
    }
  }

  const summary = buildExtractionSummary(baseCounts);
  const recovery = describeFailureRecoveries(failures);
  const message = recovery ? `${summary}\n対応: ${recovery}` : summary;
  const hasSettingsFailure = failures.some((failure) =>
    failure.kind ? shouldOfferSettings(failure.kind) : false
  );
  const actions = [
    ...(failures.length > 0 ? ["詳細を表示"] : []),
    ...(hasSettingsFailure ? ["設定を開く"] : []),
    ...(merged ? ["一覧を開く"] : []),
  ];
  const action =
    failures.length > 0 || cacheWarnings > 0 || !merged
      ? await vscode.window.showWarningMessage(message, ...actions)
      : await vscode.window.showInformationMessage(message, ...actions);

  if (action === "詳細を表示") {
    await showFailureDetails(failures);
  } else if (action === "設定を開く") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      `novelai.${resolved.provider.id}`
    );
  } else if (action === "一覧を開く") {
    const store2 = new CharacterStore(work);
    const dir = await store2.ensureDir();
    await vscode.commands.executeCommand(
      "revealInExplorer",
      vscode.Uri.file(dir)
    );
  }
}

function toExtractionFailure(chunk: Chunk, error: unknown): ExtractionFailure {
  if (!(error instanceof AIError)) {
    return {
      chunk,
      message:
        "AI処理で予期しないエラーが発生しました。" +
        "AI設定と拡張機能のログを確認してください。",
    };
  }

  const labels: Record<AIError["kind"], string> = {
    not_running: "AIに接続できませんでした。",
    model_not_found: "選択中のモデルを利用できませんでした。",
    timeout: "AIの応答が時間内に完了しませんでした。",
    bad_response: "AIの応答を利用できませんでした。",
    authentication_failed: "Claudeの認証に失敗しました。",
    permission_denied: "Claudeの利用権限がありません。",
    rate_limited: "Claudeのレート上限に達しました。",
    aborted: "AI処理が中断されました。",
    unknown: "AI処理で予期しないエラーが発生しました。",
  };
  return {
    chunk,
    kind: error.kind,
    // 例外本文にはプロバイダの応答や認証情報が混ざり得るため表示しない。
    message: `${labels[error.kind]}${recoveryForAIError(error)}`,
  };
}

function buildExtractionSummary(counts: ExtractionSummaryCounts): string {
  const rejectedDetail =
    counts.rejected.length > 0
      ? ` / ${describeRejectedCandidates(counts.rejected)}`
      : "";
  return [
    `新規 ${counts.added}名`,
    `更新 ${counts.updated}名`,
    `除外 ${counts.rejected.length}件`,
    `競合 ${counts.conflicts}件`,
    `失敗 ${counts.failedChunks}チャンク`,
    `保存済み ${counts.saved}名`,
    `手動確認が必要 ${counts.ambiguous}名`,
    `保存競合による未保存 ${counts.unsavedConflicts}名`,
    `キャッシュ保存警告 ${counts.cacheWarnings}件`,
  ].join(" / ") + rejectedDetail;
}

function describeCharacterStoreError(error: CharacterStoreError): string {
  const labels: Record<CharacterStoreError["kind"], string> = {
    modified_externally: "人物設定が読み込み後に変更されました。",
    path_conflict: "人物設定の保存先が競合しました。",
    unsaved_changes: "人物設定に未保存の変更があります。",
    io_error: "人物設定の保存中にファイル操作で失敗しました。",
  };
  return labels[error.kind];
}

function persistenceCountsForSaveError(
  error: CharacterStoreError,
  changedCharacters: Character[]
): { saved: number; ambiguous: number; unsaved: number } {
  const requestedIds = changedCharacters.map((character) => character.id);
  const requested = new Set(requestedIds);
  const claimed = new Set<string>();
  const takeKnown = (ids: string[]): number => {
    let count = 0;
    for (const id of ids) {
      if (!requested.has(id) || claimed.has(id)) continue;
      claimed.add(id);
      count++;
    }
    return count;
  };

  const progress = error.batchProgress;
  if (!progress) {
    return { saved: 0, ambiguous: 0, unsaved: requested.size };
  }

  const saved = takeKnown(progress.completedIds);
  const ambiguous = takeKnown(progress.ambiguousIds);
  const reportedUnsaved = takeKnown(progress.remainingIds);
  // 古いmockや将来の不完全な進捗でも、未分類の人物を保存済みとは扱わない。
  const unreported = [...requested].filter((id) => !claimed.has(id)).length;
  return {
    saved,
    ambiguous,
    unsaved: reportedUnsaved + unreported,
  };
}

function describeFailureRecoveries(failures: ExtractionFailure[]): string {
  return [...new Set(failures.map((failure) => failure.message))].join(" ");
}

async function showFailureDetails(
  failures: ExtractionFailure[]
): Promise<void> {
  if (failures.length === 0) return;
  const content = failures
    .map((failure) => `${describeChunk(failure.chunk)}: ${failure.message}`)
    .join("\n");
  const doc = await vscode.workspace.openTextDocument({
    content,
    language: "text",
  });
  await vscode.window.showTextDocument(doc);
}

async function showRecoveryPaths(recoveryPaths: string[]): Promise<void> {
  const content = [...new Set(recoveryPaths)].join("\n");
  if (!content) return;
  const doc = await vscode.workspace.openTextDocument({
    content,
    language: "text",
  });
  await vscode.window.showTextDocument(doc);
}

function isFatalProviderFailure(kind: AIError["kind"]): boolean {
  return kind === "authentication_failed" ||
    kind === "permission_denied" ||
    kind === "rate_limited";
}

function shouldOfferSettings(kind: AIError["kind"]): boolean {
  return kind === "not_running" ||
    kind === "model_not_found" ||
    kind === "authentication_failed" ||
    kind === "permission_denied";
}

function dirtyDocumentsInside(folderPath: string): vscode.TextDocument[] {
  return vscode.workspace.textDocuments.filter(
    (document) => document.isDirty && isPathInside(folderPath, document.uri.fsPath)
  );
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = normalizePathForComparison(parentPath);
  const candidate = normalizePathForComparison(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function normalizePathForComparison(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 実行前に、プロバイダごとの料金上の影響を明示する。 */
export function buildExtractionCostNotice(
  providerId: ProviderId,
  pendingChunks: Chunk[],
  knownCharacterNames: string[],
  configuredMaxOutputTokens: number
): string {
  if (providerId === "ollama") {
    return "料金: 無料・ローカル実行（API課金なし）";
  }
  if (providerId !== "claude") return "";

  // UTF-8の各バイトを1トークンとして数え、実際より少なく見せにくい
  // 上限寄りの概算にする。単価は変わりうるため金額には換算しない。
  const names = knownCharacterNames.slice(0, 100);
  const estimatedInputTokens = pendingChunks.reduce((total, chunk) => {
    const userPrompt = buildCharacterExtractPrompt({
      chunkText: chunk.text,
      chapterLabel: describeChunk(chunk),
      knownCharacterNames: names,
    });
    return (
      total +
      new TextEncoder().encode(BASE_SYSTEM_PROMPT).length +
      new TextEncoder().encode(userPrompt).length
    );
  }, 0);
  const perCall =
    Number.isInteger(configuredMaxOutputTokens) &&
    configuredMaxOutputTokens >= 1024
      ? configuredMaxOutputTokens
      : 8192;
  const totalOutputTokens = perCall * pendingChunks.length;

  return [
    "【課金対象トークン量の目安（上限寄り）】",
    `入力: 約 ${estimatedInputTokens.toLocaleString("ja-JP")} トークン` +
      "（実際に送る予定のチャンクと指示文をUTF-8バイト数で保守的に概算）",
    `出力: 最大 ${totalOutputTokens.toLocaleString("ja-JP")} トークン` +
      `（設定上限 ${perCall.toLocaleString("ja-JP")} × ${pendingChunks.length} 回）`,
    "Claude APIは実行すると課金が発生します。実際の金額はモデル、実使用量、" +
      "Anthropicの現行料金によって変わります。",
  ].join("\n");
}

/** 次のチャンクへ渡す既知名。直前までに得た別名も含める */
export function buildKnownCharacterNames(
  existing: Array<{ name: string; aliases: string[] }>,
  extracted: Array<{ data: ExtractedCharacter }>
): string[] {
  const names = [
    ...existing.flatMap((character) => [character.name, ...character.aliases]),
    ...extracted.flatMap((item) => [
      item.data.name,
      ...(Array.isArray(item.data.aliases) ? item.data.aliases : []),
    ]),
  ]
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/** 変更された人物だけを書き戻す */
export function selectChangedCharacters(
  characters: Character[],
  changedIds: string[]
): Character[] {
  const changed = new Set(changedIds);
  return characters.filter((character) => changed.has(character.id));
}

function describeRejectedCandidates(
  rejected: RejectedCharacterCandidate[]
): string {
  const labels: Record<CharacterRejectionReason, string> = {
    invalid_shape: "形式不正",
    invalid_name: "人物名不正",
    non_person: "人物以外",
    collective: "集団",
    ungrounded: "本文根拠なし",
  };
  const counts = new Map<CharacterRejectionReason, number>();
  for (const candidate of rejected) {
    counts.set(candidate.reason, (counts.get(candidate.reason) ?? 0) + 1);
  }
  const details = [...counts]
    .map(([reason, count]) => `${labels[reason]} ${count}`)
    .join("、");
  return `AI出力から除外 ${rejected.length} 件（${details}）`;
}

function describeChunk(chunk: Chunk): string {
  const name = path.basename(chunk.filePath);
  if (chunk.chapterStart === null) return name;
  const ch =
    chunk.chapterEnd !== null && chunk.chapterEnd !== chunk.chapterStart
      ? `第${chunk.chapterStart}〜${chunk.chapterEnd}話`
      : `第${chunk.chapterStart}話`;
  return chunk.index > 0 ? `${ch}(${chunk.index + 1})` : ch;
}
