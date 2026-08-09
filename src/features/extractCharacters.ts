import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import { Character } from "../models/character";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  AIError,
  recoveryForAIError,
  type AIProvider,
  type ConnectionTestResult,
  type ProviderId,
} from "../ai/types";
import {
  describeStartFailure,
  isLocalEndpoint,
  startOllama,
} from "../ai/ollamaLauncher";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { decideChunkSize, splitIntoChunks, Chunk } from "../core/chunker";
import {
  CharacterStore,
  CharacterStoreError,
} from "../core/characterStore";
import {
  mergeExtractedCharacters,
  type MergeCandidate,
} from "../core/characterMerge";
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
import {
  withCancellableProgress,
  withProgress,
} from "../views/progress";
import { logFailure, showLog } from "../core/logger";
import { resolveMaxOutputTokens } from "../ai/outputLimit";
import { PendingUpdateStore } from "../core/pendingUpdates";
import { applyPendingCharacterUpdates } from "./applyPendingUpdates";
import { ChunkCache } from "../core/chunkCache";
import {
  AbilitySystemStore,
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
} from "../core/abilityStore";
import {
  SettingsExtractionAccumulator,
  type SettingsPersistResult,
} from "./extractSettings";

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
  mergeCandidates: MergeCandidate[];
  /** モブとして記録された人数。ネームドキャラと区別して示す */
  mobs: number;
  /** 既存人物への更新のうち、承認待ちに回した人数 */
  pendingUpdates: number;
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
        "保存できない文書があるため、設定資料の抽出を中止しました。"
      );
      return false;
    }
  }

  if (dirtyDocumentsInside(work.folderPath).length > 0) {
    await vscode.window.showWarningMessage(
      "保存後も未保存の文書が残っているため、設定資料の抽出を中止しました。"
    );
    return false;
  }
  return true;
}

/**
 * 本文から登場人物・能力・場所を抽出して保存する。
 *
 * 戻り値は「設定が保存されたか」。
 * 中止・失敗のときに資料Markdownまで作り直しても意味がないため、
 * 呼び出し側が続けて資料を生成してよいかを判断できるようにしている。
 */
