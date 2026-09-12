import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { StoryFact } from "../models/storyFact";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  AIError,
  isFatalProviderFailure,
  recoveryForAIError,
  type AIProvider,
} from "../ai/types";
import {
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import {
  describeChunkScope,
  locateChunkLine,
  segmentAtLine,
  splitMergedChunk,
  withLineNumbers,
  type Chunk,
} from "../core/chunker";
import { ChunkCache } from "../core/chunkCache";
import { measureParts } from "../core/usageLog";
import { resolveModelInfoOrWarn } from "./chunkSettings";
import { collectManuscriptChunks } from "./manuscriptChunks";
import { isContextOverflow, retryOnOverflow } from "./chunkRetry";
import { CharacterStore } from "../core/characterStore";
import { readTextFile } from "../core/textFile";
import { factsFromCharacters } from "../core/factsFromRecords";
import {
  filterAllowed,
  findContradictionCandidates,
  type ContradictionCandidate,
} from "../core/contradictionMatch";
import {
  describeStoryFactRejections,
  validateStoryFactResult,
  type StoryFactRejection,
} from "../core/storyFactValidation";
import {
  buildFactVerifyIssue,
  buildKnownCharacterTable,
  describeCandidateTypes,
  describeFactRun,
  factExtractCacheKey,
  linesAround,
} from "../core/factContradiction";
import {
  buildStoryFactExtractPrompt,
  STORY_FACT_EXTRACT_SCHEMA,
  STORY_FACT_EXTRACT_SYSTEM_PROMPT,
  STORY_FACT_EXTRACT_VERSION,
} from "../prompts/storyFactExtract";
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
import { withCancellableProgress, type CheckProgress } from "../views/progress";
import type { SuiteAwareOptions } from "../core/proofreadingSuite";
import { withAiTurn } from "./aiTurn";
import { confirmProviderReachable } from "./aiConnectivity";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  useLogFile,
} from "../core/logger";

/**
 * 矛盾検知（事実の照合）——機械照合層の第4段（設計書6.88）。
 *
 * ## P-12 と何が違うのか
 *
 * P-12（`checkContradictions.ts`）は、本文と設定資料を丸ごとAIに見せて
 * 「食い違いを挙げよ」と頼む。**精度がモデルの賢さと指示文の言い回しに
 * 全部かかっている**ため、締めれば見逃し、緩めれば誤検出で、綱引きから
 * 出られない（実測では `gemma4:26b` が仕込んだ矛盾を2件中0件しか拾わなかった）。
 *
 * こちらは綱引きの場所を変える。
 *
 * 1. AIには**事実**だけを抜かせる（P-37。ローカルの小さいモデルで足りる）
 * 2. 食い違いは**機械**が決める（`core/contradictionMatch.ts`。確定的で安い）
 * 3. 絞り込まれた候補2か所だけを、**高精度のモデル**が1件ずつ判定する
 *    （既存の P-12b をそのまま使う。割当キーは `contradiction`）
 *
 * ## P-12 は消さない
 *
 * 作者の裁定で**しばらく並行**させる（6.88.9）。同じ評価セットで両方を
 * 測ってから、切り替えるかを決める。だから提案パネルの分類も別にしてある
 * （`FACT_CONTRADICTION_CATEGORY`）——同じタブへ混ぜると見比べられない。
 *
 * ## 設定資料が無くても走る
 *
 * P-12 は照らし合わせる相手が無いと動かせなかったが、こちらは**事実を
 * 本文から抜く**ので、資料が1件も無くても本文どうしの食い違いは出せる。
 * 資料があれば `factsFromCharacters` で事実に混ぜる（6.88.5の第2段）。
 */

/**
 * 「まとめたせいで入り切らなかった。分けて試し直す」の印。
 *
 * **`undefined`（この本文は飛ばす）と区別する。** 同じ値にすると、
 * 切り詰められたチャンクが黙って捨てられる。
 */
const RETRY_SMALLER = Symbol("retry-smaller");

