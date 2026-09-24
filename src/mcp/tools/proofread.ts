import * as nodePath from "node:path";
import {
  MAX_ISSUES_PER_1000_CHARS,
  PROOFREAD_SCHEMA,
  PROOFREAD_SYSTEM_PROMPT,
  PROOFREAD_TEMPERATURE,
  PROOFREAD_VERSION,
  buildProofreadPrompt,
  issueBudget,
} from "../../prompts/proofread";
import {
  parseProofreadResult,
  validateProofreadIssues,
  type AcceptedProofreadIssue,
  type RejectedProofreadIssue,
} from "../../core/proofreadValidation";
import { withLineNumbers, type Chunk } from "../../core/chunker";
import { blankMemoLines } from "../../core/sceneMemo";
import {
  episodeBodySources,
  type EpisodeBodySource,
} from "../../core/episodeChunks";
import {
  describeNarratorNameSlip,
  findNarratorNameSlips,
  resolveWorkNarrator,
} from "../../core/narratorNameSlip";
import { parseCharacter } from "../../models/character";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { parsePlotMarkdown } from "../../core/plotDoc";
import { buildStyleNote, collectWorkStyle } from "../../core/workStyleFacts";
import {
  isKeptWord,
  parseKeepWordSet,
  type KeepWord,
} from "../../models/keepWord";
import {
  KEEP_WORDS_FILE,
  McpToolError,
  SETTINGS_SUBDIRS,
  readSettingsRecords,
  chapterLabelOf,
  chunkFromId,
  chunkIdOf,
  chunksOfWorkFile,
  listBodyFiles,
  readBody,
  readPlotMarkdown,
  readSettingsFile,
  selectChunks,
} from "./shared";
import { ollamaGenerate } from "./ollama";
import {
  runByRunner,
  type RunOutcome,
  type RunnerKind,
  validateWith,
} from "./run";

/**
 * 推敲（P-09）を外から呼ぶ（設計書6.87.8 の4）。
 *
 * **並びは製品のまま**（6.87.6 の3）——`collectWorkStyle`／`buildStyleNote` で
 * 作品の書き方をまとめ、`buildProofreadPrompt` へ渡し、応答は
 * `parseProofreadResult` → `validateProofreadIssues` で検算する。
 *
 * **文体メモを省かない。** 渡さずに測ったとき、文語体の作品で漢字ひらきの
 * 指摘が乱発した（実機確認 F-21）。提案の数を減らすのはプロンプトの仕事、
 * 原稿へ入れないのはコードの仕事で、**両方いる。**
 */

const VALIDATE_WITH = validateWith("proofread");

/** 作品の書き方。プロンプトにも検算にも要る */
export interface WorkStyle {
  narrativeStyle: string;
  styleNote: string;
  keepWords: KeepWord[];
}

/**
 * 作品の書き方をまとめる。
 *
 * **全話を繋いで見る**（製品と同じ）。1話だけでは、語り手の一人称も
 * 文語かどうかも決められない。**シーンメモは落とす**
 * （`splitIntoChunks` が本文から消すのと同じ）。
 */
export function collectStyle(folder: string): WorkStyle {
  const bodies = readWorkSources(folder).map((source) =>
    blankMemoLines(source.body)
  );

  const plot = readPlotMarkdown(folder);
  const narrativeStyle = plot
    ? parsePlotMarkdown(plot).sections.narrativePerson.trim()
    : "";

  const keepWords = readKeepWords(folder);

  const styleNote = buildStyleNote(
    collectWorkStyle({
      bodyText: bodies.join("\n"),
      narrativePerson: narrativeStyle,
      keepWords: keepWords.map((entry) => entry.word),
    })
  );

  return { narrativeStyle, styleNote, keepWords };
}

/** 作者が「直さない」と決めた語。壊れていても直さない・止めない（守る語が無い状態で進む） */
function readKeepWords(folder: string): KeepWord[] {
  const rawKeepWords = readSettingsFile(folder, KEEP_WORDS_FILE);
  if (rawKeepWords === undefined) return [];
  try {
    return parseKeepWordSet(rawKeepWords).words;
  } catch {
    return [];
  }
}

/**
 * 全話の本文を、話ごとに切り出して読む（`filePath` は作品からの相対パス）。
 *
 * 競合マーカーのあるファイル・読めないファイルは外す。**ここで止めない**
 * ——作法や語り手の材料が少し痩せるだけで、推敲そのものはできる。
 */
