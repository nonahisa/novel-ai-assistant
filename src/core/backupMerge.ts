import type { Chapter } from "../models/chapter";
import {
  hasReaderStatsMetrics,
  siteProfile,
  type PostingLedger,
  type PostingSiteProfile,
  type ReaderStatsMetrics,
  type ReaderStatsRecord,
} from "../models/posting";
import { parseCollectedFile } from "./collectedFile";
import {
  collectedSectionStarts,
  type CollectedSectionStart,
} from "./collectedSections";
import { parseEpisodeMetadata } from "./metadataParser";
import { countProposableHunks, locateBodyInFile } from "./backupHunks";
import {
  describeMissingEpisodes,
  type MissingBackupEpisode,
} from "./backupMissingEpisodes";
import { decodeBytes, hasConflictMarkers } from "./textDecode";
import type { WorkZipInspection } from "./workZip";

/**
 * 既にある作品へ、バックアップの中身のうち「足してよいもの」だけを足す計画
 * （作者の依頼、2026-09-23。照合は `backupMatch.ts`）。
 *
 * ## 足すもの・足さないもの
 *
 * | バックアップにあるもの | どうするか |
 * |---|---|
 * | 章の見出し（【第N章】） | **章の台帳が空のときだけ**立てる（`collectedSections.ts` と同じ守り） |
 * | いいね（【リアクション】）・作品全体の評価 | 読者の反応の台帳へ**追記**（出どころ `backup`） |
 * | 作品ID（Nコード） | サイトの作品情報が**まだ無いときだけ**書く |
 * | 本文 | **ここでは書き換えない。** 違い1か所ずつを提案パネルに並べ、採るかは作者が箇所ごとに選ぶ（`backupHunks.ts`） |
 * | 手元に無い話 | 題を見せて確かめてから、新しい話のファイルとして足す（既存の話には触らない。`backupMissingEpisodes.ts`） |
 *
 * ## 本文を黙って書き換えない理由（実装ルール1）
 *
 * バックアップと手元の原稿の**どちらが新しいかは、機械には分からない。**
 * サイトの編集画面で直したならバックアップが新しく、手元で直してまだ
 * 投稿していないならバックアップが古い。古いほうで上書きすると、直した
 * ものが消える。だから違いを見せて、どちらを採るかは作者が決める
 * （作者の裁定、2026-09-23：違い1か所ずつを提案にする）。
 *
 * ## コメントは入っていない
 *
 * 2026-09-23 時点で、なろう・カクヨム・アルファポリスのどのバックアップにも
 * コメント（感想）の数は入っていない（なろうの合本の見出しを実物で数えて
 * 確かめた）。**入っていないものは作らない**——0件と書くと、次に手入力した
 * ときに増えたように見える。
 *
 * VS Code API には依存しない（ファイルを読むのは呼ぶ側）。
 */

/** バックアップの中の1話 */
export interface BackupEpisode {
  /**
   * 並び順（1始まり）。合本は区切り行の「エピソードN開始」のN、
   * 話ごとのファイル（カクヨム）はファイル名順の何番目か
   */
  readonly order: number;
  /** 作者に見せる見出し（「3話　再会」。読めなければ「3番目の話」） */
  readonly label: string;
  /** 直前の章の見出し（【第N章】の値）。無ければ null */
  readonly part: string | null;
  readonly body: string;
  /**
   * 話ごとのファイルのとき、本文フォルダーからの名前（`episode_0001.txt`）。
   * **手元の同じ名前のファイルと照らす**のに使う。合本の話は null
   */
  readonly fileName: string | null;
}

/** 手元の原稿ファイル1つぶんの材料（読むのは呼ぶ側） */
export interface LocalManuscriptSource {
  /** 作品フォルダーからの相対パス（`/` 区切り）。章の台帳はこれを指す */
  readonly relPath: string;
  /** 本文フォルダーからの相対パス（`/` 区切り） */
  readonly manuscriptName: string;
  /** 全文。**読めなかったら null** */
  readonly text: string | null;
  /**
   * 読んだときのハッシュ（`readTextFile` の `hash`）。**違いを提案にするのに要る**
   * ——提案を作ってから当てるまでに原稿が変わったら当てない（実装ルール1）。
   * 無ければ、違いは記録にだけ残す
   */
  readonly hash?: string;
}

