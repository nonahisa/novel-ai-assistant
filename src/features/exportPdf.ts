import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry, WorkPdfExportConfig } from "../models/types";
import { scanWork } from "../core/scanner";
import { readTextFile, type TextFileContent } from "../core/textFile";
import { bookChaptersOf } from "../core/bookChapters";
import { atomicWriteFile } from "../core/atomicWrite";
import { readWorkConfig, workPaths, writeWorkConfig } from "../core/workRegistry";
import {
  defaultHeaderFooterFor,
  describePdfExportPlan,
  GRID_MAX,
  GRID_MIN,
  normalizeRelativePath,
  resolvePdfExportRequest,
  type PdfExportPlanLines,
} from "../core/pdfExportConfig";
import { readWorkKind } from "../core/workKindStore";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import { bookHeading, episodeUnit } from "../core/episodeLabel";
import { timestampedFileNameCandidates } from "../core/timestampedFileName";
import {
  buildPrintHtml,
  describeHeaderFooter,
  headerFooterUses,
  mapHeaderFooter,
  MARGIN_COLUMNS,
  MARGIN_CONTENTS,
  MARGIN_PARITIES,
  MARGIN_ROWS,
  marginContentLabel,
  PRINT_PRESETS,
  type HeaderFooter,
  type MarginContent,
  type MarginRow,
  type PageMargins,
  type PrintEpisode,
  type PrintPreset,
} from "../core/printHtml";
import { notationModeFor } from "../core/manuscriptRender";
import { BookStore } from "../core/bookStore";
import {
  buildGridPrintHtml,
  GRID_MARGIN_MM,
  GRID_MARGINS,
  gridFontSizePt,
  gridMarginClear,
  type GridPaper,
} from "../core/printGridHtml";
import { layoutGrid, type GridOptions } from "../core/manuscriptGrid";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { revealFolder } from "../views/openDocument";
import { openInDefaultApp } from "../core/openExternalFile";
import { logFailure, useLogFile } from "../core/logger";

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
  // 組み方は種類で決まる（設計書6.109）。形式（長さ）とは別の軸
  const kind = await readWorkKind(work);

  const scope = await pickEpisodes(scan.episodes, unit.noun, format);
  if (!scope || scope.episodes.length === 0) return;
  const selected = scope.episodes;

  const paper = await pickPaper();
  if (!paper) return;

  // 上下の余白に刷るもの（設計書6.33.5 の2）。奇数・偶数ページごとに、ヘッダー・
  // フッターの左・中央・右へ置く（作者の裁定、2026-10-17）。置き方は紙・向き・範囲と
  // いっしょに作品の設定へ覚える（外部AIの依頼が使う）。**作者名そのものは覚えない**
  // （名前は「どこにも保存しません」と言って訊いている）
  const headerFooter = await pickHeaderFooter(
    defaultHeaderFooterFor(paperConfigOf(paper)),
    await lastHeaderFooter(work, paper)
  );
  if (!headerFooter) return;
  let author: string | undefined;
  if (headerFooterUses(headerFooter, "author")) {
    author = await askAuthorName(work);
    if (author === undefined) return;
  }

  const composed = await composePdfExport(work, {
    episodes: selected,
    format,
    kind,
    paper,
    headerFooter,
    author,
  });
  if (!composed.ok) {
    // 読めない・書けないは誤り、組める本文が無いのは注意（以前と同じ出し分け）
    if (composed.kind === "nothing") {
      void vscode.window.showWarningMessage(composed.message);
    } else {
      await vscode.window.showErrorMessage(composed.message);
    }
    return;
  }
  const { target, conflicted, empty, gridNote } = composed;

  // **作れた選択だけを覚える**（作者の裁定 2026-10-16 夜の3）。外部AIからの PDF の
  // 書き出しが、この紙・向き・範囲を使う。覚えられなくても書き出しは済んでいる
  await rememberPdfExport(work, paper, scope.all ? undefined : selected, headerFooter);

  // `.html` は既定のブラウザに関連づいている。VS Code の中で開くと
  // 印刷（Ctrl+P）が使えないので、外のブラウザへ渡す
  const opened = await openInDefaultApp(target);

  const droppedNote =
    gridNote +
    (conflicted.length > 0
      ? `\n未解決の競合を含む${conflicted.length}件は外しました（${conflicted.join(
          "、"
        )}）。`
      : "") + emptyNote(empty);

  // **開けたかどうかで案内を変える。** 以前は戻り値を見ずに
  // 「ブラウザで開きました」と告げており、VS Codeがエラーダイアログを
  // 出しているのに成功したことになっていた（作者の報告、2026-08-30）
  if (!opened) {
    useLogFile(work.folderPath);
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
    "ブラウザで開きました。画面に並んだ白い面が、そのまま紙1枚ずつになります。" +
      "印刷（Ctrl+P）で送信先を「PDFに保存」にするとPDFになります。" +
      "用紙サイズと余白は「既定」のままにし、「ヘッダーとフッター」のチェックは外してください。" +
      droppedNote,
    "フォルダーを開く"
  );
  if (action === "フォルダーを開く") await revealFolder(target);
}

