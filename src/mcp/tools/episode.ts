import fs from "node:fs";
import * as nodePath from "node:path";
import {
  SYNOPSIS_SCHEMA,
  SYNOPSIS_SYSTEM_PROMPT,
  SYNOPSIS_TEMPERATURE,
  SYNOPSIS_VERSION,
  buildSynopsisPrompt,
} from "../../prompts/synopsis";
import {
  parseSynopsisResult,
  validateSynopsisResult,
} from "../../core/synopsisValidation";
import {
  DEVIATION_CHECK_SCHEMA,
  DEVIATION_CHECK_SYSTEM_PROMPT,
  DEVIATION_CHECK_TEMPERATURE,
  DEVIATION_CHECK_VERSION,
  DEVIATION_TYPES,
  buildDeviationCheckPrompt,
} from "../../prompts/deviationCheck";
import {
  parseDeviationResult,
  validateDeviations,
} from "../../core/deviationValidation";
import {
  describePlotTrim,
  trimPlotForDeviation,
} from "../../core/plotForDeviation";
import {
  EPISODE_PLOT_CHECK_SCHEMA,
  EPISODE_PLOT_CHECK_SYSTEM_PROMPT,
  EPISODE_PLOT_CHECK_TEMPERATURE,
  EPISODE_PLOT_CHECK_VERSION,
  buildEpisodePlotCheckPrompt,
} from "../../prompts/episodePlotCheck";
import {
  parseEpisodePlotFindings,
  validateEpisodePlotCheck,
} from "../../core/episodePlotValidation";
import {
  isEpisodePlotWritten,
  parseEpisodePlot,
} from "../../core/episodePlotDoc";
import { parseSynopsisSet } from "../../models/synopsis";
import { parseCharacter } from "../../models/character";
import { withLineNumbers, type Chunk } from "../../core/chunker";
import { episodeBodySources } from "../../core/episodeChunks";
import { parseEpisodeFileName } from "../../core/episodeParser";
import {
  McpToolError,
  SETTINGS_SUBDIRS,
  SYNOPSES_FILE,
  readBody,
  readPlotMarkdown,
  readSettingsFile,
  readSettingsRecords,
  resolveInsideFolder,
} from "./shared";
import {
  runOnce,
  type RunnerInput,
  validateWith,
} from "./run";

/**
 * 話ごとに見る3つ——**各話あらすじ（P-06）・プロット逸脱（P-11）・
 * 単話プロットの緩み（P-27）**——を外から呼ぶ（設計書6.87.8 の4）。
 *
 * **1つのファイルにまとめたのは、材料の集め方が同じだから。** どれも
 * チャンクに切らず、**話を丸ごと**渡す。切ると、話の筋を見る判断
 * （あらすじ・逸脱・展開の緩み）が成り立たない。
 *
 * **並びは製品のまま**（6.87.6 の3）。材料 → プロンプト → 応答は
 * 製品の検算（`validateSynopsisResult` / `validateDeviations` /
 * `validateEpisodePlotFindings`）へ通す。
 *
 * **書き戻さない**（6.87.7）。あらすじを台帳へ入れることも、
 * 単話プロットを直すこともしない。
 */

/** 話をまるごと取り出す。**合本なら、指された話だけ** */
function readEpisode(
  folder: string,
  filePath: string,
  chapter?: number
): { label: string; body: string; chapter: number | null } {
  const text = readBody(folder, filePath);
  const parsed = parseEpisodeFileName(nodePath.basename(filePath));
  const sources = episodeBodySources(filePath, text, {
    chapterStart: parsed.chapterStart,
    chapterEnd: parsed.chapterEnd,
  });
  if (sources.length === 0) {
    throw new McpToolError("その本文から話を取り出せませんでした。");
  }
  const picked =
    chapter === undefined
      ? sources[0]
      : sources.find((source) => source.chapterStart === chapter);
  if (!picked) {
    throw new McpToolError(
      `第${chapter}話が、そのファイルの中に見つかりませんでした` +
        `（入っているのは ${sources
          .map((source) => source.chapterStart ?? "?")
          .join("・")} 話です）。`
    );
  }
  return {
    label:
      picked.chapterStart === null || picked.chapterStart === undefined
        ? nodePath.basename(filePath)
        : `第${picked.chapterStart}話`,
    body: picked.body,
    chapter: picked.chapterStart ?? null,
  };
}

