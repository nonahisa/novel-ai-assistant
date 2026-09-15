import {
  OPENING_CHECK_SCHEMA,
  OPENING_CHECK_SYSTEM_PROMPT,
  OPENING_CHECK_VERSION,
  OPENING_EXCERPT_MAX_CHARS,
  buildOpeningCheckPrompt,
  parseOpeningCheck,
} from "../../prompts/openingCheck";
import { isBlankPlotSection, parsePlotMarkdown } from "../../core/plotDoc";
import {
  McpToolError,
  OLLAMA_INPUT,
  RUNNER_INPUT,
  orderedEpisodeBodies,
  readPlotMarkdown,
  workTitleOf,
  FOLDER_INPUT,
} from "./shared";
import { responseInput, runOnce, type RunnerInput } from "./run";

/**
 * 冒頭診断（P-24。設計書6.59）を外から呼ぶ（0.66.0）。
 *
 * **作者の指示（2026-09-16）**：「ありそう部分を実装してください」
 * ——外から呼ぶ値打ちがあると見た5つのうちの1つ。
 *
 * **冒頭は、読者が読むかどうかを決める場所である。** だから第1話の
 * 先頭だけを見る——2話目以降を混ぜると、「冒頭で伝わるか」という
 * 問い自体が崩れる（`features/checkOpening.ts` と同じ考え）。
 *
 * **プロットが無くても止めない。** ジャンルとログラインは材料が1つ減る
 * だけで、診断そのものは冒頭の本文だけでできる。逸脱（P-11）が
 * プロット無しでは測れないのとは、そこが違う。
 */

const VALIDATE_WITH = "opening.validate";

export const OPENING_PROMPT_INPUT = { ...FOLDER_INPUT };

export const OPENING_VALIDATE_INPUT = {
  ...FOLDER_INPUT,
  response: responseInput(),
};

export const OPENING_RUN_INPUT = {
  ...FOLDER_INPUT,
  ...RUNNER_INPUT,
  ...OLLAMA_INPUT,
};

export interface OpeningPromptInput {
  folder: string;
}

/**
 * 第1話の冒頭を取り出す。
 *
 * **合本（1ファイルに全話）でも第1話だけを切り出す。** `episodeBodySources`
 * がその違いを吸収するので、**別の読み方を新しく書かない**——書くと、
 * 片方の形の作品でだけ壊れる。
 */
function readOpening(folder: string): { text: string; from: string } {
  /*
    **話数の順で先頭**を第1話とする（`orderedEpisodeBodies`）。
    名前順の先頭では、カクヨムの `about.txt`（作品情報）を
    診断してしまう——2026-09-16 に作者の実データで実際に起きた。
  */
  const episodes = orderedEpisodeBodies(folder);
  const head = episodes[0];
  if (!head) {
    throw new McpToolError("読める本文が見つかりません。");
  }
  return {
    text: head.body.slice(0, OPENING_EXCERPT_MAX_CHARS),
    from: head.filePath,
  };
}

/** 書かれていない項目（テンプレートの案内だけ）は空として渡す */
function plotValue(body: string | undefined): string {
  if (!body) return "";
  return isBlankPlotSection(body) ? "" : body.trim();
}

export function openingPrompt(input: OpeningPromptInput) {
  const opening = readOpening(input.folder);
  const plot = readPlotMarkdown(input.folder);
  const sections = plot ? parsePlotMarkdown(plot).sections : undefined;

  return {
    promptVersion: OPENING_CHECK_VERSION,
    systemPrompt: OPENING_CHECK_SYSTEM_PROMPT,
    schema: OPENING_CHECK_SCHEMA,
    validateWith: VALIDATE_WITH,
    /** どのファイルの、何字を見たか。**診断の前提を返り値に残す** */
    readFrom: opening.from,
    excerptChars: opening.text.length,
    hasPlot: Boolean(sections),
    userPrompt: buildOpeningCheckPrompt({
      workTitle: workTitleOf(input.folder),
      genre: plotValue(sections?.genre),
      logline: plotValue(sections?.logline),
      openingText: opening.text,
    }),
  };
}

export function openingValidate(input: { response: string }) {
  // **解析も製品のもの**（前後に説明が付くモデルがある）
  const result = parseOpeningCheck(input.response);
  if (!result) {
    throw new McpToolError(
      "応答を読み取れませんでした（冒頭診断のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }
  return result;
}

export async function openingRun(input: OpeningPromptInput & RunnerInput) {
  return runOnce(input, openingPrompt(input), (response) =>
    openingValidate({ response })
  );
}