/** 手元の原稿の中の1話 */
interface LocalEpisode {
  readonly relPath: string;
  readonly manuscriptName: string;
  /** 区切り行の番号。区切り行の無いファイルは null（並びでは照らさない） */
  readonly order: number | null;
  /** そのファイルの中で何番目の話か（0始まり）。章はファイルの頭にしか置けない */
  readonly indexInFile: number;
  readonly body: string;
  /** そのファイルの全文（本文の在り処を探すのに使う） */
  readonly fileText: string;
  readonly fileHash: string | null;
}

/** 章の台帳をどうするか */
export type ChapterMergePlan =
  /** バックアップに章の見出しが無い */
  | { readonly kind: "none" }
  /** 台帳に既に章がある。**立てない**（作者の章を上書きしない） */
  | { readonly kind: "existing"; readonly count: number; readonly existingCount: number }
  /** 台帳を読めなかった。**立てない** */
  | { readonly kind: "unreadable"; readonly count: number }
  /**
   * 置けない章がある。**1つも立てない**（`chaptersFromHeadings.ts` と同じ判断）。
   * 一部だけ立てると台帳が空でなくなり、あとで分けても残りが立たない
   */
  | {
      readonly kind: "blocked";
      readonly count: number;
      /** 手元の合本の途中から始まる章の数（ファイルの頭にしか置けない） */
      readonly insideCollected: number;
      /** 始まりの話が手元に見当たらない章の数 */
      readonly missing: number;
    }
  /** 台帳が空なので、手元の実在のファイルを指して章を立てる */
  | {
      readonly kind: "create";
      readonly sections: readonly CollectedSectionStart[];
      readonly chapters: readonly Chapter[];
    };

/** 1話ぶんの本文の違い */
export interface EpisodeBodyDiff {
  readonly order: number;
  readonly label: string;
  /** 手元のどのファイルか（作品フォルダーからの相対パス） */
  readonly relPath: string;
  readonly hunks: readonly DiffHunk[];
  /**
   * 本文の1行目が、ファイルの何行目の**1つ前**か（0始まりの位置）。
   * `hunk.localLine` に足すとファイルの行番号になる。
   *
   * **本文をファイルの中で1か所に決められなければ null**——そのときは
   * 提案にせず、記録（「違いを見る」）にだけ残す（`backupHunks.ts`）
   */
  readonly bodyLineOffset: number | null;
  /** 読んだときのファイルのハッシュ。分からなければ null（提案にしない） */
  readonly fileHash: string | null;
}

/** 本文の違いの1か所。行の単位で持つ */
export interface DiffHunk {
  /** 手元の本文の何行目から（1始まり。本文の頭から数える） */
  readonly localLine: number;
  /** 手元にあって、バックアップに無い行 */
  readonly local: readonly string[];
  /** バックアップにあって、手元に無い行 */
  readonly backup: readonly string[];
}

export interface BackupMergePlan {
  readonly chapters: ChapterMergePlan;
  /** 台帳へ足す読者の反応（まだ足していない） */
  readonly readerStats: readonly ReaderStatsRecord[];
  /** 足さなかった読者の反応の数（前にも同じ数字を取り込んでいた） */
  readonly readerStatsAlready: number;
  /**
   * 投稿状態の台帳を読めなかったので、反応を足せないか。
   *
   * **「入っていません」と取り違えない。** 数字はバックアップにあるのに、
   * 台帳が壊れていて足せない——作者が直すべきなのは台帳のほうである。
   */
  readonly readerStatsBlocked: boolean;
  /** サイトの作品情報を新しく書くなら、その中身。書かないなら null */
  readonly profile: { readonly site: "narou"; readonly value: PostingSiteProfile } | null;
  /** 本文が違った話 */
  readonly bodyDiffs: readonly EpisodeBodyDiff[];
  /** 本文が同じだった話の数 */
  readonly sameBodies: number;
  /** 手元に見当たらなかった話の数（`missingEpisodes` の数） */
  readonly unmatched: number;
  /**
   * 手元に見当たらなかった話（作者の裁定、2026-09-23：確かめてから新しい話の
   * ファイルとして足す）。中身の用意は `backupMissingEpisodes.ts`
   */
  readonly missingEpisodes: readonly MissingBackupEpisode[];
  /** 手元の同じ番号の話が2つ以上あって、どれと比べるか決められなかった数 */
  readonly ambiguousLocal: number;
  /** 競合マーカーがあって比べなかった手元のファイル */
  readonly conflicted: readonly string[];
  /** 読めなかった手元のファイル */
  readonly unreadable: readonly string[];
}

