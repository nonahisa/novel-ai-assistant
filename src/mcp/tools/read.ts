import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { parseCharacter, type Character } from "../../models/character";
import { parseForeshadow, type Foreshadow } from "../../models/foreshadow";
import { parseSynopsisSet, type ChapterSynopsisSet } from "../../models/synopsis";
import { CHAPTERS_FILE, parseChapterSet, type Chapter } from "../../models/chapter";
import { parseTimeline, type Timeline } from "../../models/timeline";
import { parseLocation, type Location } from "../../models/location";
import { DEFAULT_SETTINGS_DIR, type EpisodeFile } from "../../models/types";
import { decodeBytes } from "../../core/textDecode";
import { expandNameVariants } from "../../core/termIndex";
import { matchWorkFormat, type WorkFormatKey } from "../../core/workFormat";
import { isBlankPlotSection, parsePlotMarkdown } from "../../core/plotDoc";
import { findLatestEpisode } from "../../core/latestEpisode";
import { pickCount } from "../../core/countMode";
import {
  collectedLabelIndex,
  episodeTitle,
  formatChapterLabel,
} from "../../core/episodeLabel";
import { parseMemos } from "../../core/sceneMemo";
import {
  buildResumeSheet,
  EPISODE_PLOTS_DIR,
  episodePlotFileName,
  openForeshadowsForResume,
  recentSynopsesForResume,
  resumeChapterOf,
  resumeChapterRows,
  tailOfEpisodeFile,
  type ResumeEpisodePlot,
  type ResumeMemo,
} from "../../core/resumeSheet";
import {
  buildEmptyForeshadowGuide,
  buildForeshadowMarkdown,
} from "../../core/foreshadowMarkdown";
import { buildChronicle, type ChronicleRow } from "../../core/chronicle";
import { chronicleToMarkdown } from "../../core/chronicleMarkdown";
import { buildRelationGraph, type RelationGraph } from "../../core/relationGraph";
import { buildLocationSketch, type LocationSketch } from "../../core/locationSketch";
import { AIWRITER_DIR } from "../../models/types";
import { parseWorkGoals, WORK_GOALS_FILE } from "../../models/workGoals";
import { postingSiteInfo, type PostingSiteId } from "../../models/posting";
import {
  MILESTONE_LABELS,
  parseScheduleFile,
  SCHEDULE_FILE,
  SCHEDULE_KIND_LABELS,
  scheduleNameForExternal,
  STEP_STATUS_LABELS,
  type ScheduleKind,
  type StepStatus,
} from "../../models/schedule";
import { GOALS_CONTEST_SCHEDULE_ID } from "../../core/scheduleTemplates";
import {
  aggregate,
  currentStreak,
  DEFAULT_DAY_BOUNDARY_HOUR,
  DEFAULT_WEEK_START,
  deviceTotals,
  mergeDailyStats,
  monthKey,
  statsDayKey,
  sumRange,
  weekStartKey,
  addDays,
  type StatsGranularity,
} from "../../core/writingStats";
import { collectWritingStats, WRITING_STATS_DIR } from "../../core/writingStatsFiles";
import { buildContestProgress, type ContestProgress } from "../../core/contestProgress";
import { parseCollectedFile, type CollectedEpisode } from "../../core/collectedFile";
import { isCollectedFile } from "../../core/episodeLabel";
import { extractEpisodeParts } from "../../core/episodeCopy";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { convertForPosting } from "../../core/postingConvert";
import { postingCopyTargetFor } from "../../core/postingCopyTargets";
import type { NoteMarkdownResult } from "../../core/noteMarkdown";
import { readEpisodeFiles } from "./episodeFiles";
import {
  HISTORY_DIRECTORY,
  HISTORY_FILE,
  parseHistory,
  sortNewestFirst,
  type EditHistoryEntry,
} from "../../core/editHistoryFormat";
import { estimateResultTokens, READ_RESULT_TOKEN_BUDGET } from "./payloadBudget";
import { PARSERS as RECORD_PARSERS, SUBDIRS as RECORD_SUBDIRS } from "./proposeRecord";
import {
  FOLDER_INPUT,
  listBodyFiles,
  McpToolError,
  resolveInsideFolder,
  SETTINGS_SUBDIRS,
  SYNOPSES_FILE,
  describeError,
  readPlotMarkdown,
  readSettingsRecords,
  settingsDirOf,
  workTitleOf,
} from "./shared";

/**
 * 読む口 `novel.read`（設計書6.87.24。作者の裁定 2026-10-16「案3」の1件目）。
 *
 * **作品の今を、画面を開かずに読む。** 外部AIが作者の相談に乗るとき最初に欲しいのは
 * 設定資料・再開の1枚・伏線・年表・相関図・略図の中身で、これまでは矛盾検知の材料
 * （`novel.material`）を流用するか、ファイルを自分で開くしかなかった
 * （ファイルを読めない外部AIでは読めなかった）。
 *
 * **1本に束ねて `kind` で選ぶ。** 道具を1本足すたびに、繋ぐたびに読まれる一覧
 * （`tools/list`）が太る（6.87.15 で56本を10本に束ねたのと同じ考え）。
 *
 * **読むだけ。** AIは呼ばず、作品フォルダーに1バイトも書かない。壊れた資料は直さず、
 * 読めなかったファイルとして返す（実装ルール2）。組み立ては製品と同じ `core/` の
 * 関数を通す（写すと、片方だけ直った日に外部AIの読む中身が作者の画面と食い違う）。
 *
 * **許可の鍵は、作品の資料の kind なら道具の名前（`novel.read`）ひとつ。** 作者の裁定
 * （2026-10-16 の2）どおり `"*"` に含める。**相談ログ・ログ・編集履歴（`chatLog`・`log`・
 * `editHistory`）だけは名指しの鍵**（`novel.read.chatLog` など。同6）で、`"*"` では
 * 通らない——鍵を決めるのは `permissionKeyOf`（`core/externalAccessPermission.ts`）。
 */

export const READ_KINDS = [
  "settings",
  "resume",
  "foreshadows",
  "chronicle",
  "relations",
  "locations",
  "writingStats",
  "posting",
  "schedule",
  // ここから下の3つは名指しの鍵（`"*"` に含めない。作者の裁定 2026-10-16 の6）
  "chatLog",
  "log",
  "editHistory",
] as const;
export type ReadKind = (typeof READ_KINDS)[number];

/** 投稿サイト（`models/posting.ts` の `POSTING_SITES` の id と同じ並び） */
export const POSTING_READ_SITES = ["narou", "kakuyomu", "alphapolis", "note"] as const;

export const SETTINGS_RECORD_KINDS = [
  "character",
  "ability",
  "organization",
  "location",
  "world",
] as const;
export type SettingsRecordKind = (typeof SETTINGS_RECORD_KINDS)[number];

/**
 * 年表の `limit` の上限。実際にはその手前で大きさの上限（`READ_RESULT_TOKEN_BUDGET`）が
 * 効くので、これは入力の歯止めにすぎない（ほかの道具の `limit` と同じ200）
 */
const MAX_CHRONICLE_LIMIT = 200;

