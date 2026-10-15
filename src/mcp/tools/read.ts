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
import { readEpisodeFiles } from "./episodeFiles";
import { PARSERS as RECORD_PARSERS, SUBDIRS as RECORD_SUBDIRS } from "./proposeRecord";
import {
  FOLDER_INPUT,
  McpToolError,
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
 * **許可の鍵は道具の名前（`novel.read`）ひとつ。** 今回の6種はどれも作品の資料で、
 * 作者の裁定（2026-10-16 の2）どおり `"*"` に含める。**相談ログ・ログ・編集履歴は
 * 別の鍵にする裁定（同6）がある**——それらを足すときは、`permissionKeyOf` が
 * 既に `kind` を受け取っているので、そこで鍵を分ける。
 */

export const READ_KINDS = [
  "settings",
  "resume",
  "foreshadows",
  "chronicle",
  "relations",
  "locations",
] as const;
export type ReadKind = (typeof READ_KINDS)[number];

export const SETTINGS_RECORD_KINDS = [
  "character",
  "ability",
  "organization",
  "location",
  "world",
] as const;
export type SettingsRecordKind = (typeof SETTINGS_RECORD_KINDS)[number];

export const NOVEL_READ_INPUT = {
  ...FOLDER_INPUT,
  kind: z
    .enum(READ_KINDS)
    .describe(
      "読むもの。settings＝設定資料（人物・能力・組織・場所・世界観）／resume＝執筆再開の1枚／" +
        "foreshadows＝伏線の台帳と一覧／chronicle＝年表（話ごとのあらすじ・登場・出来事・時期）／" +
        "relations＝人物相関図の中身／locations＝場所の略図の中身"
    ),
  term: z
    .string()
    .optional()
    .describe(
      "kind: settings のとき、この語（名前・別名・名前の片方・読み）に当たる記録だけを全体で返す。" +
        "省くと、名前と短い紹介の一覧だけを返す"
    ),
  recordKind: z
    .enum(SETTINGS_RECORD_KINDS)
    .optional()
    .describe("kind: settings のとき、種類で絞る"),
};

export interface NovelReadInput {
  folder: string;
  kind: ReadKind;
  term?: string;
  recordKind?: SettingsRecordKind;
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
      /** 話ごとの行（話数順）。`workPath` は作品フォルダーからの相対 */
      rows: Array<Omit<ChronicleRow, "filePath">>;
      /** 製品の［年表］の書き出しと同じ文書（話数順） */
      markdown: string;
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
    };

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
      return readChronicle(folder);
    case "relations":
      return readRelations(folder);
    case "locations":
      return readLocations(folder);
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
          "今日の執筆量と目標は、VS Code の設定と機械ごとの記録にあるため、MCP では出しません。",
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
function readChronicle(folder: string): NovelReadResult {
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
  const markdown = chronicleToMarkdown(
    rows.length > 0 ? [{ label: "", line: null, kind: "canonical", rows }] : [],
    { workTitle: workTitleOf(folder), order: "chapter" }
  );

  return {
    kind: "chronicle",
    // 開くための絶対パス（`filePath`）は外へ出さない。話の指し先は `workPath`
    rows: rows.map(({ filePath: _filePath, ...rest }) => rest),
    markdown,
    notices,
  };
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