/* ── バックアップの話を並べる ─────────────────────────── */

/**
 * 点検済みのバックアップから、話を並べる。
 *
 * **読み方は取り込みと同じ部品を通す**（合本は `parseCollectedFile`、
 * 話ごとのファイルは `parseEpisodeMetadata`）。ここで見出しの読み方を
 * 写すと、新しく取り込んだ作品と、既にある作品へ足すときとで章の題が
 * 食い違う日が来る。
 */
export function backupEpisodesOf(inspection: WorkZipInspection): BackupEpisode[] {
  const episodes: BackupEpisode[] = [];
  const files = inspection.files.filter((file) => !file.isWorkInfo);

  for (const file of files) {
    const text = decodeBytes(file.bytes).text;
    const collected = parseCollectedFile(text);
    if (collected) {
      for (const episode of collected) {
        episodes.push({
          order: episode.order,
          label: labelOf(episode.chapter, episode.title, episode.order),
          part: episode.part,
          body: episode.body,
          fileName: null,
        });
      }
      continue;
    }
    const metadata = parseEpisodeMetadata(text);
    const order = episodes.length + 1;
    episodes.push({
      order,
      label: metadata.title ?? file.name,
      part: null,
      body: metadata.hasMetadata ? metadata.body : text,
      fileName: file.name,
    });
  }
  return episodes;
}

function labelOf(
  chapter: number | null,
  title: string | null,
  order: number
): string {
  if (chapter !== null) return title ? `${chapter}話　${title}` : `${chapter}話`;
  return title ?? `${order}番目の話`;
}

/* ── 手元の原稿を並べる ───────────────────────────────── */

interface LocalReading {
  readonly episodes: LocalEpisode[];
  readonly conflicted: string[];
  readonly unreadable: string[];
}

function readLocalEpisodes(
  sources: readonly LocalManuscriptSource[]
): LocalReading {
  const episodes: LocalEpisode[] = [];
  const conflicted: string[] = [];
  const unreadable: string[] = [];

  for (const source of sources) {
    if (source.text === null) {
      unreadable.push(source.relPath);
      continue;
    }
    /*
      **競合マーカーのあるファイルは比べない**（実装ルール1）。どちらの側が
      本当の本文か分からない状態で「違いがあります」と言うと、作者は
      マーカーの片側を採るつもりで提案を読んでしまう。
    */
    if (hasConflictMarkers(source.text)) {
      conflicted.push(source.relPath);
      continue;
    }
    const collected = parseCollectedFile(source.text);
    if (collected) {
      collected.forEach((episode, index) => {
        episodes.push({
          relPath: source.relPath,
          manuscriptName: source.manuscriptName,
          order: episode.order,
          indexInFile: index,
          body: episode.body,
          fileText: source.text as string,
          fileHash: source.hash ?? null,
        });
      });
      continue;
    }
    const metadata = parseEpisodeMetadata(source.text);
    episodes.push({
      relPath: source.relPath,
      manuscriptName: source.manuscriptName,
      // **区切り行の無いファイルは並びで照らさない。** 作者が手で書き足した
      // 話（`エピソード32.txt`）の並びは、バックアップの番号と一致する保証が無い
      order: null,
      indexInFile: 0,
      body: metadata.hasMetadata ? metadata.body : source.text,
      fileText: source.text,
      fileHash: source.hash ?? null,
    });
  }
  return { episodes, conflicted, unreadable };
}

/**
 * バックアップの1話に当たる手元の話を探す。
 *
 * - 話ごとのファイル（カクヨム）は**同じ名前のファイル**
 * - 合本の話は**区切り行の番号**（手元の合本、分け済みのファイルのどちらでも）
 *
 * @returns 1つに決まれば その話、無ければ "missing"、2つ以上なら "ambiguous"
 */
