import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { AIRegistry } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import { AtomicWriteFileError, atomicWriteFile } from "../core/atomicWrite";
import { sha256Text } from "../core/hash";
import { isWebRuntime } from "../core/runtime";
import { scanWork } from "../core/scanner";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { isToolAllowed } from "../core/externalAccessPermission";
import { ExternalAccessPermissionStore } from "../core/externalAccessPermissionStore";
import {
  RUN_REQUEST_DIRECTORY,
  RUN_REQUEST_TOOL,
  formatRunState,
  parseRunState,
  parseRunTicket,
  runIdOfFileName,
  runStateFileName,
  runTicketFileName,
  type RunFeatureDef,
  type RunStateRecord,
} from "../core/runRequest";
import {
  episodeBodyLabel,
  loadEpisodeBodies,
  needsSubtitle,
} from "../core/episodeBodies";
import { SynopsisStore } from "../core/synopsisStore";
import type { ChapterSynopsisSet } from "../models/synopsis";
import { parseSynopsisResult, validateSynopsisResult } from "../core/synopsisValidation";
import {
  SYNOPSIS_SCHEMA,
  SYNOPSIS_SYSTEM_PROMPT,
  SYNOPSIS_TEMPERATURE,
  buildSynopsisPrompt,
  synopsisPromptVersion,
} from "../prompts/synopsis";
import { CharacterStore } from "../core/characterStore";
import { ReaderTargetStore } from "../core/readerTargetStore";
import { readerTypeCacheMark } from "../core/readerTarget";
import type { ReaderProfile } from "../models/readerProfile";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import { TYPO_CHECK_VERSION } from "../prompts/typoCheck";
import { PROOFREAD_VERSION } from "../prompts/proofread";
import { CONTRADICTION_CHECK_VERSION } from "../prompts/contradictionCheck";
import { CONTRADICTION_VERIFY_VERSION } from "../prompts/contradictionVerify";
import { FORESHADOW_DETECT_VERSION } from "../prompts/foreshadowDetect";
import { DEVIATION_CHECK_VERSION } from "../prompts/deviationCheck";
import { checkTypos } from "./checkTypos";
import { checkProofread } from "./checkProofread";
import { checkContradictions } from "./checkContradictions";
import { checkForeshadows } from "./checkForeshadows";
import { checkDeviations } from "./checkDeviations";
import { confirmProviderReachable } from "./aiConnectivity";
import { withAiTurnProgress } from "./aiTurn";
import { globalStorageRoot } from "./globalStoragePath";
import type {
  RunMeasure,
  RunOutcome,
  RunRequestHandlerDeps,
} from "./runRequestHandler";

/**
 * 外部AIから頼まれた実行の、VS Code 側の手足（設計書6.87.22）。
 *
 * 受け口の判断（`runRequestHandler.ts`）は VS Code を知らない。ここが保管庫・
 * 登録簿・許可の印・AIの割当・各機能の「結果を返すだけの実行口」をつなぐ。
 *
 * ## 結果を返すだけの実行口
 *
 * **既存のコマンドは叩かない。** コマンドは結果を提案パネルへ出し、「検知した」の
 * 記録（前回から書いた分の絞り込み）を付ける——外から頼まれた実行でそれをすると、
 * 作者の画面と記録が作者の知らないうちに動く。
 *
 * 代わりに**各機能の中身（`checkTypos` など）を直に呼ぶ**。中身は結果を返すだけで、
 * 画面へ出すのはコマンドの仕事である。**まとめ実行（設計書6.80）と同じ印**
 * （`suiteConfirmed`）を渡して、機能ごとの「続けますか」を飛ばす——量と料金の
 * 確認は受け口のモーダルが1回だけ取ってある。**札（6.76）は各機能が自分で取る**
 * （`suiteHoldsRun` は渡さない）ので、ほかの一括処理とは重ならない。
 * 送信の関所（`MeteredProvider`）と手元のAIの順番待ち（6.76.1）は、
 * 割当（`AIRegistry.resolve`）が返すプロバイダが必ず通す。
 *
 * **検算は各機能の中にある。** ここで写すと、製品と違う検算を通した結果を
 * 「製品の結果」として返すことになる（CLAUDE.md の「繰り返し起きた失敗」5）。
 *
 * **各話あらすじだけは中身が保存まで抱えている**（`generateSynopses` はあらすじの
 * 台帳を書き、ファイル名の変更も勧める）ので、生成と検算だけを行う口をここに持つ。
 */