export const NOVEL_READ_INPUT = {
  ...FOLDER_INPUT,
  kind: z
    .enum(READ_KINDS)
    .describe(
      "読むもの。settings＝設定資料（人物・能力・組織・場所・世界観）／resume＝執筆再開の1枚／" +
        "foreshadows＝伏線の台帳と一覧／chronicle＝年表（話ごとのあらすじ・登場・出来事・時期）／" +
        "relations＝人物相関図の中身／locations＝場所の略図の中身／" +
        "writingStats＝執筆量（日・週・月・年ごと、続いている日数、環境ごと）と作品の目標・応募先の進み／" +
        "posting＝投稿サイトの入力欄へ貼る形にした1話の本文と題（site・file が要る。投稿はしない）／" +
        "schedule＝予定（スケジュールと段の id・名前・日数・期日・状態。novel.propose kind: schedule で段を指す id）／" +
        "chatLog＝相談ログ／log＝動作のログ／editHistory＝編集履歴（この3つは新しいものが先。" +
        "全部の道具の許可では読めず、作者が名指しで許したときだけ読める）"
    ),
  site: z
    .enum(POSTING_READ_SITES)
    .optional()
    .describe(
      "kind: posting のとき（必須）。narou＝小説家になろう、kakuyomu＝カクヨム、alphapolis＝アルファポリス、note＝note。" +
        "ルビと傍点をそのサイトの書き方にする（note は Markdown を note の形に整える）"
    ),
  file: z
    .string()
    .optional()
    .describe("kind: posting のとき（必須）。話のファイル（作品フォルダーからの相対パス。novel.scan の filePath）"),
  collectedOrder: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "kind: posting で、file が合本（1ファイルに複数話）のとき（必須）。区切りの何番目の話か（1から）。" +
        "省くと、入っている話の一覧を理由に添えて断る"
    ),
  term: z
    .string()
    .optional()
    .describe(
      "kind: settings のとき、この語（名前・別名・名前の片方・読み）に当たる記録だけを全体で返す。" +
        "省くと、名前と短い紹介の一覧だけを返す。" +
        "kind: chronicle のとき、この人物が登場する話・出来事の人物・あらすじ・題・出来事の文に語を含む話だけを返す"
    ),
  recordKind: z
    .enum(SETTINGS_RECORD_KINDS)
    .optional()
    .describe("kind: settings のとき、種類で絞る"),
  fromEpisode: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("kind: chronicle のとき、この話数から（含む）。合本は範囲と重なれば入る。話数の分からない話は、範囲を指すと入らない"),
  toEpisode: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("kind: chronicle のとき、この話数まで（含む）"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "kind: chronicle のとき、絞った行の何件目から返すか（既定は0）。" +
        "kind: posting のとき、変換した本文の何行目から返すか（0から。既定は0）。" +
        "kind: chatLog・log・editHistory のとき、新しいほうから数えて何件目から返すか（既定は0）。" +
        "kind: schedule のとき、何番目のスケジュールから返すか（0から。既定は0）。" +
        "どちらも、返事の next.offset をそのまま渡すと続きが読める（ほかの引数は同じまま）"
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_CHRONICLE_LIMIT)
    .optional()
    .describe(
      "kind: chronicle・chatLog・log・editHistory のとき、返す件数の上限。指さなくても、返事が大きくなりすぎる手前で切って next を返す"
    ),
};

export interface NovelReadInput {
  folder: string;
  kind: ReadKind;
  term?: string;
  recordKind?: SettingsRecordKind;
  fromEpisode?: number;
  toEpisode?: number;
  offset?: number;
  limit?: number;
  site?: PostingSiteId;
  file?: string;
  collectedOrder?: number;
  /**
   * 今の時刻（`kind: writingStats` の「今日」）。**入力の形（`NOVEL_READ_INPUT`）には無い**
   * ——外から日付をずらされても困らないが、試験で日付を固めるためだけに置く
   */
  now?: Date;
}

export interface SettingsReadRecord {
  recordKind: SettingsRecordKind;
  id: string;
  name: string;
  aliases: string[];
  /** 短い紹介（人物・能力・組織・場所は summary、世界観は description）。無ければ空 */
  summary: string;
  /** 記録の全体。**語で引いたときだけ**入れる（一覧が太らないように） */
  record?: unknown;
}

export interface ReadOmission {
  /** 再開の1枚の節の名前 */
  section: "todayGoal" | "relatedScenes";
  reason: string;
}

export type NovelReadResult =
  | {
      kind: "settings";
      term: string | null;
      records: SettingsReadRecord[];
      /** 読めなかったファイル（`設定/<種類>/<名前>`）。直さずに飛ばした */
      unreadableFiles: string[];
    }
  | {
      kind: "resume";
      /** 製品の［執筆再開］と同じ1枚（Markdown） */
      markdown: string;
      /** 最新話（作品フォルダーからの相対）。本文が無ければ null */
      latestFile: string | null;
      /** MCP では出さない節と理由。黙って落とさない */
      omitted: ReadOmission[];
      /** 読めなかった材料の断り（1枚の冒頭にも出る） */
      notices: string[];
    }
  | {
      kind: "foreshadows";
      records: Foreshadow[];
      /** 製品の［伏線一覧］と同じ文書 */
      markdown: string;
      unreadableFiles: string[];
    }
  | {
      kind: "chronicle";
      /** 話ごとの行（話数順）。`workPath` は作品フォルダーからの相対。**この回に返す分だけ** */
      rows: Array<Omit<ChronicleRow, "filePath">>;
      /** 製品の［年表］の書き出しと同じ文書（話数順）。**`rows` と同じ行だけ**で組む */
      markdown: string;
      /** 絞った（範囲・語）あとの行の数。`rows` はそのうち `offset` 件目からの一部 */
      total: number;
      offset: number;
      /** 返しきれずに省いた行があるか */
      truncated: boolean;
      /** 続きの取り方。ほかの引数は同じまま、これを足して呼ぶ。続きが無ければ null */
      next: { offset: number } | null;
      notices: string[];
    }
  | {
      kind: "relations";
      graph: RelationGraph;
      unreadableFiles: string[];
    }
  | {
      kind: "locations";
      sketch: LocationSketch;
      unreadableFiles: string[];
    }
  | WritingStatsReadResult
  | PostingReadResult
  | ScheduleReadResult
  | LogReadResult;

/**
 * 相談ログ・ログ・編集履歴の返事（名指しの鍵。2026-10-16）。どれも**新しいものが先**で、
 * `offset` は新しいほうから数えた位置。大きさは年表と同じ作法で詰める。
 */
export type LogReadResult = LogPage &
  (
    | {
        kind: "chatLog";
        /** 相談1回ずつ。`heading` は日時と画面（「2026-10-16 10:00:00　相談パネル」） */
        entries: Array<{ heading: string; text: string }>;
      }
    | {
        kind: "log";
        /** 動作のログの行（新しい行が先） */
        lines: string[];
      }
    | {
        kind: "editHistory";
        entries: EditHistoryEntry[];
      }
  );

interface LogPage {
  /** 全体の件数（相談の回数・行の数・履歴の件数） */
  total: number;
  offset: number;
  truncated: boolean;
  next: { offset: number } | null;
  notices: string[];
}

/** 執筆量の束（日・週・月・年の1つ）。**数字だけ**（本文もファイル名も入らない） */
export interface WritingStatsReadBucket {
  key: string;
  label: string;
  net: number;
  gross: number;
  activeDays: number;
}

export interface WritingStatsReadResult {
  kind: "writingStats";
  /** 今日（日付の境目で切った YYYY-MM-DD） */
  today: string;
  /** 日付の境目（何時で日が変わるか）。VS Code の設定は読めないので既定 */
  dayBoundaryHour: number;
  /** 記録を読めた環境の数（壊れた記録は数えない） */
  deviceCount: number;
  /** 今日・今週・今月に書いた純文字数（全環境の合算） */
  todayNet: number;
  week: { key: string; net: number; activeDays: number };
  month: { key: string; net: number; activeDays: number };
  /** 続けて書いている日数（今日まだでも昨日まで続いていれば途切れない） */
  streak: number;
  /** 粒度ごとの束（製品の執筆統計と同じ本数。書かなかった区間も0で並ぶ） */
  buckets: Record<StatsGranularity, WritingStatsReadBucket[]>;
  /** 環境ごとの内訳（環境の名前・純文字数・書いた日数） */
  devices: Array<{ deviceId: string; net: number; activeDays: number }>;
  /** いまの作品の字数（本文フォルダーの話の純文字数の合計） */
  work: { net: number; episodes: number };
  /** 作品の目標（`.aiwriter/goals.json`）。決めていなければ空の目標、読めなければ null */
  goals: {
    perEpisodeChars: number | null;
    /** 応募先と締切までの進み。応募先が無ければ null */
    contest: ContestProgress | null;
  } | null;
  /** MCP では出さないものと理由。黙って落とさない */
  omitted: Array<{ section: "dailyGoal" | "monthlyGoal"; reason: string }>;
  notices: string[];
}

