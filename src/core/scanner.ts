import * as vscode from "vscode";
import * as path from "./paths";
import {
  EpisodeFile,
  SUPPORTED_EXTENSIONS,
  WorkEntry,
  WorkStats,
} from "../models/types";
import { addCounts, emptyCounts } from "./charCount";
import { countEpisodeChars, episodeBodyForCount } from "./episodeCharCount";
import { parseEpisodeFileName } from "./episodeParser";
import { readWorkConfig, workPaths } from "./workRegistry";
import { parseEpisodeMetadata } from "./metadataParser";
import { isConflictSideFile } from "./conflictFile";
import { isWorkInfoFile } from "./workInfoFile";
import { parseCollectedFile, type CollectedEpisode } from "./collectedFile";
import { memoBadgeText, parseMemos } from "./sceneMemo";
import { pathExists } from "./fileSystem";
import { fileReader, type FileReader } from "./fileRead";
import { detectEol } from "./eolAudit";
import type { Eol } from "../models/types";

/**
 * 走査1回ぶんの計測（設計書6.107）。
 *
 * **I/O ではなく計算そのものが重い、という疑いを確かめるために要る。**
 * 0.74.7 で読み口を Node の `fs` へ替えたところ、登録簿の整備は
 * 15.2秒→43ms になったのに、**作品一覧の初回描画は25.1秒のまま**だった。
 * 整備の待ちがバラバラの位置で詰まっていたことから、**同じスレッドで
 * 走っている走査が CPU を握っている**疑いが残った。読み（I/O）と
 * 数え・解析（CPU）を分けて測れば、どちらかが決まる。
 *
 * **計測は `performance.now()` の差を足すだけ**で、走査の結果
 * （`episodes`・`stats`）は1バイトも変えない。
 */
export interface ScanTiming {
  /** 走査したファイルの数（作品情報のファイルも含む） */
  readonly files: number;
  /**
   * 読み口に費やしたミリ秒。
   *
   * **バイトを本文にするまでを含める**（`readFile` と `decodeText`）。
   * フォルダーの読み出し（`readDirectory`）と作品設定の読み込みも、
   * 同じ読み口なのでここへ入れる。
   */
  readonly readMs: number;
  /** 字数・ルビ・空白の数えに費やしたミリ秒（シーンメモの印も含む） */
  readonly countMs: number;
  /** 合本の分割・メタデータ・改行の判定・競合の検出に費やしたミリ秒 */
  readonly parseMs: number;
  /** 上のどれでもない残り（話の組み立て・並べ替え・合計）。差で求める */
  readonly otherMs: number;
  /** 走査ぜんたいにかかったミリ秒 */
  readonly totalMs: number;
  /** いちばん時間のかかったファイルの名前。1つも読まなければ `undefined` */
  readonly slowestFile?: string;
  /** その1ファイルにかかったミリ秒 */
  readonly slowestMs: number;
}

/**
 * 作品の本文ファイルを走査し、話数解析と文字数計測を行う。
 *
 * 本文フォルダが存在しない場合は、作品フォルダ直下を対象にする。
 * カクヨム等からDLしたファイルをそのまま入れたフォルダを
 * 登録するケースを想定している。
 */
