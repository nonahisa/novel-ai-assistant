import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { readTextFile, type TextFileContent } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { atomicWriteFile } from "../core/atomicWrite";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import {
  episodeTitle,
  episodeUnit,
  formatChapterLabel,
} from "../core/episodeLabel";
import { timestampedFileNameCandidates } from "../core/timestampedFileName";
import {
  buildPrintHtml,
  PRINT_PRESETS,
  type PrintEpisode,
  type PrintPreset,
} from "../core/printHtml";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { revealFolder } from "../views/openDocument";
import { logFailure } from "../core/logger";

/**
 * 本文を印刷用に組んで、ブラウザで開く（PDF出力）。
 *
 * **PDFを直接は作らない。** 理由は `core/printHtml.ts` の頭に書いた
 * ——日本語の縦書き・ルビ・傍点・禁則をきちんと組めるPDF生成の道具が
 * 実質無く、ブラウザの組版エンジンに任せるほうが仕上がりが良い。
 * ここは「組んだHTMLを作品の中へ置いて、ブラウザへ渡す」までを持つ。
 *
 * **原稿は読むだけで、1文字も書き換えない。**
 *
 * ## 書き出し先は `.aiwriter/exports/`
 *
 * 登録時の `.gitignore` 整備で除外済み（`core/workRegistry.ts` の
 * `IGNORED_PATHS`）。組み直せるものをGitへ載せると、話を1つ直すたびに
 * 履歴が膨らむ。
 *
 * **既存ファイルへは書かない**（`atomicWrite.ts` の設計では、そもそも
 * 置換は必ず失敗する）。名前がぶつかったら秒・連番で別名にする。
 */
export async function exportPdf(work: WorkEntry): Promise<void> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    void vscode.window.showInformationMessage(
      `「${work.title}」に本文のファイルが見つかりません。`
    );
    return;
  }

  const format = await readWorkFormat(work);
  const unit = episodeUnit(format);

  const selected = await pickEpisodes(scan.episodes, unit.noun, format);
  if (!selected || selected.length === 0) return;

  const preset = await pickPreset();
  if (!preset) return;

  const chapters: PrintEpisode[] = [];
  /** 競合マーカーが残っている話。組んでも読めない紙になるので外す */
  const conflicted: string[] = [];
  for (const episode of selected) {
    let file: TextFileContent;
    try {
      file = await readTextFile(episode.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("印刷用HTMLの組み立て", {
        ファイル: episode.fileName,
        内容: message,
      });
      await vscode.window.showErrorMessage(
        `${episode.fileName} を読めませんでした。${message}`
      );
      return;
    }
    // **未解決の競合をそのまま組まない。** マーカーと両方の版が混ざった紙は
    // 読めないうえ、刷ってから気づくことになる
    if (file.hasConflictMarkers) {
      conflicted.push(episode.fileName);
      continue;
    }
    chapters.push({
      heading: headingFor(episode, format),
      // 投稿サイトからDLしたファイルは、先頭にヘッダーが付いている。
      // 本文だけを組む（作品一覧の文字数計測と同じ切り分け）
      body: parseEpisodeMetadata(file.text).body,
    });
  }

  if (chapters.length === 0) {
    void vscode.window.showWarningMessage(
      "選んだ本文はすべて未解決の競合を含んでいるため、書き出しませんでした。" +
        "「競合解決」で直してからもう一度お試しください。"
    );
    return;
  }

  const html = buildPrintHtml({
    workTitle: work.title,
    episodes: chapters,
    preset,
  });

  let target: string;
  try {
    target = await writeExport(work, html);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("印刷用HTMLの書き出し", { 作品: work.title, 内容: message });
    await vscode.window.showErrorMessage(
      `印刷用のファイルを保存できませんでした。${message}`
    );
    return;
  }

  // `.html` は既定のブラウザに関連づいている。VS Code の中で開くと
  // 印刷（Ctrl+P）が使えないので、外のブラウザへ渡す
  await vscode.env.openExternal(path.toUri(target));

  const droppedNote =
    conflicted.length > 0
      ? `\n未解決の競合を含む${conflicted.length}件は外しました（${conflicted.join(
          "、"
        )}）。`
      : "";

  const action = await vscode.window.showInformationMessage(
    "ブラウザで開きました。印刷（Ctrl+P）で送信先を「PDFに保存」にするとPDFになります。" +
      "用紙サイズと余白は「既定」のままにしてください。" +
      droppedNote,
    "フォルダーを開く"
  );
  if (action === "フォルダーを開く") await revealFolder(target);
}