export interface PostingReadResult {
  kind: "posting";
  site: PostingSiteId;
  siteLabel: string;
  /** 話のファイル（作品フォルダーからの相対） */
  file: string;
  /** 合本から取り出した話の番号（区切りの何番目か）。合本でなければ null */
  collectedOrder: number | null;
  /** 題名の欄へ入れるもの（サブタイトル。note は先頭の `# 見出し`）。無ければ null */
  title: string | null;
  /** 貼る本文の**この回に返す行だけ**（行の境目で切る。ルビの記法を割らない） */
  text: string;
  /** 変換した本文の全体の字数と行数 */
  chars: number;
  totalLines: number;
  offset: number;
  truncated: boolean;
  next: { offset: number } | null;
  /** note のときだけ：貼り付けでは入らないもの（画像・埋め込み）と注意 */
  note?: { images: NoteMarkdownResult["images"]; embeds: string[]; warnings: string[] };
  notices: string[];
}

export function novelRead(input: NovelReadInput): NovelReadResult {
  const folder = input.folder;
  if (!fs.existsSync(nodePath.resolve(folder))) {
    throw new McpToolError(`作品フォルダーが見つかりません: ${folder}`);
  }
  switch (input.kind) {
    case "settings":
      return readSettings(folder, input.term, input.recordKind);
    case "resume":
      return readResume(folder);
    case "foreshadows":
      return readForeshadows(folder);
    case "chronicle":
      return readChronicle(folder, input);
    case "relations":
      return readRelations(folder);
    case "locations":
      return readLocations(folder);
    case "writingStats":
      return readWritingStats(folder, input.now ?? new Date());
    case "posting":
      return readPosting(folder, input);
    case "schedule":
      return readSchedule(folder, input);
    case "chatLog":
    case "log":
    case "editHistory":
      return readLog(folder, input.kind, input);
  }
}

/* ── settings ─────────────────────────────────────── */

/** 種類ごとの置き場と読み方。人物以外は `novel.propose` と同じ表を使う */
function settingsSourceOf(kind: SettingsRecordKind): {
  subdir: string;
  parse: (raw: unknown) => { id: string; name: string; aliases: string[]; reading: string | null };
} {
  if (kind === "character") {
    return { subdir: SETTINGS_SUBDIRS.characters, parse: parseCharacter };
  }
  return { subdir: RECORD_SUBDIRS[kind], parse: RECORD_PARSERS[kind] };
}

function readSettings(
  folder: string,
  term: string | undefined,
  recordKind: SettingsRecordKind | undefined
): NovelReadResult {
  const wanted = term?.trim() ?? "";
  const kinds = recordKind ? [recordKind] : SETTINGS_RECORD_KINDS;
  const records: SettingsReadRecord[] = [];
  const unreadableFiles: string[] = [];

  for (const kind of kinds) {
    const source = settingsSourceOf(kind);
    const loaded = readSettingsRecords(folder, source.subdir, source.parse);
    unreadableFiles.push(
      ...loaded.unreadableFiles.map((name) => `${DEFAULT_SETTINGS_DIR}/${source.subdir}/${name}`)
    );
    for (const record of loaded.records) {
      if (wanted && !matchesTerm(record, wanted)) continue;
      records.push({
        recordKind: kind,
        id: record.id,
        name: record.name,
        aliases: record.aliases,
        summary: shortSummaryOf(record),
        ...(wanted ? { record } : {}),
      });
    }
  }
  return { kind: "settings", term: wanted || null, records, unreadableFiles };
}

/**
 * 語が記録に当たるか。**本文での呼び方と同じ広げ方**（`expandNameVariants`）を通す
 * ——「灯野・ハルト」は本文では「ハルト」としか出ないことが多い。原稿エディターの
 * ［設定情報を表示］も同じ索引（`termIndex.ts`）で引いている。読みは完全一致だけ。
 */
function matchesTerm(
  record: { name: string; aliases: string[]; reading: string | null },
  term: string
): boolean {
  if (record.reading?.trim() === term) return true;
  return expandNameVariants([record.name, ...record.aliases]).includes(term);
}

function shortSummaryOf(record: object): string {
  const fields = record as { summary?: unknown; description?: unknown };
  if (typeof fields.summary === "string" && fields.summary.trim()) return fields.summary.trim();
  if (typeof fields.description === "string") return fields.description.trim();
  return "";
}

/* ── 設定/ の直下の台帳を1つ読む ───────────────────────── */

type LedgerRead<T> =
  | { state: "missing" }
  | { state: "broken"; detail: string }
  | { state: "ok"; value: T };

/**
 * `設定/` の直下の JSON 台帳を読む。**「無い」と「壊れている」を分ける**——
 * 同じ undefined にすると、壊れた章立てが「章立てはまだありません」と見え、
 * 作者が作り直して上書きしてしまう。
 */
function readLedger<T>(
  folder: string,
  fileName: string,
  parse: (raw: unknown) => T
): LedgerRead<T> {
  const settings = settingsDirOf(folder);
  if (!settings) return { state: "missing" };
  const file = nodePath.join(settings, fileName);
  if (!fs.existsSync(file)) return { state: "missing" };
  try {
    return { state: "ok", value: parse(JSON.parse(decodeBytes(fs.readFileSync(file)).text)) };
  } catch (error) {
    return { state: "broken", detail: describeError(error) };
  }
}

/**
 * 作中の時間の台帳（`core/timelineStore.ts` の `TIMELINE_FILE`）。あちらは
 * `vscode` を import しているので名前だけ写す（`shared.ts` の `SETTINGS_SUBDIRS` と同じ事情）
 */
const TIMELINE_FILE = "timeline.json";

/** 作品の形式（プロットの `## 形式`）。製品の `readWorkFormat` と同じ読み方 */
function workFormatOf(folder: string): WorkFormatKey | undefined {
  const plot = readPlotMarkdown(folder);
  return plot === undefined ? undefined : matchWorkFormat(parsePlotMarkdown(plot).sections.format);
}

function readCharacters(folder: string, notices: string[]): Character[] {
  const loaded = readSettingsRecords(folder, SETTINGS_SUBDIRS.characters, parseCharacter);
  if (loaded.unreadable > 0) {
    notices.push(
      `読み込めなかった人物が${loaded.unreadable}件あります（${loaded.unreadableFiles.join("、")}）。`
    );
  }
  return loaded.records;
}

function readForeshadowRecords(folder: string): { records: Foreshadow[]; unreadableFiles: string[] } {
  const loaded = readSettingsRecords(folder, SETTINGS_SUBDIRS.foreshadows, parseForeshadow);
  return {
    records: loaded.records,
    unreadableFiles: loaded.unreadableFiles.map(
      (name) => `${DEFAULT_SETTINGS_DIR}/${SETTINGS_SUBDIRS.foreshadows}/${name}`
    ),
  };
}

function readSynopses(folder: string, notices: string[]): ChapterSynopsisSet | null {
  const read = readLedger(folder, SYNOPSES_FILE, parseSynopsisSet);
  if (read.state === "broken") {
    notices.push(`各話あらすじを読めませんでした：${read.detail}`);
    return null;
  }
  return read.state === "ok" ? read.value : null;
}

/* ── resume ─────────────────────────────────────── */

/**
 * 執筆再開の1枚（設計書6.36.1）。**製品の［執筆再開］と同じ組み立て**
 * （`buildResumeSheet` と、選び方の関数）を通し、読み方だけを Node の `fs` にする。
 *
 * 製品と違うのは2節だけで、どちらも黙って落とさず `omitted` で返す：
 * - 今日の執筆量（記録は機械ごとの台帳で、目標は VS Code の設定にある）
 * - 関係しそうな前の場面（手元の Ollama で問いを埋め込む。読む口はAIの類を呼ばない）
 */
