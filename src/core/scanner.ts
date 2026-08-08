import * as vscode from "vscode";
import * as path from "path";
import {
  EpisodeFile,
  SUPPORTED_EXTENSIONS,
  WorkEntry,
  WorkStats,
} from "../models/types";
import { addCounts, countChars, emptyCounts } from "./charCount";
import { parseEpisodeFileName } from "./episodeParser";
import { readWorkConfig, workPaths } from "./workRegistry";
import { parseEpisodeMetadata } from "./metadataParser";
import { pathExists } from "./fileSystem";

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
}> {
  const config = await readWorkConfig(work);
  const p = workPaths(work, config);

  const targetDir = (await pathExists(p.manuscript)) ? p.manuscript : p.root;
  const files = await collectTextFiles(targetDir);

  const episodes: EpisodeFile[] = [];
  const excludeRuby = vscode.workspace
    .getConfiguration("novelai")
    .get<boolean>("excludeRubyFromCount", true);

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const parsed = parseEpisodeFileName(fileName);

    let counts = emptyCounts();
    let hasConflictMarkers = false;
    let meta = {
      hasMetadata: false,
      title: null as string | null,
      declaredCharCount: null as number | null,
      updatedAt: null as string | null,
    };
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(filePath)
      );
      const text = decodeText(bytes);

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

      hasConflictMarkers = containsConflictMarkers(text);
      if (!hasConflictMarkers) {
        // ルビ記法はMarkdownのみ対象
        counts = countChars(parsedMeta.body, ext === ".md" ? excludeRuby : false);
      }
      // 競合マーカーを含む場合は数えない。両方の版とマーカーが混ざったまま
      // 数えると、実際より多い字数を本当の進捗として見せてしまう
    } catch {
      // 読めないファイルは0字として扱い、走査は止めない
    }

    episodes.push({
      filePath,
      fileName,
      ext,
      chapterStart: parsed.chapterStart,
      chapterEnd: parsed.chapterEnd,
      // ファイル名にサブタイトルが無ければメタデータのタイトルを使う
      subtitle: parsed.subtitle ?? meta.title,
      kind: parsed.kind,
      isInitialName: parsed.isInitialName,
      counts,
      hasMetadata: meta.hasMetadata,
      metaTitle: meta.title,
      declaredCharCount: meta.declaredCharCount,
      metaUpdatedAt: meta.updatedAt,
      hasConflictMarkers,
    });
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

  return {
    episodes,
    stats: { fileCount: episodes.length, totals, conflictedCount },
    manuscriptDir: targetDir,
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
async function collectTextFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  const skipDirs = new Set([".aiwriter", ".git", "node_modules", "exports", "設定"]);

  async function walk(current: string, depth: number): Promise<void> {
    // 想定外の深い階層で無限に走査しないよう上限を設ける
    if (depth > 5) return;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(current)
      );
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (name.startsWith(".")) continue;
      const full = path.join(current, name);
      if (type === vscode.FileType.Directory) {
        if (skipDirs.has(name)) continue;
        await walk(full, depth + 1);
      } else if (type === vscode.FileType.File) {
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
