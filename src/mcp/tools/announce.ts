import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
  ACTIVITY_REPORT_MAX_CHARS,
  ACTIVITY_REPORT_MIN_CHARS,
  AFTERWORD_MAX_CHARS,
  ANNOUNCE_SCHEMA,
  ANNOUNCE_SYSTEM_PROMPT,
  X_POST_MAX_CHARS,
  announcePromptVersion,
  buildAnnouncePrompt,
} from "../../prompts/announce";
import {
  announceEpisodeLabel,
  composeXPost,
  parseAnnounceResponse,
  validateAnnouncement,
  X_WEIGHTED_LIMIT,
  xWeightedLength,
} from "../../core/announcement";
import {
  ANNOUNCEMENT_HISTORY_SUBPATH,
  formatAnnouncementHistory,
  mergeAnnouncementHistory,
  parseAnnounceConfig,
  parseAnnouncementHistory,
} from "../../core/announceConfig";
import { splitEpisodeBodyParts } from "../../core/episodeBodyParts";
import { parseSynopsisMarkdown, SYNOPSIS_FILE } from "../../core/synopsisDoc";
import {
  findReaderTypeLabels,
  publicityReaderMark,
  publicityReaderNotice,
} from "../../core/publicityReader";
import { parseSynopsisSet } from "../../models/synopsis";
import { AIWRITER_DIR, CONFIG_FILE, type WorkAnnounceConfig } from "../../models/types";
import { decodeBytes } from "../../core/textDecode";
import {
  McpToolError,
  SYNOPSES_FILE,
  readBody,
  readPublicityReader,
  readSettingsFile,
  resolveInsideFolder,
  settingsDirOf,
  workFormatOf,
  workTitleOf,
} from "./shared";
import { readEpisodeFiles } from "./episodeFiles";
import { runOnce, validateWith, type RunnerInput } from "./run";

/**
 * 更新告知文（P-30。設計書6.41）を外から呼ぶ（2026-10-16 の棚卸しの9件目）。
 *
 * **生成だけで、公開は作者。** 告知文はSNSや活動報告へ貼るもので、貼るのは作者である。
 * ここは告知文の案を返すだけで、Xの投稿画面も開かない。作品フォルダーへ書くのは
 * **前に出した告知の履歴**（`.aiwriter/cache/announcements.json`）の1つだけ。
 *
 * **材料は製品の［更新SNS告知文作成］と同じ**（その話の本文・作品紹介文・前の話の
 * あらすじ・前に出した告知・狙いの読者）。読み方も製品と同じ関数を通す
 * （`splitEpisodeBodyParts`・`parseSynopsisMarkdown`・`parseAnnounceConfig`・
 * `parseAnnouncementHistory`）。
 *
 * **履歴へも製品と同じく足す**（作者の裁定 2026-10-16 夜の2）。製品は作った告知を
 * 採用に関わらず履歴へ足し、次の告知で同じ言い回しを避けさせる。外部AIの告知だけ
 * 足さないと、外で作った言い回しを次の告知（製品でも外でも）が繰り返す。足すのは
 * 検算（`announceValidate`）を通った答えだけで、足し方は製品と同じ
 * `mergeAnnouncementHistory`。履歴はキャッシュの置き場（同期しない・作り直せる）で、
 * 原稿・設定資料には触れない
 *
 * 製品と違う点（黙らずに返す）：
 * - **本文を切らない。** 製品はモデルの読める長さから本文の予算を決めて切る。
 *   MCP の各話あらすじ（synopsis）と同じく、その話の本文をまるごと渡す
 *
 * **字数と言葉はコードで検算する**（規則3）。製品と同じ `validateAnnouncement`
 * （Xの重み付き字数・活動報告と後書きの目安・URLやハッシュタグの書き込み・
 * 材料として渡した言葉や読者層の呼び名の混入）を通し、**切り詰めずに注意として返す。**
 */

export interface AnnouncePromptInput {
  folder: string;
  filePath: string;
  /** 合本のときに、どの話か（話数） */
  chapter?: number;
}

interface AnnounceEpisode {
  label: string;
  chapter: number | null;
  body: string;
}

/**
 * その話を取り出す。**製品と同じ切り分け**（合本は中の話ごと・頭書きを外す・
 * シーンメモを消す）と、**製品と同じ見出し**（「第3話「灯を継ぐ」」）。
 */