/** 検算は本文の位置で行うので、話の本文から `Chunk` を1つ作る */
function chunkOfEpisode(filePath: string, body: string): Chunk {
  return {
    filePath,
    index: 0,
    text: body,
    startLine: 0,
    chapterStart: null,
    chapterEnd: null,
    hash: "",
  } as unknown as Chunk;
}

function readSynopses(
  folder: string
): Array<{ chapter: number | null; synopsis: string }> {
  const raw = readSettingsFile(folder, SYNOPSES_FILE);
  if (raw === undefined) return [];
  try {
    return parseSynopsisSet(raw).episodes.map((item) => ({
      chapter: item.chapter,
      synopsis: item.synopsis,
    }));
  } catch {
    // 壊れていても止めない（材料が痩せるだけ）
    return [];
  }
}

function readCharacterNames(folder: string): string[] {
  return readSettingsRecords(
    folder,
    SETTINGS_SUBDIRS.characters,
    parseCharacter
  ).records.map((record) => record.name);
}

/* ── 各話あらすじ（P-06）──────────────────────────── */

const SYNOPSIS_VALIDATE_WITH = validateWith("synopsis");

/** 前話までのあらすじを、何件まで渡すか（多すぎると本文が入らない） */
const PREVIOUS_SYNOPSIS_LIMIT = 10;

export interface EpisodePromptInput {
  folder: string;
  filePath: string;
  chapter?: number;
  needsSubtitle?: boolean;
}

export function synopsisPrompt(input: EpisodePromptInput) {
  const episode = readEpisode(input.folder, input.filePath, input.chapter);
  const synopses = readSynopses(input.folder);

  // **前の話までのあらすじだけ渡す。** 先の話を渡すと、まだ書いていない
  // ことを踏まえた要約になる
  const previous = synopses
    .filter(
      (item) =>
        episode.chapter === null ||
        (item.chapter !== null && item.chapter < episode.chapter)
    )
    .slice(-PREVIOUS_SYNOPSIS_LIMIT)
    .map((item) =>
      item.chapter === null
        ? item.synopsis
        : `第${item.chapter}話：${item.synopsis}`
    );

  return {
    promptVersion: SYNOPSIS_VERSION,
    systemPrompt: SYNOPSIS_SYSTEM_PROMPT,
    schema: SYNOPSIS_SCHEMA,
    temperature: SYNOPSIS_TEMPERATURE,
    validateWith: SYNOPSIS_VALIDATE_WITH,
    chapterLabel: episode.label,
    previousCount: previous.length,
    userPrompt: buildSynopsisPrompt({
      chapterLabel: episode.label,
      chapterText: episode.body,
      previousSynopses: previous,
      characterNames: readCharacterNames(input.folder),
      needsSubtitle: input.needsSubtitle === true,
    }),
  };
}

