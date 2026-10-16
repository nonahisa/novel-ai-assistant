import * as vscode from "vscode";
import * as path from "../core/paths";
import { AIWRITER_DIR, type WorkEntry } from "../models/types";
import type { AIRegistry } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import { atomicWriteFile } from "../core/atomicWrite";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { CharacterStore } from "../core/characterStore";
import {
  AbilitySystemStore,
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import { ExtractionReplay, initialAbilityTermOf } from "../core/externalExtractMerge";
import { SettingsExtractionCollector } from "../core/settingsExtractionCollect";
import { buildKnownCharacterNamesForPrompt } from "../core/knownCharacterNames";
import { parseResult } from "../core/characterExtractionValidation";
import {
  foreignNarrationScenesInChunk,
  foreignNarratorNoteOf,
  withSceneText,
  workNarratorContextOf,
} from "../core/sceneNarrators";
import { blankMemoLines } from "../core/sceneMemo";
import {
  EXTRACT_STASH_SUBPATH,
  externalChunksOfText,
  formatExtractStash,
  parseExtractStashEntries,
  withStashEntries,
  type ExtractStashEntry,
} from "../core/externalExtractStash";
import type { Chunk } from "../core/chunker";
import {
  BASE_SYSTEM_PROMPT,
  CHARACTER_EXTRACT_SCHEMA,
  CHARACTER_EXTRACT_TEMPERATURE,
  CHARACTER_EXTRACT_VERSION,
  buildCharacterExtractPrompt,
} from "../prompts/characterExtract";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { readChunkSettings, resolveModelInfoOrWarn } from "./chunkSettings";
import { confirmProviderReachable } from "./aiConnectivity";
import { withAiTurnProgress } from "./aiTurn";
import {
  callWithRateLimitWait,
  newRateLimitRetryState,
  rateLimitWaitHooks,
} from "./rateLimitRetry";
import type { RunOutcome } from "./runRequestHandler";

/**
 * 外部AIから頼まれた設定資料の抽出（`run.request` feature: settings。2026-10-16 の
 * 棚卸しの5件目）。**作者のAI設定（機能別AI割当の「抽出」）で取り出して検算し、
 * 答えを貯めるだけ**——設定資料には1件も書かない。
 *
 * ## 保存は `novel.extract.commit` に任せる
 *
 * 保存の線（新しい記録だけ保存・既存の記録への変更は承認待ち・既存のファイルは
 * 1バイトも変えない）は MCP の `novel.extract.commit` に1か所だけある（6.87.7 の例外）。
 * ここで保存まですると、同じ線を2か所で守ることになる。そこで答えを MCP と同じ
 * 貯め場所（`.aiwriter/cache/external-extract.json`。Git に載らない控え）へ貯め、
 * 頼んだ側が `novel.extract.commit` を呼ぶ。
 *
 * ## 製品の［設定資料を抽出］と違うところ
 *
 * - **チャンクの切り方**：隣の話をまとめて送らない（`externalChunksOfText`）。
 *   保存の道は `chunkId` から本文を切り直してハッシュを照合するので、まとめて送ると
 *   貯めた答えが全部「本文が変わった」として捨てられる
 * - **製品のチャンクの控え（ChunkCache）を使わない**：切り方が違うので鍵が噛み合わない
 * - **出力が切り詰められたチャンクを割り直さない**：割った断片は保存の道で切り直せない。
 *   失敗として数えて返す（黙って飛ばさない）
 *
 * 並び（既知名を育てながらチャンクを回す・検算は `ExtractionReplay`）は製品と保存の道と
 * 同じ部品を通す。**検算の写しを持たない**（CLAUDE.md の「繰り返し起きた失敗」5）。
 */

/** 既知名の上限。**製品と同じところで切る**（`features/extractCharacters.ts`） */
const KNOWN_LIMIT = 50;
/** 世界観の見出しだけ多く渡す（同じ事柄が別の見出しで増えるのを防ぐため） */
const KNOWN_WORLD_LIMIT = 150;

/** 作品の貯め場所（作品フォルダーからの位置） */
export function extractStashPathOf(work: Pick<WorkEntry, "folderPath">): string {
  return path.join(work.folderPath, AIWRITER_DIR, ...EXTRACT_STASH_SUBPATH);
}

/**
 * 貯め場所を読む。無ければ空。**形が合わなければ undefined**（＝止める。
 * 黙って空として扱うと、外部AIが前に貯めた分をこの回で上書きして消す）。
 */
async function readStash(file: string): Promise<ExtractStashEntry[] | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(file));
  } catch {
    return [];
  }
  try {
    return parseExtractStashEntries(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

export async function runSettingsExtraction(
  work: WorkEntry,
  registry: AIRegistry,
  filePaths: string[]
): Promise<RunOutcome> {
  useLogFile(work.folderPath);
  const resolved = registry.resolve("extract");
  if (!resolved) {
    return {
      ok: false,
      reason: "設定資料の抽出に使うAIがまだ設定されていません。",
      nextAction: "AI設定（または機能別AI割当）で使うAIを選んでください",
    };
  }

  /*
    **AIへ送る前に、貯め場所が読めるかを確かめる。** 読めないまま走らせると、
    送った料金ぶんの答えを貯められずに捨てることになる
  */
  const stashFile = extractStashPathOf(work);
  const before = await readStash(stashFile);
  if (!before) {
    return {
      ok: false,
      reason:
        "抽出の貯め場所（.aiwriter/cache/external-extract.json）の形が違うため、走らせませんでした。",
      nextAction: "中身を確かめるか、要らなければ消してから頼み直してください",
    };
  }

  // チャンクの大きさを決めるのにモデルの情報が要る（取れなければ止める。製品と同じ）
  const info = await resolveModelInfoOrWarn({
    registry,
    feature: "extract",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "設定資料の抽出",
  });
  if (!info) {
    return {
      ok: false,
      reason: "モデルの情報（扱える長さ）を取れませんでした。",
      nextAction: "AIを起動し、接続先設定を確認してください",
    };
  }

  const plannedOutputTokens = resolveOutputTokensForPlanning(
    resolved.provider.id,
    resolved.model,
    "character_extract"
  );
  const sendOutputTokens = resolveOutputTokensForSend(
    resolved.provider.id,
    resolved.model,
    "character_extract"
  );
  // **本文を空にしてプロンプトを組み、その字数を固定費とする**（製品と同じ。設計書6.27.10）
  const overheadChars =
    BASE_SYSTEM_PROMPT.length +
    buildCharacterExtractPrompt({ chunkText: "", chapterLabel: "", knownCharacterNames: [] })
      .length;
  // 大きさは製品と同じ決め方。**まとめ送信（mergeChars）だけは使わない**
  const maxChars = readChunkSettings(
    info.contextWindow,
    { overheadChars, outputTokens: plannedOutputTokens },
    { providerId: resolved.provider.id, model: resolved.model, feature: "character_extract" }
  ).chunk.chars;

  // 切る。**競合マーカーのあるファイルはAIに掛けない**（規則1）
  const scan = await scanWork(work);
  const episodes =
    filePaths.length > 0
      ? scan.episodes.filter((episode) =>
          filePaths.some((filePath) => path.isSamePath(filePath, episode.filePath))
        )
      : scan.episodes;
  const items: Array<{ chunkId: string; chunk: Chunk; relative: string }> = [];
  const conflicted: string[] = [];
  for (const episode of episodes) {
    const file = await readTextFile(episode.filePath);
    if (file.hasConflictMarkers) {
      conflicted.push(episode.fileName);
      continue;
    }
    const relative = path.relative(work.folderPath, episode.filePath);
    for (const item of externalChunksOfText(relative, file.text, maxChars)) {
      items.push({ ...item, relative });
    }
  }
  if (items.length === 0) {
    return {
      ok: false,
      reason:
        conflicted.length > 0
          ? `抽出できる本文がありません（未解決の競合：${conflicted.join("・").slice(0, 120)}）。`
          : "抽出できる本文がありません。",
    };
  }

  if (!(await confirmProviderReachable(resolved.provider, "設定資料の抽出", resolved.model))) {
    return {
      ok: false,
      reason: "AIに繋がりませんでした。",
      nextAction: "AIを起動し、接続先設定を確認してください",
    };
  }

  // 既にある資料（**読むだけ**。壊れたものは各台帳が理由つきで飛ばす）
  const loaded = await new CharacterStore(work).loadAll();
  const abilitySystem = await new AbilitySystemStore(work).load();
  const existingAbilities = (await createAbilityStore(work).loadAll()).records;
  const existingLocations = (await createLocationStore(work).loadAll()).records;
  const existingOrganizations = (await createOrganizationStore(work).loadAll()).records;
  const existingWorld = (await createWorldStore(work).loadAll()).records;
  const settings = new SettingsExtractionCollector(initialAbilityTermOf(abilitySystem));
  // 作品の語り手は全話を繋いだ本文で1回だけ決める（製品と同じ。設計書6.5.12）
  const workNarrator = workNarratorContextOf(
    items.map((item) => blankMemoLines(item.chunk.text)).join("\n"),
    loaded.characters
  );
  const replay = new ExtractionReplay(
    {
      characters: loaded.characters,
      abilities: existingAbilities,
      locations: existingLocations,
      organizations: existingOrganizations,
      world: existingWorld,
    },
    settings,
    workNarrator
  );

  const stashed: ExtractStashEntry[] = [];
  const findings: Record<string, unknown>[] = [];
  const failureNotes: string[] = [];
  let failed = 0;
  let cancelled = false;
  const rateLimit = newRateLimitRetryState();
  logStep(
    `外部AIからの依頼で設定資料を抽出します（貯めるだけで保存しません）: ${work.title} / ` +
      `${resolved.provider.displayName} / ${resolved.model} / ${items.length}チャンク / ${maxChars}字`
  );

  // **ほかの一括処理と重ならないよう、実行の札を取る**（設計書6.76）
  await withAiTurnProgress(
    "外部AIからの依頼：設定資料を抽出しています",
    { label: "設定資料の抽出（外部AIからの依頼）", onCancelled: () => (cancelled = true) },
    async (progress, token) => {
      const controller = new AbortController();
      const listener = token.onCancellationRequested(() => {
        cancelled = true;
        controller.abort();
      });
      try {
        for (let position = 0; position < items.length; position++) {
          if (token.isCancellationRequested) {
            cancelled = true;
            break;
          }
          const { chunkId, chunk, relative } = items[position];
          const label = chapterLabelOf(chunk);
          progress.report({
            message: `${position + 1}/${items.length}  ${label}`,
            increment: 100 / items.length,
          });
          // 既知名は製品と同じ形で育てる（人数で切る。`buildKnownCharacterNamesForPrompt`）
          const userPrompt = buildCharacterExtractPrompt({
            chunkText: chunk.text,
            chapterLabel: label,
            knownCharacterNames: buildKnownCharacterNamesForPrompt(
              loaded.characters,
              replay.extracted
            ),
            knownAbilityNames: settings.knownAbilityNames(existingAbilities).slice(0, KNOWN_LIMIT),
            knownLocationNames: settings.knownLocationNames(existingLocations).slice(0, KNOWN_LIMIT),
            knownOrganizationNames: settings
              .knownOrganizationNames(existingOrganizations)
              .slice(0, KNOWN_LIMIT),
            knownWorldNames: settings.knownWorldNames(existingWorld).slice(0, KNOWN_WORLD_LIMIT),
            abilityTerm: settings.currentAbilityTerm() ?? undefined,
            foreignNarrator: workNarrator
              ? foreignNarratorNoteOf(
                  withSceneText(
                    chunk.text,
                    foreignNarrationScenesInChunk(chunk, workNarrator.narrator.firstPerson)
                  ),
                  workNarrator
                )
              : null,
          });
          try {
            const response = await callWithRateLimitWait(
              () =>
                resolved.provider.generate({
                  systemPrompt: BASE_SYSTEM_PROMPT,
                  userPrompt,
                  model: resolved.model,
                  temperature: CHARACTER_EXTRACT_TEMPERATURE,
                  maxOutputTokens: sendOutputTokens,
                  plannedOutputTokens,
                  jsonSchema: CHARACTER_EXTRACT_SCHEMA as unknown as object,
                  disableThinking: true,
                  signal: controller.signal,
                  meta: { feature: "character_extract", workFolder: work.folderPath },
                }),
              rateLimit,
              rateLimitWaitHooks({
                sleep: (ms) => sleepUnlessCancelled(ms, token),
                report: (message) => progress.report({ message }),
                log: logStep,
                position: () => `${position + 1}/${items.length}`,
              })
            );
            if (response.truncated) {
              // 割り直さない（割った断片は保存の道で切り直せない）。失敗として数える
              failed++;
              failureNotes.push(`${label}: 応答が出力上限で切り詰められました（このチャンクは貯めていません）`);
              continue;
            }
            const parsed = parseResult(response.text);
            if (!parsed) {
              failed++;
              failureNotes.push(`${label}: 応答をJSONとして読み取れませんでした`);
              continue;
            }
            const validated = replay.accept(parsed, chunk);
            stashed.push({
              chunkId,
              chunkHash: chunk.hash,
              promptVersion: CHARACTER_EXTRACT_VERSION,
              parsed,
              savedAt: new Date().toISOString(),
            });
            findings.push({
              chunkId,
              filePath: relative,
              chapter: chunk.chapterStart ?? null,
              accepted: validated.accepted.map((person) => person.data.name),
              rejected: validated.rejected.length,
            });
          } catch (error) {
            if (error instanceof AIError && error.kind === "aborted" && token.isCancellationRequested) {
              cancelled = true;
              break;
            }
            failed++;
            // **種別ごとに次の操作を1つ**（規則5）。本文はログへ（`AIError` が持つ）
            failureNotes.push(
              error instanceof AIError
                ? `${label}: ${error.message} ${recoveryForAIError(error)}`
                : `${label}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      } finally {
        listener.dispose();
      }
    }
  );

  /*
    **作者が途中で止めたら貯めない。** 止めた回の答えが、頼んだ側の
    `novel.extract.commit` で資料になるのは作者の意図と食い違う
  */
  if (!cancelled && stashed.length > 0) {
    // 貯め場所はこの回のあいだに MCP が書いたかもしれないので、読み直してから足す
    const latest = await readStash(stashFile);
    if (!latest) {
      return {
        ok: false,
        reason:
          "抽出の途中で貯め場所（.aiwriter/cache/external-extract.json）の形が変わったため、答えを貯めませんでした。",
        nextAction: "中身を確かめてから頼み直してください",
      };
    }
    try {
      await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(stashFile)));
      /*
        **上書きの経路（指定なし）で置き換える**（`atomicWrite.ts` の経路①）。ここは
        `cache/` の下の作り直せる控えで、原稿でも台帳でもない。前に貯めた分は
        読み直して残してある（同じ chunkId だけ差し替える）
      */
      await atomicWriteFile(
        stashFile,
        new TextEncoder().encode(formatExtractStash(withStashEntries(latest, stashed)))
      );
    } catch (error) {
      logFailure("外部AIからの依頼の抽出: 貯め場所へ書けませんでした", {
        詳細: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        reason: `抽出の答えを貯められませんでした（${error instanceof Error ? error.message : String(error)}）。`,
      };
    }
  }

  const collected = settings.candidates();
  return {
    ok: true,
    promptVersion: CHARACTER_EXTRACT_VERSION,
    findings,
    dropped: {
      count: replay.rejected.length + collected.rejected.length,
      notes: [
        `検算で落とした人物 ${replay.rejected.length}件`,
        `検算で落とした能力・場所・組織・世界観・決まり ${collected.rejected.length}件`,
        `集めた候補：能力 ${collected.abilities.length}・場所 ${collected.locations.length}・` +
          `組織 ${collected.organizations.length}・世界観 ${collected.worldItems.length}` +
          "（保存の前の数。既にある記録との突き合わせは novel.extract.commit が行う）",
      ],
    },
    failures: {
      count: failed + conflicted.length,
      notes: [
        ...failureNotes,
        ...(conflicted.length > 0 ? [`未解決の競合で読まなかった話：${conflicted.join("・")}`] : []),
      ],
    },
    cancelled,
  };
}

/** そのチャンクが何話か（MCP の `chapterLabelOf` と同じ形） */
function chapterLabelOf(chunk: Chunk): string {
  const start = chunk.chapterStart;
  const end = chunk.chapterEnd;
  if (start === null) return "話数不明";
  if (end === null || end === start) return `第${start}話`;
  return `第${start}〜${end}話`;
}

function sleepUnlessCancelled(ms: number, token: vscode.CancellationToken): Promise<boolean> {
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