function findLocal(
  backup: BackupEpisode,
  locals: readonly LocalEpisode[]
): LocalEpisode | "missing" | "ambiguous" {
  const found =
    backup.fileName !== null
      ? locals.filter(
          (local) => local.manuscriptName === backup.fileName && local.order === null
        )
      : locals.filter((local) => local.order === backup.order);
  if (found.length === 0) return "missing";
  if (found.length > 1) return "ambiguous";
  return found[0];
}

/* ── 計画を立てる ─────────────────────────────────────── */

/**
 * 既にある作品へ足すものを決める。**まだ何も書かない。**
 *
 * @param existingChapters いまの章の台帳。**読めなかったときは null**
 * @param ledger いまの投稿状態の台帳。**読めなかったときは null**（反応は足さない）
 * @param readAt 読者の反応に書く日時（取り込んだ日時。バックアップの日時は分からない）
 */
export function planBackupMerge(input: {
  inspection: WorkZipInspection;
  local: readonly LocalManuscriptSource[];
  existingChapters: readonly Chapter[] | null;
  ledger: PostingLedger | null;
  readAt: string;
}): BackupMergePlan {
  const backupEpisodes = backupEpisodesOf(input.inspection);
  const local = readLocalEpisodes(input.local);

  const matches = backupEpisodes.map((episode) => ({
    episode,
    local: findLocal(episode, local.episodes),
  }));

  const bodyDiffs: EpisodeBodyDiff[] = [];
  let sameBodies = 0;
  const missingEpisodes: MissingBackupEpisode[] = [];
  let ambiguousLocal = 0;
  for (const { episode, local: found } of matches) {
    if (found === "missing") {
      /*
        **番号でも名前でも照らせなかった話が、手元に本文ごと在ることがある。**
        作者が手で書き足した話（`エピソード32.txt`）は区切り行を持たないので
        番号では照らせないが、サイトへ出したあとのバックアップには入っている。
        本文がそっくり同じ話が手元にあれば「在る」と見る——足すと同じ話が
        2つになる（作者の原稿に重複を作らない）。
      */
      if (hasSameBodyElsewhere(episode.body, local.episodes)) {
        sameBodies++;
        continue;
      }
      missingEpisodes.push({
        order: episode.order,
        label: episode.label,
        part: episode.part,
        fileName: episode.fileName,
      });
      continue;
    }
    if (found === "ambiguous") {
      ambiguousLocal++;
      continue;
    }
    const hunks = diffBodies(found.body, episode.body);
    if (hunks.length === 0) {
      sameBodies++;
      continue;
    }
    bodyDiffs.push({
      order: episode.order,
      label: episode.label,
      relPath: found.relPath,
      hunks,
      bodyLineOffset: locateBodyInFile(found.fileText, found.body),
      fileHash: found.fileHash,
    });
  }

  const readerStats = input.ledger
    ? backupReaderStats(input.inspection, input.ledger, input.readAt)
    : { records: [], already: 0 };

  return {
    chapters: planChapters(
      backupEpisodes,
      matches.map((entry) => entry.local),
      input.existingChapters
    ),
    readerStats: readerStats.records,
    readerStatsAlready: readerStats.already,
    readerStatsBlocked: input.ledger === null && input.inspection.narou !== null,
    profile: input.ledger ? profileToAdd(input.inspection, input.ledger) : null,
    bodyDiffs,
    sameBodies,
    unmatched: missingEpisodes.length,
    missingEpisodes,
    ambiguousLocal,
    conflicted: local.conflicted,
    unreadable: local.unreadable,
  };
}

/** 足すものが1つも無く、見せる違いも無いか */
export function isEmptyMergePlan(plan: BackupMergePlan): boolean {
  return (
    plan.chapters.kind !== "create" &&
    plan.readerStats.length === 0 &&
    plan.profile === null &&
    plan.bodyDiffs.length === 0 &&
    plan.missingEpisodes.length === 0
  );
}

