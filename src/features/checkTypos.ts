import * as vscode from "vscode";
import * as path from "../core/paths";
import { WorkEntry } from "../models/types";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import {
  AIError,
  isConnectivityFailure,
  isFatalProviderFailure,
  type ProviderId,
} from "../ai/types";
import { confirmProviderReachable } from "./aiConnectivity";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { parseCollectedFile } from "../core/collectedFile";
import { blankMemoLines } from "../core/sceneMemo";
import {
  splitIntoChunks,
  withLineNumbers,
  mergeAdjacentChunks,
  splitMergedChunk,
  locateChunkLine,
  Chunk,
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
import { type CheckProgress } from "../views/progress";
import { withAiTurnProgress } from "./aiTurn";
import { logFailure, logStep, useLogFile } from "../core/logger";
import {
  resolveMaxOutputTokens,
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
} from "../ai/outputLimit";
import {
  rateLimitWaitMs,
  describeRateLimitGiveUp,
  type RateLimitWaitState,
} from "./extractCharacters";
import { KeepWordStore } from "../core/keepWordStore";
import {
  buildStyleNote,
  collectWorkStyle,
  readNarrativePerson,
} from "../core/workStyle";
import type { KeepWord } from "../models/keepWord";

/**
 * 誤字脱字検知（P-09）のオーケストレーション。
 *
 * `extractCharacters.ts` の骨格を踏襲する。以前は「チャンクのまとめ送信は
 * 持ち込まない」としていたが、1話ずつでは指示のほうが本文より大きく、
 * 19話で19回ぶん同じ指示を送り直していた（作者の指摘）。まとめて送り、
 * 返ってきた行番号は `locateChunkLine` で元のファイルへ戻す。
 */

export interface TypoCheckIssue extends AcceptedTypoIssue {
  filePath: string;
  chunkHash: string;
}

export interface TypoCheckRunResult {
  issues: TypoCheckIssue[];
  rejectedCount: number;
  failedChunks: number;
  /**
   * 送るはずだったチャンクの総数。
   *
   * **失敗の件数だけでは「どれだけ検査できていないか」が分からない。**
   * 実データで「3件中2件が失敗」した回に、作者へは
   * 「完了しました。指摘 0件 / 失敗 2チャンク」としか出ていなかった
   * ——本文の3分の2が未検査なのに、誤字が無かったように読める（0.28.8）。
   */
  totalChunks: number;
  /**
   * そのうち、時間切れで落ちたチャンクの数。
   *
   * **失敗の総数とは別に数える。** 時間切れだけは作者が直せる
   * ——待ち時間を延ばせばよい——のに、ほかの失敗と混ざっていると
   * 「AIが不調」としか読めない。1件でもあれば、通知から
   * 「AIチューニング」へ誘って秒数を測らせる（設計書6.49）。
   */
  timedOutChunks: number;
  /**
   * この回に使ったAIが有料か。
   *
   * **時間切れの案内で「料金がかかります」と言い切るために要る。**
   * 「AIチューニングを実行しますか」と誘う以上、それが有料の呼び出しなのか
   * 無料なのかは、押す前に分かっていなければならない。
   */
  usedPaidProvider: boolean;
  dismissedCount: number;
  cancelled: boolean;
}

interface FileChunkTask {
  filePath: string;
  chunks: Chunk[];
}

/**
 * まだ切っていない本文の1まとまり（1ファイル、または合本の中の1話）。
 *
 * **切るのは、固定費（指示・辞書・作法）を測ったあと**（設計書6.27.10）。
 * 読むのと切るのを1つのループでやっていたので、字数を決めるのに必要な
 * 材料（辞書・作法）がまだ手元に無い時点で切っていた。
 */
interface SplitSource {
  filePath: string;
  body: string;
  chapterStart: number | null;
  chapterEnd: number | null;
  /** この本文が、元ファイルの何行目から始まるか（0始まり） */
  lineOffset: number;
}

/**
 * 辞書へ載せる固有名詞の件数。
 *
 * **固定費の測定と、実際に送るときで同じ値を使う。** 別々に書くと、
 * 片方を直したときに見込みと実物がずれる（それがこの改修で塞いだ穴である）。
 */
const DICTIONARY_LIMIT = 200;

export interface CheckTyposOptions {
  /**
   * 対象を絞り込むファイルパス。指定すると、そのファイルだけを検知する
   * （作品一覧で1話を右クリックしたときなど）。省略すると作品全体が対象。
   */
  filePaths?: string[];
  /**
   * 進み具合の届け先（作者の報告、2026-08-29）。
   *
   * **ステータスバーの進捗と一緒に呼ぶ。** 結果が出るのは下段の提案パネルで、
   * 作者はそこを見て待っている。渡されなければ何もしない
   */
  onProgress?: CheckProgress;
}

export async function checkTypos(
  work: WorkEntry,
  registry: AIRegistry,
  options: CheckTyposOptions = {}
): Promise<TypoCheckRunResult | undefined> {
  const resolved = await ensureConfigured(registry, "typo");
  if (!resolved) return undefined;

  // モデル情報はチャンクの字数を決めるのに使う。取れないまま既定値で進むと
  // 分割単位が変わり、キャッシュが全滅する。**手順は1か所にある**（6.27.10）
  const modelInfo = await resolveModelInfoOrWarn({
    registry,
    feature: "typo",
    provider: resolved.provider,
    model: resolved.model,
    actionLabel: "誤字脱字の検知",
  });
  if (!modelInfo) return undefined;

  const contextWindow = modelInfo.contextWindow;
  // **応答の見込みに実測を使う**（設計書6.65.16の2）。台帳に書ける量の
  // 実測があればそれ、無ければ既定の見込み（8,192）を上限とする
  const outputTuning = { providerId: resolved.provider.id, model: resolved.model };
  const plannedOutputTokens = resolveOutputTokensForPlanning(
    outputTuning.providerId,
    outputTuning.model
  );
  // **場所の確保（上）と、実際に送る上限（下）は別物である**（設計書6.77の
  // 第2段）。上を上限として送ると、測っていないモデルでは上限が設定値の
  // 半分になり、長い応答が途中で切れる——抽出のJSONは切れると解析できず、
  // そのチャンクが丸ごと捨てられる
  const sendOutputTokens = resolveOutputTokensForSend(
    outputTuning.providerId,
    outputTuning.model
  );

  // 実際に使うコンテキスト長。**本文以外の量を見込まない**（設計書6.27.10）。
  // 以前は「本文＋固定12,000字」で計算しており、固定費（指示・辞書・作法）が
  // 育つと足りなくなった。組み上がったプロンプトの実測から決める道
  // （`contextSizeForPrompt`）へ揃え、出力の見込みだけを渡す。

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
  // **切る前の本文をいったん溜める。** チャンクの字数は、指示と辞書と作法が
  // 何字あるかを測ってからでないと決められない（設計書6.27.10）。
  // 先に切ってしまうと、固定費が分かったときには切り直しになる
  const sources: SplitSource[] = [];

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
        sources.push({
          filePath: ep.filePath,
          body: episode.body,
          chapterStart: episode.chapter,
          chapterEnd: episode.chapter,
          lineOffset: located.line,
        });
      }
      continue;
    }

    const meta = parseEpisodeMetadata(file.text);
    if (!meta.body.trim()) continue;
    const located = locateBody(file.text, meta.body, 0);
    sources.push({
      filePath: ep.filePath,
      body: meta.body,
      chapterStart: ep.chapterStart,
      chapterEnd: ep.chapterEnd,
      lineOffset: located.line,
    });
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

  if (sources.length === 0) {
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

  // **方言・口癖は固有名詞の辞書に入らない。** 作者が名指しで守った語を別に読む
  const keepWords = await new KeepWordStore(work).loadWords();

  // **この作品の書き方をAIへ先に伝える**（設計書6.8.14）。
  // 語り手の一人称・文語体かどうか・直さない語。これまでは渡しておらず、
  // モデルが知りようのないことをコード側で後から弾いていた。
  // **コードの検証は外さない。** ここは「生まれる数を減らす」ためである
  const styleNote = buildStyleNote(
    collectWorkStyle({
      // 全話を繋いで見る。1話だけでは一人称も文語かも決められない。
      // **シーンメモは落とす**（`splitIntoChunks` が本文から消すのと同じ）。
      // 作者の覚え書きを地の文と読むと、人称の判定を誤る
      bodyText: sources.map((source) => blankMemoLines(source.body)).join("\n"),
      narrativePerson: await readNarrativePerson(work),
      keepWords: keepWords.map((entry) => entry.word),
    })
  );

  // **本文を空にしてプロンプトを組み、その字数を固定費とする**（設計書6.27.10）。
  // 辞書は作品が育つほど伸び、作法も条件で長さが変わる。見込みの定数を
  // 置くと必ず追い越されるので、実際に送る形のまま測る
  const overheadChars =
    TYPO_CHECK_SYSTEM_PROMPT.length +
    buildTypoCheckPrompt({
      chunkTextWithLineNumbers: "",
      properNounDictionary: protectedNames.slice(0, DICTIONARY_LIMIT),
      styleNote,
    }).length;

  // 大きさの決め方は1か所へ集めてある（設計書6.23）。固定費を差し引いてから決める
  const chunkSettings = readChunkSettings(
    contextWindow,
    {
      overheadChars,
      outputTokens: plannedOutputTokens,
    },
    outputTuning
  );
  const chunkChars = chunkSettings.chunk.chars;

  const tasks: FileChunkTask[] = sources.map((source) => ({
    filePath: source.filePath,
    chunks: splitIntoChunks(
      source.filePath,
      source.body,
      source.chapterStart,
      source.chapterEnd,
      { maxChars: chunkChars }
    ).map((chunk) => ({
      ...chunk,
      startLine: chunk.startLine + source.lineOffset,
    })),
  }));

  // **1話ずつ送ると、指示のほうが本文より大きい。** 1話2,000字の作品で
  // 指示が約5,600字。19話なら19回ぶん同じ指示を送り直していた
  // （2026-08-21、作者の指摘）。隣どうしをまとめて呼び出し回数を減らす。
  //
  // **行番号は `locateChunkLine` で元のファイルへ戻す。** まとめた本文の
  // 通し番号のまま使うと、2話目以降の指摘が1話目の別の行を書き換える。
  const mergeChars = chunkSettings.mergeChars;
  const chunks =
    mergeChars > 0
      ? mergeAdjacentChunks(
          tasks.flatMap((task) => task.chunks),
          { maxChars: mergeChars }
        )
      : tasks.flatMap((task) => task.chunks);
  if (chunks.length === 0) {
    vscode.window.showWarningMessage("処理できる本文がありません。");
    return undefined;
  }

  const dismissedHistory = new TypoDismissedHistory(work);
  const dismissed = await dismissedHistory.load();
  const appliedFixKeys = await loadAppliedFixKeys(work);

  const issues: TypoCheckIssue[] = [];

  // 文章作法（三点リーダー・ダッシュの偶数使用、鉤括弧内文末の句点、
  // 感嘆符・疑問符後の空白）はAIを使わずコードだけで判定できるため、
  // AIの実行有無・キャッシュに関係なく毎回すべてのチャンクに対して行う
  for (const chunk of chunks) {
    for (const issue of checkWritingStyle(chunk)) {
      // **まとめたチャンクでは、行番号が元ファイルのものではない。**
      // 戻せないものは捨てる（どこを直すのか分からないため）
      const at = locateChunkLine(chunk, issue.line);
      if (!at) continue;
      const located = { ...issue, line: at.line };
      const key = dismissKey(at.filePath, located);
      if (dismissed.has(key)) continue;
      issues.push({ ...located, filePath: at.filePath, chunkHash: chunk.hash });
    }
  }

  useLogFile(work.folderPath);
  logStep(
    `誤字脱字検知を開始: ${work.title} / ${resolved.provider.displayName} / ` +
      `${resolved.model} / ${chunks.length}チャンク / ` +
      `${describeChunkSettings(chunkSettings)} / v${TYPO_CHECK_VERSION}`
  );

  const cache = new ChunkCache(work);
  await cache.load();
  const cacheKeyBase = {
    feature: "typo_check",
    promptVersion: TYPO_CHECK_VERSION,
    providerId: resolved.provider.id,
    model: resolved.model,
  };

  const pending = chunks.filter((c) => !cache.get(c.hash, cacheKeyBase));

  if (pending.length > 0) {
    if (
      !(await confirmProviderReachable(
        resolved.provider,
        "誤字脱字の検知",
        resolved.model
      ))
    ) {
      return undefined;
    }
    const estimateMinutes = Math.ceil((pending.length * 15) / 60);
    const costNotice = buildTypoCheckCostNotice(
      resolved.provider.id,
      resolved.provider.isPaid,
      pending
    );
    // **まとめ方を変えると、キャッシュが総入れ替えになる。** 何も変えて
    // いないのに全件が対象になると、作者は不具合だと思う。理由を添える
    const allPending =
      pending.length === chunks.length && chunks.length > 1
        ? "\n（前回から本文の分け方が変わっているため、今回はすべて送り直します）"
        : "";
    const confirm = await vscode.window.showInformationMessage(
      `${chunks.length} チャンク中 ${pending.length} 件を処理します` +
        `（処理済み ${chunks.length - pending.length} 件はスキップ）。\n` +
        `モデル: ${resolved.model} / 目安 ${estimateMinutes} 分程度\n` +
        costNotice +
        allPending,
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
  /** 時間切れで落ちた数。作者へ「待ち時間を測れます」と出すかの判断に使う */
  let timedOutChunks = 0;
  let cancelled = false;
  let connectivityLost = false;
  let consecutiveConnectivityFailures = 0;
  const rateLimit: RateLimitWaitState = { waits: 0, totalWaitedMs: 0 };
  let rateLimitGaveUp = false;

  // **ほかの一括処理と重ならないよう、実行の札を取る**（設計書6.76）。
  // 関所（送信を1件ずつ）だけだと、誤字脱字と矛盾検知が交互に流れて
  // モデルの読み込み直しが往復する
  await withAiTurnProgress(
    "誤字脱字を検知しています",
    { label: "誤字脱字の検知", onCancelled: () => (cancelled = true) },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => {
        cancelled = true;
        controller.abort();
      });

      let done = 0;
      // **切り詰められたら、まとめたぶんを話ごとに戻して試し直す。**
      // まとめると出力も増えるので、上限に当たる見込みが上がる。
      // 捨てるとその話は丸ごと検査されないまま終わる（抽出で実際に起きた）。
      // 処理中に足すので、`for...of` ではなく番号で回す
      const queue = [...chunks];
      /**
       * 進捗の分母。**未処理の件数ではなく、全チャンク数である。**
       *
       * キャッシュ命中のチャンクも下で `done++` するので、分母を
       * `pending.length` にすると分子が分母を超える（処理済みが9件・
       * 未処理が2件の作品で「11/2」と出た）。0.28.13で送受信のログだけを
       * `total` へ揃えたが、その `total` の初期値がここで未処理の件数の
       * ままだった。分け直しで増える分（`total += …`）はどちらの数え方でも
       * 同じように足す。
       */
      let total = chunks.length;
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const chunk = queue[cursor];
        if (token.isCancellationRequested) break;

        const cached = cache.get(chunk.hash, cacheKeyBase);
        if (cached) {
          collectIssues(
            cached as TypoCheckResult,
            chunk,
            protectedNames,
            keepWords,
            dismissed,
            appliedFixKeys,
            issues
          );
          done++;
          continue;
        }

        const label = describeChunkFile(chunk.filePath, chunk);
        progress.report({
          message: `${done + 1}/${total}  ${label}`,
          increment: 100 / Math.max(total, 1),
        });
        // 提案パネルにも同じ進みを出す（作者は結果が出る場所で待っている）
        options.onProgress?.(done + 1, total);
        logStep(`AIへ送信: ${done + 1}/${total} ${label}`);
        const startedAt = Date.now();

        const bodyWithLines = withLineNumbers(chunk);
        // **「直さない語」は辞書へ混ぜない。** 固有名詞を先に並べて
        // 200語で切っていたため、固有名詞が多い作品では
        // **作者が名指しで守った語が1つも届かなかった**（2026-08-21）。
        // 作法の枠（styleNote）へ独立して出す
        const dictionary = protectedNames.slice(0, DICTIONARY_LIMIT);
        const userPrompt = buildTypoCheckPrompt({
          chunkTextWithLineNumbers: bodyWithLines,
          properNounDictionary: dictionary,
          styleNote,
        });

        const callAI = () =>
          resolved.provider.generate({
            systemPrompt: TYPO_CHECK_SYSTEM_PROMPT,
            userPrompt,
            model: resolved.model,
            temperature: 0.0,

            maxOutputTokens: sendOutputTokens,
            plannedOutputTokens,
            jsonSchema: TYPO_CHECK_SCHEMA as unknown as object,
            disableThinking: true,
            signal: controller.signal,
            meta: {
              feature: "typo_check",
              workFolder: work.folderPath,
              parts: measureParts(userPrompt, {
                本文: bodyWithLines.length,
                辞書: dictionary.join("").length,
                作法: styleNote?.length ?? 0,
              }),
            },
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
                  `${done + 1}/${total}  ` +
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
          // **分母は `total` を使う。** 送る側（上）と同じ値でなければ、
          // 同じ実行の中で分母が食い違う。`total` は入り切らなかったチャンクを
          // 分割して送り直すたびに増えるので、`pending.length` は途中で古くなる
          // （実際のログに「AIへ送信: 4/9」と「応答を受信: 4/7」が並んでいた。
          // 作者のログ、2026-08-30）。0.28.13
          logStep(
            `応答を受信: ${done + 1}/${total} ${label} ` +
              `（${Math.round((Date.now() - startedAt) / 1000)}秒）`
          );

          if (res.truncated || !res.text.trim()) {
            // まとめたせいで入り切らなかったのなら、元の大きさなら通る見込みが
            // ある。**捨てるより試すほうがよい**（部分的なJSONは解析できない）
            const parts = splitMergedChunk(chunk);
            if (parts.length > 1) {
              queue.splice(cursor + 1, 0, ...parts);
              total += parts.length;
              logStep(
                `切り詰められたため ${parts.length} 話に分けて試し直します: ${label}`
              );
            } else {
              failedChunks++;
            }
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
              protectedNames,
              keepWords,
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
          // **入らなかったなら、小さくして試し直す**（設計書6.27.10）。
          // 切り詰められたときと同じ道だが、こちらは送る前に分かっている
          if (isContextOverflow(e)) {
            const retry = retryOnOverflow(chunk, e);
            if (retry.kind === "split") {
              queue.splice(cursor + 1, 0, ...retry.parts);
              total += retry.parts.length;
              logStep(`${label}: ${retry.note}`);
            } else {
              // 下限まで割っても入らない。**黙って飛ばさず、理由を残す**
              failedChunks++;
              logFailure("誤字脱字検知", {
                チャンク: label,
                理由: retry.note,
              });
            }
            done++;
            continue;
          }
          logTypoFailure(chunk, e, {
            provider: resolved.provider.displayName,
            model: resolved.model,
          });
          failedChunks++;
          // **時間切れだけは別に数える。** 直し方が「待ち時間を延ばす」で
          // はっきりしており、ほかの失敗と束ねると案内が出せない
          if (e instanceof AIError && e.kind === "timeout") timedOutChunks++;
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

      // 分母は送受信と同じ `total`。**`chunks.length` は分割の前の数**なので、
      // 分割が起きた回は「9/7」のように分子が分母を超える（作者のログで発覚）
      logStep(
        `誤字脱字検知を終了: ${done}/${total}（失敗 ${failedChunks}件${
          total > chunks.length
            ? ` / 入り切らず ${total - chunks.length}回に分けた`
            : ""
        }${cancelled ? " / 中止された" : ""}）`
      );

      try {
        await cache.save();
      } catch {
        // キャッシュは再生成できるので、検知結果はそのまま返す
      }
    }
  );

  if (cancelled) {
    vscode.window.showInformationMessage(
      "誤字脱字検知を中止しました。完了済みの処理は次回再利用されます。"
    );
    return {
      issues,
      rejectedCount,
      failedChunks,
      totalChunks: chunks.length,
      timedOutChunks,
      usedPaidProvider: resolved.provider.isPaid,
      dismissedCount: 0,
      cancelled: true,
    };
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
    totalChunks: chunks.length,
    timedOutChunks,
    usedPaidProvider: resolved.provider.isPaid,
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
  protectedNames: string[],
  keepWords: KeepWord[],
  dismissed: Set<string>,
  appliedFixKeys: ReadonlySet<string>,
  out: TypoCheckIssue[],
  onRejected?: (count: number) => void
): void {
  const validated = validateTypoIssues(result, chunk, protectedNames, keepWords);
  let rejectedCount = validated.rejected.length;

  for (const issue of validated.accepted) {
    // **どのファイルの何行目かを、ここで確定させる。** まとめたチャンクでは
    // AIが返す行番号がまとめた本文の通し番号になっており、そのまま使うと
    // 別の話のファイルの、まったく違う行を書き換える
    const at = locateChunkLine(chunk, issue.line);
    if (!at) {
      // 戻せない行は捨てる。どこを直すのか決められない
      rejectedCount++;
      continue;
    }
    const located = { ...issue, line: at.line };
    const fileName = path.basename(at.filePath);

    if (dismissed.has(dismissKey(at.filePath, located))) continue;

    if (
      appliedFixKeys.has(
        appliedFixKey(fileName, located.suggestion, located.target)
      )
    ) {
      rejectedCount++;
      continue;
    }

    out.push({ ...located, filePath: at.filePath, chunkHash: chunk.hash });
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
    // **送った量を残す。** タイムアウトの記録が「180秒で切れた」だけだと、
    // あとから見ても「大きすぎたのか、AIが遅かったのか」を切り分けられない
    // （実測：この作品の応答は中央34秒・90%点124秒で、上限180秒に余裕が
    // 無かった。作者のログ、2026-08-29）。0.28.9
    送った本文: `${chunk.text.length}字`,
    種別: error instanceof AIError ? error.kind : "不明",
    詳細:
      error instanceof AIError
        ? error.detail
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
  });
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

/**
 * 実行前に、プロバイダごとの料金上の影響を明示する（簡易版）。
 *
 * **「無料か」はプロバイダIDではなく `isPaid` で決める。** 以前は
 * `providerId === "ollama"` と書いていたため、**同じく課金されない
 * LM Studio に「課金対象トークン量の目安」が出ていた**（設計書6.28）。
 */
export function buildTypoCheckCostNotice(
  providerId: ProviderId,
  paid: boolean,
  pendingChunks: Chunk[]
): string {
  if (!paid) {
    return "料金: 無料・手元で実行（API課金なし）";
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