/**
 * どの話を組むかを決める。
 *
 * **全部と、選ぶ、の2択にする。** 話が19本ある作品で毎回すべてに
 * チェックを入れさせるのは、いちばんよく使う道を遠回りにすることになる。
 */
async function pickEpisodes(
  episodes: readonly EpisodeFile[],
  noun: string,
  format: WorkFormatKey | undefined
): Promise<EpisodeFile[] | undefined> {
  const scope = await vscode.window.showQuickPick(
    [
      {
        label: `すべての${noun}（全${episodes.length}${noun}）`,
        detail: "登録されている本文をすべて、話数の順に並べます",
        all: true,
      },
      {
        label: `${noun}を選ぶ`,
        detail: "一部だけを本にするときに使います",
        all: false,
      },
      cancelItem(),
    ],
    {
      title: "PDFにする範囲を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!scope || isCancelItem(scope) || !("all" in scope)) return undefined;
  if (scope.all) return [...episodes];

  // **複数選択に「取りやめる」を足さない。** VS Code が自分で
  // 「OK」「キャンセル」を出すので、項目として並べるとかえって紛らわしい
  const picked = await vscode.window.showQuickPick(
    episodes.map((episode) => ({
      label: headingFor(episode, format),
      description: episode.fileName,
      episode,
    })),
    {
      title: `PDFにする${noun}を選んでください`,
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  return picked?.map((item) => item.episode);
}

async function pickPreset(): Promise<PrintPreset | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...PRINT_PRESETS.map((preset) => ({
        label: preset.label,
        detail: preset.detail,
        id: preset.id,
      })),
      cancelItem(),
    ],
    {
      title: "紙の大きさと組み方を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("id" in picked)) return undefined;
  return picked.id;
}

/**
 * 紙に出す見出し。
 *
 * 作品一覧と同じ作り方にする（`episodeLabel.ts`）。話数と題が二重に
 * 並ばないよう、`episodeTitle` を通すのを忘れないこと。
 */
function headingFor(
  episode: EpisodeFile,
  format: WorkFormatKey | undefined
): string {
  const chapter = formatChapterLabel(episode, format);
  const title = episodeTitle(episode, chapter);
  return [chapter, title].filter(Boolean).join("　") || episode.fileName;
}

/** 書き出し先。**新規作成だけ**を使い、名前がぶつかったら別名にする */
async function writeExport(work: WorkEntry, html: string): Promise<string> {
  const config = await readWorkConfig(work);
  const directory = path.join(workPaths(work, config).aiwriter, EXPORT_DIR);
  await vscode.workspace.fs.createDirectory(path.toUri(directory));

  const target = await freshExportPath(directory, new Date());
  await atomicWriteFile(target, new TextEncoder().encode(html), {
    mode: "create",
  });
  return target;
}

/** 組み直せるものの置き場所。`.gitignore` で除外済み */
const EXPORT_DIR = "exports";

/**
 * まだ使われていない保存先を決める。
 *
 * 名前の作り方は `timestampedFileName.ts`（相談メモと同じ規則）。
 */
async function freshExportPath(
  directory: string,
  at: Date
): Promise<string> {
  for (const name of timestampedFileNameCandidates("印刷用", at, ".html")) {
    const target = path.join(directory, name);
    try {
      await vscode.workspace.fs.stat(path.toUri(target));
    } catch {
      // 読めない＝まだ無い。ここへ書く
      return target;
    }
  }
  throw new Error("書き出し先の名前を決められませんでした。");
}