export interface RunRequestDepsInput {
  context: vscode.ExtensionContext;
  findWork(folder: string): WorkEntry | undefined;
  aiRegistry: AIRegistry;
  log(line: string): void;
}

export function createRunRequestDeps(
  input: RunRequestDepsInput
): RunRequestHandlerDeps<WorkEntry> {
  const directory = (): string =>
    path.join(globalStorageRoot(input.context), RUN_REQUEST_DIRECTORY);
  const fileOf = (name: string): string => path.join(directory(), name);

  return {
    isWeb: isWebRuntime,
    now: () => Date.now(),
    hash: sha256Text,
    readTicket: async (id) => {
      const text = await readText(fileOf(runTicketFileName(id)));
      return text === undefined ? undefined : parseRunTicket(text);
    },
    claim: async (state) => {
      await vscode.workspace.fs.createDirectory(path.toUri(directory()));
      try {
        // **新しく作るだけ**（`mode: "create"`）。既にあれば＝もう誰かが受けた
        await atomicWriteFile(fileOf(runStateFileName(state.id)), encode(state), {
          mode: "create",
        });
        return true;
      } catch (error) {
        if (error instanceof AtomicWriteFileError && error.kind === "path_conflict") {
          return false;
        }
        throw error;
      }
    },
    writeState: async (state) => {
      /*
        **保管庫の中の、拡張機能だけが書くファイル**なので、上書きの経路（指定なし）で
        置き換える。作者の原稿でも台帳でもない（`atomicWrite.ts` の経路①）
      */
      await atomicWriteFile(fileOf(runStateFileName(state.id)), encode(state));
    },
    listStates: async () => {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(path.toUri(directory()));
      } catch {
        return [];
      }
      const states: RunStateRecord[] = [];
      for (const [name] of entries) {
        if (runIdOfFileName(name)?.kind !== "state") continue;
        const text = await readText(fileOf(name));
        const parsed = text === undefined ? undefined : parseRunState(text);
        if (parsed) states.push(parsed);
      }
      return states;
    },
    findWork: input.findWork,
    isAllowed: async (work, client) =>
      isToolAllowed(await new ExternalAccessPermissionStore(work).load(), client, RUN_REQUEST_TOOL),
    resolveAi: (def) => {
      const resolved = input.aiRegistry.resolve(def.assigned);
      if (!resolved) return undefined;
      return {
        providerId: resolved.provider.id,
        providerName: resolved.provider.displayName,
        model: resolved.model,
        paid: resolved.provider.isPaid,
      };
    },
    measure: (work, file) => measureTarget(work, file),
    confirm: async (message, detail) =>
      (await vscode.window.showWarningMessage(
        message,
        { modal: true, detail },
        "走らせる"
      )) === "走らせる",
    run: (def, work, filePaths) => runFeature(def, work, input.aiRegistry, filePaths),
    describeFailure: (error) => {
      if (error instanceof AIError) {
        return {
          reason: error.message,
          errorKind: error.kind,
          // **種別ごとに次の操作を1つ**（規則5）。サービス名は決め打ちしない
          nextAction: recoveryForAIError(error),
        };
      }
      return { reason: error instanceof Error ? error.message : String(error) };
    },
    warn: (message) => void vscode.window.showWarningMessage(message),
    info: (message) => void vscode.window.showInformationMessage(message),
    log: input.log,
  };
}

function encode(state: RunStateRecord): Uint8Array {
  return new TextEncoder().encode(formatRunState(state));
}