export function synopsisValidate(input: {
  folder: string;
  filePath: string;
  chapter?: number;
  response: string;
}) {
  // **解析も製品のもの**（前後に説明が付くモデルがある）
  const parsed = parseSynopsisResult(input.response);
  if (!parsed) {
    throw new McpToolError(
      "応答を読み取れませんでした（あらすじのスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }
  return validateSynopsisResult(parsed);
}

/* ── プロット逸脱（P-11）────────────────────────────── */

const DEVIATION_VALIDATE_WITH = validateWith("deviation");

/** 1話で挙げてよい件数。**製品と同じ考え方で、多すぎると読まれない** */
const DEVIATION_MAX_ISSUES = 5;

export function deviationPrompt(input: EpisodePromptInput) {
  const plot = readPlotMarkdown(input.folder);
  if (!plot) {
    // **プロットが無ければ、逸脱は測れない。** 黙って空のプロットで
    // 問うと、AIが「筋書きが無い」ことを逸脱として挙げ始める
    throw new McpToolError(
      "プロット（設定/plot.md）が見つかりません。逸脱はプロットと突き合わせる機能なので、" +
        "プロットが無いままでは測れません。"
    );
  }
  const episode = readEpisode(input.folder, input.filePath, input.chapter);
  const synopses = readSynopses(input.folder);

  // 前後の話のあらすじ。無ければ空文字（製品と同じ）
  const surrounding =
    episode.chapter === null
      ? ""
      : synopses
          .filter(
            (item) =>
              item.chapter !== null &&
              Math.abs(item.chapter - episode.chapter!) === 1
          )
          .map((item) => `第${item.chapter}話：${item.synopsis}`)
          .join("\n");

  /*
    **プロットも製品と同じところで切る**（`core/plotForDeviation.ts`、0.66.4）。
    ここは `readPlotMarkdown` の全文をそのまま渡しており、76,471字の
    プロットでも切らず、切ったことも知らせていなかった——**製品の経路を
    迂回していた**（CLAUDE.md の「繰り返し起きた失敗」5番）。

    **コンテキスト長は使わない。** モデル比で縮める側（`plotMaxChars`）は
    送り先のモデルが分かって初めて決まるもので、この口では行き先が
    `ollama`／`claude`／`sampling` のどれにもなりうる。頭打ち
    （`PLOT_MAX_CHARS`）だけを効かせ、**切ったことは返り値で知らせる**。
  */
  const plotTrim = trimPlotForDeviation(plot);

  return {
    promptVersion: DEVIATION_CHECK_VERSION,
    systemPrompt: DEVIATION_CHECK_SYSTEM_PROMPT,
    schema: DEVIATION_CHECK_SCHEMA,
    temperature: DEVIATION_CHECK_TEMPERATURE,
    validateWith: DEVIATION_VALIDATE_WITH,
    chapterLabel: episode.label,
    maxIssues: DEVIATION_MAX_ISSUES,
    /** プロットの全体の字数（切る前） */
    plotChars: plot.length,
    /** 実際に送った字数 */
    usedPlotChars: plotTrim.usedChars,
    plotTrimmed: plotTrim.trimmed,
    // **切ったときだけ言う。** 切っていないのに断ると、毎回の返り値が
    // 案内文で埋まって読まれなくなる
    ...(plotTrim.trimmed
      ? { note: describePlotTrim(plotTrim.usedChars, plot.length) }
      : {}),
    userPrompt: buildDeviationCheckPrompt({
      chapterLabel: episode.label,
      plot: plotTrim.text,
      chapterTextWithLineNumbers: withLineNumbers(
        chunkOfEpisode(input.filePath, episode.body)
      ),
      surroundingSynopses: surrounding,
      types: DEVIATION_TYPES,
      maxIssues: DEVIATION_MAX_ISSUES,
    }),
  };
}

export function deviationValidate(input: {
  folder: string;
  filePath: string;
  chapter?: number;
  response: string;
}) {
  const episode = readEpisode(input.folder, input.filePath, input.chapter);
  const plot = readPlotMarkdown(input.folder);
  if (!plot) {
    throw new McpToolError(
      "プロット（設定/plot.md）が見つかりません。逸脱はプロットと突き合わせる機能です。"
    );
  }
  /*
    **先にパースする。** `validateDeviations` は `unknown` を受け取り、
    形が合わなければ黙って空を返す作りなので、**JSONの文字列をそのまま
    渡すと、どんな応答でも「逸脱0件」になり、例外も出ない**。
    製品（`features/checkDeviations.ts`）は `parseDeviationResult` を
    通してから渡しており、ここだけがその手順を欠いていた（0.64.3で直した）。

    これは「何も指摘しない実装が満点になる」形そのものである
    （CLAUDE.md の「繰り返し起きた失敗」2番）。
  */
  const parsed = parseDeviationResult(input.response);
  if (!parsed) {
    throw new McpToolError(
      "応答を読み取れませんでした（プロット逸脱のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }
  return validateDeviations(parsed, {
    text: episode.body,
    /*
      **照らすのは「送ったプロット」である**（製品の `checkDeviations.ts` と
      同じ）。全文で照らすと、切り落とした先の一節を引いた指摘まで通ってしまい、
      **AIが見ていない箇所を当てた**ことになる。`deviationPrompt` が切るように
      なった以上、こちらも同じ相手を見る（0.66.4）。
    */
    plot: trimPlotForDeviation(plot).text,
  });
}

/* ── 単話プロットの緩み（P-27）───────────────────────── */

const EPISODE_PLOT_VALIDATE_WITH = validateWith("episodePlot");

/** 1話で挙げてよい件数 */
const EPISODE_PLOT_MAX_FINDINGS = 5;

export interface EpisodePlotPromptInput {
  folder: string;
  plotPath: string;
  chapterLabel?: string;
}

function readEpisodePlotDoc(input: EpisodePlotPromptInput) {
  // **作品フォルダーの外は読まない**（`shared.ts` の守り）
  const absolute = resolveInsideFolder(input.folder, input.plotPath);
  let text: string;
  try {
    /*
      **静的 import で読む。** 束は ESM なので、`require("node:fs")` は
      **束ねた後に実行時だけ落ちる**（"Dynamic require of node:fs is not
      supported"）。**単体テストでは通ってしまう**ので気づけない。
      実機で叩いて見つけた（0.64.3）。
    */
    text = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    throw new McpToolError(
      `単話プロットを読めませんでした（${
        error instanceof Error ? error.message : String(error)
      }）。`
    );
  }
  const doc = parseEpisodePlot(text);
  if (!isEpisodePlotWritten(doc)) {
    // **空のまま問わない。** 展開が書かれていないものに「緩みは？」と
    // 聞くと、書いていないこと自体を指摘として並べ始める
    throw new McpToolError(
      "単話プロットに、展開（箇条書き）がまだ書かれていません。"
    );
  }
  return doc;
}

export function episodePlotPrompt(input: EpisodePlotPromptInput) {
  const doc = readEpisodePlotDoc(input);
  const label = input.chapterLabel ?? nodePath.basename(input.plotPath);

  return {
    promptVersion: EPISODE_PLOT_CHECK_VERSION,
    systemPrompt: EPISODE_PLOT_CHECK_SYSTEM_PROMPT,
    schema: EPISODE_PLOT_CHECK_SCHEMA,
    temperature: EPISODE_PLOT_CHECK_TEMPERATURE,
    validateWith: EPISODE_PLOT_VALIDATE_WITH,
    chapterLabel: label,
    itemCount: doc.items.length,
    userPrompt: buildEpisodePlotCheckPrompt({
      chapterLabel: label,
      viewpoint: doc.viewpoint,
      goal: doc.goal,
      items: doc.items.map((item) => item.text),
      maxFindings: EPISODE_PLOT_MAX_FINDINGS,
    }),
  };
}

export function episodePlotValidate(
  input: EpisodePlotPromptInput & { response: string }
) {
  const doc = readEpisodePlotDoc(input);
  const parsed = parseEpisodePlotFindings(input.response);
  return validateEpisodePlotCheck(parsed, {
    items: doc.items,
    maxFindings: EPISODE_PLOT_MAX_FINDINGS,
  });
}

/* ── runner（3つとも同じ形）────────────────────────── */


export async function synopsisRun(input: EpisodePromptInput & RunnerInput) {
  return runOnce(input, synopsisPrompt(input), (response) =>
    synopsisValidate({ ...input, response })
  );
}

export async function deviationRun(input: EpisodePromptInput & RunnerInput) {
  const prompt = deviationPrompt(input);
  const outcome = await runOnce(input, prompt, (response) =>
    deviationValidate({ ...input, response })
  );
  /*
    **切ったことは `run` でも知らせる**（0.66.4）。`prompt` だけが知っていると、
    `run` で回した人には「プロットを全部見たうえでの0件」に見える。
    `runOnce` の返り値の形は壊さず、プロット側の情報を足すだけにしてある。
  */
  const plotInfo = {
    plotChars: prompt.plotChars,
    usedPlotChars: prompt.usedPlotChars,
    plotTrimmed: prompt.plotTrimmed,
  };
  if (!prompt.note) return { ...outcome, ...plotInfo };
  // `claude` の道は `runOnce` が案内文（`note`）を持っている。
  // **上書きしない**——応答をどこへ戻すかの案内が消える
  const runnerNote = "note" in outcome ? outcome.note : undefined;
  return {
    ...outcome,
    ...plotInfo,
    note: runnerNote ? `${runnerNote}\n${prompt.note}` : prompt.note,
  };
}

export async function episodePlotRun(
  input: EpisodePlotPromptInput & RunnerInput
) {
  return runOnce(input, episodePlotPrompt(input), (response) =>
    episodePlotValidate({ ...input, response })
  );
}