function readResume(folder: string): NovelReadResult {
  const notices: string[] = [];
  const base = nodePath.resolve(folder);
  const format = workFormatOf(folder);
  const scanned = readEpisodeFiles(folder);
  for (const relative of scanned.unreadable) {
    notices.push(`${relative} を読めませんでした。`);
  }
  const { episodes, texts } = scanned;
  const latest = findLatestEpisode(episodes);
  const chapter = resumeChapterOf(latest);

  const plotText = readPlotMarkdown(folder) ?? "";
  const outline = parsePlotMarkdown(plotText).sections.outline ?? "";

  let chapters: Chapter[] = [];
  const chapterLedger = readLedger(folder, CHAPTERS_FILE, parseChapterSet);
  if (chapterLedger.state === "broken") {
    notices.push(`章立てを読めませんでした：${chapterLedger.detail}`);
  } else if (chapterLedger.state === "ok") {
    chapters = chapterLedger.value.chapters;
  }

  const foreshadows = readForeshadowRecords(folder);
  if (foreshadows.unreadableFiles.length > 0) {
    notices.push(
      `読み込めない伏線が ${foreshadows.unreadableFiles.length} 件あります。残りだけを並べています。`
    );
  }

  const markdown = buildResumeSheet({
    workTitle: workTitleOf(folder),
    overview: {
      plotOutline: isBlankPlotSection(outline) ? "" : outline.trim(),
      chapters: resumeChapterRows(episodes, chapters, base, chapter),
      totalEpisodes: episodes.length,
      latestChapter: chapter,
    },
    latest: latest
      ? {
          label: labelOf(latest, format),
          title: episodeTitle(latest, formatChapterLabel(latest, format)),
          // 数え方の設定は VS Code の中にあるので、既定（純文字数）で数える
          chars: pickCount(latest.counts, "net"),
          countLabel: "",
          tail: tailOf(latest, texts, notices),
        }
      : null,
    synopses: recentSynopsesForResume(
      readSynopses(folder, notices)?.episodes ?? [],
      chapter,
      format
    ),
    openForeshadows: openForeshadowsForResume(foreshadows.records),
    openMemos: memosOf(episodes, texts, format),
    episodePlot: episodePlotOf(folder, chapter, notices),
    todayGoal: null,
    notices,
  });

  return {
    kind: "resume",
    markdown,
    latestFile: latest ? toWorkPath(base, latest.filePath) : null,
    omitted: [
      {
        section: "todayGoal",
        reason:
          "今日の目標は VS Code の設定にあるため、MCP では出しません（執筆量そのものは kind: writingStats で読めます）。",
      },
      {
        section: "relatedScenes",
        reason:
          "関係しそうな前の場面は手元の Ollama で探すため、読む口では出しません。novel.search で探せます。",
      },
    ],
    notices,
  };
}

function labelOf(episode: EpisodeFile, format: WorkFormatKey | undefined): string {
  return formatChapterLabel(episode, format) || episode.fileName;
}

function tailOf(
  latest: EpisodeFile,
  texts: ReadonlyMap<string, string>,
  notices: string[]
): string {
  const text = texts.get(latest.filePath);
  if (latest.hasConflictMarkers || text === undefined) {
    // 競合の跡が残ったまま読むと、両方の版が混ざった文章を
    // 「前回書いたもの」として見せることになる（製品と同じ断り）
    notices.push(
      latest.hasConflictMarkers
        ? `${latest.fileName} に同期の競合の跡が残っています。末尾は出しません（先に競合を解消してください）。`
        : `${latest.fileName} を読めませんでした。`
    );
    return "";
  }
  return tailOfEpisodeFile(latest.filePath, text, latest);
}

/** 本文に残っているシーンメモ（設計書6.40.5）。合本はメモの行からその話の見出しを引く */
function memosOf(
  episodes: readonly EpisodeFile[],
  texts: ReadonlyMap<string, string>,
  format: WorkFormatKey | undefined
): ResumeMemo[] {
  const memos: ResumeMemo[] = [];
  for (const episode of episodes) {
    const text = texts.get(episode.filePath);
    if (text === undefined) continue;
    const labels = collectedLabelIndex(text, labelOf(episode, format), format);
    for (const memo of parseMemos(text, episode.filePath)) {
      memos.push({ label: labels.labelAt(memo.line), line: memo.line, tag: memo.tag, text: memo.text });
    }
  }
  return memos;
}

function episodePlotOf(
  folder: string,
  chapter: number | null,
  notices: string[]
): ResumeEpisodePlot {
  if (chapter === null) return { kind: "unnumbered" };
  const shown = `${DEFAULT_SETTINGS_DIR}/${EPISODE_PLOTS_DIR}/${episodePlotFileName(chapter)}`;
  const file = nodePath.join(nodePath.resolve(folder), shown);
  if (!fs.existsSync(file)) return { kind: "missing", path: shown };
  try {
    return { kind: "found", path: shown, body: decodeBytes(fs.readFileSync(file)).text };
  } catch (error) {
    notices.push(`${shown} を読めませんでした：${describeError(error)}`);
    return { kind: "missing", path: shown };
  }
}

/** 作品フォルダーからの相対（区切りは `/`）。機械の中の絶対パスを外へ出さない */
function toWorkPath(base: string, filePath: string): string {
  return nodePath.relative(base, filePath).replace(/\\/g, "/");
}

/* ── foreshadows ─────────────────────────────────────── */

function readForeshadows(folder: string): NovelReadResult {
  const { records, unreadableFiles } = readForeshadowRecords(folder);
  return {
    kind: "foreshadows",
    records,
    // 製品の［伏線一覧］と同じ（0件なら案内の文書）
    markdown: records.length === 0 ? buildEmptyForeshadowGuide() : buildForeshadowMarkdown(records),
    unreadableFiles,
  };
}

/* ── chronicle ─────────────────────────────────────── */

/**
 * 年表（設計書6.39）。製品の［年表］と同じ `buildChronicle` に、同じ材料
 * （話・人物・各話あらすじ・伏線・作中の時間）を渡す。**読めない材料があっても
 * 年表は出す**（製品と同じ。あらすじは行の1列にすぎない）。
 */
function readChronicle(folder: string, input: NovelReadInput): NovelReadResult {
  const { fromEpisode, toEpisode } = input;
  if (fromEpisode !== undefined && toEpisode !== undefined && fromEpisode > toEpisode) {
    throw new McpToolError(
      `fromEpisode（${fromEpisode}）が toEpisode（${toEpisode}）より後になっています。始まりと終わりを入れ替えてください。`
    );
  }
  const notices: string[] = [];
  const base = nodePath.resolve(folder);
  const scanned = readEpisodeFiles(folder);
  for (const relative of scanned.unreadable) {
    notices.push(`${relative} を読めませんでした。`);
  }
  const foreshadows = readForeshadowRecords(folder);
  if (foreshadows.unreadableFiles.length > 0) {
    notices.push(`読み込めなかった伏線があります（${foreshadows.unreadableFiles.join("、")}）。`);
  }

  let timeline: Timeline | null = null;
  const timelineLedger = readLedger(folder, TIMELINE_FILE, parseTimeline);
  if (timelineLedger.state === "broken") {
    notices.push(`作中の時間（${TIMELINE_FILE}）を読めませんでした：${timelineLedger.detail}`);
  } else if (timelineLedger.state === "ok") {
    timeline = timelineLedger.value;
  }

  const rows = buildChronicle(
    scanned.episodes,
    readCharacters(folder, notices),
    readSynopses(folder, notices),
    foreshadows.records,
    timeline,
    { workRoot: base, format: workFormatOf(folder) }
  );
  const term = input.term?.trim() ?? "";
  const filtered = rows.filter(
    (row) =>
      chronicleRowInRange(row, fromEpisode, toEpisode) && (!term || chronicleRowMatchesTerm(row, term))
  );
  const offset = input.offset ?? 0;
  const candidates = filtered.slice(offset, offset + (input.limit ?? MAX_CHRONICLE_LIMIT));
  const workTitle = workTitleOf(folder);

  /*
    **返す行は、件数でなく大きさで詰める**（2026-10-16。確認用の作品の24話で、年表だけ
    呼び出し側の上限を超えてファイルへ逃がされた）。行の大きさは話によって十倍以上違い
    （出来事が多い話・合本）、件数で切ると上限を守れない。実際に届く形で見積もって、
    上限（`READ_RESULT_TOKEN_BUDGET`）の手前まで入れる。
  */
  const compose = (count: number): Extract<NovelReadResult, { kind: "chronicle" }> => {
    const page = candidates.slice(0, count);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < filtered.length;
    return {
      kind: "chronicle",
      // 開くための絶対パス（`filePath`）は外へ出さない。話の指し先は `workPath`
      rows: page.map(({ filePath: _filePath, ...rest }) => rest),
      markdown: chronicleMarkdownOf(page, rows.length, workTitle),
      total: filtered.length,
      offset,
      truncated,
      next: truncated ? { offset: nextOffset } : null,
      notices: [...notices, ...pageNotices(page, filtered.length, offset, truncated, rows.length)],
    };
  };

  // 1行ずつ足し、上限を超えた行の手前で止める。**最低1行は返す**——1行だけで上限を
  // 超える話（とても長い合本）でも、0行を返して続きを示すと同じ所で永遠に止まる
  let count = Math.min(1, candidates.length);
  while (
    count < candidates.length &&
    estimateResultTokens(compose(count + 1)) <= READ_RESULT_TOKEN_BUDGET
  ) {
    count++;
  }
  const result = compose(count);
  if (count === 1 && estimateResultTokens(result) > READ_RESULT_TOKEN_BUDGET) {
    result.notices.push(
      `${result.rows[0].chapterLabel}の行だけで返事の大きさの目安を超えています。呼び出し側で切られることがあります。`
    );
  }
  return result;
}