export async function scanWork(work: WorkEntry): Promise<{
  episodes: EpisodeFile[];
  stats: WorkStats;
  manuscriptDir: string;
  /**
   * 作品情報のファイル（絶対パス）。**話には数えない**（`workInfoFile.ts`）。
   *
   * 落としたことが分かるように返す。画面に「作品情報」として見せるかは
   * 使う側の判断だが、**黙って消したことにはしない。**
   */
  workInfoFiles: string[];
  /** 何にどれだけかかったか（設計書6.107）。**使わなくてよい** */
  timing: ScanTiming;
}> {
  const scanStartedAt = performance.now();
  /*
    **計測は数えるだけ**（設計書6.107）。`performance.now()` の差を
    足す以外のことはせず、走査の結果には触らない。
  */
  let readMs = 0;
  let countMs = 0;
  let parseMs = 0;
  let slowestMs = 0;
  let slowestFile: string | undefined;

  const config = await readWorkConfig(work);
  const p = workPaths(work, config);

  const targetDir = (await pathExists(p.manuscript)) ? p.manuscript : p.root;
  /*
    **ここだけ読み口を切り替える**（設計書6.107）。走査は573ファイルを
    1つずつ読むので、`vscode.workspace.fs` の列に全部が並ぶと一覧が出るまで
    26〜35秒かかっていた。**読むだけ**の道なので、手元では Node の `fs` で
    読む（`core/fileRead.ts`）。書き込みは1つもここに無い。
  */
  const reader = await fileReader();
  const files = await collectTextFiles(targetDir, reader);
  // **下ごしらえも読み口**（設計書6.107）。作品設定の読み込み・本文
  // フォルダーの有無・フォルダーの読み出しは、すべてファイルへの往復である
  readMs += performance.now() - scanStartedAt;

  const episodes: EpisodeFile[] = [];
  const workInfoFiles: string[] = [];
  const excludeRuby = vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>("excludeRubyFromCount", true);

  /**
   * 1ファイルぶんの計測を締める（設計書6.107）。
   *
   * **ループから抜ける所すべてで呼ぶ。** いまは2つある——作品情報の
   * ファイルで `continue` する道と、話として積む道。増やすときは
   * ここを呼ぶのを忘れないこと（漏らすと「最長」がそのぶん軽く出る）。
   */
  const noteFile = (name: string, startedAt: number): void => {
    const elapsed = performance.now() - startedAt;
    if (elapsed > slowestMs) {
      slowestMs = elapsed;
      slowestFile = name;
    }
  };

  for (const filePath of files) {
    const fileStartedAt = performance.now();
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const parsed = parseEpisodeFileName(fileName);

    let counts = emptyCounts();
    let hasConflictMarkers = false;
    /**
     * 改行コード（設計書5.4.2）。**読めなければ null のまま。**
     * ここで一緒に見ておけば、作品ぜんたいの改行を調べるために
     * 全話をもう一度読み直さずに済む
     */
    let eol: Eol | null = null;
    let hasMixedEol = false;
    let collected: CollectedEpisode[] | null = null;
    /** 残っているシーンメモの印（設計書6.40.5）。無ければ空文字 */
    let memoBadge = "";
    let meta = {
      hasMetadata: false,
      title: null as string | null,
      declaredCharCount: null as number | null,
      updatedAt: null as string | null,
    };
    try {
      const readStartedAt = performance.now();
      const bytes = await reader.readFile(filePath);
      const text = decodeText(bytes);
      readMs += performance.now() - readStartedAt;

      // **作品情報（`about.txt`）はここで抜ける。** 中身を見ないと
      // 見分けられないので、読んだ直後のこの位置にしか置けない
      if (isWorkInfoFile(fileName, text)) {
        workInfoFiles.push(filePath);
        noteFile(fileName, fileStartedAt);
        continue;
      }

      const parseStartedAt = performance.now();
      // **改行の判定は正規化前の本文で行う**（`decodeText` は改行を
      // そのまま残す）。LFへ揃えたあとでは、もう見分けられない
      ({ eol, hasMixedEol } = detectEol(text));

      // 投稿サイトのDLファイルはメタデータヘッダーを持つことがある。
      // ヘッダーを含めると投稿サイト上の文字数と一致しなくなるため、
      // 本文部分だけを計測対象にする。
      const parsedMeta = parseEpisodeMetadata(text);
      meta = {
        hasMetadata: parsedMeta.hasMetadata,
        title: parsedMeta.title,
        declaredCharCount: parsedMeta.declaredCharCount,
        updatedAt: parsedMeta.updatedAt,
      };

      // 全話が1ファイルに入っている形（合本）は、話ごとに分けて扱う。
      // まとめて数えると、後書き・リアクション（作者の物語ではない文章）まで
      // 進捗に足してしまう。実データの73万字の作品で1万字あった
      collected = parseCollectedFile(text);

      hasConflictMarkers = containsConflictMarkers(text);
      parseMs += performance.now() - parseStartedAt;

      if (!hasConflictMarkers) {
        const countStartedAt = performance.now();
        // **数え方は `core/episodeCharCount.ts` の1か所に集めてある。**
        // 原稿エディタの「このファイル ◯字」も同じ関数を通る（写しを作らない）。
        // 既に読み解いたもの（合本の割り・頭書きの除去）を渡すのは、
        // 走査が全ファイルを毎回読むので二度手間を避けるためである
        const parsed = { collected, metaBody: parsedMeta.body };
        const body = episodeBodyForCount(text, parsed);
        // ルビ記法はMarkdownのみ対象。
        // **文字数にメモは入らない**（数える側が落とす。設計書6.40.2）
        counts = countEpisodeChars(text, { ext, excludeRuby }, parsed);
        // **ここで数えるのは、既に読んだ本文をもう一度読まないため**である。
        // 一覧の印のためだけに、全話をもう一巡することになる
        memoBadge = memoBadgeText(parseMemos(body));
        // **シーンメモの印も「数え」に入れる**（設計書6.107）。同じ本文を
        // 一度で済ませるために、ここへ並べて置いてあるものである
        countMs += performance.now() - countStartedAt;
      }
      // 競合マーカーを含む場合は数えない。両方の版とマーカーが混ざったまま
      // 数えると、実際より多い字数を本当の進捗として見せてしまう
    } catch {
      // 読めないファイルは0字として扱い、走査は止めない
    }

    // 合本はファイル名から話数を取れない。中の各話のタイトルから読み取る
    const collectedChapters = (collected ?? [])
      .map((episode) => episode.chapter)
      .filter((chapter): chapter is number => chapter !== null);

    episodes.push({
      filePath,
      fileName,
      ext,
      chapterStart:
        collectedChapters.length > 0
          ? Math.min(...collectedChapters)
          : parsed.chapterStart,
      chapterEnd:
        collectedChapters.length > 0
          ? Math.max(...collectedChapters)
          : parsed.chapterEnd,
      // ファイル名にサブタイトルが無ければメタデータのタイトルを使う
      subtitle: parsed.subtitle ?? meta.title,
      kind: parsed.kind,
      isInitialName: parsed.isInitialName,
      date: parsed.date,
      dateSeq: parsed.dateSeq,
      counts,
      hasMetadata: meta.hasMetadata,
      metaTitle: meta.title,
      declaredCharCount: meta.declaredCharCount,
      metaUpdatedAt: meta.updatedAt,
      hasConflictMarkers,
      collectedCount: collected ? collected.length : null,
      memoBadge,
      eol,
      hasMixedEol,
    });
    noteFile(fileName, fileStartedAt);
  }

  episodes.sort(compareEpisodes);

  let totals = emptyCounts();
  let conflictedCount = 0;
  for (const e of episodes) {
    if (e.hasConflictMarkers) {
      conflictedCount++;
      continue;
    }
    totals = addCounts(totals, e.counts);
  }

  const totalMs = performance.now() - scanStartedAt;
  return {
    episodes,
    stats: { fileCount: episodes.length, totals, conflictedCount },
    manuscriptDir: targetDir,
    workInfoFiles,
    timing: {
      files: files.length,
      readMs,
      countMs,
      parseMs,
      // **残りは引き算で出す。** 足し忘れた区間があっても、合計と
      // 内訳の食い違いとしてではなく「その他が大きい」として現れる
      otherMs: Math.max(0, totalMs - readMs - countMs - parseMs),
      totalMs,
      slowestFile,
      slowestMs,
    },
  };
}

