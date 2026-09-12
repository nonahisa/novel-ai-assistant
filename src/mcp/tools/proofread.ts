import * as nodePath from "node:path";
import {
  MAX_ISSUES_PER_1000_CHARS,
  PROOFREAD_SCHEMA,
  PROOFREAD_SYSTEM_PROMPT,
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
import { episodeBodySources } from "../../core/episodeChunks";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { parsePlotMarkdown } from "../../core/plotDoc";
import { buildStyleNote, collectWorkStyle } from "../../core/workStyleFacts";
import { parseKeepWordSet, type KeepWord } from "../../models/keepWord";
import {
  CHUNK_INPUT,
  FOLDER_INPUT,
  KEEP_WORDS_FILE,
  McpToolError,
  OLLAMA_INPUT,
  RUNNER_INPUT,
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
  chunkIdInput,
  claudeNote,
  responseInput,
  runChunks,
  type RunOutcome,
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

const VALIDATE_WITH = "proofread.validate";

export const PROOFREAD_PROMPT_INPUT = { ...FOLDER_INPUT, ...CHUNK_INPUT };

export const PROOFREAD_VALIDATE_INPUT = {
  ...FOLDER_INPUT,
  chunkId: chunkIdInput(),
  response: responseInput(),
};

export const PROOFREAD_RUN_INPUT = {
  ...FOLDER_INPUT,
  ...CHUNK_INPUT,
  ...RUNNER_INPUT,
  ...OLLAMA_INPUT,
};

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
  const bodies: string[] = [];
  for (const relative of listBodyFiles(folder)) {
    let text: string;
    try {
      text = readBody(folder, relative);
    } catch {
      // 競合マーカーのあるファイル・読めないファイルは作法の材料から外す。
      // **ここで止めない**——作法が少し痩せるだけで、推敲そのものはできる
      continue;
    }
    const parsed = parseEpisodeFileName(nodePath.basename(relative));
    for (const source of episodeBodySources(relative, text, {
      chapterStart: parsed.chapterStart,
      chapterEnd: parsed.chapterEnd,
    })) {
      bodies.push(blankMemoLines(source.body));
    }
  }

  const plot = readPlotMarkdown(folder);
  const narrativeStyle = plot
    ? parsePlotMarkdown(plot).sections.narrativePerson.trim()
    : "";

  let keepWords: KeepWord[] = [];
  const rawKeepWords = readSettingsFile(folder, KEEP_WORDS_FILE);
  if (rawKeepWords !== undefined) {
    try {
      keepWords = parseKeepWordSet(rawKeepWords).words;
    } catch {
      // 壊れていても直さない・止めない（守る語が無い状態で進む）
      keepWords = [];
    }
  }

  const styleNote = buildStyleNote(
    collectWorkStyle({
      bodyText: bodies.join("\n"),
      narrativePerson: narrativeStyle,
      keepWords: keepWords.map((entry) => entry.word),
    })
  );

  return { narrativeStyle, styleNote, keepWords };
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
      "応答をJSONとして読めませんでした（推敲のスキーマに沿っていません）。"
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
  runner: "ollama" | "claude";
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
}

export async function proofreadRun(
  input: ProofreadRunInput
): Promise<RunOutcome<ProofreadChunkPrompt, ProofreadValidateResult>> {
  // **省略を既定で埋めない**（設計書6.87.8 の5）。手元へ投げるのと
  // Anthropic へ本文を渡すのとでは、作者にとっての意味がまるで違う
  if (input.runner !== "ollama" && input.runner !== "claude") {
    throw new McpToolError(
      "runner を ollama（手元で検算まで通す）か claude（プロンプトだけ返す）で指定してください。既定はありません。"
    );
  }
  const prompts = proofreadPrompt(input);
  if (input.runner === "claude") {
    return {
      runner: "claude",
      note: claudeNote(VALIDATE_WITH),
      systemPrompt: prompts.systemPrompt,
      schema: prompts.schema,
      validateWith: VALIDATE_WITH,
      chunks: prompts.chunks,
    };
  }

  const model = input.model;
  if (!model) {
    throw new McpToolError("runner が ollama のときは model が要ります。");
  }
  const style = collectStyle(input.folder);

  return runChunks(model, prompts.chunks, async (item) => {
    const response = await ollamaGenerate({
      endpoint: input.endpoint,
      model,
      systemPrompt: prompts.systemPrompt,
      userPrompt: item.userPrompt,
      schema: prompts.schema,
      numCtx: input.numCtx,
      allowRemote: input.allowRemote,
    });
    return validateAgainst(
      item.chunkId,
      chunkFromId(input.folder, item.chunkId),
      response.text,
      style
    );
  });
}
