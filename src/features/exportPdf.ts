import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { readTextFile, type TextFileContent } from "../core/textFile";
import { bookChaptersOf } from "../core/bookChapters";
import { atomicWriteFile } from "../core/atomicWrite";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import { bookHeading, episodeUnit } from "../core/episodeLabel";
import { timestampedFileNameCandidates } from "../core/timestampedFileName";
import {
  buildPrintHtml,
  PRINT_PRESETS,
  type PrintEpisode,
  type PrintPreset,
} from "../core/printHtml";
import { notationModeFor } from "../core/manuscriptRender";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { revealFolder } from "../views/openDocument";
import { openInDefaultApp } from "../core/openExternalFile";
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
  /** 区切りだけで、紙に出る本文が1文字も無かった合本。**黙って減らさない** */
  const empty: string[] = [];
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
    // 投稿サイトからDLしたファイルは、先頭にヘッダーが付いている。
    // 合本（1ファイルに複数話）は話ごとに割って、1話＝1章で組む
    // （設計書6.65.15。切り分けは `core/bookChapters.ts` が1か所で持ち、
    // EPUBと同じものを通す——別々に切ると、同じ原稿から出た本と紙で
    // 話の切れ目が違うことになる）
    const parts = bookChaptersOf(episode, file.text, format);
    if (parts.length === 0) {
      empty.push(episode.fileName);
      continue;
    }

    for (const part of parts) {
      chapters.push({
        heading: part.heading,
        body: part.body,
        // **話ごとに記法を見る。** 1つの作品に `.md` と `.txt` が混ざる
        // ことがある（DLした話と、こちらで書き足した話）
        notation: notationModeFor(episode.fileName),
      });
    }
  }

  if (chapters.length === 0) {
    // **理由で言い分ける**（EPUBと同じ）。競合が1つも無いのに
    // 「競合解決で直して」と言われると、作者は在りもしないマーカーを探す
    void vscode.window.showWarningMessage(
      conflicted.length > 0
        ? "選んだ本文はすべて未解決の競合を含んでいるため、書き出しませんでした。" +
            "「競合解決」で直してからもう一度お試しください。"
        : "紙に出せる本文がありませんでした。" + emptyNote(empty)
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
  const opened = await openInDefaultApp(target);

  const droppedNote =
    (conflicted.length > 0
      ? `\n未解決の競合を含む${conflicted.length}件は外しました（${conflicted.join(
          "、"
        )}）。`
      : "") + emptyNote(empty);

  // **開けたかどうかで案内を変える。** 以前は戻り値を見ずに
  // 「ブラウザで開きました」と告げており、VS Codeがエラーダイアログを
  // 出しているのに成功したことになっていた（作者の報告、2026-08-30）
  if (!opened) {
    logFailure("印刷用HTMLをブラウザで開く", { 作品: work.title, 場所: target });
    const action = await vscode.window.showWarningMessage(
      "印刷用のファイルは作りましたが、ブラウザを開けませんでした。" +
        "フォルダーの中の .html をダブルクリックすると開きます。" +
        "開いたら印刷（Ctrl+P）で送信先を「PDFに保存」にしてください。" +
        droppedNote,
      "フォルダーを開く"
    );
    if (action === "フォルダーを開く") await revealFolder(target);
    return;
  }

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
      // 選ぶ画面の見出しは、紙に出る単話の見出しと同じ部品で作る
      // （合本は1行で1ファイルを指すので、割る前の見出しでよい）
      label: bookHeading(episode, format),
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
 * 本文が1文字も無かった合本を伝える言葉。無ければ空文字。
 *
 * **黙って減らさない。** 話が紙に入らなかった理由は、作者にしか直せない
 * （EPUBの同じ場面と揃えてある）。
 */
function emptyNote(empty: readonly string[]): string {
  if (empty.length === 0) return "";
  return `\n紙に出る本文が無かった${empty.length}件は外しました（${empty.join(
    "、"
  )}）。`;
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