/**
 * 次のチャンクへ引き継ぐ topic の上限。
 *
 * **際限なく足すと、チャンクが進むほど指示だけが太る。** topic は
 * 「同じ事柄に同じ語を付けさせる」ための助けなので、直近のものが効けばよい。
 */
const TOPIC_CARRY_LIMIT = 60;

/** 検証へ渡す前後の行数（設計書6.88の第4段。作者への指示どおり±5行） */
const VERIFY_CONTEXT_LINES = 5;

/**
 * 提案パネルへ渡す1件。
 *
 * **既存の矛盾の項目と同じ並びにしてある。** パネル側は
 * `ContradictionViewItem` へ写すだけで、描画も操作も使い回せる。
 */
export interface FactContradictionIssue {
  filePath: string;
  /** 元のファイルでの行（1始まり）。まとめたチャンクは戻してある */
  line: number;
  chunkHash: string;
  excerpt: string;
  /** 候補の型（設定・時系列・状態・知識・視点・規則） */
  category: string;
  settingSays: string;
  textSays: string;
  note: string;
  confidence: "high" | "medium" | "low";
}

export interface FactContradictionRunResult {
  issues: FactContradictionIssue[];
  /** 機械が挙げた候補の件数（判定に回した数） */
  candidateCount: number;
  /** 受理した事実（本文から抜いたぶん） */
  acceptedFacts: number;
  /** 検算で弾いた事実 */
  rejectedFacts: number;
  /** 応答を読み取れなかったチャンク数 */
  failedChunks: number;
  /** 本文そのものを読めなかった話の数（ログに詳細） */
  unreadableEpisodes: number;
  cancelled: boolean;
  processedChunks: number;
  /** 検算で弾いた理由の内訳。0件なら空文字 */
  rejectionNote: string;
  /** 判定で取り下げた件数と理由の内訳。0件なら空文字 */
  verifyNote: string;
  /** 候補の型ごとの内訳。0件なら空文字 */
  candidateNote: string;
}

export interface CheckFactContradictionsOptions extends SuiteAwareOptions {
  /** 話を絞る。指定しなければ作品全体 */
  filePaths?: string[];
  /** 本文から事実を抜く段の進み具合の届け先。単位は「チャンク」 */
  onProgress?: CheckProgress;
  /** 候補を1件ずつ判定する段の進み具合の届け先。単位は「件」 */
  onVerifyProgress?: CheckProgress;
}