/** 組む材料（画面で選んだもの。外からの依頼では既定で埋める） */
interface PdfExportInput {
  episodes: readonly EpisodeFile[];
  format: WorkFormatKey | undefined;
  kind: Awaited<ReturnType<typeof readWorkKind>>;
  paper: PaperChoice;
  headerFooter: HeaderFooter;
  author: string | undefined;
}

type PdfExportOutcome =
  | {
      ok: true;
      /** 作ったファイル（絶対パス） */
      target: string;
      bytes: number;
      /** 紙に入った話の数（合本は話ごと） */
      chapters: number;
      conflicted: string[];
      empty: string[];
      /** 公募の納品用のときの枚数の一言（先頭に改行）。ほかは空 */
      gridNote: string;
    }
  | { ok: false; kind: "unreadable" | "nothing" | "write"; message: string };

/**
 * 読む → 組む → 書く（2026-10-16 に［PDF出力］の本体から切り出した）。**画面には何も
 * 出さない**——訊く段・ブラウザを開く・知らせは呼ぶ側が持つ。外部AIの依頼
 * （`run.request` の `exportPdf`）も、ここを通して同じ紙を作る。
 *
 * 失敗の文言は以前のまま（呼ぶ側がそのまま作者に出す）。記録（ログ）はここで残す。
 */
