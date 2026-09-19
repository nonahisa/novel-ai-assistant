import {
  PLOT_REVERSE_SCHEMA,
  PLOT_REVERSE_SYSTEM_PROMPT,
  PLOT_REVERSE_TEMPERATURE,
  PLOT_REVERSE_VERSION,
  buildPlotReversePrompt,
} from "../../prompts/plotReverse";
import {
  parsePlotReverseResult,
  plotSectionLabel,
  validatePlotReverseResult,
} from "../../core/plotReverseValidation";
import { parseSynopsisSet } from "../../models/synopsis";
import { parseCharacter } from "../../models/character";
import { parseLocation } from "../../models/location";
import { parseWorldItem } from "../../models/world";
import {
  McpToolError,
  SETTINGS_SUBDIRS,
  SYNOPSES_FILE,
  orderedEpisodeBodies,
  readSettingsFile,
  readSettingsRecords,
  workTitleOf,
} from "./shared";
import {
  runOnce,
  validateWith,
  type RunnerInput,
} from "./run";

/**
 * プロット逆算（P-02。設計書6.7）を外から呼ぶ（0.66.0）。
 *
 * **既に書いた本文から、プロットを起こし直す機能である。** 書き始めてから
 * プロットを作る作者のために在る（先に作るものだけがプロットではない）。
 *
 * **あらすじが無ければ断る。** 冒頭だけを見て中盤以降を書かせると、
 * **本文に無い筋書きが混ざる**——製品の画面でも同じところで止めている
 * （`features/generatePlot.ts`）。逸脱検知がプロット無しでは測れないのと
 * 同じで、材料が足りないまま通すと、もっともらしい嘘が返る。
 *
 * **書き戻さない**（6.87.7）。`設定/plot.md` は作者の文書で、
 * 書き戻すときに「作者が既に書いた項目には触れない」判断が要る——
 * それは製品の画面の仕事である。
 */

const VALIDATE_WITH = validateWith("plotReverse");

/** 冒頭に渡す字数（`features/generatePlot.ts` の `PLOT_OPENING_EXCERPT_CHARS` と同じ） */
const OPENING_EXCERPT_CHARS = 3_000;

export interface PlotReversePromptInput {
  folder: string;
}

/** 各話あらすじを話数順に並べる。**逆算の背骨になる材料** */
function readSynopses(folder: string): string[] {
  const raw = readSettingsFile(folder, SYNOPSES_FILE);
  if (raw === undefined) return [];
  try {
    return parseSynopsisSet(raw).episodes.map((item) =>
      item.chapter !== null
        ? `第${item.chapter}話: ${item.synopsis}`
        : item.synopsis
    );
  } catch {
    return [];
  }
}

/**
 * 冒頭を上限まで詰める。
 *
 * **人称と語り口を読み取るための材料**なので、話の途中で切れてよい。
 * 合本でも話ごとに分けてから詰める（`episodeBodySources`）。
 */
function readOpeningExcerpt(folder: string): string {
  // **話数の順に詰める**（名前順だと `about.txt` が先頭に来る。0.66.0）
  let excerpt = "";
  for (const episode of orderedEpisodeBodies(folder)) {
    if (excerpt.length >= OPENING_EXCERPT_CHARS) break;
    excerpt += `${episode.body}\n\n`;
  }
  return excerpt.slice(0, OPENING_EXCERPT_CHARS);
}

export function plotReversePrompt(input: PlotReversePromptInput) {
  const chapterSynopses = readSynopses(input.folder);
  if (chapterSynopses.length === 0) {
    /*
      **材料が足りないまま通さない。** 冒頭だけを見て中盤以降を推測すると、
      本文に無い筋書きが返る——それは「読み取った」ではなく「作った」である。
    */
    throw new McpToolError(
      "各話あらすじ（設定/chapter_synopses.json）がまだありません。" +
        "あらすじが無いと、冒頭だけを見て中盤以降を推測することになり、" +
        "本文に無い筋書きが混ざります。先に episode.synopsisRun で各話あらすじを作ってください。"
    );
  }

  const characters = readSettingsRecords(
    input.folder,
    SETTINGS_SUBDIRS.characters,
    parseCharacter
  ).records;

  return {
    promptVersion: PLOT_REVERSE_VERSION,
    systemPrompt: PLOT_REVERSE_SYSTEM_PROMPT,
    schema: PLOT_REVERSE_SCHEMA,
    temperature: PLOT_REVERSE_TEMPERATURE,
    validateWith: VALIDATE_WITH,
    /** 何話ぶんのあらすじを渡したか。**材料の厚みを返り値に残す** */
    synopsisCount: chapterSynopses.length,
    userPrompt: buildPlotReversePrompt({
      workTitle: workTitleOf(input.folder),
      chapterSynopses,
      openingExcerpt: readOpeningExcerpt(input.folder),
      // **モブは筋を追うのに要らない**（名前が普通名詞になりがちで紛れる）
      characterNames: characters
        .filter((character) => !character.isMob)
        .map((character) => character.name),
      worldItems: readSettingsRecords(
        input.folder,
        SETTINGS_SUBDIRS.world,
        parseWorldItem
      ).records.map((record) => record.name),
      locationNames: readSettingsRecords(
        input.folder,
        SETTINGS_SUBDIRS.locations,
        parseLocation
      ).records.map((record) => record.name),
    }),
  };
}

export function plotReverseValidate(input: { response: string }) {
  const parsed = parsePlotReverseResult(input.response);
  if (!parsed) {
    throw new McpToolError(
      "応答を読み取れませんでした（プロット逆算のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }
  const result = validatePlotReverseResult(parsed);
  return {
    sections: result.sections,
    /** 目安の字数を超えた項目。**捨てずに、超えたことだけ伝える** */
    overLimit: result.overLimit,
    notes: result.notes,
    /** どの節に中身が入ったか（空の節は書き戻す相手がいない） */
    filled: Object.entries(result.sections)
      .filter(([, body]) => typeof body === "string" && body.trim())
      .map(([key]) => plotSectionLabel(key as never)),
    note:
      "読み取った内容を返しただけで、設定/plot.md は書き換えていません" +
      "（プロットは作者の文書なので、書き戻しは作者の操作で行います）。",
  };
}

export async function plotReverseRun(
  input: PlotReversePromptInput & RunnerInput
) {
  return runOnce(input, plotReversePrompt(input), (response) =>
    plotReverseValidate({ response })
  );
}