export async function checkFactContradictions(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckFactContradictionsOptions = {}
): Promise<FactContradictionRunResult | undefined> {
  useLogFile(work.folderPath);

  // **抽出は `factExtract` の割当で動かす**（6.88.9）。定型のJSON化なので
  // ローカルの小さいモデルで足り、判定（`contradiction`）とは分けて選べる
  const resolved = await ensureConfigured(registry, "factExtract");
  if (!resolved) return undefined;

  // **モデルの情報を先に1回だけ引く。** チャンクの大きさはここから決まる。
  // 取れなければ止める（黙って既定値へ落ちると、キャッシュが全滅する）
  const info = await resolveModelInfoOrWarn({
    registry,
    feature: "factExtract",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "矛盾検知（事実の照合）",
  });
  if (!info) return undefined;

  const provider = resolved.provider;
  const model = resolved.model;

  // **設定資料が無くても走る。** 読めなかったら空で続ける——事実は本文から
  // 抜けるので、資料は「あれば混ぜる」材料にすぎない
  const characters = await loadCharacters(work);
  const table = buildKnownCharacterTable(characters);
  /**
   * 既にある人物レコードから組んだ事実（設計書6.88.5の第2段）。
   *
   * **1回だけ組む。** 照合と完了報告の両方が数を要るので、2度組むと
   * 「照合に使った数」と「報告した数」が静かに食い違う余地ができる。
   */
  const recordFacts = factsFromCharacters(characters);

  // **本文を空にしてプロンプトを組み、その字数を固定費とする。**
  // 見込みの定数を置くと、プロンプトの改訂に置いていかれて必ず追い越される
  const overheadChars =
    STORY_FACT_EXTRACT_SYSTEM_PROMPT.length +
    buildStoryFactExtractPrompt({
      chunkText: "",
      chapterLabel: "",
      chapterNumber: null,
      knownCharacters: table.entries,
      knownTopics: [],
    }).length;

  // **応答の見込みに実測を使う**（設計書6.65.16の2）
  const outputTuning = { providerId: provider.id, model };
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    outputTuning.providerId,
    outputTuning.model
  );
  // **場所の確保（上）と、実際に送る上限（下）は別物である**（設計書6.77）
  const sendOutputTokens = resolveOutputTokensForSend(
    outputTuning.providerId,
    outputTuning.model
  );

  const tasks = await collectManuscriptChunks({
    work,
    info,
    options,
    fixedCost: { overheadChars, outputTokens: plannedOutputTokens },
    outputTuning,
    logLabel: "矛盾検知（事実の照合）",
  });
  const { chunks, chapterLabelByFile, chapterByFile, chunkNote } = tasks;
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("検知できる本文がありませんでした。");
    return undefined;
  }

  const cache = new ChunkCache(work);
  await cache.load();
  // **既知の topic は鍵に入れない**（`factExtractCacheKey` のコメント）
  const extractKeyBase = factExtractCacheKey({ providerId: provider.id, model });
  // 判定は別のプロンプトなので、版も別に持つ
  const verifyKeyBase = {
    feature: "fact_contradiction_verify",
    promptVersion: CONTRADICTION_VERIFY_VERSION,
    providerId: provider.id,
    model,
  };

  const pending = chunks.filter((chunk) => !cache.get(chunk.hash, extractKeyBase));
  if (pending.length > 0) {
    // **モデル名を渡す。** LM Studioをこの場から起こしたとき、
    // 起こした直後に読み込ませるために要る（`aiConnectivity.ts`）
    if (
      !(await confirmProviderReachable(
        provider,
        "矛盾検知（事実の照合）",
        model
      ))
    ) {
      return undefined;
    }
    const detail = [
      `${chunks.length}チャンク中 ${pending.length}件から事実を取り出します` +
        `（処理済み ${chunks.length - pending.length}件はスキップ）。`,
      table.entries.length > 0
        ? `人物 ${table.entries.length}人の対応表を渡します。`
        : "人物の登録がまだ無いので、人物は本文の表記のまま扱います。",
      "",
      "AIには「矛盾」ではなく「本文に書いてあること」だけを取り出させ、",
      "食い違いの判定は拡張機能側が機械的に行います。",
      // 確認のダイアログは素のテキストである。Markdownの記号を混ぜると
      // そのまま「**」が見える（`plainTextUi.test.ts`）
      "本文は書き換えません。",
      // 判定だけ別のAIになりうることを黙らない（有料のAIなら料金にも効く）
      "見つかった候補は、矛盾検知に割り当てたAIが1件ずつ確かめます。",
      provider.isPaid
        ? `\n${provider.displayName} はチャンクごとに課金されます。`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (options.suiteConfirmed) {
      // まとめ実行が先に1回だけ確認している（設計書6.80）。
      // **飛ばした中身はログへ残す**
      logStep(`矛盾検知（事実の照合）：まとめ実行のため確認を省略\n${detail}`);
    } else {
      const confirm = await vscode.window.showInformationMessage(
        `${work.title} の事実を取り出して照合します。`,
        { modal: true, detail },
        "実行"
      );
      if (confirm !== "実行") return undefined;
    }
  }

  logStep(
    `矛盾検知（事実の照合）を開始: ${work.title} / ${provider.displayName} / ` +
      `${model} / ${chunks.length}チャンク / ${chunkNote} / ` +
      `v${STORY_FACT_EXTRACT_VERSION}`
  );

  /** 本文から受理した事実 */
  const facts: StoryFact[] = [];
  /**
   * 事実の id → 本文の場所。
   *
   * **`StoryFact` に file を足さない**（設計書6.88.3の形を保つ）。照合器は
   * 本文の場所を知らなくてよく、知らせると「どのファイルか」で条件分岐したく
   * なる。行もここへ持つのは、**まとめたチャンクでは `withLineNumbers` の
   * 番号が元ファイルの行ではない**ため——`locateChunkLine` を通して戻した
   * 値を、判定と提案パネルの両方が使う。
   */
  const factPlaces = new Map<string, { filePath: string; line: number }>();
  /** 既知の topic。走らせながら集めて、次のチャンクへ渡す */
  const knownTopics: string[] = [];
  const rejections: Array<{ reason: StoryFactRejection }> = [];
  /** チャンクの中を指していたのに、元のファイルへ戻せなかった事実 */
  let unlocatable = 0;

  let failedChunks = 0;
  let cancelled = false;
  /** 待っても直らない失敗を掴んだら、残りのチャンクは試さない */
  let fatalFailure = "";
  /**
   * 進み（何チャンク見たか／分母）。**数えるのは、実際にAIへ送ったものだけ**
   * である。キャッシュ命中まで分母に入れると、1件しか動かない実行が
   * 止まったように見える。
   */
  let chunksDone = 0;
  let chunksTotal = pending.length;
  const skippedChunks = chunks.length - pending.length;
  let processedChunks = 0;

  /** 判定を通った候補 */
  const issues: FactContradictionIssue[] = [];
  const verifyRejected: Array<{ reason?: VerifyRejectReason }> = [];
  let verifyUndecided = 0;
  let candidates: ContradictionCandidate[] = [];
  const readSource = createSourceReader();

  // **抽出と判定は、ひと続きの仕事として1つの札で回す**（設計書6.76）。
  // 別の札にすると、あいだに他の一括処理が割り込んでモデルの読み込み直しが
  // 往復する
  await withAiTurn(
    { label: "矛盾の検知（事実の照合）", onCancelled: () => (cancelled = true) },
    async () => {
      await withCancellableProgress(
        "本文から事実を取り出しています",
        async (progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => {
            cancelled = true;
            controller.abort();
          });

          // **まとめたチャンクは、切り詰められたら分けて試し直す**（6.23）。
          // 処理中に増えるので配列で持つ
          const queue = [...chunks];

          for (let cursor = 0; cursor < queue.length; cursor++) {
            if (token.isCancellationRequested) break;
            if (fatalFailure) break;
            const chunk = queue[cursor];

            const cached = cache.get(chunk.hash, extractKeyBase);
            const raw = cached ?? (await ask(chunk, controller));
            if (cached === undefined) {
              chunksDone++;
              progress.report({
                message: `${chunksDone}/${chunksTotal}`,
                increment: 100 / Math.max(chunksTotal, 1),
              });
              options.onProgress?.(chunksDone, chunksTotal, skippedChunks);
            }

            if (raw === RETRY_SMALLER) {
              const parts = splitMergedChunk(chunk);
              if (parts.length > 1) {
                queue.splice(cursor + 1, 0, ...parts);
                chunksTotal += parts.length;
                logStep(
                  `切り詰められたため ${parts.length} 話に分けて試し直します: ${chunk.hash}`
                );
              } else {
                failedChunks++;
              }
              continue;
            }
            // 上限に入らなかった。**まとめたぶんを戻す→半分に割る→諦める**の順
            if (raw instanceof AIError) {
              const retry = retryOnOverflow(chunk, raw);
              if (retry.kind === "split") {
                queue.splice(cursor + 1, 0, ...retry.parts);
                chunksTotal += retry.parts.length;
                logStep(`${chunk.hash}: ${retry.note}`);
              } else {
                failedChunks++;
                logFailure("矛盾検知（事実の照合）", {
                  チャンク: chunk.hash,
                  理由: retry.note,
                });
              }
              continue;
            }
            if (raw === undefined) continue;

            collect(raw, chunk);
            processedChunks++;
          }

          /** 応答を検算して、本文の場所まで確定させる */
          function collect(raw: unknown, chunk: Chunk): void {
            const lineCount = chunk.text.split("\n").length;
            const validated = validateStoryFactResult(raw, {
              chunkLineStart: chunk.startLine + 1,
              chunkLineEnd: chunk.startLine + lineCount,
              chapter: chunk.chapterStart,
              knownCharacterIds: table.ids,
              knownNames: table.names,
            });
            rejections.push(...validated.rejected);

            for (const fact of validated.accepted) {
              // **まとめたチャンクの行番号は、元のファイルへ戻す。**
              // 戻さずに使うと、2話目以降の事実が1話目の行を指す
              const at = locateChunkLine(chunk, fact.lineRange[0]);
              if (!at) {
                // 戻せない行は捨てる。どこの話か決められない。
                // **黙って落とさない**（設計書6.8）
                unlocatable++;
                logStep(
                  `矛盾検知（事実の照合）：行番号 ${fact.lineRange[0]} を元のファイルへ戻せず除外`
                );
                continue;
              }
              const end = locateChunkLine(chunk, fact.lineRange[1]);
              // **話数はチャンクの内訳から引く。** ファイル単位で引くと、
              // 合本（全話が1ファイル）では走査が返す先頭の話数になり、
              // どの話の事実も全部「第1話」になる。内訳が無いときだけ
              // ファイルへ退く。読めなければ null のまま——推測で埋めない
              const chapter =
                segmentAtLine(chunk, fact.lineRange[0])?.chapterStart ??
                chapterByFile.get(at.filePath) ??
                null;
              facts.push({
                ...fact,
                chapter,
                lineRange: [at.line, end?.line ?? at.line],
              });
              factPlaces.set(fact.id, { filePath: at.filePath, line: at.line });
              if (fact.topic && !knownTopics.includes(fact.topic)) {
                knownTopics.push(fact.topic);
              }
            }
          }

          async function ask(
            chunk: Chunk,
            controller: AbortController
          ): Promise<unknown | undefined> {
            try {
              const bodyWithLines = withLineNumbers(chunk);
              const userPrompt = buildStoryFactExtractPrompt({
                chunkText: bodyWithLines,
                // **まとめたチャンクは、話が1つとは限らない**（設計書6.23）
                chapterLabel: describeChunkScope(chunk, (filePath) =>
                  chapterLabelByFile.get(filePath)
                ),
                chapterNumber: chunk.chapterStart,
                knownCharacters: table.entries,
                // 直近のものだけを渡す（指示だけが太らないように）
                knownTopics: knownTopics.slice(-TOPIC_CARRY_LIMIT),
              });

              const response = await provider.generate({
                systemPrompt: STORY_FACT_EXTRACT_SYSTEM_PROMPT,
                userPrompt,
                model,
                // 事実の書き写しなので揺らさない
                temperature: 0.0,
                maxOutputTokens: sendOutputTokens,
                plannedOutputTokens,
                jsonSchema: STORY_FACT_EXTRACT_SCHEMA as unknown as object,
                disableThinking: true,
                signal: controller.signal,
                meta: {
                  feature: "story_fact_extract",
                  workFolder: work.folderPath,
                  parts: measureParts(userPrompt, {
                    本文: bodyWithLines.length,
                    人物: table.entries.length,
                    topic: knownTopics.length,
                  }),
                },
              });

              if (response.truncated || !response.text.trim()) {
                // まとめたせいで入り切らなかったのなら、元の大きさなら通る
                // 見込みがある。**捨てるより試すほうがよい**
                logFailure("矛盾検知（事実の照合）", {
                  チャンク: chunk.hash,
                  理由: "応答が上限で切り詰められました",
                });
                return RETRY_SMALLER;
              }

              const parsed = parseJsonObject(response.text);
              if (!parsed) {
                failedChunks++;
                logFailure("矛盾検知（事実の照合）", {
                  チャンク: chunk.hash,
                  理由: "応答を読み取れません",
                  応答: responseExcerptForLog(response.text),
                });
                return undefined;
              }
              await cache.set(chunk.hash, extractKeyBase, parsed);
              return parsed;
            } catch (error) {
              if (error instanceof AIError && error.kind === "aborted") {
                return undefined;
              }
              // **入らなかったときは、失敗として数える前に分け直しへ回す**
              if (isContextOverflow(error)) return error;
              // **同じ失敗を積まない。** 環境側の失敗はどのチャンクでも同じ
              if (error instanceof AIError && isFatalProviderFailure(error.kind)) {
                fatalFailure = `${error.message} ${recoveryForAIError(error)}`.trim();
                logStep(`残りのチャンクは試しません: ${fatalFailure}`);
              }
              failedChunks++;
              logFailure("矛盾検知（事実の照合）", {
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
        }
      );

      if (cancelled) return;

      // ── 機械照合（設計書6.88.6。**AIを使わない**）──────────
      //
      // 既にある人物レコードから組んだ事実も混ぜる（6.88.5の第2段）。
      // 遷移・場面は第5段以降で供給するので、いまは空で呼ぶ。
      const allFacts = [...facts, ...recordFacts];
      candidates = filterAllowed(
        findContradictionCandidates({
          facts: allFacts,
          transitions: [],
          scenes: [],
        }),
        // 容認リスト（6.88.8）の保存は第5段。いまは何も抑えない
        []
      );
      const factById = new Map(allFacts.map((fact) => [fact.id, fact]));

      // ── 判定（既存の1件ずつの検証。設計書6.10.5）──────────
      //
      // **候補が0件ならAIを呼ばない。** 呼ぶだけ無駄で、有料のAIなら
      // 料金にもなる。
      if (candidates.length === 0) return;

      // 判定は `contradiction` の割当で動かす（6.88.9。抽出＝ローカルで
      // 足りる／判定＝高精度、と分けられるようにする）
      const verifier = await ensureConfigured(registry, "contradiction");
      if (!verifier) {
        // **候補を消さない。** 判定できなかっただけなので、そのまま出して
        // 「確かめていない」と断る（検証できないことを、指摘を消す理由にしない）
        logStep("矛盾検知（事実の照合）：判定のAIが選べないため、候補をそのまま出します");
        for (const candidate of candidates) {
          const sides = await resolveSides(candidate, factById);
          if (sides) issues.push(toIssue(candidate, sides, undefined));
        }
        verifyUndecided = issues.length;
        return;
      }

      await withCancellableProgress(
        "見つかった候補を確かめています",
        async (progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => {
            cancelled = true;
            controller.abort();
          });

          let done = 0;
          for (const candidate of candidates) {
            if (token.isCancellationRequested) break;
            progress.report({
              message: `${++done}/${candidates.length}`,
              increment: 100 / candidates.length,
            });
            options.onVerifyProgress?.(done, candidates.length);

            const sides = await resolveSides(candidate, factById);
            if (!sides) continue;

            const issue = buildFactVerifyIssue({
              candidate,
              left: sides.left,
              right: sides.right,
              rightLineText: sides.rightLineText,
            });
            const outcome = await verify({
              provider: verifier.provider,
              model: verifier.model,
              chapterLabel:
                chapterLabelByFile.get(sides.place.filePath) ?? "",
              context: sides.context,
              issue,
              // **前側の話数を渡す。** 検証は「まだ明かされていない」を
              // 見分けるのにこれを使う（前側が後の話なら怪しむ）
              knownAt:
                sides.left.chapter !== null ? `第${sides.left.chapter}話` : "",
              fingerprint: candidate.fingerprint,
              controller,
            });

            if (outcome.undecided) verifyUndecided++;
            if (!outcome.keep) {
              verifyRejected.push({ reason: outcome.reason });
              logStep(
                `判定で取り下げ: ${issue.excerpt.slice(0, 20)} ` +
                  `（${outcome.reason}／${outcome.explanation}）`
              );
              continue;
            }

            issues.push(toIssue(candidate, sides, outcome.explanation));
          }
        }
      );
    }
  );

  await cache.save();

  const rejectionNote = describeStoryFactRejections(rejections);
  const verifyNote = describeVerifyResults(verifyRejected, verifyUndecided);
  const candidateNote = describeCandidateTypes(candidates);

  if (unlocatable > 0) {
    logStep(
      `矛盾検知（事実の照合）：元のファイルへ戻せない事実 ${unlocatable}件を除外`
    );
  }
  /*
    **開始したら、必ず終了の1行を残す。** どの工程で減ったのかが分からないと、
    次に直す場所が決まらない——この道は工程が4つある（設計書6.88.1）。
  */
  logStep(
    describeFactRun({
      chunksDone,
      chunksTotal,
      skippedChunks,
      failedChunks,
      acceptedFacts: facts.length,
      recordFacts: recordFacts.length,
      rejectedFacts: rejections.length,
      rejectionNote,
      candidates: candidates.length,
      candidateNote,
      kept: issues.length,
      verifyNote,
      cancelled,
    })
  );

  return {
    issues,
    candidateCount: candidates.length,
    acceptedFacts: facts.length,
    rejectedFacts: rejections.length,
    failedChunks,
    unreadableEpisodes: tasks.unreadableEpisodes,
    cancelled,
    processedChunks,
    rejectionNote,
    verifyNote,
    candidateNote,
  };

  /** 候補の両側と、本文のどこを指すか */
  interface CandidateSides {
    left: StoryFact;
    right: StoryFact;
    /** 作者が飛ぶ先。**後ろ側の事実のもの**（無ければ前側へ落とす） */
    place: { filePath: string; line: number };
    /** 後ろ側の事実が書かれている本文の行。資料由来なら undefined */
    rightLineText?: string;
    /** その行の前後（行番号つき）。本文が読めなければ空文字 */
    context: string;
  }

  /**
   * 候補から、判定と提案パネルが要るものを一度に引く。
   *
   * **判定とパネルで別々に引かない。** 別々に組むと、AIへ見せた引用と
   * 作者の画面に出る引用が食い違い、「AIは何を見て採用したのか」が
   * 追えなくなる。
   */
  async function resolveSides(
    candidate: ContradictionCandidate,
    factById: Map<string, StoryFact>
  ): Promise<CandidateSides | undefined> {
    const left = factById.get(candidate.left);
    const right = factById.get(candidate.right);
    if (!left || !right) return undefined;

    const rightPlace = factPlaces.get(right.id);
    const place = rightPlace ?? factPlaces.get(left.id);
    if (!place) {
      // どちらも資料由来。**本文の飛び先が無い**ので、いまは出せない
      // （資料どうしの食い違いは `conflicts` が既に作者へ回している）
      logStep(
        `矛盾検知（事実の照合）：本文の場所が無い候補を除外（${candidate.fingerprint}）`
      );
      return undefined;
    }

    const source = await readSource(place.filePath);
    return {
      left,
      right,
      place,
      // **前側の行を「後ろ側の引用」にしない。** 後ろ側が資料由来のときは
      // ここが前側の場所になっているので、行の本文は渡さない
      rightLineText: rightPlace ? lineTextOf(source, place.line) : undefined,
      context: source
        ? linesAround(source, place.line, VERIFY_CONTEXT_LINES)
        : "",
    };
  }

  /** 候補を提案パネルの1件に写す */
  function toIssue(
    candidate: ContradictionCandidate,
    sides: CandidateSides,
    explanation: string | undefined
  ): FactContradictionIssue {
    const issue = buildFactVerifyIssue({
      candidate,
      left: sides.left,
      right: sides.right,
      rightLineText: sides.rightLineText,
    });
    return {
      filePath: sides.place.filePath,
      line: sides.place.line,
      // 本文のチャンクを跨いで組んだ候補なので、チャンクの指紋は持てない。
      // 代わりに**容認リストの鍵（6.88.8）**を入れておく——第5段で
      // 「これは意図的」を登録するときに、この値がそのまま鍵になる
      chunkHash: candidate.fingerprint,
      excerpt: issue.excerpt,
      category: issue.category,
      settingSays: issue.settingSays,
      textSays: issue.textSays,
      note: appendNote(issue.note, explanation ?? ""),
      confidence: candidate.confidence,
    };
  }

  /** 1件だけを見て、本当に矛盾かを問い直す（既存の P-12b をそのまま使う） */
  async function verify(input: {
    provider: AIProvider;
    model: string;
    chapterLabel: string;
    context: string;
    issue: ReturnType<typeof buildFactVerifyIssue>;
    knownAt: string;
    fingerprint: string;
    controller: AbortController;
  }): Promise<VerifyOutcome> {
    // 指紋は（型・主語・項目・両側の値）から作るので、同じ食い違いなら
    // 同じ値になる。判定をやり直さずに済む
    const cached = cache.get(input.fingerprint, verifyKeyBase);
    if (cached !== undefined) {
      return parseVerifyOutcome(
        typeof cached === "string" ? cached : JSON.stringify(cached)
      );
    }

    try {
      const response = await input.provider.generate({
        systemPrompt: CONTRADICTION_VERIFY_SYSTEM_PROMPT,
        userPrompt: buildContradictionVerifyPrompt({
          chapterLabel: input.chapterLabel,
          contextWithLineNumbers: input.context,
          excerpt: input.issue.excerpt,
          settingSays: input.issue.settingSays,
          textSays: input.issue.textSays,
          category: input.issue.category,
          settingKnownAt: input.knownAt,
        }),
        model: input.model,
        temperature: 0.0,
        maxOutputTokens: resolveOutputTokensForSend(
          input.provider.id,
          input.model
        ),
        plannedOutputTokens: resolveOutputTokensForPlanning(
          input.provider.id,
          input.model
        ),
        jsonSchema: CONTRADICTION_VERIFY_SCHEMA as unknown as object,
        disableThinking: true,
        signal: input.controller.signal,
        meta: {
          feature: "fact_contradiction_verify",
          workFolder: work.folderPath,
        },
      });

      if (response.truncated || !response.text.trim()) {
        return undecidedOutcome("応答が切り詰められました");
      }
      await cache.set(input.fingerprint, verifyKeyBase, response.text);
      return parseVerifyOutcome(response.text);
    } catch (error) {
      if (error instanceof AIError && error.kind === "aborted") {
        return undecidedOutcome("取りやめました");
      }
      // **判定できなかったら通す。** 通信の失敗で本物の候補を消さない
      logFailure("矛盾の判定（事実の照合）", {
        引用: input.issue.excerpt.slice(0, 40),
        詳細: error instanceof Error ? error.message : String(error),
      });
      return undecidedOutcome("判定できませんでした");
    }
  }
}

/**
 * 人物レコードを読む。
 *
 * **読めなくても止めない。** 資料は「あれば混ぜる」材料で、事実そのものは
 * 本文から抜ける。ここで止めると、資料の壊れた1件で機能ごと使えなくなる。
 */
async function loadCharacters(work: WorkEntry) {
  try {
    const loaded = await new CharacterStore(work).loadAll();
    // モブは資料が薄く、対応表を太らせるだけなので外す（P-12 と揃える）
    return loaded.characters.filter((character) => !character.isMob);
  } catch (error) {
    logFailure("矛盾検知（事実の照合）：人物の読み込み", {
      詳細: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * 本文を1回だけ読む口を作る。判定は同じファイルを何度も引く。
 *
 * **実行のたびに新しく作る。** モジュールに置いたままにすると、作者が
 * 本文を直しても前の実行で読んだ中身を引き続けることになる。
 */
function createSourceReader(): (
  filePath: string
) => Promise<string | undefined> {
  const cache = new Map<string, string | undefined>();
  return async (filePath) => {
    if (cache.has(filePath)) return cache.get(filePath);
    let text: string | undefined;
    try {
      text = (await readTextFile(filePath)).text;
    } catch {
      // 読めなければ前後の文脈なしで判定する（候補ごと捨てるよりよい）
      text = undefined;
    }
    cache.set(filePath, text);
    return text;
  };
}

/** その行の本文。範囲の外なら undefined */
function lineTextOf(text: string | undefined, line: number): string | undefined {
  if (text === undefined) return undefined;
  return text.split("\n")[line - 1];
}

/** 判定で分かったことを、もとの補足へ足す */
function appendNote(note: string, explanation: string): string {
  const extra = explanation.trim();
  if (!extra) return note;
  return note.trim() ? `${note.trim()}（判定: ${extra}）` : `判定: ${extra}`;
}

/** 応答からJSONの本体を取り出す。読めなければ undefined */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

