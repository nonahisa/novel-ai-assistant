import {
  BLURB_MAX_CHARS,
  BLURB_MIN_CHARS,
  BLURB_SCHEMA,
  BLURB_SYSTEM_PROMPT,
  BLURB_VERSION,
  CATCHPHRASE_COUNT,
  CATCHPHRASE_MAX_CHARS,
  CATCHPHRASE_SCHEMA,
  buildBlurbPrompt,
  buildCatchphrasePrompt,
} from "../../prompts/blurb";
import {
  measureBlurb,
  parseBlurbResponse,
  parseCatchphraseResponse,
  screenCatchphrases,
} from "../../core/blurbValidation";
import { parseSynopsisSet } from "../../models/synopsis";
import {
  McpToolError,
  SYNOPSES_FILE,
  orderedEpisodeBodies,
  readPlotMarkdown,
  readSettingsFile,
  workTitleOf,
} from "./shared";
import {
  runOnce,
  validateWith,
  type RunnerInput,
} from "./run";

/**
 * 作品紹介文（P-06）とキャッチコピー（P-08）を外から呼ぶ（0.66.0）。
 *
 * **投稿サイトの入力欄に貼るものである。** だから**字数はコードで測り直す**
 * （CLAUDE.md 規則3）——AIは「300〜400字」と言われても外す。超えたまま
 * 返して困るのは、貼ったところで弾かれる作者である。
 *
 * **短すぎるほうも見る。** 長いほうだけを見ると、**1行で終わった紹介文が
 * 満点で通る**（「見逃しと誤検出の両方を測る」と同じ考え）。
 *
 * **書き戻さない**（6.87.7）。紹介文もキャッチコピーも、どれを採るかは
 * 作者が決める。
 */

/** 冒頭に渡す字数（`features/generateBlurb.ts` と同じ） */
const OPENING_EXCERPT_CHARS = 6_000;
/** 渡すあらすじの件数（多いと本文が入らない） */
const SYNOPSES_LIMIT = 30;

export interface BlurbPromptInput {
  folder: string;
}

export interface CatchphrasePromptInput {
  folder: string;
  blurb?: string;
  rejected?: string[];
}

/**
 * 冒頭を上限まで詰める。
 *
 * **作品の雰囲気を渡すための材料**なので、話の途中で切れてよい。
 * 合本でも話ごとに分けてから詰める（`episodeBodySources`）。
 */
function readOpeningExcerpt(folder: string): string {
  // **話数の順に詰める**（名前順だと `about.txt` が先頭に来る。0.66.0）
  let excerpt = "";
  for (const episode of orderedEpisodeBodies(folder)) {
    if (excerpt.length >= OPENING_EXCERPT_CHARS) break;
    excerpt += `${episode.body}\n\n`;
  }
  if (!excerpt.trim()) {
    throw new McpToolError("読める本文がありません。");
  }
  return excerpt.slice(0, OPENING_EXCERPT_CHARS);
}

/** 各話あらすじ。**前半だけ渡す**（終盤まで渡すと、紹介文に結末が混ざる） */
function readSynopses(folder: string): string[] {
  const raw = readSettingsFile(folder, SYNOPSES_FILE);
  if (raw === undefined) return [];
  try {
    return parseSynopsisSet(raw)
      .episodes.slice(0, SYNOPSES_LIMIT)
      .map((item) =>
        item.chapter !== null
          ? `第${item.chapter}話: ${item.synopsis}`
          : item.synopsis
      );
  } catch {
    return [];
  }
}

export function blurbPrompt(input: BlurbPromptInput) {
  const synopses = readSynopses(input.folder);
  return {
    promptVersion: BLURB_VERSION,
    systemPrompt: BLURB_SYSTEM_PROMPT,
    schema: BLURB_SCHEMA,
    validateWith: validateWith("blurb"),
    synopsisCount: synopses.length,
    /** 何字で書かせるか。**呼ぶ側にも見せる**（検算と同じ数字である） */
    targetChars: { min: BLURB_MIN_CHARS, max: BLURB_MAX_CHARS },
    userPrompt: buildBlurbPrompt({
      workTitle: workTitleOf(input.folder),
      plot: readPlotMarkdown(input.folder) ?? "",
      openingExcerpt: readOpeningExcerpt(input.folder),
      chapterSynopses: synopses,
    }),
  };
}

export function blurbValidate(input: { response: string }) {
  const parsed = parseBlurbResponse(input.response);
  if (!parsed) {
    throw new McpToolError(
      "応答を読み取れませんでした（紹介文のスキーマに沿っていません。JSONの形か、項目が合っていません）。"
    );
  }
  const measured = measureBlurb(parsed.blurb);
  return {
    blurb: parsed.blurb,
    /** 伏せた要素についてのAIの申告。**そのまま信じる材料ではない** */
    spoilerCheck: parsed.spoilerCheck,
    chars: measured.chars,
    /*
      **字数はコードで測り直す**（規則3）。捨てはしない——投稿サイトに
      よって上限が違うので、**超えたことを伝えて作者に決めさせる。**
    */
    tooShort: measured.tooShort,
    tooLong: measured.tooLong,
    targetChars: { min: BLURB_MIN_CHARS, max: BLURB_MAX_CHARS },
    note:
      measured.tooShort || measured.tooLong
        ? `目安（${BLURB_MIN_CHARS}〜${BLURB_MAX_CHARS}字）から外れています（${measured.chars}字）。捨てずに返しています——投稿サイトによって上限が違うためです。何も書き換えていません。`
        : "何も書き換えていません（どれを使うかは作者が決めます）。",
  };
}

export async function blurbRun(input: BlurbPromptInput & RunnerInput) {
  return runOnce(input, blurbPrompt(input), (response) =>
    blurbValidate({ response })
  );
}

export function catchphrasePrompt(input: CatchphrasePromptInput) {
  return {
    promptVersion: BLURB_VERSION,
    systemPrompt: BLURB_SYSTEM_PROMPT,
    schema: CATCHPHRASE_SCHEMA,
    validateWith: validateWith("catchphrase"),
    asked: CATCHPHRASE_COUNT,
    maxChars: CATCHPHRASE_MAX_CHARS,
    userPrompt: buildCatchphrasePrompt({
      workTitle: workTitleOf(input.folder),
      plot: readPlotMarkdown(input.folder) ?? "",
      blurb: input.blurb ?? "",
      openingExcerpt: readOpeningExcerpt(input.folder),
      rejected: input.rejected ?? [],
    }),
  };
}

export function catchphraseValidate(input: { response: string }) {
  const candidates = parseCatchphraseResponse(input.response);
  if (candidates.length === 0) {
    throw new McpToolError(
      "応答から案を読み取れませんでした（キャッチコピーのスキーマに沿っていません）。"
    );
  }
  /*
    **字数はコードで測る**（規則3）。一覧に並ぶものなので、ここは
    紹介文と違って**超えたら落とす**——貼れない案を選ばせても仕方がない。
  */
  const screened = screenCatchphrases(candidates);
  return {
    candidates: screened.kept,
    /** 落とした案と、その理由。**黙って減らさない** */
    dropped: screened.dropped,
    asked: CATCHPHRASE_COUNT,
    maxChars: CATCHPHRASE_MAX_CHARS,
    note:
      `${CATCHPHRASE_MAX_CHARS}字に収まる案だけを残しました。` +
      "何も書き換えていません（どれを使うかは作者が決めます）。",
  };
}

export async function catchphraseRun(
  input: CatchphrasePromptInput & RunnerInput
) {
  return runOnce(input, catchphrasePrompt(input), (response) =>
    catchphraseValidate({ response })
  );
}