async function composePdfExport(
  work: WorkEntry,
  input: PdfExportInput
): Promise<PdfExportOutcome> {
  const { format, kind, paper, headerFooter, author } = input;
  const chapters: PrintEpisode[] = [];
  /** 競合マーカーが残っている話。組んでも読めない紙になるので外す */
  const conflicted: string[] = [];
  /** 区切りだけで、紙に出る本文が1文字も無かった合本。**黙って減らさない** */
  const empty: string[] = [];
  for (const episode of input.episodes) {
    let file: TextFileContent;
    try {
      file = await readTextFile(episode.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // **記録の直前に書き先を向ける**（0.43.3 と同じ）
      useLogFile(work.folderPath);
      logFailure("印刷用HTMLの組み立て", {
        ファイル: episode.fileName,
        内容: message,
      });
      return {
        ok: false,
        kind: "unreadable",
        message: `${episode.fileName} を読めませんでした。${message}`,
      };
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
    return {
      ok: false,
      kind: "nothing",
      message:
        conflicted.length > 0
          ? "選んだ本文はすべて未解決の競合を含んでいるため、書き出しませんでした。" +
            "「競合解決」で直してからもう一度お試しください。"
          : "紙に出せる本文がありませんでした。" + emptyNote(empty),
    };
  }

  // 公募の納品用（設計書6.33.5 の3）は1字1マスで組む。**台本と漫画の原作だけ、
  // ト書きを3字下げ、台詞を人物名の欄に入れる**（作者の裁定、2026-10-09・10-17）。
  // 字下げは空のマスで取るので、1行の字数は指定どおりのまま。ほかの種類は本文を
  // そのまま升目に置く
  const html =
    paper.kind === "grid"
      ? buildGridPrintHtml({
          workTitle: work.title,
          episodes: chapters,
          paper: paper.paper,
          grid: paper.grid,
          headerFooter,
          author,
          marginMm: paper.marginMm,
          kind,
        })
      : buildPrintHtml({
          workTitle: work.title,
          episodes: chapters,
          preset: paper.preset,
          // **種類で組み方が変わる**（設計書6.70・6.109。台本は柱・ト書き・台詞）。
          // 上で読んだものをそのまま渡す——ここで読み直すと、選んでいる間に
          // 設定が書き換わったときに、見出しと組み方で別の種類を指す
          kind,
          headerFooter,
          author,
        });
  // 公募の規定は枚数で決まることが多い。刷る前に枚数が分かるよう知らせる
  const gridNote =
    paper.kind === "grid"
      ? `\n${paper.grid.columns}字×${paper.grid.rows}行で本文${
          // 紙と同じ種類を渡す（台本の字下げで行が増える。枚数の知らせと紙がずれない）
          layoutGrid(chapters, paper.grid, kind).length
        }枚（扉を除く）です。`
      : "";

  const bytes = new TextEncoder().encode(html);
  let target: string;
  try {
    target = await writeExport(work, bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useLogFile(work.folderPath);
    logFailure("印刷用HTMLの書き出し", { 作品: work.title, 内容: message });
    return {
      ok: false,
      kind: "write",
      message: `印刷用のファイルを保存できませんでした。${message}`,
    };
  }

  return {
    ok: true,
    target,
    bytes: bytes.byteLength,
    chapters: chapters.length,
    conflicted,
    empty,
    gridNote,
  };
}

/**
 * 外部AIから頼まれた［PDF出力］（`run.request` の `exportPdf`。2026-10-16 の棚卸しの10件目）。
 *
 * **訊く段を、作品の前回の［PDF出力］の設定で埋める**（作者の裁定 2026-10-16 夜の3）：
 * 紙・向き・範囲・上下の余白の置き方は `config.json` の `pdfExport`（作者が画面で
 * 書き出せたときに覚える）、記録が無ければ文庫サイズ・縦書き・全話・その紙の既定の余白。
 * 作者名を置いた枠は、名前を訊けないので「なし」にして断りを残す（勝手に名前を決めない）。
 *
 * **ブラウザもフォルダーも開かない**（作者の画面を勝手に動かさない）。返すのは
 * 作ったファイルの場所（作品フォルダーからの相対）と数字だけ。
 */
export async function exportPdfForRequest(
  work: WorkEntry
): Promise<
  | {
      ok: true;
      filePath: string;
      bytes: number;
      chapters: number;
      conflicted: string[];
      notices: string[];
    }
  | { ok: false; reason: string; nextAction?: string }
> {
  const plan = await planPdfExportForRequest(work);
  if (!plan.ok) return plan;
  const { paper, episodes, lines } = plan;

  // 前回の置き方（無ければ紙の既定）。**作者名の枠は空ける**——外からは名前を訊けず、
  // 勝手に決めることもしない
  const headerFooter = mapHeaderFooter(plan.headerFooter, (content) =>
    content === "author" ? "none" : content
  );
  const notices: string[] = [
    `紙は${lines.paper}・${lines.direction}、範囲は${lines.range}、` +
      `上下の余白は${describeHeaderFooter(headerFooter)}で組みました（${lines.source}）。`,
  ];
  if (headerFooterUses(plan.headerFooter, "author")) {
    notices.push("作者名を刷る余白は、外からは名前を訊けないため空けました。");
  }

  const composed = await composePdfExport(work, {
    episodes,
    format: await readWorkFormat(work),
    kind: await readWorkKind(work),
    paper,
    headerFooter,
    author: undefined,
  });
  if (!composed.ok) return { ok: false, reason: composed.message };
  if (composed.empty.length > 0) notices.push(emptyNote(composed.empty).trim());
  // 公募の納品用は枚数も（画面の知らせと同じ一言）
  if (composed.gridNote) notices.push(composed.gridNote.trim());
  return {
    ok: true,
    filePath: normalizeRelativePath(path.relative(work.folderPath, composed.target)),
    bytes: composed.bytes,
    chapters: composed.chapters,
    conflicted: composed.conflicted,
    notices,
  };
}

/**
 * 外部AIの依頼で組む紙・話（作者の裁定 2026-10-16 夜の3）。**確認の窓に並べるものと、
 * 実際に組むものを同じ関数で決める**（`runRequestRunners.ts` の inspect と
 * `exportPdfForRequest` の両方がここを通る）。
 *
 * 前回の設定が読めない（`config.json` が壊れている）ときは、記録が無いのと同じく
 * 既定で組む。書き出しは原稿にも設定にも触れないので、ここで止める理由が無い。
 * 壊れた設定ファイルは直さない（読むだけ）。
 */
export async function planPdfExportForRequest(
  work: WorkEntry
): Promise<
  | {
      ok: true;
      paper: PaperChoice;
      episodes: EpisodeFile[];
      lines: PdfExportPlanLines;
      /** 前回の置き方（無ければ紙の既定）。作者名の枠はまだ空けていない */
      headerFooter: HeaderFooter;
    }
  | { ok: false; reason: string; nextAction?: string }
> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    return {
      ok: false,
      reason: `「${work.title}」に本文のファイルが見つかりません。`,
      nextAction: "本文のファイルを作品フォルダーに入れてから頼んでください",
    };
  }
  let saved: WorkPdfExportConfig | undefined;
  try {
    saved = (await readWorkConfig(work))?.pdfExport;
  } catch {
    saved = undefined;
  }
  const byRelative = new Map(
    scan.episodes.map((episode) => [episodeRelativePath(work, episode), episode] as const)
  );
  const plan = resolvePdfExportRequest(saved, [...byRelative.keys()]);
  const episodes = plan.files
    .map((file) => byRelative.get(file))
    .filter((episode): episode is EpisodeFile => episode !== undefined);
  return {
    ok: true,
    paper: paperChoiceOf(plan.paper),
    episodes,
    lines: describePdfExportPlan(plan),
    headerFooter: plan.headerFooter,
  };
}

/** 作品フォルダーからの相対パス（区切りは `/`）。前回の範囲はこの形で覚える */
function episodeRelativePath(work: WorkEntry, episode: EpisodeFile): string {
  return normalizeRelativePath(path.relative(work.folderPath, episode.filePath));
}

function paperChoiceOf(paper: WorkPdfExportConfig["paper"]): PaperChoice {
  if (paper.kind === "preset") return { kind: "preset", preset: paper.preset };
  return {
    kind: "grid",
    paper: paper.paper,
    grid: {
      columns: paper.columns,
      rows: paper.rows,
      hanging: paper.hanging,
      vertical: paper.vertical,
    },
    marginMm: paper.marginMm,
  };
}

function paperConfigOf(paper: PaperChoice): WorkPdfExportConfig["paper"] {
  if (paper.kind === "preset") return { kind: "preset", preset: paper.preset };
  return {
    kind: "grid",
    paper: paper.paper,
    columns: paper.grid.columns,
    rows: paper.grid.rows,
    hanging: paper.grid.hanging,
    vertical: paper.grid.vertical,
    marginMm: paper.marginMm,
  };
}

/**
 * 作者が画面で選んだ紙・向き・範囲を、作品の設定（`config.json` の `pdfExport`）に覚える
 * （作者の裁定 2026-10-16 夜の3）。`selected` が undefined なら「すべての話」。
 *
 * - 書くのは `writeWorkConfig`（ほかの欄を落とさず、読んだままの改行の形で書き戻す）
 * - **同じ設定なら書かない**（書き出すたびに設定ファイルを触ると、同期の差分が濁る）
 * - 設定ファイルが無い・読めない（壊れている）ときは書かない。壊れたJSONは直さない（規則2）
 * - 覚えられなくても書き出しは済んでいるので、作者には知らせずログにだけ残す
 */
async function rememberPdfExport(
  work: WorkEntry,
  paper: PaperChoice,
  selected: readonly EpisodeFile[] | undefined,
  headerFooter: HeaderFooter
): Promise<void> {
  const next: WorkPdfExportConfig = {
    paper: paperConfigOf(paper),
    range: selected
      ? { scope: "files", files: selected.map((episode) => episodeRelativePath(work, episode)) }
      : { scope: "all" },
    // 置き場所だけ（作者名そのものは覚えない）。枠の並びをいつも同じにして書く
    // ——同じ設定なら書かない判定（JSON の文字列の比べ）がぶれないように
    headerFooter: mapHeaderFooter(headerFooter, (content) => content),
  };
  try {
    const config = await readWorkConfig(work);
    if (!config) return;
    if (JSON.stringify(config.pdfExport) === JSON.stringify(next)) return;
    await writeWorkConfig(work, { ...config, pdfExport: next });
  } catch (error) {
    useLogFile(work.folderPath);
    logFailure("PDF出力の設定を覚える", {
      作品: work.title,
      内容: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * どの話を組むかを決める。
 *
 * **全部と、選ぶ、の2択にする。** 話が19本ある作品で毎回すべてに
 * チェックを入れさせるのは、いちばんよく使う道を遠回りにすることになる。
 *
 * 「すべて」を選んだかも返す。覚えるときに「そのときの全話」と「選んだ話」を
 * 分けるため（すべてを選んだ作者は、あとから足した話も入ってほしい）。
 */
async function pickEpisodes(
  episodes: readonly EpisodeFile[],
  noun: string,
  format: WorkFormatKey | undefined
): Promise<{ episodes: EpisodeFile[]; all: boolean } | undefined> {
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
  if (scope.all) return { episodes: [...episodes], all: true };

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
  return picked ? { episodes: picked.map((item) => item.episode), all: false } : undefined;
}

/** 紙の選び方。ふつうの紙（流し込み）か、公募の納品用（1字1マス） */
type PaperChoice =
  | { kind: "preset"; preset: PrintPreset }
  | { kind: "grid"; paper: GridPaper; grid: GridOptions; marginMm: number };

async function pickPaper(): Promise<PaperChoice | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...PRINT_PRESETS.map((preset) => ({
        label: preset.label,
        detail: preset.detail,
        id: preset.id,
      })),
      // 公募の納品用（設計書6.33.5 の3）。字数・行数・向きは次の画面で決める
      {
        label: "公募の納品用（字数×行数を決める）",
        detail: "1ページの字数と行数を決めて、1字1マスで組みます。句読点・括弧の禁則処理つき",
        manuscript: true as const,
      },
      cancelItem(),
    ],
    {
      title: "紙の大きさと組み方を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  if ("id" in picked) return { kind: "preset", preset: picked.id };
  if (!("manuscript" in picked)) return undefined;
  return pickGrid();
}

/**
 * 公募の納品用の組み方を決める：字数×行数 → 向きと紙 → ぶら下げ。
 *
 * **よくある字数×行数を先に並べる。** 募集要項に「40字×40行」とあれば
 * 1回で選べる。要項ごとに違う（42字×34行など）ので、自分で決める道も置く。
 */
async function pickGrid(): Promise<PaperChoice | undefined> {
  const size = await vscode.window.showQuickPick(
    [
      { label: "40字×40行", detail: "A4に縦書きで組む公募でよく使われます", columns: 40, rows: 40 },
      { label: "40字×30行", detail: "行間を広めにとる公募で使われます", columns: 40, rows: 30 },
      {
        label: "20字×20行（原稿用紙）",
        detail: "400字詰め原稿用紙と同じ。原稿用紙の枚数で数える公募に",
        columns: 20,
        rows: 20,
      },
      {
        label: "字数と行数を自分で決める",
        detail: "募集要項の指定（42字×34行など）に合わせます",
        custom: true as const,
      },
      cancelItem(),
    ],
    { title: "1ページの字数と行数を選んでください（募集要項の指定に合わせます）", ignoreFocusOut: true }
  );
  if (!size || isCancelItem(size)) return undefined;
  let columns: number;
  let rows: number;
  if ("columns" in size && size.columns !== undefined && size.rows !== undefined) {
    columns = size.columns;
    rows = size.rows;
  } else {
    const typedColumns = await askGridNumber("1行の字数", "40");
    if (typedColumns === undefined) return undefined;
    const typedRows = await askGridNumber("1ページの行数", "40");
    if (typedRows === undefined) return undefined;
    columns = typedColumns;
    rows = typedRows;
  }

  const layout = await vscode.window.showQuickPick(
    [
      {
        label: "縦書き・A4横置き",
        detail: "用紙を横長に使い、右から左へ行が進みます。縦書きの公募で多い形です",
        paper: "a4-landscape" as const,
        vertical: true,
      },
      {
        label: "縦書き・A4縦置き",
        detail: "用紙を縦長に使います。行が多いと字が小さくなります",
        paper: "a4-portrait" as const,
        vertical: true,
      },
      {
        label: "横書き・A4縦置き",
        detail: "横書きの公募に。半角の英数字は2字で1マスに入れます",
        paper: "a4-portrait" as const,
        vertical: false,
      },
      cancelItem(),
    ],
    { title: "向きと用紙を選んでください", ignoreFocusOut: true }
  );
  if (!layout || isCancelItem(layout) || !("paper" in layout)) return undefined;

  const hang = await vscode.window.showQuickPick(
    [
      {
        label: "句読点をぶら下げる",
        detail: "行末からはみ出す「。」「、」を、行の外（余白）に書きます。原稿用紙の書き方です",
        hanging: true,
      },
      {
        label: "句読点をぶら下げない",
        detail: "「。」「、」が行の頭に来るときは、前の字ごと次の行へ送ります",
        hanging: false,
      },
      cancelItem(),
    ],
    { title: "行末の句読点の扱いを選んでください", ignoreFocusOut: true }
  );
  if (!hang || isCancelItem(hang) || !("hanging" in hang)) return undefined;

  const grid: GridOptions = { columns, rows, hanging: hang.hanging, vertical: layout.vertical };
  const marginMm = await pickGridMargin(layout.paper, grid);
  if (marginMm === undefined) return undefined;

  return { kind: "grid", paper: layout.paper, grid, marginMm };
}

/**
 * 余白を決める：普通（20mm）／狭く（10mm）。既定は普通（作者の裁定、2026-10-09）。
 *
 * **字の大きさを、選んだ紙と字数×行数で計算して出す。** A4縦置きの縦書き
 * 40×40 なら約8pt→約9pt。固定の文にすると、ほかの組み合わせで嘘になる。
 *
 * **狭くすると上下の帯の字（ページ番号など）とぶら下げ・ルビが重なる組み合わせ
 * では、尋ねずに普通で組む**（`gridMarginClear`）。重なる紙を選ばせない。
 */
async function pickGridMargin(
  paper: GridPaper,
  grid: GridOptions
): Promise<number | undefined> {
  const narrow = GRID_MARGINS.find((margin) => margin.id === "narrow");
  if (!narrow || !gridMarginClear(paper, grid, narrow.mm)) return GRID_MARGIN_MM;

  const points = (mm: number) => `約${gridFontSizePt(paper, grid, mm).toFixed(1)}pt`;
  const picked = await vscode.window.showQuickPick(
    [
      ...GRID_MARGINS.map((margin) => ({
        label: `${margin.label}（${margin.mm}mm）`,
        detail:
          margin.id === "normal"
            ? `字の大きさは${points(margin.mm)}。綴じしろや書き込みの余裕があります`
            : `字が${points(GRID_MARGIN_MM)}から${points(margin.mm)}に大きくなります。` +
              "家庭用のプリンターは紙の端の数mmに刷れないことがあります",
        mm: margin.mm,
      })),
      cancelItem(),
    ],
    { title: "紙の余白を選んでください", ignoreFocusOut: true }
  );
  if (!picked || isCancelItem(picked) || !("mm" in picked)) return undefined;
  return picked.mm;
}

// 自分で決める字数・行数の幅（GRID_MIN・GRID_MAX）は `core/pdfExportConfig.ts` にある
// （前回の設定を読むときも同じ幅で確かめるため）

async function askGridNumber(
  what: string,
  example: string
): Promise<number | undefined> {
  const typed = await askText({
    title: what,
    prompt: `${what}を数字で入れてください（${GRID_MIN}〜${GRID_MAX}）`,
    placeHolder: `例：${example}`,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) return "半角の数字で入れてください";
      const number = Number(trimmed);
      if (number < GRID_MIN || number > GRID_MAX) {
        return `${GRID_MIN}から${GRID_MAX}までの数にしてください`;
      }
      return undefined;
    },
  });
  if (typed === undefined) return undefined;
  return Number(typed.trim());
}

/**
 * 前回の［PDF出力］の余白の置き方。**同じ種類の紙（読む紙どうし・公募の納品用どうし）
 * のときだけ**返す——読む紙で選んだ「ヘッダーの右にページ番号」を、公募の納品用に
 * そのまま持ち込むと、公募の既定（下の中央）から黙って外れる。
 * 設定が読めないときは無いものとする（読むだけ。壊れた設定は直さない）。
 */
async function lastHeaderFooter(
  work: WorkEntry,
  paper: PaperChoice
): Promise<HeaderFooter | undefined> {
  try {
    const saved = (await readWorkConfig(work))?.pdfExport;
    if (!saved?.headerFooter) return undefined;
    return saved.paper.kind === paper.kind ? saved.headerFooter : undefined;
  } catch {
    return undefined;
  }
}

/** 置き場所の選択肢（ヘッダー・フッターの左・中央・右と、刷らない） */
type MarginPlace = { row: keyof PageMargins; column: keyof MarginRow } | "none";

/** 中身を、その面のどこに置いているか。置いていなければ "none" */
function placeOf(page: PageMargins, content: MarginContent): MarginPlace {
  for (const row of MARGIN_ROWS) {
    for (const column of MARGIN_COLUMNS) {
      if (page[row.id][column.id] === content) return { row: row.id, column: column.id };
    }
  }
  return "none";
}

function placeLabel(place: MarginPlace): string {
  if (place === "none") return "刷らない";
  const row = MARGIN_ROWS.find((item) => item.id === place.row)?.label ?? place.row;
  const column = MARGIN_COLUMNS.find((item) => item.id === place.column)?.label ?? place.column;
  return `${row}${column}`;
}

/**
 * 中身をその面の1か所へ置き直す（元の置き場所は空ける）。**置いた先に別の中身が
 * あれば、そちらは刷らなくなる**——1つの枠に2つは入らない（選ぶ画面にそう出す）。
 */
function placeContent(page: PageMargins, content: MarginContent, place: MarginPlace): void {
  for (const row of MARGIN_ROWS) {
    for (const column of MARGIN_COLUMNS) {
      if (page[row.id][column.id] === content) page[row.id][column.id] = "none";
    }
  }
  if (place !== "none") page[place.row][place.column] = content;
}

/**
 * 上下の余白（ヘッダー・フッター）に刷るものを決める。
 *
 * **いちばん上は「この紙の既定のまま」**（前回の置き方があれば、その上に「前回と同じ」）。
 * 毎回選ばせると、いちばんよく使う道が遠回りになる。中身は項目の横に書いて見せる。
 *
 * 自分で選ぶときは**刷るもの→置き場所の順**（作者の裁定、2026-10-17：刷るものを、
 * 奇数ページと偶数ページごとに、ヘッダー・フッターの左・中央・右のどこに置くか）。
 * 12の枠を1つずつ訊くより少なく済む。「これで決める」を押すまで繰り返せる。
 *
 * ブラウザの印刷画面にも「ヘッダーとフッター」（日付とファイルの場所）が
 * あり、名前が同じで紛らわしい。こちらは紙の余白に刷る中身で、あちらは
 * 外すもの——と項目の説明で言い分ける。
 */
async function pickHeaderFooter(
  defaults: HeaderFooter,
  last: HeaderFooter | undefined
): Promise<HeaderFooter | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...(last
        ? [
            {
              label: "前回と同じ置き方",
              description: describeHeaderFooter(last),
              margins: "last" as const,
            },
          ]
        : []),
      {
        label: "この紙の既定のまま",
        description: describeHeaderFooter(defaults),
        detail:
          "ブラウザの印刷画面の「ヘッダーとフッター」（日付とファイルの場所）とは別のものです。あちらは外してください",
        margins: "default" as const,
      },
      {
        label: "刷るものと置き場所を選ぶ",
        detail:
          "ページ番号・話の見出し・題名・作者名を、奇数ページと偶数ページごとに、ヘッダー・フッターの左・中央・右へ置きます",
        margins: "choose" as const,
      },
      cancelItem(),
    ],
    {
      title: "ページの上と下の余白に何を刷るか選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("margins" in picked)) return undefined;
  if (picked.margins === "last" && last) return mapHeaderFooter(last, (content) => content);
  if (picked.margins === "default") return mapHeaderFooter(defaults, (content) => content);
  return chooseHeaderFooter(mapHeaderFooter(last ?? defaults, (content) => content));
}

/** 刷るもの（「なし」を除く）を選び、その置き場所を奇数・偶数の順に選ぶ。繰り返せる */
async function chooseHeaderFooter(start: HeaderFooter): Promise<HeaderFooter | undefined> {
  const current = start;
  const contents = MARGIN_CONTENTS.filter((item) => item.id !== "none");
  for (;;) {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "これで決める",
          description: describeHeaderFooter(current),
          done: true as const,
        },
        ...contents.map((item) => ({
          label: item.label,
          description: MARGIN_PARITIES.map(
            (parity) => `${parity.label}：${placeLabel(placeOf(current[parity.id], item.id))}`
          ).join("／"),
          detail: item.detail,
          content: item.id,
        })),
        cancelItem(),
      ],
      { title: "置き場所を変えるものを選んでください", ignoreFocusOut: true }
    );
    if (!picked || isCancelItem(picked)) return undefined;
    if ("done" in picked) return current;
    if (!("content" in picked)) return undefined;
    for (const parity of MARGIN_PARITIES) {
      const place = await pickPlace(current[parity.id], picked.content, parity.label);
      if (place === undefined) return undefined;
      placeContent(current[parity.id], picked.content, place);
    }
  }
}