/**
 * 範囲の中の行か（両端を含む）。**合本（1行が複数話）は、範囲と少しでも重なれば入れる**
 * ——始まりの話だけで見ると、第10〜12話の合本を「第12話から」で引いたとき落ちる。
 * 話数の分からない行は、範囲を指したときは入れない（どこに当たるかを想像で決めない）。
 */
export function chronicleRowInRange(
  row: Pick<ChronicleRow, "chapter" | "chapterEnd">,
  fromEpisode: number | undefined,
  toEpisode: number | undefined
): boolean {
  if (fromEpisode === undefined && toEpisode === undefined) return true;
  if (row.chapter === null) return false;
  const start = row.chapter;
  const end = row.chapterEnd ?? row.chapter;
  if (fromEpisode !== undefined && end < fromEpisode) return false;
  if (toEpisode !== undefined && start > toEpisode) return false;
  return true;
}

/**
 * 語に当たる行か。人物（登場・出来事の人物）は設定資料と同じ広げ方
 * （`expandNameVariants`。「灯野・ソウ」を「ソウ」で引ける）で完全一致、
 * あらすじ・題・出来事の文は語を含むかで見る。
 */
function chronicleRowMatchesTerm(row: ChronicleRow, term: string): boolean {
  const names = [
    ...row.appeared.map((person) => person.name),
    ...row.events.flatMap((event) => (event.characterName ? [event.characterName] : [])),
  ];
  if (names.some((name) => expandNameVariants([name]).includes(term))) return true;
  const texts = [row.synopsis ?? "", row.title ?? "", ...row.events.map((event) => event.text)];
  return texts.some((text) => text.includes(term));
}

function chronicleMarkdownOf(
  page: readonly ChronicleRow[],
  allRows: number,
  workTitle: string
): string {
  // 作品に話が1つも無いときだけ製品と同じ案内を出す。絞って0行になったときに
  // 「本文ファイルを入れてください」と出すと、話が無いと読み違える
  if (page.length === 0) return allRows === 0 ? chronicleToMarkdown([]) : "";
  return chronicleToMarkdown([{ label: "", line: null, kind: "canonical", rows: [...page] }], {
    workTitle,
    order: "chapter",
  });
}

/** 返した範囲と続きの取り方の断り。外部AIは構造より平文を読むので、文でも書く */
function pageNotices(
  page: readonly ChronicleRow[],
  total: number,
  offset: number,
  truncated: boolean,
  allRows: number
): string[] {
  if (page.length === 0) {
    if (allRows === 0) return [];
    return total === 0
      ? ["絞り込み（範囲・語）に当たる話がありません。"]
      : [`offset（${offset}）が絞った行の数（${total}）を超えています。`];
  }
  if (!truncated && offset === 0) return [];
  const first = page[0].chapterLabel;
  const last = page[page.length - 1].chapterLabel;
  const shown = `全${total}件のうち${offset + 1}〜${offset + page.length}件目（${first}〜${last}）を返しました。`;
  return truncated
    ? [
        // 省いた理由は大きさの上限と limit の2つがあるので、理由は書かず件数だけにする
        `${shown}残りの${total - offset - page.length}件は省きました。` +
          `続きは offset: ${offset + page.length} で読めます（ほかの引数は同じまま）。` +
          "話数の範囲（fromEpisode・toEpisode）や語（term）で絞ることもできます。",
      ]
    : [shown];
}

/* ── relations・locations ─────────────────────────────── */

function readRelations(folder: string): NovelReadResult {
  const loaded = readSettingsRecords(folder, SETTINGS_SUBDIRS.characters, parseCharacter);
  return {
    kind: "relations",
    graph: buildRelationGraph(loaded.records),
    unreadableFiles: loaded.unreadableFiles.map(
      (name) => `${DEFAULT_SETTINGS_DIR}/${SETTINGS_SUBDIRS.characters}/${name}`
    ),
  };
}

function readLocations(folder: string): NovelReadResult {
  const loaded = readSettingsRecords<Location>(folder, SETTINGS_SUBDIRS.locations, parseLocation);
  return {
    kind: "locations",
    sketch: buildLocationSketch(loaded.records),
    unreadableFiles: loaded.unreadableFiles.map(
      (name) => `${DEFAULT_SETTINGS_DIR}/${SETTINGS_SUBDIRS.locations}/${name}`
    ),
  };
}

/* ── writingStats ─────────────────────────────────────── */

/**
 * 執筆量（設計書6.3）と作品の目標（6.3.6）。**製品の［執筆統計］と同じ集計**
 * （`core/writingStats.ts` の関数）を通し、記録の読み方も製品と同じ関数
 * （`collectWritingStats`）を通す。
 *
 * 製品と違うのは、VS Code の設定にあるものを読めないことだけで、黙って既定に
 * 倒さず `omitted`・`notices` で言う：
 * - 日次・月次の目標（`novelai.stats.dailyGoal`・`monthlyGoal`）→ 出さない
 * - 日付の境目（`novelai.stats.dayBoundaryHour`）→ 既定（午前4時）で数える
 *
 * **返すのは数字だけ。** 記録にはファイルごとの内訳（作品フォルダーからの相対パス）が
 * あるが、相談に要らないので入れない。
 */