async function readText(filePath: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(path.toUri(filePath)));
  } catch {
    return undefined;
  }
}

/**
 * 送る量を見積もる。**走査（`scanWork`）が数えた字数をそのまま使う**
 * （独自に数えると、確認に出す量と実際が食い違う）。
 */
async function measureTarget(work: WorkEntry, file: string | undefined): Promise<RunMeasure> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    return { ok: false, reason: "本文ファイルが見つかりません。" };
  }
  if (file === undefined) {
    const usable = scan.episodes.filter((episode) => !episode.hasConflictMarkers);
    return {
      ok: true,
      bodyChars: usable.reduce((total, episode) => total + episode.counts.gross, 0),
      episodeCount: usable.length,
      // 作品全体は「絞らない」で渡す（各機能の既定の範囲と同じにする）
      filePaths: [],
      targetLabel: `作品全体（${usable.length}話）`,
    };
  }
  const wanted = path.join(work.folderPath, file);
  const episode = scan.episodes.find((candidate) => path.isSamePath(candidate.filePath, wanted));
  if (!episode) {
    return {
      ok: false,
      reason: `指定された話が見つかりません（${file.slice(0, 80)}）。`,
      nextAction: "novel.scan の filePath を渡してください",
    };
  }
  if (episode.hasConflictMarkers) {
    // **競合マーカーのあるファイルはAIに掛けない**（規則1）
    return {
      ok: false,
      reason: `${episode.fileName} には未解決の競合があります。`,
      nextAction: "競合を解決してから頼んでください",
    };
  }
  return {
    ok: true,
    bodyChars: episode.counts.gross,
    episodeCount: 1,
    filePaths: [episode.filePath],
    targetLabel: episode.fileName,
  };
}