/**
 * 作品ごとの計測を1つにまとめる（設計書6.107）。
 *
 * **合計は実際の経過時間を超える。** 走査は同時に4つまで走るので、
 * 4本ぶんの時間が足し合わされる。**それでよい**——ここで読みたいのは
 * 「壁時計で何秒か」ではなく「どの作業がどれだけ CPU を食ったか」である。
 *
 * 0件なら、すべて0の計測を返す（呼び出し側で場合分けさせない）。
 */
export function summarizeScanTimings(
  timings: readonly ScanTiming[]
): ScanTiming {
  let files = 0;
  let readMs = 0;
  let countMs = 0;
  let parseMs = 0;
  let otherMs = 0;
  let totalMs = 0;
  let slowestMs = 0;
  let slowestFile: string | undefined;
  for (const t of timings) {
    files += t.files;
    readMs += t.readMs;
    countMs += t.countMs;
    parseMs += t.parseMs;
    otherMs += t.otherMs;
    totalMs += t.totalMs;
    if (t.slowestMs > slowestMs) {
      slowestMs = t.slowestMs;
      slowestFile = t.slowestFile;
    }
  }
  return {
    files,
    readMs,
    countMs,
    parseMs,
    otherMs,
    totalMs,
    slowestFile,
    slowestMs,
  };
}