function planChapters(
  episodes: readonly BackupEpisode[],
  locals: readonly (LocalEpisode | "missing" | "ambiguous")[],
  existingChapters: readonly Chapter[] | null
): ChapterMergePlan {
  const sections = collectedSectionStarts(episodes);
  if (sections.length === 0) return { kind: "none" };
  if (existingChapters === null) {
    return { kind: "unreadable", count: sections.length };
  }
  if (existingChapters.length > 0) {
    return {
      kind: "existing",
      count: sections.length,
      existingCount: existingChapters.length,
    };
  }

  let insideCollected = 0;
  let missing = 0;
  const chapters: Chapter[] = [];
  for (const section of sections) {
    const found = locals[section.startIndex];
    if (found === "missing" || found === "ambiguous") {
      missing++;
      continue;
    }
    // **章の台帳はファイルしか指せない**（6.66.4）。合本の途中には置けない
    if (found.indexInFile > 0) {
      insideCollected++;
      continue;
    }
    chapters.push({ name: section.name, startEpisodePath: found.relPath });
  }

  // 同じファイルから2つの章が始まることは起きないはずだが、台帳が受け付けない
  // 形は書かない（読み込みで弾かれて、台帳ごと読めなくなる）
  const starts = new Set(chapters.map((chapter) => chapter.startEpisodePath));
  if (insideCollected > 0 || missing > 0 || starts.size !== chapters.length) {
    return {
      kind: "blocked",
      count: sections.length,
      insideCollected,
      missing: missing + (starts.size !== chapters.length ? 1 : 0),
    };
  }
  return { kind: "create", sections, chapters };
}

/**
 * バックアップに入っていた読者の反応のうち、台帳へ足すもの。
 *
 * **同じ数字を2度積まない。** 同じバックアップを2回持ち込んだとき、
 * 取り込んだ日時だけが違う同じ数字が並ぶと、推移の線が平らなまま
 * 点だけ増える。**その話の、バックアップ由来の最新の記録と同じなら足さない。**
 * 数字が変わっていれば足す（それが推移である）。
 */
function backupReaderStats(
  inspection: WorkZipInspection,
  ledger: PostingLedger,
  readAt: string
): { records: ReaderStatsRecord[]; already: number } {
  const narou = inspection.narou;
  if (!narou) return { records: [], already: 0 };

  const latest = (scope: "work" | "episode", episode?: number) => {
    const rows = (ledger.readerStats ?? []).filter(
      (row) =>
        row.site === "narou" &&
        row.source === "backup" &&
        row.scope === scope &&
        (scope === "work" || row.episode === episode)
    );
    return rows.length > 0 ? rows[rows.length - 1] : undefined;
  };

  const records: ReaderStatsRecord[] = [];
  let already = 0;
  const consider = (
    scope: "work" | "episode",
    metrics: ReaderStatsMetrics,
    episode?: number
  ) => {
    if (!hasReaderStatsMetrics(metrics)) return;
    const previous = latest(scope, episode);
    if (previous && sameMetrics(previous.metrics, metrics)) {
      already++;
      return;
    }
    records.push({
      site: "narou",
      readAt,
      scope,
      ...(episode === undefined ? {} : { episode }),
      metrics,
      source: "backup",
    });
  };

  consider("work", narou.header.metrics);
  for (const reaction of narou.episodes) {
    consider("episode", reaction.metrics, reaction.episode);
  }
  return { records, already };
}

function sameMetrics(a: ReaderStatsMetrics, b: ReaderStatsMetrics): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * サイトの作品情報を書くなら、その中身。
 *
 * **その サイトの作品情報がまだ無いときだけ**書く（取り込みの
 * `notePostingSite` と同じ守り）。あれば、作者が書いたメモやジャンルを
 * 押し流さないよう何もしない——作品IDが空の行へ書き足すこともしない。
 */
function profileToAdd(
  inspection: WorkZipInspection,
  ledger: PostingLedger
): BackupMergePlan["profile"] {
  const header = inspection.narou?.header;
  if (!header) return null;
  if (siteProfile(ledger, "narou")) return null;
  return {
    site: "narou",
    value: {
      workId: header.ncode,
      workUrl: header.workUrl,
      ...(header.genre ? { genre: header.genre } : {}),
    },
  };
}

/** 反応の記録を読んで、いいねを足す話の数と、作品全体を足すか */
export function describeReaderStatsCounts(
  records: readonly ReaderStatsRecord[]
): { work: boolean; episodes: number } {
  return {
    work: records.some((record) => record.scope === "work"),
    episodes: records.filter((record) => record.scope === "episode").length,
  };
}