function readWritingStats(folder: string, now: Date): WritingStatsReadResult {
  const notices: string[] = [];
  const sets = collectWritingStats(readStatsFiles(folder, notices));
  const days = mergeDailyStats(sets);

  const today = statsDayKey(now, DEFAULT_DAY_BOUNDARY_HOUR);
  const week = weekStartKey(today, DEFAULT_WEEK_START);
  const month = monthKey(today);
  const weekTotal = sumRange(days, week, addDays(week, 6));
  const monthTotal = sumRange(days, `${month}-01`, `${month}-31`);

  const granularities: StatsGranularity[] = ["daily", "weekly", "monthly", "yearly"];
  const buckets = Object.fromEntries(
    granularities.map((granularity) => [
      granularity,
      aggregate(days, granularity, { today, weekStart: DEFAULT_WEEK_START }),
    ])
  ) as Record<StatsGranularity, WritingStatsReadBucket[]>;

  // いまの作品の字数。**製品の統計と同じく純文字数**（数え方の設定は VS Code の中にある）
  const scanned = readEpisodeFiles(folder);
  for (const relative of scanned.unreadable) {
    notices.push(`${relative} を読めませんでした（作品の字数に入っていません）。`);
  }
  const workNet = scanned.episodes.reduce(
    (sum, episode) => sum + pickCount(episode.counts, "net"),
    0
  );

  const goals = readGoals(folder, workNet, today, notices);

  if (sets.length === 0) {
    notices.push(
      "執筆量の記録がまだありません（拡張機能で本文を保存すると、環境ごとに .aiwriter/stats/ へ記録が付きます）。"
    );
  }
  notices.push(
    `日付の境目は既定の午前${DEFAULT_DAY_BOUNDARY_HOUR}時で数えました（作者が VS Code の設定で変えていれば、製品の画面と1日ずれることがあります）。` +
      "作品の字数は純文字数（ルビを除く）で、作者が総文字数で数える設定にしていても純文字数です。"
  );

  return {
    kind: "writingStats",
    today,
    dayBoundaryHour: DEFAULT_DAY_BOUNDARY_HOUR,
    deviceCount: sets.length,
    todayNet: sumRange(days, today, today).net,
    week: { key: week, net: weekTotal.net, activeDays: weekTotal.activeDays },
    month: { key: month, net: monthTotal.net, activeDays: monthTotal.activeDays },
    streak: currentStreak(days, today),
    buckets,
    devices: deviceTotals(sets),
    work: { net: workNet, episodes: scanned.episodes.length },
    goals,
    omitted: [
      {
        section: "dailyGoal",
        reason:
          "1日の目標は VS Code の設定（novelai.stats.dailyGoal）にあるため、MCP では出しません。作者に尋ねてください。",
      },
      {
        section: "monthlyGoal",
        reason:
          "月の目標は VS Code の設定（novelai.stats.monthlyGoal）にあるため、MCP では出しません。作者に尋ねてください。",
      },
    ],
    notices,
  };
}

/** `.aiwriter/stats/*.json` の名前と中身。読めないファイルは飛ばして断る */
function readStatsFiles(folder: string, notices: string[]): Array<{ name: string; text: string }> {
  const dir = nodePath.join(nodePath.resolve(folder), AIWRITER_DIR, WRITING_STATS_DIR);
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    // 記録がまだ無い（フォルダーが無い）。呼ぶ側が「まだありません」と言う
    return [];
  }
  const files: Array<{ name: string; text: string }> = [];
  for (const name of names) {
    try {
      files.push({ name, text: decodeBytes(fs.readFileSync(nodePath.join(dir, name))).text });
    } catch (error) {
      notices.push(`執筆量の記録 ${name} を読めませんでした：${describeError(error)}`);
    }
  }
  return files;
}

/**
 * 作品の目標（`.aiwriter/goals.json`）。**無ければ空の目標**、壊れていれば null と断り
 * ——直さない（作者が書いた値が黙って消える。製品の `readWorkGoals` と同じ線）。
 */
function readGoals(
  folder: string,
  written: number,
  today: string,
  notices: string[]
): WritingStatsReadResult["goals"] {
  const file = nodePath.join(nodePath.resolve(folder), AIWRITER_DIR, WORK_GOALS_FILE);
  if (!fs.existsSync(file)) return { perEpisodeChars: null, contest: null };
  try {
    const goals = parseWorkGoals(JSON.parse(decodeBytes(fs.readFileSync(file)).text));
    return {
      perEpisodeChars: goals.perEpisodeChars,
      contest: buildContestProgress(goals, written, today) ?? null,
    };
  } catch (error) {
    notices.push(
      `作品の目標（${AIWRITER_DIR}/${WORK_GOALS_FILE}）を読めませんでした：${describeError(error)}`
    );
    return null;
  }
}

/* ── schedule ─────────────────────────────────────── */

/** 予定の段1つ。**台帳が持つ値だけ**（逆算した日付は台帳に無いので入れない） */
export interface ScheduleReadStep {
  id: string;
  label: string;
  /** 所要日数。執筆の段では、巡航速度が無いときの仮の日数 */
  days: number;
  /** 作者が手で入れた期日。null なら画面が逆算で決める */
  due: string | null;
  status: StepStatus;
  statusLabel: string;
  doneAt: string | null;
}

export interface ScheduleReadEntry {
  id: string;
  /** `novel.propose kind: schedule` の `ledger.schedule` に渡せる名前 */
  name: string;
  scheduleKind: ScheduleKind;
  kindLabel: string;
  /** 締切・発売日・連載開始日のどれか */
  milestoneLabel: string;
  /** 作品目標設定に従う公募なら、目標の応募先の締切 */
  milestone: string | null;
  followsGoals: boolean;
  steps: ScheduleReadStep[];
}

export interface ScheduleReadResult {
  kind: "schedule";
  /** 読んだ台帳（作品フォルダーからの相対）。まだ無ければ null */
  file: string | null;
  schedules: ScheduleReadEntry[];
  /** スケジュールの数（段の数ではない） */
  total: number;
  offset: number;
  truncated: boolean;
  next: { offset: number } | null;
  unreadableFiles: string[];
  notices: string[];
}

/**
 * 予定（設計書6.111）を読む。**`novel.propose kind: schedule` の案が段を id で指せる
 * ように**、スケジュールと段の id・名前・日数・期日・状態を返す。
 *
 * 返すのは台帳（`設定/スケジュール.json`）が持つ値だけ。逆算した日付は画面が毎回
 * 計算するもの（`core/schedulePlan.ts`）で、巡航速度は VS Code の中にあるので出さない
 * ——案を置く口も台帳の値（`days`・`due`・`status`）を相手にしている。
 *
 * **作品目標設定に従う公募は、作者が段を一度直すまでファイルに無い**（画面は目標から
 * 仮に組み立てて見せる）。案を置く口も断るので、ここでは並べずに断りを添える。
 *
 * 大きさは年表と同じ作法で、**スケジュールの境目で**切って続きの印を返す。
 */
function readSchedule(folder: string, input: NovelReadInput): ScheduleReadResult {
  const notices: string[] = [];
  const shown = `${DEFAULT_SETTINGS_DIR}/${SCHEDULE_FILE}`;
  const target = nodePath.join(nodePath.resolve(folder), DEFAULT_SETTINGS_DIR, SCHEDULE_FILE);
  const goalsContest = readGoalsContest(folder, notices);
  const empty = (file: string | null, unreadableFiles: string[]): ScheduleReadResult => ({
    kind: "schedule",
    file,
    schedules: [],
    total: 0,
    offset: input.offset ?? 0,
    truncated: false,
    next: null,
    unreadableFiles,
    notices,
  });

  if (!fs.existsSync(target)) {
    notices.push(
      "スケジュールがまだありません（作者が拡張機能のスケジュールの画面で作ります。作られてから段の案を置けます）。"
    );
    if (goalsContest) notices.push(goalsRowMissingNotice());
    return empty(null, []);
  }
  let schedules;
  try {
    schedules = parseScheduleFile(JSON.parse(decodeBytes(fs.readFileSync(target)).text)).schedules;
  } catch (error) {
    // 壊れた台帳は直さない（実装ルール2）。読めなかったことだけを返す
    notices.push(`${shown} を読めませんでした（直していません）：${describeError(error)}`);
    return empty(shown, [shown]);
  }
  if (goalsContest && !schedules.some((entry) => entry.id === GOALS_CONTEST_SCHEDULE_ID)) {
    notices.push(goalsRowMissingNotice());
  }

  const entries: ScheduleReadEntry[] = schedules.map((schedule) => ({
    id: schedule.id,
    name: scheduleNameForExternal(schedule),
    scheduleKind: schedule.kind,
    kindLabel: SCHEDULE_KIND_LABELS[schedule.kind],
    milestoneLabel: MILESTONE_LABELS[schedule.kind],
    // 目標に従う公募は締切を写さずに持たない（`models/schedule.ts`）。画面と同じく目標から読む
    milestone: schedule.followsGoals ? (goalsContest?.deadline ?? null) : schedule.milestone,
    followsGoals: schedule.followsGoals,
    steps: schedule.steps.map((step) => ({
      id: step.id,
      label: step.label,
      days: step.days,
      due: step.due,
      status: step.status,
      statusLabel: STEP_STATUS_LABELS[step.status],
      doneAt: step.doneAt,
    })),
  }));
  if (entries.length === 0) {
    notices.push("スケジュールの台帳はありますが、予定が1つもありません。");
  }

  const offset = input.offset ?? 0;
  const candidates = entries.slice(offset, offset + (input.limit ?? MAX_CHRONICLE_LIMIT));
  const compose = (count: number): ScheduleReadResult => {
    const page = candidates.slice(0, count);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < entries.length;
    return {
      kind: "schedule",
      file: shown,
      schedules: page,
      total: entries.length,
      offset,
      truncated,
      next: truncated ? { offset: nextOffset } : null,
      unreadableFiles: [],
      notices: [
        ...notices,
        ...(truncated
          ? [
              `全${entries.length}件の予定のうち${offset + 1}〜${nextOffset}件目を返しました。` +
                `続きは offset: ${nextOffset} で読めます（ほかの引数は同じまま）。`,
            ]
          : []),
        ...(offset > 0 && offset >= entries.length
          ? [`offset（${offset}）が予定の件数（${entries.length}）を超えています。`]
          : []),
      ],
    };
  };
  // 1件ずつ足して、上限を超える手前で止める。**最低1件は返す**（年表・ログと同じ。
  // 0件で続きを示すと、同じ所で永遠に止まる）
  let count = Math.min(1, candidates.length);
  while (count < candidates.length && estimateResultTokens(compose(count + 1)) <= READ_RESULT_TOKEN_BUDGET) {
    count++;
  }
  const result = compose(count);
  if (count === 1 && estimateResultTokens(result) > READ_RESULT_TOKEN_BUDGET) {
    result.notices.push(
      `${offset + 1}件目の予定だけで返事の大きさの目安を超えています。呼び出し側で切られることがあります。`
    );
  }
  return result;
}