export async function extractCharacters(
  work: WorkEntry,
  registry: AIRegistry
): Promise<boolean> {
  const resolved = await ensureConfigured(registry);
  if (!resolved) return false;

  // モデル情報はチャンクサイズを決めるのに使う。
  // 取得できないまま既定値で進むと、本来より細かく分割され、
  // ハッシュが変わって既存のキャッシュが全て無駄になる。
  // そのため取れない場合は、先に疎通を回復させてから取り直す。
  let modelInfo = await registry.resolveModelInfo();
  if (!modelInfo) {
    if (!(await confirmProviderReachable(resolved.provider))) return false;
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
    return false;
  }

  const contextWindow = modelInfo.contextWindow;
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
    return false;
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
    if (proceed !== "除外して続行") return false;
  }

  if (chunks.length === 0) {
    vscode.window.showWarningMessage("処理できる本文がありません。");
    return false;
  }

  const store = new CharacterStore(work);
  if ((await store.dirtyDocumentPaths()).length > 0) {
    await vscode.window.showWarningMessage(
      "未保存の人物設定があります。人物設定を保存してから、もう一度実行してください。"
    );
    return false;
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
    return false;
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
    // キャッシュだけで完結するのでAIには接続しない。
    // Ollamaが落ちていても再反映はできるため、ここで疎通を求めない。
    vscode.window.showInformationMessage(
      "すべてのチャンクが処理済みです。キャッシュから人物設定を再反映します。"
    );
  } else {
    // AIを呼ぶ前に疎通を確認する。
    // ここで確認しないと、接続できないまま全チャンクを順に試し、
    // 待たされた末に「失敗 N 件」とだけ言われることになる。
    if (!(await confirmProviderReachable(resolved.provider))) return false;

    const estimateMinutes = Math.ceil((pending.length * 20) / 60);
    // 表示する上限と、実際に送る上限を同じ値にする。
    // 金額に関わる表示なので、送っていない上限を目安として出さない
    const configuredMaxOutputTokens = resolveMaxOutputTokens();
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
    if (confirm !== "実行") return false;
  }

  const extractedAll: Array<{
    data: ExtractedCharacter;
    chapters: number[];
  }> = [];
  const rejectedCandidates: RejectedCharacterCandidate[] = [];
  const failures: ExtractionFailure[] = [];
  let cacheWarnings = 0;
  let cancelled = false;
  /** 実行中にAIへ接続できなくなり、残りのチャンクを諦めたか */
  let connectivityLost = false;
  let consecutiveConnectivityFailures = 0;
  /** レート上限で待った回数と合計時間。待ち続けないための歯止め */
  const rateLimit: RateLimitWaitState = { waits: 0, totalWaitedMs: 0 };
  /** 待っても解消せず諦めたか。作者への説明を変える */
  let rateLimitGaveUp = false;

  // 同じAI応答から能力・場所も取り出す。種別ごとにAIを呼ばないための仕組み。
  // 既存の総称が決まっていれば、チャンクごとに揺れないよう引き継ぐ。
  const abilitySystem = await new AbilitySystemStore(work).load();
  const existingAbilities = (await createAbilityStore(work).loadAll()).records;
  const existingLocations = (await createLocationStore(work).loadAll()).records;
  const existingOrganizations = (
    await createOrganizationStore(work).loadAll()
  ).records;
  const settings = new SettingsExtractionAccumulator(
    abilitySystem.autoGenerated ? null : abilitySystem.abilityTerm
  );

  await withCancellableProgress(
    "設定資料を抽出しています",
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
          const cachedResult = cached as CharacterExtractResult;
          const validated = validateCharacterExtractResult(
            cachedResult,
            chunk
          );
          extractedAll.push(...validated.accepted);
          rejectedCandidates.push(...validated.rejected);
          // キャッシュにも能力・場所が入っている。同じ応答を使い回す
          settings.collect(cachedResult, chunk);
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

        const callAI = () =>
          resolved.provider.generate({
            systemPrompt: BASE_SYSTEM_PROMPT,
            userPrompt: buildCharacterExtractPrompt({
              chunkText: chunk.text,
              chapterLabel: label,
              knownCharacterNames: knownNames.slice(0, 100),
              knownAbilityNames: settings
                .knownAbilityNames(existingAbilities)
                .slice(0, 50),
              knownLocationNames: settings
                .knownLocationNames(existingLocations)
                .slice(0, 50),
              knownOrganizationNames: settings
                .knownOrganizationNames(existingOrganizations)
                .slice(0, 50),
              abilityTerm: settings.currentAbilityTerm() ?? undefined,
            }),
            model: resolved.model,
            temperature: 0.2,
            numCtx,
            jsonSchema: CHARACTER_EXTRACT_SCHEMA as unknown as object,
            disableThinking: true,
            signal: controller.signal,
          });

        try {
          // 無料枠は毎分の呼び出し回数が少なく、すぐ上限に当たる。
          // サーバーが待ち時間を指定してきたら守って同じチャンクをやり直す。
          // 上限で弾かれた呼び出しは課金対象にならないので、
          // 失敗として捨てるより待って続けるほうが作者の損が少ない。
          let res: Awaited<ReturnType<typeof callAI>> | undefined;
          for (;;) {
            try {
              res = await callAI();
              break;
            } catch (error) {
              const waitMs = rateLimitWaitMs(error, rateLimit);
              if (waitMs === undefined) {
                // 待ちきれなかった場合は、そのことを理由として残す。
                // 「利用できませんでした」だけでは待った意味が伝わらない
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
                  `${done + 1}/${chunks.length}  ` +
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

          // 応答が返った時点で接続は生きている。連続失敗の数え直し
          consecutiveConnectivityFailures = 0;

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
            settings.collect(parsed, chunk);
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

          failures.push(
            toExtractionFailure(chunk, e, {
              provider: resolved.provider.displayName,
              model: resolved.model,
            })
          );
          if (e instanceof AIError && isFatalProviderFailure(e.kind)) {
            done++;
            break;
          }
          // 実行中にAIが落ちた・回線が切れた場合、残りも同じ理由で失敗する。
          // 単発の揺らぎは許容しつつ、連続したら待たせずに打ち切る。
          if (e instanceof AIError && isConnectivityFailure(e.kind)) {
            consecutiveConnectivityFailures++;
            if (
              consecutiveConnectivityFailures >= CONNECTIVITY_FAILURE_LIMIT
            ) {
              connectivityLost = true;
              done++;
              break;
            }
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
      "設定資料の抽出を中止しました。完了済みの処理は次回再利用されます。"
    );
    return false;
  }

  /** 承認待ちに回した更新の件数。要約で作者へ知らせる */
  let pendingUpdateCount = 0;
  /** 保留に失敗した場合の説明。要約の先頭へ足す */
  let settingsNoticePrefix = "";

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
    mergeCandidates: merged?.mergeCandidates ?? [],
    mobs: merged?.characters.filter((character) => character.isMob).length ?? 0,
    pendingUpdates: 0,
  };

  // 既存人物への変更は、その場では書き込まずに保留へ回す。
  // このプロジェクトは正規ファイルを上書きしないため以前は必ず失敗しており、
  // 作品を書き進めても既存人物の情報がまったく増えなかった。
  // 作者が内容を見て承認したときにだけ反映する。
  const existingIds = new Set(loaded.characters.map((character) => character.id));
  const newCharacters = changedCharacters.filter(
    (character) => !existingIds.has(character.id)
  );
  const updatedCharacters = changedCharacters.filter((character) =>
    existingIds.has(character.id)
  );

  if (updatedCharacters.length > 0) {
    try {
      await new PendingUpdateStore(work).stage(updatedCharacters);
      pendingUpdateCount = updatedCharacters.length;
      baseCounts.pendingUpdates = pendingUpdateCount;
    } catch (error) {
      settingsNoticePrefix =
        "\n既存人物の更新案を保留できませんでした: " +
        (error instanceof Error ? error.message : String(error));
    }
  }

  if (newCharacters.length > 0) {
    if ((await store.dirtyDocumentPaths()).length > 0) {
      await vscode.window.showWarningMessage(
        "保存直前に未保存の人物設定が見つかりました。作者の変更を保護するため、抽出結果は保存しませんでした。"
      );
      return false;
    }
    try {
      await store.saveAll(newCharacters);
      baseCounts.saved = newCharacters.length;
    } catch (error) {
      if (!(error instanceof CharacterStoreError)) throw error;
      const persistence = persistenceCountsForSaveError(
        error,
        newCharacters
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
      return false;
    }
  }

  // 能力・場所を保存する。人物の保存が終わってから行うのは、
  // 人物側で保存を中止した場合に設定だけ書き込まれるのを避けるため。
  let settingsNotice = settingsNoticePrefix;
  try {
    const persisted = await settings.persist(work);
    settingsNotice = describeSettingsResult(persisted);
  } catch (error) {
    // 設定の保存に失敗しても、人物の抽出結果は保存済みである。
    // 何が保存されなかったかを伝えて続行する。
    settingsNotice =
      "\n能力・場所は保存できませんでした: " +
      (error instanceof Error ? error.message : String(error));
  }

  const summary = buildExtractionSummary(baseCounts) + settingsNotice;
  const recovery = describeFailureRecoveries(failures);
  // 接続断で打ち切った場合、件数だけ見せても理由が伝わらないので先頭で明示する
  const connectivityNotice = connectivityLost
    ? "AIへ接続できなくなったため、残りのチャンクを中断しました。" +
      "AIが起動しているか、ネットワーク接続を確認してください。" +
      "完了済みの処理は次回再利用されます。\n"
    : rateLimitGaveUp
      ? `${describeRateLimitGiveUp(rateLimit)}\n`
      : "";
  const message =
    connectivityNotice +
    (recovery ? `${summary}\n対応: ${recovery}` : summary);
  const hasSettingsFailure = failures.some((failure) =>
    failure.kind ? shouldOfferSettings(failure.kind) : false
  );
  const actions = [
    ...(pendingUpdateCount > 0 ? ["更新分を反映"] : []),
    ...(failures.length > 0 ? ["詳細を表示", "ログを表示"] : []),
    ...(hasSettingsFailure ? ["設定を開く"] : []),
    ...(merged ? ["一覧を開く"] : []),
  ];
  const action =
    failures.length > 0 ||
    cacheWarnings > 0 ||
    connectivityLost ||
    rateLimitGaveUp ||
    !merged
      ? await vscode.window.showWarningMessage(message, ...actions)
      : await vscode.window.showInformationMessage(message, ...actions);

  if (action === "更新分を反映") {
    await applyPendingCharacterUpdates(work);
  } else if (action === "詳細を表示") {
    await showFailureDetails(failures);
  } else if (action === "ログを表示") {
    showLog();
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

  // ここまで来ていれば人物・能力・場所の保存を試みている。
  // 保存件数が0でも、既存の設定から資料は作り直せる
  return true;
}

/**
 * 原因がはっきりしていて、こちらで書いた説明をそのまま出すべき失敗か。
 *
 * 定型文だけでは何をすればよいか伝わらないものに限る。
 * プロバイダーの応答本文をそのまま出さないという方針は崩さない
 * （これらのメッセージはすべて拡張機能側で組み立てている）。
 */
function hasSpecificMessage(kind: AIError["kind"]): boolean {
  return kind === "insufficient_credit";
}

function toExtractionFailure(
  chunk: Chunk,
  error: unknown,
  /**
   * どのAIのどのモデルで起きたか。
   *
   * これが無いと、AIを切り替えたあとにログを見たとき、
   * 前のAIの失敗を今のAIのものと取り違える。実際に起きた
   * （Ollamaへ切り替えたのに、残っていたGeminiの上限エラーを
   * Ollamaの失敗だと読んでしまった）。
   */
  used?: { provider: string; model: string }
): ExtractionFailure {
  // 通知には出さない技術的な内容をログへ残す。
  // これが無いと、作者は「利用できませんでした」だけを見て手詰まりになる
  logFailure("AI呼び出しの失敗", {
    ファイル: describeChunk(chunk),
    使用中のAI: used ? `${used.provider} / ${used.model}` : "不明",
    種別: error instanceof AIError ? error.kind : "不明",
    詳細:
      error instanceof AIError
        ? error.detail
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
  });

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
    // 使っているのがGeminiでも「Claudeの…」と出ないよう、サービス名は書かない
    authentication_failed: "AIの認証に失敗しました。",
    permission_denied: "AIの利用権限がありません。",
    insufficient_credit: "AIサービスの残高が不足しています。",
    rate_limited: "AIのレート上限に達しました。",
    aborted: "AI処理が中断されました。",
    unknown: "AI処理で予期しないエラーが発生しました。",
  };
  return {
    chunk,
    kind: error.kind,
    // 例外本文にはプロバイダの応答や認証情報が混ざり得るため表示しない。
    // ただし拡張機能側で組み立てた具体的な説明は、そのまま出したほうが役に立つ。
    message: hasSpecificMessage(error.kind)
      ? error.message
      : `${labels[error.kind]}${recoveryForAIError(error)}`,
  };
}

function buildExtractionSummary(counts: ExtractionSummaryCounts): string {
  const rejectedDetail =
    counts.rejected.length > 0
      ? ` / ${describeRejectedCandidates(counts.rejected)}`
      : "";
  // 統合候補は自動では反映しないので、作者が気づけるよう本文に出す
  const candidateDetail =
    counts.mergeCandidates.length > 0
      ? `\n同一人物かもしれない組: ${describeMergeCandidates(
          counts.mergeCandidates
        )}（自動では統合していません）`
      : "";
  return (
    [
      `新規 ${counts.added}名（うちモブ ${counts.mobs}名）`,
      `更新 ${counts.updated}名`,
      `除外 ${counts.rejected.length}件`,
      `競合 ${counts.conflicts}件`,
      `失敗 ${counts.failedChunks}チャンク`,
      `保存済み ${counts.saved}名`,
      `手動確認が必要 ${counts.ambiguous}名`,
      `保存競合による未保存 ${counts.unsavedConflicts}名`,
      `キャッシュ保存警告 ${counts.cacheWarnings}件`,
    ].join(" / ") +
    rejectedDetail +
    candidateDetail +
    // 既存人物への変更は承認待ちに回る。件数を出さないと、
    // 作者は「更新0名」を見て何も増えなかったと思ってしまう
    (counts.pendingUpdates > 0
      ? `\n既存人物への更新 ${counts.pendingUpdates}名は承認待ちです（「更新分を反映」から確認できます）`
      : "")
  );
}

/**
 * 能力・場所の結果を説明する。
 * 該当が無い種別は行を出さない。能力体系の無い作品に
 * 「能力 0件」と表示しても意味がないため。
 */
function describeSettingsResult(result: SettingsPersistResult): string {
  const { counts } = result;
  const lines: string[] = [];

  const abilityTotal = counts.abilitiesAdded + counts.abilitiesUpdated;
  if (abilityTotal > 0) {
    const label = counts.abilityTerm ?? "能力";
    lines.push(
      `${label}: 新規 ${counts.abilitiesAdded}件 / 更新 ${counts.abilitiesUpdated}件`
    );
  }

  const organizationTotal =
    counts.organizationsAdded + counts.organizationsUpdated;
  if (organizationTotal > 0) {
    lines.push(
      `組織: 新規 ${counts.organizationsAdded}件 / 更新 ${counts.organizationsUpdated}件`
    );
  }

  const locationTotal = counts.locationsAdded + counts.locationsUpdated;
  if (locationTotal > 0) {
    lines.push(
      `場所: 新規 ${counts.locationsAdded}件 / 更新 ${counts.locationsUpdated}件`
    );
  }

  if (counts.mergeCandidates.length > 0) {
    const shown = counts.mergeCandidates
      .slice(0, 3)
      .map(({ names }) => `「${names[0]}」と「${names[1]}」`)
      .join("、");
    const rest =
      counts.mergeCandidates.length > 3
        ? ` ほか${counts.mergeCandidates.length - 3}組`
        : "";
    lines.push(
      `同じものかもしれない組: ${shown}${rest}（自動では統合していません）`
    );
  }

  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

function describeMergeCandidates(candidates: MergeCandidate[]): string {
  const shown = candidates
    .slice(0, 5)
    .map(({ names }) => `「${names[0]}」と「${names[1]}」`)
    .join("、");
  const rest =
    candidates.length > 5 ? ` ほか${candidates.length - 5}組` : "";
  return shown + rest;
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
  const content = [
    ...failures.map(
      (failure) =>
        `${describeChunk(failure.chunk)}: ${failure.message}` +
        (failure.kind ? `（種別: ${failure.kind}）` : "")
    ),
    "",
    "AIが返した詳細は「表示 > 出力」の「小説AI執筆補助」に記録しています。",
    "原因が分からない場合は、そこの内容を確認してください。",
  ].join("\n");
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

/**
 * AIを呼び始める前に疎通を確認する。
 *
 * Ollamaが起動していない・ネットワークが切れている場合、
 * 確認せずに走らせると全チャンクが同じ理由で失敗するだけなので、
 * 開始前に止めて作者に理由と対処を伝える。
 */
async function confirmProviderReachable(
  provider: Pick<AIProvider, "id" | "testConnection">
): Promise<boolean> {
  // testConnection を持たないプロバイダは確認をスキップする（実行自体は妨げない）
  if (typeof provider.testConnection !== "function") return true;

  for (;;) {
    let result: ConnectionTestResult;
    try {
      result = await withProgress("AIに接続できるか確認しています…", () =>
        provider.testConnection()
      );
    } catch (error) {
      // testConnection 自体が落ちた場合も「接続できない」として扱う
      result = {
        ok: false,
        message:
          error instanceof Error ? error.message : String(error),
      };
    }

    if (result.ok) return true;

    // ローカルのOllamaなら、この場から起動できる
    const canStart = provider.id === "ollama" && isLocalOllamaEndpoint();

    const action = await vscode.window.showWarningMessage(
      `AIに接続できないため、設定資料の抽出を開始できません。\n${result.message}`,
      ...(canStart ? ["Ollamaを起動"] : []),
      "再試行",
      "設定を開く",
      "中止"
    );

    if (action === "Ollamaを起動") {
      const started = await startOllamaWithProgress();
      if (!started) continue; // 失敗理由は起動側で通知済み。再度この警告へ戻る
      continue; // 起動できたので疎通を確認し直す
    }
    if (action === "再試行") continue;
    if (action === "設定を開く") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `novelai.${provider.id}`
      );
    }
    return false;
  }
}

function ollamaEndpoint(): string {
  return vscode.workspace
    .getConfiguration("novelai")
    .get<string>("ollama.endpoint", "http://localhost:11434");
}

function isLocalOllamaEndpoint(): boolean {
  return isLocalEndpoint(ollamaEndpoint());
}

/** Ollamaを起動し、応答するまで進捗を出しながら待つ */
async function startOllamaWithProgress(): Promise<boolean> {
  const outcome = await withProgress("Ollamaを起動しています…", () =>
    startOllama({
      endpoint: ollamaEndpoint(),
      executablePath: vscode.workspace
        .getConfiguration("novelai")
        .get<string>("ollama.executablePath", ""),
    })
  );

  if (outcome.ok) {
    vscode.window.showInformationMessage("Ollamaを起動しました。");
    return true;
  }

  // 実行ファイルが見つからない場合は、その場で選んでもらえるようにする
  if (outcome.reason === "not_installed") {
    const action = await vscode.window.showWarningMessage(
      describeStartFailure(outcome),
      "実行ファイルを選択",
      "閉じる"
    );
    if (action === "実行ファイルを選択") {
      await vscode.commands.executeCommand("novelai.selectOllamaExecutable");
    }
    return false;
  }

  await vscode.window.showWarningMessage(describeStartFailure(outcome));
  return false;
}

/**
 * 接続断とみなす失敗の種別。
 * 単発なら通信の揺らぎかもしれないが、連続するならAI側が落ちている。
 */
function isConnectivityFailure(kind: AIError["kind"]): boolean {
  return kind === "not_running" || kind === "timeout";
}

/** 1回あたりの待機時間の上限。これを超える指定なら待たずに失敗として扱う */
const MAX_RATE_LIMIT_WAIT_MS = 90_000;

/**
 * 1回の抽出で待ってよい合計時間。
 *
 * 無料枠には毎分の制限とは別に1日あたりの上限があり、
 * そちらを使い切ると待っても回復しない。それでも待ち続けると
 * 何十分も終わらない処理になる。
 * 回数ではなく**合計時間**で区切るのは、1回の待ち時間が
 * サーバーの都合で変わるため、回数では長さを見積もれないから。
 */
const MAX_TOTAL_RATE_LIMIT_WAIT_MS = 180_000;

export interface RateLimitWaitState {
  waits: number;
  totalWaitedMs: number;
}

/**
 * レート上限で待つべきなら待機時間を返す。待つべきでなければ undefined。
 *
 * サーバーが待ち時間を示してこない場合は待たない。
 * 当てずっぽうで待つと、いつ終わるか分からない処理になる。
 */
export function rateLimitWaitMs(
  error: unknown,
  state: RateLimitWaitState
): number | undefined {
  if (!(error instanceof AIError)) return undefined;
  if (error.kind !== "rate_limited") return undefined;
  if (error.retryAfterMs === undefined) return undefined;

  // サーバーの指定ちょうどだと際どいので少し余裕を持たせる
  const waitMs = error.retryAfterMs + 1000;
  if (waitMs > MAX_RATE_LIMIT_WAIT_MS) return undefined;
  if (state.totalWaitedMs + waitMs > MAX_TOTAL_RATE_LIMIT_WAIT_MS) {
    return undefined;
  }
  return waitMs;
}

/** 待ちきれずに諦めたときの説明。次に何をすればよいかまで書く */
export function describeRateLimitGiveUp(state: RateLimitWaitState): string {
  return (
    `レート上限のため合計 ${Math.round(state.totalWaitedMs / 1000)} 秒待ちましたが、` +
    "解消しませんでした。無料枠には1日あたりの上限もあり、" +
    "使い切っている場合は待っても回復しません。\n" +
    "時間をおいて再実行するか、呼び出し回数の多い抽出はOllamaで行ってください。" +
    "完了済みのチャンクは次回再利用されます。"
  );
}

/** 中止できる待機。中止されたら false */
function delay(
  ms: number,
  token: vscode.CancellationToken
): Promise<boolean> {
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

/** 連続でこの回数だけ接続に失敗したら、残りのチャンクを試さず中断する */
const CONNECTIVITY_FAILURE_LIMIT = 3;

function isFatalProviderFailure(kind: AIError["kind"]): boolean {
  return kind === "authentication_failed" ||
    kind === "permission_denied" ||
    // 待っても直らない。残りのチャンクを試すだけ無駄になる
    kind === "insufficient_credit" ||
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

/** 課金の説明に出すサービス名 */
const CLOUD_SERVICE_NAMES: Partial<Record<ProviderId, string>> = {
  claude: "Claude API",
  openai: "OpenAI API",
  gemini: "Gemini API",
};

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

  const serviceName = CLOUD_SERVICE_NAMES[providerId] ?? "利用中のAIサービス";

  return [
    "【課金対象トークン量の目安（上限寄り）】",
    `入力: 約 ${estimatedInputTokens.toLocaleString("ja-JP")} トークン` +
      "（実際に送る予定のチャンクと指示文をUTF-8バイト数で保守的に概算）",
    `出力: 最大 ${totalOutputTokens.toLocaleString("ja-JP")} トークン` +
      `（設定上限 ${perCall.toLocaleString("ja-JP")} × ${pendingChunks.length} 回）`,
    `${serviceName}は実行すると利用量が加算されます。実際の金額はモデル、実使用量、` +
      "各社の現行料金によって変わります。無料枠の有無も提供元の条件によります。",
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