/* ── 本文の違い ───────────────────────────────────────── */

/**
 * 行ごとの比較をする大きさの上限（手元の行数 × バックアップの行数）。
 *
 * 1話は多くても数百行なので普段は届かない。合本を1話として比べるような
 * 取り違えが起きたときに、比較で固まらないための柵である。超えたら
 * 「全体が違う」1か所として返す（違うことは確かなので、黙らない）。
 */
const DIFF_CELL_LIMIT = 4_000_000;

/**
 * 2つの本文の違いを、行の単位で返す。同じなら空。
 *
 * **比べる前に、行末の空白と前後の空行だけをそろえる。** サイトは行末の
 * 空白を落として保存することがあり、それを「違い」と数えると、全話が
 * 違うことになる。**行頭の全角空白（字下げ）はそろえない**——作者の書式である。
 */
export function diffBodies(localBody: string, backupBody: string): DiffHunk[] {
  const a = linesForDiff(localBody);
  const b = linesForDiff(backupBody);

  // 頭と尻の同じ行を先に落とす（大抵の違いは数行なので、ここで表がほぼ消える）
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length === 0 && midB.length === 0) return [];

  if (midA.length * midB.length > DIFF_CELL_LIMIT) {
    return [{ localLine: head + 1, local: midA, backup: midB }];
  }

  return lcsHunks(midA, midB).map((hunk) => ({
    ...hunk,
    localLine: hunk.localLine + head,
  }));
}

/** 手元のどれかの話が、比べ方をそろえたうえでこの本文とそっくり同じか */
function hasSameBodyElsewhere(
  body: string,
  locals: readonly LocalEpisode[]
): boolean {
  const key = linesForDiff(body).join("\n");
  if (key === "") return false;
  return locals.some((local) => linesForDiff(local.body).join("\n") === key);
}

function linesForDiff(body: string): string[] {
  const lines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t　]+$/u, ""));
  // 行末の全角空白も落とすが、**行頭は触らない**（字下げは作者の書式）
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 最長共通部分列で行を対応させ、対応しなかった行をまとめて返す */
function lcsHunks(a: readonly string[], b: readonly string[]): DiffHunk[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // 上限で n*m を抑えてあるので、長さは 65535 を超えない（Uint16 で足りる）
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const hunks: DiffHunk[] = [];
  let current: { localLine: number; local: string[]; backup: string[] } | null =
    null;
  const flush = () => {
    if (current) hunks.push(current);
    current = null;
  };
  const open = (i: number) => {
    if (!current) current = { localLine: i + 1, local: [], backup: [] };
    return current;
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (
      j < m &&
      (i >= n || table[i * width + j + 1] >= table[(i + 1) * width + j])
    ) {
      open(i).backup.push(b[j]);
      j++;
    } else {
      open(i).local.push(a[i]);
      i++;
    }
  }
  flush();
  return hunks;
}

/* ── 作者に見せる言葉 ─────────────────────────────────── */

/** 確認の画面に並べる章の題の数 */
const LISTED_CHAPTERS = 3;

/**
 * 押す前に見せる一覧（実装ルール2：何を足すか・何を足さないかを先に言う）。
 */