/** 機能ごとの実行口。**白名簿に無い機能はここに来ない**（受け口が先に断る） */
async function runFeature(
  def: RunFeatureDef,
  work: WorkEntry,
  registry: AIRegistry,
  filePaths: string[]
): Promise<RunOutcome> {
  // 作品全体なら絞らない（空の配列を渡すと「1話も無い」になる）
  const scope = filePaths.length > 0 ? { filePaths } : {};
  const notStarted: RunOutcome = {
    ok: false,
    reason:
      `${def.label}を始められませんでした（AIが未設定・繋がらない・作者が途中の確認で止めた、など）。` +
      "理由は作者の画面と作品のログに出ています。",
    nextAction: "作者の画面の知らせを確かめてもらってください",
  };

  switch (def.feature) {
    case "typo": {
      const result = await checkTypos(work, registry, { ...scope, suiteConfirmed: true });
      if (!result) return notStarted;
      return {
        ok: true,
        promptVersion: TYPO_CHECK_VERSION,
        findings: result.issues.map((issue) => toFinding(issue, work)),
        dropped: {
          count: result.rejectedCount + result.alreadyAppliedCount,
          notes: [
            `本文と合わない・行を戻せない指摘 ${result.rejectedCount}件`,
            `前回適用済みの直しと同じ ${result.alreadyAppliedCount}件`,
          ],
        },
        failures: {
          count: result.failedChunks,
          notes: failureNotes(result.failedChunks, result.totalChunks, result.timedOutChunks),
        },
        cancelled: result.cancelled,
      };
    }
    case "proofread": {
      const result = await checkProofread(work, registry, { ...scope, suiteConfirmed: true });
      if (!result) return notStarted;
      return {
        ok: true,
        promptVersion: PROOFREAD_VERSION,
        findings: result.issues.map((issue) => toFinding(issue, work)),
        dropped: {
          count: result.rejectedCount + result.overBudgetCount + result.monotonyDroppedCount,
          notes: [
            `本文に無い原文・上限超過など ${result.rejectedCount}件`,
            `件数の上限で切った ${result.overBudgetCount}件`,
            `語尾単調で数え直すと届かなかった ${result.monotonyDroppedCount}件`,
            `同じ連続を指していたのでまとめた ${result.monotonyMergedCount}件`,
          ],
        },
        failures: { count: result.failedChunks, notes: failureNotes(result.failedChunks) },
        cancelled: result.cancelled,
      };
    }
    case "contradiction": {
      let missing: string | undefined;
      const result = await checkContradictions(work, registry, {
        ...scope,
        // **分けて読む**（まとめ実行と同じ。まるごと読むのは作者が画面で選んだときだけ）
        readMode: "chunked",
        suiteConfirmed: true,
        noteMissing: (note, reason) => {
          missing = reason ? `${reason}。${note}` : note;
        },
      });
      if (missing) return { ok: false, reason: missing };
      if (!result) return notStarted;
      return {
        ok: true,
        promptVersion: `${CONTRADICTION_CHECK_VERSION}|verify:${CONTRADICTION_VERIFY_VERSION}`,
        findings: result.issues.map((issue) => toFinding(issue, work)),
        dropped: {
          count: result.rejectedCount,
          notes: [
            `本文に無い引用など ${result.rejectedCount}件`,
            // 口調を照らさなかった断り（P-12 1.9）も、突き合わせなかった人物と
            // 同じ並びに出す——外部AIが「口調は合っていた」と読まないように
            ...[result.verifyNote, result.missedNote, result.speechNote].filter(Boolean),
          ],
        },
        failures: {
          count: result.failedChunks + result.unreadableEpisodes,
          notes: [
            ...failureNotes(result.failedChunks),
            ...(result.unreadableEpisodes > 0
              ? [`本文を読めなかった話 ${result.unreadableEpisodes}話`]
              : []),
          ],
        },
        cancelled: result.cancelled,
      };
    }
    case "foreshadow": {
      const result = await checkForeshadows(work, registry, { ...scope, suiteConfirmed: true });
      if (!result) return notStarted;
      return {
        ok: true,
        promptVersion: FORESHADOW_DETECT_VERSION,
        findings: result.candidates.map((candidate) => toFinding(candidate, work)),
        dropped: {
          count: result.rejectedCount + result.duplicateCount,
          notes: [
            `本文と合わない候補 ${result.rejectedCount}件`,
            `既に台帳にある ${result.duplicateCount}件`,
          ],
        },
        failures: {
          count: result.failedChunks + result.unreadableEpisodes,
          notes: [
            ...failureNotes(result.failedChunks),
            ...(result.unreadableEpisodes > 0
              ? [`本文を読めなかった話 ${result.unreadableEpisodes}話`]
              : []),
          ],
        },
        cancelled: result.cancelled,
      };
    }
    case "deviation": {
      let missing: string | undefined;
      const result = await checkDeviations(work, registry, {
        ...scope,
        suiteConfirmed: true,
        noteMissing: (note, reason) => {
          missing = reason ? `${reason}。${note}` : note;
        },
      });
      if (missing) return { ok: false, reason: missing };
      if (!result) return notStarted;
      return {
        ok: true,
        promptVersion: DEVIATION_CHECK_VERSION,
        findings: result.issues.map((issue) => toFinding(issue, work)),
        dropped: {
          count: result.rejectedCount + result.ungroundedCount,
          notes: [
            `本文と合わない指摘 ${result.rejectedCount}件`,
            `照らした先がプロットに無かった ${result.ungroundedCount}件`,
            ...(result.plotTrimmedNote ? [result.plotTrimmedNote] : []),
          ],
        },
        failures: {
          count: result.failedChunks + result.unreadableEpisodes,
          notes: [
            ...failureNotes(result.failedChunks),
            ...(result.unreadableEpisodes > 0
              ? [`本文を読めなかった話 ${result.unreadableEpisodes}話`]
              : []),
          ],
        },
        cancelled: result.cancelled,
      };
    }
    case "synopsis":
      return runSynopses(work, registry, filePaths);
  }
}