/** 1つの面での置き場所を選ぶ（ヘッダー・フッターの左・中央・右と、刷らない） */
async function pickPlace(
  page: PageMargins,
  content: MarginContent,
  parityLabel: string
): Promise<MarginPlace | undefined> {
  const now = placeOf(page, content);
  const places: MarginPlace[] = [
    ...MARGIN_ROWS.flatMap((row) =>
      MARGIN_COLUMNS.map((column) => ({ row: row.id, column: column.id }))
    ),
    "none",
  ];
  const picked = await vscode.window.showQuickPick(
    [
      ...places.map((place) => {
        const occupant = place === "none" ? "none" : page[place.row][place.column];
        const isNow = placeLabel(place) === placeLabel(now);
        return {
          label: placeLabel(place),
          description: isNow
            ? "いまの置き場所"
            : occupant !== "none"
              ? `いまは${marginContentLabel(occupant)}（置くと、そちらは刷らなくなります）`
              : undefined,
          place,
        };
      }),
      cancelItem(),
    ],
    {
      title: `${parityLabel}の「${marginContentLabel(content)}」をどこに置きますか`,
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("place" in picked)) return undefined;
  return picked.place;
}

/**
 * 余白に刷る作者名を尋ねる。取りやめたら undefined。
 *
 * **EPUBの設計図（`設定/書籍/book.json`）に筆名があれば、初めから入れて
 * 見せる。** 同じ名前を二度打たせない。ただし**ここで入れた名前は設計図へ
 * 書き込まない**——PDFの余白に刷る名前を変えただけで、本の奥付まで
 * 変わってしまうのは、作者の思っていない書き換えになる。
 *
 * 設計図が壊れていて読めなくても止めない（ここは読むだけで、直すのは
 * EPUBエディターの役目）。空欄から尋ねる。
 */
async function askAuthorName(work: WorkEntry): Promise<string | undefined> {
  let known = "";
  try {
    known = (await new BookStore(work).load()).author;
  } catch {
    known = "";
  }
  const typed = await askText({
    title: "余白に刷る作者名",
    prompt:
      "上下の余白に刷る作者名（筆名）を入れてください。この書き出しにだけ使い、どこにも保存しません。",
    value: known,
    placeHolder: "例：山田太郎",
  });
  return typed === undefined ? undefined : typed.trim();
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
async function writeExport(work: WorkEntry, html: Uint8Array): Promise<string> {
  const config = await readWorkConfig(work);
  const directory = path.join(workPaths(work, config).aiwriter, EXPORT_DIR);
  await vscode.workspace.fs.createDirectory(path.toUri(directory));

  const target = await freshExportPath(directory, new Date());
  await atomicWriteFile(target, html, {
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