export function describeMergePlan(
  plan: BackupMergePlan,
  options: {
    /**
     * 本文の違いを提案パネルへ並べられるか（提案パネルへの口が繋がっているか）。
     * 繋がっていなければ、これまでどおり記録へ書き出すとだけ言う
     */
    readonly proposals?: boolean;
  } = {}
): string[] {
  const lines: string[] = [];

  lines.push(`・章：${describeChapterPlan(plan.chapters)}`);

  const counts = describeReaderStatsCounts(plan.readerStats);
  const stats = [
    counts.episodes > 0 ? `いいね${counts.episodes}話ぶん` : "",
    counts.work ? "作品全体の評価" : "",
  ].filter((part) => part !== "");
  if (stats.length > 0) {
    lines.push(`・読者の反応：${stats.join("と")}を台帳へ足します（これまでの記録は消しません）`);
  } else if (plan.readerStatsBlocked) {
    lines.push(
      "・読者の反応：投稿状態の台帳（設定/投稿状態.json）を読めなかったため、足しません"
    );
  } else if (plan.readerStatsAlready > 0) {
    lines.push("・読者の反応：前に取り込んだときと同じ数字なので、足しません");
  } else {
    lines.push("・読者の反応：このバックアップには入っていません");
  }
  lines.push("・コメント：このバックアップには入っていません");

  if (plan.profile) {
    lines.push(
      `・投稿先の作品ID：${plan.profile.value.workId?.toUpperCase() ?? ""} を書き留めます`
    );
  }

  const proposable = options.proposals ? countProposableHunks(plan.bodyDiffs) : 0;
  if (plan.bodyDiffs.length > 0 && proposable > 0) {
    /*
      **違い1か所ずつを提案にする**（作者の裁定、2026-09-23）。
      どちらが新しいかは機械には分からないので、ここでは書き換えず、
      採るかどうかを作者が箇所ごとに選ぶ。
    */
    const total = plan.bodyDiffs.reduce((sum, diff) => sum + diff.hunks.length, 0);
    lines.push(
      `・本文の違い：${plan.bodyDiffs.length}話（${proposable}か所）。提案パネルに並べます（${listEpisodes(plan.bodyDiffs)}）`,
      "　原稿はまだ書き換えません。1か所ずつ、手元のままにするか、" +
        "バックアップの文を採るかを選べます。"
    );
    if (proposable < total) {
      lines.push(
        `　うち${total - proposable}か所は原稿の中の位置を決められないため、` +
          "「バックアップとの違い」の記録にだけ書き出します。"
      );
    }
  } else if (plan.bodyDiffs.length > 0) {
    lines.push(
      `・本文の違い：${plan.bodyDiffs.length}話（${listEpisodes(plan.bodyDiffs)}）`,
      "　原稿は書き換えません。どちらが新しいかは機械には分からないので、" +
        "違いを「バックアップとの違い」に書き出します。"
    );
  } else {
    lines.push("・本文の違い：ありません");
  }

  // 手元に無い話（作者の裁定、2026-09-23：題を並べて、確かめてから足す）
  lines.push(...describeMissingEpisodes(plan.missingEpisodes));

  const notes: string[] = [];
  if (plan.ambiguousLocal > 0) {
    notes.push(
      `手元に同じ番号の話が2つ以上あって、比べる相手を決められなかった話が${plan.ambiguousLocal}話あります。`
    );
  }
  if (plan.conflicted.length > 0) {
    notes.push(
      `競合の印（<<<<<<<）があるファイルが${plan.conflicted.length}件あり、比べていません。先に競合を解消してください。`
    );
  }
  if (plan.unreadable.length > 0) {
    notes.push(`読めなかったファイルが${plan.unreadable.length}件あります。`);
  }
  return notes.length > 0 ? [...lines, "", ...notes] : lines;
}

function describeChapterPlan(plan: ChapterMergePlan): string {
  switch (plan.kind) {
    case "none":
      return "バックアップに章の見出しはありません";
    case "create":
      return `${plan.chapters.length}個立てます（${listChapters(plan.chapters)}）。章立ての台帳に書くだけで、原稿は書き換えません`;
    case "existing":
      return `章立ての台帳に既に${plan.existingCount}個あるため、立てません（作者の章を上書きしないため）`;
    case "unreadable":
      return "章立ての台帳を読めなかったため、立てません";
    case "blocked": {
      const why = [
        plan.insideCollected > 0
          ? `手元の合本の途中から始まる章が${plan.insideCollected}個あります（章はファイルの頭からしか始められません。先に「合本を話ごとに分ける」を使うと、そのとき章も立ちます）`
          : "",
        plan.missing > 0
          ? `始まりの話が手元に見当たらない章が${plan.missing}個あります`
          : "",
      ].filter((part) => part !== "");
      return `${plan.count}個の見出しがありますが、立てません。${why.join("。")}`;
    }
  }
}

function listChapters(chapters: readonly Chapter[]): string {
  const listed = chapters
    .slice(0, LISTED_CHAPTERS)
    .map((chapter) => `「${chapter.name}」`)
    .join("");
  const rest = chapters.length - LISTED_CHAPTERS;
  return rest > 0 ? `${listed}ほか${rest}個` : listed;
}