function failureNotes(failed: number, total?: number, timedOut?: number): string[] {
  if (failed === 0) return [];
  const notes = [
    total !== undefined
      ? `${total}チャンク中 ${failed}件を送れませんでした（未検査）`
      : `${failed}チャンクを送れませんでした（未検査）`,
  ];
  if (timedOut) notes.push(`うち時間切れ ${timedOut}件`);
  notes.push("理由は作品のログにあります。");
  return notes;
}

/**
 * 指摘を、保管庫へ書く形にする。**ファイルは作品フォルダーからの相対パス**
 * （`novel.scan` と同じ指し方。頼んだ側がそのまま話を引ける）。キャッシュの鍵
 * （`chunkHash`）は頼んだ側に意味が無いので落とす。
 */
function toFinding(issue: object, work: WorkEntry): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(issue as Record<string, unknown>) };
  delete copy.chunkHash;
  if (typeof copy.filePath === "string" && path.isAbsolute(copy.filePath)) {
    copy.filePath = path.relative(work.folderPath, copy.filePath);
  }
  return copy;
}

/** 直前の話のあらすじを何件まで文脈として渡すか（`generateSynopses.ts` と同じ） */
const PREVIOUS_SYNOPSES_LIMIT = 3;

/**
 * 各話あらすじを**生成と検算だけ**行う（台帳へ書かない・ファイル名を変えない）。
 *
 * 組み立て（プロンプト・温度・出力の上限・スキーマ）は `generateSynopses.ts` と
 * 同じ部品を使う。**違うのは保存しないことと、作者が書いたあらすじ・変わって
 * いない話を飛ばさないこと**——頼まれたのは「いまの本文から作るとどうなるか」で、
 * 台帳の更新ではない。
 */