/** 目標に従う公募の行がまだファイルに無いときの断り（案を置く口の断りと同じ言い方） */
function goalsRowMissingNotice(): string {
  return (
    "作品目標設定の応募先に従う公募は、作者がスケジュールの画面で一度段を直すまでファイルにありません" +
    "（画面には出ていますが、いまはこの予定へ段の案を置けません）。"
  );
}

/** 作品目標設定の応募先（締切だけ使う）。無い・読めないなら null（読めないときは断りを足す） */
function readGoalsContest(folder: string, notices: string[]): { deadline: string | null } | null {
  const file = nodePath.join(nodePath.resolve(folder), AIWRITER_DIR, WORK_GOALS_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const goals = parseWorkGoals(JSON.parse(decodeBytes(fs.readFileSync(file)).text));
    return goals.contest ? { deadline: goals.contest.deadline } : null;
  } catch (error) {
    notices.push(
      `作品の目標（${AIWRITER_DIR}/${WORK_GOALS_FILE}）を読めませんでした（目標に従う公募の締切は空で返します）：${describeError(error)}`
    );
    return null;
  }
}

/* ── posting ─────────────────────────────────────── */

/**
 * 投稿サイトの入力欄へ貼る形（設計書6.84・6.68）。**製品の［投稿サイト用に変換してコピー］
 * と同じ変換**（`convertForPosting`。1話まるごとの経路なので前後の空行を落とす）を通す。
 *
 * **投稿はしない。** 返すのは貼る文と題だけで、クリップボードにも投稿状態の台帳にも
 * 触れない——貼るのは作者である。
 *
 * **競合の跡が残る話は断る**（投稿キットと同じ。印ごと公開されると取り返しがつかない）。
 * **合本は話を指させる**（画面では一覧から選ばせるところ。指さなければ一覧を添えて断る）。
 *
 * 大きさは年表と同じ作法で、**行の境目で**切って続きの印を返す——字数で切ると
 * ルビの記法（`｜漢字《かんじ》`）の途中で割れ、貼った片方が壊れる。
 */
function readPosting(folder: string, input: NovelReadInput): PostingReadResult {
  const site = input.site;
  if (!site) {
    throw new McpToolError(
      "kind: posting には site（narou・kakuyomu・alphapolis・note のどれか）が要ります。"
    );
  }
  const file = input.file?.trim();
  if (!file) {
    throw new McpToolError(
      "kind: posting には file（話のファイル。novel.scan の filePath）が要ります。"
    );
  }
  const absolute = resolveInsideFolder(folder, file);
  // **本文のファイルだけ。** 設定資料や .aiwriter の中を「投稿用」として返さない
  const isBodyFile = listBodyFiles(folder).some(
    (relative) => resolveInsideFolder(folder, relative) === absolute
  );
  if (!isBodyFile) {
    throw new McpToolError(
      `${file} は本文のファイルではありません（novel.scan の filePath を渡してください）。`
    );
  }
  const shown = toWorkPath(nodePath.resolve(folder), absolute);

  let decoded: ReturnType<typeof decodeBytes>;
  try {
    decoded = decodeBytes(fs.readFileSync(absolute));
  } catch (error) {
    throw new McpToolError(`${shown} を読めませんでした：${describeError(error)}`);
  }
  if (decoded.hasConflictMarkers) {
    throw new McpToolError(
      `${shown} に未解決の競合（<<<<<<<）があります。そのまま投稿すると競合の印ごと公開されるため、変換しません。` +
        "競合を解決してから呼んでください。"
    );
  }

  // 題と本文の切り分けは投稿キットと同じ（頭書きの【タイトル】が優先、無ければファイル名）
  const parts = extractEpisodeParts(
    decoded.text,
    parseEpisodeFileName(nodePath.basename(absolute)).subtitle
  );
  const picked = pickCollected(decoded.text, input.collectedOrder, shown);
  const subtitle = picked ? picked.title ?? parts.subtitle : parts.subtitle;
  const body = picked ? picked.body : parts.body;
  if (!body.trim()) {
    throw new McpToolError(`${shown} に本文が見つかりませんでした。`);
  }

  const converted = convertForPosting(body, postingCopyTargetFor(site), { trimEdges: true });
  const lines = converted.text.split("\n");
  const offset = input.offset ?? 0;
  // note は貼り付けでは入らないものがある。製品の知らせ（`noteCopyMessage`）と同じことを言う
  const noteNotices: string[] = [];
  if (converted.note) {
    if (converted.note.images.length > 0) {
      noteNotices.push(
        `画像${converted.note.images.length}枚は貼り付けでは入りません（【画像：…】の行の位置へ作者がアップロードします）。`
      );
    }
    if (converted.note.embeds.length > 0) {
      noteNotices.push(
        `埋め込み${converted.note.embeds.length}件は、URLの行末でEnterを押すと展開されます。`
      );
    }
    noteNotices.push("目次は note の編集画面のスイッチで入れられます。", ...converted.note.warnings);
  }

  const compose = (count: number): PostingReadResult => {
    const page = lines.slice(offset, offset + count);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < lines.length;
    return {
      kind: "posting",
      site,
      siteLabel: postingSiteInfo(site).label,
      file: shown,
      collectedOrder: picked ? picked.order : null,
      title: converted.note?.title ?? subtitle ?? null,
      text: page.join("\n"),
      chars: converted.text.length,
      totalLines: lines.length,
      offset,
      truncated,
      next: truncated ? { offset: nextOffset } : null,
      ...(converted.note
        ? {
            note: {
              images: converted.note.images,
              embeds: converted.note.embeds,
              warnings: converted.note.warnings,
            },
          }
        : {}),
      notices: [...noteNotices, ...postingPageNotices(offset, page.length, lines.length, truncated)],
    };
  };

  if (offset >= lines.length) {
    const empty = compose(0);
    empty.notices.push(`offset（${offset}）が本文の行の数（${lines.length}）を超えています。`);
    return empty;
  }

  // 年表と同じ詰め方：1行ずつ足し、上限を超える行の手前で止める。**最低1行は返す**
  // （1行だけで上限を超える段落でも、0行を返すと同じ所で永遠に止まる）
  const remaining = lines.length - offset;
  let count = 1;
  while (
    count < remaining &&
    estimateResultTokens(compose(count + 1)) <= READ_RESULT_TOKEN_BUDGET
  ) {
    count++;
  }
  const result = compose(count);
  if (count === 1 && estimateResultTokens(result) > READ_RESULT_TOKEN_BUDGET) {
    result.notices.push(
      `${offset + 1}行目だけで返事の大きさの目安を超えています。呼び出し側で切られることがあります。`
    );
  }
  return result;
}

