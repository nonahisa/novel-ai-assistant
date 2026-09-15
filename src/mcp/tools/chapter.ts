import * as nodePath from "node:path";
import { z } from "zod";
import {
  CHAPTER_PROPOSE_SCHEMA,
  CHAPTER_PROPOSE_SYSTEM_PROMPT,
  CHAPTER_PROPOSE_VERSION,
  buildChapterProposePrompt,
  type ChapterProposeEpisode,
} from "../../prompts/chapterPropose";
import {
  parseChapterProposeResult,
  validateChapterNames,
  validateChapterProposal,
} from "../../core/chapterProposalValidation";
import {
  CHAPTERS_FILE,
  parseChapterSet,
  type Chapter,
} from "../../models/chapter";
import { findSynopsis, parseSynopsisSet } from "../../models/synopsis";
import {
  FOLDER_INPUT,
  McpToolError,
  OLLAMA_INPUT,
  RUNNER_INPUT,
  SYNOPSES_FILE,
  readSettingsFile,
  workTitleOf,
} from "./shared";
import { workScan } from "./workScan";
import { responseInput, runOnce, type RunnerInput } from "./run";

/**
 * 章立ての提案（P-31。設計書6.66.4）を外から呼ぶ（0.66.0）。
 *
 * **区切りの判断は、話の並びの上でしか行えない。** だから合本も
 * 話ごとに並べて渡す——`work.scan` が既にそうしているので、材料は
 * そこから組む（**別の走り方を新しく書かない**。書くと、合本の作品で
 * だけ材料が痩せる。製品側では、219話入りの合本から1件しか渡らず
 * **218話ぶんが消えていた**ことが実際にあった）。
 *
 * **番号の読めない話は渡さない。** 開始点として指せないので、渡すと
 * 存在しない番号を作られるだけである（`prompts/chapterPropose.ts`）。
 *
 * **台帳は書き換えない**（6.87.7）。`設定/章立て.json` への反映は
 * 作者の操作で行う。
 */

const VALIDATE_WITH = "chapter.proposeValidate";

const CHAPTER_INPUT = {
  ...FOLDER_INPUT,
  nameOnly: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "章名だけを、この件数ぶん出させる（区切りは動かしません）。省略すると区切りから提案します"
    ),
};

export const CHAPTER_PROMPT_INPUT = { ...CHAPTER_INPUT };

export const CHAPTER_VALIDATE_INPUT = {
  ...CHAPTER_INPUT,
  response: responseInput(),
};

export const CHAPTER_RUN_INPUT = {
  ...CHAPTER_INPUT,
  ...RUNNER_INPUT,
  ...OLLAMA_INPUT,
};

export interface ChapterPromptInput {
  folder: string;
  nameOnly?: number;
}

/** いまの章立て。無くても止めない（初めて組むときは空である） */
function readChapters(folder: string): Chapter[] {
  const raw = readSettingsFile(folder, CHAPTERS_FILE);
  if (raw === undefined || raw === null) return [];
  try {
    // 読み込みは済んでいる（`readSettingsFile` が JSON を解いて返す）
    return parseChapterSet(raw).chapters;
  } catch {
    // **壊れていても止めない**（材料が1つ減るだけ）
    return [];
  }
}

/**
 * 話の一覧を組む。**番号の読める話だけ**を、話数の順に並べる。
 *
 * あらすじは話数で引ける（`models/synopsis.ts` の `synopsisKey`）。
 * 合本の中の話も、合本ファイルの名前と話数で同じ1件に当たる。
 */