function readAnnounceEpisode(folder: string, filePath: string, chapter?: number): AnnounceEpisode {
  // 競合の跡は読まずに断る（`readBody` が製品と同じ断り方をする）
  const text = readBody(folder, filePath);
  const absolute = resolveInsideFolder(folder, filePath);
  const file = readEpisodeFiles(folder).episodes.find((episode) => episode.filePath === absolute);
  if (!file) {
    throw new McpToolError(
      `${filePath} は本文のファイルではありません（novel.scan の filePath を渡してください）。`
    );
  }
  const parts = splitEpisodeBodyParts(text, {
    chapter: file.chapterStart,
    title: file.subtitle ?? file.metaTitle,
  });
  if (parts.length === 0) {
    throw new McpToolError(`${filePath} に本文が見つかりませんでした。`);
  }
  const picked =
    chapter === undefined ? parts[0] : parts.find((part) => part.chapter === chapter);
  if (!picked) {
    throw new McpToolError(
      `第${chapter}話が、そのファイルの中に見つかりませんでした` +
        `（入っているのは ${parts.map((part) => part.chapter ?? "?").join("・")} 話です）。`
    );
  }
  return {
    label: announceEpisodeLabel(
      { chapter: picked.chapter, title: picked.title, file },
      workFormatOf(folder)
    ),
    chapter: picked.chapter,
    body: picked.body,
  };
}

/** 作品紹介文（`設定/synopsis.md`）。無ければ空（プロンプト側が印を置く） */
function readBlurb(folder: string): string {
  const settings = settingsDirOf(folder);
  if (!settings) return "";
  try {
    const text = decodeBytes(fs.readFileSync(nodePath.join(settings, SYNOPSIS_FILE))).text;
    return parseSynopsisMarkdown(text).blurb;
  } catch {
    return "";
  }
}

/**
 * 1つ前の話のあらすじ。無ければ空。**話数が読めない話には前後が無い**ので、
 * 想像で近いものを当てない（製品と同じ）。
 */
function readPreviousSynopsis(folder: string, chapter: number | null): string {
  if (chapter === null) return "";
  const raw = readSettingsFile(folder, SYNOPSES_FILE);
  if (raw === undefined) return "";
  try {
    const previous = parseSynopsisSet(raw).episodes.find((item) => item.chapter === chapter - 1);
    return previous?.synopsis.trim() ?? "";
  } catch {
    // あらすじが読めなくても告知は作れる。材料が減るだけ
    return "";
  }
}

function announcementHistoryFileOf(folder: string): string {
  return nodePath.join(nodePath.resolve(folder), AIWRITER_DIR, ...ANNOUNCEMENT_HISTORY_SUBPATH);
}

/** 前に出した告知（`.aiwriter/cache/announcements.json`）。読めなければ空（製品と同じ） */
function readPastAnnouncements(folder: string): string[] {
  try {
    return parseAnnouncementHistory(decodeBytes(fs.readFileSync(announcementHistoryFileOf(folder))).text);
  } catch {
    return [];
  }
}

/**
 * 検算を通った告知（X用の本文）を履歴へ足す（作者の裁定 2026-10-16 夜の2）。
 * **足し方とファイルの形は製品と同じ関数**（`mergeAnnouncementHistory`・
 * `formatAnnouncementHistory`）。
 *
 * **書けなくても告知文は返す**（製品も履歴の失敗で機能を止めない）。ただ黙らずに、
 * 足せたかどうかを返す。一時ファイルへ書いてから置き換えるのは、ほかの貯め場所
 * （`synopsisStash.ts`）と同じ。プロセス番号は、MCPサーバーが2つ動いていても
 * 一時ファイルがぶつからないようにするため
 */