function readWorkSources(folder: string): EpisodeBodySource[] {
  const sources: EpisodeBodySource[] = [];
  for (const relative of listBodyFiles(folder)) {
    let text: string;
    try {
      text = readBody(folder, relative);
    } catch {
      continue;
    }
    const parsed = parseEpisodeFileName(nodePath.basename(relative));
    sources.push(
      ...episodeBodySources(relative, text, {
        chapterStart: parsed.chapterStart,
        chapterEnd: parsed.chapterEnd,
      })
    );
  }
  return sources;
}

/** 語り手の名前が地の文に出る所（設計書6.9.2）。1件ぶん */
export interface NarratorSlipResult {
  filePath: string;
  /** ファイルの行番号（1始まり） */
  line: number;
  original: string;
  /** 一人称へ置き換えた形。同じ行に同じ範囲が2か所あれば空 */
  suggestion: string;
  /** 製品の推敲と同じ札 */
  reason: "視点";
  explanation: string;
}

export interface NarratorSlipScan {
  /** 作品全体から決めた語り手。決まらなければ null（そのときは何も探さない） */
  narrator: { firstPerson: string; name: string } | null;
  /** 何も出さなかった理由（語り手が決まらない・人物の資料が読めない） */
  note: string;
  slips: NarratorSlipResult[];
  /** 見なかった話と、その理由（`NarratorSlipSkip`） */
  skipped: Array<{ filePath: string; reason: string }>;
}

/**
 * 語り手の名前が地の文に三人称で出る所を、**AIを使わずに**探す（設計書6.9.2）。
 *
 * **製品と同じ関数・同じ決め方**（`core/narratorNameSlip.ts`）。語り手は
 * 全話を繋いで決め、話ごとに「その話がその語り手の一人称か」を確かめる。
 * 人物の資料に読めないファイルがあれば探さない（製品と同じ。苗字の重なりが
 * 分からなくなる）。
 */
export function scanNarratorSlips(
  folder: string,
  filePath?: string
): NarratorSlipScan {
  const people = readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.characters,
    parseCharacter
  );
  if (people.unreadable > 0) {
    return {
      narrator: null,
      note: `人物の資料に読めないファイルが${people.unreadable}件あるため、探していません（製品も同じ）。`,
      slips: [],
      skipped: [],
    };
  }
  const sources = readWorkSources(folder);
  const narrator = resolveWorkNarrator(
    sources.map((source) => blankMemoLines(source.body)).join("\n"),
    people.records
  );
  if (!narrator) {
    return {
      narrator: null,
      note: "語り手が1人に決まらないため、探していません（三人称の作品・一人称が人物に登録されていない作品では出しません）。",
      slips: [],
      skipped: [],
    };
  }

  // 作者が「直さない」と決めた語を含むなら出さない（製品と同じ）
  const keepWords = readKeepWords(folder);
  const slips: NarratorSlipResult[] = [];
  const skipped: Array<{ filePath: string; reason: string }> = [];
  for (const source of sources) {
    if (filePath && !sameRelative(source.filePath, filePath)) continue;
    const found = findNarratorNameSlips({
      text: source.body,
      narrator,
      people: people.records,
    });
    if (found.skipped) {
      skipped.push({
        filePath: source.filePath.replace(/\\/g, "/"),
        reason: found.skipped,
      });
    }
    for (const slip of found.slips) {
      if (isKeptWord(slip.original, keepWords)) continue;
      slips.push({
        // **区切りは「/」に揃える。** Windows では `listBodyFiles` が「\」で
        // 返すが、呼ぶ側（novel.run の filePath）は「/」で渡してくる
        filePath: source.filePath.replace(/\\/g, "/"),
        line: source.lineOffset + slip.line,
        original: slip.original,
        suggestion: slip.suggestion,
        reason: "視点",
        explanation: describeNarratorNameSlip(slip),
      });
    }
  }
  return {
    narrator: { firstPerson: narrator.firstPerson, name: narrator.name },
    note: "AIを使わずに数えた結果です。製品の推敲では「視点」の札で並びます。",
    slips,
    skipped,
  };
}

function sameRelative(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return normalize(left) === normalize(right);
}

export interface ProofreadChunkPrompt {
  chunkId: string;
  index: number;
  chapterLabel: string;
  chars: number;
  maxIssues: number;
  userPrompt: string;
}

export interface ProofreadPromptResult {
  promptVersion: string;
  systemPrompt: string;
  schema: unknown;
  /** 製品がこのプロンプトで使う温度（`prompts/*.ts`）。**写しを持たない** */
  temperature: number;
  /** AIへ渡す作品の書き方。**空のまま投げない**（F-21） */
  styleNote: string;
  narrativeStyle: string;
  maxIssuesPer1000Chars: number;
  validateWith: string;
  chunks: ProofreadChunkPrompt[];
}

export interface ProofreadPromptInput {
  folder: string;
  filePath: string;
  numCtx: number;
  chunkIndex?: number;
}

