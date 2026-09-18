import type { StoryFact } from "../../models/storyFact";
import { parseCharacter } from "../../models/character";
import { withLineNumbers, type Chunk } from "../../core/chunker";
import {
  buildFactVerifyIssue,
  buildKnownCharacterTable,
  describeCandidateTypes,
  describeFactRun,
  linesAround,
  type KnownCharacterTable,
} from "../../core/factContradiction";
import { factsFromCharacters } from "../../core/factsFromRecords";
import {
  buildFactContradictionIssue,
  candidateSidesOf,
  collectFactsFromChunk,
  lineTextOf,
  parseFactJsonObject,
  TOPIC_CARRY_LIMIT,
  VERIFY_CONTEXT_LINES,
  type FactContradictionIssue,
  type FactPlace,
} from "../../core/factContradictionFlow";
import {
  filterAllowed,
  findContradictionCandidates,
} from "../../core/contradictionMatch";
import {
  describeStoryFactRejections,
  type RejectedStoryFact,
} from "../../core/storyFactValidation";
import {
  describeVerifyResults,
  parseVerifyOutcome,
  undecidedOutcome,
  type VerifyOutcome,
} from "../../core/contradictionVerifyValidation";
import {
  buildStoryFactExtractPrompt,
  STORY_FACT_EXTRACT_SCHEMA,
  STORY_FACT_EXTRACT_SYSTEM_PROMPT,
  STORY_FACT_EXTRACT_VERSION,
} from "../../prompts/storyFactExtract";
import {
  buildContradictionVerifyPrompt,
  CONTRADICTION_VERIFY_SCHEMA,
  CONTRADICTION_VERIFY_SYSTEM_PROMPT,
  CONTRADICTION_VERIFY_VERSION,
  type VerifyRejectReason,
} from "../../prompts/contradictionVerify";
import {
  McpToolError,
  SETTINGS_SUBDIRS,
  chapterLabelOf,
  chunkFromId,
  chunkIdOf,
  chunksOfWorkFile,
  describeError,
  listBodyFiles,
  readBody,
  readSettingsRecords,
  selectChunks,
} from "./shared";
import { ollamaGenerate } from "./ollama";
import { askSampling } from "./sampling";
import {
  assertRunner,
  describeOutcome,
  claudeNote,
  validateWith,
  type RunnerKind,
} from "./run";

/**
 * 矛盾検知（事実の照合）を外から呼ぶ——設計書6.88 の**評価セット**（第5段）。
 *
 * ## なぜ口を開けたのか
 *
 * 6.88 は 0.46.0〜0.46.3 で4段まで実装され、**製品では動いていた**。
 * ところが MCP の feature 一覧に無かったため `scripts/measure.mjs` から
 * 呼べず、**効くのかどうかを一度も測れていなかった**（2026-09-18 の測定は
 * 古いほうの道（P-12）だけを測っている）。ここはその測る道である。
 *
 * ## 判定のロジックは書き直さない
 *
 * 通る部品は製品とまったく同じである——抽出（P-37）・検算
 * （`core/storyFactValidation.ts`）・機械照合（`core/contradictionMatch.ts`）・
 * 判定（P-12b）。**写しを作ると、製品と測定がずれる**（CLAUDE.md の
 * 「繰り返し起きた失敗」5）。ここがするのは、ファイルを読んで順に呼ぶことだけ。
 *
 * ## P-12（`contradiction`）とは別の feature である
 *
 * **許可も別に要る。** `contradiction` を許したことは、こちらを許したことに
 * ならない——通るプロンプトも、本文が出る回数も違う。古い道具名の
 * 読み替え表（`LEGACY_TOOL_KEYS`）にも足さない（そんな道具は無かった）。
 *
 * ## 作品ぜんたいを一度に見る
 *
 * **`filePath` は任意である。** 6.88 の値打ちは**話をまたいで事実を追う**
 * ところにあり（第2話で折った足が、第4話でどちらのギプスか）、
 * 1話ずつ回すとその型は原理的に拾えない。省略すると作品ぜんたいを見る。
 */