/**
 * Gitの未解決な競合マーカーを含むか。
 *
 * `textFile.ts` にも同じ判定があるが、あちらは読み書きの安全確認用で
 * 文字コードの復元まで行う。走査は全ファイルを毎回読むため、
 * 復元を伴わない軽い判定をここに置く。
 */
function containsConflictMarkers(text: string): boolean {
  return /^(?:<{7}|={7}|>{7})(?: |$)/m.test(text);
}

/** 話数順に並べる。話数不明のものは末尾へ */
function compareEpisodes(a: EpisodeFile, b: EpisodeFile): number {
  const kindOrder: Record<string, number> = {
    プロローグ: 0,
    本編: 1,
    幕間: 1,
    エピローグ: 2,
    不明: 3,
  };
  const ka = kindOrder[a.kind] ?? 3;
  const kb = kindOrder[b.kind] ?? 3;
  if (ka !== kb) return ka - kb;

  // 日付で名付けられたファイルは、日付 → その日の中の並び で揃える。
  // **文字列の比較では足りない。** 「2026-08-16_10」は「_2」より
  // 前に来てしまう（辞書順では 1 < 2）
  if (a.date && b.date) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const sa = a.dateSeq ?? 0;
    const sb = b.dateSeq ?? 0;
    if (sa !== sb) return sa - sb;
    return a.fileName.localeCompare(b.fileName, "ja");
  }
  // 日付のものと話数のものが混じる作品では、日付を後ろへ置く。
  // 話数で書いていた作品に日付の下書きを足した場合、間へ割り込ませない
  if (a.date && !b.date) return 1;
  if (!a.date && b.date) return -1;

  const na = a.chapterStart;
  const nb = b.chapterStart;
  if (na === null && nb === null) {
    return a.fileName.localeCompare(b.fileName, "ja");
  }
  if (na === null) return 1;
  if (nb === null) return -1;
  if (na !== nb) return na - nb;
  return a.fileName.localeCompare(b.fileName, "ja");
}

/** 対象ディレクトリ配下のtxt/mdを再帰的に集める */
async function collectTextFiles(
  dir: string,
  reader: FileReader
): Promise<string[]> {
  const result: string[] = [];
  const skipDirs = new Set([".aiwriter", ".git", "node_modules", "exports", "設定"]);

  async function walk(current: string, depth: number): Promise<void> {
    // 想定外の深い階層で無限に走査しないよう上限を設ける
    if (depth > 5) return;
    let entries: Array<[string, "file" | "directory" | "other"]>;
    try {
      entries = await reader.readDirectory(current);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (name.startsWith(".")) continue;
      const full = path.join(current, name);
      if (type === "directory") {
        if (skipDirs.has(name)) continue;
        await walk(full, depth + 1);
      } else if (type === "file") {
        // 競合を「両方を残す」で解決したときの退避ファイルは原稿ではない。
        // 拾うと同じ話数の本文が2つある状態になる
        if (isConflictSideFile(name)) continue;
        const ext = path.extname(name).toLowerCase();
        if ((SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
          result.push(full);
        }
      }
    }
  }

  await walk(dir, 0);
  return result;
}

/**
 * テキストをデコードする。
 * なろう・カクヨムからのDLファイルはUTF-8が多いが、
 * Shift_JISの可能性もあるため簡易判定を行う。
 */
function decodeText(bytes: Uint8Array): string {
  // BOM付きUTF-8
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.slice(3));
  }
  try {
    // fatal:true にすると不正なUTF-8で例外が飛ぶ
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // UTF-8として不正ならShift_JISとみなす
    try {
      return new TextDecoder("shift_jis").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}