/**
 * 合本なら1話を選ぶ。合本でなければ null。**指していなければ、入っている話の一覧を
 * 添えて断る**（画面の［どの話をコピーしますか］の代わり。黙って1話目を返すと、
 * 別の話を貼らせることになる）。
 */
function pickCollected(
  text: string,
  order: number | undefined,
  shown: string
): CollectedEpisode | null {
  const episodes = parseCollectedFile(text);
  // 1話ぶんに区切り行が付いているだけのファイルは合本ではない（`isCollectedFile`）
  if (!episodes || !isCollectedFile(episodes.length)) return null;
  const list = episodes
    .map(
      (episode) =>
        `${episode.order}＝${episode.chapter !== null ? `第${episode.chapter}話` : "話数なし"}` +
        `${episode.title ? `「${episode.title}」` : ""}（${episode.body.length.toLocaleString("ja-JP")}字）`
    )
    .join("、");
  if (order === undefined) {
    throw new McpToolError(
      `${shown} は合本（${episodes.length}話）です。どの話かを collectedOrder で指してください：${list}`
    );
  }
  const found = episodes.find((episode) => episode.order === order);
  if (!found) {
    throw new McpToolError(`${shown} に ${order} 番目の話はありません：${list}`);
  }
  return found;
}

/** 返した行の範囲と続きの取り方（年表と同じ書き方） */
function postingPageNotices(
  offset: number,
  shown: number,
  total: number,
  truncated: boolean
): string[] {
  if (!truncated && offset === 0) return [];
  const range = `全${total}行のうち${offset + 1}〜${offset + shown}行目を返しました。`;
  return truncated
    ? [
        `${range}残りの${total - offset - shown}行は offset: ${offset + shown} で読めます（ほかの引数は同じまま）。` +
          "貼る文は、続きをすべて読んでから改行でつないでください。",
      ]
    : [range];
}


/* ── chatLog・log・editHistory ─────────────────────────── */

/**
 * 相談ログ・動作のログの置き場所（`.aiwriter/logs/`。同期しない）。書く側の
 * `core/chatLog.ts`・`core/logger.ts` は `vscode` を import しているので、名前だけ写す
 * （`TIMELINE_FILE` と同じ事情。食い違えば `mcpNovelReadLogs.test.ts` が落ちる）
 */
const LOGS_DIR = "logs";
const CHAT_LOG_FILE = "chat.md";
const ACTION_LOG_FILE = "actions.log";

/** 相談ログの1回の区切り（`renderChatLogEntry` が回の頭に書く横線と見出し） */
const CHAT_ENTRY_SEPARATOR = /\r?\n---\r?\n\r?\n## /;

/**
 * 相談ログ・ログ・編集履歴（作者の裁定 2026-10-16 の6）。**読むだけ**で、無ければ
 * 空と断りを返す（作らない）。読み方は製品と同じ形（編集履歴は `editHistoryFormat.ts`
 * の関数そのもの）。**新しいものが先**——相談の続きや直前の操作を知りたいときに、
 * 古い順だと最初の頁が何か月も前の記録になる。
 */
function readLog(
  folder: string,
  kind: "chatLog" | "log" | "editHistory",
  input: NovelReadInput
): LogReadResult {
  const base = nodePath.resolve(folder);
  const notices: string[] = [];
  const relative =
    kind === "editHistory"
      ? `${AIWRITER_DIR}/${HISTORY_DIRECTORY}/${HISTORY_FILE}`
      : `${AIWRITER_DIR}/${LOGS_DIR}/${kind === "chatLog" ? CHAT_LOG_FILE : ACTION_LOG_FILE}`;
  const file = nodePath.join(base, relative);
  let text = "";
  if (fs.existsSync(file)) {
    try {
      text = decodeBytes(fs.readFileSync(file)).text;
    } catch (error) {
      throw new McpToolError(`${relative} を読めませんでした：${describeError(error)}`);
    }
  } else {
    notices.push(
      kind === "chatLog"
        ? `相談ログはまだありません（${relative}）。作者が相談を使っていないか、設定 novelai.chatLog.enabled を切っています。`
        : kind === "log"
          ? `動作のログはまだありません（${relative}）。`
          : `編集履歴はまだありません（${relative}）。`
    );
  }

  if (kind === "chatLog") {
    return packLogPage(parseChatLog(text), input, notices, (page, paging) => ({
      kind: "chatLog",
      entries: page,
      ...paging,
    }));
  }
  if (kind === "log") {
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .reverse();
    return packLogPage(lines, input, notices, (page, paging) => ({
      kind: "log",
      lines: page,
      ...paging,
    }));
  }
  return packLogPage(sortNewestFirst(parseHistory(text)), input, notices, (page, paging) => ({
    kind: "editHistory",
    entries: page,
    ...paging,
  }));
}

/**
 * 相談ログを回ごとに分ける（新しい回が先）。冒頭の説明（`# 〜 の相談ログ`）は回ではない
 * ので落とす。見出しの行（日時と画面）は `heading` に分け、中身からは外す。
 */
export function parseChatLog(text: string): Array<{ heading: string; text: string }> {
  // 先頭は冒頭の説明（回の区切りより前）
  return text
    .split(CHAT_ENTRY_SEPARATOR)
    .slice(1)
    .map((part) => {
      const newline = part.indexOf("\n");
      const heading = (newline < 0 ? part : part.slice(0, newline)).trim();
      const body = newline < 0 ? "" : part.slice(newline + 1).trim();
      return { heading, text: body };
    })
    .reverse();
}

/**
 * 新しい順に並んだものから、`offset` 件目から上限の手前まで詰める（年表と同じ作法：
 * 1件ずつ足して、上限を超える手前で止める。**最低1件は返す**——1件だけで上限を
 * 超える相談でも、0件で続きを示すと同じ所で永遠に止まる）。
 */
function packLogPage<T>(
  items: readonly T[],
  input: NovelReadInput,
  notices: string[],
  build: (page: T[], paging: LogPage) => LogReadResult
): LogReadResult {
  const offset = input.offset ?? 0;
  const candidates = items.slice(offset, offset + (input.limit ?? MAX_CHRONICLE_LIMIT));
  const compose = (count: number): LogReadResult => {
    const page = candidates.slice(0, count);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < items.length;
    return build(page, {
      total: items.length,
      offset,
      truncated,
      next: truncated ? { offset: nextOffset } : null,
      notices: [
        ...notices,
        ...(truncated
          ? [
              `全${items.length}件のうち、新しいほうから${offset + 1}〜${nextOffset}件目を返しました。` +
                `続きは offset: ${nextOffset} で読めます（ほかの引数は同じまま）。`,
            ]
          : []),
        ...(offset > 0 && offset >= items.length
          ? [`offset（${offset}）が全体の件数（${items.length}）を超えています。`]
          : []),
      ],
    });
  };
  let count = Math.min(1, candidates.length);
  while (
    count < candidates.length &&
    estimateResultTokens(compose(count + 1)) <= READ_RESULT_TOKEN_BUDGET
  ) {
    count++;
  }
  const result = compose(count);
  if (count === 1 && estimateResultTokens(result) > READ_RESULT_TOKEN_BUDGET) {
    result.notices.push(
      `新しいほうから${offset + 1}件目だけで返事の大きさの目安を超えています。呼び出し側で切られることがあります。`
    );
  }
  return result;
}