const VALIDATE_WITH = validateWith("factContradiction");

/** 読み込んだ材料。**AIを呼ぶ前に揃うものだけ** */
interface FactWorkContext {
  table: KnownCharacterTable;
  /** 既にある人物レコードから組んだ事実（設計書6.88.5の第2段） */
  recordFacts: StoryFact[];
  chunks: Array<{ chunkId: string; chunk: Chunk; chapterLabel: string }>;
  /** 内訳から話数が引けないときの落とし先 */
  chapterByFile: Map<string, number | null>;
  chapterLabelByFile: Map<string, string>;
  /** 読めなかった設定資料の件数（黙って直さない） */
  unreadableSettings: number;
  /** 本文そのものを読めなかったファイルと、その理由 */
  unreadableFiles: Array<{ filePath: string; reason: string }>;
}

export interface FactContradictionInput {
  folder: string;
  /** 省略すると作品ぜんたい。**話をまたぐ食い違いは、絞ると拾えない** */
  filePath?: string;
  numCtx: number;
  chunkIndex?: number;
}

/**
 * 人物レコードと本文のチャンクを揃える。
 *
 * **設定資料が無くても走る。** 事実は本文から抜けるので、資料は
 * 「あれば混ぜる」材料にすぎない（製品と同じ）。
 */
function loadFactWork(input: FactContradictionInput): FactWorkContext {
  const loaded = readSettingsRecords(
    input.folder,
    SETTINGS_SUBDIRS.characters,
    parseCharacter
  );
  // モブは資料が薄く、対応表を太らせるだけなので外す（製品と揃える）
  const characters = loaded.records.filter((character) => !character.isMob);
  const table = buildKnownCharacterTable(characters);

  const files =
    input.filePath !== undefined && input.filePath.trim()
      ? [input.filePath.trim()]
      : listBodyFiles(input.folder);
  if (files.length === 0) {
    throw new McpToolError(
      `検知できる本文がありません: ${input.folder}（本文/ の下に .txt か .md を置いてください）`
    );
  }

  const chunks: FactWorkContext["chunks"] = [];
  const chapterByFile = new Map<string, number | null>();
  const chapterLabelByFile = new Map<string, string>();
  const unreadableFiles: FactWorkContext["unreadableFiles"] = [];

  for (const filePath of files) {
    let built: ReturnType<typeof chunksOfWorkFile>;
    try {
      built = chunksOfWorkFile(input.folder, filePath, input.numCtx);
    } catch (error) {
      // **1つ読めなくても止めない**（製品と同じ）。理由は残す
      unreadableFiles.push({ filePath, reason: describeError(error) });
      continue;
    }
    for (const chunk of built.chunks) {
      const label = chapterLabelOf(chunk);
      if (!chapterLabelByFile.has(filePath)) {
        chapterLabelByFile.set(filePath, label);
        chapterByFile.set(filePath, chunk.chapterStart);
      }
      chunks.push({
        chunkId: chunkIdOf(filePath, chunk, built.maxChars),
        chunk,
        chapterLabel: label,
      });
    }
  }

  return {
    table,
    recordFacts: factsFromCharacters(characters),
    // `chunkIndex` は**切り終えた並びの何番目か**（`selectChunks` と同じ数え方）
    chunks: selectFrom(chunks, input.chunkIndex),
    chapterByFile,
    chapterLabelByFile,
    unreadableSettings: loaded.unreadable,
    unreadableFiles,
  };
}

/**
 * `chunkIndex` の絞り込み。
 *
 * `selectChunks` と同じ断り方をするために、いったんチャンクの並びへ戻す
 * ——断り文句を写すと、片方だけが古くなる。
 */
function selectFrom<T extends { chunk: Chunk }>(
  items: T[],
  chunkIndex?: number
): T[] {
  if (chunkIndex === undefined) return items;
  selectChunks(
    items.map((item) => item.chunk),
    chunkIndex
  );
  return [items[chunkIndex]];
}