function listEpisodes(diffs: readonly EpisodeBodyDiff[]): string {
  const listed = diffs
    .slice(0, LISTED_CHAPTERS)
    .map((diff) => diff.label)
    .join("・");
  const rest = diffs.length - LISTED_CHAPTERS;
  return rest > 0 ? `${listed} ほか${rest}話` : listed;
}

/**
 * 相談パネルに出す、済んだことの短い一文。
 *
 * 例：「コールドスリープ」へ取り込みました：章5・いいね31話ぶん・本文の違い3話（記録に残しました）
 */
export function summarizeMergeResult(input: {
  workTitle: string;
  chapters: number;
  likesEpisodes: number;
  workStats: boolean;
  bodyDiffs: number;
  recorded: boolean;
  /** 提案パネルに並べた違いの数（並べなければ 0 か省く） */
  proposals?: number;
  /** 手元に無かったので新しいファイルとして足した話の数 */
  addedEpisodes?: number;
}): string {
  const proposals = input.proposals ?? 0;
  const bodyNote =
    proposals > 0
      ? `（${proposals}か所を提案パネルに並べました。原稿はまだ書き換えていません）`
      : input.recorded
        ? "（記録に残しました。原稿は書き換えていません）"
        : "";
  const parts = [
    input.chapters > 0 ? `章${input.chapters}` : "",
    input.likesEpisodes > 0 ? `いいね${input.likesEpisodes}話ぶん` : "",
    input.workStats ? "作品全体の評価" : "",
    (input.addedEpisodes ?? 0) > 0 ? `新しい話${input.addedEpisodes}話` : "",
    input.bodyDiffs > 0 ? `本文の違い${input.bodyDiffs}話${bodyNote}` : "",
  ].filter((part) => part !== "");
  if (parts.length === 0) {
    return `「${input.workTitle}」に足すものはありませんでした。`;
  }
  return `「${input.workTitle}」へ取り込みました：${parts.join("・")}`;
}

/** 1か所に並べる行の上限。長い書き換えで記録が読めなくなるのを防ぐ */
const RECORD_LINES_PER_SIDE = 40;

/** 「バックアップとの違い」の記録の見出し（生成文書の種類名にも使う） */
export const BACKUP_DIFF_RECORD_KIND = "バックアップとの違い";

/**
 * 本文の違いの記録（Markdown）。**読むためだけのもの**で、どこにも当てない。
 *
 * `-` が手元、`+` がバックアップ。**この記録から原稿へ書き戻す道は作らない**
 * ——採るのは提案パネルの1か所ずつの提案で、そちらはハッシュの照合を通る。
 * 記録は、提案にできなかった違い（位置を決められない）も含めた全部の控えである。
 */
export function buildBackupDiffRecord(input: {
  workTitle: string;
  sourceName: string;
  diffs: readonly Pick<EpisodeBodyDiff, "label" | "relPath" | "hunks">[];
}): string {
  const lines: string[] = [
    `# ${BACKUP_DIFF_RECORD_KIND}：${input.workTitle}`,
    "",
    `比べたバックアップ：${input.sourceName}`,
    "",
    "`-` の行が手元の原稿、`+` の行がバックアップです。",
    "原稿は書き換えていません。どちらが新しいかは機械には分からないため、",
    "採るほうを選んでください（提案パネルに並んだ違いは、そこで1か所ずつ採れます）。",
    "",
  ];
  for (const diff of input.diffs) {
    lines.push(`## ${diff.label}（${diff.relPath}）`, "");
    for (const hunk of diff.hunks) {
      lines.push(`本文の${hunk.localLine}行目あたり`, "", "~~~diff");
      lines.push(...clip(hunk.local).map((line) => `- ${line}`));
      lines.push(...clip(hunk.backup).map((line) => `+ ${line}`));
      lines.push("~~~", "");
    }
  }
  return lines.join("\n");
}

function clip(lines: readonly string[]): string[] {
  if (lines.length <= RECORD_LINES_PER_SIDE) return [...lines];
  return [
    ...lines.slice(0, RECORD_LINES_PER_SIDE),
    `（ほか${lines.length - RECORD_LINES_PER_SIDE}行）`,
  ];
}