function addToAnnouncementHistory(folder: string, text: string): boolean {
  const file = announcementHistoryFileOf(folder);
  try {
    const merged = mergeAnnouncementHistory(readPastAnnouncements(folder), [text]);
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, formatAnnouncementHistory(merged), "utf8");
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

/** 告知の設定（ハッシュタグ・作品URL）。無ければ空（URLは目印のまま残る） */
function readAnnounceConfig(folder: string): WorkAnnounceConfig {
  const file = nodePath.join(nodePath.resolve(folder), AIWRITER_DIR, CONFIG_FILE);
  try {
    const raw = JSON.parse(decodeBytes(fs.readFileSync(file)).text) as { announce?: unknown };
    return parseAnnounceConfig(raw.announce) ?? { hashtags: [], workUrl: "" };
  } catch {
    return { hashtags: [], workUrl: "" };
  }
}

export function announcePrompt(input: AnnouncePromptInput) {
  const episode = readAnnounceEpisode(input.folder, input.filePath, input.chapter);
  const reader = readPublicityReader(input.folder);
  const pastAnnouncements = readPastAnnouncements(input.folder);
  return {
    // **版も製品と同じ組み立て**（読者の印が混ざる。規則4）
    promptVersion: announcePromptVersion(publicityReaderMark(reader)),
    /** 何に向けて書かせたか（製品の画面に出る1行と同じ） */
    readerNote: publicityReaderNotice(reader),
    systemPrompt: ANNOUNCE_SYSTEM_PROMPT,
    schema: ANNOUNCE_SCHEMA,
    // 読ませる文章なので、抽出より少し揺らす（製品の generateAnnouncement と同じ 0.5）
    temperature: 0.5,
    validateWith: validateWith("announce"),
    episodeLabel: episode.label,
    bodyChars: episode.body.length,
    pastAnnouncementCount: pastAnnouncements.length,
    /** 何字で書かせるか。**呼ぶ側にも見せる**（検算と同じ数字である） */
    targetChars: {
      xPost: X_POST_MAX_CHARS,
      activityReport: { min: ACTIVITY_REPORT_MIN_CHARS, max: ACTIVITY_REPORT_MAX_CHARS },
      afterword: AFTERWORD_MAX_CHARS,
    },
    userPrompt: buildAnnouncePrompt({
      workTitle: workTitleOf(input.folder),
      episodeLabel: episode.label,
      blurb: readBlurb(input.folder),
      previousSynopsis: readPreviousSynopsis(input.folder, episode.chapter),
      bodyExcerpt: episode.body,
      pastAnnouncements,
      reader,
    }),
  };
}

export function announceValidate(input: AnnouncePromptInput & { response: string }) {
  const parsed = parseAnnounceResponse(input.response);
  if (!parsed) {
    throw new McpToolError(
      "応答を読み取れませんでした（告知文のスキーマに沿っていません。JSONの形か、xPost・activityReport・afterword がすべて空です）。"
    );
  }
  const episode = readAnnounceEpisode(input.folder, input.filePath, input.chapter);
  const config = readAnnounceConfig(input.folder);
  /*
    **定型句・ハッシュタグ・URLはコードで付ける**（製品と同じ `composeXPost`）。
    AIに書かせると話数を取り違えたり、存在しないURLを作ったりする
  */
  const composedX = composeXPost({
    body: parsed.xPost,
    episodeLabel: episode.label,
    hashtags: config.hashtags,
    workUrl: config.workUrl,
  });
  // **注意が出ても切り詰めない**（製品と同じ）。直すかどうかは作者が決める
  const warnings = validateAnnouncement(parsed, composedX, config.workUrl);
  // **採用したかどうかに関わらず覚える**（製品と同じ。目的は同じ言い回しを避けること）。
  // 足すのは製品と同じく X用の本文（定型句・タグ・URLを足す前のもの）
  const historyAdded = addToAnnouncementHistory(input.folder, parsed.xPost);
  return {
    episodeLabel: episode.label,
    /** X用の投稿（話の見出し・ハッシュタグ・URLまで足したもの） */
    composedX,
    /** Xの重み付き字数（日本語は1字＝2）と上限 */
    weightedLength: xWeightedLength(composedX),
    weightedLimit: X_WEIGHTED_LIMIT,
    xPost: parsed.xPost,
    activityReport: parsed.activityReport,
    afterword: parsed.afterword,
    /** 伏せた要素についてのAIの申告。**そのまま信じる材料ではない** */
    spoilerCheck: parsed.spoilerCheck,
    warnings,
    /** 3つの文に出ていた読者層の呼び名（無ければ空） */
    readerLabels: findReaderTypeLabels(
      [parsed.xPost, parsed.activityReport, parsed.afterword].join("\n")
    ),
    /** 前に出した告知の履歴（`.aiwriter/cache/announcements.json`）へ足せたか */
    historyAdded,
    note:
      "告知文の案です。原稿も設定資料も書き換えず、投稿もしていません（貼るのは作者です）。" +
      (config.workUrl
        ? ""
        : "作品URLが未設定なので、X用の末尾は {URL} の目印のままです（作者が貼るときに差し替えます）。") +
      (historyAdded
        ? "X用の本文は、製品の［更新SNS告知文作成］と同じく前に出した告知の履歴へ足しました（次の告知で同じ言い回しを避けます）。"
        : "前に出した告知の履歴へは足せませんでした（告知文はそのまま使えます）。"),
  };
}

export async function announceRun(input: AnnouncePromptInput & RunnerInput) {
  return runOnce(input, announcePrompt(input), (response) =>
    announceValidate({ ...input, response })
  );
}