/* ── プロンプトを組む ───────────────────────────────────── */

export interface FactExtractChunkPrompt {
  chunkId: string;
  index: number;
  chapterLabel: string;
  chars: number;
  userPrompt: string;
}

export interface FactContradictionPromptResult {
  /** 事実の抽出（P-37）の版。**ここが返すプロンプトの版である** */
  promptVersion: string;
  /**
   * 判定（P-12b）の版。
   *
   * **この道は2つのプロンプトを通る。** 片方の版しか記録に残さないと、
   * あとから「前 → 後」を並べても何が変わったのかが分からない。
   */
  verifyPromptVersion: string;
  systemPrompt: string;
  schema: unknown;
  validateWith: string;
  /** 対応表に載せた人物の数。0なら本文の表記のまま扱う */
  knownCharacters: number;
  /** **これは第1段だけである**と断る */
  note: string;
  chunks: FactExtractChunkPrompt[];
  unreadableFiles: Array<{ filePath: string; reason: string }>;
}

/**
 * 事実を抜く（P-37）プロンプトを、チャンクごとに組む。
 *
 * **ここで返せるのは第1段だけである。** 機械照合は**作品ぜんたいの事実が
 * 揃ってから**でないと動かず、判定（P-12b）はその候補を見て初めて組める。
 * `novel.run`（runner: ollama／sampling）は4段を続けて通す。
 *
 * **既知の topic は空で組む。** 製品は前のチャンクで出た topic を次へ渡すが、
 * ここは全チャンクを先に組むので渡しようがない。topic は「同じ事柄に同じ語を
 * 付けさせる」ための助けであって、答えの正しさを決めるものではない。
 */
export function factContradictionPrompt(
  input: FactContradictionInput
): FactContradictionPromptResult {
  const context = loadFactWork(input);
  return {
    promptVersion: STORY_FACT_EXTRACT_VERSION,
    verifyPromptVersion: CONTRADICTION_VERIFY_VERSION,
    systemPrompt: STORY_FACT_EXTRACT_SYSTEM_PROMPT,
    schema: STORY_FACT_EXTRACT_SCHEMA,
    validateWith: VALIDATE_WITH,
    knownCharacters: context.table.entries.length,
    note:
      "本文から「事実」を取り出す段（P-37）のプロンプトです。" +
      "食い違いの照合と判定は拡張機能側が行うため、" +
      "この段の応答だけでは矛盾は出ません（novel.run が4段を続けて通します）。",
    chunks: context.chunks.map((item) => ({
      chunkId: item.chunkId,
      index: item.chunk.index,
      chapterLabel: item.chapterLabel,
      chars: item.chunk.text.length,
      userPrompt: promptForChunk(context, item, []),
    })),
    unreadableFiles: context.unreadableFiles,
  };
}

function promptForChunk(
  context: FactWorkContext,
  item: FactWorkContext["chunks"][number],
  knownTopics: string[]
): string {
  return buildStoryFactExtractPrompt({
    chunkText: withLineNumbers(item.chunk),
    chapterLabel: item.chapterLabel,
    chapterNumber: item.chunk.chapterStart,
    knownCharacters: context.table.entries,
    knownTopics,
  });
}

/* ── 1チャンクぶんの検算 ────────────────────────────────── */

export interface FactContradictionValidateResult {
  chunkId: string;
  chapterLabel: string;
  /** 受理した事実。行は元のファイルへ戻してある */
  accepted: StoryFact[];
  rejected: RejectedStoryFact[];
  rejectionNote: string;
  note: string;
}

/**
 * P-37 の応答を、製品と同じ検算に掛ける。
 *
 * **ここで出るのは事実であって、矛盾ではない。** 照合には作品ぜんたいの
 * 事実が要るので、1チャンクだけでは決められない——そう断って返す。
 */
