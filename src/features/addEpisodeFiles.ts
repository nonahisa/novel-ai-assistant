import * as vscode from "vscode";
import * as path from "../core/paths";
import { AtomicWriteFileError, atomicWriteFile } from "../core/atomicWrite";
import type { MissingEpisodeFile } from "../core/backupMissingEpisodes";
import {
  episodeNameStyleOf,
  nextEpisodeFileNameLike,
} from "../core/episodeRenumber";
import { findLatestEpisode } from "../core/latestEpisode";
import { logFailure, useLogFile } from "../core/logger";
import type { scanWork } from "../core/scanner";
import {
  encodeForNewFile,
  readTextFile,
  type TextFileContent,
} from "../core/textFile";
import type { WorkEntry } from "../models/types";

/**
 * 作品の外から届いた話を、**新しい話のファイルとして足す**（設計書6.99.7）。
 *
 * 相談パネルへ落とされたバックアップの「手元に無い話」（作者の裁定、2026-09-23）と、
 * 既存作品の続きと分かった Word 原稿（同じ日の裁定）が通る。**2つの道で名前の
 * 決め方と書き方を分けない**——片方だけ直すと、同じ作品に流儀の違う名前が混ざる。
 *
 * ## 既存の話には触らない（実装ルール1・2）
 *
 * 書き込みは `atomicWriteFile` の `mode: "create"` だけ（3経路の②。既にあれば
 * 失敗する）。名前がぶつかったら別名にはせず、**その話は足さずに理由を言う**
 * ——バックアップの話は名前で次のバックアップと照らすので、別名にすると
 * 照らせなくなる。
 */

/** 走査の結果（使うのは話の一覧と本文フォルダーだけ） */
export type WorkScan = Awaited<ReturnType<typeof scanWork>>;

/** 足す1話ぶん（名前が決まったもの） */
export interface NamedEpisodeFile {
  readonly file: MissingEpisodeFile;
  /** 本文フォルダーからの名前（`/` 区切り） */
  readonly name: string;
}

/** 足せなかった1話ぶん。**黙って落とさない**ので、理由と一緒に持ち回る */
export interface EpisodeNotAdded {
  readonly label: string;
  readonly reason: string;
}

/**
 * 足す話の名前を決める。
 *
 * **手元の話の名前の流儀に合わせる**——「新しい話を作る」
 * （`novelai.addEpisode`）と同じ `nextEpisodeFileNameLike`（いちばん新しい
 * 話の名前の番号だけを差し替える）。流儀が読めない作品（合本1つだけ等）では
 * `defaultFileName` を使う。`renamable` でない話（カクヨムの話ごとのファイル）は
 * 名前を変えない（次のバックアップと名前で照らす）。
 *
 * **既にある名前には置かない。** ぶつかったらその話は足さず、理由を言う。
 *
 * @param existing 本文フォルダーに既にある名前（手元の一覧）
 * @param options.extension 名前の拡張子をこれにする（Word 原稿は Markdown に
 *   変換するので `.md`。手元が `.txt` の作品でも中身は Markdown である）
 */
export function nameNewEpisodes(
  files: readonly MissingEpisodeFile[],
  scan: WorkScan,
  existing: readonly string[],
  options: { extension?: string } = {}
): { named: NamedEpisodeFile[]; skipped: EpisodeNotAdded[] } {
  const latest = findLatestEpisode(scan.episodes);
  const style = latest ? episodeNameStyleOf(latest.fileName) : null;
  const used = new Set(existing.map((name) => name.toLowerCase()));
  const named: NamedEpisodeFile[] = [];
  const skipped: EpisodeNotAdded[] = [];
  for (const file of files) {
    let name =
      file.renamable && latest && style
        ? nextEpisodeFileNameLike({
            latestFileName: latest.fileName,
            number: file.number,
            fallback: { digits: 4, extension: style.ext },
          })
        : file.defaultFileName;
    if (options.extension && file.renamable) {
      name = `${name.slice(0, name.length - path.extname(name).length)}${options.extension}`;
    }
    if (used.has(name.toLowerCase())) {
      skipped.push({
        label: file.label,
        reason: `同じ名前のファイル（${name}）が既にあります（上書きしません）`,
      });
      continue;
    }
    used.add(name.toLowerCase());
    named.push({ file, name });
  }
  return { named, skipped };
}

/**
 * 話を新しいファイルとして書く。**`mode: "create"` だけ。**
 *
 * 文字列の話は**手元の原稿と同じ文字コード・改行**で書く（`encodeForNewFile`。
 * いちばん新しい話を手本にする）。手本が読めなければ UTF-8・LF。バイト列の話
 * （カクヨムの話ごとのファイル）はそのまま（6.99 の新規取り込みと同じ）。
 *
 * @returns 足せた話と、足せなかった話（理由つき）
 */
export async function writeNewEpisodes(
  work: WorkEntry,
  scan: WorkScan,
  files: readonly NamedEpisodeFile[]
): Promise<{
  added: { file: MissingEpisodeFile; path: string }[];
  skipped: EpisodeNotAdded[];
}> {
  const added: { file: MissingEpisodeFile; path: string }[] = [];
  const skipped: EpisodeNotAdded[] = [];
  if (files.length === 0) return { added, skipped };

  const latest = findLatestEpisode(scan.episodes);
  let reference: TextFileContent | undefined;
  if (latest) {
    try {
      reference = await readTextFile(latest.filePath);
    } catch {
      // 手本が読めなければ UTF-8・LF で書く（新しいファイルなので壊すものは無い）
    }
  }

  for (const { file, name } of files) {
    const target = path.join(scan.manuscriptDir, name);
    const bytes =
      file.content.kind === "bytes"
        ? file.content.bytes
        : reference
          ? encodeForNewFile(file.content.text, reference)
          : new TextEncoder().encode(file.content.text);
    if (!bytes) {
      skipped.push({
        label: file.label,
        reason: `手元の原稿の文字コード（${reference?.encoding ?? ""}）で書けない文字があります`,
      });
      continue;
    }
    try {
      await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
      await atomicWriteFile(target, bytes, { mode: "create" });
      added.push({ file, path: target });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      skipped.push({
        label: file.label,
        // **「既にある」と言ってよいのは、1文字も書かずに止まったときだけ**
        // （`docxImport.ts` と同じ線引き）。置いたあとで確かめられなかった
        // ときは、そのとおりに言う——作者がファイルを開いて確かめられるように
        reason: !(error instanceof AtomicWriteFileError)
          ? `書けませんでした（${name}）：${detail}`
          : error.kind === "path_conflict" && error.persistenceState === "not_saved"
            ? `同じ名前のファイル（${name}）が既にあります（上書きしません）`
            : `書けたか確かめられませんでした（${name}。開いて中身をお確かめください）：${detail}`,
      });
      // **記録の直前に書き先を向ける**（呼ぶ側が向けていても、ほかの機能が
      // 途中で別の作品へ向け直していることがある）
      useLogFile(work.folderPath);
      logFailure("話を新しいファイルとして足せなかった", {
        作品: work.title,
        ファイル: target,
        詳細: detail,
      });
    }
  }
  return { added, skipped };
}