export function proofreadPrompt(
  input: ProofreadPromptInput
): ProofreadPromptResult {
  const style = collectStyle(input.folder);
  const { chunks, maxChars } = chunksOfWorkFile(
    input.folder,
    input.filePath,
    input.numCtx
  );

  return {
    promptVersion: PROOFREAD_VERSION,
    systemPrompt: PROOFREAD_SYSTEM_PROMPT,
    schema: PROOFREAD_SCHEMA,
    temperature: PROOFREAD_TEMPERATURE,
    styleNote: style.styleNote,
    narrativeStyle: style.narrativeStyle,
    maxIssuesPer1000Chars: MAX_ISSUES_PER_1000_CHARS,
    validateWith: VALIDATE_WITH,
    chunks: selectChunks(chunks, input.chunkIndex).map((chunk) =>
      promptForChunk(input.filePath, chunk, maxChars, style)
    ),
  };
}

function promptForChunk(
  relative: string,
  chunk: Chunk,
  maxChars: number,
  style: WorkStyle
): ProofreadChunkPrompt {
  const maxIssues = issueBudget(chunk.text.length);
  return {
    chunkId: chunkIdOf(relative, chunk, maxChars),
    index: chunk.index,
    chapterLabel: chapterLabelOf(chunk),
    chars: chunk.text.length,
    maxIssues,
    userPrompt: buildProofreadPrompt({
      chunkTextWithLineNumbers: withLineNumbers(chunk),
      narrativeStyle: style.narrativeStyle,
      styleNote: style.styleNote,
      maxIssues,
    }),
  };
}

export interface ProofreadValidateResult {
  chunkId: string;
  chapterLabel: string;
  accepted: AcceptedProofreadIssue[];
  rejected: RejectedProofreadIssue[];
}

export function proofreadValidate(input: {
  folder: string;
  chunkId: string;
  response: string;
}): ProofreadValidateResult {
  const chunk = chunkFromId(input.folder, input.chunkId);
  const style = collectStyle(input.folder);
  return validateAgainst(input.chunkId, chunk, input.response, style);
}

/**
 * 応答を検算する。
 *
 * **解析も製品のもの**（`parseProofreadResult`）。構造化出力でも前後に
 * 説明やコードフェンスが付くモデルがあるので、ここを自前で書くと
 * 「製品では通る応答が MCP では捨てられる」という差ができる。
 */
function validateAgainst(
  chunkId: string,
  chunk: Chunk,
  response: string,
  style: WorkStyle
): ProofreadValidateResult {
  const parsed = parseProofreadResult(response);
  if (!parsed) {
    throw new McpToolError(
      "応答を読み取れませんでした（推敲のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }
  // **作者が「直さない」と決めた語を渡す。** 推敲は原文まるごとを
  // 置き換えるので、守る語が原文に含まれていたらその指摘ごと出さない
  const result = validateProofreadIssues(parsed, chunk, style.keepWords);
  return {
    chunkId,
    chapterLabel: chapterLabelOf(chunk),
    accepted: result.accepted,
    rejected: result.rejected,
  };
}

export interface ProofreadRunInput extends ProofreadPromptInput {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  temperature?: number;
}

export async function proofreadRun(input: ProofreadRunInput): Promise<
  RunOutcome<ProofreadChunkPrompt, ProofreadValidateResult> & {
    /**
     * 語り手の名前が地の文に出る所（設計書6.9.2）。**AIを呼ばずに数えた**もの。
     * 製品はこれを推敲の結果へ「視点」の札で混ぜて出す。**空でも欄は出す**
     */
    narratorSlips: NarratorSlipScan;
  }
> {
  const prompts = proofreadPrompt(input);
  // **作法は1回だけ集める**（チャンクごとに読み直さない）
  const style = collectStyle(input.folder);
  const narratorSlips = scanNarratorSlips(input.folder, input.filePath);

  // 行き先ごとの分岐は `runByRunner` が持つ（設計書6.87.12）
  const outcome = await runByRunner(
    input,
    prompts,
    VALIDATE_WITH,
    (chunkId, responseText) =>
      validateAgainst(
        chunkId,
        chunkFromId(input.folder, chunkId),
        responseText,
        style
      ),
    ollamaGenerate,
    {
      folder: input.folder,
      // **製品と同じ鍵**（`features/checkProofread.ts` の `cacheKeyBase`）
      feature: "proofread",
      promptVersion: PROOFREAD_VERSION,
      hashOf: (chunkId) => chunkFromId(input.folder, chunkId).hash,
      parse: (responseText) => parseProofreadResult(responseText),
    }
  );
  return { ...outcome, narratorSlips };
}