export function factContradictionValidate(input: {
  folder: string;
  chunkId: string;
  response: string;
}): FactContradictionValidateResult {
  const chunk = chunkFromId(input.folder, input.chunkId);
  const raw = parseFactJsonObject(input.response);
  if (!raw) {
    throw new McpToolError(
      "応答を読み取れませんでした（事実の抽出のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }
  const loaded = readSettingsRecords(
    input.folder,
    SETTINGS_SUBDIRS.characters,
    parseCharacter
  );
  const table = buildKnownCharacterTable(
    loaded.records.filter((character) => !character.isMob)
  );
  const got = collectFactsFromChunk({ raw, chunk, table });
  return {
    chunkId: input.chunkId,
    chapterLabel: chapterLabelOf(chunk),
    accepted: got.accepted,
    rejected: got.rejected,
    rejectionNote: describeStoryFactRejections(got.rejected),
    note:
      "取り出した事実です（矛盾ではありません）。" +
      "食い違いの照合には作品ぜんたいの事実が要るので、novel.run を使ってください。",
  };
}

/* ── 4段を通す ──────────────────────────────────────────── */

/** ファイルごとにまとめた結果。**`contradiction` と同じ並びにしてある** */
export interface FactContradictionFileResult {
  /** ファイルの相対パス。**`chunkId` の位置に置く**（集計が同じ形で読める） */
  chunkId: string;
  chapterLabel: string;
  accepted: FactContradictionIssue[];
  /** 判定（P-12b）で取り下げた候補 */
  rejected: Array<{ reason: string; excerpt: string; explanation: string }>;
}

export interface FactContradictionRunInput extends FactContradictionInput {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
}

export type FactContradictionRunOutcome =
  | {
      runner: "claude";
      note: string;
      systemPrompt: string;
      schema: unknown;
      validateWith: string;
      chunks: FactExtractChunkPrompt[];
    }
  | {
      runner: "ollama" | "sampling";
      note: string;
      model: string;
      results: FactContradictionFileResult[];
      failures: Array<{ chunkId: string; reason: string }>;
      /** 工程ごとの数（どこで減ったのかが分からないと、直す場所が決まらない） */
      stages: {
        chunks: number;
        acceptedFacts: number;
        recordFacts: number;
        rejectedFacts: number;
        rejectionNote: string;
        candidates: number;
        candidateNote: string;
        kept: number;
        verifyNote: string;
      };
      unreadableFiles: Array<{ filePath: string; reason: string }>;
    };

export async function factContradictionRun(
  input: FactContradictionRunInput
): Promise<FactContradictionRunOutcome> {
  // **省略を既定で埋めない**（設計書6.87.8 の5）
  assertRunner(input.runner);

  if (input.runner === "claude") {
    const prompts = factContradictionPrompt(input);
    return {
      runner: "claude",
      // **4段のうち1段しか渡せないことを黙らない**
      note: `${claudeNote(VALIDATE_WITH)} ${prompts.note}`,
      systemPrompt: prompts.systemPrompt,
      schema: prompts.schema,
      validateWith: VALIDATE_WITH,
      chunks: prompts.chunks,
    };
  }

  const context = loadFactWork(input);
  const ask = askerOf(input);

  /* ── 第1段：本文から事実を抜く（P-37）───────────────── */
  const facts: StoryFact[] = [];
  const places = new Map<string, FactPlace>();
  const rejected: RejectedStoryFact[] = [];
  const knownTopics: string[] = [];
  const failures: Array<{ chunkId: string; reason: string }> = [];
  const models = new Set<string>();

  for (const item of context.chunks) {
    try {
      const reply = await ask({
        systemPrompt: STORY_FACT_EXTRACT_SYSTEM_PROMPT,
        // 直近のものだけを渡す（指示だけが太らないように。製品と同じ）
        userPrompt: promptForChunk(
          context,
          item,
          knownTopics.slice(-TOPIC_CARRY_LIMIT)
        ),
        schema: STORY_FACT_EXTRACT_SCHEMA,
      });
      models.add(reply.model);
      const raw = parseFactJsonObject(reply.text);
      if (!raw) throw new McpToolError("応答を読み取れません（JSONの形ではありません）");

      const got = collectFactsFromChunk({
        raw,
        chunk: item.chunk,
        table: context.table,
        chapterOfFile: (filePath) => context.chapterByFile.get(filePath) ?? null,
      });
      facts.push(...got.accepted);
      for (const [id, place] of got.places) places.set(id, place);
      rejected.push(...got.rejected);
      for (const topic of got.topics) {
        if (!knownTopics.includes(topic)) knownTopics.push(topic);
      }
    } catch (error) {
      // **1つ失敗しても全体を止めない**（製品と同じ）
      failures.push({ chunkId: item.chunkId, reason: describeError(error) });
    }
  }

  /* ── 第2・3段：機械照合（**AIを使わない**。設計書6.88.6）───── */
  const allFacts = [...facts, ...context.recordFacts];
  const candidates = filterAllowed(
    findContradictionCandidates({ facts: allFacts, transitions: [], scenes: [] }),
    // 容認リスト（6.88.8）の保存は第5段の残り。いまは何も抑えない
    []
  );
  const factById = new Map(allFacts.map((fact) => [fact.id, fact]));

  /* ── 第4段：候補を1件ずつ確かめる（P-12b）───────────── */
  const issuesByFile = new Map<string, FactContradictionIssue[]>();
  const rejectedByFile = new Map<
    string,
    FactContradictionFileResult["rejected"]
  >();
  const verifyRejected: Array<{ reason?: VerifyRejectReason }> = [];
  let verifyUndecided = 0;
  const sourceCache = new Map<string, string | undefined>();

  for (const candidate of candidates) {
    const sides = candidateSidesOf({ candidate, factById, places });
    // 両側とも資料由来なら本文の飛び先が無い（製品と同じく、いまは出せない）
    if (!sides) continue;

    const source = readSourceCached(input.folder, sides.place.filePath, sourceCache);
    const rightLineText = sides.rightInBody
      ? lineTextOf(source, sides.place.line)
      : undefined;
    const issue = buildFactVerifyIssue({
      candidate,
      left: sides.left,
      right: sides.right,
      rightLineText,
    });

    let outcome: VerifyOutcome;
    try {
      const reply = await ask({
        systemPrompt: CONTRADICTION_VERIFY_SYSTEM_PROMPT,
        userPrompt: buildContradictionVerifyPrompt({
          chapterLabel: context.chapterLabelByFile.get(sides.place.filePath) ?? "",
          contextWithLineNumbers: source
            ? linesAround(source, sides.place.line, VERIFY_CONTEXT_LINES)
            : "",
          excerpt: issue.excerpt,
          settingSays: issue.settingSays,
          textSays: issue.textSays,
          category: issue.category,
          // **前側の話数を渡す。** 検証は「まだ明かされていない」を
          // 見分けるのにこれを使う（前側が後の話なら怪しむ）
          settingKnownAt:
            sides.left.chapter !== null ? `第${sides.left.chapter}話` : "",
        }),
        schema: CONTRADICTION_VERIFY_SCHEMA,
      });
      models.add(reply.model);
      outcome = parseVerifyOutcome(reply.text);
    } catch (error) {
      // **判定できなかったら通す。** 通信の失敗で本物の候補を消さない
      outcome = undecidedOutcome(`判定できませんでした（${describeError(error)}）`);
    }

    if (outcome.undecided) verifyUndecided++;
    if (!outcome.keep) {
      verifyRejected.push({ reason: outcome.reason });
      push(rejectedByFile, sides.place.filePath, {
        reason: outcome.reason ?? "理由なし",
        excerpt: issue.excerpt,
        explanation: outcome.explanation,
      });
      continue;
    }
    push(
      issuesByFile,
      sides.place.filePath,
      buildFactContradictionIssue({
        candidate,
        sides,
        rightLineText,
        explanation: outcome.explanation,
      })
    );
  }

  const kept = [...issuesByFile.values()].reduce(
    (total, list) => total + list.length,
    0
  );
  const rejectionNote = describeStoryFactRejections(rejected);
  const verifyNote = describeVerifyResults(verifyRejected, verifyUndecided);
  const candidateNote = describeCandidateTypes(candidates);

  const files = new Set([...issuesByFile.keys(), ...rejectedByFile.keys()]);
  const results: FactContradictionFileResult[] = [...files]
    .sort((left, right) => left.localeCompare(right, "ja"))
    .map((filePath) => ({
      chunkId: filePath,
      chapterLabel: context.chapterLabelByFile.get(filePath) ?? "",
      accepted: issuesByFile.get(filePath) ?? [],
      rejected: rejectedByFile.get(filePath) ?? [],
    }));

  return {
    runner: input.runner,
    /*
      **どこで減ったのかを、報告の1行に出す**（`describeFactRun`。製品の
      ログと同じ文）。この道は工程が4つあり、件数だけでは
      「本当に無い」のか「どこかで消しすぎている」のかが切り分けられない。
    */
    note: `${describeOutcome({
      done: context.chunks.length - failures.length,
      failed: failures.length,
      where:
        input.runner === "ollama"
          ? "手元の Ollama で"
          : "呼び出し元に考えてもらい、",
      aside:
        input.runner === "ollama"
          ? "原稿はこの機械から出ていません"
          : "本文は呼び出し元へ渡っており、その先は呼び出し元の設定によります",
    })} ${describeFactRun({
      chunksDone: context.chunks.length - failures.length,
      chunksTotal: context.chunks.length,
      skippedChunks: 0,
      failedChunks: failures.length,
      acceptedFacts: facts.length,
      recordFacts: context.recordFacts.length,
      rejectedFacts: rejected.length,
      rejectionNote,
      candidates: candidates.length,
      candidateNote,
      kept,
      verifyNote,
      cancelled: false,
    })}`,
    model:
      models.size > 0
        ? [...models].join(" / ")
        : (input.model ?? "（不明）"),
    results,
    failures,
    stages: {
      chunks: context.chunks.length,
      acceptedFacts: facts.length,
      recordFacts: context.recordFacts.length,
      rejectedFacts: rejected.length,
      rejectionNote,
      candidates: candidates.length,
      candidateNote,
      kept,
      verifyNote,
    },
    unreadableFiles: context.unreadableFiles,
  };
}

/** 行き先を1つの呼び方に揃える（`runByRunner` は2段に分かれた道を回せない） */
function askerOf(
  input: FactContradictionRunInput
): (params: {
  systemPrompt: string;
  userPrompt: string;
  schema: unknown;
}) => Promise<{ text: string; model: string }> {
  if (input.runner === "sampling") {
    return async (params) => {
      const reply = await askSampling({
        folder: input.folder,
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
      });
      return { text: reply.text, model: reply.model };
    };
  }
  const model = input.model;
  if (!model) {
    throw new McpToolError("runner が ollama のときは model が要ります。");
  }
  return async (params) => {
    const response = await ollamaGenerate({
      endpoint: input.endpoint,
      model,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      schema: params.schema,
      numCtx: input.numCtx,
      allowRemote: input.allowRemote,
      // 事実の書き写しも判定も揺らさない（製品と同じ 0.0）
      temperature: 0,
    });
    return { text: response.text, model: response.model };
  };
}

/** 本文は1回だけ読む。判定は同じファイルを何度も引く */
function readSourceCached(
  folder: string,
  filePath: string,
  cache: Map<string, string | undefined>
): string | undefined {
  if (cache.has(filePath)) return cache.get(filePath);
  let text: string | undefined;
  try {
    text = readBody(folder, filePath);
  } catch {
    // 読めなければ前後の文脈なしで判定する（候補ごと捨てるよりよい）
    text = undefined;
  }
  cache.set(filePath, text);
  return text;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