async function runSynopses(
  work: WorkEntry,
  registry: AIRegistry,
  filePaths: string[]
): Promise<RunOutcome> {
  const resolved = registry.resolve("generate");
  if (!resolved) {
    return {
      ok: false,
      reason: "あらすじに使うAIがまだ設定されていません。",
      nextAction: "AI設定（または機能別AI割当）で使うAIを選んでください",
    };
  }
  const scan = await scanWork(work);
  const episodes =
    filePaths.length > 0
      ? scan.episodes.filter((episode) =>
          filePaths.some((filePath) => path.isSamePath(filePath, episode.filePath))
        )
      : scan.episodes;
  const loaded = await loadEpisodeBodies(episodes);
  if (loaded.bodies.length === 0) {
    return { ok: false, reason: "あらすじを作れる本文がありません（競合のある話は除きます）。" };
  }
  if (!(await confirmProviderReachable(resolved.provider, "各話あらすじの作成", resolved.model))) {
    return {
      ok: false,
      reason: "AIに繋がりませんでした。",
      nextAction: "AIを起動し、接続先設定を確認してください",
    };
  }

  // **読むだけ。** 壊れた台帳を直さない（規則2）——読めなければ前話の文脈なしで作る
  let set: ChapterSynopsisSet | undefined;
  try {
    set = await new SynopsisStore(work).load();
  } catch (error) {
    logFailure("外部AIからの依頼のあらすじ: 台帳を読めませんでした（前話の文脈なしで作ります）", {
      詳細: error instanceof Error ? error.message : String(error),
    });
  }
  let readerProfile: ReaderProfile | undefined;
  try {
    readerProfile = await new ReaderTargetStore(work).load();
  } catch {
    readerProfile = undefined;
  }
  const characterNames = (await new CharacterStore(work).loadAll()).characters
    .filter((character) => !character.isMob)
    .map((character) => character.name);
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    resolved.provider.id,
    resolved.model,
    "synopsis"
  );
  const sendOutputTokens = resolveOutputTokensForSend(
    resolved.provider.id,
    resolved.model,
    "synopsis"
  );

  const findings: Record<string, unknown>[] = [];
  const failureNotesList: string[] = [];
  let failed = 0;
  let rejectedSubtitles = 0;
  let cancelled = false;
  useLogFile(work.folderPath);
  logStep(
    `外部AIからの依頼で各話あらすじを作ります（保存しません）: ${work.title} / ` +
      `${resolved.provider.displayName} / ${resolved.model} / ${loaded.bodies.length}話`
  );

  // **ほかの一括処理と重ならないよう、実行の札を取る**（設計書6.76）
  await withAiTurnProgress(
    "外部AIからの依頼：あらすじを作っています",
    { label: "各話あらすじの生成（外部AIからの依頼）", onCancelled: () => (cancelled = true) },
    async (progress, token) => {
      let done = 0;
      for (const episode of loaded.bodies) {
        if (token.isCancellationRequested) {
          cancelled = true;
          break;
        }
        progress.report({
          message: `${done + 1}/${loaded.bodies.length} ${episodeBodyLabel(episode)}`,
        });
        const controller = new AbortController();
        const listener = token.onCancellationRequested(() => controller.abort());
        const label = episodeBodyLabel(episode);
        try {
          const response = await resolved.provider.generate({
            systemPrompt: SYNOPSIS_SYSTEM_PROMPT,
            userPrompt: buildSynopsisPrompt({
              chapterLabel: label,
              chapterText: episode.body,
              previousSynopses: previousSynopses(set, episode.chapter),
              characterNames: characterNames.slice(0, 100),
              needsSubtitle: needsSubtitle(episode),
              readerProfile,
            }),
            model: resolved.model,
            temperature: SYNOPSIS_TEMPERATURE,
            maxOutputTokens: sendOutputTokens,
            plannedOutputTokens,
            jsonSchema: SYNOPSIS_SCHEMA as unknown as object,
            disableThinking: true,
            signal: controller.signal,
            meta: { feature: "synopsis", workFolder: work.folderPath },
          });
          const parsed = parseSynopsisResult(response.text);
          const validated = parsed ? validateSynopsisResult(parsed) : undefined;
          if (!validated || !validated.synopsis) {
            failed++;
            failureNotesList.push(
              `${label}: ${
                !parsed
                  ? response.truncated
                    ? "応答が出力上限で切り詰められました"
                    : "応答を読み取れませんでした"
                  : "あらすじが空でした"
              }`
            );
            continue;
          }
          rejectedSubtitles += validated.rejectedSubtitles.length;
          findings.push({
            filePath: path.relative(work.folderPath, episode.file.filePath),
            chapter: episode.chapter,
            title: episode.title,
            synopsis: validated.synopsis,
            emotion: validated.emotion,
            ...(needsSubtitle(episode) ? { subtitles: validated.subtitles } : {}),
          });
        } catch (error) {
          if (error instanceof AIError && error.kind === "aborted" && token.isCancellationRequested) {
            cancelled = true;
            break;
          }
          failed++;
          // **種別ごとに次の操作を1つ**（規則5）
          failureNotesList.push(
            error instanceof AIError
              ? `${label}: ${error.message} ${recoveryForAIError(error)}`
              : `${label}: ${error instanceof Error ? error.message : String(error)}`
          );
        } finally {
          listener.dispose();
          done++;
        }
      }
    }
  );

  return {
    ok: true,
    promptVersion: synopsisPromptVersion({
      needsSubtitle: false,
      readerTypeMark: readerTypeCacheMark(readerProfile),
    }),
    findings,
    dropped: {
      count: rejectedSubtitles,
      notes: [`字数や形の合わないサブタイトル案 ${rejectedSubtitles}件`],
    },
    failures: { count: failed, notes: failureNotesList },
    cancelled,
  };
}

function previousSynopses(
  set: ChapterSynopsisSet | undefined,
  chapter: number | null
): string[] {
  if (!set || chapter === null) return [];
  return set.episodes
    .filter((item) => item.chapter !== null && item.chapter < chapter)
    .slice(-PREVIOUS_SYNOPSES_LIMIT)
    .map((item) => `第${item.chapter}話: ${item.synopsis}`);
}