function buildEpisodes(folder: string): ChapterProposeEpisode[] {
  const scanned = workScan({ folder }).episodes;
  const raw = readSettingsFile(folder, SYNOPSES_FILE);
  let synopses;
  try {
    synopses = raw === undefined ? undefined : parseSynopsisSet(raw);
  } catch {
    synopses = undefined;
  }

  const seen = new Set<number>();
  const episodes: ChapterProposeEpisode[] = [];
  for (const episode of scanned) {
    if (episode.chapter === null) continue;
    // 同じ話数のファイルが2つあることがある（合本と単話が並ぶなど）。
    // **先に見つかったほうを使う**——番号は1つの話しか指せない
    if (seen.has(episode.chapter)) continue;
    seen.add(episode.chapter);
    episodes.push({
      number: episode.chapter,
      label: `第${episode.chapter}話`,
      subtitle: (episode.title ?? "").trim(),
      synopsis: synopses
        ? (findSynopsis(
            synopses,
            nodePath.basename(episode.filePath),
            episode.chapter
          )?.synopsis ?? "")
        : "",
    });
  }
  // **話数の順に並べて渡す。** 区切りの判断がこの並びに乗る
  episodes.sort((left, right) => left.number - right.number);
  return episodes;
}

/** 章の開始（ファイルのパス）を、話数へ直す */
function currentChapters(
  folder: string,
  episodes: readonly ChapterProposeEpisode[]
): Array<{ name: string; startEpisode: number | null }> {
  const scanned = workScan({ folder }).episodes;
  return readChapters(folder).map((chapter) => {
    const found = scanned.find(
      (episode) =>
        episode.filePath.replace(/\\/g, "/") ===
        chapter.startEpisodePath.replace(/\\/g, "/")
    );
    const number = found?.chapter ?? null;
    return {
      name: chapter.name,
      // 一覧に無い話数は指しようがない（**並び順で埋めない**）
      startEpisode:
        number !== null && episodes.some((item) => item.number === number)
          ? number
          : null,
    };
  });
}

export function chapterPrompt(input: ChapterPromptInput) {
  const episodes = buildEpisodes(input.folder);
  if (episodes.length === 0) {
    throw new McpToolError(
      "話数の読める本文が見つかりません。章の区切りは話数の並びの上で決めるので、" +
        "ファイル名から話数が読める形（`004_…`）にしてから実行してください。"
    );
  }

  return {
    promptVersion: CHAPTER_PROPOSE_VERSION,
    systemPrompt: CHAPTER_PROPOSE_SYSTEM_PROMPT,
    schema: CHAPTER_PROPOSE_SCHEMA,
    validateWith: VALIDATE_WITH,
    /** 何話を材料にしたか。**合本が痩せていないかを、ここで見られる** */
    episodeCount: episodes.length,
    synopsisCount: episodes.filter((episode) => episode.synopsis).length,
    userPrompt: buildChapterProposePrompt({
      workTitle: workTitleOf(input.folder),
      episodes,
      current: currentChapters(input.folder, episodes),
      ...(input.nameOnly === undefined
        ? {}
        : { nameOnly: { maxSuggestions: input.nameOnly } }),
    }),
  };
}

export function chapterValidate(input: ChapterPromptInput & { response: string }) {
  const parsed = parseChapterProposeResult(input.response);
  if (!parsed) {
    throw new McpToolError(
      "応答を読み取れませんでした（章立てのスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }

  const episodes = buildEpisodes(input.folder);
  /*
    **名前だけのときと、区切りごとのときで、検算が違う。** 前者は
    区切りを動かさないので、確かめるのは名前の形だけである。
  */
  if (input.nameOnly !== undefined) {
    const names = validateChapterNames(
      parsed,
      episodes.map((episode) => episode.number),
      input.nameOnly
    );
    return {
      mode: "nameOnly" as const,
      names: names.names,
      rejected: names.rejected,
      note:
        "章名の案だけを返しました（区切りは動かしていません）。" +
        "設定/章立て.json は書き換えていません。",
    };
  }

  const result = validateChapterProposal(
    parsed,
    episodes.map((episode) => episode.number)
  );
  return {
    mode: "chapters" as const,
    chapters: result.accepted,
    /** 落とした提案と、その理由。**黙って減らさない** */
    rejected: result.rejected,
    note:
      "区切りは、実在する話数だけに限って通しました" +
      "（AIが出した番号をそのまま使ってはいません）。" +
      "設定/章立て.json は書き換えていません。",
  };
}

export async function chapterRun(input: ChapterPromptInput & RunnerInput) {
  return runOnce(input, chapterPrompt(input), (response) =>
    chapterValidate({ ...input, response })
  );
}
